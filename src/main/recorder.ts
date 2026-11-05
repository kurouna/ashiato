import { powerMonitor } from 'electron';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { DayData, JournalEvent, dayKey, startOfDay } from '../shared/types';
import { ActiveWindowProbe, WindowSample, micAppName } from './activeWindow';
import { Store } from './store';

type Open = { kind: 'window'; app: string; title: string; start: number } | { kind: 'idle'; start: number; locked?: boolean };
type OpenCall = { start: number; app: string; title: string; misses: number };

const IGNORED_DIR = /(^|[\\/])(node_modules|\.git|dist|out|build|\.next|\.nuxt|\.cache|\.turbo|__pycache__|\.venv|venv|target|bin|obj)([\\/]|$)/i;
const IGNORED_FILE = /(~$|\.swp$|\.tmp$|\.lock$|^~\$|\.crdownload$|\.part$)/i;
/** git rewrites these while checking out, merging, pulling or rebasing */
const GIT_ACTIVITY = /(^|[\\/])\.git[\\/](index\.lock|HEAD\.lock|ORIG_HEAD|MERGE_HEAD|AUTO_MERGE|REBASE_HEAD|CHERRY_PICK_HEAD|rebase-merge|rebase-apply|logs[\\/]HEAD)/i;
const FILE_DEDUPE_MS = 60_000;
/** file changes this close to git activity in the same repo are git's, not the user's */
const GIT_QUIET_MS = 5_000;
/** file events are held this long so git activity that lands just after them can still claim them */
const FILE_SETTLE_MS = 4_000;
/** more distinct files than this in one burst is a checkout, build or tool run, not editing */
const BURST_FILES = 40;
const GIT_POLL_MS = 3 * 60_000;
const CHECKPOINT_MS = 15_000;
/** a call ends after this many consecutive checks (~15 s apart) without a microphone or meeting window */
const CALL_END_MISSES = 2;

export class Recorder extends EventEmitter {
  private probe?: ActiveWindowProbe;
  private current: Open | null = null;
  private call: OpenCall | null = null;
  private watchers = new Map<string, fs.FSWatcher>();
  private lastFileHit = new Map<string, number>();
  private pendingFiles = new Map<string, { items: { rel: string; ts: number }[]; first: number; timer: NodeJS.Timeout }>();
  private gitActivity = new Map<string, number[]>();
  private repoOf = new Map<string, string | null>();
  private seenCommits = new Set<string>();
  private gitTimer?: NodeJS.Timeout;
  private checkpointTimer?: NodeJS.Timeout;
  private started = false;
  lastSampleAt: number | null = null;
  watchErrors: string[] = [];

  constructor(private store: Store) {
    super();
  }

  start() {
    if (this.started) return;
    this.started = true;
    // spans left open by a crash or forced shutdown end at the last time we saw them
    const cp = this.store.readCheckpoint<{ open?: Open; call?: OpenCall; lastSeen: number }>();
    if (cp?.open && cp.lastSeen > cp.open.start) {
      this.current = cp.open;
      this.close(cp.lastSeen);
    }
    if (cp?.call && cp.lastSeen > cp.call.start) {
      this.call = cp.call;
      this.endCall(cp.lastSeen);
    }
    this.checkpointTimer = setInterval(() => {
      // the last real sample, not timer time: a dead probe must not stretch the span
      const lastSeen = Math.max(this.current?.start ?? 0, this.call?.start ?? 0, this.lastSampleAt ?? 0);
      if (this.current || this.call) this.store.writeCheckpoint({ open: this.current, call: this.call, lastSeen });
    }, CHECKPOINT_MS);

    this.syncProbe();
    powerMonitor.on('lock-screen', () => this.toIdle(Date.now(), true));
    powerMonitor.on('suspend', () => this.closeAll(Date.now()));
    powerMonitor.on('shutdown', () => this.closeAll(Date.now()));
    this.refreshWatchers();
    for (const e of [...this.store.readDay(dayKey(Date.now() - 86400_000)), ...this.store.readDay(dayKey(Date.now()))]) {
      if (e.t === 'commit') this.seenCommits.add(e.hash).add(`${e.repo}|${e.ts / 1000}|${e.subject}`);
      if (e.t === 'gitop') this.seenCommits.add(`op|${e.repo}|${e.ts}|${e.text}`);
    }
    this.pollGit();
    this.gitTimer = setInterval(() => this.pollGit(), GIT_POLL_MS);
  }

  stop() {
    this.probe?.stop();
    this.closeAll(Date.now());
    for (const root of [...this.pendingFiles.keys()]) this.flushFiles(root);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    if (this.gitTimer) clearInterval(this.gitTimer);
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
  }

