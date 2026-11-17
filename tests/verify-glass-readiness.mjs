/*
 * Offline checks for fully prepared optical controls before page transitions.
 *
 * Uses an isolated CDP browser context, synthetic Android/clipboard bridges,
 * real Worker jobs and real image decoding. No existing tabs or user data are
 * inspected, and all external requests are blocked.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = process.env.IT_PREVIEW_ORIGIN || 'http://127.0.0.1:8874';
const DEBUG = process.env.IT_CDP_ORIGIN || 'http://127.0.0.1:9238';
const REPORT = process.env.IT_GLASS_READINESS_REPORT || '.build/glass-readiness.json';
const report = { checks: [], measurements: {} };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(socket, sessionId = '', sequence = { value: 0 }) {
    this.socket = socket;
    this.sessionId = sessionId;
    this.sequence = sequence;
    this.pending = new Map();
    this.errors = [];
    this.blockedRequests = 0;
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if ((message.sessionId || '') !== this.sessionId) return;
      if (message.id) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params.exceptionDetails.exception?.description ||
          message.params.exceptionDetails.text);
      } else if (message.method === 'Fetch.requestPaused') {
        const { request, requestId } = message.params;
        const local = request.url.startsWith(`${ORIGIN}/`) || /^(data|blob):/.test(request.url);
        if (!local) this.blockedRequests++;
        this.send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          local ? { requestId } : { requestId, errorReason: 'BlockedByClient' })
          .catch((error) => this.errors.push(error.message));
      }
    });
    socket.addEventListener('close', () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP connection closed before its response'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence.value;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({
        id, method, params, ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  async until(expression, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await pause(25);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  }

  async tap(selector) {
    const point = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Missing tap target');
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!(hit === element || element.contains(hit))) throw new Error('Tap target is obscured');
      return { x, y };
    })()`);
    await this.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }],
    });
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

function check(name, passed, detail = undefined) {
  report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
}

const instrumentation = `
  window.__readinessProbe = {
    workers: [], workerHold: null, heldWorkerReplies: [], animations: [],
    holdDecodes: false, heldDecodes: [], completedDecodes: 0, copied: [],
    appearance: []
  };
  const probe = window.__readinessProbe;
  if (typeof Worker === 'function') {
    const OriginalWorker = Worker;
    window.Worker = function (...args) {
      const worker = new OriginalWorker(...args);
      probe.workers.push(worker);
      return worker;
    };
    window.Worker.prototype = OriginalWorker.prototype;
  }
  const decode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = function (...args) {
    return decode.apply(this, args).then(() => new Promise((resolve) => {
      const finish = () => { probe.completedDecodes++; resolve(); };
      if (probe.holdDecodes) probe.heldDecodes.push(finish);
      else finish();
    }));
  };
  probe.releaseDecodes = () => {
    probe.holdDecodes = false;
    for (const finish of probe.heldDecodes.splice(0)) finish();
  };
  probe.holdWorker = () => {
    if (probe.workerHold) throw new Error('A Worker result hold is already active');
    const worker = probe.workers[0];
    if (!worker || typeof worker.onmessage !== 'function') throw new Error('Optical Worker is unavailable');
    const receive = worker.onmessage;
    probe.workerHold = { worker, receive };
    worker.onmessage = (event) => {
      if (event.data && event.data.result) probe.heldWorkerReplies.push(event);
      else receive.call(worker, event);
    };
  };
  probe.releaseWorker = (resume = true) => {
    const hold = probe.workerHold;
    if (!hold) throw new Error('No Worker result hold is active');
    if (resume) {
      hold.worker.onmessage = hold.receive;
      probe.workerHold = null;
    }
    for (const event of probe.heldWorkerReplies.splice(0)) hold.receive.call(hold.worker, event);
  };
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const pane = this.matches('.pane') ? this : this.closest('.pane');
    const dialog = this.matches('.it-set') ? this : this.closest('.it-set');
    const scope = dialog || pane;
    if (scope && window.ItLiquidGlass) {
      const dock = pane && document.querySelector('.dock[data-pane="' +
        pane.id.replace('pane-', '') + '"]');
      const elements = [...scope.querySelectorAll('[data-it-liquid-preset]'),
        ...(dock ? dock.querySelectorAll('[data-it-liquid-preset]') : [])];
      const controls = elements
        .filter((element) => element.offsetWidth >= 4 && element.offsetHeight >= 4 &&
          !element.closest('[hidden]'))
        .map((element) => {
          const state = ItLiquidGlass.stateOf(element);
          return { element: element.id || element.className,
            preset: state?.presetName, decoded: state?.decoded === true,
            dimensions: { width: element.offsetWidth, height: element.offsetHeight,
              mapWidth: state?.maps?.width, mapHeight: state?.maps?.height },
            geometry: state?.geometry, readyGeometry: state?.readyGeometry,
            pendingGeometry: state?.pendingGeometry,
            current: !!state && state.readyGeometry === state.geometry &&
              state.geometry === state.pendingGeometry };
        });
      probe.animations.push({
        scope: dialog ? 'settings' : pane.id, element: this.id || this.className,
        ready: ItLiquidGlass.isReady(scope) && (!dock || ItLiquidGlass.isReady(dock)), controls
      });
    }
    return animate.apply(this, args);
  };
  window.NativeBridge = {
    platform: () => 'android', getSystemAppearance: () => 'light',
    applyAppearance: (json) => probe.appearance.push(JSON.parse(json)),
    commitAppearance: () => true, pickImage() {}, pickImageWithToken() {}, toast() {}
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    readText: () => Promise.resolve('Synthetic clipboard'),
    writeText: (text) => { probe.copied.push(String(text)); return Promise.resolve(); }
  } });
  const originalFetch = window.fetch.bind(window);
  window.fetch = (url, options) => {
    const target = new URL(String(url), location.href);
    if (target.origin === location.origin || /^(data|blob):$/.test(target.protocol)) {
      return originalFetch(url, options);
    }
    if (target.href === 'https://api.github.com/repos/jiuxina/jian-translator/releases/latest') {
      return Promise.resolve(new Response(JSON.stringify({
        tag_name: 'v2.3.0',
        html_url: 'https://github.com/jiuxina/jian-translator/releases/tag/v2.3.0'
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return Promise.reject(new Error('External requests are disabled by the readiness probe'));
  };
  window.__readinessFrames = (count = 3) => new Promise((resolve) => {
    const frame = () => --count <= 0 ? resolve() : requestAnimationFrame(frame);
    requestAnimationFrame(frame);
  });
`;

const onlyTab = (name) => `(() => {
  const visible = [...document.querySelectorAll('.pane.on')];
  return visible.length === 1 && visible[0].id === 'pane-${name}' &&
    window.__itDebug.state.tab === '${name}' &&
    document.querySelector('.pane-stack').getAnimations({ subtree: true })
      .every((animation) => animation.effect.getComputedTiming().iterations === Infinity);
})()`;
const firstFramesReady = (frames) => frames.length > 0 && frames.every((frame) =>
  frame.ready && frame.controls.length > 0 &&
  frame.controls.every((control) => control.decoded && control.current));
const frameSummary = (frames) => ({
  animations: frames.length,
  incompleteAnimations: frames.filter((frame) => !frame.ready ||
    frame.controls.some((control) => !control.decoded || !control.current)).length,
});

let browser;
let page;
let contextId;
let targetId;
try {
  const version = await (await fetch(`${DEBUG}/json/version`)).json();
  report.browser = version.Browser;
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  browser = new Cdp(socket);
  ({ browserContextId: contextId } = await browser.send('Target.createBrowserContext'));
  ({ targetId } = await browser.send('Target.createTarget', {
    url: 'about:blank', browserContextId: contextId,
  }));
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  page = new Cdp(socket, sessionId, browser.sequence);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });
  await page.send('Page.navigate', { url: `${ORIGIN}/?debug=1` });
  await page.send('Page.bringToFront');
  await page.until(`document.readyState === 'complete' && !!window.__itDebug &&
    typeof window.ItLiquidGlass?.prepare === 'function' &&
    typeof ItLiquidGlass.isReady === 'function' &&
    ItLiquidGlass.isReady(document.getElementById('pane-text')) &&
    ItLiquidGlass.diagnostics().queuedJobs === 0`, 45000);
  await page.evaluate('window.__readinessFrames(3)');
  check('The optical preparation API initializes with decoded maps',
    await page.evaluate(`ItLiquidGlass.diagnostics().workerActive &&
      window.__readinessProbe.completedDecodes > 0`));

  const selection = await page.evaluate(`(() => {
    document.getElementById('src').value = 'Synthetic source for selection';
    const placeholderSelection = ['out-text', 'out-syllable', 'out-doc'].map((id) =>
      getComputedStyle(document.getElementById(id)).userSelect);
    for (const id of ['out-text', 'out-syllable', 'out-doc']) {
      const output = document.getElementById(id);
      output.textContent = 'Synthetic translated content';
      output.classList.remove('empty');
    }
    const ids = ['src', 'syl-src', 'doc-src', 'out-text', 'out-syllable', 'out-doc'];
    const content = ids.map((id) => ({ id,
      select: getComputedStyle(document.getElementById(id)).userSelect }));
    const labels = [...document.querySelectorAll(
      '.card-head,.card-foot,.sel-value,.sel-item,.it-set-row > span,.it-set-range > span,.it-set-nav button')]
      .map((element) => getComputedStyle(element).userSelect);
    const search = document.querySelector('.sel-search');
    const source = document.getElementById('src');
    source.focus(); source.setSelectionRange(0, source.value.length);
    const sourceRange = source.selectionStart === 0 && source.selectionEnd === source.value.length;
    source.blur();
    return { content, labels, placeholderSelection,
      search: getComputedStyle(search).userSelect, sourceRange };
  })()`);
  report.measurements.selection = selection;
  check('UI labels are not selectable while original and translated contents remain selectable',
    selection.labels.length > 10 && selection.labels.every((value) => value === 'none') &&
    selection.content.every(({ select }) => select === 'text') &&
    selection.placeholderSelection.every((value) => value === 'none') &&
    selection.search === 'text' && selection.sourceRange, selection);
  const borderBefore = await page.evaluate(
    `getComputedStyle(document.querySelector('#langbar .sel-btn')).borderColor`);
  await page.tap('#langbar .sel-btn');
  await page.until(`document.querySelector('#langbar .sel-btn').getAttribute('aria-expanded') === 'true' &&
    document.querySelector('#langbar .sel-btn').getAnimations().length === 0`);
  const openedLanguage = await page.evaluate(`(() => {
    const button = document.querySelector('#langbar .sel-btn');
    const focused = document.activeElement;
    return { border: getComputedStyle(button).borderColor,
      editable: focused.matches('input,textarea,[contenteditable="true"]') || focused.isContentEditable };
  })()`);
  check('A touch-opened language selector keeps its ordinary border and avoids keyboard focus',
    openedLanguage.border === borderBefore && !openedLanguage.editable, openedLanguage);
  await page.evaluate('window.__itHandleBack()');
  await page.until(`!document.querySelector('.sel-pop[aria-hidden="false"]')`);
  await page.tap('#btn-copy');
  await page.until(`window.__readinessProbe.copied.includes('Synthetic translated content')`);
  check('The translated-content copy action still uses its complete text', true);

  // Force a cold, exact geometry key, then separately delay its Worker result
  // and its real image decode. Neither stage may leak a flat incoming frame.
  await page.evaluate(`(() => {
    const probe = window.__readinessProbe;
    probe.animations = [];
    probe.holdWorker();
    probe.holdDecodes = true;
    const panel = document.getElementById('pane-syllable');
    panel.querySelector('.models-thumb').style.borderRadius = '9.17px';
    ItLiquidGlass.refresh(panel);
    document.querySelector('[data-tab="syllable"]').click();
  })()`);
  await page.until('window.__readinessProbe.heldWorkerReplies.length > 0', 8000);
  const beforeWorker = await page.evaluate(`(() => ({
    intent: window.__itDebug.state.tab,
    visible: [...document.querySelectorAll('.pane.on')].map((pane) => pane.id),
    incomingAnimations: window.__readinessProbe.animations.filter((entry) =>
      entry.scope === 'pane-syllable').length
  }))()`);
  check('A cold Tab keeps the previous page visible until its optical result exists',
    beforeWorker.intent === 'syllable' && beforeWorker.visible.length === 1 &&
    beforeWorker.visible[0] === 'pane-text' && beforeWorker.incomingAnimations === 0, beforeWorker);
  await page.evaluate('window.__readinessProbe.releaseWorker()');
  await page.until('window.__readinessProbe.heldDecodes.length > 0', 8000);
  check('PNG decode completion is required before the incoming animation',
    await page.evaluate(`!ItLiquidGlass.isReady(document.getElementById('pane-syllable')) &&
      document.getElementById('pane-text').classList.contains('on') &&
      window.__readinessProbe.animations.every((entry) => entry.scope !== 'pane-syllable')`));
  await page.evaluate('window.__readinessProbe.releaseDecodes()');
  await page.until(onlyTab('syllable'));
  const coldFrames = await page.evaluate(`window.__readinessProbe.animations.filter(
    (entry) => entry.scope === 'pane-syllable')`);
  report.measurements.coldTab = coldFrames;
  check('The first incoming Tab animation starts with complete decoded glass',
    firstFramesReady(coldFrames), frameSummary(coldFrames));

  await page.evaluate(`document.querySelector('[data-tab="text"]').click()`);
  await page.until(onlyTab('text'));
  const warm = await page.evaluate(`(() => {
    const panel = document.getElementById('pane-syllable');
    const ready = ItLiquidGlass.isReady(panel);
    window.__readinessProbe.animations = [];
    document.querySelector('[data-tab="syllable"]').click();
    return { ready, immediate: panel.classList.contains('on'),
      frames: window.__readinessProbe.animations.filter((entry) => entry.scope === 'pane-syllable') };
  })()`);
  check('A warmed Tab starts its original transition in the click call without another frame',
    warm.ready && warm.immediate && firstFramesReady(warm.frames),
    { ready: warm.ready, immediate: warm.immediate, ...frameSummary(warm.frames) });
  await page.until(onlyTab('syllable'));
  await page.evaluate(`document.querySelector('[data-tab="text"]').click()`);
  await page.until(onlyTab('text'));

  await page.evaluate(`(() => {
    const probe = window.__readinessProbe;
    probe.animations = []; probe.holdWorker(); probe.holdDecodes = true;
    document.getElementById('btn-go-syllable').style.borderRadius = '12.83px';
    ItLiquidGlass.refresh(document.querySelector('.dock[data-pane="syllable"]'));
    document.querySelector('[data-tab="syllable"]').click();
    document.querySelector('[data-tab="syllable"]').click();
  })()`);
  await page.until('window.__readinessProbe.heldWorkerReplies.length > 0', 8000);
  await page.evaluate('window.__readinessFrames(2)');
  check('A cold target dock is prepared before its Tab or action buttons are revealed',
    await page.evaluate(`document.getElementById('pane-text').classList.contains('on') &&
      !document.querySelector('.dock[data-pane="syllable"]').classList.contains('on') &&
      window.__readinessProbe.animations.every((entry) => entry.scope !== 'pane-syllable')`));
  check('Repeated cold Tab clicks retain staging owned by the newest dock preparation',
    await page.evaluate(`(() => {
      const dock = document.querySelector('.dock[data-pane="syllable"]');
      return dock.classList.contains('it-glass-preparing') && dock.inert &&
        document.getElementById('btn-go-syllable').offsetWidth > 4;
    })()`));
  await page.evaluate('window.__readinessProbe.releaseWorker()');
  await page.until('window.__readinessProbe.heldDecodes.length > 0');
  check('Overlapping dock requests remain hidden until the shared PNG decode completes',
    await page.evaluate(`document.getElementById('pane-text').classList.contains('on') &&
      document.querySelector('.dock[data-pane="syllable"]').classList.contains('it-glass-preparing') &&
      !document.querySelector('.dock[data-pane="syllable"]').classList.contains('on')`));
  await page.evaluate('window.__readinessProbe.releaseDecodes()');
  await page.until(onlyTab('syllable'));
  const dockFrames = await page.evaluate(`window.__readinessProbe.animations.filter(
    (entry) => entry.scope === 'pane-syllable')`);
  check('The first Tab animation includes decoded glass for its external action dock',
    firstFramesReady(dockFrames), frameSummary(dockFrames));
  await page.evaluate(`document.querySelector('[data-tab="text"]').click()`);
  await page.until(onlyTab('text'));

  await page.evaluate(`(() => {
    const probe = window.__readinessProbe;
    probe.animations = []; probe.holdWorker();
    document.querySelector('#pane-syllable .models-thumb').style.borderRadius = '9.53px';
    document.querySelector('#pane-doc .models-thumb').style.borderRadius = '9.71px';
    ItLiquidGlass.refresh(document.getElementById('pane-syllable'));
    ItLiquidGlass.refresh(document.getElementById('pane-doc'));
    document.querySelector('[data-tab="syllable"]').click();
    document.querySelector('[data-tab="doc"]').click();
    document.querySelector('[data-tab="text"]').click();
  })()`);
  await page.until('window.__readinessProbe.heldWorkerReplies.length > 0', 8000);
  await page.evaluate('window.__readinessProbe.releaseWorker()');
  await page.until('ItLiquidGlass.diagnostics().queuedJobs === 0');
  await page.evaluate('window.__readinessFrames(3)');
  check('Rapid cold Tab reversals discard old requests instead of revealing a late target',
    await page.evaluate(`${onlyTab('text')} &&
      window.__readinessProbe.animations.every((entry) =>
        entry.scope !== 'pane-syllable' && entry.scope !== 'pane-doc') &&
      [...document.querySelectorAll('.pane')].every((pane) =>
        pane.id === 'pane-text' ? !pane.inert : pane.inert)`));

  await page.evaluate(`(() => {
    const probe = window.__readinessProbe;
    probe.holdWorker();
    const button = document.createElement('button');
    button.id = 'readiness-shared-button';
    button.style.cssText = 'position:fixed;left:-1200px;top:0;width:193px;height:47px;border-radius:11.19px';
    document.body.appendChild(button);
    ItLiquidGlass.attach(button, 'button');
    probe.abortController = new AbortController();
    probe.abortedPrepare = 'pending'; probe.sharedPrepare = 'pending';
    ItLiquidGlass.prepare(button, { signal: probe.abortController.signal })
      .then((value) => { probe.abortedPrepare = value; },
        (error) => { probe.abortedPrepare = error.name; });
    ItLiquidGlass.prepare(button).then((value) => { probe.sharedPrepare = value; });
  })()`);
  await page.until('window.__readinessProbe.heldWorkerReplies.length > 0', 8000);
  await page.evaluate('window.__readinessProbe.abortController.abort()');
  await page.until(`window.__readinessProbe.abortedPrepare === 'AbortError'`);
  check('An aborted prepare waiter does not complete the other shared waiter',
    await page.evaluate(`window.__readinessProbe.sharedPrepare === 'pending'`));
  await page.evaluate('window.__readinessProbe.releaseWorker()');
  await page.until(`window.__readinessProbe.sharedPrepare === true &&
    ItLiquidGlass.isReady(document.getElementById('readiness-shared-button'))`);
  check('Other callers still receive the decoded result of a shared optical task', true);
  await page.evaluate(`document.getElementById('readiness-shared-button').remove()`);

  await page.evaluate(`(() => {
    const probe = window.__readinessProbe;
    probe.holdWorker(); probe.resizedPrepare = 'pending';
    const button = document.createElement('button');
    button.id = 'readiness-resize-button';
    button.style.cssText = 'position:fixed;left:-1200px;top:0;width:257px;height:53px;border-radius:12.17px';
    document.body.appendChild(button);
    ItLiquidGlass.attach(button, 'button');
    ItLiquidGlass.prepare(button).then((value) => { probe.resizedPrepare = value; });
  })()`);
  await page.until('window.__readinessProbe.heldWorkerReplies.length > 0', 8000);
  await page.evaluate(`(async () => {
    const button = document.getElementById('readiness-resize-button');
    button.style.width = '319px'; button.style.height = '61px';
    ItLiquidGlass.refresh(button);
    await window.__readinessFrames(2);
    window.__readinessProbe.releaseWorker(false);
  })()`);
  await page.until('window.__readinessProbe.heldWorkerReplies.length > 0', 8000);
  check('An obsolete size cannot resolve preparation after its border box changes',
    await page.evaluate(`window.__readinessProbe.resizedPrepare === 'pending' &&
      !ItLiquidGlass.isReady(document.getElementById('readiness-resize-button'))`));
  await page.evaluate('window.__readinessProbe.releaseWorker()');
  await page.until(`window.__readinessProbe.resizedPrepare === true &&
    ItLiquidGlass.isReady(document.getElementById('readiness-resize-button'))`);
  check('Preparation resolves only for the final exact geometry',
    await page.evaluate(`(() => {
      const state = ItLiquidGlass.stateOf(document.getElementById('readiness-resize-button'));
      return state.maps.width === 319 && state.maps.height === 61 && state.decoded &&
        state.readyGeometry === state.geometry && state.geometry === state.pendingGeometry;
    })()`));
  await page.evaluate(`document.getElementById('readiness-resize-button').remove()`);

  // A map can be applied while its decode is still pending, then become stale.
  // Returning to that same map must rebind its already-completed decode rather
  // than waiting forever for a second Worker message with the same geometry.
  await page.evaluate(`(() => {
    const probe = window.__readinessProbe;
    probe.holdWorker(); probe.holdDecodes = true;
    const button = document.createElement('button');
    button.id = 'readiness-return-map-button';
    button.style.cssText = 'position:fixed;left:-1200px;top:0;width:181px;height:43px;border-radius:10.73px';
    document.body.appendChild(button);
    ItLiquidGlass.attach(button, 'button');
    probe.returnMapA = new AbortController();
    probe.returnMapFirst = 'pending';
    ItLiquidGlass.prepare(button, { signal: probe.returnMapA.signal }).then(
      (value) => { probe.returnMapFirst = value; },
      (error) => { probe.returnMapFirst = error.name; });
  })()`);
  await page.until('window.__readinessProbe.heldWorkerReplies.length > 0');
  await page.evaluate('window.__readinessProbe.releaseWorker()');
  await page.until('window.__readinessProbe.heldDecodes.length > 0');
  await page.evaluate(`(() => {
    const probe = window.__readinessProbe;
    const button = document.getElementById('readiness-return-map-button');
    probe.holdWorker();
    probe.returnMapA.abort();
    probe.returnMapB = new AbortController();
    probe.returnMapSecond = 'pending';
    button.style.width = '223px'; button.style.height = '59px';
    ItLiquidGlass.refresh(button);
    ItLiquidGlass.prepare(button, { signal: probe.returnMapB.signal }).then(
      (value) => { probe.returnMapSecond = value; },
      (error) => { probe.returnMapSecond = error.name; });
  })()`);
  await page.until('window.__readinessProbe.heldWorkerReplies.length > 0');
  await page.evaluate(`(async () => {
    window.__readinessProbe.releaseDecodes();
    await window.__readinessFrames(2);
  })()`);
  check('A completed stale decode cannot mark a newer pending geometry ready',
    await page.evaluate(`(() => {
      const state = ItLiquidGlass.stateOf(document.getElementById('readiness-return-map-button'));
      return state.maps.width === 181 && !state.decoded &&
        state.pendingGeometry !== state.geometry &&
        window.__readinessProbe.returnMapSecond === 'pending';
    })()`));
  await page.evaluate(`(() => {
    const probe = window.__readinessProbe;
    const button = document.getElementById('readiness-return-map-button');
    probe.returnMapB.abort(); probe.returnMapLatest = 'pending';
    button.style.width = '181px'; button.style.height = '43px';
    ItLiquidGlass.refresh(button);
    ItLiquidGlass.prepare(button).then((value) => { probe.returnMapLatest = value; });
  })()`);
  await page.until(`window.__readinessProbe.returnMapLatest === true &&
    ItLiquidGlass.isReady(document.getElementById('readiness-return-map-button'))`);
  check('Returning to an applied map reuses its completed decode while the other Worker reply is held',
    await page.evaluate(`(() => {
      const state = ItLiquidGlass.stateOf(document.getElementById('readiness-return-map-button'));
      return window.__readinessProbe.heldWorkerReplies.length > 0 &&
        state.maps.width === 181 && state.maps.height === 43 && state.decoded &&
        state.readyGeometry === state.geometry &&
        window.__readinessProbe.returnMapFirst === 'AbortError' &&
        window.__readinessProbe.returnMapSecond === 'AbortError';
    })()`));
  await page.evaluate(`(async () => {
    window.__readinessProbe.releaseWorker();
    await window.__readinessFrames(2);
  })()`);
  check('The delayed intermediate Worker reply cannot replace the restored exact map',
    await page.evaluate(`(() => {
      const state = ItLiquidGlass.stateOf(document.getElementById('readiness-return-map-button'));
      return state.maps.width === 181 && state.maps.height === 43 && state.decoded &&
        ItLiquidGlass.isReady(document.getElementById('readiness-return-map-button'));
    })()`));
  await page.evaluate(`document.getElementById('readiness-return-map-button').remove()`);

  await page.evaluate(`(() => {
    const probe = window.__readinessProbe;
    probe.animations = []; probe.holdWorker();
    document.getElementById('it-set-save').style.borderRadius = '11.63px';
    ItLiquidGlass.refresh(document.querySelector('.it-set-mask'));
    window.__itOpenSettings({ section: 'appearance', trigger: document.getElementById('mobile-settings') });
  })()`);
  await page.until('window.__readinessProbe.heldWorkerReplies.length > 0', 8000);
  check('Opening a cold settings dialog does not begin a flat-glass animation',
    await page.evaluate(`window.__readinessProbe.animations.every((entry) => entry.scope !== 'settings')`));
  const pendingSettingsBack = await page.evaluate('window.__itHandleBack()');
  check('System Back cancels a settings dialog while it is preparing', pendingSettingsBack);
  await page.evaluate('window.__readinessProbe.releaseWorker()');
  await page.until('ItLiquidGlass.diagnostics().queuedJobs === 0');
  await page.evaluate('window.__readinessFrames(3)');
  check('Late optical preparation cannot reopen a canceled settings dialog',
    await page.evaluate(`!document.querySelector('.it-set-mask').classList.contains('on') &&
      document.querySelector('.it-set-mask').getAttribute('aria-hidden') === 'true' &&
      document.querySelector('.it-set-mask').inert`));
  await page.evaluate(`(() => {
    window.__readinessProbe.animations = [];
    window.__itOpenSettings({ section: 'appearance', trigger: document.getElementById('mobile-settings') });
  })()`);
  await page.until(`document.querySelector('.it-set-mask').classList.contains('on') &&
    document.querySelector('.it-set').getAnimations().length === 0`);
  const settingsFrames = await page.evaluate(`window.__readinessProbe.animations.filter(
    (entry) => entry.scope === 'settings')`);
  report.measurements.settings = settingsFrames;
  check('Settings can reopen with decoded glass from the first animation frame',
    firstFramesReady(settingsFrames), frameSummary(settingsFrames));

  await page.evaluate(`(() => {
    const probe = window.__readinessProbe;
    probe.holdWorker();
    const target = document.querySelector('[data-pref-section="reading"]');
    const button = [...target.querySelectorAll('.sel-btn')].find((element) =>
      !element.closest('[data-desktop-only]') &&
      !element.closest('#it-pref-font-family-row'));
    button.style.borderRadius = '10.39px';
    document.querySelector('[data-pref-tab="reading"]').click();
  })()`);
  await page.until('window.__readinessProbe.heldWorkerReplies.length > 0', 8000);
  check('A settings category waits for its glass before the incoming fade becomes visible',
    await page.evaluate(`(() => {
      const target = document.querySelector('[data-pref-section="reading"]');
      return getComputedStyle(target).visibility === 'hidden' ||
        Number(getComputedStyle(target).opacity) === 0 || target.hidden;
    })()`));
  await page.evaluate('window.__readinessProbe.releaseWorker()');
  await page.until(`(() => {
    const target = document.querySelector('[data-pref-section="reading"]');
    return !target.hidden && !target.inert &&
      !target.classList.contains('is-entering') &&
      !target.classList.contains('is-leaving') &&
      ItLiquidGlass.isReady(target);
  })()`);
  check('The final settings category is interactive with complete optical maps', true);

  await page.evaluate(`(() => {
    const api = window.__itDebug.preferences;
    const preferences = api.normalize(JSON.parse(JSON.stringify(api.defaults)));
    preferences.appearance.motion = 'off';
    api.apply(preferences);
    window.__readinessProbe.holdWorker();
    const target = document.querySelector('[data-pref-section="motion"]');
    target.querySelector('.sel-btn').style.borderRadius = '11.91px';
    document.querySelector('[data-pref-tab="motion"]').click();
  })()`);
  await page.until('window.__readinessProbe.heldWorkerReplies.length > 0', 8000);
  check('Reduced-motion category changes keep the old section until target glass is ready',
    await page.evaluate(`document.querySelector('[data-pref-section="motion"]').hidden &&
      !document.querySelector('[data-pref-section="reading"]').hidden`));
  await page.evaluate(`(async () => {
    window.dispatchEvent(new Event('resize'));
    await window.__readinessFrames(2);
  })()`);
  check('A resize cannot bypass pending category preparation when animations are off',
    await page.evaluate(`document.querySelector('[data-pref-section="motion"]').hidden &&
      !document.querySelector('[data-pref-section="reading"]').hidden &&
      !ItLiquidGlass.isReady(document.querySelector('[data-pref-section="motion"]'))`));
  await page.evaluate('window.__readinessProbe.releaseWorker()');
  await page.until(`(() => {
    const target = document.querySelector('[data-pref-section="motion"]');
    return !target.hidden && !target.inert && ItLiquidGlass.isReady(target) &&
      !target.classList.contains('is-entering') && !target.classList.contains('is-leaving');
  })()`);
  check('An animations-off category becomes visible only with complete optical maps', true);

  await page.evaluate(`(() => {
    const probe = window.__readinessProbe;
    probe.holdWorker();
    document.querySelector('[data-pref-section="reading"] .sel-btn').style.borderRadius = '10.61px';
    document.querySelector('[data-pref-section="appearance"] .sel-btn').style.borderRadius = '9.89px';
    document.querySelector('[data-pref-tab="reading"]').click();
    document.querySelector('[data-pref-tab="appearance"]').click();
    document.querySelector('[data-pref-tab="reading"]').click();
  })()`);
  await page.until('window.__readinessProbe.heldWorkerReplies.length > 0');
  await page.evaluate('window.__readinessFrames(2)');
  check('Animations-off A-to-B-to-A requests keep the latest hidden section staging alive',
    await page.evaluate(`(() => {
      const target = document.querySelector('[data-pref-section="reading"]');
      return target.hidden && target.classList.contains('it-glass-section-preparing') &&
        target.querySelector('.sel-btn').offsetWidth > 4 &&
        !document.querySelector('[data-pref-section="motion"]').hidden &&
        document.querySelector('[data-pref-tab="reading"]').classList.contains('on');
    })()`));
  await page.evaluate('window.__readinessProbe.releaseWorker()');
  await page.until(`(() => {
    const target = document.querySelector('[data-pref-section="reading"]');
    return !target.hidden && !target.inert && ItLiquidGlass.isReady(target);
  })()`);
  check('Only the final animations-off category is revealed after overlapping preparations',
    await page.evaluate(`document.querySelector('[data-pref-section="appearance"]').hidden &&
      document.querySelector('[data-pref-section="motion"]').hidden &&
      !document.querySelector('[data-pref-section="reading"]').classList.contains('it-glass-section-preparing')`));

  await page.evaluate(`(() => {
    window.__itDebug.preferences.apply(window.__itDebug.preferences.defaults);
    window.__readinessProbe.holdWorker();
    document.querySelector('[data-pref-section="translation"] .sel-btn').style.borderRadius = '11.37px';
    document.querySelector('[data-pref-tab="translation"]').click();
    window.dispatchEvent(new Event('resize'));
  })()`);
  await page.until('window.__readinessProbe.heldWorkerReplies.length > 0');
  await page.evaluate('window.__readinessFrames(2)');
  check('A resize during normal category leave cannot reveal an unprepared display-none target',
    await page.evaluate(`(() => {
      const target = document.querySelector('[data-pref-section="translation"]');
      return target.hidden && target.classList.contains('it-glass-section-preparing') &&
        !document.querySelector('[data-pref-section="reading"]').hidden &&
        !ItLiquidGlass.isReady(target);
    })()`));
  await page.evaluate('window.__readinessProbe.releaseWorker()');
  await page.until(`(() => {
    const target = document.querySelector('[data-pref-section="translation"]');
    return !target.hidden && !target.inert && ItLiquidGlass.isReady(target) &&
      !target.classList.contains('is-entering') && !target.classList.contains('is-leaving');
  })()`);
  check('The resized normal transition finishes on the prepared final category', true);
  await page.evaluate('window.__itHandleBack()');
  await page.until(`!document.querySelector('.it-set-mask').classList.contains('on')`);
  await page.evaluate(`window.__itDebug.preferences.apply(window.__itDebug.preferences.defaults)`);

  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1180, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await page.evaluate('window.__readinessFrames(3)');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' });
  const keyboardOutline = await page.evaluate(`(() => {
    const button = document.querySelector('#langbar .sel-btn');
    button.focus({ preventScroll: true });
    const style = getComputedStyle(button);
    return { visible: button.matches(':focus-visible'), style: style.outlineStyle,
      width: parseFloat(style.outlineWidth) };
  })()`);
  check('Removing the mobile expanded border preserves desktop keyboard focus visibility',
    keyboardOutline.visible && keyboardOutline.style !== 'none' && keyboardOutline.width > 0,
    keyboardOutline);
  check('The readiness scenarios report no uncaught JavaScript exceptions',
    page.errors.length === 0, page.errors);
  report.blockedRequests = page.blockedRequests;
} catch (error) {
  report.diagnostic = page && await page.evaluate(`(() => ({
    intent: window.__itDebug?.state.tab,
    visible: [...document.querySelectorAll('.pane.on')].map((pane) => pane.id),
    settings: document.querySelector('.it-set-mask')?.className,
    worker: window.ItLiquidGlass?.diagnostics?.(),
    heldWorkerReplies: window.__readinessProbe?.heldWorkerReplies.length,
    heldDecodes: window.__readinessProbe?.heldDecodes.length,
    errors: window.__readinessProbe?.animations.filter((entry) => !entry.ready)
  }))()`).catch(() => null);
  report.runtimeErrors = page?.errors;
  check('Glass-readiness scenarios complete', false, error.stack || error.message);
} finally {
  if (browser && targetId) await browser.send('Target.closeTarget', { targetId }).catch(() => {});
  if (browser && contextId) await browser.send('Target.disposeBrowserContext', {
    browserContextId: contextId,
  }).catch(() => {});
  browser?.socket.close();
  await mkdir(path.dirname(REPORT), { recursive: true });
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Glass readiness report: ${path.resolve(REPORT)}`);
  if (report.checks.some(({ passed }) => !passed)) process.exitCode = 1;
}
