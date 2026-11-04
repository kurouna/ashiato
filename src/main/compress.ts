import { defang, redact } from '../shared/redact';
import { DayData, JournalEvent, evTime, hhmm } from '../shared/types';

const MIN_SPAN_MS = 15_000;
const MERGE_GAP_MS = 30_000;
const FILE_BUCKET_MS = 10 * 60_000;

/**
 * Turn a day's raw events into a compact, time-ordered text the model can read.
 * Short window hops are folded into their neighbours; file edits are bucketed per 10 minutes.
 */
export function compressDay(events: JournalEvent[], live?: DayData['live'], opts: { redact?: boolean } = {}): string {
  const all = [...events];
  if (live) {
    const now = Date.now();
    all.push(live.kind === 'idle' ? { t: 'idle', start: live.start, end: now } : { t: 'window', start: live.start, end: now, app: live.app, title: live.title });
  }
  all.sort((a, b) => evTime(a) - evTime(b));

  type Line = { ts: number; text: string };
  const lines: Line[] = [];

  // windows: merge consecutive same app+title, then drop tiny hops
  const spans: { start: number; end: number; app: string; title: string; idle: boolean }[] = [];
  for (const e of all) {
    if (e.t !== 'window' && e.t !== 'idle') continue;
    const app = e.t === 'window' ? e.app : '';
    const title = e.t === 'window' ? e.title : '';
    const prev = spans[spans.length - 1];
    if (prev && prev.app === app && prev.title === title && prev.idle === (e.t === 'idle') && e.start - prev.end < MERGE_GAP_MS) {
      prev.end = Math.max(prev.end, e.end);
    } else {
      spans.push({ start: e.start, end: e.end, app, title, idle: e.t === 'idle' });
    }
  }
  for (const s of spans) {
    if (s.end - s.start < MIN_SPAN_MS) continue;
    const mins = Math.max(1, Math.round((s.end - s.start) / 60000));
    const text = s.idle ? '(離席)' : `[${defang(s.app || '?')}] ${defang(s.title) || '(タイトルなし)'}`;
    lines.push({ ts: s.start, text: `${hhmm(s.start)}–${hhmm(s.end)} (${mins}分) ${text}` });
  }

  // files: bucket by 10 minutes and root
  const buckets = new Map<string, { ts: number; root: string; paths: Set<string> }>();
  for (const e of all) {
    if (e.t !== 'file') continue;
    const b = Math.floor(e.ts / FILE_BUCKET_MS) * FILE_BUCKET_MS;
    const key = `${b}|${e.root}`;
    const entry = buckets.get(key) ?? { ts: b, root: e.root, paths: new Set<string>() };
    entry.paths.add(e.path);
    buckets.set(key, entry);
  }
  for (const b of buckets.values()) {
    const paths = [...b.paths];
    const shown = paths.slice(0, 12).map(defang).join(', ') + (paths.length > 12 ? ` ほか${paths.length - 12}件` : '');
    lines.push({ ts: b.ts, text: `${hhmm(b.ts)} ファイル編集 「${defang(baseName(b.root))}」: ${shown}` });
  }

  for (const e of all) {
    if (e.t === 'commit') lines.push({ ts: e.ts, text: `${hhmm(e.ts)} git commit 「${defang(e.repo)}」 ${defang(e.subject)}` });
    if (e.t === 'memo') lines.push({ ts: e.ts, text: `${hhmm(e.ts)} 本人メモ: ${defang(e.text)}` });
  }

  lines.sort((a, b) => a.ts - b.ts);
  const text = lines.map((l) => l.text).join('\n');
  return opts.redact ? redact(text) : text;
}

function baseName(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}