  /** Restart pieces that depend on settings. */
  reconfigure(prev: { pollSeconds: number; detectCalls: boolean }) {
    const s = this.store.getSettings();
    if (s.paused) this.closeAll(Date.now());
    if (!s.detectCalls) this.endCall(Date.now());
    if (s.pollSeconds !== prev.pollSeconds || s.detectCalls !== prev.detectCalls) {
      this.probe?.stop();
      this.probe = undefined;
    }
    this.syncProbe();
    this.refreshWatchers();
    this.pollGit();
  }

  /** While paused nothing observes the screen at all. */
  private syncProbe() {
    const s = this.store.getSettings();
    if (s.paused) {
      this.probe?.stop();
      return;
    }
    this.probe ??= new ActiveWindowProbe(Math.max(1, s.pollSeconds) * 1000, (sample) => this.onSample(sample), s.detectCalls);
    this.probe.start();
  }

  health(): { ok: boolean; reason: string; lastSampleAt: number | null } {
    if (this.store.getSettings().paused) return { ok: true, reason: '', lastSampleAt: this.lastSampleAt };
    const state = this.probe?.state ?? { ok: false, reason: '起動中' };
    if (!state.ok) return { ok: false, reason: state.reason, lastSampleAt: this.lastSampleAt };
    const stale = !this.lastSampleAt || Date.now() - this.lastSampleAt > 60_000 + this.store.getSettings().pollSeconds * 1000;
    return { ok: !stale, reason: stale ? '1 分以上ウィンドウ情報を取得できていません' : '', lastSampleAt: this.lastSampleAt };
  }

  live(): DayData['live'] {
    return this.current ? { ...this.current } : null;
  }

  liveCall(): DayData['liveCall'] {
    return this.call ? { start: this.call.start, app: this.call.app, title: this.call.title } : null;
  }

  addMemo(text: string) {
    const t = text.trim();
    if (!t) return;
    this.write({ t: 'memo', ts: Date.now(), text: t.slice(0, 2000) });
  }

  // ---- window / idle ----
  private onSample(sample: WindowSample | null) {
    const now = Date.now();
    const s = this.store.getSettings();
    if (sample) this.lastSampleAt = now;
    if (s.paused) return this.closeAll(now);
    if (sample) this.trackCall(sample, now);

    const state = powerMonitor.getSystemIdleState(Math.max(1, s.idleMinutes) * 60);
    // in a call the user listens and watches without touching anything: that is not idle
    if (state === 'locked' || (state === 'idle' && !this.call)) {
      return this.toIdle(now - powerMonitor.getSystemIdleTime() * 1000, state === 'locked');
    }
    if (!sample || (!sample.app && !sample.title)) return;

    const next: Open = this.isPrivateApp(sample.app) || this.isExcluded(`${sample.app} ${sample.title}`)
      ? { kind: 'window', app: '(非公開)', title: '', start: now }
      : { kind: 'window', app: sample.app.slice(0, 80), title: sample.title.replace(/\s+/g, ' ').slice(0, 300), start: now };

    this.rollDay(now);
    const cur = this.current;
    if (cur && cur.kind === 'window' && cur.app === next.app && cur.title === next.title) return;
    this.close(now);
    this.current = next;
    this.emit('changed', dayKey(now));
  }

  private isPrivateApp(app: string) {
    return this.store.getSettings().excludeApps.some((a) => a.trim() && a.trim().toLowerCase() === app.toLowerCase());
  }

  private isExcluded(text: string) {
    const hay = text.toLowerCase();
    return this.store.getSettings().excludeKeywords.some((k) => k.trim() && hay.includes(k.trim().toLowerCase()));
  }

  private toIdle(since: number, locked: boolean) {
    this.rollDay(Date.now());
    if (this.current?.kind === 'idle') {
      if (locked && !this.current.locked) this.current.locked = true;
      return;
    }
    const start = Math.max(since, this.current?.start ?? since);
    this.close(start);
    this.current = { kind: 'idle', start, ...(locked ? { locked } : {}) };
    this.emit('changed', dayKey(start));
  }

  /** Split open spans at midnight so each day's file stands on its own. */
  private rollDay(now: number) {
    const midnight = startOfDay(dayKey(now));
    const cur = this.current;
    if (cur && cur.start < midnight) {
      this.close(midnight);
      this.current = { ...cur, start: midnight };
    }
    const call = this.call;
    if (call && call.start < midnight) {
      this.endCall(midnight);
      this.call = { ...call, start: midnight };
    }
  }

