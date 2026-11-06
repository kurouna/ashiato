export type JournalEvent =
  | { t: 'window'; start: number; end: number; app: string; title: string }
  /** locked: screen lock / sleep (really away); otherwise just no keyboard or mouse input */
  | { t: 'idle'; start: number; end: number; locked?: boolean }
  /** an ongoing call or meeting, recorded alongside whatever window is in front */
  | { t: 'call'; start: number; end: number; app: string; title: string }
  | { t: 'file'; ts: number; path: string; root: string }
  | { t: 'commit'; ts: number; repo: string; hash: string; subject: string }
  | { t: 'memo'; ts: number; text: string }
  /** merge / pull / rebase: bringing in existing work, not authoring it */
  | { t: 'gitop'; ts: number; repo: string; action: string; text: string };

export const CATEGORIES = [
  'coding',
  'review',
  'debugging',
  'research',
  'writing',
  'meeting',
  'communication',
  'design',
  'admin',
  'break',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface WorkBlock {
  start: string; // HH:MM
  end: string; // HH:MM
  title: string;
  project: string;
  category: Category;
  summary: string;
}

export interface DayAi {
  blocks?: WorkBlock[];
  blocksAt?: number;
  report?: string;
  reportAt?: number;
  model?: string;
}

export type ProviderKind = 'claude' | 'local';
export type SecretName = 'claude' | 'local';

export interface Settings {
  provider: ProviderKind;
  model: string;
  localBaseUrl: string;
  localModel: string;
  watchFolders: string[];
  excludeKeywords: string[];
  excludeApps: string[];
  redact: boolean;
  detectCalls: boolean;
  /** how long an AI request may wait for the server to start answering */
  aiTimeoutMinutes: number;
  idleMinutes: number;
  pollSeconds: number;
  retentionDays: number;
  reportTemplate: string;
  paused: boolean;
  pausedUntil: number | null;
  openAtLogin: boolean;
  onboarded: boolean;
}

export interface PublicSettings extends Settings {
  hasApiKey: boolean;
  apiKeySource: 'saved' | 'env' | 'none';
  hasLocalKey: boolean;
  secretUnreadable: boolean;
  encryptionAvailable: boolean;
}

export interface Status {
  version: string;
  recording: boolean;
  probeOk: boolean;
  probeReason: string;
  watchErrors: string[];
  lastSampleAt: number | null;
  shortcutOk: boolean;
  destination: string;
}

export interface DayData {
  date: string;
  events: JournalEvent[];
  ai: DayAi;
  live?: { kind: 'window'; app: string; title: string; start: number } | { kind: 'idle'; start: number; locked?: boolean } | null;
  liveCall?: { start: number; app: string; title: string } | null;
}

export interface DaySummary {
  date: string;
  activeMinutes: number;
  events: number;
}

export type StreamEvent =
  | { reqId: string; kind: 'text'; data: string }
  | { reqId: string; kind: 'thinking'; data: string }
  | { reqId: string; kind: 'tool'; data: string }
  | { reqId: string; kind: 'done'; data: string }
  | { reqId: string; kind: 'error'; data: string };

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（既定）' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
] as const;

export function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function startOfDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function evTime(e: JournalEvent): number {
  return 'ts' in e ? e.ts : e.start;
}
