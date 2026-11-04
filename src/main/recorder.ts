import { powerMonitor } from 'electron';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { DayData, JournalEvent, dayKey, startOfDay } from '../shared/types';
import { ActiveWindowProbe, WindowSample } from './activeWindow';
import { Store } from './store';

type Open = { kind: 'window'; app: string; title: string; start: number } | { kind: 'idle'; start: number };

const IGNORED_DIR = /(^|[\\/])(node_modules|\.git|dist|out|build|\.next|\.nuxt|\.cache|\.turbo|__pycache__|\.venv|venv|target|bin|obj)([\\/]|$)/i;
const IGNORED_FILE = /(~$|\.swp$|\.tmp$|\.lock$|^~\$|\.crdownload$|\.part$)/i;
const FILE_DEDUPE_MS = 60_000;
const GIT_POLL_MS = 3 * 60_000;
const CHECKPOINT_MS = 15_000;

export class Recorder extends EventEmitter {
  private probe?: ActiveWindowProbe;
  private current: Open | null = null;
  private watchers = new Map<string, fs.FSWatcher>();
  private lastFileHit = new Map<string, number>();
  private seenCommits = new Set<string>();
  private gitTimer?: NodeJS.Timeout;
  private checkpointTimer?: NodeJS.Timeout;
  lastSampleAt: number | null = null;
  watchErrors: string[] = [];

  constructor(private store: Store) {
    super();
  }

  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    // a span left open by a crash or forced shutdown ends at the last time we saw it
    const cp = this.store.readCheckpoint<{ open: Open; lastSeen: number }>();
    if (cp?.open && cp.lastSeen > cp.open.start) {
      this.current = cp.open;
      this.close(cp.lastSeen);
    }
    this.checkpointTimer = setInterval(() => {
      // the last real sample, not timer time: a dead probe must not stretch the span
      if (this.current) this.store.writeCheckpoint({ open: this.current, lastSeen: Math.max(this.current.start, this.lastSampleAt ?? 0) });
    }, CHECKPOINT_MS);

    this.syncProbe();
    powerMonitor.on('lock-screen', () => this.toIdle(Date.now()));
    powerMonitor.on('suspend', () => this.close(Date.now()));
    powerMonitor.on('shutdown', () => this.close(Date.now()));
    this.refreshWatchers();
    for (const e of [...this.store.readDay(dayKey(Date.now() - 86400_000)), ...this.store.readDay(dayKey(Date.now()))]) {
      if (e.t === 'commit') this.seenCommits.add(e.hash).add(`${e.repo}|${e.ts / 1000}|${e.subject}`);
    }
    this.pollGit();
    this.gitTimer = setInterval(() => this.pollGit(), GIT_POLL_MS);
  }

  stop() {
    this.probe?.stop();
    this.close(Date.now());
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    if (this.gitTimer) clearInterval(this.gitTimer);
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
  }

  /** Restart pieces that depend on settings. */
  reconfigure(prevPoll: number) {
    const s = this.store.getSettings();
    if (s.paused) this.close(Date.now());
    if (s.pollSeconds !== prevPoll) {
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
    this.probe ??= new ActiveWindowProbe(Math.max(1, s.pollSeconds) * 1000, (sample) => this.onSample(sample));
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
    if (s.paused) return this.close(now);

    const state = powerMonitor.getSystemIdleState(Math.max(1, s.idleMinutes) * 60);
    if (state === 'idle' || state === 'locked') {
      return this.toIdle(now - powerMonitor.getSystemIdleTime() * 1000);
    }
    if (!sample || (!sample.app && !sample.title)) return;

    const appExcluded = s.excludeApps.some((a) => a.trim() && a.trim().toLowerCase() === sample.app.toLowerCase());
    const excluded = appExcluded || this.isExcluded(`${sample.app} ${sample.title}`);
    const next: Open = excluded
      ? { kind: 'window', app: '(非公開)', title: '', start: now }
      : { kind: 'window', app: sample.app.slice(0, 80), title: sample.title.replace(/\s+/g, ' ').slice(0, 300), start: now };

    this.rollDay(now);
    const cur = this.current;
    if (cur && cur.kind === 'window' && cur.app === next.app && cur.title === next.title) return;
    this.close(now);
    this.current = next;
    this.emit('changed', dayKey(now));
  }

  private isExcluded(text: string) {
    const hay = text.toLowerCase();
    return this.store.getSettings().excludeKeywords.some((k) => k.trim() && hay.includes(k.trim().toLowerCase()));
  }

  private toIdle(since: number) {
    this.rollDay(Date.now());
    if (this.current?.kind === 'idle') return;
    const start = Math.max(since, this.current?.start ?? since);
    this.close(start);
    this.current = { kind: 'idle', start };
    this.emit('changed', dayKey(start));
  }

  /** Split the open span at midnight so each day's file stands on its own. */
  private rollDay(now: number) {
    const cur = this.current;
    if (!cur || dayKey(cur.start) === dayKey(now)) return;
    const midnight = startOfDay(dayKey(now));
    this.close(midnight);
    this.current = { ...cur, start: midnight };
  }

  private close(end: number) {
    const cur = this.current;
    this.current = null;
    if (!cur) return;
    this.store.clearCheckpoint();
    if (end - cur.start < 1000) return;
    if (cur.kind === 'idle') this.write({ t: 'idle', start: cur.start, end });
    else this.write({ t: 'window', start: cur.start, end, app: cur.app, title: cur.title });
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
    if (IGNORED_DIR.test(rel) || IGNORED_FILE.test(path.basename(rel)) || this.isExcluded(rel)) return;
    const full = path.join(root, rel);
    const now = Date.now();
    if (now - (this.lastFileHit.get(full) ?? 0) < FILE_DEDUPE_MS) return;
    // claim the slot before the async stat: one save fires several watch events at once
    this.lastFileHit.set(full, now);
    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) return this.lastFileHit.delete(full);
      this.write({ t: 'file', ts: now, path: rel.replace(/\\/g, '/'), root });
    });
  }

  // ---- git ----
  private pollGit() {
    const s = this.store.getSettings();
    if (s.paused) return;
    this.refreshWatchers();
    // a little past midnight so commits made just before it are not missed; seenCommits dedupes
    const since = new Date(Date.now() - 26 * 3600_000).toISOString();
    const now = Date.now();
    for (const [k, t] of this.lastFileHit) if (now - t > FILE_DEDUPE_MS) this.lastFileHit.delete(k);
    for (const repo of findRepos(s.watchFolders)) {
      execFile('git', ['-C', repo, 'config', 'user.email'], { timeout: 5000 }, (_e, email) => {
        // without an identity we can't tell the user's commits from teammates' fetched ones
        if (!email.trim()) return;
        const args = ['-c', 'core.fsmonitor=false', '-C', repo, 'log', '--all', `--since=${since}`, '--no-merges', `--author=${email.trim()}`, '--pretty=format:%H%x1f%at%x1f%s'];
        execFile('git', args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
          if (err) return;
          for (const line of out.split('\n')) {
            const [hash, ct, subject] = line.split('\x1f');
            // rebase/amend rewrites the hash but keeps author time + subject
            const key = `${path.basename(repo)}|${ct}|${subject}`;
            if (!hash || this.seenCommits.has(hash) || this.seenCommits.has(key) || this.isExcluded(subject ?? '')) continue;
            this.seenCommits.add(hash).add(key);
            this.write({ t: 'commit', ts: Number(ct) * 1000, repo: path.basename(repo), hash, subject: subject ?? '' });
          }
        });
      });
    }
  }
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
