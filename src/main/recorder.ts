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

  constructor(private store: Store) {
    super();
  }

  start() {
    // a span left open by a crash or forced shutdown ends at the last time we saw it
    const cp = this.store.readCheckpoint<{ open: Open; lastSeen: number }>();
    if (cp?.open && cp.lastSeen > cp.open.start) {
      this.current = cp.open;
      this.close(cp.lastSeen);
    }
    this.checkpointTimer = setInterval(() => {
      if (this.current) this.store.writeCheckpoint({ open: this.current, lastSeen: Date.now() });
    }, CHECKPOINT_MS);

    const s = this.store.getSettings();
    this.probe = new ActiveWindowProbe(Math.max(1, s.pollSeconds) * 1000, (sample) => this.onSample(sample));
    this.probe.start();
    powerMonitor.on('lock-screen', () => this.toIdle(Date.now()));
    powerMonitor.on('suspend', () => this.close(Date.now()));
    powerMonitor.on('shutdown', () => this.close(Date.now()));
    this.refreshWatchers();
    for (const e of this.store.readDay(dayKey(Date.now()))) if (e.t === 'commit') this.seenCommits.add(e.hash);
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
    if (s.pollSeconds !== prevPoll && this.probe) {
      this.probe.stop();
      this.probe = new ActiveWindowProbe(Math.max(1, s.pollSeconds) * 1000, (sample) => this.onSample(sample));
      this.probe.start();
    }
    this.refreshWatchers();
    this.pollGit();
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
    if (s.paused) return this.close(now);

    const state = powerMonitor.getSystemIdleState(Math.max(1, s.idleMinutes) * 60);
    if (state === 'idle' || state === 'locked') {
      return this.toIdle(now - powerMonitor.getSystemIdleTime() * 1000);
    }
    if (!sample || (!sample.app && !sample.title)) return;

    const hay = `${sample.app} ${sample.title}`.toLowerCase();
    const excluded = s.excludeKeywords.some((k) => k.trim() && hay.includes(k.trim().toLowerCase()));
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

  private toIdle(since: number) {
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
    for (const dir of wanted) {
      if (this.watchers.has(dir) || !fs.existsSync(dir)) continue;
      try {
        const w = fs.watch(dir, { recursive: true }, (_type, filename) => filename && this.onFile(dir, filename.toString()));
        w.on('error', () => {
          w.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, w);
      } catch (err) {
        console.warn('watch failed', dir, err);
      }
    }
  }

  private onFile(root: string, rel: string) {
    if (this.store.getSettings().paused) return;
    if (IGNORED_DIR.test(rel) || IGNORED_FILE.test(path.basename(rel))) return;
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
    const since = new Date(startOfDay(dayKey(Date.now()))).toISOString();
    for (const repo of findRepos(s.watchFolders)) {
      execFile('git', ['-C', repo, 'config', 'user.email'], { timeout: 5000 }, (_e, email) => {
        const args = ['-C', repo, 'log', '--all', `--since=${since}`, '--no-merges', '--pretty=format:%H%x1f%ct%x1f%s'];
        if (email.trim()) args.push(`--author=${email.trim()}`);
        execFile('git', args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
          if (err) return;
          for (const line of out.split('\n')) {
            const [hash, ct, subject] = line.split('\x1f');
            if (!hash || this.seenCommits.has(hash)) continue;
            this.seenCommits.add(hash);
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
