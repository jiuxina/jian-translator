/* Production transport against memory-only responses and a manually advanced clock. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = new TextDecoder('utf-8', { fatal: true }).decode(
  await readFile(new URL('../web/translation-stream.js', import.meta.url)));
const encoder = new TextEncoder();
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const delta = (text) => ({ choices: [{ delta: { content: text }, finish_reason: null }] });
const stop = { choices: [{ delta: {}, finish_reason: 'stop' }] };
const flush = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(fetcher) {
  let now = 100, sequence = 0;
  const timers = new Map(), requests = [], output = [];
  const context = vm.createContext({ window: {}, AbortController, TextDecoder,
    performance: { now: () => now },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: (url, options) => { requests.push({ url, options }); return fetcher(url, options); },
  });
  vm.runInContext(source, context);
  return {
    requests, output, timers,
    request(options = {}) {
      return context.window.ItTranslationStream.request('https://synthetic.invalid/chat', {}, {
        onDelta: (text) => output.push(text), connectTimeoutMs: 30, idleTimeoutMs: 60, ...options,
      });
    },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
      await flush();
    },
  };
}
function streaming(parts, { hold = false } = {}) {
  const queue = parts.map((part) => encoder.encode(part));
  const pendingRead = deferred();
  let cancels = 0, reads = 0;
  return {
    get cancels() { return cancels; },
    get reads() { return reads; },
    pendingRead,
    response: {
      ok: true, headers: { get: () => 'text/event-stream; charset=utf-8' },
      body: { getReader: () => ({
        read: () => { reads++; return queue.length ? Promise.resolve({ value: queue.shift(), done: false })
          : hold ? pendingRead.promise : Promise.resolve({ done: true }); },
        cancel: () => { cancels++; return Promise.resolve(); },
      }) },
    },
  };
}

const cases = [];
function test(name, run) { cases.push({ name, run }); }

test('connection timeout aborts transport and clears its timer', async () => {
  const pending = deferred();
  const test = fixture(() => pending.promise);
  const result = test.request();
  const rejection = assert.rejects(result, /超时/);
  await test.advance(29);
  assert.equal(test.requests[0].options.signal.aborted, false);
  await test.advance(1);
  await rejection;
  assert.equal(test.requests[0].options.signal.aborted, true);
  assert.equal(test.timers.size, 0);
});

test('stream idle timeout cancels a reader and never promotes preview', async () => {
  const stream = streaming([event(delta('preview'))], { hold: true });
  const test = fixture(async () => stream.response);
  const result = test.request();
  const rejection = assert.rejects(result, /超时/);
  await flush();
  assert.deepEqual(test.output, ['preview']);
  await test.advance(60);
  await rejection;
  assert.equal(stream.cancels, 1);
  assert.equal(test.timers.size, 0);
});

test('JSON body timeout uses the idle budget after headers', async () => {
  const body = deferred();
  const test = fixture(async () => ({ ok: true, headers: { get: () => 'application/json' }, json: () => body.promise }));
  const result = test.request();
  const rejection = assert.rejects(result, /超时/);
  await flush(); await test.advance(60); await rejection;
  assert.equal(test.timers.size, 0);
});

test('each received chunk resets the idle budget', async () => {
  const reads = [];
  let cancels = 0;
  const test = fixture(async () => ({ ok: true, headers: { get: () => 'text/event-stream' },
    body: { getReader: () => ({
      read: () => { const operation = deferred(); reads.push(operation); return operation.promise; },
      cancel: async () => { cancels++; },
    }) },
  }));
  const result = test.request();
  await flush(); await test.advance(40);
  reads[0].resolve({ done: false, value: encoder.encode(event(delta('fresh data'))) });
  await flush(); await test.advance(40);
  assert.equal(test.requests[0].options.signal.aborted, false, 'A live stream does not use its original idle deadline');
  reads[1].resolve({ done: false, value: encoder.encode(event(stop) + 'data: [DONE]\n\n') });
  assert.equal((await result).text, 'fresh data');
  assert.equal(cancels, 1);
  assert.equal(test.timers.size, 0);
});

test('explicit abort cancels a pending reader and drops a late chunk', async () => {
  const stream = streaming([], { hold: true });
  const test = fixture(async () => stream.response);
  const aborter = new AbortController();
  const result = test.request({ signal: aborter.signal });
  const rejection = assert.rejects(result, { name: 'AbortError' });
  await flush(); aborter.abort(); await rejection;
  stream.pendingRead.resolve({ value: encoder.encode(event(delta('too late'))), done: false });
  await flush();
  assert.deepEqual(test.output, []);
  assert.equal(stream.cancels, 1);
  assert.equal(test.timers.size, 0);
});

test('already aborted requests cannot emit deltas or succeed', async () => {
  const stream = streaming([event(delta('must not arrive')), event(stop), 'data: [DONE]\n\n']);
  const test = fixture(async () => stream.response);
  const aborter = new AbortController(); aborter.abort();
  await assert.rejects(test.request({ signal: aborter.signal }), { name: 'AbortError' });
  assert.deepEqual(test.output, []);
  assert.equal(test.timers.size, 0);
});

test('multi-line data joins JSON and preserves usage-only frames', async () => {
  const stream = streaming([
    ': heartbeat\r\nid: 123\r\ndata: {"choices":[\r\ndata: {"delta":{"content":"multi-line"},"finish_reason":null}]}\r\n\r\n',
    event(stop), event({ choices: [], usage: { total_tokens: 17 } }), 'data: [DONE]\n\n',
  ]);
  const test = fixture(async () => stream.response);
  const result = await test.request();
  assert.equal(result.text, 'multi-line');
  assert.equal(result.usage.total_tokens, 17);
  assert.equal(stream.cancels, 1);
  assert.equal(test.timers.size, 0);
});

test('DONE terminates parsing within the same network chunk', async () => {
  const stream = streaming([event(delta('complete')) + event(stop) + 'data: [DONE]\n\ndata: broken trailer\n\n']);
  const test = fixture(async () => stream.response);
  assert.equal((await test.request()).text, 'complete');
});

test('an early DONE fails even when more data follows it', async () => {
  const stream = streaming([event(delta('preview')) + 'data: [DONE]\n\n' + event(stop)]);
  const test = fixture(async () => stream.response);
  await assert.rejects(test.request(), /中断|结束/);
});

test('HTTP error uses the supplied status and response description', async () => {
  const calls = [];
  const test = fixture(async () => ({ ok: false, status: 429, text: async () => 'synthetic quota' }));
  await assert.rejects(test.request({ describeError(status, body) {
    calls.push([status, body]); return 'rate limited';
  } }), /rate limited/);
  assert.deepEqual(calls, [[429, 'synthetic quota']]);
  assert.equal(test.timers.size, 0);
});

test('consumer failure cancels the reader and clears timers', async () => {
  const stream = streaming([event(delta('preview'))], { hold: true });
  const test = fixture(async () => stream.response);
  await assert.rejects(test.request({ onDelta() { throw new Error('synthetic rendering failure'); } }), /rendering failure/);
  assert.equal(stream.cancels, 1);
  assert.equal(test.timers.size, 0);
});

test('JSON completion succeeds without SSE DONE but rejects filtered text', async () => {
  const complete = fixture(async () => ({ ok: true, headers: { get: () => 'application/json' },
    json: async () => ({ choices: [{ message: { content: 'JSON complete' }, finish_reason: 'stop' }] }) }));
  assert.equal((await complete.request()).text, 'JSON complete');
  const filtered = fixture(async () => ({ ok: true, headers: { get: () => 'application/json' },
    json: async () => ({ choices: [{ message: { content: 'hidden' }, finish_reason: 'content_filter' }] }) }));
  await assert.rejects(filtered.request(), /正常完成|content_filter/);
  assert.deepEqual(filtered.output, []);
});

const failures = [];
for (const entry of cases) {
  try { await entry.run(); console.log(`PASS ${entry.name}`); }
  catch (error) { failures.push(entry.name); console.error(`FAIL ${entry.name}: ${error.message}`); }
}
assert.deepEqual(failures, [], `Stream boundary failures: ${failures.join('; ')}`);
console.log(`Translation transport boundaries: ${cases.length}/${cases.length} passed.`);
