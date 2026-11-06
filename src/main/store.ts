import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import { CATEGORIES, DayAi, DaySummary, JournalEvent, PublicSettings, SecretName, Settings, dayKey, evTime } from '../shared/types';

const DEFAULT_TEMPLATE = `## 今日やったこと
## 進捗・成果
## 課題・気づき
## 明日やること`;

const DEFAULTS: Settings = {
  provider: 'claude',
  model: 'claude-opus-5-5',
  localBaseUrl: 'http://localhost:11434/v1',
  localModel: '',
  watchFolders: [],
  excludeKeywords: ['password', 'パスワード', '1Password', 'Bitwarden', 'KeePass', 'シークレット', 'InPrivate', 'Incognito', 'シークレット ウィンドウ'],
  excludeApps: [],
  redact: true,
  detectCalls: true,
  idleMinutes: 5,
  pollSeconds: 5,
  retentionDays: 0,
  reportTemplate: DEFAULT_TEMPLATE,
  paused: false,
  pausedUntil: null,
  openAtLogin: false,
  onboarded: false,
};

const str = (max: number) => z.string().max(max);
const strList = z.array(str(200)).max(200);

/** Every settings write from the renderer goes through this allow-list. */
export const SettingsPatch = z
  .object({
    provider: z.enum(['claude', 'local']),
    model: str(80),
    localBaseUrl: z.string().max(500).refine((u) => /^https?:\/\/[^\s]+$/i.test(u), 'http(s) の URL を指定してください'),
    localModel: str(200),
    watchFolders: z.array(str(1000)).max(50),
    excludeKeywords: strList,
    excludeApps: strList,
    redact: z.boolean(),
    detectCalls: z.boolean(),
    idleMinutes: z.number().int().min(1).max(120),
    pollSeconds: z.number().int().min(1).max(60),
    retentionDays: z.number().int().min(0).max(3650),
    reportTemplate: str(5000),
    paused: z.boolean(),
    pausedUntil: z.number().nullable(),
    openAtLogin: z.boolean(),
    onboarded: z.boolean(),
  })
  .partial()
  .strict();

/** Days kept parsed in memory; searching a whole year would otherwise keep it all resident. */
const DAY_CACHE_MAX = 14;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function assertDate(date: unknown): string {
  if (typeof date !== 'string' || !DATE_RE.test(date)) throw new Error('日付の形式が不正です');
  return date;
}

const BlockSchema = z.object({
  start: z.string(),
  end: z.string(),
  title: z.string().max(300),
  project: z.string().max(200),
  category: z.enum(CATEGORIES),
  summary: z.string().max(2000),
});
export const AiPatch = z.object({ report: z.string().max(100_000).optional(), blocks: z.array(BlockSchema).max(200).optional() }).strict();

interface StoredSettings extends Settings {
  apiKeyEnc?: string;
  localKeyEnc?: string;
}
const SECRET_FIELD: Record<SecretName, 'apiKeyEnc' | 'localKeyEnc'> = { claude: 'apiKeyEnc', local: 'localKeyEnc' };

export class Store {
  readonly dir = path.join(app.getPath('userData'), 'journal');
  private settingsFile = path.join(app.getPath('userData'), 'settings.json');
  private settings: StoredSettings;
  private secretError: Partial<Record<SecretName, boolean>> = {};
  private dayCache = new Map<string, { stamp: string; events: JournalEvent[] }>();
  private encryptionOk = false;

  constructor() {
    fs.mkdirSync(this.dir, { recursive: true });
    const raw = this.readJson<Partial<StoredSettings>>(this.settingsFile, {});
    // drop anything that no longer validates (hand edits, older versions) instead of crashing later
    const { apiKeyEnc, localKeyEnc, ...rest } = raw;
    const ok = SettingsPatch.safeParse(Object.fromEntries(Object.entries(rest).filter(([k]) => k in DEFAULTS)));
    this.settings = { ...DEFAULTS, ...(ok.success ? ok.data : {}), apiKeyEnc, localKeyEnc };
    // existing installs predate onboarding
    if (raw.watchFolders !== undefined && raw.onboarded === undefined) this.settings.onboarded = true;
  }

  /** Must run after app ready: the OS keychain backend is only known then. */
  async init() {
    this.encryptionOk = await safeStorage.isAsyncEncryptionAvailable();
  }

  // ---- settings ----
  getSettings(): Settings {
    const { apiKeyEnc: _a, localKeyEnc: _l, ...rest } = this.settings;
    return rest;
  }

  getPublicSettings(): PublicSettings {
    const claude = this.settings.apiKeyEnc && !this.secretError.claude ? 'saved' : process.env.ANTHROPIC_API_KEY ? 'env' : 'none';
    return {
      ...this.getSettings(),
      hasApiKey: claude !== 'none',
      apiKeySource: claude,
      hasLocalKey: !!this.settings.localKeyEnc,
      secretUnreadable: !!(this.secretError.claude || this.secretError.local),
      encryptionAvailable: this.encryptionOk,
    };
  }

  updateSettings(patch: unknown): Settings {
    const valid = SettingsPatch.parse(patch);
    this.settings = { ...this.settings, ...valid };
    this.writeJson(this.settingsFile, this.settings);
    return this.getSettings();
  }

