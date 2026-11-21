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
  const queue = parts.map((part) => typeof part === 'string' ? encoder.encode(part) : part);
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

const repetitionError = {
  name: 'TranslationRepetitionError',
  code: 'repetitive_output',
  message: '检测到译文异常重复，已停止输出，请重试',
};

test('a live Chinese word loop stops early and cleans up the transport', async () => {
  const parts = [event(delta('这是一只')),
    ...Array.from({ length: 100 }, () => event(delta('小鸡'))),
    event(delta('must not arrive')), event(stop), 'data: [DONE]\n\n'];
  const stream = streaming(parts);
  const test = fixture(async () => stream.response);
  await assert.rejects(test.request({ sourceText: 'This is a chick.' }), repetitionError);
  assert.ok(test.output.join('').startsWith('这是一只'));
  assert.ok(test.output.join('').length < 80, 'The preview stays bounded before the runaway stream is stopped');
  assert.ok(stream.reads < parts.length, 'Detection stops reading without waiting for the provider to finish');
  assert.equal(stream.cancels, 1);
  assert.equal(test.requests.length, 1, 'A rejected translation is not retried automatically');
  assert.equal(test.requests[0].options.signal.aborted, true);
  assert.equal(test.timers.size, 0);
  stream.pendingRead.resolve({ done: false, value: encoder.encode(event(delta('late content'))) });
  await flush();
  assert.ok(!test.output.join('').includes('late content'));
});

test('single characters, English words, emoji and whole sentences cannot loop indefinitely', async () => {
  const patterns = ['鸡', 'chick ', '🙂', '这是一只快乐的小鸡，正在草地上散步。\n'];
  for (const pattern of patterns) {
    const stream = streaming([event(delta(pattern.repeat(100))), event(stop)]);
    const test = fixture(async () => stream.response);
    await assert.rejects(test.request(), repetitionError, `Runaway unit: ${pattern}`);
    assert.deepEqual(test.output, [], 'An offending single delta is rejected before rendering');
    assert.equal(stream.cancels, 1);
  }
});

test('a long periodic sentence is detected without requiring a short repeated word', async () => {
  const sentence = Array.from({ length: 512 }, (_, index) => String.fromCharCode(0x4e00 + index)).join('');
  const stream = streaming([event(delta(sentence.repeat(9))), event(stop)]);
  const test = fixture(async () => stream.response);
  await assert.rejects(test.request(), repetitionError);
  assert.deepEqual(test.output, []);
});

test('repetition inside a large delta is caught even when different text follows it', async () => {
  const stream = streaming([event(delta('正常开头。' + '小鸡'.repeat(100) + '这是不同的结尾。')) + event(stop)]);
  const test = fixture(async () => stream.response);
  await assert.rejects(test.request(), repetitionError);
  assert.deepEqual(test.output, [], 'A safe-looking suffix cannot hide an earlier loop in the same delta');
  assert.equal(stream.reads, 1);
});

test('loop detection survives SSE and UTF-8 network boundaries', async () => {
  const wire = Array.from({ length: 50 }, () => event(delta('小')) + event(delta('鸡🙂'))).join('') + event(stop);
  const stream = streaming(Array.from(encoder.encode(wire), byte => Uint8Array.of(byte)));
  const test = fixture(async () => stream.response);
  await assert.rejects(test.request(), repetitionError);
  assert.ok(test.output.join('').length < 100);
  assert.equal(stream.cancels, 1);
  assert.equal(test.timers.size, 0);
});

test('a complete JSON response with a runaway loop is rejected before preview or success', async () => {
  const test = fixture(async () => ({ ok: true, headers: { get: () => 'application/json' },
    json: async () => ({ choices: [{ message: { content: '小鸡'.repeat(100) }, finish_reason: 'stop' }] }) }));
  await assert.rejects(test.request(), repetitionError);
  assert.deepEqual(test.output, []);
  assert.equal(test.requests[0].options.signal.aborted, true);
  assert.equal(test.timers.size, 0);
});

test('both sustained repetition and enough output are required before stopping', async () => {
  for (const text of ['小鸡'.repeat(31), 'abcdefghijklmnop'.repeat(7)]) {
    const stream = streaming([event(delta(text)), event(stop)]);
    const test = fixture(async () => stream.response);
    assert.equal((await test.request()).text, text, 'Short repetition and limited repeated passages remain intact');
  }
  for (const text of ['小鸡'.repeat(32), 'abcdefghijklmnop'.repeat(8)]) {
    const stream = streaming([event(delta(text)), event(stop)]);
    const test = fixture(async () => stream.response);
    await assert.rejects(test.request(), repetitionError);
  }
});

