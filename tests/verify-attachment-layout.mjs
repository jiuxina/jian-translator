/*
 * Synthetic attachment layout checks. The CDP context and all image contents
 * belong to this test; no existing tabs, photographs or stored texts are read.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = process.env.IT_PREVIEW_ORIGIN || 'http://127.0.0.1:8875';
const DEBUG = process.env.IT_CDP_ORIGIN || 'http://127.0.0.1:9240';
const REPORT = process.env.IT_ATTACHMENT_REPORT || '.build/attachment-layout.json';
const report = { checks: [], layouts: [] };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let contextId;
let targetId;
let sessionId;
let sequence = 0;
const pending = new Map();
const runtimeErrors = [];

function send(method, params = {}, session = sessionId) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
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

async function until(expression, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(expression)) return;
    await pause(25);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

function check(name, passed, detail) {
  report.checks.push({ name, passed: !!passed, ...(detail ? { detail } : {}) });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
}

const settledImage = `(() => {
  const preview = document.getElementById('img-preview');
  return document.getElementById('img-thumb').complete &&
    preview.classList.contains('on') &&
    !preview.getAnimations().some((animation) => animation.playState === 'running');
})()`;
const fixtureScript = `
  window.NativeBridge = {
    platform: () => 'android', getSystemAppearance: () => 'light',
    applyAppearance() {}, commitAppearance: () => true,
    pickImage() {}, pickImageWithToken() {}, toast() {}
  };
  window.fetch = () => Promise.reject(new Error('External requests disabled by the attachment test'));
  window.__attachmentFixture = (width, height, color) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = color; context.fillRect(0, 0, width, height);
    context.fillStyle = '#ffffff'; context.fillRect(width * .15, height * .15, width * .7, height * .2);
    return canvas.toDataURL('image/png');
  };
`;

try {
  const version = await (await fetch(`${DEBUG}/json/version`)).json();
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
      const { request, requestId } = message.params;
      const local = request.url.startsWith(`${ORIGIN}/`) || /^(data|blob):/.test(request.url);
      send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        local ? { requestId } : { requestId, errorReason: 'BlockedByClient' })
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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: fixtureScript });
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
  });
  await send('Page.navigate', { url: `${ORIGIN}/?debug=1` });
  await send('Page.bringToFront');
  await until(`document.readyState === 'complete' && !!window.__itDebug`);

  for (const [width, height] of [[390, 844], [360, 640], [1180, 900]]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 760,
    });
    await evaluate(`(() => {
      document.getElementById('src').value = 'Synthetic original text remains editable.';
      window.__itDebug.setImage(window.__attachmentFixture(320, 1600, '#5372a2'));
    })()`);
    await until(settledImage);
    const layout = await evaluate(`(() => {
      const box = document.getElementById('img-preview');
      const image = document.getElementById('img-thumb');
      const source = document.getElementById('src');
      const body = source.closest('.composer-body');
      const scroller = source.closest('.composer-scroll');
      const foot = source.closest('.composer-source').querySelector('.card-foot');
      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height,
          top: box.top, bottom: box.bottom };
      };
      return { viewport: { width: innerWidth, height: innerHeight },
        image: rect(image), attachment: rect(box), source: rect(source),
        body: rect(body), foot: rect(foot), sourceValue: source.value,
        bodyOverflow: getComputedStyle(scroller).overflowY,
        canScroll: scroller.scrollHeight > scroller.clientHeight,
        deleteSize: rect(document.getElementById('img-del')),
        imageDataPreserved: window.__itDebug.state.image === image.src };
    })()`);
    report.layouts.push(layout);
    check(`${width}×${height} portrait images stay a compact attachment above readable source text`,
      layout.image.width === 80 && layout.image.height === 80 &&
      layout.attachment.height === 88 && layout.attachment.width <= 96 &&
      layout.source.height >= 108 && layout.source.top >= layout.image.bottom &&
      layout.attachment.bottom <= layout.foot.top && layout.imageDataPreserved &&
      layout.bodyOverflow === 'auto' && layout.deleteSize.width >= 32 &&
      layout.deleteSize.height >= 32, layout);
    if (width === 390 && process.env.IT_ATTACHMENT_SCREENSHOT) {
      const screenshotPath = path.resolve(process.env.IT_ATTACHMENT_SCREENSHOT);
      await mkdir(path.dirname(screenshotPath), { recursive: true });
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
      report.screenshot = screenshotPath;
    }
    await evaluate(`window.__itDebug.setImage(window.__attachmentFixture(1600, 240, '#8f5f97'))`);
    await until(settledImage);
    check(`${width}×${height} landscape images preserve the same attachment and input layout`,
      await evaluate(`document.getElementById('img-preview').getBoundingClientRect().height === 88 &&
        document.getElementById('src').getBoundingClientRect().height >= 108 &&
        document.getElementById('src').value === 'Synthetic original text remains editable.'`));
    await evaluate(`(() => {
      const source = document.getElementById('src');
      source.closest('.composer-scroll').scrollTop = 0;
      source.focus(); source.setSelectionRange(0, source.value.length);
    })()`);
    check(`${width}×${height} source text selection is preserved with an attachment`,
      await evaluate(`document.getElementById('src').selectionStart === 0 &&
        document.getElementById('src').selectionEnd === document.getElementById('src').value.length`));
    await evaluate(`document.getElementById('src').blur()`);
    await evaluate(`(() => {
      document.getElementById('instruct-box').querySelector('summary')
        .scrollIntoView({ block: 'nearest' });
    })()`);
    check(`${width}×${height} the translation instruction control remains reachable`,
      await evaluate(`(() => {
        const body = document.querySelector('.composer-body').getBoundingClientRect();
        const summary = document.querySelector('#instruct-box summary').getBoundingClientRect();
        return summary.top >= body.top - 1 && summary.bottom <= body.bottom + 1;
      })()`));
    await evaluate(`document.getElementById('img-del').click()`);
    await until(`document.getElementById('img-preview').getBoundingClientRect().height === 0`);
    check(`${width}×${height} removal keeps text and clears only the attachment`,
      await evaluate(`window.__itDebug.state.image === null &&
        document.getElementById('src').value === 'Synthetic original text remains editable.'`));
  }

  await evaluate(`(async () => {
    const first = window.__attachmentFixture(320, 1600, '#4c638b');
    const final = window.__attachmentFixture(240, 320, '#81976e');
    window.__itDebug.setImage(first);
    await new Promise(requestAnimationFrame);
    window.__itDebug.setImage(null);
    await new Promise(requestAnimationFrame);
    window.__itDebug.setImage(final);
    window.__finalAttachment = final;
  })()`);
  await until(settledImage);
  check('Adding, removing and replacing during an animation settles on the latest image',
    await evaluate(`window.__itDebug.state.image === window.__finalAttachment &&
      document.getElementById('img-thumb').src === window.__finalAttachment &&
      document.getElementById('img-preview').getBoundingClientRect().height === 88`));
  assert.equal(runtimeErrors.length, 0, runtimeErrors.join('\n'));
  check('The attachment scenarios report no uncaught JavaScript errors', true);
} catch (error) {
  check('Attachment layout scenarios complete', false, error.stack || error.message);
} finally {
  if (socket?.readyState === WebSocket.OPEN && targetId) {
    await send('Target.closeTarget', { targetId }, '').catch(() => {});
  }
  if (socket?.readyState === WebSocket.OPEN && contextId) {
    await send('Target.disposeBrowserContext', { browserContextId: contextId }, '').catch(() => {});
  }
  socket?.close();
  await mkdir(path.dirname(REPORT), { recursive: true });
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (report.checks.some(({ passed }) => !passed)) process.exitCode = 1;
  console.log(`Attachment report: ${path.resolve(REPORT)}`);
}
