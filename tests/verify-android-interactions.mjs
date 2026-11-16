/*
 * Offline Android interaction probes using synthetic preferences and images.
 * Requires a local preview and an isolated Chromium debug process. The probe
 * creates its own browser context and never enumerates other browser tabs.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = process.env.IT_PREVIEW_ORIGIN || 'http://127.0.0.1:8871';
const DEBUG = process.env.IT_CDP_ORIGIN || 'http://127.0.0.1:9236';
const BASELINE = process.argv.includes('--baseline');
const FILE_ROOT = new URL('../web/', import.meta.url).href;
const FILE_PAGE = new URL('../web/index.html?debug=1', import.meta.url).href;
const REPORT = process.env.IT_ANDROID_INTERACTION_REPORT ||
  `.build/android-interactions-${BASELINE ? 'before' : 'after'}.json`;
const report = { baseline: BASELINE, previewOrigin: ORIGIN, checks: [], measurements: {} };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(socket, sessionId = '', sequence = { value: 0 }) {
    this.socket = socket;
    this.sessionId = sessionId;
    this.sequence = sequence;
    this.pending = new Map();
    this.errors = [];
    this.warnings = [];
    this.blocked = 0;
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
      } else if (message.method === 'Runtime.consoleAPICalled' &&
          ['warning', 'error'].includes(message.params.type)) {
        this.warnings.push(message.params.args.map((argument) =>
          argument.value || argument.description || '').join(' '));
      } else if (message.method === 'Fetch.requestPaused') {
        const { requestId, request } = message.params;
        const allowed = request.url.startsWith(`${ORIGIN}/`) ||
          request.url.startsWith(FILE_ROOT) || /^(data|blob):/.test(request.url);
        if (!allowed) this.blocked++;
        this.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' })
          .catch((error) => this.errors.push(error.message));
      }
    });
    socket.addEventListener('close', () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP connection closed'));
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
    const response = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text);
    }
    return response.result?.value;
  }

  async until(expression, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.evaluate(expression)) return;
      await pause(35);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  }

  async metrics() {
    const { metrics } = await this.send('Performance.getMetrics');
    const values = Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
    return Object.fromEntries(['LayoutCount', 'RecalcStyleCount', 'ScriptDuration',
      'LayoutDuration', 'TaskDuration'].map((name) => [name, values[name]]));
  }
}

function check(name, passed, detail) {
  report.checks.push({ name, passed: !!passed, ...(detail ? { detail } : {}) });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}

function delta(before, after) {
  return Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - before[key]]));
}

const instrumentation = `
  window.__androidProbe = {
    reads: { offsetReads: 0, boundingRects: 0, computedStyles: 0 },
    native: [], commits: [], configureCalls: 0, longTasks: [], writes: null, workers: []
  };
  const probe = window.__androidProbe;
  if (typeof Worker === 'function') {
    const OriginalWorker = Worker;
    window.Worker = function (...args) {
      const worker = new OriginalWorker(...args);
      probe.workers.push(worker);
      return worker;
    };
    window.Worker.prototype = OriginalWorker.prototype;
  }
  for (const property of ['offsetLeft', 'offsetTop', 'offsetWidth', 'offsetHeight']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property);
    if (descriptor && descriptor.get) Object.defineProperty(HTMLElement.prototype, property, {
      ...descriptor, get() { probe.reads.offsetReads++; return descriptor.get.call(this); }
    });
  }
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (...args) {
    probe.reads.boundingRects++; return rect.apply(this, args);
  };
  const style = window.getComputedStyle;
  window.getComputedStyle = function (...args) {
    probe.reads.computedStyles++; return style.apply(this, args);
  };
  window.NativeBridge = {
    platform: () => 'android',
    getSystemAppearance: () => 'light',
    applyAppearance: (json) => probe.native.push(JSON.parse(json)),
    commitAppearance: (json) => { probe.commits.push(JSON.parse(json)); return true; },
    pickImage() {}, pickImageWithToken() {}, toast() {}
  };
  const fetchReal = window.fetch.bind(window);
  window.fetch = (url, options) => {
    const value = new URL(String(url), location.href);
    if (value.origin === location.origin || /^(data|blob):$/.test(value.protocol)) {
      return fetchReal(url, options);
    }
    if (value.href === 'https://api.github.com/repos/jiuxina/jian-translator/releases/latest') {
      return Promise.resolve(new Response(JSON.stringify({
        tag_name: 'v2.3.0',
        html_url: 'https://github.com/jiuxina/jian-translator/releases/tag/v2.3.0'
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return Promise.reject(new Error('External request disabled by the Android interaction probe'));
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    readText: () => Promise.resolve('synthetic clipboard'), writeText: () => Promise.resolve()
  } });
  if (typeof PerformanceObserver === 'function') {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push({
        startTime: entry.startTime, duration: entry.duration
      });
    });
    observer.observe({ type: 'longtask', buffered: true });
  }
  window.__probeFrames = (count = 3) => new Promise((resolve) => {
    const frame = () => --count <= 0 ? resolve() : requestAnimationFrame(frame);
    requestAnimationFrame(frame);
  });
  window.__probeReset = () => {
    probe.reads = { offsetReads: 0, boundingRects: 0, computedStyles: 0 };
    probe.native = []; probe.configureCalls = 0;
  };
`;

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
  await page.send('Performance.enable');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  });
  await page.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });
  await page.send('Page.navigate', { url: `${ORIGIN}/?debug=1` });
  await page.send('Page.bringToFront');
  await page.until(`document.readyState === 'complete' && !!window.__itDebug &&
    ItLiquidGlass.stateOf(document.querySelector('.tabs-thumb'))?.maps &&
    document.documentElement.dataset.itLiquidGlass === 'ready' &&
    (!ItLiquidGlass.diagnostics || ItLiquidGlass.diagnostics().queuedJobs === 0)`, 45000);
  await page.evaluate(`(() => {
    const configure = ItLiquidGlass.configure;
    ItLiquidGlass.configure = function (...args) {
      window.__androidProbe.configureCalls++;
      return configure.apply(this, args);
    };
  })()`);
  await page.evaluate('window.__probeFrames(5)');
  check('The synthetic Android bridge and interactive optical renderer initialize', await page.evaluate(`(() => {
    const state = ItLiquidGlass.stateOf(document.querySelector('.tabs-thumb'));
    return document.documentElement.classList.contains('it-android') &&
      state.presetName === 'pill' && state.maps.maxDisplacement > 0 &&
      state.filter.querySelector('feDisplacementMap') && state.filter.querySelector('feBlend');
  })()`));
  report.measurements.surfaceScope = await page.evaluate(`(() => {
    const containers = [...document.querySelectorAll(
      '.card,.it-set,.sel-pop,.menu,.it-about,.instruct,.toast,.it-pref-preview-card,.it-popup-preview-card')];
    const optical = [...document.querySelectorAll('[data-it-liquid-preset]')].map((element) =>
      ItLiquidGlass.stateOf(element)).filter((state) => state && state.maps);
    return {
      containerOpticalStates: containers.filter((element) => ItLiquidGlass.stateOf(element)).length,
      containerDirectLayers: containers.filter((element) => element.querySelector(
        ':scope > [data-it-liquid-background],:scope > [data-it-liquid-progressive]')).length,
      containerBackdropFilters: containers.filter((element) =>
        getComputedStyle(element).backdropFilter !== 'none').length,
      opticalSurfaces: optical.length,
      opticalMapPixels: optical.reduce((sum, state) =>
        sum + state.maps.mapWidth * state.maps.mapHeight, 0)
    };
  })()`);
  if (!BASELINE) {
    check('Content panels use static frost without optical states or backdrop layers',
      report.measurements.surfaceScope.containerOpticalStates === 0 &&
      report.measurements.surfaceScope.containerDirectLayers === 0 &&
      report.measurements.surfaceScope.containerBackdropFilters === 0,
      JSON.stringify(report.measurements.surfaceScope));
    report.measurements.navigation = await page.evaluate(`(() => {
        const track = document.querySelector('.tabs');
        const settings = document.getElementById('mobile-settings');
        const trackState = ItLiquidGlass.stateOf(track);
        const settingsState = ItLiquidGlass.stateOf(settings);
        const thumbState = ItLiquidGlass.stateOf(track.querySelector('.tabs-thumb'));
        return {
          trackPreset: trackState?.presetName, settingsPreset: settingsState?.presetName,
          trackFill: getComputedStyle(trackState.background).backgroundColor,
          settingsFill: getComputedStyle(settingsState.background).backgroundColor,
          thumbFill: getComputedStyle(thumbState.background).backgroundColor,
          text: settings.textContent.trim(), name: settings.getAttribute('aria-label'),
          width: settings.getBoundingClientRect().width, height: settings.getBoundingClientRect().height
        };
      })()`);
    const transparent = (color) => color?.startsWith('rgba(') &&
      Number(color.split(',').at(-1).replace(')', '').trim()) === 0;
    const navigation = report.measurements.navigation;
    check('The mobile tab track and icon-only settings button use matching transparent glass',
      navigation.trackPreset === 'button' && navigation.settingsPreset === 'button' &&
      transparent(navigation.trackFill) && transparent(navigation.settingsFill) &&
      transparent(navigation.thumbFill) && navigation.text === '' && !!navigation.name &&
      navigation.width >= 48 && navigation.height >= 48, JSON.stringify(navigation));
    check('Opening a language selector does not focus an editable field',
      await page.evaluate(`(() => {
        const button = document.getElementById('src-lang').parentElement.querySelector('.sel-btn');
        button.click();
        const popup = document.querySelector('.sel-pop[aria-hidden="false"]');
        const focused = document.activeElement;
        const noKeyboardFocus = popup && popup.contains(focused) &&
          !focused.matches('input,textarea,[contenteditable="true"]') &&
          !focused.isContentEditable;
        document.getElementById('src-lang').__itRefreshDropdown();
        const refreshed = document.activeElement;
        const noRefreshKeyboard = popup.contains(refreshed) &&
          !refreshed.matches('input,textarea,[contenteditable="true"]') && !refreshed.isContentEditable;
        const search = popup.querySelector('.sel-search');
        search.focus();
        search.value = '英';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('src-lang').__itRefreshDropdown();
        const manualSearchWorks = document.activeElement === search &&
          popup.querySelectorAll('.sel-item').length > 0;
        window.__itHandleBack();
        const closedFocus = document.activeElement === button;
        button.click();
        const reopened = document.querySelector('.sel-pop[aria-hidden="false"]');
        reopened.querySelector('.sel-item[data-value="en"]').click();
        const choiceWorks = document.getElementById('src-lang').value === 'en' &&
          document.activeElement === button && !document.querySelector('.sel-pop[aria-hidden="false"]');
        document.getElementById('src-lang').value = 'auto';
        document.getElementById('src-lang').dispatchEvent(new Event('change', { bubbles: true }));
        return noKeyboardFocus && noRefreshKeyboard && manualSearchWorks && closedFocus && choiceWorks;
      })()`));
    check('Static-frost notifications retain readable text in both themes',
      await page.evaluate(`(() => {
        const toast = document.getElementById('toast');
        const matches = [];
        for (const mode of ['light', 'dark']) {
          window.__itDebug.preferences.apply(window.__itDebug.preferences.normalize({ appearance: { mode } }));
          toast.classList.remove('error');
          const ordinary = getComputedStyle(toast).color;
          toast.classList.add('error');
          const error = getComputedStyle(toast).color;
          matches.push(ordinary === (mode === 'light' ? 'rgb(46, 42, 56)' : 'rgb(242, 237, 243)') &&
            error === (mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(255, 245, 245)'));
        }
        toast.classList.remove('error');
        window.__itDebug.preferences.apply(window.__itDebug.preferences.defaults);
        return matches.every(Boolean);
      })()`));
  }
  if (process.env.IT_ANDROID_INTERACTION_SCREENSHOT) {
    const screenshotPath = path.resolve(process.env.IT_ANDROID_INTERACTION_SCREENSHOT);
    await mkdir(path.dirname(screenshotPath), { recursive: true });
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    report.screenshot = screenshotPath;
  }

  await page.evaluate(`window.__itOpenSettings({ section: 'glass' })`);
  await page.until(`document.querySelector('.it-set-mask').classList.contains('on') &&
    !document.querySelector('.it-set').getAnimations().length`);
  await page.evaluate('window.__probeFrames(5)');
  await page.evaluate(`(() => {
    const target = document.getElementById('it-glass-target');
    target.value = 'pill';
    target.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const rangeStart = await page.metrics();
  report.measurements.range = await page.evaluate(`(async () => {
    const probe = window.__androidProbe;
    const slider = ItLiquidGlass.stateOf(document.querySelector('.tabs-thumb'));
    const oldMap = slider.displacementImage.getAttribute('href');
    const counters = { rootAttributes: 0, stylesheetWrites: 0 };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target === document.documentElement) {
          counters.rootAttributes++;
        }
        const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (node && node.closest && node.closest('style')) counters.stylesheetWrites++;
      }
    });
    observer.observe(document.documentElement, {
      attributes: true, childList: true, characterData: true, subtree: true
    });
    window.__probeReset();
    const range = document.querySelector('[data-pref="liquidGlass.pill.refractionLevel"]');
    if (!range) throw new Error('The slider refraction control is unavailable');
    for (let value = 51; value <= 70; value++) {
      range.value = value;
      range.dispatchEvent(new Event('input', { bubbles: true }));
    }
    range.dispatchEvent(new Event('change', { bubbles: true }));
    const synchronous = { ...probe.reads };
    await window.__probeFrames(4);
    observer.disconnect();
    return { ...counters, synchronous, reads: { ...probe.reads },
      configureCalls: probe.configureCalls, nativeCalls: probe.native.length,
      value: Number(range.value), scale: Number(slider.refract.getAttribute('scale')),
      expectedScale: slider.maps.maxDisplacement * (.4 * .7),
      sameMap: oldMap === slider.displacementImage.getAttribute('href') };
  })()`);
  report.measurements.range.performance = delta(rangeStart, await page.metrics());
  check('Twenty same-frame range inputs preserve the last refraction value and optical PNG',
    report.measurements.range.value === 70 && report.measurements.range.sameMap &&
    Math.abs(report.measurements.range.scale - report.measurements.range.expectedScale) < 1e-8);
  if (!BASELINE) {
    check('Range previews batch configuration work once per frame',
      report.measurements.range.configureCalls <= 2,
      JSON.stringify(report.measurements.range));
    check('Optical-only changes do not repeat native appearance updates',
      report.measurements.range.nativeCalls === 0);
  }

  await page.evaluate(`window.__itHandleBack()`);
  await page.until(`!document.querySelector('.it-set-mask').classList.contains('on')`);
  await page.evaluate('window.__probeFrames(5)');
  check('Cancel restores the committed refraction after a pending preview', await page.evaluate(`(() => {
    const slider = ItLiquidGlass.stateOf(document.querySelector('.tabs-thumb'));
    return Math.abs(Number(slider.refract.getAttribute('scale')) - slider.maps.maxDisplacement * .4) < 1e-8;
  })()`));

  report.measurements.drag = await page.evaluate(`(async () => {
    const box = document.getElementById('model-text');
    const buttons = [...box.querySelectorAll('button[data-model]')];
    const points = buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    const event = (type, point) => new PointerEvent(type, { bubbles: true,
      cancelable: true, pointerId: 37, pointerType: 'touch', isPrimary: true,
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: point.x, clientY: point.y });
    buttons[0].dispatchEvent(event('pointerdown', points[0]));
    document.dispatchEvent(event('pointermove', { x: points[0].x + 12, y: points[0].y }));
    await window.__probeFrames(2);
    window.__probeReset();
    for (let index = 0; index < 20; index++) document.dispatchEvent(event('pointermove', {
      x: points[0].x + 12 + index / 10, y: points[0].y
    }));
    const sameIndexReads = { ...window.__androidProbe.reads };
    document.dispatchEvent(event('pointermove', points[1]));
    const beforeRelease = window.__itDebug.state.model.text;
    document.dispatchEvent(event('pointerup', points[1]));
    await window.__probeFrames(3);
    return { sameIndexReads, beforeRelease, selected: window.__itDebug.state.model.text,
      released: !box.classList.contains('is-dragging') };
  })()`);
  check('Dragging crosses the model threshold before pointer release',
    report.measurements.drag.beforeRelease === 'index-mt-9b' &&
    report.measurements.drag.selected === 'index-mt-9b' && report.measurements.drag.released);
  if (!BASELINE) check('Repeated same-index drag moves do not read layout',
    report.measurements.drag.sameIndexReads.offsetReads === 0 &&
    report.measurements.drag.sameIndexReads.boundingRects === 0,
    JSON.stringify(report.measurements.drag.sameIndexReads));

  report.measurements.resizeBurst = await page.evaluate(`(async () => {
    window.__probeReset();
    for (let index = 0; index < 12; index++) window.dispatchEvent(new Event('resize'));
    const synchronous = { ...window.__androidProbe.reads };
    await window.__probeFrames(4);
    return { synchronous, total: { ...window.__androidProbe.reads } };
  })()`);
  if (!BASELINE) check('Resize bursts defer repeated layout work until a frame',
    report.measurements.resizeBurst.synchronous.offsetReads === 0 &&
    report.measurements.resizeBurst.synchronous.boundingRects === 0,
    JSON.stringify(report.measurements.resizeBurst));

  await page.evaluate(`window.__itOpenSettings({ section: 'appearance' })`);
  await page.until(`document.querySelector('.it-set-mask').classList.contains('on') &&
    !document.querySelector('.it-set').getAnimations().length`);
  report.measurements.save = await page.evaluate(`(async () => {
    window.__probeReset();
    const mode = document.querySelector('[data-pref="appearance.mode"]');
    mode.value = 'dark';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    await window.__probeFrames(3);
    const darkNative = window.__androidProbe.native.some((value) => value.dark);
    const target = document.getElementById('it-glass-target');
    target.value = 'pill';
    target.dispatchEvent(new Event('change', { bubbles: true }));
    const refraction = document.querySelector('[data-pref="liquidGlass.pill.refractionLevel"]');
    refraction.value = '41';
    refraction.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('it-set-save').click();
    await window.__probeFrames(4);
    const saved = JSON.parse(localStorage.getItem('it-preferences'));
    const slider = ItLiquidGlass.stateOf(document.querySelector('.tabs-thumb'));
    return { darkNative, commits: window.__androidProbe.commits.length,
      savedMode: saved.appearance.mode, savedRefraction: saved.liquidGlass.pill.refractionLevel,
      scale: Number(slider.refract.getAttribute('scale')),
      expectedScale: slider.maps.maxDisplacement * (.4 * .41),
      closed: !document.querySelector('.it-set-mask').classList.contains('on') };
  })()`);
  check('A real theme change still reaches native appearance', report.measurements.save.darkNative);
  check('Save flushes the last pending range preview and keeps the committed state',
    report.measurements.save.savedMode === 'dark' &&
    report.measurements.save.savedRefraction === 41 && report.measurements.save.closed &&
    report.measurements.save.commits === 1 &&
    Math.abs(report.measurements.save.scale - report.measurements.save.expectedScale) < 1e-8);

  await page.evaluate(`(() => {
    // Product panels above remain static frost. This unattached synthetic shape
    // explicitly exercises the retained legacy engine API and worker fallback.
    const surface = document.createElement('div');
    surface.id = 'android-geometry-probe';
    surface.style.cssText = 'position:fixed;left:-900px;top:0;width:211px;height:173px;border-radius:28px';
    document.body.appendChild(surface);
    ItLiquidGlass.attach(surface, 'card');
  })()`);
  await page.until(`ItLiquidGlass.stateOf(document.getElementById('android-geometry-probe'))?.maps?.width === 211`);
  const geometryStart = await page.metrics();
  await page.evaluate(`(() => {
    window.__geometryProbeStart = performance.now();
    const surface = document.getElementById('android-geometry-probe');
    surface.style.width = '391px'; surface.style.height = '607px';
  })()`);
  await page.until(`ItLiquidGlass.stateOf(document.getElementById('android-geometry-probe'))?.maps?.width === 391 &&
    ItLiquidGlass.stateOf(document.getElementById('android-geometry-probe'))?.maps?.height === 607`, 45000);
  await page.evaluate('window.__probeFrames(3)');
  report.measurements.geometry = await page.evaluate(`(() => {
    const surface = document.getElementById('android-geometry-probe');
    const state = ItLiquidGlass.stateOf(surface);
    return { ready: surface.dataset.itLiquidState === 'ready',
      maxDisplacement: state.maps.maxDisplacement,
      progressiveLayers: state.progressiveLayers.length,
      longTasks: window.__androidProbe.longTasks.filter((entry) =>
        entry.startTime >= window.__geometryProbeStart) };
  })()`);
  report.measurements.geometry.performance = delta(geometryStart, await page.metrics());
  check('The standalone legacy preset retains full geometry and progressive layers',
    report.measurements.geometry.ready && report.measurements.geometry.maxDisplacement > 0 &&
    report.measurements.geometry.progressiveLayers === 3);
  if (!BASELINE) {
    report.measurements.worker = await page.evaluate('ItLiquidGlass.diagnostics()');
    check('Android optical generation runs in a worker without main-thread raster work',
      report.measurements.worker.workerActive && report.measurements.worker.workerMaps > 0 &&
      report.measurements.worker.mainThreadMaps === 0,
      JSON.stringify(report.measurements.worker));

    report.measurements.workerPixelComparison = await page.evaluate(`(async () => {
      const surface = document.getElementById('android-geometry-probe');
      const state = ItLiquidGlass.stateOf(surface);
      const expected = ItLiquidGlass.generateMaps(state.maps.width, state.maps.height,
        state.maps.radius, ItLiquidGlass.opticalPreset(state.presetName, state.maps.radius));
      const canvas = document.createElement('canvas');
      canvas.width = expected.mapWidth; canvas.height = expected.mapHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const load = (url) => new Promise((resolve, reject) => {
        const image = new Image(); image.onload = () => resolve(image); image.onerror = reject;
        image.src = url;
      });
      const compare = async (pixels, url) => {
        const image = context.createImageData(canvas.width, canvas.height);
        image.data.set(pixels); context.putImageData(image, 0, 0);
        const reference = await load(canvas.toDataURL('image/png'));
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(reference, 0, 0);
        const a = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const actual = await load(url);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(actual, 0, 0);
        const b = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let differences = 0;
        for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) differences++;
        return differences;
      };
      return { displacement: await compare(expected.displacement, state.displacementImage.getAttribute('href')),
        specular: await compare(expected.specular, state.specularImage.getAttribute('href')) };
    })()`);
    check('Worker PNG pixels exactly match the original optical renderer',
      report.measurements.workerPixelComparison.displacement === 0 &&
      report.measurements.workerPixelComparison.specular === 0,
      JSON.stringify(report.measurements.workerPixelComparison));

    await page.evaluate(`(() => {
      const worker = window.__androidProbe.workers[0];
      window.__deliverOpticalReply = worker.onmessage;
      window.__heldOpticalReplies = [];
      worker.onmessage = (event) => window.__heldOpticalReplies.push(event);
      const surface = document.getElementById('android-geometry-probe');
      surface.style.width = '251px'; surface.style.height = '177px';
      ItLiquidGlass.refresh(surface);
    })()`);
    await page.until('window.__heldOpticalReplies.length > 0');
    await page.evaluate(`(async () => {
      const surface = document.getElementById('android-geometry-probe');
      surface.style.width = '347px'; surface.style.height = '219px';
      ItLiquidGlass.refresh(surface);
      await window.__probeFrames(2);
      surface.style.width = '433px'; surface.style.height = '263px';
      ItLiquidGlass.refresh(surface);
      await window.__probeFrames(2);
      ItLiquidGlass.configure(ItLiquidGlass.defaults);
      ItLiquidGlass.setInteraction(document.querySelector('.tabs-thumb'), true);
      const state = ItLiquidGlass.stateOf(surface);
      window.__pendingOpticalBounds = {
        width: Number(state.filter.getAttribute('width')),
        height: Number(state.filter.getAttribute('height'))
      };
      window.__deliverOpticalReply(window.__heldOpticalReplies.shift());
    })()`);
    check('Configuration updates preserve the latest bounds while the new map is pending',
      await page.evaluate('window.__pendingOpticalBounds.width === 433 && window.__pendingOpticalBounds.height === 263'));
    await page.until('window.__heldOpticalReplies.length > 0');
    await page.evaluate(`(() => {
      const worker = window.__androidProbe.workers[0];
      worker.onmessage = window.__deliverOpticalReply;
      for (const event of window.__heldOpticalReplies.splice(0)) window.__deliverOpticalReply(event);
      ItLiquidGlass.setInteraction(document.querySelector('.tabs-thumb'), false);
    })()`);
    await page.until(`ItLiquidGlass.stateOf(document.getElementById('android-geometry-probe'))?.maps?.width === 433`);
    check('Stale worker results cannot replace the latest geometry',
      await page.evaluate(`ItLiquidGlass.stateOf(document.getElementById('android-geometry-probe')).maps.height === 263 &&
        ItLiquidGlass.diagnostics().discardedJobs > 0`));

    await page.evaluate(`(async () => {
      const worker = window.__androidProbe.workers[0];
      worker.onmessage = (event) => window.__heldOpticalReplies.push(event);
      const wrapper = document.createElement('div');
      const surface = document.createElement('div');
      surface.style.cssText = 'width:239px;height:113px;border-radius:21px;position:fixed;left:-900px';
      wrapper.appendChild(surface); document.body.appendChild(wrapper);
      window.__removedWorkerSurface = surface;
      window.__removedWorkerWrapper = wrapper;
      ItLiquidGlass.attach(surface, 'card');
    })()`);
    await page.until('window.__heldOpticalReplies.length > 0');
    await page.evaluate(`(async () => {
      window.__removedWorkerWrapper.remove();
      await window.__probeFrames(2);
      const worker = window.__androidProbe.workers[0];
      worker.onmessage = window.__deliverOpticalReply;
      for (const event of window.__heldOpticalReplies.splice(0)) window.__deliverOpticalReply(event);
    })()`);
    check('A completed worker job cannot restore a removed surface',
      await page.evaluate('ItLiquidGlass.stateOf(window.__removedWorkerSurface) === null'));

    await page.evaluate(`(() => {
      window.__androidProbe.workers[0].onmessage = (event) => window.__heldOpticalReplies.push(event);
      const surface = document.getElementById('android-geometry-probe');
      surface.style.width = '479px'; surface.style.height = '283px';
      ItLiquidGlass.refresh(surface);
    })()`);
    await page.until('window.__heldOpticalReplies.length > 0');
    await page.evaluate(`(() => {
      window.__androidProbe.workers[0].dispatchEvent(new ErrorEvent('error', {
        message: 'Synthetic worker failure for fallback verification', cancelable: true
      }));
    })()`);
    await page.until(`ItLiquidGlass.stateOf(document.getElementById('android-geometry-probe'))?.maps?.width === 479`);
    check('Worker failure recovers pending jobs with the complete original renderer',
      await page.evaluate(`(() => {
        const state = ItLiquidGlass.stateOf(document.getElementById('android-geometry-probe'));
        const stats = ItLiquidGlass.diagnostics();
        return stats.workerDisabled && stats.mainThreadMaps > 0 && stats.queuedJobs === 0 &&
          state.maps.height === 283 && state.maps.maxDisplacement > 0 &&
          state.progressiveLayers.length === 3;
      })()`));

    await page.send('Page.navigate', { url: FILE_PAGE });
    await page.until(`document.readyState === 'complete' && !!window.__itDebug &&
      ItLiquidGlass.stateOf(document.querySelector('.tabs-thumb'))?.maps &&
      ItLiquidGlass.diagnostics().queuedJobs === 0`, 45000);
    report.measurements.fileWorker = await page.evaluate('ItLiquidGlass.diagnostics()');
    check('The Android file-asset page can use the full optical worker',
      report.measurements.fileWorker.workerActive && report.measurements.fileWorker.workerMaps > 0 &&
      report.measurements.fileWorker.mainThreadMaps === 0,
      JSON.stringify(report.measurements.fileWorker));
  }
  check('The Android interaction page has no uncaught exceptions', page.errors.length === 0,
    page.errors.join('\n'));
  report.blockedRequests = page.blocked;
} catch (error) {
  if (page) report.diagnostic = await page.evaluate(`(() => ({
    ready: document.readyState, debug: !!window.__itDebug,
    glass: document.documentElement.dataset.itLiquidGlass,
    stats: window.ItLiquidGlass?.diagnostics?.(),
    interactionReady: document.querySelector('.tabs-thumb')?.dataset.itLiquidState
  }))()`).catch(() => null);
  report.runtimeErrors = page?.errors;
  report.warnings = page?.warnings;
  check('Android interaction probe completes', false, error.stack || error.message);
} finally {
  if (browser && targetId) await browser.send('Target.closeTarget', { targetId }).catch(() => {});
  if (browser && contextId) await browser.send('Target.disposeBrowserContext', {
    browserContextId: contextId,
  }).catch(() => {});
  browser?.socket.close();
  await mkdir(path.dirname(REPORT), { recursive: true });
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Android interaction report: ${path.resolve(REPORT)}`);
  if (report.checks.some(({ passed }) => !passed)) process.exitCode = 1;
}
