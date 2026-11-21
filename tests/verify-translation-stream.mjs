/* Synthetic responses only; exercises the production transport, never the API. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import vm from 'node:vm';

const read = async (name) => new TextDecoder('utf-8', { fatal: true })
  .decode(await readFile(new URL(name, import.meta.url))).replace(/\r\n/g, '\n');
const app = await read('../web/app.js');
const transportPath = new URL('../web/translation-stream.js', import.meta.url);
const transport = existsSync(transportPath) ? await read('../web/translation-stream.js') : '';
const start = app.indexOf('  function chatStream(');
const end = app.indexOf('\n  /* ---------------- 6.', start);
assert.ok(start >= 0 && end > start);
const encoder = new TextEncoder();
const event = (json, newline = '\n') => 'data: ' + JSON.stringify(json) + newline + newline;
const delta = (text) => ({ choices: [{ delta: { content: text }, finish_reason: null }] });
const stop = { choices: [{ delta: {}, finish_reason: 'stop' }] };
let requests = 0;
async function run(parts, options = {}) {
  const output = [];
  let cancelled = false;
  const response = {
    ok: true,
    headers: { get: () => options.json ? 'application/json' : 'text/event-stream' },
    body: options.json ? null : { getReader() {
      const queue = parts.map((part) => typeof part === 'string' ? encoder.encode(part) : part);
      return { read: async () => queue.length ? { value: queue.shift(), done: false } : { done: true },
        cancel: async () => { cancelled = true; }, releaseLock() {} };
    } },
    json: async () => options.json,
  };
  const context = vm.createContext({ window: {}, performance, AbortController, TextDecoder,
    setTimeout, clearTimeout, fetch: async () => { requests++; return response; },
    CHAT_URL: 'https://synthetic.invalid/chat', describeError: () => 'synthetic HTTP failure' });
  if (transport) vm.runInContext(transport, context);
  const chatStream = vm.runInContext(app.slice(start, end) + '\nchatStream;', context);
  const result = await chatStream({}, (text) => output.push(text), options.signal, options.sourceText);
  return { result, output: output.join(''), cancelled };
}

await assert.rejects(run([event(delta('partial')), event({ choices: [{ finish_reason: 'length' }] })]),
  /截断|length/, 'Token exhaustion cannot be a successful translation');
for (const newline of ['\n', '\r\n', '\r']) {
  const frame = event(delta('完整译文🙂'), newline) + event(stop, newline) + 'data: [DONE]';
  const bytes = encoder.encode(frame);
  const result = await run(Array.from(bytes, (byte) => new Uint8Array([byte])));
  assert.equal(result.result.text, '完整译文🙂');
  assert.equal(result.output, '完整译文🙂', 'Chunked UTF-8 and newline boundaries preserve text');
}
assert.equal((await run([event(delta('末帧')), 'data: ' + JSON.stringify(stop)])).result.text, '末帧');
assert.equal((await run([event(delta('A')) + event(stop) + 'data: [DONE]\n\n' + event(delta('B'))])).result.text,
  'A', 'Frames after DONE are ignored even within the same network chunk');
await assert.rejects(run(['event: error\ndata: {"error":{"message":"synthetic denied"}}\n\n']), /synthetic denied/);
await assert.rejects(run([event(delta('incomplete'))]), /中断|结束|完整/);
await assert.rejects(run([event(delta('incomplete')), 'data: [DONE]\n\n']), /中断|结束|完整/);
await assert.rejects(run(['data: {broken}\n\n', event(stop)]), /解析|格式/);
await assert.rejects(run([event(stop), 'data: [DONE]\n\n']), /空|译文/);
assert.equal((await run([], { json: { choices: [{ message: { content: 'JSON response' }, finish_reason: 'stop' }] } })).result.text,
  'JSON response');
await assert.rejects(run([], { json: { choices: [{ message: { content: 'truncated' }, finish_reason: 'length' }] } }), /截断|length/);
const repeatedSource = 'chick '.repeat(50);
const repeatedTranslation = '小鸡'.repeat(50);
const legitimate = await run([event(delta(repeatedTranslation)), event(stop)], { sourceText: repeatedSource });
assert.equal(legitimate.result.text, repeatedTranslation,
  'The real chatStream adapter forwards original repetition context to the transport');
assert.equal(legitimate.output, repeatedTranslation);
assert.equal(legitimate.cancelled, true);
const repetitionError = { name: 'TranslationRepetitionError', code: 'repetitive_output', message: /异常重复.*重试/ };
await assert.rejects(run([event(delta(repeatedTranslation)), event(stop)]), repetitionError,
  'The adapter still protects translations when no original repetition context is supplied');
await assert.rejects(run([event(delta('小鸡'.repeat(200))), event(stop)], { sourceText: repeatedSource }), repetitionError,
  'Forwarding the original context does not disable the runaway guard');
await assert.rejects(run([], { sourceText: repeatedSource,
  json: { choices: [{ message: { content: '小鸡'.repeat(200) }, finish_reason: 'stop' }] } }), repetitionError,
  'The adapter propagates repetition failures from the complete JSON branch');
const splitEmoji = (count) => Array.from({ length: count }, () => event(delta('\ud83d')) + event(delta('\ude42')));
const normalEmoji = await run([...splitEmoji(3), event(stop)]);
assert.equal(normalEmoji.result.text, '🙂🙂🙂', 'Separate surrogate halves in SSE deltas preserve normal output');
assert.equal(normalEmoji.output, '🙂🙂🙂');
await assert.rejects(run([...splitEmoji(100), event(stop)]), repetitionError,
  'A repeating emoji cannot bypass protection by splitting surrogate halves across SSE deltas');
assert.ok(requests > 0);
console.log('Translation stream completeness, framing and repetition adapter checks passed.');
