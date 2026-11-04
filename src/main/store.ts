import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DayAi, DaySummary, JournalEvent, PublicSettings, Settings, dayKey, evTime } from '../shared/types';

const DEFAULT_TEMPLATE = `## 今日やったこと
## 進捗・成果
## 課題・気づき
## 明日やること`;

const DEFAULTS: Settings = {
  model: 'claude-opus-5-5',
  watchFolders: [],
  excludeKeywords: ['password', 'パスワード', '1Password', 'Bitwarden', 'シークレット', 'InPrivate', 'Incognito'],
  idleMinutes: 5,
  pollSeconds: 5,
  reportTemplate: DEFAULT_TEMPLATE,
  paused: false,
  openAtLogin: false,
};

interface StoredSettings extends Settings {
  apiKeyEnc?: string;
}

export class Store {
  readonly dir = path.join(app.getPath('userData'), 'journal');
  private settingsFile = path.join(app.getPath('userData'), 'settings.json');
  private settings: StoredSettings;

  constructor() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.settings = { ...DEFAULTS, ...this.readJson<Partial<StoredSettings>>(this.settingsFile, {}) };
  }

  // ---- settings ----
  getSettings(): Settings {
    const { apiKeyEnc: _omit, ...rest } = this.settings;
    return rest;
  }

  getPublicSettings(): PublicSettings {
    const source = this.settings.apiKeyEnc ? 'saved' : process.env.ANTHROPIC_API_KEY ? 'env' : 'none';
    return { ...this.getSettings(), hasApiKey: source !== 'none', apiKeySource: source };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...patch };
    this.writeJson(this.settingsFile, this.settings);
    return this.getSettings();
  }

  setApiKey(key: string | null): void {
    if (!key) {
      delete this.settings.apiKeyEnc;
    } else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS の暗号化ストレージが使えないため、API キーを保存できません');
      this.settings.apiKeyEnc = safeStorage.encryptString(key.trim()).toString('base64');
    }
    this.writeJson(this.settingsFile, this.settings);
  }

  /** Saved key first, then ANTHROPIC_API_KEY; undefined lets the SDK resolve other credentials. */
  getApiKey(): string | undefined {
    if (this.settings.apiKeyEnc) {
      return safeStorage.decryptString(Buffer.from(this.settings.apiKeyEnc, 'base64'));
    }
    return undefined;
  }

  // ---- journal ----
  private dayFile(date: string) {
    return path.join(this.dir, `${date}.jsonl`);
  }
  private aiFile(date: string) {
    return path.join(this.dir, `${date}.ai.json`);
  }

  append(ev: JournalEvent): string {
    const date = dayKey('ts' in ev ? ev.ts : ev.start);
    fs.appendFileSync(this.dayFile(date), JSON.stringify(ev) + '\n', 'utf8');
    return date;
  }

  readDay(date: string): JournalEvent[] {
    const file = this.dayFile(date);
    if (!fs.existsSync(file)) return [];
    const out: JournalEvent[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a torn last line after a crash; skip it
      }
    }
    return out.sort((a, b) => evTime(a) - evTime(b));
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

