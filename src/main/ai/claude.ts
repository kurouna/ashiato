import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat, betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { AiStop, BlocksSchema, ChatTurn, Emit, Provider, ToolDef } from './prompts';

export class ClaudeProvider implements Provider {
  readonly label: string;
  private client: Anthropic;
  private base: { model: string; betas?: Anthropic.Beta.AnthropicBeta[]; fallbacks?: 'default' };

  constructor(apiKey: string | undefined, model: string) {
    this.label = model;
    this.client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY ?? null });
    // Server-side fallback reroutes a safety decline to a suitable model; Haiku has no server-side fallback.
    this.base = model.startsWith('claude-haiku') ? { model } : { model, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
  }

  async segment(system: string, user: string, signal: AbortSignal) {
    const msg = await this.client.beta.messages.parse(
      {
        ...this.base,
        max_tokens: 16000,
        output_config: { effort: 'medium', format: betaZodOutputFormat(BlocksSchema) },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
      },
      { signal },
    );
    assertNotRefused(msg.stop_reason);
    const blocks = msg.parsed_output?.blocks;
    if (!blocks) throw new AiStop('作業ブロックを読み取れませんでした（出力が途中で切れた可能性があります）');
    return { blocks, model: msg.model };
  }

  async report(system: string, user: string, emit: Emit, signal: AbortSignal) {
    const stream = this.client.beta.messages.stream(
      {
        ...this.base,
        max_tokens: 64000,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'high' },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
      },
      { signal },
    );
    stream.on('text', (d) => emit('text', d));
    stream.on('thinking', (d) => emit('thinking', d));
    const msg = await stream.finalMessage();
    assertNotRefused(msg.stop_reason);
    return { text: textOf(msg.content), model: msg.model };
  }

  async ask(system: string, turns: ChatTurn[], tools: ToolDef[], emit: Emit, signal: AbortSignal) {
    let runner = this.client.beta.messages.toolRunner(
      {
        ...this.base,
        max_tokens: 64000,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: tools.map((t) =>
          betaZodTool({ name: t.name, description: t.description, inputSchema: t.schema, eager_input_streaming: true, run: (input) => t.run(input) }),
        ),
        messages: turns,
        stream: true,
        max_iterations: 12,
      },
      { signal },
    );

    let answer = '';
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const messageStream of runner) {
          for await (const event of messageStream) {
            if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') emit('text', event.delta.text);
              else if (event.delta.type === 'thinking_delta') emit('thinking', event.delta.thinking);
            }
          }
          const message = await messageStream.finalMessage();
          attempt = 0;
          const toolUses = message.content.filter((b) => b.type === 'tool_use');
          assertNotRefused(message.stop_reason);
          if (message.stop_reason === 'max_tokens' && toolUses.length) throw new AiStop('ツール入力が途中で切れました');
          for (const t of toolUses) emit('tool', `${t.name} ${JSON.stringify(t.input)}`);
          if (!toolUses.length) answer = textOf(message.content);
          else emit('text', '\n\n');
        }
        break;
      } catch (err) {
        // only an unparseable tool input is retried; API errors, aborts and our own stops are final
        if (err instanceof Anthropic.APIError || err instanceof AiStop || signal.aborted || attempt >= 2) throw err;
        runner = this.client.beta.messages.toolRunner({ ...runner.params }, { signal });
      }
    }
    return answer;
  }
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function assertNotRefused(stop: string | null | undefined) {
  if (stop === 'refusal') throw new AiStop('Claude がこのリクエストへの回答を辞退しました。除外キーワードで該当ウィンドウを外すと通る場合があります。');
}

export function describeClaudeError(err: unknown): string | null {
  if (err instanceof Anthropic.APIUserAbortError) return '中止しました';
  if (err instanceof Anthropic.AuthenticationError) return 'Claude API キーが無効です。設定から確認してください。';
  if (err instanceof Anthropic.RateLimitError) return 'レート制限に達しました。少し待ってから再試行してください。';
  if (err instanceof Anthropic.APIConnectionError) return 'Claude API に接続できませんでした。ネットワークやプロキシ設定を確認してください。';
  if (err instanceof Anthropic.APIError) return `Claude API エラー (${err.status ?? '?'}): ${err.message}`;
  return null;
}
