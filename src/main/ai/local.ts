import OpenAI from 'openai';
import * as z from 'zod';
import { AiStop, BlocksSchema, ChatTurn, Emit, Provider, ToolDef } from './prompts';

type Msg = OpenAI.Chat.ChatCompletionMessageParam;
const MAX_TOOL_ROUNDS = 10;

/**
 * Any OpenAI-compatible Chat Completions server: Ollama, LM Studio, vLLM, llama.cpp server, LocalAI…
 * Local models vary a lot, so every step degrades gracefully (JSON schema → JSON mode → repair, tools → no tools).
 */
export class LocalProvider implements Provider {
  readonly label: string;
  private client: OpenAI;

  constructor(
    baseURL: string,
    private model: string,
    apiKey?: string,
  ) {
    if (!model) throw new AiStop('ローカル LLM のモデル名が設定されていません。⚙ から「接続テスト」でモデルを選んでください。');
    this.label = `${model} @ ${hostOf(baseURL)}`;
    this.client = new OpenAI({ baseURL, apiKey: apiKey || 'not-needed', timeout: 10 * 60_000, maxRetries: 1 });
  }

  static async listModels(baseURL: string, apiKey?: string): Promise<string[]> {
    const client = new OpenAI({ baseURL, apiKey: apiKey || 'not-needed', timeout: 10_000, maxRetries: 0 });
    const ids: string[] = [];
    for await (const m of client.models.list()) ids.push(m.id);
    return ids.sort();
  }

  async segment(system: string, user: string) {
    const schema = z.toJSONSchema(BlocksSchema);
    const messages: Msg[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    let content: string;
    try {
      content = await this.complete(messages, { type: 'json_schema', json_schema: { name: 'work_blocks', schema, strict: true } });
    } catch (err) {
      if (!(err instanceof OpenAI.BadRequestError)) throw err;
      // server without json_schema support: plain JSON mode with the schema spelled out
      messages[0] = { role: 'system', content: `${system}\n\n次の JSON Schema に従う JSON だけを出力してください:\n${JSON.stringify(schema)}` };
      content = await this.complete(messages, { type: 'json_object' });
    }
    let parsed = BlocksSchema.safeParse(extractJson(content));
    if (!parsed.success) {
      messages.push({ role: 'assistant', content }, { role: 'user', content: `出力がスキーマに合いません: ${parsed.error.message.slice(0, 800)}\n修正した JSON だけを出力してください。` });
      parsed = BlocksSchema.safeParse(extractJson(await this.complete(messages, { type: 'json_object' })));
    }
    if (!parsed.success) throw new AiStop('ローカル LLM の出力を作業ブロックとして読み取れませんでした。より大きなモデルを試してください。');
    return { blocks: parsed.data.blocks, model: this.model };
  }

  async report(system: string, user: string, emit: Emit, signal: AbortSignal) {
    const text = await this.streamText(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      undefined,
      emit,
      signal,
    );
    return { text: text.content.trim(), model: this.model };
  }

  async ask(system: string, turns: ChatTurn[], tools: ToolDef[], emit: Emit, signal: AbortSignal, fallbackContext: () => string) {
    const messages: Msg[] = [{ role: 'system', content: system }, ...turns];
    const wire: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.schema) as Record<string, unknown> },
    }));

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let res: StreamResult;
      try {
        res = await this.streamText(messages, wire, emit, signal);
      } catch (err) {
        if (round === 0 && err instanceof OpenAI.BadRequestError) {
          // model/server without tool calling: answer from the recent days pasted into the prompt instead
          emit('tool', 'ツール非対応のモデルのため、直近の記録を直接読み込みます');
          const ctx = fallbackContext();
          const res2 = await this.streamText([{ role: 'system', content: `${system}\n\n<recent_days>\n${ctx ?? ''}\n</recent_days>` }, ...turns], undefined, emit, signal);
          return res2.content.trim();
        }
        throw err;
      }
      if (!res.toolCalls.length) return res.content.trim();

      messages.push({
        role: 'assistant',
        content: res.content || null,
        tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
      });
      for (const call of res.toolCalls) {
        emit('tool', `${call.name} ${call.args}`);
        messages.push({ role: 'tool', tool_call_id: call.id, content: await runTool(tools, call.name, call.args) });
      }
      emit('text', '\n\n');
    }
    throw new AiStop('ツール呼び出しが多すぎるため中断しました');
  }

  private async complete(messages: Msg[], response_format: OpenAI.Chat.ChatCompletionCreateParams['response_format']) {
    const res = await this.client.chat.completions.create({ model: this.model, messages, response_format, temperature: 0.2 });
    return stripThink(res.choices[0]?.message?.content ?? '');
  }

  private async streamText(messages: Msg[], tools: OpenAI.Chat.ChatCompletionTool[] | undefined, emit: Emit, signal: AbortSignal): Promise<StreamResult> {
    const stream = await this.client.chat.completions.create(
      { model: this.model, messages, stream: true, ...(tools?.length ? { tools } : {}) },
      { signal },
    );
    const think = new ThinkSplitter(emit);
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as (OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string; reasoning?: string }) | undefined;
      if (!delta) continue;
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) emit('thinking', reasoning);
      if (delta.content) think.push(delta.content);
      for (const tc of delta.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: tc.id ?? `call_${tc.index}`, name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
    }
    think.flush();
    return { content: think.visible, toolCalls: [...calls.values()].filter((c) => c.name) };
  }
}

