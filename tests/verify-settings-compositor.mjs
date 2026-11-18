/*
 * Pixel checks for glass during the real settings arrival animation.
 *
 * Each sample pauses production animations at a known progress, captures the
 * controls with their real displacement enabled and disabled, then compares the
 * pixels inside those controls. A decoded PNG alone is not a compositor check.
 * All content and native interfaces are synthetic; other tabs are never read.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = process.env.IT_PREVIEW_ORIGIN || 'http://127.0.0.1:8875';
const DEBUG = process.env.IT_CDP_ORIGIN || 'http://127.0.0.1:9240';
const BASELINE = process.argv.includes('--baseline');
const FALLBACK_ONLY = process.argv.includes('--fallback-only');
const REPORT = process.env.IT_SETTINGS_COMPOSITOR_REPORT ||
  `.build/settings-compositor-${BASELINE ? 'baseline' : 'optimized'}.json`;
const PREFIX = process.env.IT_SETTINGS_COMPOSITOR_SCREENSHOT_PREFIX ||
  `.build/settings-compositor-${BASELINE ? 'baseline' : 'optimized'}`;
const report = { baseline: BASELINE, fallbackOnly: FALLBACK_ONLY, origin: ORIGIN, checks: [], scenarios: [] };
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
        const { requestId, request } = message.params;
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
        entry.reject(new Error('CDP closed before the response'));
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
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await pause(25);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  }
}

function check(name, passed, detail) {
  report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
}

const instrumentation = `
  window.__settingsCompositor = { copied: [], animations: [] };
  window.NativeBridge = {
    platform: () => 'android', getSystemAppearance: () => 'light',
    applyAppearance() {}, commitAppearance: () => true,
    pickImage() {}, pickImageWithToken() {}, toast() {}
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    readText: () => Promise.resolve('Synthetic clipboard'),
    writeText: (text) => { window.__settingsCompositor.copied.push(String(text)); return Promise.resolve(); }
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
    return Promise.reject(new Error('External requests are disabled by the settings compositor probe'));
  };
  window.__compositorFrames = (count = 2) => new Promise((resolve) => {
    const next = () => --count <= 0 ? resolve() : requestAnimationFrame(next);
    requestAnimationFrame(next);
  });
  window.__pauseSettingsAt = (progress) => {
    const mask = document.querySelector('.it-set-mask');
    const dialog = mask.querySelector('.it-set');
    const finite = document.getAnimations().filter((animation) => {
      const target = animation.effect && animation.effect.target;
      return target && (target === mask || dialog.contains(target)) &&
        animation.effect.getComputedTiming().iterations !== Infinity;
    });
    for (const animation of finite) {
      const duration = Number(animation.effect.getTiming().duration);
      if (!Number.isFinite(duration) || duration <= 0) continue;
      animation.pause();
      animation.currentTime = duration * progress;
    }
    window.__settingsCompositor.animations = finite;
    return finite.map((animation) => ({
      target: animation.effect.target.id || animation.effect.target.className,
      pseudoElement: animation.effect.pseudoElement || '',
      duration: animation.effect.getTiming().duration,
      properties: [...new Set(animation.effect.getKeyframes().flatMap((frame) => Object.keys(frame)))]
        .filter((name) => !['offset', 'computedOffset', 'easing', 'composite'].includes(name))
    }));
  };
  window.__finishSettings = () => {
    for (const animation of window.__settingsCompositor.animations) {
      if (animation.playState !== 'idle') animation.finish();
    }
  };
`;

let browser;
let page;
let contextId;
let targetId;

async function setDisplacement(enabled, scopeSelector) {
  return page.evaluate(`(() => {
    const states = [...document.querySelector(${JSON.stringify(scopeSelector)})
      .querySelectorAll('[data-it-liquid-preset]')]
      .map((element) => ItLiquidGlass.stateOf(element)).filter(Boolean);
    for (const state of states) {
      if (${enabled}) {
        if (state.__compositorScale != null) {
          state.refract.setAttribute('scale', state.__compositorScale);
          delete state.__compositorScale;
        }
      } else {
        state.__compositorScale = state.refract.getAttribute('scale');
        state.refract.setAttribute('scale', '0');
      }
    }
    return window.__compositorFrames(2);
  })()`);
}

async function snapshotSample(progress, label, scopeSelector = '.it-set') {
  if (progress < 1) await page.evaluate(`window.__pauseSettingsAt(${progress})`);
  else await page.evaluate('window.__finishSettings()');
  await page.evaluate('window.__compositorFrames(2)');
  const state = await page.evaluate(`(() => {
    const dialog = document.querySelector('.it-set');
    const scope = document.querySelector(${JSON.stringify(scopeSelector)});
    const controls = [...scope.querySelectorAll('[data-it-liquid-preset]')].map((element) => {
      const state = ItLiquidGlass.stateOf(element);
      const rect = element.getBoundingClientRect();
      if (!state || !state.maps || rect.width < 4 || rect.height < 4 ||
          getComputedStyle(element).visibility === 'hidden' || element.closest('[hidden]')) return null;
      const ancestors = [];
      for (let node = state.background.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        ancestors.push({ name: node.id || node.className || node.tagName,
          opacity: Number(style.opacity), filter: style.filter,
          backdropFilter: style.backdropFilter, mixBlendMode: style.mixBlendMode });
      }
      return { name: element.id || element.className,
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        scale: Number(state.refract.getAttribute('scale')), ancestors };
    }).filter(Boolean);
    return { controls, reveal: getComputedStyle(dialog).getPropertyValue('--it-settings-reveal').trim(),
      pageReveal: getComputedStyle(scope).getPropertyValue('--it-settings-page-reveal').trim(),
      maskOpacity: getComputedStyle(dialog.parentElement).opacity,
      dialogOpacity: getComputedStyle(dialog).opacity };
  })()`);
  await setDisplacement(true, scopeSelector);
  const on = await page.send('Page.captureScreenshot', { format: 'png' });
  await setDisplacement(false, scopeSelector);
  const off = await page.send('Page.captureScreenshot', { format: 'png' });
  await setDisplacement(true, scopeSelector);
  const difference = await page.evaluate(`(async () => {
    const load = (source) => new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = reject;
      image.src = 'data:image/png;base64,' + source;
    });
    const [on, off] = await Promise.all([load(${JSON.stringify(on.data)}), load(${JSON.stringify(off.data)})]);
    const canvas = document.createElement('canvas');
    canvas.width = on.width; canvas.height = on.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(on, 0, 0);
    const a = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(off, 0, 0);
    const b = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const mask = new Uint8Array(canvas.width * canvas.height);
    for (const control of ${JSON.stringify(state.controls)}) {
      for (let y = Math.max(0, Math.floor(control.top)); y < Math.min(canvas.height, Math.ceil(control.bottom)); y++) {
        for (let x = Math.max(0, Math.floor(control.left)); x < Math.min(canvas.width, Math.ceil(control.right)); x++) {
          mask[y * canvas.width + x] = 1;
        }
      }
    }
    let changed = 0, maximumDelta = 0, compared = 0;
    for (let pixel = 0; pixel < mask.length; pixel++) {
      if (!mask[pixel]) continue;
      compared++;
      const offset = pixel * 4;
      const delta = Math.max(Math.abs(a[offset] - b[offset]),
        Math.abs(a[offset + 1] - b[offset + 1]), Math.abs(a[offset + 2] - b[offset + 2]));
      if (delta > 3) changed++;
      maximumDelta = Math.max(maximumDelta, delta);
    }
    return { changed, maximumDelta, compared };
  })()`);
  const result = { progress, ...difference, ...state };
  const screenshotPath = `${PREFIX}-${label}-${String(progress).replace('.', '_')}.png`;
  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await writeFile(screenshotPath, Buffer.from(on.data, 'base64'));
  result.screenshot = path.resolve(screenshotPath);
  return result;
}

async function navigateScenario(width, height, mode) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width < 760,
  });
  await page.send('Page.navigate', { url: `${ORIGIN}/?debug=1` });
  await page.send('Page.bringToFront');
  await page.until(`document.readyState === 'complete' && !!window.__itDebug &&
    ItLiquidGlass.diagnostics().queuedJobs === 0 &&
    ItLiquidGlass.isReady(document.querySelector('.tabs'))`, 45000);
  await page.evaluate(`(() => {
    const style = document.createElement('style');
    style.id = 'settings-compositor-synthetic-scene';
    style.textContent = 'body::before{animation:none!important;background:repeating-linear-gradient(90deg,#ff1744 0 6px,#1e40ff 6px 12px,#ffe600 12px 18px,#00bd72 18px 24px)!important}body::after{display:none!important}';
    document.head.appendChild(style);
    window.__itDebug.preferences.apply(window.__itDebug.preferences.normalize({
      appearance: { mode: ${JSON.stringify(mode)} },
      liquidGlass: { card: { backgroundOpacity: 0 } }
    }));
  })()`);
  await page.evaluate('window.__compositorFrames(3)');
}

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
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });

  if (!FALLBACK_ONLY) {
  for (const scenario of [
    { name: 'mobile-light', width: 390, height: 844, mode: 'light' },
    { name: 'mobile-dark', width: 390, height: 844, mode: 'dark' },
    { name: 'wide-light', width: 1180, height: 900, mode: 'light' },
  ]) {
    await navigateScenario(scenario.width, scenario.height, scenario.mode);
    // Matching the final dialog box isolates ancestor opacity from changing
    // screen geometry. A separate case below retains the real gear trajectory.
    await page.evaluate(`(() => {
      const rect = document.querySelector('.it-set').getBoundingClientRect();
      window.__itOpenSettings({ section: 'appearance',
        origin: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
    })()`);
    await page.until(`document.querySelector('.it-set-mask').classList.contains('on')`);
    const animations = await page.evaluate('window.__pauseSettingsAt(.3)');
    check(`${scenario.name}: the settings animation is present`, animations.length > 0, animations);
    const samples = [];
    for (const progress of [.3, .65, .995, 1]) {
      const sample = await snapshotSample(progress, scenario.name);
      samples.push(sample);
      if (!BASELINE) {
        check(`${scenario.name}: refraction is visible at ${progress * 100}%`,
          sample.changed > 20 && sample.maximumDelta > 10,
          { changed: sample.changed, maximumDelta: sample.maximumDelta, compared: sample.compared });
        check(`${scenario.name}: optical ancestors remain opaque at ${progress * 100}%`,
          sample.controls.length > 0 &&
          sample.controls.every((control) => control.ancestors.every((ancestor) => ancestor.opacity === 1)));
      }
    }
    const beforeEnd = samples.find((sample) => sample.progress === .995);
    const complete = samples.find((sample) => sample.progress === 1);
    if (!BASELINE) check(`${scenario.name}: optical pixels remain substantial throughout arrival`,
      samples.filter((sample) => sample.progress < 1).every((sample) =>
        sample.changed >= complete.changed * .5 &&
        sample.maximumDelta >= complete.maximumDelta * .5),
      samples.map(({ progress, changed, maximumDelta }) => ({ progress, changed, maximumDelta })));
    if (!BASELINE) check(`${scenario.name}: the last animation frame does not suddenly gain refraction`,
      beforeEnd.changed >= complete.changed * .65 &&
      beforeEnd.maximumDelta >= complete.maximumDelta * .65,
      { beforeEnd: beforeEnd.changed, complete: complete.changed });
    report.scenarios.push({ ...scenario, animations, samples });
    await page.evaluate('window.__itHandleBack()');
    await page.until(`!document.querySelector('.it-set-mask').classList.contains('on')`);
  }

  await navigateScenario(390, 844, 'light');
  await page.evaluate(`(() => {
    const trigger = document.getElementById('mobile-settings');
    window.__itOpenSettings({ section: 'appearance', trigger,
      origin: trigger.getBoundingClientRect() });
  })()`);
  await page.until(`document.querySelector('.it-set-mask').classList.contains('on')`);
  await page.evaluate('window.__pauseSettingsAt(.65)');
  const realOrigin = await snapshotSample(.65, 'real-gear');
  if (!BASELINE) check('The real gear-origin opening retains optical pixels during scaling',
    realOrigin.changed > 10 && realOrigin.maximumDelta > 10,
    { changed: realOrigin.changed, maximumDelta: realOrigin.maximumDelta });
  report.realGear = realOrigin;
  await page.evaluate(`(async () => {
    window.__itHandleBack();
    window.__pauseSettingsAt(.35);
    window.__itOpenSettings({ section: 'appearance' });
    await window.__compositorFrames(2);
  })()`);
  await page.until(`document.querySelector('.it-set-mask').classList.contains('on')`);
  await page.evaluate('window.__pauseSettingsAt(.65)');
  const reopened = await snapshotSample(.65, 'reopened');
  if (!BASELINE) check('Reversing close and reopen keeps the glass scene composited',
    reopened.changed > 10 && reopened.maximumDelta > 10);
  await page.evaluate('window.__finishSettings()');
  await page.evaluate('window.__compositorFrames(3)');
  check('The reopened dialog finishes visible with interactive controls', await page.evaluate(`(() => {
    const mask = document.querySelector('.it-set-mask');
    const reveal = getComputedStyle(mask.querySelector('.it-set'))
      .getPropertyValue('--it-settings-reveal').trim();
    return mask.classList.contains('on') && !mask.inert &&
      ItLiquidGlass.isReady(mask) && getComputedStyle(mask).visibility === 'visible' &&
      (!reveal || Number(reveal) === 1);
  })()`));
  report.reopened = reopened;
  await page.evaluate(`(() => {
    window.__itHandleBack();
    window.__finishSettings();
    const preferences = window.__itDebug.preferences.normalize();
    preferences.appearance.motion = 'off';
    window.__itDebug.preferences.apply(preferences);
  })()`);
  await page.evaluate('window.__compositorFrames(2)');
  await page.evaluate(`window.__itOpenSettings({ section: 'appearance' })`);
  await page.until(`document.querySelector('.it-set-mask').classList.contains('on')`);
  check('Animations-off settings preserve their complete optical state', await page.evaluate(`(() => {
    const mask = document.querySelector('.it-set-mask');
    const dialog = mask.querySelector('.it-set');
    return ItLiquidGlass.isReady(mask) &&
      dialog.getAnimations({ subtree: true }).every((animation) =>
        animation.effect.getComputedTiming().iterations === Infinity) &&
      getComputedStyle(dialog).opacity === '1';
  })()`));
  }

  if (!BASELINE) {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      Object.defineProperty(CSS, 'registerProperty', { value: undefined, configurable: true });
      window.__settingsFallbackProbe = { paintWrites: 0, revealFrames: new Set() };
      const setProperty = CSSStyleDeclaration.prototype.setProperty;
      CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
        if (name === '--it-settings-reveal' || name === '--it-settings-page-reveal') {
          window.__settingsFallbackProbe.paintWrites++;
        }
        return setProperty.call(this, name, value, priority);
      };
      const requestFrame = window.requestAnimationFrame.bind(window);
      const cancelFrame = window.cancelAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => {
        const reveal = callback.name === 'updateReveal';
        let id;
        id = requestFrame((time) => {
          if (reveal) window.__settingsFallbackProbe.revealFrames.delete(id);
          callback(time);
        });
        if (reveal) window.__settingsFallbackProbe.revealFrames.add(id);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        window.__settingsFallbackProbe.revealFrames.delete(id);
        cancelFrame(id);
      };
    ` });
    await navigateScenario(390, 844, 'light');
    check('The compatibility fixture disables custom-property registration before app startup',
      await page.evaluate(`typeof CSS.registerProperty !== 'function'`));
    await page.evaluate(`(() => {
      const rect = document.querySelector('.it-set').getBoundingClientRect();
      window.__itOpenSettings({ section: 'appearance',
        origin: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
    })()`);
    await page.until(`document.querySelector('.it-set-mask').classList.contains('on')`);
    const fallbackDialog = [];
    for (const progress of [.3, .65]) {
      const sample = await snapshotSample(progress, 'fallback-dialog');
      fallbackDialog.push(sample);
      const reveal = Number(sample.reveal);
      check(`The unregistered dialog fade has an intermediate value at ${progress * 100}%`,
        sample.reveal !== '' && reveal > 0 && reveal < 1,
        { reveal, progress });
      check(`The unregistered dialog retains real refraction at ${progress * 100}%`,
        sample.changed > 20 && sample.maximumDelta > 10 &&
        sample.controls.every((control) => control.ancestors.every((ancestor) => ancestor.opacity === 1)),
        { changed: sample.changed, maximumDelta: sample.maximumDelta });
    }
    check('The compatibility dialog fade follows its production animation progress',
      Number(fallbackDialog[1].reveal) > Number(fallbackDialog[0].reveal));
    await page.evaluate('window.__finishSettings()');
    await page.evaluate('window.__compositorFrames(3)');

    await page.evaluate(`document.querySelector('[data-pref-tab="reading"]').click()`);
    await page.until(`(() => {
      const section = document.querySelector('[data-pref-section="reading"]');
      return !section.hidden && section.classList.contains('is-entered') &&
        section.getAnimations().some((animation) => animation.effect.getKeyframes()
          .some((frame) => Object.hasOwn(frame, 'transform')));
    })()`);
    const fallbackSection = [];
    for (const progress of [.3, .65]) {
      const sample = await snapshotSample(progress, 'fallback-category', '[data-pref-section="reading"]');
      fallbackSection.push(sample);
      const reveal = Number(sample.pageReveal);
      check(`The unregistered category fade has an intermediate value at ${progress * 100}%`,
        sample.pageReveal !== '' && reveal > 0 && reveal < 1,
        { reveal, progress });
      check(`The unregistered category retains optical pixels at ${progress * 100}%`,
        sample.controls.length > 0 && sample.changed > 10 && sample.maximumDelta > 10 &&
        sample.controls.every((control) => control.ancestors.every((ancestor) => ancestor.opacity === 1)),
        { changed: sample.changed, maximumDelta: sample.maximumDelta });
    }
    check('The compatibility category fade follows the incoming animation progress',
      Number(fallbackSection[1].pageReveal) > Number(fallbackSection[0].pageReveal));
    await page.evaluate('window.__finishSettings()');
    await page.until(`(() => {
      const section = document.querySelector('[data-pref-section="reading"]');
      return !section.hidden && !section.inert && !section.classList.contains('is-entering') &&
        !section.classList.contains('is-leaving');
    })()`);
    await page.evaluate(`(() => {
      document.querySelector('[data-pref-tab="glass"]').click();
      document.querySelector('[data-pref-tab="translation"]').click();
      document.querySelector('[data-pref-tab="motion"]').click();
    })()`);
    await page.until(`(() => {
      const sections = [...document.querySelectorAll('[data-pref-section]')].filter((section) => !section.hidden);
      return sections.length === 1 && sections[0].dataset.prefSection === 'motion' &&
        !sections[0].inert && !sections[0].classList.contains('is-entering') &&
        !sections[0].classList.contains('is-leaving') &&
        sections[0].getAnimations().length === 0;
    })()`);
    check('Rapid category changes finish only the newest compatibility fade',
      await page.evaluate(`(() => {
        const sections = [...document.querySelectorAll('[data-pref-section]')];
        return sections.every((section) => section.style.getPropertyValue('--it-settings-page-reveal') === '') &&
          window.__settingsFallbackProbe.revealFrames.size === 0;
      })()`));

    await page.evaluate(`(async () => {
      document.querySelector('[data-pref-tab="appearance"]').click();
      window.__pauseSettingsAt(.35);
      window.__itHandleBack();
      window.__pauseSettingsAt(.35);
      await window.__compositorFrames(2);
      window.__itOpenSettings({ section: 'appearance' });
    })()`);
    await page.until(`document.querySelector('.it-set-mask').classList.contains('on')`);
    const fallbackReopened = await snapshotSample(.65, 'fallback-reopened');
    check('Reopening cancels the old compatibility fade without losing its intermediate paint state',
      Number(fallbackReopened.reveal) > 0 && Number(fallbackReopened.reveal) < 1 &&
      fallbackReopened.changed > 10 && fallbackReopened.maximumDelta > 10,
      { reveal: fallbackReopened.reveal, changed: fallbackReopened.changed,
        maximumDelta: fallbackReopened.maximumDelta });
    await page.evaluate('window.__finishSettings()');
    await page.evaluate('window.__compositorFrames(3)');
    await page.evaluate(`(() => {
      document.querySelector('[data-pref-tab="reading"]').click();
      window.__pauseSettingsAt(.35);
      window.__itHandleBack();
      window.__pauseSettingsAt(.65);
      window.__finishSettings();
    })()`);
    await page.until(`!document.querySelector('.it-set-mask').classList.contains('on') &&
      !document.querySelector('.it-set-mask').classList.contains('it-surface-leave')`);
    await page.evaluate('window.__compositorFrames(3)');
    const cancelled = await page.evaluate(`(async () => {
      const probe = window.__settingsFallbackProbe;
      const before = probe.paintWrites;
      await window.__compositorFrames(5);
      return { before, after: probe.paintWrites, frames: probe.revealFrames.size,
        dialogInline: document.querySelector('.it-set').style.getPropertyValue('--it-settings-reveal'),
        pageInline: [...document.querySelectorAll('[data-pref-section]')]
          .map((section) => section.style.getPropertyValue('--it-settings-page-reveal')) };
    })()`);
    check('Closing cancels every compatibility reveal frame, stops stale writes and keeps dialog transparent',
      cancelled.before > 2 && cancelled.after === cancelled.before && cancelled.frames === 0 &&
      cancelled.dialogInline === '0' && cancelled.pageInline.every((value) => value === ''), cancelled);
    report.fallback = { dialog: fallbackDialog, section: fallbackSection,
      reopened: fallbackReopened, cancelled };
  }
  check('The settings compositor probe reports no uncaught exceptions', page.errors.length === 0, page.errors);
  check('The settings compositor probe does not access external URLs', page.blockedRequests === 0);
} catch (error) {
  report.diagnostic = page && await page.evaluate(`(() => ({
    settings: document.querySelector('.it-set-mask')?.className,
    reveal: getComputedStyle(document.querySelector('.it-set')).getPropertyValue('--it-settings-reveal'),
    animations: document.getAnimations().map((animation) => ({
      target: animation.effect?.target?.className,
      currentTime: animation.currentTime, playState: animation.playState
    }))
  }))()`).catch(() => null);
  report.errors = page?.errors;
  check('The settings compositor probe completes', false, error.stack || error.message);
} finally {
  if (browser && targetId) await browser.send('Target.closeTarget', { targetId }).catch(() => {});
  if (browser && contextId) await browser.send('Target.disposeBrowserContext', {
    browserContextId: contextId,
  }).catch(() => {});
  browser?.socket.close();
  await mkdir(path.dirname(REPORT), { recursive: true });
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Settings compositor report: ${path.resolve(REPORT)}`);
  if (report.checks.some(({ passed }) => !passed)) process.exitCode = 1;
}