test('normal emphasis, formatting and separated repeated vocabulary preserve every character', async () => {
  const texts = [
    '不不不，这是一只小鸡。Ha ha ha! Go, go, go! 🙂🙂🙂',
    '---\n'.repeat(100) + '表格结束。' + ' \t\n'.repeat(100),
    '，。！？；：、—'.repeat(100),
    Array.from({ length: 160 }, (_, index) => `第${index}行：小鸡在第${index}号草地。`).join('\n'),
    Array.from({ length: 1200 }, (_, index) => `item-${index}: value ${index + 17}`).join('\n'),
  ];
  for (const text of texts) {
    const stream = streaming([event(delta(text)), event(stop)]);
    const test = fixture(async () => stream.response);
    assert.equal((await test.request()).text, text);
    assert.equal(test.output.join(''), text);
  }
});

test('source repetition can justify repeated translated wording but cannot allow unbounded output', async () => {
  const sourceText = 'chick '.repeat(50);
  const legitimate = '小鸡'.repeat(50);
  const stream = streaming([event(delta(legitimate)), event(stop)]);
  const test = fixture(async () => stream.response);
  assert.equal((await test.request({ sourceText })).text, legitimate,
    'The original repetition count applies even when the translated unit has a different length');
  const runawayStream = streaming([event(delta(legitimate)), event(delta('小鸡'.repeat(200))), event(stop)]);
  const runaway = fixture(async () => runawayStream.response);
  await assert.rejects(runaway.request({ sourceText }), repetitionError);
  assert.equal(runaway.output.join(''), legitimate, 'Only the justified prefix was allowed to reach the renderer');
  assert.equal(runawayStream.cancels, 1);
});

test('format-only source repetition does not disable meaningful output protection', async () => {
  const stream = streaming([event(delta('鸡'.repeat(200))), event(stop)]);
  const test = fixture(async () => stream.response);
  await assert.rejects(test.request({ sourceText: '---\n'.repeat(500) }), repetitionError);
});

test('source analysis is bounded and late repetition cannot disable output protection', async () => {
  const stream = streaming([event(delta('小鸡'.repeat(100))), event(stop)]);
  const test = fixture(async () => stream.response);
  const sourceText = ' '.repeat(16000) + 'chick '.repeat(20000);
  await assert.rejects(test.request({ sourceText }), repetitionError,
    'Repetition beyond the source analysis budget must not exempt runaway output');
  assert.deepEqual(test.output, []);
  assert.equal(stream.cancels, 1);
  assert.equal(test.timers.size, 0);
});

test('requests keep independent repetition state and can recover after a rejected translation', async () => {
  const streams = [
    streaming([event(delta('小鸡'.repeat(50))), event(stop)]),
    streaming([event(delta('小鸡'.repeat(100))), event(stop)]),
    streaming([event(delta('重新翻译成功。')), event(stop)]),
  ];
  let index = 0;
  const test = fixture(async () => streams[index++].response);
  assert.equal((await test.request({ sourceText: 'chick '.repeat(50) })).text, '小鸡'.repeat(50));
  await assert.rejects(test.request(), repetitionError, 'An earlier source allowance cannot leak into the next request');
  assert.equal((await test.request()).text, '重新翻译成功。');
  assert.equal(test.requests.length, 3);
  assert.equal(test.timers.size, 0);
});

test('missing or non-string source context is optional and never breaks normal translations', async () => {
  for (const sourceText of [undefined, null, 42, { text: 'synthetic' }]) {
    const stream = streaming([event(delta('正常译文。')), event(stop)]);
    const test = fixture(async () => stream.response);
    assert.equal((await test.request({ sourceText })).text, '正常译文。');
  }
});

const failures = [];
for (const entry of cases) {
  try { await entry.run(); console.log(`PASS ${entry.name}`); }
  catch (error) { failures.push(entry.name); console.error(`FAIL ${entry.name}: ${error.message}`); }
}
assert.deepEqual(failures, [], `Stream boundary failures: ${failures.join('; ')}`);
console.log(`Translation transport boundaries: ${cases.length}/${cases.length} passed.`);
