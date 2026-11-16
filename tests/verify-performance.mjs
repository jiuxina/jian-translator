/*
 * Offline performance probes with a fresh CDP browser context.
 *
 * Start tests/serve-preview.mjs and an isolated Chromium debug profile first.
 * IT_PREVIEW_ORIGIN, IT_CDP_ORIGIN and IT_PERFORMANCE_REPORT select the local
 * preview, debugger and JSON report. IT_PERFORMANCE_SCREENSHOT optionally saves
 * the initial synthetic page. --baseline records the previous renderer without
 * requiring the new no-op and memory optimizations.
 *
 * All text, clipboard contents and preferences are synthetic. The page cannot
 * send external requests, and this script never inspects existing browser tabs.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = process.env.IT_PREVIEW_ORIGIN || 'http://127.0.0.1:8897';
const DEBUG_ORIGIN = process.env.IT_CDP_ORIGIN || 'http://127.0.0.1:9235';
const BASELINE = process.argv.includes('--baseline');
const REPORT = process.env.IT_PERFORMANCE_REPORT ||
  `.build/performance-${BASELINE ? 'baseline' : 'optimized'}.json`;
const SCREENSHOT = process.env.IT_PERFORMANCE_SCREENSHOT;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { baseline: BASELINE, previewOrigin: ORIGIN, checks: [], measurements: {} };
const sockets = [];

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
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params.exceptionDetails.exception?.description ||
          message.params.exceptionDetails.text);
      } else if (message.method === 'Fetch.requestPaused') {
        const { request, requestId } = message.params;
        const local = request.url.startsWith(`${ORIGIN}/`) ||
          request.url.startsWith('data:') || request.url.startsWith('blob:');
        if (!local) this.blockedRequests++;
        this.send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          local ? { requestId } : { requestId, errorReason: 'BlockedByClient' })
          .catch((error) => this.errors.push(error.message));
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP closed before the response'));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    sockets.push(socket);
    return new Cdp(socket);
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence.value;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({
        id, method, params, ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text);
    }
    return response.result?.value;
  }

  async until(expression, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await pause(25);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  }

  async metrics() {
    const { metrics } = await this.send('Performance.getMetrics');
    const values = Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
    return Object.fromEntries([
      'LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration',
      'ScriptDuration', 'TaskDuration', 'JSHeapUsedSize', 'Nodes',
    ].map((name) => [name, values[name]]));
  }
}

function check(name, passed, detail) {
  report.checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}

function delta(before, after) {
  return Object.fromEntries(Object.keys(after).map((name) => [name, after[name] - before[name]]));
}

const instrument = `
  window.__performanceProbe = { computedStyles: 0, boundingRects: 0 };
  const originalStyle = window.getComputedStyle;
  window.getComputedStyle = function (...args) {
    window.__performanceProbe.computedStyles++;
    return originalStyle.apply(this, args);
  };
  const originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (...args) {
    window.__performanceProbe.boundingRects++;
    return originalRect.apply(this, args);
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = (url, options) => {
    const target = new URL(String(url), location.href);
    if (target.origin === location.origin || /^(data|blob):$/.test(target.protocol)) {
      return originalFetch(url, options);
    }
    if (target.href === 'https://api.github.com/repos/jiuxina/jian-translator/releases/latest') {
      return Promise.resolve(new Response(JSON.stringify({
        tag_name: 'v2.2.0',
        html_url: 'https://github.com/jiuxina/jian-translator/releases/tag/v2.2.0'
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return Promise.reject(new Error('External requests are disabled by the performance probe'));
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    readText: () => Promise.resolve('synthetic clipboard'),
    writeText: () => Promise.resolve()
  } });
  window.__probeFrames = (count = 3) => new Promise((resolve) => {
    const frame = () => { if (--count <= 0) resolve(); else requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
`;

let browser;
let page;
let contextId;
let targetId;
try {
  const version = await (await fetch(`${DEBUG_ORIGIN}/json/version`)).json();
  report.browser = version.Browser;
  browser = await Cdp.connect(version.webSocketDebuggerUrl);
  ({ browserContextId: contextId } = await browser.send('Target.createBrowserContext'));
  ({ targetId } = await browser.send('Target.createTarget', {
    url: 'about:blank', browserContextId: contextId,
  }));
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  page = new Cdp(browser.socket, sessionId, browser.sequence);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Performance.enable');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1180, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: instrument });
  const startMetrics = await page.metrics();
  await page.send('Page.navigate', { url: `${ORIGIN}/?debug=1` });
  await page.send('Page.bringToFront');
  await page.until(`document.readyState === 'complete' && !!window.__itDebug &&
    document.documentElement.dataset.itLiquidGlass === 'ready'`);
  await page.evaluate('window.__probeFrames(5)');
  report.measurements.startup = delta(startMetrics, await page.metrics());
  report.measurements.startup.domReads = await page.evaluate('({...window.__performanceProbe})');
  check('Interactive controls initialize with the full optical renderer', await page.evaluate(`(() => {
    const control = document.querySelector('.tabs-thumb');
    const state = ItLiquidGlass.stateOf(control);
    return state && state.maps && state.maps.maxDisplacement > 0 &&
      state.presetName === 'pill' &&
      state.filter.querySelector('feDisplacementMap') &&
      state.filter.querySelector('feBlend') &&
      document.documentElement.dataset.itLiquidGlass === 'ready';
  })()`));
  if (!BASELINE) check('Content cards use static frost without optical layers', await page.evaluate(`(() => {
    const card = document.querySelector('#pane-text .card');
    const style = card && getComputedStyle(card);
    return card && ItLiquidGlass.stateOf(card) === null &&
      !card.querySelector(':scope > [data-it-liquid-background], :scope > [data-it-liquid-progressive]') &&
      style.backdropFilter === 'none' &&
      (style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.backgroundImage !== 'none');
  })()`));

  const maps = await page.evaluate(`(() => {
    const buffers = new Set();
    const surfaces = [];
    for (const element of document.querySelectorAll('[data-it-liquid-preset]')) {
      const state = ItLiquidGlass.stateOf(element);
      if (!state || !state.maps) continue;
      for (const value of Object.values(state.maps)) {
        if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
      }
      surfaces.push({
        name: element.id || element.className,
        preset: state.presetName,
        width: state.maps.width, height: state.maps.height,
        maxDisplacement: state.maps.maxDisplacement,
        displacement: state.displacementImage.getAttribute('href'),
        specular: state.specularImage.getAttribute('href')
      });
    }
    return { rawMapBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0), surfaces };
  })()`);
  report.measurements.maps = {
    rawMapBytes: maps.rawMapBytes,
    surfaces: maps.surfaces.map(({ displacement, specular, ...surface }) => ({
      ...surface,
      displacementSha256: createHash('sha256').update(displacement || '').digest('hex'),
      specularSha256: createHash('sha256').update(specular || '').digest('hex'),
    })),
  };
  if (!BASELINE) check('Encoded optical maps do not retain redundant RGBA buffers', maps.rawMapBytes === 0);
  if (SCREENSHOT) {
    const { data } = await page.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false,
    });
    await mkdir(path.dirname(SCREENSHOT), { recursive: true });
    await writeFile(SCREENSHOT, Buffer.from(data, 'base64'));
    report.screenshot = path.resolve(SCREENSHOT);
  }

  report.measurements.noop = await page.evaluate(`(async () => {
    const config = ItLiquidGlass.configure(ItLiquidGlass.defaults);
    await window.__probeFrames(5);
    const counters = { filterAttributes: 0, surfaceStyles: 0, rootStyles: 0 };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target;
        if (target.closest && target.closest('#it-liquid-glass-defs')) counters.filterAttributes++;
        else if (target === document.documentElement) counters.rootStyles++;
        else if (record.attributeName === 'style' && target.closest &&
            target.closest('[data-it-liquid-preset]')) counters.surfaceStyles++;
      }
    });
    observer.observe(document.documentElement, { subtree: true, attributes: true });
    const reads = { ...window.__performanceProbe };
    for (let index = 0; index < 12; index++) {
      ItLiquidGlass.configure(config);
      ItLiquidGlass.refresh(document);
      await window.__probeFrames(1);
    }
    await window.__probeFrames(3);
    observer.disconnect();
    return { ...counters,
      computedStyles: window.__performanceProbe.computedStyles - reads.computedStyles,
      boundingRects: window.__performanceProbe.boundingRects - reads.boundingRects };
  })()`);
  if (!BASELINE) {
    check('Unchanged glass configuration and refresh do not rewrite filters',
      report.measurements.noop.filterAttributes === 0,
      JSON.stringify(report.measurements.noop));
    check('Unchanged glass configuration and refresh do not rewrite surface styles',
      report.measurements.noop.surfaceStyles === 0);
    check('Unchanged glass configuration and refresh do not rewrite root styles',
      report.measurements.noop.rootStyles === 0);
  }

  report.measurements.parameterChanges = await page.evaluate(`(async () => {
    const surface = document.querySelector('.tabs-thumb');
    const state = ItLiquidGlass.stateOf(surface);
    function snapshot() {
      return {
        displacement: state.displacementImage.getAttribute('href'),
        specular: state.specularImage.getAttribute('href'),
        scale: state.refract.getAttribute('scale'),
        blur: state.baseBlur.getAttribute('stdDeviation'),
        saturation: state.specularColor.getAttribute('values'),
        alpha: state.alphaFunction.getAttribute('slope'),
        opacity: surface.style.getPropertyValue('--it-liquid-background-opacity')
      };
    }
    const before = snapshot();
    const changed = JSON.parse(JSON.stringify(ItLiquidGlass.defaults));
    Object.assign(changed.pill, {
      refractionLevel: 67, blurLevel: 2.3, specularSaturation: 4,
      specularOpacity: 73
    });
    ItLiquidGlass.configure(changed);
    await window.__probeFrames(3);
    const after = snapshot();
    const changedAll = after.blur === '2.3' && after.saturation === '4' &&
      after.alpha === '0.73' && after.opacity === '1' &&
      Math.abs(Number(after.scale) - state.maps.maxDisplacement * (.4 * .67)) < 1e-9;
    const nondefaultNoop = { filterAttributes: 0, surfaceStyles: 0, rootStyles: 0 };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target;
        if (target.closest && target.closest('#it-liquid-glass-defs')) nondefaultNoop.filterAttributes++;
        else if (target === document.documentElement) nondefaultNoop.rootStyles++;
        else if (record.attributeName === 'style' && target.closest &&
            target.closest('[data-it-liquid-preset]')) nondefaultNoop.surfaceStyles++;
      }
    });
    observer.observe(document.documentElement, { subtree: true, attributes: true });
    for (let index = 0; index < 3; index++) {
      ItLiquidGlass.configure(changed);
      ItLiquidGlass.refresh(document);
      await window.__probeFrames(1);
    }
    await window.__probeFrames(3);
    observer.disconnect();
    surface.style.setProperty('--it-liquid-background-opacity', '.7');
    const externalStyleApplied = surface.style.getPropertyValue('--it-liquid-background-opacity') === '.7';
    ItLiquidGlass.configure(changed);
    await window.__probeFrames(3);
    const repaired = snapshot();
    ItLiquidGlass.configure(ItLiquidGlass.defaults);
    await window.__probeFrames(3);
    const restored = snapshot();
    return {
      changedAll,
      nondefaultNoop,
      externalStyleApplied,
      externalStyleRepaired: JSON.stringify(repaired) === JSON.stringify(after),
      repairMapsUnchanged: repaired.displacement === after.displacement && repaired.specular === after.specular,
      filterChanged: before.scale !== after.scale && before.blur !== after.blur,
      mapsUnchanged: before.displacement === after.displacement && before.specular === after.specular,
      restored: JSON.stringify(before) === JSON.stringify(restored)
    };
  })()`);
  check('Changing slider glass controls updates refraction, blur and highlights',
    report.measurements.parameterChanges.changedAll &&
    report.measurements.parameterChanges.filterChanged);
  check('Filter-only controls reuse identical optical PNGs and restore their previous values',
    report.measurements.parameterChanges.mapsUnchanged && report.measurements.parameterChanges.restored);
  if (!BASELINE) {
    check('Nondefault interactive glass refreshes without repeated SVG or CSS writes',
      Object.values(report.measurements.parameterChanges.nondefaultNoop).every((value) => value === 0),
      JSON.stringify(report.measurements.parameterChanges.nondefaultNoop));
  }
  check('Configuring the same preset repairs external layer edits without regenerating optical PNGs',
    report.measurements.parameterChanges.externalStyleApplied &&
    report.measurements.parameterChanges.externalStyleRepaired &&
    report.measurements.parameterChanges.repairMapsUnchanged);

  const interaction = await page.evaluate(`(() => {
    const pill = document.querySelector('.tabs-thumb');
    const state = ItLiquidGlass.stateOf(pill);
    const before = Number(state.refract.getAttribute('scale'));
    const beforeOpacity = pill.style.getPropertyValue('--it-liquid-background-opacity');
    ItLiquidGlass.setInteraction(pill, true);
    const active = Number(state.refract.getAttribute('scale'));
    const activeOpacity = pill.style.getPropertyValue('--it-liquid-background-opacity');
    ItLiquidGlass.setInteraction(pill, false);
    return { before, active, restored: Number(state.refract.getAttribute('scale')),
      beforeOpacity, activeOpacity,
      restoredOpacity: pill.style.getPropertyValue('--it-liquid-background-opacity') };
  })()`);
  check('Pressed pills preserve their stronger refraction and restore on release',
    interaction.before > 0 && Math.abs(interaction.active / interaction.before - .9 / .4) < 1e-9 &&
    interaction.restored === interaction.before && interaction.activeOpacity === '0.1' &&
    interaction.restoredOpacity === interaction.beforeOpacity);
  report.measurements.interaction = interaction;

  const wheelStart = await page.metrics();
  const wheelReads = await page.evaluate('({...window.__performanceProbe})');
  await page.evaluate(`(() => {
    const select = document.getElementById('src-lang');
    select.selectedIndex = select.options.length - 1;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.until(`!document.querySelector('#src-lang').parentElement.querySelector('.rolling')`);
  report.measurements.languageWheel = delta(wheelStart, await page.metrics());
  const wheelAfter = await page.evaluate('({...window.__performanceProbe})');
  report.measurements.languageWheel.domReads = delta(wheelReads, wheelAfter);

  const streamStart = await page.metrics();
  const streamReads = await page.evaluate('({...window.__performanceProbe})');
  await page.evaluate(`(() => {
    window.__probeText = 'Synthetic text 0123456789. '.repeat(400).slice(0, 10000);
    window.__probeWriter = window.__itDebug.startWriter(document.getElementById('out-text'));
    window.__probeWriter.push(window.__probeText);
  })()`);
  try {
    await page.until(`(() => {
      const output = document.getElementById('out-text');
      return output.textContent === window.__probeText && !output.querySelector('.st-seg');
    })()`, 45000);
  } catch (error) {
    report.measurements.streamingTimeout = await page.evaluate(`(() => {
      const output = document.getElementById('out-text');
      return { length: output.textContent.length, expectedLength: window.__probeText.length,
        animatedSpans: output.querySelectorAll('.st-seg').length,
        textNodes: [...output.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).length };
    })()`);
    check('Streaming drains within the 45-second probe timeout', false,
      JSON.stringify({ ...report.measurements.streamingTimeout, error: error.message }));
  }
  report.measurements.streaming = delta(streamStart, await page.metrics());
  report.measurements.streaming.domReads = delta(streamReads,
    await page.evaluate('({...window.__performanceProbe})'));
  const streamState = await page.evaluate(`(() => {
    const output = document.getElementById('out-text');
    const textNodes = [...output.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).length;
    const exact = output.textContent === window.__probeText;
    window.__probeWriter.stop();
    return { textNodes, exact, length: output.textContent.length };
  })()`);
  report.measurements.streaming.output = streamState;
  check('Streaming preserves all 10000 synthetic characters', streamState.exact && streamState.length === 10000);
  if (!BASELINE) check('Settled stream text is coalesced without changing animation', streamState.textNodes <= 2);

  await page.evaluate(`(() => {
    // Exercise the engine's retained legacy preset in isolation. Product cards
    // above are deliberately never attached to this optical pipeline.
    const wrapper = document.createElement('div');
    wrapper.id = 'performance-surface-wrapper';
    const surface = document.createElement('div');
    surface.id = 'performance-surface';
    surface.style.cssText = 'position:fixed;left:5px;top:5px;width:200px;height:120px;border-radius:28px';
    wrapper.appendChild(surface);
    document.body.appendChild(wrapper);
    ItLiquidGlass.attach(surface, 'card');
  })()`);
  await page.until(`ItLiquidGlass.stateOf(document.getElementById('performance-surface'))?.maps?.width === 200`);
  report.measurements.legacyPreset = await page.evaluate(`(async () => {
    const surface = document.getElementById('performance-surface');
    const state = ItLiquidGlass.stateOf(surface);
    const config = JSON.parse(JSON.stringify(ItLiquidGlass.defaults));
    config.card.progressiveBlurStrength = 4;
    ItLiquidGlass.configure(config);
    await window.__probeFrames(3);
    const expected = state.progressiveLayers.map((layer) => layer.style.backdropFilter);
    const levels = ItLiquidGlass.progressiveLevels(4);
    const exactLevels = expected.every((value, index) =>
      value.startsWith('blur(') && Math.abs(parseFloat(value.slice(5)) - levels[index]) < .00001);
    let repeatedWrites = 0;
    const observer = new MutationObserver((records) => { repeatedWrites += records.length; });
    observer.observe(surface, { attributes: true, subtree: true });
    observer.observe(state.filter, { attributes: true, subtree: true });
    for (let index = 0; index < 3; index++) {
      ItLiquidGlass.configure(config);
      ItLiquidGlass.refresh(surface);
      await window.__probeFrames(1);
    }
    await window.__probeFrames(3);
    observer.disconnect();
    state.progressiveLayers[0].style.backdropFilter = 'blur(7px)';
    const externalStyleApplied = state.progressiveLayers[0].style.backdropFilter === 'blur(7px)';
    ItLiquidGlass.configure(config);
    const externalStyleRepaired = state.progressiveLayers.every((layer, index) =>
      layer.style.backdropFilter === expected[index]);
    ItLiquidGlass.configure(ItLiquidGlass.defaults);
    return { exactLevels, repeatedWrites, externalStyleApplied, externalStyleRepaired };
  })()`);
  check('Standalone legacy progressive layers preserve precision and repair external edits',
    report.measurements.legacyPreset.exactLevels &&
    report.measurements.legacyPreset.externalStyleApplied &&
    report.measurements.legacyPreset.externalStyleRepaired);
  if (!BASELINE) check('Standalone legacy progressive layers avoid repeated rounded CSS writes',
    report.measurements.legacyPreset.repeatedWrites === 0,
    JSON.stringify(report.measurements.legacyPreset));
  await page.evaluate(`(() => {
    const surface = document.getElementById('performance-surface');
    window.__probeOldMap = ItLiquidGlass.stateOf(surface).displacementImage.getAttribute('href');
    surface.style.width = '240px';
  })()`);
  await page.until(`ItLiquidGlass.stateOf(document.getElementById('performance-surface'))?.maps?.width === 240`);
  check('Standalone legacy geometry still regenerates its complete optical map', await page.evaluate(`(() => {
    const state = ItLiquidGlass.stateOf(document.getElementById('performance-surface'));
    return state.maps.height === 120 && state.maps.maxDisplacement > 0 &&
      state.displacementImage.getAttribute('href') !== window.__probeOldMap;
  })()`));
  await page.evaluate(`document.getElementById('performance-surface').replaceChildren(
    document.createTextNode('synthetic replacement'))`);
  await page.until(`(() => {
    const surface = document.getElementById('performance-surface');
    const state = ItLiquidGlass.stateOf(surface);
    return state.background.parentNode === surface && state.progressive.parentNode === surface;
  })()`);
  check('Replacing surface contents repairs both glass layers', true);
  await page.evaluate(`(() => {
    window.__probeRemovedSurface = document.getElementById('performance-surface');
    document.getElementById('performance-surface-wrapper').remove();
  })()`);
  await page.until(`ItLiquidGlass.stateOf(window.__probeRemovedSurface) === null`);
  check('Removing an ancestor releases the attached surface', true);
  check('The browser reports no uncaught runtime errors', page.errors.length === 0,
    page.errors.join('\n'));
  report.blockedRequests = page.blockedRequests;
} catch (error) {
  check('Performance probe completes', false, error.stack || error.message);
} finally {
  if (browser && targetId) {
    await browser.send('Target.closeTarget', { targetId }).catch(() => {});
  }
  if (browser && contextId) {
    await browser.send('Target.disposeBrowserContext', { browserContextId: contextId }).catch(() => {});
  }
  for (const socket of sockets) socket.close();
  await mkdir(path.dirname(REPORT), { recursive: true });
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Performance report: ${path.resolve(REPORT)}`);
  if (report.checks.some(({ passed }) => !passed)) process.exitCode = 1;
}
