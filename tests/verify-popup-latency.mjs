/*
 * Shared desktop popup lifecycle checks with synthetic, deferred translation.
 *
 * The test creates its own Chromium context and evaluates project sources on
 * about:blank. It never reads a selection, clipboard, user settings or tabs.
 * A delayed fake fetch makes the waiting state and arrival animation observable.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEBUG = process.env.IT_CDP_ORIGIN || 'http://127.0.0.1:9240';
const REPORT = process.env.IT_POPUP_LATENCY_REPORT || '.build/popup-latency.json';
const SCREENSHOT = process.env.IT_POPUP_LATENCY_SCREENSHOT || '.build/popup-pending.png';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const [nativeSource, engineSource] = await Promise.all([
  readFile(path.join(ROOT, 'desktop/patch/setup.rs')).then((value) => utf8.decode(value)),
  readFile(path.join(ROOT, 'web/liquid-glass.js')).then((value) => utf8.decode(value)),
]);
const marker = 'const POPUP_BOOTSTRAP: &str = r#"';
const start = nativeSource.indexOf(marker);
const end = nativeSource.indexOf('"#;', start + marker.length);
if (start < 0 || end < 0) throw new Error('The shared popup bootstrap must be present');
const bootstrap = nativeSource.slice(start + marker.length, end);
const report = { checks: [], source: 'desktop/patch/setup.rs', synthetic: true };
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let socket;
let contextId;
let targetId;
let sessionId;
let sequence = 0;
const pending = new Map();
const runtimeErrors = [];
let blockedRequests = 0;

function send(method, params = {}, session = sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({
      id, method, params, ...(session ? { sessionId: session } : {}),
    }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function until(expression, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await pause(20);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

function check(name, passed, detail) {
  report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
}

const fixture = `
  window.__popupTest = { requests: [], writes: [], holdCopy: false, copyResolvers: [] };
  window.__JIAN_DESKTOP__ = {
    invoke(command, args) {
      if (command !== 'it_write_clipboard_text') throw new Error('Unexpected synthetic command');
      window.__popupTest.writes.push(String(args.text));
      if (!window.__popupTest.holdCopy) return Promise.resolve();
      return new Promise((resolve, reject) => window.__popupTest.copyResolvers.push({ resolve, reject }));
    }
  };
  window.fetch = (url, options) => {
    if (String(url) !== 'https://index-translate.bilibili.com/v1/chat/completions') {
      throw new Error('Unexpected external request in popup test');
    }
    const reads = [];
    const chunks = [];
    let ended = false;
    const entry = {
      body: JSON.parse(options.body),
      signal: options.signal,
      push(text) {
        const bytes = new TextEncoder().encode(
          'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\\n\\n');
        if (reads.length) reads.shift().resolve({ value: bytes, done: false });
        else chunks.push(bytes);
      },
      end() {
        ended = true;
        while (reads.length) reads.shift().resolve({ done: true });
      },
      failRead(message) {
        if (!reads.length) throw new Error('No pending synthetic stream read');
        reads.shift().reject(new Error(message));
      },
      reader: {
        read() {
          if (chunks.length) return Promise.resolve({ value: chunks.shift(), done: false });
          if (ended) return Promise.resolve({ done: true });
          return new Promise((resolve, reject) => reads.push({ resolve, reject }));
        },
        cancel() { return Promise.resolve(); },
        releaseLock() {}
      }
    };
    entry.response = new Promise((resolve, reject) => {
      entry.respond = () => resolve({ ok: true, status: 200, body: { getReader: () => entry.reader } });
      entry.reject = (message) => reject(new Error(message));
    });
    // Deliberately ignore AbortSignal: obsolete work is allowed to resolve so
    // production ownership guards, rather than the stub, must protect the UI.
    window.__popupTest.requests.push(entry);
    return entry.response;
  };
  window.__popupFrames = (count = 2) => new Promise((resolve) => {
    const next = () => --count <= 0 ? resolve() : requestAnimationFrame(next);
    requestAnimationFrame(next);
  });
`;

try {
  const version = await (await fetch(`${DEBUG}/json/version`)).json();
  report.browser = version.Browser;
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    } else if (message.sessionId === sessionId && message.method === 'Runtime.exceptionThrown') {
      runtimeErrors.push(message.params.exceptionDetails.exception?.description ||
        message.params.exceptionDetails.text);
    } else if (message.sessionId === sessionId && message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      const generated = /^(data|blob):/.test(request.url);
      if (!generated) blockedRequests++;
      send(generated ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        generated ? { requestId } : { requestId, errorReason: 'BlockedByClient' })
        .catch((error) => runtimeErrors.push(error.message));
    }
  });
  ({ browserContextId: contextId } = await send('Target.createBrowserContext', {}, ''));
  ({ targetId } = await send('Target.createTarget', {
    url: 'about:blank', browserContextId: contextId,
  }, ''));
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, ''));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 436, height: 282, deviceScaleFactor: 1, mobile: false,
  });
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await evaluate(fixture);
  await evaluate(engineSource);
  await evaluate(bootstrap);
  await until(`typeof window.__popupApply === 'function' &&
    typeof window.__popupPresent === 'function' && typeof window.__popupDismiss === 'function'`);
  check('Warming the popup does not consume its arrival animation or start translation',
    await evaluate(`document.getElementById('card-frame').getAnimations().length === 0 &&
      window.__popupTest.requests.length === 0`));
  await evaluate(`(() => {
    window.__popupApplyPreferences({ appearance: { motion: 'system', mode: 'light' } });
    window.__popupApply({ id: 1, phase: 'pending', text: '', notice: '', target: 'en' });
    window.__popupPresent();
  })()`);
  const arrival = await evaluate(`(async () => {
    await window.__popupFrames(2);
    const frame = document.getElementById('card-frame');
    const animation = frame.getAnimations().find((item) => item.animationName === 'popup-arrive');
    if (!animation) return { animation: false };
    window.__popupTest.arrival = animation;
    animation.pause();
    animation.currentTime = Number(animation.effect.getTiming().duration) * .35;
    await window.__popupFrames(2);
    return { animation: true, opacity: Number(getComputedStyle(frame).opacity),
      transform: getComputedStyle(frame).transform, time: animation.currentTime,
      waiting: document.querySelector('#out .ph')?.textContent,
      requests: window.__popupTest.requests.length, copyDisabled: document.getElementById('copy').disabled };
  })()`);
  check('The pending popup is painted with its original arrival animation before any translation',
    arrival.animation && arrival.opacity > 0 && arrival.opacity < 1 &&
    arrival.transform !== 'none' && arrival.requests === 0 && arrival.waiting, arrival);
  await evaluate(`document.getElementById('copy').click()`);
  check('A pending popup cannot copy its waiting status',
    await evaluate(`window.__popupTest.writes.length === 0 && document.getElementById('copy').disabled`));
  await mkdir(path.dirname(path.resolve(SCREENSHOT)), { recursive: true });
  const pendingShot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(SCREENSHOT, Buffer.from(pendingShot.data, 'base64'));
  report.pendingScreenshot = path.resolve(SCREENSHOT);

  await evaluate(`window.__popupApply({
    id: 1, phase: 'ready', text: 'Synthetic selection one', notice: '', target: 'en'
  })`);
  const ready = await evaluate(`(() => {
    const frame = document.getElementById('card-frame');
    return { requests: window.__popupTest.requests.length,
      sameAnimation: frame.getAnimations().includes(window.__popupTest.arrival),
      time: window.__popupTest.arrival.currentTime, output: document.getElementById('out').textContent,
      message: window.__popupTest.requests[0]?.body.messages[0].content };
  })()`);
  check('Selected text starts one asynchronous request in the same arriving popup',
    ready.requests === 1 && ready.sameAnimation && Math.abs(ready.time - arrival.time) < 1 &&
    ready.message?.endsWith('Synthetic selection one') && ready.output.includes('正在翻译'), ready);
  await evaluate(`(() => {
    window.__popupApply({ id: 1, phase: 'ready', text: 'Duplicate', target: 'en' });
    window.__popupApply({ id: 1, phase: 'pending', text: '', target: 'en' });
    window.__popupApply({ id: 1, phase: 'notice', notice: 'Duplicate final stage' });
    window.__popupApply({ id: 0, phase: 'notice', notice: 'Old notice' });
  })()`);
  check('Repeated and older payload stages cannot restart the request or replace its waiting state',
    await evaluate(`window.__popupTest.requests.length === 1 &&
      document.getElementById('meta').textContent === 'Synthetic selection one' &&
      document.getElementById('out').textContent.includes('正在翻译')`));

  await evaluate(`window.__popupTest.requests[0].respond()`);
  await evaluate(`window.__popupTest.requests[0].push('Synthetic translated ')`);
  await until(`!!document.querySelector('#out .stream-segment')`);
  const stream = await evaluate(`(async () => {
    const segment = document.querySelector('#out .stream-segment');
    const animation = segment.getAnimations().find((item) => item.animationName === 'stream-arrive');
    if (!animation) return { animation: false };
    animation.pause();
    animation.currentTime = Number(animation.effect.getTiming().duration) * .3;
    await window.__popupFrames(2);
    return { animation: true, opacity: Number(getComputedStyle(segment).opacity) };
  })()`);
  check('The first streamed text retains its own fade while the network is still open',
    stream.animation && stream.opacity > 0 && stream.opacity < 1, stream);
  await evaluate(`window.__popupTest.requests[0].push('result one.'); window.__popupTest.requests[0].end()`);
  await until(`document.getElementById('out').textContent === 'Synthetic translated result one.'`);
  await evaluate(`window.__popupTest.arrival.finish()`);
  check('A complete translation replaces waiting text without replaying the popup arrival',
    await evaluate(`document.getElementById('out').textContent === 'Synthetic translated result one.' &&
      document.getElementById('meta').textContent === 'Synthetic selection one' &&
      !document.getElementById('copy').disabled`));

  await evaluate(`(() => {
    window.__popupTest.holdCopy = true;
    document.getElementById('copy').click();
    window.__popupApply({ id: 2, phase: 'pending', text: '', target: 'zh' });
    window.__popupPresent();
  })()`);
  await evaluate(`window.__popupTest.copyResolvers[0].resolve()`);
  await evaluate('window.__popupFrames(2)');
  check('A late clipboard completion cannot relabel or enable a newer pending request',
    await evaluate(`window.__popupTest.writes.length === 1 &&
      window.__popupTest.writes[0] === 'Synthetic translated result one.' &&
      document.getElementById('copy').disabled && document.getElementById('copy').textContent === '复制'`));
  await evaluate(`window.__popupApply({ id: 1, phase: 'ready', text: 'Old retry after newer shortcut', target: 'en' })`);
  check('A delayed retry from a completed request cannot replace a newer pending shortcut',
    await evaluate(`window.__popupTest.requests.length === 1 &&
      document.getElementById('out').textContent.includes('正在翻译') &&
      document.getElementById('copy').disabled`));
  await evaluate(`window.__popupApply({ id: 2, phase: 'ready', text: 'Old active stream', target: 'zh' })`);
  await evaluate(`window.__popupTest.requests[1].respond()`);
  await evaluate(`window.__popupTest.requests[1].push('Obsolete stream prefix')`);
  await until(`document.getElementById('out').textContent.includes('Obsolete')`);
  await evaluate(`window.__popupApply({ id: 3, phase: 'pending', text: '', target: 'zh' }); window.__popupPresent()`);
  await evaluate(`window.__popupTest.requests[1].push(' STALE'); window.__popupTest.requests[1].end()`);
  await evaluate('window.__popupFrames(3)');
  check('A newer pending request rejects obsolete stream chunks and stream completion',
    await evaluate(`document.getElementById('out').textContent.includes('正在翻译') &&
      !document.getElementById('out').textContent.includes('STALE') &&
      window.__popupTest.requests[1].signal.aborted`));
  await evaluate(`window.__popupApply({ id: 3, phase: 'ready', text: 'Delayed old response', target: 'zh' })`);
  await evaluate(`window.__popupApply({ id: 4, phase: 'pending', text: '', target: 'en' }); window.__popupPresent()`);
  await evaluate(`window.__popupTest.requests[2].reject('Synthetic obsolete failure')`);
  await evaluate('window.__popupFrames(2)');
  check('An obsolete request failure cannot replace the latest waiting state',
    await evaluate(`!document.querySelector('#out .err') &&
      document.getElementById('out').textContent.includes('正在翻译')`));
  await evaluate(`window.__popupApply({ id: 4, phase: 'notice', notice: 'Synthetic empty selection', text: '' })`);
  check('The same pending request can finish with a notice without submitting empty text',
    await evaluate(`document.getElementById('out').textContent === 'Synthetic empty selection' &&
      window.__popupTest.requests.length === 3 && document.getElementById('copy').disabled`));

  await evaluate(`window.__popupApply({ id: 5, phase: 'pending', text: '', target: 'en' }); window.__popupPresent()`);
  await evaluate(`window.__popupDismiss()`);
  await evaluate(`(() => {
    window.__popupApply({ id: 5, phase: 'ready', text: 'Closed selection', target: 'en' });
    window.__popupApply({ id: 5, phase: 'notice', notice: 'Late closed notice' });
  })()`);
  check('Closing while selection is pending rejects late ready and notice stages',
    await evaluate(`window.__popupTest.requests.length === 3 &&
      !document.getElementById('out').textContent.includes('Late closed notice') &&
      document.getElementById('copy').disabled`));
  await evaluate(`window.__popupApply({ id: 6, phase: 'pending', text: '', target: 'en' }); window.__popupPresent()`);
  await evaluate(`window.__popupApply({ id: 6, phase: 'ready', text: 'New after close', target: 'en' })`);
  check('A later shortcut can reuse the popup after dismissal',
    await evaluate(`window.__popupTest.requests.length === 4 &&
      document.getElementById('meta').textContent === 'New after close'`));
  await evaluate(`window.__popupDismiss(); window.__popupTest.requests[3].respond()`);
  await evaluate(`window.__popupTest.requests[3].push('Late closed translation'); window.__popupTest.requests[3].end()`);
  await evaluate('window.__popupFrames(3)');
  check('Dismissal also rejects a late network response and its stream',
    await evaluate(`!document.getElementById('out').textContent.includes('Late closed translation') &&
      document.getElementById('copy').disabled`));

  await evaluate(`(() => {
    window.__popupApplyPreferences({ appearance: { motion: 'off', mode: 'light' } });
    window.__popupApply({ id: 7, phase: 'pending', text: '', target: 'en' });
    window.__popupPresent();
  })()`);
  check('Animations-off preserves a visible waiting popup without an arrival animation',
    await evaluate(`getComputedStyle(document.getElementById('card-frame')).opacity === '1' &&
      document.getElementById('card-frame').getAnimations().length === 0 &&
      document.getElementById('out').textContent.includes('正在翻译')`));
  await evaluate(`window.__popupApplyPreferences({ appearance: { motion: 'system', mode: 'light' } })`);
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await evaluate(`window.__popupApply({ id: 8, phase: 'pending', text: '', target: 'en' }); window.__popupPresent()`);
  check('System reduced motion preserves the waiting state and disables arrival',
    await evaluate(`getComputedStyle(document.getElementById('card-frame')).opacity === '1' &&
      document.getElementById('card-frame').getAnimations().length === 0 &&
      document.getElementById('out').textContent.includes('正在翻译')`));
  await evaluate(`window.__popupApply({ id: 8, phase: 'ready', text: 'Current error case', target: 'en' })`);
  await evaluate(`window.__popupTest.requests[4].reject('Synthetic current failure')`);
  await until(`document.getElementById('out').textContent.includes('Synthetic current failure')`);
  check('A current request failure still reports an error and cannot copy the error as a translation',
    await evaluate(`!!document.querySelector('#out .err') && document.getElementById('copy').disabled`));
  await evaluate(`window.__popupApply({ id: 9, text: 'Legacy ready payload', target: 'en' }); window.__popupPresent()`);
  await evaluate(`window.__popupTest.requests[5].respond()`);
  await evaluate(`window.__popupTest.requests[5].push('Synthetic reduced-motion result'); window.__popupTest.requests[5].end()`);
  await until(`document.getElementById('out').textContent === 'Synthetic reduced-motion result'`);
  check('Legacy payloads still translate, while reduced motion omits only the text animation',
    await evaluate(`document.getElementById('meta').textContent === 'Legacy ready payload' &&
      !document.querySelector('#out .stream-segment') && !document.getElementById('copy').disabled`));
  await evaluate(`window.__popupTest.holdCopy = false; document.getElementById('copy').click()`);
  await until(`document.getElementById('copy').textContent === '已复制'`);
  check('Completed translated text remains copyable after the lifecycle changes',
    await evaluate(`window.__popupTest.writes.at(-1) === 'Synthetic reduced-motion result'`));
  check('The popup scenarios report no uncaught JavaScript exceptions', runtimeErrors.length === 0, runtimeErrors);
  check('The popup scenarios perform no real external requests', blockedRequests === 0, blockedRequests);
} catch (error) {
  check('The popup lifecycle scenarios complete', false, error.stack || error.message);
} finally {
  if (socket?.readyState === WebSocket.OPEN && targetId) {
    await send('Target.closeTarget', { targetId }, '').catch(() => {});
  }
  if (socket?.readyState === WebSocket.OPEN && contextId) {
    await send('Target.disposeBrowserContext', { browserContextId: contextId }, '').catch(() => {});
  }
  socket?.close();
  await mkdir(path.dirname(path.resolve(REPORT)), { recursive: true });
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (report.checks.some(({ passed }) => !passed)) process.exitCode = 1;
  console.log(`Popup latency report: ${path.resolve(REPORT)}`);
}
