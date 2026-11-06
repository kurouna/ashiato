import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import * as z from 'zod';
import { LocalProvider, describeLocalError } from '../src/main/ai/local';
import { defineTool } from '../src/main/ai/prompts';

// A tiny OpenAI-compatible server that behaves like Ollama / LM Studio would.
let server: http.Server;
let base = '';
let toolsSupported = true;
const seen: any[] = [];

function sse(res: http.ServerResponse, chunks: object[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, ...c }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

before(async () => {
  server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3:14b', object: 'model' }, { id: 'llama3.1', object: 'model' }] }));
    }
    const j = JSON.parse(body);
    seen.push(j);
    // a GPU too busy to start in time, and a proxy that gives up first
    if (j.model === 'slow') await new Promise((r) => setTimeout(r, 1500));
    if (j.model === 'gateway') {
      res.writeHead(504, { 'content-type': 'text/plain' });
      return res.end('Gateway Timeout');
    }
    if (j.tools && !toolsSupported) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'model does not support tools' } }));
    }
    if (!j.stream) {
      // structured output: answer with think tags + fenced JSON, like many local models do
      const content = '<think>考え中</think>```json\n{"blocks":[{"start":"9:00","end":"10:30","title":"実装","project":"p","category":"coding","summary":"s"}]}\n```';
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] }));
    }
    if (j.response_format) {
      // structured output, streamed: think tags + fenced JSON split across chunks, like many local models
      const content = '<think>考え中</think>```json\n{"blocks":[{"start":"9:00","end":"10:30","title":"実装","project":"p","category":"coding","summary":"s"}]}\n```';
      return sse(res, [{ delta: { content: content.slice(0, 20) } }, { delta: { content: content.slice(20, 70) } }, { delta: { content: content.slice(70) }, finish_reason: 'stop' }]);
    }
    const last = j.messages[j.messages.length - 1];
    if (j.tools && last.role === 'user') {
      // first turn: call a tool, arguments split across chunks
      return sse(res, [
        { delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search_events', arguments: '{"que' } }] } },
        { delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"kanban"}' } }] } },
        { delta: {}, finish_reason: 'tool_calls' },
      ]);
    }
    // plain streamed answer with a <think> tag straddling chunks
    return sse(res, [{ delta: { content: '<thi' } }, { delta: { content: 'nk>内緒</th' } }, { delta: { content: 'ink>こんにちは' } }, { delta: { content: '、記録です' }, finish_reason: 'stop' }]);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => server.close());

const collect = () => {
  const out = { text: '', thinking: '', tools: [] as string[] };
  return { out, emit: (k: 'text' | 'thinking' | 'tool', d: string) => (k === 'tool' ? out.tools.push(d) : (out[k] += d)) };
};

test('listModels reads /models', async () => {
  assert.deepEqual(await LocalProvider.listModels(base), ['llama3.1', 'qwen3:14b']);
});

test('segment requests a JSON schema and parses fenced output', async () => {
  const p = new LocalProvider(base, 'qwen3:14b');
  const { out, emit } = collect();
  const res = await p.segment('sys', 'user', new AbortController().signal, emit);
  assert.ok(out.text.length > 0 && out.thinking === '考え中', 'progress is streamed while the JSON arrives');
  assert.equal(seen.at(-1).stream, true);
  assert.equal(res.blocks[0].title, '実装');
  assert.equal(seen.at(-1).response_format.type, 'json_schema');
});

test('report streams text and routes <think> to the thinking channel', async () => {
  const p = new LocalProvider(base, 'qwen3:14b');
  const { out, emit } = collect();
  const res = await p.report('sys', 'user', emit, new AbortController().signal);
  assert.equal(res.text, 'こんにちは、記録です');
  assert.equal(out.thinking, '内緒');
  assert.equal(out.text, 'こんにちは、記録です');
});

test('ask runs tool calls with validated arguments, then answers', async () => {
  toolsSupported = true;
  let got: unknown;
  const tool = defineTool({ name: 'search_events', description: 'd', schema: z.object({ query: z.string() }), run: async (i) => ((got = i), '2026-11-05 10:00 [Code] kanban') });
  const p = new LocalProvider(base, 'qwen3:14b');
  const { out, emit } = collect();
  const answer = await p.ask('sys', [{ role: 'user', content: 'q' }], [tool], emit, new AbortController().signal, () => '');
  assert.deepEqual(got, { query: 'kanban' });
  assert.equal(answer, 'こんにちは、記録です');
  assert.match(out.tools[0], /search_events/);
  const toolMsg = seen.at(-1).messages.find((m: any) => m.role === 'tool');
  assert.equal(toolMsg.content, '2026-11-05 10:00 [Code] kanban');
});

test('ask falls back to pasted context when the model has no tool support', async () => {
  toolsSupported = false;
  const p = new LocalProvider(base, 'tiny');
  const { emit } = collect();
  const answer = await p.ask('sys', [{ role: 'user', content: 'q' }], [defineTool({ name: 't', description: 'd', schema: z.object({}), run: async () => '' })], emit, new AbortController().signal, () => 'RECENT');
  assert.equal(answer, 'こんにちは、記録です');
  assert.match(seen.at(-1).messages[0].content, /RECENT/);
  toolsSupported = true;
});

test('a server that does not start answering in time reports a timeout, not "cannot connect"', async () => {
  const p = new LocalProvider(base, 'slow', undefined, 300);
  const { emit } = collect();
  const err = await p.report('sys', 'user', emit, new AbortController().signal).then(() => null, (e) => e);
  const msg = describeLocalError(err, base, 10) ?? '';
  assert.match(msg, /10 分以内に応答を始めませんでした/);
  assert.doesNotMatch(msg, /接続できません/);
});

test('a proxy timeout (504) is named as such', async () => {
  const p = new LocalProvider(base, 'gateway');
  const { emit } = collect();
  const err = await p.report('sys', 'user', emit, new AbortController().signal).then(() => null, (e) => e);
  assert.match(describeLocalError(err, base) ?? '', /プロキシやゲートウェイ.*504/);
});
