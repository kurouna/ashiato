import * as z from 'zod';
import { defang, redact } from '../../shared/redact';
import { DayAi, WorkBlock, dayKey, evTime, hhmm } from '../../shared/types';
import { compressDay } from '../compress';
import { Recorder } from '../recorder';
import { Store } from '../store';
import { ClaudeProvider, describeClaudeError } from './claude';
import { LocalProvider, describeLocalError } from './local';
import { ASK_SYSTEM, AiStop, ChatTurn, Emit, Provider, REPORT_SYSTEM, SEGMENT_SYSTEM, cleanBlocks, defineTool } from './prompts';

const MAX_CHAT_TURNS = 20;

export class Ai {
  private chat: ChatTurn[] = [];
  private running = new Map<string, AbortController>();

  constructor(
    private store: Store,
    private recorder: Recorder,
  ) {}

  preview(date: string): string {
    return compressDay(this.store.readDay(date), date === dayKey(Date.now()) ? this.recorder.live() : null, { redact: this.store.getSettings().redact });
  }

  /** Where the data goes, for the UI to show before anything is sent. */
  destination(): string {
    const s = this.store.getSettings();
    return s.provider === 'local' ? `ローカル LLM: ${s.localModel || '(未設定)'} @ ${s.localBaseUrl}` : `Claude API (Anthropic): ${s.model}`;
  }

  resetChat() {
    this.chat = [];
  }

  cancel(reqId: string) {
    this.running.get(reqId)?.abort();
  }

  async segment(date: string): Promise<DayAi> {
    const timeline = this.requireTimeline(date);
    const provider = await this.provider();
    const res = await provider.segment(SEGMENT_SYSTEM, `日付: ${date}\n\n<timeline>\n${timeline}\n</timeline>`);
    const blocks: WorkBlock[] = cleanBlocks(res.blocks);
    if (!blocks.length) throw new AiStop('作業ブロックを作れませんでした');
    return this.store.writeAi(date, { blocks, blocksAt: Date.now(), model: res.model });
  }

  async report(date: string, reqId: string, emit: Emit): Promise<DayAi> {
    const timeline = this.requireTimeline(date);
    const provider = await this.provider();
    const settings = this.store.getSettings();
    const ai = this.store.readAi(date);
    const blocks = ai.blocks?.length
      ? ai.blocks.map((b) => `- ${b.start}–${b.end} [${b.category}] ${b.title}${b.project ? ` (${b.project})` : ''}: ${b.summary}`).join('\n')
      : '（未整理）';
    const user = `日付: ${date}\n\n<template>\n${settings.reportTemplate}\n</template>\n\n<work_blocks>\n${blocks}\n</work_blocks>\n\n<timeline>\n${timeline}\n</timeline>`;
    const res = await this.withAbort(reqId, (signal) => provider.report(REPORT_SYSTEM, user, emit, signal));
    if (!res.text) throw new AiStop('日報が空でした。もう一度お試しください。');
    return this.store.writeAi(date, { report: res.text, reportAt: Date.now(), model: res.model });
  }

  async ask(question: string, reqId: string, emit: Emit): Promise<string> {
    const provider = await this.provider();
    const now = new Date();
    const stamp = `${dayKey(now.getTime())} (${'日月火水木金土'[now.getDay()]}) ${hhmm(now.getTime())}`;
    const turns: ChatTurn[] = [...this.chat, { role: 'user', content: `[現在: ${stamp}]\n${question}` }];
    const answer = await this.withAbort(reqId, (signal) => provider.ask(ASK_SYSTEM, turns, this.tools(), emit, signal, () => this.recentDays(7)));
    // keep the visible conversation only; tools are re-run on demand
    this.chat = [...turns, { role: 'assistant' as const, content: answer || '（回答なし）' }].slice(-MAX_CHAT_TURNS);
    if (this.chat[0]?.role === 'assistant') this.chat.shift();
    return answer;
  }