  private close(end: number) {
    const cur = this.current;
    this.current = null;
    if (!cur) return;
    if (!this.call) this.store.clearCheckpoint();
    if (end - cur.start < 1000) return;
    if (cur.kind === 'idle') this.write({ t: 'idle', start: cur.start, end, ...(cur.locked ? { locked: true } : {}) });
    else this.write({ t: 'window', start: cur.start, end, app: cur.app, title: cur.title });
  }

  private closeAll(end: number) {
    this.endCall(end);
    this.close(end);
  }

  // ---- calls / meetings ----
  /** A call is on while a conferencing app holds the microphone or a meeting window is open, even in the background. */
  private trackCall(sample: WindowSample, now: number) {
    if (sample.mic === undefined && sample.meetings === undefined) return; // not a call-check tick
    const s = this.store.getSettings();
    if (!s.detectCalls) return;
    const mic = (sample.mic ?? []).map(micAppName).filter((a) => !this.isPrivateApp(a));
    const meeting = (sample.meetings ?? []).find((t) => !this.isExcluded(t));
    const active = mic.length > 0 || !!meeting;
    if (!active) {
      if (this.call && ++this.call.misses >= CALL_END_MISSES) this.endCall(now);
      return;
    }
    const app = mic[0] ?? (meeting ? meetingApp(meeting) : '');
    const title = meeting ? meeting.replace(/\s+/g, ' ').slice(0, 200) : '';
    if (!this.call) {
      this.rollDay(now);
      this.call = { start: now, app, title, misses: 0 };
      this.emit('changed', dayKey(now));
      return;
    }
    this.call.misses = 0;
    if (!this.call.title && title) this.call.title = title;
  }

  private endCall(end: number) {
    const call = this.call;
    this.call = null;
    if (!call) return;
    if (!this.current) this.store.clearCheckpoint();
    if (end - call.start < 30_000) return; // a mic test or a notification sound
    this.write({ t: 'call', start: call.start, end, app: call.app, title: call.title });
  }

  private write(ev: JournalEvent) {
    const date = this.store.append(ev);
    this.emit('changed', date);
  }