  async setSecret(name: SecretName, key: string | null): Promise<void> {
    const field = SECRET_FIELD[name];
    if (!key) {
      delete this.settings[field];
    } else {
      if (typeof key !== 'string' || key.length > 500) throw new Error('キーの形式が不正です');
      if (!this.encryptionOk) throw new Error('OS の暗号化ストレージが使えないため、キーを保存できません。環境変数 ANTHROPIC_API_KEY を使ってください。');
      this.settings[field] = (await safeStorage.encryptStringAsync(key.trim())).toString('base64');
    }
    this.secretError[name] = false;
    this.writeJson(this.settingsFile, this.settings);
  }

  /** undefined when not saved, or when it can't be decrypted (profile copied to another user/PC). */
  async getSecret(name: SecretName): Promise<string | undefined> {
    const enc = this.settings[SECRET_FIELD[name]];
    if (!enc) return undefined;
    try {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'));
      if (shouldReEncrypt) await this.setSecret(name, result);
      return result;
    } catch {
      this.secretError[name] = true;
      return undefined;
    }
  }

  // ---- journal ----
  private dayFile(date: string) {
    return path.join(this.dir, `${assertDate(date)}.jsonl`);
  }
  private aiFile(date: string) {
    return path.join(this.dir, `${assertDate(date)}.ai.json`);
  }

  append(ev: JournalEvent): string {
    const date = dayKey(evTime(ev));
    fs.appendFileSync(this.dayFile(date), JSON.stringify(ev) + '\n', 'utf8');
    return date;
  }

  readDay(date: string): JournalEvent[] {
    const file = this.dayFile(date);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return [];
    }
    const stamp = `${st.mtimeMs}:${st.size}`;
    const hit = this.dayCache.get(date);
    if (hit?.stamp === stamp) return hit.events;
    const out: JournalEvent[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a torn last line after a crash; skip it
      }
    }
    out.sort((a, b) => evTime(a) - evTime(b));
    this.dayCache.delete(date); // re-insert so the Map order is least-recently-used first
    this.dayCache.set(date, { stamp, events: out });
    while (this.dayCache.size > DAY_CACHE_MAX) this.dayCache.delete(this.dayCache.keys().next().value!);
    return out;
  }

  listDays(): string[] {
    return fs
      .readdirSync(this.dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  }

  summarizeDays(): DaySummary[] {
    return this.listDays().map((date) => {
      const events = this.readDay(date);
      const ms = events.reduce((sum, e) => (e.t === 'window' ? sum + (e.end - e.start) : sum), 0);
      return { date, activeMinutes: Math.round(ms / 60000), events: events.length };
    });
  }

  deleteDay(date: string) {
    fs.rmSync(this.dayFile(date), { force: true });
    fs.rmSync(this.aiFile(date), { force: true });
    this.dayCache.delete(date);
  }

  /** Remove one recorded event (matched by its exact JSON) — for a title that should never have been kept. */
  deleteEvent(date: string, ev: JournalEvent) {
    const target = JSON.stringify(ev);
    const kept = this.readDay(date).filter((e) => JSON.stringify(e) !== target);
    const file = this.dayFile(date);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e) + '\n').join(''), 'utf8');
    fs.renameSync(tmp, file);
    this.dayCache.delete(date);
  }

  /** Days a retention of `days` would remove (0 = keep forever). */
  expiredDays(days: number): string[] {
    if (!days) return [];
    const cutoff = dayKey(Date.now() - days * 86400_000);
    return this.listDays().filter((d) => d < cutoff);
  }

  purgeExpired(): number {
    const old = this.expiredDays(this.settings.retentionDays);
    for (const d of old) this.deleteDay(d);
    return old.length;
  }

  /** Free parsed days, e.g. after a search over the whole history. */
  releaseCache() {
    this.dayCache.clear();
  }

  /** How much is on disk, for the settings screen. */
  stats(): { days: number; first: string | null; last: string | null; bytes: number } {
    const days = this.listDays();
    let bytes = 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (/^\d{4}-\d{2}-\d{2}\.(jsonl|ai\.json)$/.test(f)) bytes += fs.statSync(path.join(this.dir, f)).size;
    }
    return { days: days.length, first: days[0] ?? null, last: days.at(-1) ?? null, bytes };
  }

  private get checkpointFile() {
    return path.join(this.dir, 'open-span.json');
  }
  readCheckpoint<T>(): T | null {
    return this.readJson<T | null>(this.checkpointFile, null);
  }
  writeCheckpoint(data: unknown) {
    this.writeJson(this.checkpointFile, data);
  }
  clearCheckpoint() {
    fs.rmSync(this.checkpointFile, { force: true });
  }

  readAi(date: string): DayAi {
    return this.readJson<DayAi>(this.aiFile(date), {});
  }

  writeAi(date: string, patch: Partial<DayAi>): DayAi {
    const next = { ...this.readAi(date), ...patch };
    this.writeJson(this.aiFile(date), next);
    return next;
  }

  private readJson<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(file: string, data: unknown) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }
}