  describeError(err: unknown): string {
    const s = this.store.getSettings();
    const known = s.provider === 'local' ? describeLocalError(err, s.localBaseUrl) : describeClaudeError(err);
    if (known) return known;
    if (err instanceof z.ZodError) return err.issues[0]?.message ?? '入力が不正です';
    if (err instanceof Error) {
      if (err.name === 'AbortError') return '中止しました';
      if (/api key|apiKey|authentication/i.test(err.message)) return 'API キーが設定されていません。⚙ から設定するか、ローカル LLM に切り替えてください。';
      return err.message;
    }
    return String(err);
  }

  private requireTimeline(date: string) {
    const timeline = this.preview(date);
    if (!timeline) throw new AiStop('この日の記録がまだありません');
    return timeline;
  }

  private async provider(): Promise<Provider> {
    const s = this.store.getSettings();
    if (s.provider === 'local') return new LocalProvider(s.localBaseUrl, s.localModel, await this.store.getSecret('local'));
    return new ClaudeProvider(await this.store.getSecret('claude'), s.model);
  }

  private async withAbort<T>(reqId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctl = new AbortController();
    this.running.set(reqId, ctl);
    try {
      return await fn(ctl.signal);
    } finally {
      this.running.delete(reqId);
    }
  }

  private recentDays(n: number): string {
    return this.store
      .listDays()
      .slice(-n)
      .map((d) => `# ${d}\n${this.preview(d)}`)
      .join('\n\n')
      .slice(-60_000);
  }

  private tools() {
    const store = this.store;
    return [
      defineTool({
        name: 'list_days',
        description: '記録がある日付の一覧と、各日のアクティブ時間（分）・イベント数を返す。',
        schema: z.object({}),
        run: async () => JSON.stringify(store.summarizeDays()),
      }),
      defineTool({
        name: 'get_day',
        description: '指定日のタイムライン（整理済みなら作業ブロックと日報も）を返す。date は YYYY-MM-DD。',
        schema: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
        run: async ({ date }) => {
          const timeline = this.preview(date);
          if (!timeline) return `${date} の記録はありません`;
          const ai = store.readAi(date);
          const blocks = ai.blocks?.map((b) => `- ${b.start}–${b.end} ${b.title} (${b.project || '-'}): ${b.summary}`).join('\n');
          return [`# ${date}`, blocks ? `## 作業ブロック\n${blocks}` : '', ai.report ? `## 日報\n${ai.report}` : '', `## タイムライン\n<timeline>\n${timeline}\n</timeline>`]
            .filter(Boolean)
            .join('\n\n');
        },
      }),
      defineTool({
        name: 'search_events',
        description:
          'ウィンドウタイトル・ファイルパス・コミットメッセージ・メモをキーワードで部分一致検索する（大文字小文字無視、スペース区切りは AND）。from/to は YYYY-MM-DD で省略可。最大80件。',
        schema: z.object({
          query: z.string().min(1),
          from: z.string().optional(),
          to: z.string().optional(),
        }),
        run: async ({ query, from, to }) => {
          const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
          const hits: string[] = [];
          for (const date of store.listDays()) {
            if ((from && date < from) || (to && date > to)) continue;
            for (const e of store.readDay(date)) {
              const text =
                e.t === 'window' ? `[${e.app}] ${e.title}` : e.t === 'file' ? `file ${e.path}` : e.t === 'commit' ? `commit <${e.repo}> ${e.subject}` : e.t === 'memo' ? `memo ${e.text}` : '';
              if (!text) continue;
              const low = text.toLowerCase();
              if (terms.every((t) => low.includes(t))) hits.push(`${date} ${hhmm(evTime(e))} ${text}`);
            }
          }
          const scrub = store.getSettings().redact ? (t: string) => redact(defang(t)) : defang;
          const unique = [...new Set(hits.map(scrub))];
          return unique.length ? unique.slice(-80).join('\n') + (unique.length > 80 ? `\n（ほか ${unique.length - 80} 件。期間を絞ってください）` : '') : '該当なし';
        },
      }),
    ];
  }
}

export { LocalProvider };