  // ---- files ----
  private refreshWatchers() {
    const wanted = new Set(this.store.getSettings().watchFolders);
    for (const [dir, w] of this.watchers) {
      if (!wanted.has(dir)) {
        w.close();
        this.watchers.delete(dir);
      }
    }
    this.watchErrors = [];
    for (const dir of wanted) {
      if (this.watchers.has(dir)) continue;
      if (!fs.existsSync(dir)) {
        this.watchErrors.push(dir);
        continue;
      }
      try {
        const w = fs.watch(dir, { recursive: true }, (_type, filename) => filename && this.onFile(dir, filename.toString()));
        // a dropped network/USB drive errors out; pollGit() re-arms it later
        w.on('error', () => {
          w.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, w);
      } catch (err) {
        console.warn('watch failed', dir, err);
        this.watchErrors.push(dir);
      }
    }
  }

  private onFile(root: string, rel: string) {
    if (this.store.getSettings().paused) return;
    const now = Date.now();
    const git = rel.match(GIT_ACTIVITY);
    if (git) {
      // remember when git touched this repo; file changes around it are git's doing
      const repo = path.resolve(root, rel.slice(0, git.index ?? 0));
      const times = (this.gitActivity.get(repo) ?? []).filter((t) => now - t < 60_000);
      times.push(now);
      this.gitActivity.set(repo, times);
      return;
    }
    if (IGNORED_DIR.test(rel) || IGNORED_FILE.test(path.basename(rel)) || this.isExcluded(rel)) return;
    const pending = this.pendingFiles.get(root);
    if (pending) {
      pending.items.push({ rel, ts: now });
      clearTimeout(pending.timer);
      // keep settling while events keep coming, but never hold a batch longer than a few seconds more
      const wait = Math.max(0, Math.min(FILE_SETTLE_MS, pending.first + 3 * FILE_SETTLE_MS - now));
      pending.timer = setTimeout(() => this.flushFiles(root), wait);
    } else {
      this.pendingFiles.set(root, { items: [{ rel, ts: now }], first: now, timer: setTimeout(() => this.flushFiles(root), FILE_SETTLE_MS) });
    }
  }

  private flushFiles(root: string) {
    const batch = this.pendingFiles.get(root);
    this.pendingFiles.delete(root);
    if (!batch) return;
    clearTimeout(batch.timer);
    const distinct = new Map<string, number>();
    for (const it of batch.items) if (!distinct.has(it.rel)) distinct.set(it.rel, it.ts);
    if (distinct.size > BURST_FILES) return; // checkout, build output, formatter run…
    for (const [rel, ts] of distinct) {
      const full = path.resolve(root, rel);
      const repo = this.findRepo(full);
      if (repo && (this.gitActivity.get(repo) ?? []).some((t) => Math.abs(t - ts) < GIT_QUIET_MS)) continue;
      if (ts - (this.lastFileHit.get(full) ?? 0) < FILE_DEDUPE_MS) continue;
      this.lastFileHit.set(full, ts);
      fs.stat(full, (err, st) => {
        if (err || !st.isFile()) return this.lastFileHit.delete(full);
        this.write({ t: 'file', ts, path: rel.replace(/\\/g, '/'), root });
      });
    }
  }

  /** Nearest folder with a .git above a file, cached per directory. */
  private findRepo(file: string): string | null {
    const dir = path.dirname(file);
    if (this.repoOf.has(dir)) return this.repoOf.get(dir)!;
    let cur = dir;
    let found: string | null = null;
    for (let i = 0; i < 30; i++) {
      if (fs.existsSync(path.join(cur, '.git'))) {
        found = cur;
        break;
      }
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    this.repoOf.set(dir, found);
    return found;
  }

  // ---- git ----
  private pollGit() {
    const s = this.store.getSettings();
    if (s.paused) return;
    this.refreshWatchers();
    // a little past midnight so commits made just before it are not missed; seenCommits dedupes
    const sinceMs = Date.now() - 26 * 3600_000;
    const since = new Date(sinceMs).toISOString();
    const now = Date.now();
    for (const [k, t] of this.lastFileHit) if (now - t > FILE_DEDUPE_MS) this.lastFileHit.delete(k);
    if (this.repoOf.size > 5000) this.repoOf.clear();
    for (const repo of findRepos(s.watchFolders)) {
      const name = path.basename(repo);
      execFile('git', ['-C', repo, 'config', 'user.email'], { timeout: 5000 }, (_e, email) => {
        // without an identity we can't tell the user's commits from teammates' fetched ones
        if (!email.trim()) return;
        const args = ['-c', 'core.fsmonitor=false', '-C', repo, 'log', '--all', `--since=${since}`, '--no-merges', `--author=${email.trim()}`, '--pretty=format:%H%x1f%at%x1f%s'];
        execFile('git', args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
          if (err) return;
          for (const line of out.split('\n')) {
            const [hash, at, subject] = line.split('\x1f');
            // rebase/amend rewrites the hash but keeps author time + subject
            const key = `${name}|${at}|${subject}`;
            if (!hash || this.seenCommits.has(hash) || this.seenCommits.has(key) || this.isExcluded(subject ?? '')) continue;
            this.seenCommits.add(hash).add(key);
            // --since looks at the committer date; a rebase or pull --rebase re-commits old work with
            // today's committer date, so only work authored in the window counts as today's
            if (Number(at) * 1000 < sinceMs) continue;
            this.write({ t: 'commit', ts: Number(at) * 1000, repo: name, hash, subject: subject ?? '' });
          }
        });
      });
      // merges, pulls and rebases from the reflog: the user brought work in, they did not write it
      execFile('git', ['-c', 'core.fsmonitor=false', '-C', repo, 'log', '-g', '--date=unix', '--format=%gd%x1f%gs', '-200'], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
        if (err) return;
        for (const line of out.split('\n')) {
          const [sel, text] = line.split('\x1f');
          const ts = Number(sel?.match(/@\{(\d+)\}/)?.[1]) * 1000;
          const action = text?.match(/^(merge|pull|rebase)\b/i)?.[1]?.toLowerCase();
          if (!ts || ts < sinceMs || !action || !text || /^rebase.*\((start|pick|continue)\)/i.test(text)) continue;
          const key = `op|${name}|${ts}|${text}`;
          if (this.seenCommits.has(key) || this.isExcluded(text)) continue;
          this.seenCommits.add(key);
          this.write({ t: 'gitop', ts, repo: name, action, text: text.slice(0, 300) });
        }
      });
    }
  }
}

function meetingApp(title: string): string {
  if (/zoom/i.test(title)) return 'Zoom';
  if (/meet/i.test(title)) return 'Google Meet';
  if (/webex/i.test(title)) return 'Webex';
  if (/slack|ハドル|huddle/i.test(title)) return 'Slack';
  return '';
}

function findRepos(folders: string[]): string[] {
  const repos = new Set<string>();
  for (const dir of folders) {
    if (fs.existsSync(path.join(dir, '.git'))) repos.add(dir);
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory() && fs.existsSync(path.join(dir, ent.name, '.git'))) repos.add(path.join(dir, ent.name));
      }
    } catch {
      // unreadable folder
    }
  }
  return [...repos];
}