interface StreamResult {
  content: string;
  toolCalls: { id: string; name: string; args: string }[];
}

async function runTool(tools: ToolDef[], name: string, args: string): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return `エラー: ${name} というツールはありません`;
  let input: unknown;
  try {
    input = args.trim() ? JSON.parse(args) : {};
  } catch {
    return 'エラー: 引数が JSON として読めません';
  }
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return `エラー: 引数が不正です: ${parsed.error.message.slice(0, 500)}`;
  try {
    return await tool.run(parsed.data);
  } catch (err) {
    return `エラー: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Routes <think>…</think> (Qwen3, DeepSeek-R1 style) to the thinking channel, even when tags straddle chunks. */
class ThinkSplitter {
  visible = '';
  private buf = '';
  private inThink = false;
  constructor(private emit: Emit) {}

  push(s: string) {
    this.buf += s;
    for (;;) {
      const tag = this.inThink ? '</think>' : '<think>';
      const i = this.buf.indexOf(tag);
      if (i >= 0) {
        this.out(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // keep a possible partial tag at the end for the next chunk
      const keep = partialSuffix(this.buf, tag);
      this.out(this.buf.slice(0, this.buf.length - keep));
      this.buf = this.buf.slice(this.buf.length - keep);
      return;
    }
  }

  flush() {
    this.out(this.buf);
    this.buf = '';
  }

  private out(s: string) {
    if (!s) return;
    if (this.inThink) this.emit('thinking', s);
    else {
      this.visible += s;
      this.emit('text', s);
    }
  }
}

function partialSuffix(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(-n))) return n;
  return 0;
}

export function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export function extractJson(s: string): unknown {
  const t = stripThink(s);
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function describeLocalError(err: unknown, baseURL: string): string | null {
  if (err instanceof OpenAI.APIUserAbortError) return '中止しました';
  if (err instanceof OpenAI.APIConnectionError) return `ローカル LLM（${baseURL}）に接続できません。サーバーが起動しているか、URL が正しいか確認してください。`;
  if (err instanceof OpenAI.NotFoundError) return `モデルまたはエンドポイントが見つかりません（${baseURL}）。モデル名と URL（末尾は通常 /v1）を確認してください。`;
  if (err instanceof OpenAI.AuthenticationError) return 'ローカル LLM サーバーに認証で拒否されました。API キーを確認してください。';
  if (err instanceof OpenAI.APIError) return `ローカル LLM エラー (${err.status ?? '?'}): ${err.message}`;
  return null;
}
