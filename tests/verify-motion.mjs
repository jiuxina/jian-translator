/*
 * Offline interaction checks for the continuous motion experience.
 *
 * Prerequisites: serve web/ on 127.0.0.1:8899 and start an isolated Chrome
 * profile with --remote-debugging-port=9223. Then run:
 *
 *   node tests/verify-motion.mjs
 *
 * Uses Node's built-in WebSocket and CDP. External page requests are blocked,
 * the clipboard and desktop bridge are local stubs, and no translation API,
 * credentials, package installation, or existing browser windows are needed.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const ORIGIN = process.env.IT_PREVIEW_ORIGIN || 'http://127.0.0.1:8899';
const DEBUG_ORIGIN = process.env.IT_CDP_ORIGIN || 'http://127.0.0.1:9223';
const PAGE_URL = `${ORIGIN}/?debug=1`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const connections = [];
let mainTargetId;
let desktopTargetId;
let popupTargetId;
let macTargetId;

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.errors = [];
    this.blockedRequests = [];
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        this.errors.push(details.exception?.description || details.text);
      } else if (message.method === 'Fetch.requestPaused') {
        const { requestId, request } = message.params;
        const local = request.url.startsWith(`${ORIGIN}/`) ||
          request.url.startsWith('data:') || request.url.startsWith('blob:');
        const command = local ? 'Fetch.continueRequest' : 'Fetch.failRequest';
        const params = local ? { requestId } : { requestId, errorReason: 'BlockedByClient' };
        if (!local) this.blockedRequests.push(request.url);
        this.send(command, params).catch((error) => this.errors.push(error.message));
      }
    });
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('CDP connection closed before the response'));
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
    const connection = new Cdp(socket);
    connections.push(connection);
    return connection;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
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

  async until(expression, timeout = 3500) {
    const deadline = Date.now() + timeout;
    do {
      if (await this.evaluate(expression)) return;
      await pause(30);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for: ${expression}`);
  }

  async key(key, code = key) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
  }

  async click(selector) {
    await this.until(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      for (let node = element; node && node !== document.body; node = node.parentElement) {
        const moving = node.getAnimations().some((animation) =>
          animation.effect.getComputedTiming().iterations !== Infinity &&
          animation.effect.getKeyframes().some((frame) => frame.transform));
        if (moving) return false;
      }
      return true;
    })()`);
    const point = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit: hit === element || element.contains(hit),
        visible: x >= 0 && y >= 0 && x < innerWidth && y < innerHeight };
    })()`);
    if (!point?.hit || !point.visible) {
      throw new Error(`Control is not reachable by pointer: ${selector} ${JSON.stringify(point)}`);
    }
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', button: 'left', clickCount: 1, x: point.x, y: point.y,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x, y: point.y,
    });
  }
}

function check(name, passed, detail = '') {
  results.push({ name, passed: Boolean(passed) });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function scenario(name, task) {
  try {
    await task();
  } catch (error) {
    check(name, false, error.message);
  }
}

const baselineScript = `
  window.__motionTest = { copied: [], invoked: [] };
  window.__glassStyle = (element) => getComputedStyle(
    element.querySelector(':scope > [data-it-liquid-background]') || element);
  const fetchReal = window.fetch.bind(window);
  window.fetch = (url, options) => {
    if (String(url) === 'https://api.github.com/repos/jiuxina/jian-translator/releases/latest') {
      window.__motionTest.updateChecks = (window.__motionTest.updateChecks || 0) + 1;
      const mocked = window.__motionTest.updateResponse || { status: 200, body: {
        tag_name: 'v2.3.0', html_url: 'https://github.com/jiuxina/jian-translator/releases/tag/v2.3.0'
      } };
      return Promise.resolve(new Response(JSON.stringify(mocked.body || {}), {
        status: mocked.status, headers: { 'content-type': 'application/json' }
      }));
    }
    return fetchReal(url, options);
  };
  window.alert = (message) => { window.__motionTest.alerts = [...(window.__motionTest.alerts || []), message]; };
  const inputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type === 'file' && this.accept === 'image/*') {
      window.__motionTest.filePickerOpens = (window.__motionTest.filePickerOpens || 0) + 1;
      Object.defineProperty(this, 'files', { configurable: true,
        value: [new File(['offline image'], 'background.png', { type: 'image/png' })] });
      this.dispatchEvent(new Event('change'));
      return;
    }
    return inputClick.call(this);
  };
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text) => { window.__motionTest.copied.push(text); return Promise.resolve(); },
      readText: () => Promise.resolve('离线测试剪贴板')
    }
  });
`;
const desktopScript = `
  window.__TAURI_INTERNALS__ = {
    invoke: (command, args) => {
      window.__motionTest.invoked.push({ command, args });
      if (command === 'it_get_settings') return Promise.resolve({
        selection_shortcut: 'Ctrl+Alt+T', activation_shortcut: 'Ctrl+Alt+I',
        open_main_window: false, target_lang: 'auto',
        auto_start: false, start_to_tray: true,
        preferences: JSON.parse(localStorage.getItem('it-preferences') || 'null')
      });
      if (command === 'it_list_system_fonts') {
        const fonts = ['Arial', 'Microsoft YaHei UI',
          ...Array.from({ length: 15 }, (_, index) => 'Offline Test Font ' + index)];
        if (!window.__motionTest.delaySystemFonts) return Promise.resolve(fonts);
        return new Promise((resolve) => {
          window.__motionTest.resolveSystemFonts = () => resolve(fonts);
        });
      }
      if (command === 'it_write_clipboard_text') return Promise.resolve(true);
      if (command === 'it_save_settings') {
        const submitted = JSON.parse(JSON.stringify(args.settings));
        window.__motionTest.submittedSettings = submitted;
        return new Promise((resolve) => {
          let timer;
          const finish = () => {
            clearTimeout(timer);
            window.__motionTest.savedSettings = submitted;
            delete window.__motionTest.resolveSave;
            resolve([]);
          };
          window.__motionTest.resolveSave = finish;
          timer = setTimeout(finish, window.__motionTest.saveDelay || 0);
        });
      }
      return Promise.resolve(null);
    }
  };
`;
const macScript = desktopScript + `
  const invokeDesktop = window.__TAURI_INTERNALS__.invoke;
  delete window.__TAURI_INTERNALS__;
  window.__JIAN_DESKTOP__ = Object.freeze({
    platform: 'darwin',
    invoke: (command, args) => invokeDesktop(command, args).then((result) => {
      if (command !== 'it_get_settings') return result;
      return { ...result, selection_shortcut: 'Cmd+Alt+T', activation_shortcut: 'Cmd+Alt+I' };
    }),
    onAction: (callback) => {
      window.__motionTest.nativeAction = callback;
      return () => { delete window.__motionTest.nativeAction; };
    }
  });
`;

async function prepare(connection, desktop = false, clearStorage = false) {
  await connection.send('Emulation.setDeviceMetricsOverride', {
    width: 1180, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await connection.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await connection.send('Runtime.enable');
  await connection.send('Page.enable');
  await connection.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }],
  });
  await connection.send('Page.addScriptToEvaluateOnNewDocument', {
    source: (clearStorage ? 'try { if (!sessionStorage.getItem("motion-test-fresh")) {' +
      ' localStorage.clear(); sessionStorage.setItem("motion-test-fresh", "1"); } } catch (e) {}\n' : '') +
      baselineScript + (desktop === 'mac' ? macScript : desktop ? desktopScript : ''),
  });
  await connection.send('Page.navigate', { url: PAGE_URL });
  await connection.send('Page.bringToFront');
  await connection.until(`document.readyState === 'complete' && !!window.__itDebug`);
  await connection.evaluate(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);
}

const finitePaneAnimations = `(() => {
  const root = document.querySelector('.pane-stack');
  return root.getAnimations({ subtree: true }).filter((animation) =>
    animation.effect.getComputedTiming().iterations !== Infinity).length;
})()`;

async function settle(connection, tab) {
  await connection.until(`(() => {
    const selected = document.querySelectorAll('.pane[aria-hidden="false"]');
    return selected.length === 1 && selected[0].id === 'pane-${tab}' &&
      ${finitePaneAnimations} === 0 &&
      [...document.querySelectorAll('.pane')].filter((pane) =>
        getComputedStyle(pane).visibility === 'visible').length === 1;
  })()`);
}

async function selectTab(connection, tab) {
  await connection.evaluate(`document.querySelector('[data-tab="${tab}"]').click()`);
  await settle(connection, tab);
}

async function selectSettingsSection(connection, section) {
  await connection.until(`document.querySelector('.it-set').getAnimations().length === 0`);
  await connection.click(`[data-pref-tab="${section}"]`);
  try {
    await connection.until(`(() => {
      const page = document.querySelector('[data-pref-section="${section}"]');
      return !!page && !page.hidden && !page.inert &&
        !page.classList.contains('is-entering') && !page.classList.contains('is-leaving');
    })()`);
  } catch (error) {
    const state = await connection.evaluate(`(() => ({
      open: document.querySelector('.it-set-mask')?.getAttribute('aria-hidden'),
      active: document.querySelector('.it-set-nav .on')?.getAttribute('data-pref-tab'),
      pages: [...document.querySelectorAll('[data-pref-section]')].map((page) => ({
        id: page.dataset.prefSection, hidden: page.hidden, inert: page.inert, classes: page.className
      }))
    }))()`);
    throw new Error(`${error.message} ${JSON.stringify(state)}`);
  }
}

async function openMenu(connection) {
  const trigger = await connection.evaluate(`(() => {
    const mobile = document.getElementById('mobile-settings');
    return mobile?.getClientRects().length ? '#mobile-settings' : '#brand';
  })()`);
  await connection.click(trigger);
}

async function directionAndShells(connection, from, to, direction) {
  await selectTab(connection, from);
  const sample = await connection.evaluate(`(async () => {
    const before = ['appbar', 'langbar'].map((id) => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const source = document.getElementById('pane-${from}');
    const target = document.getElementById('pane-${to}');
    const sourceCards = [...source.querySelectorAll('.card')];
    const targetCards = [...target.querySelectorAll('.card')];
    const cores = sourceCards.map((card, index) => {
      const start = card.getBoundingClientRect(), end = targetCards[index].getBoundingClientRect();
      return { left: Math.max(start.left, end.left), top: Math.max(start.top, end.top),
        right: Math.min(start.right, end.right), bottom: Math.min(start.bottom, end.bottom) };
    });
    const opacity = (element) => {
      let value = 1;
      for (let node = element; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none') return 0;
        value *= Number(style.opacity);
      }
      return value;
    };
    const offsets = (pane) => [...pane.querySelectorAll('.card-head, .card-body, .card-foot')].map((node) => {
      const transform = getComputedStyle(node).transform;
      return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41;
    });
    document.querySelector('[data-tab="${to}"]').click();
    source.querySelector('.src').focus();
    const focusBlocked = !source.contains(document.activeElement);
    const frames = [];
    for (let i = 0; i < 120; i++) {
      await new Promise(requestAnimationFrame);
      const bars = ['appbar', 'langbar'].map((id, index) => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return Math.max(...['x', 'y', 'width', 'height'].map((key) =>
          Math.abs(rect[key] - before[index][key])));
      });
      const cards = [...document.querySelectorAll('.pane .card')].filter((card) => {
        const rect = card.getBoundingClientRect();
        return opacity(card) > .85 && rect.width > 80 && rect.height > 60;
      });
      const covered = cores.every((core) => cards.some((card) => {
        const rect = card.getBoundingClientRect();
        const width = Math.max(0, Math.min(rect.right, core.right) - Math.max(rect.left, core.left));
        const height = Math.max(0, Math.min(rect.bottom, core.bottom) - Math.max(rect.top, core.top));
        const area = (core.right - core.left) * (core.bottom - core.top);
        return area > 0 && width * height / area > .95;
      }));
      frames.push({ bars, covered,
        incoming: offsets(target), outgoing: offsets(source) });
      if (i >= 2 && ${finitePaneAnimations} === 0) break;
    }
    return { frames, focusBlocked };
  })()`);
  const { frames, focusBlocked } = sample;
  const incoming = frames.flatMap((frame) => frame.incoming);
  const outgoing = frames.flatMap((frame) => frame.outgoing);
  const contentCount = frames[0].incoming.length;
  const everyContentMoved = contentCount === 6 && frames[0].outgoing.length === 6 &&
    Array.from({ length: contentCount }, (_, index) =>
      frames.some((frame) => direction * frame.incoming[index] > 1) &&
      frames.some((frame) => -direction * frame.outgoing[index] > 1)).every(Boolean);
  const everyDirectionCorrect = incoming.every((x) => direction * x >= -.05) &&
    outgoing.every((x) => direction * x <= .05);
  check(`${from} → ${to} 的内容沿导航方向承接`,
    everyContentMoved && everyDirectionCorrect,
    `incoming=[${Math.min(...incoming).toFixed(2)},${Math.max(...incoming).toFixed(2)}], ` +
      `outgoing=[${Math.min(...outgoing).toFixed(2)},${Math.max(...outgoing).toFixed(2)}]`);
  check(`${from} → ${to} 全程保留卡壳与共享栏`,
    frames.every((frame) => frame.covered && frame.bars.every((delta) => delta < .75)));
  check(`${from} → ${to} 动画开始时已隔离退场焦点`, focusBlocked);
  await settle(connection, to);
}

async function menus(connection) {
  await openMenu(connection);
  check('主菜单只包含设置和关于', await connection.evaluate(`(() => {
    const actions = [...document.querySelectorAll('#more-menu [data-act]')]
      .map((button) => button.getAttribute('data-act'));
    return JSON.stringify(actions) === JSON.stringify(['settings', 'about']);
  })()`));
  await connection.key('Escape');
  check('Escape 关闭更多菜单',
    await connection.evaluate(`document.getElementById('more-menu').getAttribute('aria-hidden') === 'true'`));
  await openMenu(connection);
  check('系统返回关闭更多菜单',
    await connection.evaluate(`window.__itHandleBack() === true &&
      document.getElementById('more-menu').getAttribute('aria-hidden') === 'true'`));
  await openMenu(connection);
  await connection.click('#more-menu [data-act="about"]');
  await connection.until(`document.querySelector('.it-about-mask')?.getAttribute('aria-hidden') === 'false'`);
  await pause(350);
  const aboutScreenshot = await connection.send('Page.captureScreenshot', { format: 'png' });
  await mkdir('output', { recursive: true });
  await writeFile('output/preview-2.3.0-about.png', Buffer.from(aboutScreenshot.data, 'base64'));
  check('关于页展示版本、品牌与服务说明', await connection.evaluate(`(() => {
    const about = document.querySelector('.it-about');
    return !!about && about.textContent.includes('笺') && about.textContent.includes('2.3.0') &&
      about.textContent.includes('Index-Translate') && about.textContent.includes('非官方客户端');
  })()`));
  check('关于页移除译字标语并展示开源仓库链接', await connection.evaluate(`(() => {
    const about = document.querySelector('.it-about');
    const repository = about?.querySelector('.it-about-repository');
    return !!about && !about.querySelector('.it-about-eyebrow') &&
      !about.querySelector('.it-about-brand') && !about.querySelector('#it-about-logo') &&
      repository?.href === 'https://github.com/jiuxina/jian-translator' &&
      repository.target === '_blank' && repository.rel.includes('noopener');
  })()`));
  check('关于页打开时焦点位于对话框内', await connection.evaluate(`
    document.querySelector('.it-about').contains(document.activeElement)`));
  check('系统返回关闭关于页', await connection.evaluate(`window.__itHandleBack() === true &&
    document.querySelector('.it-about-mask')?.getAttribute('aria-hidden') === 'true'`));
  await openMenu(connection);
  await connection.click('#more-menu [data-act="about"]');
  await connection.until(`document.querySelector('.it-about-mask')?.getAttribute('aria-hidden') === 'false'`);
  await connection.key('Escape');
  await connection.until(`document.querySelector('.it-about-mask')?.getAttribute('aria-hidden') === 'true'`);
  check('Escape 关闭关于页并恢复焦点', await connection.evaluate(`document.activeElement === document.getElementById('brand')`));
  await connection.click('#langbar .sel-btn');
  await connection.key('Escape');
  check('Escape 关闭语言列表并归还焦点',
    await connection.evaluate(`!document.querySelector('.sel-pop[aria-hidden="false"]') &&
      document.activeElement === document.querySelector('#langbar .sel-btn')`));
  await connection.click('#langbar .sel-btn');
  check('系统返回关闭语言列表',
    await connection.evaluate(`window.__itHandleBack() === true &&
      !document.querySelector('.sel-pop[aria-hidden="false"]')`));
}

let page;
let controller;
let desktop;

function connectOwnTarget(targetId) {
  const url = new URL(controller.socket.url);
  url.pathname = '/devtools/page/' + targetId;
  return Cdp.connect(url.href);
}

try {
  const version = await (await fetch(`${DEBUG_ORIGIN}/json/version`)).json();
  controller = await Cdp.connect(version.webSocketDebuggerUrl);
  const created = await controller.send('Target.createTarget', { url: 'about:blank' });
  mainTargetId = created.targetId;
  page = await connectOwnTarget(mainTargetId);
  await prepare(page, false, true);

  await scenario('旧版已保存的玻璃偏好会升级并保留其他设置', async () => {
    await page.evaluate(`localStorage.setItem('it-preferences', JSON.stringify({
      version: 1,
      appearance: { mode: 'dark', palette: 'sage', material: 'solid', glassStrength: 0,
        cardReveal: 100, font: 'serif', fontWeight: 500 },
      background: { opacity: 28 }, popup: { cardReveal: 100, backgroundData: '' }
    }))`);
    await page.send('Page.reload');
    await page.until(`document.readyState === 'complete' && !!window.__itDebug`);
    const migrated = await page.evaluate(`JSON.parse(localStorage.getItem('it-preferences') || 'null')`);
    check('旧玻璃键改用新默认参数且主题、字体和壁纸偏好保留', migrated?.version === 3 &&
      migrated?.appearance?.mode === 'dark' && migrated?.appearance?.palette === 'sage' &&
      migrated?.appearance?.font === 'serif' && migrated?.appearance?.fontWeight === 500 &&
      migrated?.background?.opacity === 28 && migrated?.liquidGlass?.card?.backgroundOpacity === 60 &&
      migrated?.liquidGlass?.card?.refractionLevel === 100 && migrated?.appearance?.material === undefined &&
      migrated?.appearance?.glassStrength === undefined && migrated?.appearance?.cardReveal === undefined &&
      migrated?.popup?.cardReveal === undefined);
    await page.evaluate(`localStorage.removeItem('it-preferences')`);
    await page.send('Page.reload');
    await page.until(`document.readyState === 'complete' && !!window.__itDebug`);
  });

  await scenario('双向页面承接', async () => {
    await directionAndShells(page, 'text', 'syllable', 1);
    await directionAndShells(page, 'syllable', 'text', -1);
  });

  await scenario('鼠标拖动模型滑块实时选择', async () => {
    await selectTab(page, 'text');
    await page.evaluate(`document.querySelector('#model-text [data-model="index-mt-2b"]').click()`);
    await pause(450);
    const points = await page.evaluate(`(() => [...document.querySelectorAll('#model-text button')].map((button) => {
      const rect = button.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }))()`);
    const mouse = (type, point) => page.send('Input.dispatchMouseEvent', {
      type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1,
    });
    await mouse('mousePressed', points[0]);
    await mouse('mouseMoved', { x: points[0].x + 5, y: points[0].y });
    check('模型滑块轻微抖动不会提前切换', await page.evaluate(`
      window.__itDebug.state.model.text === 'index-mt-2b' &&
      !document.getElementById('model-text').classList.contains('is-dragging')`));
    await mouse('mouseMoved', { x: points[0].x + 12, y: points[0].y });
    check('模型滑块开始拖动后跟随指针且未越阈值时保留当前项', await page.evaluate(`(() => {
      const box = document.getElementById('model-text');
      const thumb = box.querySelector('.models-thumb');
      const active = box.querySelector('button.on');
      const x = new DOMMatrixReadOnly(getComputedStyle(thumb).transform).m41;
      return box.classList.contains('is-dragging') && window.__itDebug.state.model.text === 'index-mt-2b' &&
        x > active.offsetLeft + 6;
    })()`));
    await mouse('mouseMoved', points[1]);
    check('鼠标尚未松开时越过阈值已切到9B', await page.evaluate(`
      window.__itDebug.state.model.text === 'index-mt-9b'`));
    await mouse('mouseMoved', points[2]);
    check('模型滑块同次拖动可继续切到35B', await page.evaluate(`
      window.__itDebug.state.model.text === 'index-mt-35b'`));
    await mouse('mouseMoved', points[1]);
    await mouse('mouseReleased', points[1]);
    await pause(450);
    check('反向拖动松开后选择持久化且滑块归位', await page.evaluate(`(() => {
      const box = document.getElementById('model-text');
      const active = box.querySelector('button.on');
      const x = new DOMMatrixReadOnly(getComputedStyle(box.querySelector('.models-thumb')).transform).m41;
      return window.__itDebug.state.model.text === 'index-mt-9b' &&
        JSON.parse(localStorage.getItem('it-state')).model.text === 'index-mt-9b' &&
        !box.classList.contains('is-dragging') && Math.abs(x - active.offsetLeft) < .75;
    })()`));
    await page.click('#model-text [data-model="index-mt-2b"]');
    check('拖动后普通模型点击仍可用', await page.evaluate(`
      window.__itDebug.state.model.text === 'index-mt-2b'`));
  });

  await scenario('触屏拖动底栏实时切页与取消', async () => {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    let activeTouch = false;
    try {
      await selectTab(page, 'text');
      const points = await page.evaluate(`(() => [...document.querySelectorAll('.tabs button[data-tab]')].map((button) => {
        const rect = button.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }))()`);
      const touch = async (type, point) => {
        await page.send('Input.dispatchTouchEvent', {
          type, touchPoints: point ? [{ x: point.x, y: point.y, id: 1 }] : [],
        });
        activeTouch = type !== 'touchCancel' && type !== 'touchEnd';
        await page.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      };
      await touch('touchStart', points[0]);
      await touch('touchMove', points[1]);
      check('手指尚未抬起时底栏已切到音节页', await page.evaluate(`
        window.__itDebug.state.tab === 'syllable' &&
        document.getElementById('pane-text').inert`));
      await touch('touchMove', points[2]);
      check('底栏同次拖动可继续切到长文页', await page.evaluate(`
        window.__itDebug.state.tab === 'doc'`));
      await touch('touchMove', points[0]);
      await touch('touchCancel');
      await settle(page, 'text');
      check('触屏取消后保留最后选择且释放拖动状态', await page.evaluate(`(() => {
        const box = document.querySelector('.tabs');
        const active = box.querySelector('button.on[data-tab]');
        const x = new DOMMatrixReadOnly(getComputedStyle(box.querySelector('.tabs-thumb')).transform).m41;
        return window.__itDebug.state.tab === 'text' && !box.classList.contains('is-dragging') &&
          Math.abs(x - active.offsetLeft) < .75;
      })()`));
    } finally {
      if (activeTouch) await page.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 1180, height: 900, deviceScaleFactor: 1, mobile: false,
      });
      await selectTab(page, 'text');
    }
  });

  await scenario('关闭动效时桌面标签仍可拖动', async () => {
    await page.evaluate(`window.__itDebug.preferences.apply(
      window.__itDebug.preferences.normalize({ appearance: { motion: 'off' } }))`);
    try {
      await selectTab(page, 'text');
      const points = await page.evaluate(`(() => [...document.querySelectorAll('.tabs button[data-tab]')].map((button) => {
        const rect = button.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }))()`);
      await page.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', ...points[0], button: 'left', buttons: 1, clickCount: 1,
      });
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', ...points[2], button: 'none', buttons: 1,
      });
      check('关闭动效时鼠标拖动立即切换桌面标签且无页面动画', await page.evaluate(`
        window.__itDebug.state.tab === 'doc' && ${finitePaneAnimations} === 0`));
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: 1170, y: points[2].y, button: 'left', buttons: 0, clickCount: 1,
      });
      check('在标签外松开仍释放捕获并保留已切页面', await page.evaluate(`
        window.__itDebug.state.tab === 'doc' && !document.querySelector('.tabs').classList.contains('is-dragging')`));
      await page.key('ArrowLeft');
      check('拖动后方向键从当前标签继续切换', await page.evaluate(`
        window.__itDebug.state.tab === 'syllable' &&
        document.activeElement.getAttribute('data-tab') === 'syllable'`));
    } finally {
      await page.evaluate(`window.__itDebug.preferences.apply(window.__itDebug.preferences.defaults)`);
      await selectTab(page, 'text');
    }
  });

  await scenario('Windows 悬浮窗原生桥接源码一致性', async () => {
    const popupSource = await readFile('desktop/patch/setup.rs', 'utf8');
    check('流式动效读取新的悬浮窗偏好对象', popupSource.includes(
      'activePopupPreferences.appearance.motion') && !popupSource.includes('activePopupAppearance'));
    check('悬浮窗剪贴板与字体命令具有独立窗口校验',
      popupSource.includes('window.label() != POPUP_LABEL') &&
      popupSource.includes('window.label() != APP_WINDOW_LABEL'));
  });

  await scenario('液态玻璃参数驱动真实折射', async () => {
    const result = await page.evaluate(`(() => {
      const card = document.querySelector('#langbar .sel-btn');
      const filterUrl = window.__glassStyle(card).backdropFilter || window.__glassStyle(card).webkitBackdropFilter;
      const filterId = (filterUrl.match(/url\\(["']?#([^"')]+)["']?\\)/) || [])[1];
      const filter = filterId && document.getElementById(filterId);
      const map = filter?.querySelector('feImage[href^="data:image/png"]');
      const config = window.ItLiquidGlass.normalize({});
      const controls = [...document.querySelectorAll('[data-pref^="liquidGlass."]')]
        .map((control) => control.dataset.pref);
      return {
        engine: typeof window.ItLiquidGlass,
        state: card.dataset.itLiquidState,
        filterId,
        primitiveUnits: filter?.getAttribute('primitiveUnits'),
        displacement: !!filter?.querySelector('feDisplacementMap'),
        refractionMap: !!map && Number(map.getAttribute('width')) > 4 && Number(map.getAttribute('height')) > 4,
        specular: !!filter?.querySelector('feComposite[in="displaced-saturated"][in2="specular-map"]') &&
          [...(filter?.querySelectorAll('feBlend') || [])]
            .every((blend) => blend.getAttribute('mode') === 'normal'),
        blur: !!filter?.querySelector('feGaussianBlur'),
        noProgressiveBlur: card.querySelectorAll(':scope > [data-it-liquid-progressive]').length === 0 &&
          !filter?.querySelector('[result^="progressive-blur"]'),
        controls,
        config
      };
    })()`);
    check('每个玻璃表面直接使用SVG折射滤镜与按尺寸生成的位移图',
      result.engine === 'object' && result.state === 'ready' && !!result.filterId &&
        result.primitiveUnits === 'userSpaceOnUse' && result.displacement && result.refractionMap,
      JSON.stringify(result));
    check('磨砂面板仅显示不透明度并保留历史参数兼容', result.controls.length === 1 &&
      result.controls[0] === 'liquidGlass.card.backgroundOpacity' &&
      Object.keys(result.config).join(',') === 'card,pill,button' &&
      result.config.card.specularOpacity === 40 && result.config.card.specularSaturation === 6 &&
      result.config.card.refractionLevel === 100 && result.config.card.blurLevel === 1 &&
      result.config.card.progressiveBlurStrength === 1 && result.config.card.backgroundOpacity === 60,
      JSON.stringify(result.controls));
    check('按钮保留SVG高光和折射且无大面积渐进模糊', result.specular && result.blur && result.noProgressiveBlur,
      JSON.stringify({ specular: result.specular, blur: result.blur, noProgressiveBlur: result.noProgressiveBlur }));
    check('内容卡片采用静态磨砂且不挂载光学滤镜', await page.evaluate(`(() => {
      const card = document.querySelector('#pane-text .card');
      const rim = getComputedStyle(card, '::after');
      return !rim.backgroundImage.includes('conic-gradient') &&
        ItLiquidGlass.stateOf(card) === null &&
        !card.querySelector(':scope > [data-it-liquid-background], :scope > [data-it-liquid-progressive]') &&
        getComputedStyle(card).backdropFilter === 'none' &&
        getComputedStyle(card).backgroundImage.includes('repeating-linear-gradient') &&
        !document.documentElement.hasAttribute('data-it-material') &&
        !document.documentElement.classList.contains('no-lg-blur');
    })()`));
    check('光学挂载仅用于交互轨道、滑块和按钮', await page.evaluate(`(() => {
      const engine = window.ItLiquidGlass;
      if (!engine || typeof engine.stateOf !== 'function') return false;
      return [['.tabs', 'button'], ['.tabs-thumb', 'pill'], ['.btn-secondary', 'button']].every(([selector, preset]) => {
        const element = document.querySelector(selector);
        const state = element && engine.stateOf(element);
        return element?.dataset.itLiquidPreset === preset && state?.presetName === preset;
      });
    })()`));
    check('Tab轨道使用透明按钮玻璃且滑块保留折射', await page.evaluate(`(() => {
      const track = document.querySelector('.tabs');
      const thumb = document.querySelector('.tabs-thumb');
      const fill = window.__glassStyle(track).backgroundColor;
      return window.__glassStyle(track).backdropFilter.includes('url(') &&
        fill.startsWith('rgba(') && Number(fill.split(',').at(-1).replace(')', '').trim()) === 0 &&
        window.__glassStyle(thumb).backdropFilter.includes('url(');
    })()`));
    check('旧玻璃设置迁移为新默认值且保留无关偏好', await page.evaluate(`(() => {
      const api = window.__itDebug.preferences;
      const old = api.normalize({ version: 1,
        appearance: { material: 'solid', glassStrength: 0, cardReveal: 100, fontWeight: 600 },
        popup: { cardReveal: 100, backgroundData: 'data:image/png;base64,AA==' },
        background: { opacity: 28 } });
      return old.version === 3 && old.appearance.material === undefined &&
        old.appearance.glassStrength === undefined && old.appearance.cardReveal === undefined &&
        old.popup.cardReveal === undefined && old.appearance.fontWeight === 600 &&
        old.background.opacity === 28 && old.liquidGlass.card.refractionLevel === 100 &&
        old.popup.backgroundData === 'data:image/png;base64,AA==';
    })()`));
    check('第二版扁平玻璃配置清除后恢复分元素预设', await page.evaluate(`(() => {
      const old = window.__itDebug.preferences.normalize({ version: 2,
        appearance: { fontWeight: 500 }, background: { opacity: 25 },
        liquidGlass: { surfaceProfile: 'lip', bezelWidth: 22, glassThickness: 35,
          refractiveIndex: 2, specularOpacity: 95, specularSaturation: 10,
          refractionLevel: 175, blurLevel: 90, progressiveBlurStrength: 80, backgroundOpacity: 15 }
      });
      const defaults = window.ItLiquidGlass.defaults;
      return old.version === 3 && JSON.stringify(old.liquidGlass) === JSON.stringify(defaults) &&
        old.appearance.fontWeight === 500 && old.background.opacity === 25 &&
        !('surfaceProfile' in old.liquidGlass) && !('bezelWidth' in old.liquidGlass);
    })()`));

    await page.evaluate(`(() => {
      const contrast = document.createElement('style');
      contrast.id = 'liquid-glass-contrast-test';
      // Narrow optical bands need several background edges inside their few
      // pixel displacement range; keep the pixel-change threshold unchanged.
      contrast.textContent = 'body::before{background:repeating-linear-gradient(90deg,#ff1744 0 6px,#1e40ff 6px 12px,#ffe600 12px 18px,#00bd72 18px 24px)!important;animation:none!important}body::after{display:none!important}';
      document.head.appendChild(contrast);
      window.__itDebug.preferences.apply(window.__itDebug.preferences.normalize({
        version: 3,
        liquidGlass: { card: { backgroundOpacity: 0 }, button: { refractionLevel: 0,
          specularOpacity: 0, specularSaturation: 1 } }
      }));
    })()`);
    await page.until(`document.querySelector('#langbar .sel-btn')?.dataset.itLiquidState === 'ready'`);
    await pause(100);
    const unbentScreenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile('output/preview-liquid-glass-no-refraction.png', Buffer.from(unbentScreenshot.data, 'base64'));
    await page.evaluate(`window.__itDebug.preferences.apply(window.__itDebug.preferences.normalize({
      version: 3,
      liquidGlass: { card: { backgroundOpacity: 0 }, button: { refractionLevel: 100,
        specularOpacity: 0, specularSaturation: 1 } }
    }))`);
    await pause(100);
    const refractedScreenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile('output/preview-liquid-glass-refraction.png', Buffer.from(refractedScreenshot.data, 'base64'));
    const delta = await page.evaluate(`(async (offData, onData) => {
      const load = (data) => new Promise((resolve, reject) => {
        const image = new Image(); image.onload = () => resolve(image); image.onerror = reject;
        image.src = 'data:image/png;base64,' + data;
      });
      const [off, on] = await Promise.all([load(${JSON.stringify(unbentScreenshot.data)}), load(${JSON.stringify(refractedScreenshot.data)})]);
      const canvas = document.createElement('canvas'); canvas.width = on.width; canvas.height = on.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const read = (image) => { context.drawImage(image, 0, 0); return context.getImageData(0, 0, canvas.width, canvas.height).data; };
      const a = read(off), b = read(on), cards = [...document.querySelectorAll('.sel-btn, .btn-secondary')].map((node) => {
        const rect = node.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      });
      let changed = 0, maxDelta = 0;
      for (const card of cards) for (let y = Math.max(0, Math.floor(card.top)); y < Math.min(canvas.height, Math.ceil(card.bottom)); y++) {
        for (let x = Math.max(0, Math.floor(card.left)); x < Math.min(canvas.width, Math.ceil(card.right)); x++) {
          if (x - card.left > 32 && card.right - x > 32 && y - card.top > 32 && card.bottom - y > 32) continue;
          const i = (y * canvas.width + x) * 4;
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
          if (d > 8) changed++;
          maxDelta = Math.max(maxDelta, d);
        }
      }
      return { changed, maxDelta };
    })(${JSON.stringify(unbentScreenshot.data)}, ${JSON.stringify(refractedScreenshot.data)})`);
    check('开启折射参数会在交互按钮改变背景像素', delta.changed > 100 && delta.maxDelta > 12,
      JSON.stringify(delta));
    await page.evaluate(`(() => {
      document.getElementById('liquid-glass-contrast-test')?.remove();
      window.__itDebug.preferences.apply(window.__itDebug.preferences.defaults);
    })()`);
  });

  await scenario('入场时仍可切换模型', async () => {
    await selectTab(page, 'text');
    const motion = await page.evaluate(`(async () => {
      document.querySelector('[data-tab="syllable"]').click();
      await new Promise((resolve) => setTimeout(resolve, 70));
      const box = document.getElementById('model-syllable');
      const thumb = box.querySelector('.models-thumb');
      const button = box.querySelector('[data-model="index-mt-9b-syllable"]');
      const x = () => {
        const transform = getComputedStyle(thumb).transform;
        return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41;
      };
      const start = x(), target = button.offsetLeft;
      button.click();
      const values = [x()];
      for (let index = 0; index < 90; index++) {
        await new Promise(requestAnimationFrame);
        values.push(x());
        if (index > 2 && ${finitePaneAnimations} === 0) break;
      }
      return { start, target, values, final: x(),
        selected: button.classList.contains('on'),
        model: window.__itDebug.state.model.syllable };
    })()`);
    const distance = motion.target - motion.start;
    const advanced = motion.values.findIndex((x) => x >= motion.start + distance * .25);
    check('入场70ms选择9B后模型和滑块最终一致',
      distance > 1 && motion.selected && motion.model === 'index-mt-9b-syllable' &&
      Math.abs(motion.final - motion.target) < .75, JSON.stringify(motion));
    check('入场模型滑块前进后全程不退回旧选项',
      advanced >= 0 && motion.values.every((x) => x >= motion.start - .75) &&
      motion.values.slice(advanced).every((x) =>
        x > motion.start + distance * .15));
    await settle(page, 'syllable');
  });

  await scenario('快速切换与焦点交接', async () => {
    await selectTab(page, 'text');
    const isolated = await page.evaluate(`(async () => {
      document.getElementById('src').focus();
      const isolated = [];
      for (const tab of ['syllable', 'doc', 'text']) {
        const previous = document.querySelector('.pane[aria-hidden="false"]');
        document.querySelector('[data-tab="' + tab + '"]').click();
        previous.querySelector('.src').focus();
        isolated.push(!previous.contains(document.activeElement));
        await new Promise((resolve) => setTimeout(resolve, 70));
      }
      return isolated;
    })()`);
    check('快速切换每次都立即隔离离场页焦点', isolated.every(Boolean));
    await settle(page, 'text');
    check('快速切换最终仅目标页面可交互且无残留动画',
      await page.evaluate(`(() => {
        const panes = [...document.querySelectorAll('.pane')];
        return panes.every((pane) => pane.id === 'pane-text' ?
          !pane.inert && pane.getAttribute('aria-hidden') === 'false' :
          pane.inert && pane.getAttribute('aria-hidden') === 'true') &&
          ${finitePaneAnimations} === 0;
      })()`));
    check('退场页面无法再次取得焦点',
      await page.evaluate(`(() => {
        document.getElementById('syl-src').focus();
        return !document.getElementById('pane-syllable').contains(document.activeElement);
      })()`));
    await page.click('#src');
    check('最终原文输入框可通过真实点击编辑',
      await page.evaluate(`document.activeElement.id === 'src'`));
    await page.evaluate(`document.activeElement.blur()`);
  });

  await scenario('翻译要求支持中途反转', async () => {
    const reversal = await page.evaluate(`(async () => {
      const box = document.getElementById('instruct-box');
      const body = document.getElementById('instruct-body');
      const summary = box.querySelector('summary');
      summary.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const deadline = performance.now() + 1500;
      while (body.getBoundingClientRect().height === 0 && performance.now() < deadline) {
        await new Promise(requestAnimationFrame);
      }
      const before = body.getBoundingClientRect().height;
      summary.click();
      const after = body.getBoundingClientRect().height;
      return { before, after };
    })()`);
    check('要求反转从当前高度接续', reversal.before > 0 &&
      Math.abs(reversal.before - reversal.after) < 2, JSON.stringify(reversal));
    await page.until(`!document.getElementById('instruct-box').open`);
    await page.click('#instruct-box summary');
    await page.until(`document.getElementById('instruct-body').getBoundingClientRect().height > 40`);
    check('反转收起后仍可再次展开',
      await page.evaluate(`document.getElementById('instruct-box').open`));
    await page.evaluate(`document.querySelector('#instruct-box summary').click()`);
    await page.until(`!document.getElementById('instruct-box').open`);
  });

  await scenario('图片进出可连续反转', async () => {
    const expected = await page.evaluate(`(async () => {
      const image = (color, width) => {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = 72;
        const context = canvas.getContext('2d');
        context.fillStyle = color; context.fillRect(0, 0, width, 72);
        return canvas.toDataURL();
      };
      const first = image('#e28ba6', 160), second = image('#9a9be6', 240);
      window.__itDebug.setImage(first);
      await new Promise((resolve) => setTimeout(resolve, 80));
      window.__itDebug.setImage(null);
      await new Promise((resolve) => setTimeout(resolve, 80));
      window.__itDebug.setImage(second);
      return second;
    })()`);
    await page.until(`document.getElementById('img-thumb').complete &&
      document.getElementById('img-thumb').naturalWidth === 240 &&
      document.getElementById('img-preview').getBoundingClientRect().height > 20 &&
      ${finitePaneAnimations} === 0`);
    check('移除中重新设置图片保留最终图片', await page.evaluate(
      `document.getElementById('img-thumb').src === ${JSON.stringify(expected)} &&
       window.__itDebug.state.image === ${JSON.stringify(expected)}`));
    const heights = await page.evaluate(`(async () => {
      const box = document.getElementById('img-preview');
      const first = box.getBoundingClientRect().height;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return [first, box.getBoundingClientRect().height];
    })()`);
    check('图片落定后布局稳定', Math.abs(heights[0] - heights[1]) < .75);
    await page.evaluate(`window.__itDebug.setImage(null)`);
    await page.until(`document.getElementById('img-preview').getBoundingClientRect().height === 0`);
  });

  await scenario('语言轮盘保留列表顺序', async () => {
    async function sampleWheel(index) {
      return page.evaluate(`(async () => {
        document.querySelector('.sel-pop[aria-hidden="false"]')
          .querySelectorAll('.sel-item')[${index}].click();
        const reel = document.querySelector('#langbar .sel-reel');
        const labels = [...reel.children].map((row) => row.textContent);
        const animation = reel.getAnimations().find((candidate) =>
          candidate.transitionProperty === 'transform');
        if (!animation) throw new Error('Selecting a different language must start a reel transition.');
        const duration = Number(animation.effect.getTiming().duration);
        if (!Number.isFinite(duration) || duration <= 0) {
          throw new Error('The reel transition needs a finite positive duration.');
        }
        animation.pause();
        animation.currentTime = duration * .2;
        const first = new DOMMatrixReadOnly(getComputedStyle(reel).transform).m42;
        animation.currentTime = duration * .6;
        const second = new DOMMatrixReadOnly(getComputedStyle(reel).transform).m42;
        animation.play();
        await animation.finished;
        return { labels, first, second, value: document.getElementById('src-lang').value };
      })()`);
    }

    await page.click('#langbar .sel-btn');
    const rows = await page.evaluate(`[...document.querySelector('.sel-pop[aria-hidden="false"]')
      .querySelectorAll('.sel-item')].slice(0, 7).map((row) => ({
        value: row.dataset.value, label: row.textContent
      }))`);
    if (rows.length < 7) throw new Error('Source language list needs at least seven options.');
    await page.evaluate(`(async () => {
      document.querySelector('.sel-pop[aria-hidden="false"] .sel-item').click();
      const animation = document.querySelector('#langbar .sel-reel').getAnimations()
        .find((candidate) => candidate.transitionProperty === 'transform');
      if (animation) await animation.finished;
    })()`);
    await page.click('#langbar .sel-btn');
    const wheel = await sampleWheel(6);
    check('轮盘逐项经过语言列表且朝正确方向滚动',
      JSON.stringify(wheel.labels) === JSON.stringify(rows.map((row) => row.label)) &&
      wheel.second < wheel.first - 1, JSON.stringify(wheel));
    check('轮盘最终语言与所选项一致', wheel.value === rows[6].value);
    await page.click('#langbar .sel-btn');
    const reverse = await sampleWheel(0);
    check('反向选择沿同一列表回滚',
      reverse.second > reverse.first + 1 && reverse.value === rows[0].value &&
      JSON.stringify(reverse.labels) === JSON.stringify(rows.map((row) => row.label)),
      JSON.stringify(reverse));
  });

  await scenario('弹层支持键盘与系统返回', async () => {
    check('软件提供统一系统返回入口',
      await page.evaluate(`typeof window.__itHandleBack === 'function'`));
    await menus(page);
  });

  await scenario('弹层与要求按当前模式处理返回', async () => {
    await selectTab(page, 'text');
    await page.click('#instruct-box summary');
    await page.until(`document.getElementById('instruct-body').getBoundingClientRect().height > 40`);
    await selectTab(page, 'syllable');
    check('隐藏文本页的要求不消费音节页返回',
      await page.evaluate(`window.__itHandleBack() === false &&
        document.getElementById('instruct-box').open &&
        window.__itDebug.state.tab === 'syllable'`));
    await page.click('#pane-syllable .sel-btn');
    const modeDropdown = await page.evaluate(`(() => {
      const popup = document.querySelector('.sel-pop[aria-hidden="false"]');
      if (!popup) return false;
      popup.querySelector('.sel-item').focus();
      return popup.contains(document.activeElement);
    })()`);
    check('模式内语言列表可取得焦点', modeDropdown);
    await page.evaluate(`document.querySelector('[data-tab="doc"]').click()`);
    check('带焦点的模式下拉在切换时关闭且交接到目标标签',
      await page.evaluate(`!document.querySelector('.sel-pop[aria-hidden="false"]') &&
        document.activeElement.id === 'tab-doc' &&
        document.getElementById('pane-syllable').inert`));
    await settle(page, 'doc');
    await selectTab(page, 'text');
    await page.click('#instruct-box summary');
    await page.until(`!document.getElementById('instruct-box').open`);
  });

  await scenario('resize 与系统减少动态效果可收束', async () => {
    await selectTab(page, 'text');
    await page.evaluate(`document.querySelector('[data-tab="doc"]').click()`);
    await pause(60);
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 900, height: 740, deviceScaleFactor: 1, mobile: false,
    });
    await settle(page, 'doc');
    check('切换中 resize 后目标布局与动画正常收束',
      await page.evaluate(`document.querySelector('#pane-doc .card').getBoundingClientRect().width > 100 &&
        ${finitePaneAnimations} === 0`));
    await page.evaluate(`document.querySelector('[data-tab="text"]').click()`);
    await pause(60);
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await pause(60);
    check('动态开启减少动态效果立即结束页面动画',
      await page.evaluate(`${finitePaneAnimations} === 0`));
    await settle(page, 'text');
    await page.evaluate(`document.querySelector('[data-tab="syllable"]').click()`);
    check('减少动态效果时直接呈现最终页面',
      await page.evaluate(`document.getElementById('pane-syllable').getAttribute('aria-hidden') === 'false' &&
        ${finitePaneAnimations} === 0`));
    await page.send('Emulation.setEmulatedMedia', { features: [] });
  });

  for (const [width, height] of [[390, 844], [360, 640]]) {
    await scenario(`${width}×${height} 手机安全区与可操作性`, async () => {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: true,
      });
      await selectTab(page, 'text');
      await pause(80);
      const layout = await page.evaluate(`(() => {
        const nav = document.querySelector('.tabs').getBoundingClientRect();
        const dock = document.querySelector('.dock.on').getBoundingClientRect();
        const touch = Math.min(...[...document.querySelectorAll('.tabs button')]
          .map((button) => button.getBoundingClientRect().height));
        const focusRects = ['#pane-text', '.mobile-navigation'].map((selector) => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height];
        });
        return { navBottom: nav.bottom, navTop: nav.top, dockBottom: dock.bottom,
          touch, width: innerWidth, height: innerHeight, focusRects };
      })()`);
      check(`${width}×${height} 导航触控与安全区`,
        layout.touch >= 48 && layout.navBottom <= height &&
        layout.dockBottom <= layout.navTop - 4, JSON.stringify(layout));
      await page.click('#src');
      const focusedLayout = await page.evaluate(`(() => {
        const focusRects = ['#pane-text', '.mobile-navigation'].map((selector) => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height];
        });
        return { focused: document.activeElement.id === 'src', focusRects };
      })()`);
      check(`${width}×${height} 输入焦点保持页面与底栏尺寸位置`,
        focusedLayout.focused && focusedLayout.focusRects.every((rect, index) =>
          rect.every((value, edge) => Math.abs(value - layout.focusRects[index][edge]) < .25)),
        JSON.stringify(focusedLayout));
      await page.evaluate(`document.getElementById('src').blur()`);
      await page.until(`document.querySelector('.tabs').getClientRects().length > 0`);
      await page.evaluate(`document.getElementById('out-text').textContent = '离线验证译文'`);
      const copiedBefore = await page.evaluate(`window.__motionTest.copied.length`);
      await page.click('#btn-copy');
      check(`${width}×${height} 卡内复制按钮可真实点中`,
        await page.evaluate(`window.__motionTest.copied.length === ${copiedBefore + 1} &&
          window.__motionTest.copied.at(-1) === '离线验证译文'`));
      await page.click('[data-tab="doc"]');
      await settle(page, 'doc');
      await page.click('[data-tab="text"]');
      await settle(page, 'text');
      check(`${width}×${height} 导航按钮通过真实点击切换`,
        await page.evaluate(`window.__itDebug.state.tab === 'text'`));
      if (width === 390) {
        await page.evaluate(`document.documentElement.style.setProperty('--it-safe-top', '24px');
          document.documentElement.style.setProperty('--it-safe-bottom', '16px')`);
        check('手机设置入口与模式胶囊分开并避让安全区', await page.evaluate(`(() => {
          const gear = document.getElementById('mobile-settings').getBoundingClientRect();
          const tabs = document.querySelector('.tabs').getBoundingClientRect();
          return getComputedStyle(document.getElementById('brand')).display === 'none' &&
            document.getElementById('appbar').getBoundingClientRect().height === 0 &&
            gear.width >= 48 && gear.height >= 48 && gear.left >= tabs.right + 6 &&
            gear.bottom <= innerHeight - 16 &&
            document.getElementById('langbar').getBoundingClientRect().top >= 24;
        })()`));
        check('手机按钮默认触摸高亮透明并保留文本选择样式', await page.evaluate(`(() => {
          return ['mobile-settings', 'btn-go', 'btn-copy'].every((id) =>
            getComputedStyle(document.getElementById(id)).webkitTapHighlightColor === 'rgba(0, 0, 0, 0)') &&
            getComputedStyle(document.getElementById('src'), '::selection').backgroundColor !== 'rgba(0, 0, 0, 0)';
        })()`));
        await page.evaluate(`document.getElementById('toast').classList.remove('on')`);
        await page.until(`getComputedStyle(document.getElementById('toast')).opacity === '0'`);
        const mobileMain = await page.send('Page.captureScreenshot', { format: 'png' });
        await writeFile('output/preview-touch-mobile-main.png', Buffer.from(mobileMain.data, 'base64'));
        await openMenu(page);
        await page.until(`document.getElementById('more-menu').getAnimations().length === 0`);
        check('手机齿轮在底栏上方打开菜单', await page.evaluate(`(() => {
          const menu = document.getElementById('more-menu');
          const gear = document.getElementById('mobile-settings');
          return gear.getAttribute('aria-expanded') === 'true' && menu.classList.contains('on') &&
            menu.getBoundingClientRect().bottom <= gear.getBoundingClientRect().top - 4;
        })()`));
        await page.until(`document.getElementById('more-menu').getAnimations().length === 0`);
        const mobileMenu = await page.send('Page.captureScreenshot', { format: 'png' });
        await writeFile('output/preview-touch-mobile-menu.png', Buffer.from(mobileMenu.data, 'base64'));
        await page.click('#more-menu [data-act="about"]');
        await page.until(`document.querySelector('.it-about-mask').getAttribute('aria-hidden') === 'false'`);
        await page.key('Escape');
        check('手机关于页关闭后焦点返回齿轮', await page.evaluate(`
          document.activeElement.id === 'mobile-settings'`));
        await openMenu(page);
        await page.click('#more-menu [data-act="settings"]');
        await page.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'false'`);
        await page.until(`document.querySelector('.it-set').getAnimations().length === 0`);
        const mobileControlHeights = await page.evaluate(`(() => {
          const controls = [
            ...document.querySelectorAll('.it-set-nav button'),
            ...document.querySelectorAll('.it-set-row'),
            ...document.querySelectorAll('.it-set-foot button')
          ].filter((control) => control.getClientRects().length > 0);
          return controls.map((control) => ({
            label: control.textContent.trim().slice(0, 24), height: control.getBoundingClientRect().height
          }));
        })()`);
        check('手机设置导航、选项和底栏按钮均达到48px触控高度',
          mobileControlHeights.length > 0 && mobileControlHeights.every((control) => control.height >= 48),
          JSON.stringify(mobileControlHeights));
        await selectSettingsSection(page, 'reading');
        check('手机设置横向滑块对齐且PC字体控件不显示', await page.evaluate(`(() => {
          const tab = document.querySelector('[data-pref-tab="reading"]').getBoundingClientRect();
          const thumb = document.querySelector('.it-set-nav-thumb').getBoundingClientRect();
          return Math.abs(tab.x - thumb.x) < 1 && Math.abs(tab.y - thumb.y) < 1 &&
            getComputedStyle(document.getElementById('it-pref-font-family-row')).display === 'none' &&
            getComputedStyle(document.getElementById('it-pref-font-status')).display === 'none' &&
            document.querySelector('.it-set-body').scrollWidth <= document.querySelector('.it-set-body').clientWidth;
        })()`));
        const mobileSettings = await page.send('Page.captureScreenshot', { format: 'png' });
        await writeFile('output/preview-settings-polish-mobile.png', Buffer.from(mobileSettings.data, 'base64'));
        await page.key('Escape');
        await page.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'true'`);
        check('手机设置关闭后焦点返回齿轮', await page.evaluate(`
          document.activeElement.id === 'mobile-settings'`));
        await page.evaluate(`document.documentElement.style.removeProperty('--it-safe-top');
          document.documentElement.style.removeProperty('--it-safe-bottom')`);
      }
    });
  }

  await scenario('文本滚动条适配主题', async () => {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1180, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await selectTab(page, 'text');
    await page.evaluate(`(() => {
      document.getElementById('src').value = '原文内容较多时，滚动条仍保持轻盈清晰。\\n'.repeat(120);
      const out = document.getElementById('out-text');
      out.textContent = '译文内容较多时，轨道透明，圆角滑块与主题一致。\\n'.repeat(120);
      out.classList.remove('empty');
    })()`);
    const thumbColors = [];
    for (const mode of ['light', 'dark']) {
      await page.evaluate(`window.__itDebug.preferences.apply(
        window.__itDebug.preferences.normalize({ appearance: { mode: '${mode}' } }))`);
      check(`${mode} 原文与译文使用透明轨道且移除滚动箭头`, await page.evaluate(`(() => {
        return ['src', 'out-text'].every((id) => {
          const node = document.getElementById(id);
          const bar = getComputedStyle(node, '::-webkit-scrollbar');
          const thumb = getComputedStyle(node, '::-webkit-scrollbar-thumb');
          const track = getComputedStyle(node, '::-webkit-scrollbar-track');
          const buttons = getComputedStyle(node, '::-webkit-scrollbar-button');
          return node.scrollHeight > node.clientHeight && bar.width === '8px' &&
            thumb.borderRadius === '99px' && track.backgroundColor === 'rgba(0, 0, 0, 0)' &&
            buttons.display === 'none';
        });
      })()`));
      thumbColors.push(await page.evaluate(`getComputedStyle(document.getElementById('src'),
        '::-webkit-scrollbar-thumb').backgroundColor`));
      const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(`output/preview-touch-scrollbar-${mode}.png`, Buffer.from(screenshot.data, 'base64'));
    }
    check('滚动条颜色随浅深主题变化', thumbColors[0] !== thumbColors[1]);
    await page.evaluate(`(() => {
      window.__itDebug.preferences.apply(window.__itDebug.preferences.defaults);
      document.getElementById('src').value = '';
      document.getElementById('out-text').textContent = '';
    })()`);
  });

  await scenario('通用偏好实时应用与持久化', async () => {
    check('文本2B模型显示名称简化为2B且模型标识不变', await page.evaluate(`(() => {
      const model = document.querySelector('#model-text [data-model="index-mt-2b"]');
      return model?.textContent.trim() === '2B';
    })()`));
    check('偏好配置公开可测试的归一化入口', await page.evaluate(`
      !!window.__itDebug.preferences &&
      typeof window.__itDebug.preferences.normalize === 'function'`));
    check('偏好默认值使用新液态玻璃参数组', await page.evaluate(`(() => {
      const defaults = window.__itDebug.preferences?.normalize({});
      return defaults?.appearance?.mode === 'light' &&
        defaults?.appearance?.palette === 'sakura' &&
        defaults?.version === 3 &&
        defaults?.appearance?.fontWeight === 400 &&
        defaults?.appearance?.fontColorMode === 'theme' &&
        defaults?.liquidGlass?.card?.refractionLevel === 100 &&
        defaults?.liquidGlass?.card?.specularOpacity === 40 && defaults?.liquidGlass?.card?.specularSaturation === 6 &&
        defaults?.liquidGlass?.card?.blurLevel === 1 && defaults?.liquidGlass?.card?.progressiveBlurStrength === 1 &&
        defaults?.liquidGlass?.card?.backgroundOpacity === 60 &&
        defaults?.liquidGlass?.pill?.specularOpacity === 50 && defaults?.liquidGlass?.pill?.specularSaturation === 6 &&
        defaults?.liquidGlass?.pill?.refractionLevel === 100 && defaults?.liquidGlass?.pill?.blurLevel === 0.2 &&
        defaults?.liquidGlass?.button?.specularOpacity === 50 && defaults?.liquidGlass?.button?.specularSaturation === 9 &&
        defaults?.liquidGlass?.button?.refractionLevel === 100 &&
        defaults?.popup?.cardReveal === undefined && defaults?.popup?.backgroundData === '' &&
        defaults?.translation?.defaultTab === 'text';
    })()`));
    // Start from an actually persisted image. A debug-only appearance preview
    // must not inherit a previous scenario's last-persisted settings snapshot.
    await page.evaluate(`(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2;
      const context = canvas.getContext('2d');
      context.fillStyle = '#5372a2';
      context.fillRect(0, 0, 2, 2);
      const saved = window.__itDebug.preferences.normalize({
        background: { data: canvas.toDataURL('image/png') }
      });
      localStorage.setItem('it-preferences', JSON.stringify(saved));
    })()`);
    await page.send('Page.reload');
    await page.until(`document.readyState === 'complete' && !!window.__itDebug`);
    await openMenu(page);
    await page.click('#more-menu [data-act="settings"]');
    await page.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'false'`);
    await selectSettingsSection(page, 'background');
    check('恢复背景前确有已持久化的图片且控件已呈现', await page.evaluate(`(() => {
      const saved = JSON.parse(localStorage.getItem('it-preferences'));
      const reset = document.getElementById('it-pref-reset-background');
      return saved.background.data.startsWith('data:image/png;base64,') &&
        !!document.getElementById('it-bg-style') &&
        document.getElementById('it-pref-background-status').textContent === '已选择背景图片。' &&
        !reset.disabled && reset.getClientRects().length > 0;
    })()`));
    await page.click('#it-pref-reset-background');
    const backgroundResetState = await page.evaluate(`(() => ({
      status: document.getElementById('it-pref-background-status').textContent,
      style: !!document.getElementById('it-bg-style'),
      data: window.__itDebug.preferences.normalize({}).background.data
    }))()`);
    check('恢复默认背景立即清除并保存',
      backgroundResetState.status === '未选择背景图片。' && !backgroundResetState.style,
      JSON.stringify(backgroundResetState));
    await page.key('Escape');
    await page.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'true'`);
    check('关闭设置保留已应用的背景恢复', await page.evaluate(`!document.getElementById('it-bg-style') &&
      JSON.parse(localStorage.getItem('it-preferences')).background.data === ''`));
    await page.evaluate(`window.__itDebug.preferences.apply(window.__itDebug.preferences.defaults)`);
    const nativeSnapshotCheck = await page.evaluate(`(() => {
      const api = window.__itDebug.preferences;
      const preferences = api.normalize({ appearance: { mode: 'system', palette: 'sage' } });
      const snapshot = JSON.parse(api.nativeSnapshot(preferences));
      const allModesValid = ['system', 'light', 'dark'].every((mode) => {
        const candidate = api.normalize({ appearance: { mode: mode } });
        const stored = JSON.parse(api.nativeSnapshot(candidate));
        return stored.mode === mode && stored.light.dark === false && stored.dark.dark === true &&
          stored.dark.surface === '#99302C38';
      });
      return { valid: allModesValid && snapshot.mode === 'system' && snapshot.light.dark === false && snapshot.dark.dark === true &&
        snapshot.light.accent === '#FF66876F' && snapshot.dark.accent === '#FF83A58B' &&
        snapshot.light.surface === '#99FFFFFF' && snapshot.dark.surface === '#99302C38' &&
        snapshot.light.background.every((color) => /^#[0-9A-F]{8}$/.test(color)), snapshot };
    })()`);
    check('安卓启动缓存包含浅深两套原生色板', nativeSnapshotCheck.valid,
      JSON.stringify(nativeSnapshotCheck.snapshot));
    check('背景滑块更新不重写或复制完整图片数据', await page.evaluate(`(() => {
      const api = window.__itDebug.preferences;
      const preferences = api.normalize({
        background: { data: 'data:image/png;base64,AA==' }
      });
      api.apply(preferences);
      const style = document.getElementById('it-bg-style').textContent;
      preferences.background.blur = 10;
      api.apply(preferences);
      const stable = document.getElementById('it-bg-style').textContent === style &&
        style.indexOf('data:image/png') === -1;
      api.apply(api.defaults);
      return stable;
    })()`));
    check('液态玻璃全部设置值归一化并限制边界', await page.evaluate(`(() => {
      const api = window.__itDebug.preferences;
      const normalized = api.normalize({ version: 3, liquidGlass: {
        card: { surfaceProfile: 'bad-profile', bezelWidth: 99, glassThickness: -2,
          refractiveIndex: 9, refractionLevel: 999, specularOpacity: -5,
          specularSaturation: 99, blurLevel: 101, progressiveBlurStrength: -1, backgroundOpacity: 200 },
        pill: { backgroundOpacity: 10, progressiveBlurStrength: 5 },
        button: { blurLevel: 30 }
      } });
      const glass = normalized.liquidGlass.card;
      return Object.keys(glass).length === 6 && !('surfaceProfile' in glass) &&
        glass.refractionLevel === 100 && glass.specularOpacity === 0 &&
        glass.specularSaturation === 50 && glass.blurLevel === 40 &&
        glass.progressiveBlurStrength === 0 && glass.backgroundOpacity === 100 &&
        !('backgroundOpacity' in normalized.liquidGlass.pill) &&
        !('progressiveBlurStrength' in normalized.liquidGlass.pill) &&
        !('blurLevel' in normalized.liquidGlass.button);
    })()`));
    check('旧配置归一化会丢弃全部旧玻璃键且背景字体仍保留', await page.evaluate(`(() => {
      const api = window.__itDebug.preferences;
      const normalized = api.normalize({ appearance: { font: 'serif', fontWeight: 950,
        material: 'solid', glassStrength: 0, cardReveal: 100 },
        popup: { cardReveal: 100, backgroundData: 'bad-image' }, background: { opacity: 30 } });
      return normalized.appearance.font === 'serif' && normalized.appearance.fontWeight === 700 &&
        normalized.liquidGlass.card.refractionLevel === 100 &&
        ['material', 'glassStrength', 'cardReveal'].every((key) => normalized.appearance[key] === undefined) &&
        normalized.popup.cardReveal === undefined && normalized.popup.backgroundData === '' &&
        normalized.background.opacity === 30;
    })()`));

    await openMenu(page);
    await page.click('#more-menu [data-act="settings"]');
    await page.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'false'`);
    check('网页与安卓界面可直接打开通用设置',
      await page.evaluate(`!!document.querySelector('#it-pref-theme') &&
        !!document.querySelector('[data-pref-section="appearance"]') &&
        !!document.querySelector('[data-pref="appearance.fontWeight"]') &&
        !!document.querySelector('[data-pref="appearance.fontColorMode"]') &&
        !!document.querySelector('[data-pref-tab="glass"]') &&
        !!document.querySelector('[data-pref-section="glass"]') &&
        document.querySelectorAll('[data-pref^="liquidGlass."]').length === 1 &&
        !!document.querySelector('#it-glass-target') &&
        !document.querySelector('[data-pref="liquidGlass.surfaceProfile"]') &&
        !document.querySelector('[data-pref="liquidGlass.bezelWidth"]') &&
        !document.querySelector('[data-pref="liquidGlass.glassThickness"]') &&
        !document.querySelector('[data-pref="liquidGlass.refractiveIndex"]') &&
        !document.querySelector('[data-pref="appearance.material"]') &&
        !document.querySelector('[data-pref="appearance.glassStrength"]') &&
        !document.querySelector('[data-pref="appearance.cardReveal"]') &&
        document.querySelector('[data-pref="appearance.systemFontFamily"]')?.closest('#it-pref-font-family-row')?.hidden === true &&
        document.getElementById('it-popup-settings')?.hidden === true`));

    await page.evaluate(`(() => {
      const control = document.getElementById('it-pref-theme');
      if (!control) return;
      control.value = 'dark';
      control.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    check('修改主题立即应用且无需保存按钮', await page.evaluate(`
      document.documentElement.dataset.itTheme === 'dark' && !document.getElementById('it-set-save') &&
      ![...document.querySelectorAll('.it-set-foot button')].some((button) => /^(保存|取消)$/.test(button.textContent))`));
    await page.key('Escape');
    await page.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'true'`);
    check('Escape 关闭后保留并持久化当前外观', await page.evaluate(`
      document.documentElement.dataset.itTheme === 'dark' &&
      JSON.parse(localStorage.getItem('it-preferences')).appearance.mode === 'dark'`));

    await openMenu(page);
    await page.click('#more-menu [data-act="settings"]');
    await page.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'false'`);
    await page.evaluate(`(() => {
      const control = document.getElementById('it-pref-theme');
      control.value = 'dark';
      control.dispatchEvent(new Event('change', { bubbles: true }));
      const palette = document.getElementById('it-pref-palette');
      palette.value = 'sage';
      palette.dispatchEvent(new Event('change', { bubbles: true }));
      const setPreference = (path, value) => {
        if (path.startsWith('liquidGlass.')) {
          const target = document.getElementById('it-glass-target');
          target.value = path.split('.')[1];
          target.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const input = document.querySelector('[data-pref="' + path + '"]');
        if (input.type === 'checkbox') input.checked = value;
        else input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setPreference('translation.defaultTab', 'doc');
      setPreference('translation.sourceLanguage', 'auto');
      setPreference('translation.targetLanguage', 'en');
      setPreference('translation.defaultModels.text', 'index-mt-9b');
      setPreference('appearance.fontWeight', 600);
      setPreference('appearance.fontColorMode', 'custom');
      setPreference('appearance.fontColor', '#ff0000');
      setPreference('liquidGlass.pill.refractionLevel', 85);
      setPreference('liquidGlass.card.backgroundOpacity', 40);
      setPreference('translation.rememberLanguages', false);
      setPreference('translation.rememberModels', false);
    })()`);
    await page.key('Escape');
    await page.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'true'`);
    check('网页实时持久化完整配置且关闭不回滚', await page.evaluate(`(() => {
      const saved = JSON.parse(localStorage.getItem('it-preferences') || 'null');
      return document.documentElement.dataset.itTheme === 'dark' &&
        saved?.appearance?.mode === 'dark' && saved?.appearance?.palette === 'sage' &&
        saved?.translation?.defaultTab === 'doc' &&
        saved?.appearance?.fontWeight === 600 && saved?.appearance?.fontColor === '#FF0000' &&
        saved?.liquidGlass?.pill?.refractionLevel === 85 && saved?.liquidGlass?.card?.backgroundOpacity === 40 &&
        saved?.translation?.defaultModels?.text === 'index-mt-9b';
    })()`));
    await page.evaluate(`localStorage.setItem('it-state', JSON.stringify({
      src: 'de', tgt: 'ja', model: { text: 'index-mt-35b', syllable: 'index-mt-9b-syllable',
        doc: 'index-nailong-9b' }, tab: 'text'
    }))`);
    await page.send('Page.reload');
    await pause(400);
    const restoredDefaults = await page.evaluate(`(() => {
      const state = window.__itDebug && window.__itDebug.state;
      return state && {
        tab: state.tab, src: state.src, tgt: state.tgt, model: state.model.text,
        preferences: JSON.parse(localStorage.getItem('it-preferences') || 'null'),
        remembered: JSON.parse(localStorage.getItem('it-state') || 'null')
      };
    })()`);
    check('关闭语言与模型记忆时，下次启动按默认页面语言和模型',
      !!restoredDefaults && restoredDefaults.tab === 'doc' && restoredDefaults.src === 'auto' &&
      restoredDefaults.tgt === 'en' && restoredDefaults.model === 'index-mt-9b',
      JSON.stringify(restoredDefaults));
    await page.evaluate(`(() => {
      const saved = JSON.parse(localStorage.getItem('it-preferences'));
      saved.translation.defaultTab = 'last';
      localStorage.setItem('it-preferences', JSON.stringify(saved));
      const remembered = JSON.parse(localStorage.getItem('it-state'));
      remembered.tab = 'doc';
      localStorage.setItem('it-state', JSON.stringify(remembered));
    })()`);
    await page.send('Page.reload');
    await page.until(`document.readyState === 'complete' && !!window.__itDebug`);
    await page.evaluate(`window.dispatchEvent(new Event('resize'))`);
    check('记住上次页面后调整窗口仍保持页面、焦点和操作栏一致', await page.evaluate(`(() => {
      const selected = [...document.querySelectorAll('.pane.on')];
      const accessible = [...document.querySelectorAll('.pane[aria-hidden="false"]')];
      return window.__itDebug.state.tab === 'doc' && selected.length === 1 &&
        selected[0].id === 'pane-doc' && accessible.length === 1 &&
        accessible[0] === selected[0] && !selected[0].inert &&
        document.querySelector('.dock.on').dataset.pane === 'doc';
    })()`));
  });

  await scenario('桌面设置焦点与返回', async () => {
    await page.evaluate(`(() => {
      // This scenario owns its expected appearance instead of depending on
      // whether the preceding web persistence scenario completed.
      const saved = window.__itDebug.preferences.normalize({
        appearance: { mode: 'dark', palette: 'sage', fontWeight: 400, fontColorMode: 'theme' },
        popup: { backgroundData: '' }
      });
      localStorage.setItem('it-preferences', JSON.stringify(saved));
    })()`);
    const created = await controller.send('Target.createTarget', { url: 'about:blank' });
    desktopTargetId = created.targetId;
    desktop = await connectOwnTarget(desktopTargetId);
    await prepare(desktop, true);
    await desktop.send('Emulation.setDeviceMetricsOverride', {
      width: 700, height: 800, deviceScaleFactor: 1, mobile: false,
    });
    check('窄桌面窗口仍保留标题栏和窗口操作按钮', await desktop.evaluate(`(() => {
      return document.getElementById('appbar').getBoundingClientRect().height === 40 &&
        document.getElementById('win-actions').getBoundingClientRect().width > 80 &&
        document.getElementById('brand').getClientRects().length > 0 &&
        document.getElementById('mobile-settings').getClientRects().length === 0;
    })()`));
    await desktop.send('Emulation.setDeviceMetricsOverride', {
      width: 1180, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await desktop.evaluate(`(() => {
      window.__motionTest.delaySystemFonts = true;
      window.__itOpenSettings({ trigger: document.getElementById('brand') });
    })()`);
    await desktop.until(`typeof window.__motionTest.resolveSystemFonts === 'function'`);
    check('桌面设置在系统字体与最终布局就绪前保持隐藏', await desktop.evaluate(`(() => {
      const modal = document.querySelector('.it-set-mask');
      return !modal.classList.contains('on') && modal.getAttribute('aria-hidden') === 'true' &&
        modal.inert && document.querySelector('.it-set').getAnimations().length === 0 &&
        !window.__motionTest.invoked.some((entry) =>
          entry.command === 'it_set_hotkeys_enabled' && entry.args.enabled === false);
    })()`));
    check('桌面设置准备期间系统返回可取消打开', await desktop.evaluate(`window.__itHandleBack() === true`));
    await desktop.evaluate(`(() => {
      window.__motionTest.delaySystemFonts = false;
      window.__motionTest.resolveSystemFonts();
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    check('较晚返回的字体不会重新打开已取消的设置', await desktop.evaluate(`(() => {
      const modal = document.querySelector('.it-set-mask');
      return !modal.classList.contains('on') && modal.getAttribute('aria-hidden') === 'true' && modal.inert;
    })()`));
    await desktop.click('#brand');
    await desktop.click('#more-menu [data-act="settings"]');
    await desktop.until(`document.querySelector('.it-set-mask').getAttribute('aria-hidden') === 'false'`);
    await pause(350);
    const settingsScreenshot = await desktop.send('Page.captureScreenshot', { format: 'png' });
    await writeFile('output/preview-2.3.0-settings.png', Buffer.from(settingsScreenshot.data, 'base64'));
    await writeFile('output/preview-settings-polish-dark.png', Buffer.from(settingsScreenshot.data, 'base64'));
    check('桌面设置将焦点带入对话框',
      await desktop.evaluate(`document.querySelector('.it-set').contains(document.activeElement)`));
    check('桌面设置隔离背景输入焦点',
      await desktop.evaluate(`(() => {
        document.getElementById('src').focus();
        return document.activeElement.id !== 'src';
      })()`));
    await desktop.until(`!document.getElementById('it-pref-theme').disabled`);
    check('PC 设置提供系统字体选择并加载原生列表', await desktop.evaluate(`(() => {
      const select = document.querySelector('[data-pref="appearance.systemFontFamily"]');
      return !!select && [...select.options].some((option) => option.value === 'Arial') &&
        [...select.options].some((option) => option.value === 'Microsoft YaHei UI') &&
        !!document.querySelector('[data-pref="liquidGlass.card.backgroundOpacity"]') &&
        !!document.getElementById('it-popup-pick-background') &&
        !!document.getElementById('it-popup-follow-background');
    })()`));
    await desktop.evaluate(`document.querySelector('[data-pref-tab="background"]').click()`);
    const sectionTransitionStarted = await desktop.evaluate(`(() => {
      const leaving = document.querySelector('[data-pref-section="appearance"]');
      const activeTab = document.querySelector('[data-pref-tab="background"]');
      const thumb = document.querySelector('.it-set-nav-thumb');
      return !!thumb && activeTab.classList.contains('on') &&
        leaving.classList.contains('is-leaving') &&
        leaving.getAnimations().some((animation) => animation.playState === 'running');
    })()`);
    check('设置导航滑块移动且右侧旧页面淡出', sectionTransitionStarted);
    await desktop.until(`(() => {
      const visible = [...document.querySelectorAll('[data-pref-section]')]
        .filter((section) => !section.hidden && !section.inert);
      return visible.length === 1 && visible[0].dataset.prefSection === 'background';
    })()`);
    await desktop.until(`(() => {
      const tab = document.querySelector('[data-pref-tab="background"]')?.getBoundingClientRect();
      const thumb = document.querySelector('.it-set-nav-thumb')?.getBoundingClientRect();
      return tab && thumb && Math.abs(tab.x - thumb.x) < 1 && Math.abs(tab.y - thumb.y) < 1 &&
        Math.abs(tab.width - thumb.width) < 1 && Math.abs(tab.height - thumb.height) < 1;
    })()`);
    const sectionThumbAligned = await desktop.evaluate(`(() => {
      const tab = document.querySelector('[data-pref-tab="background"]');
      const thumb = document.querySelector('.it-set-nav-thumb');
      const tabRect = tab.getBoundingClientRect();
      const thumbRect = thumb.getBoundingClientRect();
      return Math.abs(tabRect.x - thumbRect.x) < 1 && Math.abs(tabRect.y - thumbRect.y) < 1 &&
        Math.abs(tabRect.width - thumbRect.width) < 1 && Math.abs(tabRect.height - thumbRect.height) < 1;
    })()`);
    check('设置导航滑块落在当前菜单项下方', sectionThumbAligned);
    await desktop.evaluate(`document.querySelector('[data-pref-tab="glass"]').click()`);
    await desktop.until(`(() => document.querySelector('[data-pref-section="glass"]')?.classList.contains('is-entering'))()`);
    await desktop.until(`(() => {
      const visible = [...document.querySelectorAll('[data-pref-section]')]
        .filter((section) => !section.hidden && !section.inert);
      return visible.length === 1 && visible[0].dataset.prefSection === 'glass';
    })()`);
    const presetPopup = await desktop.evaluate(`(() => {
      const select = document.getElementById('it-glass-target');
      const button = select?.parentElement?.querySelector('.sel-btn');
      const expectedRadius = getComputedStyle(document.documentElement).getPropertyValue('--lg-r-sm').trim();
      return !!button && !!button.getAttribute('aria-label') &&
        [...select.options].map((option) => option.value).join(',') === 'card,pill,button' &&
        getComputedStyle(button).borderRadius === expectedRadius &&
        window.__glassStyle(button).backdropFilter.includes('url(');
    })()`);
    check('玻璃调整对象下拉与滤镜控件风格统一', presetPopup);
    await desktop.evaluate(`document.getElementById('it-glass-target')?.parentElement?.querySelector('.sel-btn')?.click()`);
    await desktop.until(`!!document.querySelector('.sel-pop[aria-hidden="false"]')`);
    const themeOptionsStyled = await desktop.evaluate(`(() => {
      const popup = document.querySelector('.sel-pop[aria-hidden="false"]');
      return !!popup && !!popup.querySelector('.sel-list .sel-item') &&
        ItLiquidGlass.stateOf(popup) === null &&
        getComputedStyle(popup).backdropFilter === 'none' &&
        getComputedStyle(popup).backgroundImage.includes('repeating-linear-gradient');
    })()`);
    check('调整对象选项使用静态磨砂弹层', themeOptionsStyled);
    await desktop.key('Escape');
    await desktop.until(`!document.querySelector('.sel-pop[aria-hidden="false"]')`);
    check('设置下拉关闭后焦点返回触发控件', await desktop.evaluate(`(() =>
      document.activeElement === document.getElementById('it-glass-target')?.parentElement?.querySelector('.sel-btn'))()`));
    await desktop.evaluate(`(() => {
      const select = document.getElementById('it-glass-target');
      select.value = 'card';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.parentElement.querySelector('.sel-btn').click();
    })()`);
    await desktop.key('ArrowDown');
    await desktop.key(' ');
    check('玻璃调整对象下拉可用键盘选择', await desktop.evaluate(`(() => {
      const select = document.getElementById('it-glass-target');
      return select.value === 'pill' && !document.querySelector('.sel-pop[aria-hidden="false"]');
    })()`));
    const groupControls = await desktop.evaluate(`(() => {
      const select = document.getElementById('it-glass-target');
      const counts = {};
      for (const group of ['card', 'pill', 'button']) {
        select.value = group;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const controls = [...document.querySelectorAll('[data-pref^="liquidGlass."]')]
          .filter((control) => !control.closest('[hidden]'));
        counts[group] = controls.length;
        if (controls.some((control) => !control.dataset.pref.startsWith('liquidGlass.' + group + '.'))) return null;
      }
      return counts;
    })()`);
    check('磨砂、滑块和按钮分别显示一、四、三个有效控件',
      groupControls?.card === 1 && groupControls?.pill === 4 && groupControls?.button === 3,
      JSON.stringify(groupControls));
    await desktop.evaluate(`(() => {
      const select = document.getElementById('it-glass-target');
      select.value = 'card';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await selectSettingsSection(desktop, 'appearance');
    await desktop.evaluate(`(() => {
      const select = document.querySelector('[data-pref="appearance.mode"]');
      select.value = 'light';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.parentElement.querySelector('.sel-btn').click();
    })()`);
    await desktop.key('ArrowDown');
    await desktop.key(' ');
    check('设置下拉方向键后按空格选择当前高亮项', await desktop.evaluate(`(() => {
      const select = document.querySelector('[data-pref="appearance.mode"]');
      return select.value === 'dark' && !document.querySelector('.sel-pop[aria-hidden="false"]') &&
        document.activeElement === select.parentElement.querySelector('.sel-btn');
    })()`));
    await desktop.evaluate(`(() => {
      const select = document.querySelector('[data-pref="appearance.mode"]');
      select.value = 'light';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await desktop.until(`document.querySelector('.it-set').getAnimations({ subtree: true })
      .every((animation) => animation.effect.getComputedTiming().iterations === Infinity)`);
    const lightSettings = await desktop.send('Page.captureScreenshot', { format: 'png' });
    await writeFile('output/preview-settings-polish-light.png', Buffer.from(lightSettings.data, 'base64'));
    await desktop.evaluate(`document.querySelector('[data-pref="appearance.mode"]').parentElement.querySelector('.sel-btn').click()`);
    await desktop.until(`document.querySelector('.sel-pop[aria-hidden="false"]').getAnimations().length === 0`);
    const lightDropdown = await desktop.send('Page.captureScreenshot', { format: 'png' });
    await writeFile('output/preview-settings-polish-dropdown.png', Buffer.from(lightDropdown.data, 'base64'));
    await desktop.key('Escape');
    await desktop.evaluate(`(() => {
      const select = document.querySelector('[data-pref="appearance.mode"]');
      select.value = 'dark';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const rapidSettings = await desktop.evaluate(`(async () => {
      document.querySelector('[data-pref-tab="background"]').click();
      await new Promise((resolve) => setTimeout(resolve, 45));
      const before = getComputedStyle(document.querySelector('[data-pref-section="appearance"]'))
        .getPropertyValue('--it-settings-page-reveal');
      document.querySelector('[data-pref-tab="reading"]').click();
      const after = getComputedStyle(document.querySelector('[data-pref-section="appearance"]'))
        .getPropertyValue('--it-settings-page-reveal');
      return { before, after, skipped: document.querySelector('[data-pref-section="background"]').hidden };
    })()`);
    check('设置连续切换保留当前淡出状态并跳过中间页',
      Number(rapidSettings.before) > 0 && Number(rapidSettings.before) < 1 &&
      Math.abs(Number(rapidSettings.before) - Number(rapidSettings.after)) < .05 && rapidSettings.skipped);
    await desktop.until(`!document.querySelector('[data-pref-section="reading"]').hidden &&
      !document.querySelector('[data-pref-section="reading"]').inert`);
    await desktop.evaluate(`document.querySelector('[data-pref="appearance.systemFontFamily"]').parentElement.querySelector('.sel-btn').click()`);
    await desktop.until(`!!document.querySelector('.sel-pop[aria-hidden="false"] .sel-search')`);
    await desktop.click('.sel-pop[aria-hidden="false"] .sel-search');
    await desktop.evaluate(`(() => {
      const search = document.querySelector('.sel-pop[aria-hidden="false"] .sel-search');
      search.value = 'Arial';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await desktop.key('ArrowDown');
    await desktop.key('Enter');
    check('系统字体晚加载后可在统一下拉中搜索并选择', await desktop.evaluate(`(() => {
      const select = document.querySelector('[data-pref="appearance.systemFontFamily"]');
      return select.value === 'Arial' &&
        getComputedStyle(document.documentElement).getPropertyValue('--it-content-font').includes('"Arial"') &&
        !document.querySelector('.sel-pop[aria-hidden="false"]');
    })()`));
    await desktop.evaluate(`(() => {
      const select = document.querySelector('[data-pref="appearance.systemFontFamily"]');
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await desktop.evaluate(`document.querySelector('[data-pref-tab="background"]').click()`);
    await desktop.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await desktop.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    check('设置切换中开启系统减少动态效果立即收束', await desktop.evaluate(`(() => {
      const pages = [...document.querySelectorAll('[data-pref-section]')].filter((page) => !page.hidden);
      return pages.length === 1 && pages[0].dataset.prefSection === 'background' &&
        !pages[0].classList.contains('is-leaving') && !pages[0].classList.contains('is-entering') &&
        getComputedStyle(pages[0]).opacity === '1' &&
        Number(getComputedStyle(pages[0]).getPropertyValue('--it-settings-page-reveal')) === 1;
    })()`));
    await desktop.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
    await selectSettingsSection(desktop, 'appearance');
    await selectSettingsSection(desktop, 'glass');
    await desktop.evaluate(`(() => {
      const target = document.getElementById('it-glass-target');
      target.value = 'pill';
      target.dispatchEvent(new Event('change', { bubbles: true }));
      const setValue = (path, value) => {
        const control = document.querySelector('[data-pref="' + path + '"]');
        control.value = value;
        control.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setValue('liquidGlass.pill.refractionLevel', 80);
      setValue('liquidGlass.pill.specularOpacity', 65);
      setValue('liquidGlass.pill.blurLevel', 3.5);
    })()`);
    check('液态玻璃控件实时驱动折射、高光和模糊', await desktop.evaluate(`(() => {
      const card = document.querySelector('.tabs-thumb');
      const getFilter = () => {
        const url = window.__glassStyle(card).backdropFilter;
        const id = (url.match(/url\\(["']?#([^"')]+)["']?\\)/) || [])[1];
        return id && document.getElementById(id);
      };
      const filter = getFilter();
      return !!filter && filter.querySelector('feDisplacementMap')?.getAttribute('scale') !== '0' &&
        filter.querySelector('[result="specular-map"]') && filter.querySelector('feGaussianBlur');
    })()`));
    await selectSettingsSection(desktop, 'desktop');
    await desktop.click('#it-popup-pick-background');
    check('模拟文件选择器已打开', await desktop.evaluate('window.__motionTest.filePickerOpens === 1'));
    await desktop.until(`document.getElementById('it-popup-background-status')?.textContent.includes('已选择独立图片')`);
    check('悬浮窗选图立即更新预览且使用独立图层', await desktop.evaluate(`(() => {
      const image = document.querySelector('.it-popup-preview-image').style.getPropertyValue('--it-popup-preview-image');
      const card = document.querySelector('.it-popup-preview-card');
      return image.startsWith('url("data:image/png;base64,') &&
        window.__glassStyle(card).backgroundColor !== 'rgba(0, 0, 0, 0)';
    })()`));
    check('设置中的悬浮窗背景预览也仅覆盖卡片内部', await desktop.evaluate(`(() => {
      const card = document.querySelector('.it-popup-preview-card');
      const image = document.querySelector('.it-popup-preview-image');
      const a = card.getBoundingClientRect(), b = image.getBoundingClientRect();
      return card.parentElement === image.parentElement &&
        ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) < .1) &&
        getComputedStyle(image).overflow === 'hidden';
    })()`));
    await desktop.click('#it-popup-follow-background');
    const popupFollowState = await desktop.evaluate(`(() => ({
      status: document.getElementById('it-popup-background-status').textContent,
      image: document.querySelector('.it-popup-preview-image').style.getPropertyValue('--it-popup-preview-image')
    }))()`);
    check('悬浮窗可恢复跟随主窗口背景', popupFollowState.status === '悬浮窗跟随主窗口背景。' &&
      popupFollowState.image === 'none', JSON.stringify(popupFollowState));
    check('重置电脑功能前通用外观与当前分类符合测试输入', await desktop.evaluate(`(() => {
      const button = document.querySelector('[data-reset-section]');
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return document.documentElement.dataset.itTheme === 'dark' &&
        document.documentElement.dataset.itPalette === 'sage' &&
        !document.querySelector('[data-pref-section="desktop"]').hidden &&
        !document.querySelector('[data-pref-section="desktop"]').inert &&
        !button.disabled && (hit === button || button.contains(hit));
    })()`));
    const glassBeforeDesktopReset = await desktop.evaluate(`document.querySelector('[data-pref="liquidGlass.pill.refractionLevel"]').value`);
    await desktop.click('[data-reset-section]');
    check('恢复电脑功能默认值不会重置通用外观', await desktop.evaluate(`
      document.documentElement.dataset.itTheme === 'dark' &&
      document.documentElement.dataset.itPalette === 'sage' &&
      String(document.querySelector('[data-pref="liquidGlass.pill.refractionLevel"]').value) === String(${glassBeforeDesktopReset}) &&
      !document.querySelector('[data-pref="popup.cardReveal"]')`));
    await desktop.key('Escape');
    await desktop.until(`document.querySelector('.it-set-mask').getAttribute('aria-hidden') === 'true'`);
    check('桌面设置 Escape 关闭并归还可用焦点',
      await desktop.evaluate(`(() => {
        const selected = document.querySelectorAll('.pane[aria-hidden="false"]');
        return document.activeElement.id === 'brand' && selected.length === 1 && !selected[0].inert;
      })()`));
    await desktop.click('#brand');
    await desktop.click('#more-menu [data-act="settings"]');
    await desktop.until(`document.querySelector('.it-set-mask').getAttribute('aria-hidden') === 'false'`);
    check('桌面设置系统返回被消费',
      await desktop.evaluate(`window.__itHandleBack() === true`));
    await desktop.until(`document.querySelector('.it-set-mask').getAttribute('aria-hidden') === 'true'`);
    await desktop.click('#brand');
    await desktop.click('#more-menu [data-act="settings"]');
    await desktop.until(`document.querySelector('.it-set-mask').getAttribute('aria-hidden') === 'false'`);
    await pause(350);
    await desktop.click('.it-set-x');
    await desktop.until(`document.querySelector('.it-set-mask').getAttribute('aria-hidden') === 'true'`);
    check('桌面设置关闭按钮可真实点中', true);

    await desktop.click('#brand');
    await desktop.click('#more-menu [data-act="settings"]');
    await desktop.until(`document.querySelector('.it-set-mask').getAttribute('aria-hidden') === 'false' &&
      !document.getElementById('it-pref-theme').disabled`);
    await desktop.evaluate(`(() => {
      const setPreference = (path, value) => {
        const control = document.querySelector('[data-pref="' + path + '"]');
        if (control.type === 'checkbox') control.checked = value;
        else control.value = value;
        control.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setPreference('appearance.mode', 'dark');
      setPreference('appearance.palette', 'amber');
      setPreference('appearance.radius', 'small');
      setPreference('appearance.fontScale', 130);
      setPreference('appearance.fontWeight', 600);
      setPreference('appearance.fontColorMode', 'custom');
      setPreference('appearance.fontColor', '#ff0000');
      setPreference('appearance.systemFontFamily', 'Arial');
      setPreference('appearance.layout', 'compact');
      setPreference('appearance.motion', 'reduced');
      setPreference('appearance.ambientLight', false);
    })()`);
    await selectSettingsSection(desktop, 'glass');
    await desktop.evaluate(`(() => {
      const selectTarget = (group) => {
        const select = document.getElementById('it-glass-target');
        select.value = group;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const setPreference = (path, value) => {
        const control = document.querySelector('[data-pref="' + path + '"]');
        control.value = value;
        control.dispatchEvent(new Event('change', { bubbles: true }));
      };
      selectTarget('pill');
      setPreference('liquidGlass.pill.specularOpacity', 33);
      setPreference('liquidGlass.pill.refractionLevel', 55);
      selectTarget('button');
      setPreference('liquidGlass.button.specularOpacity', 65);
      selectTarget('card');
      setPreference('liquidGlass.card.backgroundOpacity', 33);
    })()`);
    await desktop.click('[data-reset-section]');
    check('恢复当前玻璃预设不会重置其他元素或外观阅读草稿', await desktop.evaluate(`(() => {
      const value = (path) => document.querySelector('[data-pref="' + path + '"]').value;
      const defaults = window.__itDebug.preferences.defaults.liquidGlass.card;
      const cardReset = Number(value('liquidGlass.card.backgroundOpacity')) === defaults.backgroundOpacity &&
        !document.querySelector('[data-pref="liquidGlass.card.refractionLevel"]') &&
        !document.querySelector('[data-pref="liquidGlass.card.specularOpacity"]');
      const select = document.getElementById('it-glass-target');
      select.value = 'pill';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const pillPreserved = Number(value('liquidGlass.pill.specularOpacity')) === 33 &&
        Number(value('liquidGlass.pill.refractionLevel')) === 55;
      select.value = 'button';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const buttonPreserved = Number(value('liquidGlass.button.specularOpacity')) === 65;
      select.value = 'card';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return cardReset && pillPreserved && buttonPreserved &&
        value('appearance.mode') === 'dark' && value('appearance.palette') === 'amber' &&
        value('appearance.radius') === 'small' && value('appearance.fontScale') === '130' &&
        value('appearance.fontWeight') === '600' && value('appearance.fontColorMode') === 'custom' &&
        value('appearance.systemFontFamily') === 'Arial' &&
        document.getElementById('it-popup-background-status').textContent === '悬浮窗跟随主窗口背景。' &&
        value('appearance.layout') === 'compact' && value('appearance.motion') === 'reduced' &&
        !document.querySelector('[data-pref="appearance.ambientLight"]').checked;
    })()`));
    await desktop.until(`window.__motionTest.savedSettings?.preferences.liquidGlass.card.backgroundOpacity === 60`);
    await desktop.evaluate(`(() => {
      window.__motionTest.saveDelay = 10000;
      const scale = document.querySelector('[data-pref="appearance.fontScale"]');
      scale.value = '135';
      scale.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await desktop.until(`typeof window.__motionTest.resolveSave === 'function'`);
    check('后台保存不会禁用编辑、类别导航和关闭控件', await desktop.evaluate(`(() => {
      const controls = [document.getElementById('it-pref-theme'),
        document.querySelector('[data-pref-tab="appearance"]'),
        document.querySelector('.it-set-x'), document.querySelector('[data-reset-section]')];
      const scale = document.querySelector('[data-pref="appearance.fontScale"]');
      scale.value = '130';
      scale.dispatchEvent(new Event('change', { bubbles: true }));
      return controls.every((control) => !control.disabled) &&
        document.getElementById('it-set-save') === null;
    })()`));
    await desktop.key('Escape');
    check('后台保存时 Escape 可以关闭且保留最新更改', await desktop.evaluate(`
      document.querySelector('.it-set-mask').getAttribute('aria-hidden') === 'true' &&
      document.documentElement.dataset.itTheme === 'dark'`));
    const settingsReadsBeforeReopen = await desktop.evaluate(`window.__motionTest.invoked.filter(
      (entry) => entry.command === 'it_get_settings').length`);
    await desktop.evaluate(`window.__itOpenSettings({ section: 'reading' })`);
    await desktop.until(`document.querySelector('.it-set-mask').getAttribute('aria-hidden') === 'false'`);
    check('未完成保存时重开设置保持最新草稿并继续编辑', await desktop.evaluate(`(() => {
      const scale = document.querySelector('[data-pref="appearance.fontScale"]');
      return scale.value === '130' && !scale.disabled &&
        window.__motionTest.invoked.filter((entry) => entry.command === 'it_get_settings').length ===
          ${settingsReadsBeforeReopen};
    })()`));
    await desktop.key('Escape');
    await desktop.evaluate(`window.__motionTest.saveDelay = 0; window.__motionTest.resolveSave()`);
    await desktop.until(`window.__motionTest.savedSettings?.preferences.appearance.fontScale === 130`);
    check('异步保存按序提交最新快照且旧写入不覆盖新偏好', await desktop.evaluate(`(() => {
      const submitted = window.__motionTest.submittedSettings;
      const saved = window.__motionTest.savedSettings;
      const local = JSON.parse(localStorage.getItem('it-preferences') || 'null');
      return submitted && saved && JSON.stringify(submitted) === JSON.stringify(saved) &&
        JSON.stringify(saved.preferences) === JSON.stringify(local) &&
        local.appearance.mode === 'dark' && local.appearance.fontScale === 130 &&
        local.appearance.fontWeight === 600 && local.appearance.fontColor === '#FF0000' &&
        local.version === 3 && local.liquidGlass.card.specularOpacity === 40 &&
        local.liquidGlass.card.refractionLevel === 100 && local.liquidGlass.card.backgroundOpacity === 60 &&
        local.liquidGlass.pill.specularOpacity === 33 && local.liquidGlass.pill.refractionLevel === 55 &&
        local.liquidGlass.button.specularOpacity === 65 &&
        local.appearance.material === undefined && local.appearance.glassStrength === undefined &&
        local.appearance.cardReveal === undefined && local.popup.cardReveal === undefined &&
        local.appearance.layout === 'compact' && local.appearance.motion === 'reduced' &&
        local.appearance.ambientLight === false && document.documentElement.dataset.itTheme === 'dark';
    })()`));
  });

  await scenario('精简按钮文字与更新设置', async () => {
    await desktop.evaluate(`window.__motionTest.saveDelay = 0`);
    check('翻译和下载按钮使用简短文字', await desktop.evaluate(`(() => {
      return ['btn-go', 'btn-go-syllable', 'btn-go-doc'].every((id) =>
        document.getElementById(id).textContent === '翻译') &&
        document.getElementById('btn-dl').textContent === '下载';
    })()`));
    await desktop.evaluate(`window.__itOpenSettings({section:'updates'})`);
    await desktop.until(`!document.getElementById('it-pref-theme').disabled &&
      !document.querySelector('[data-pref-section="updates"]').hidden`);
    check('更新设置提供自动检查开关与当前版本', await desktop.evaluate(`(() => {
      const page=document.querySelector('[data-pref-section="updates"]');
      return page.textContent.includes('2.3.0') &&
        page.textContent.includes('24 小时') &&
        !!page.querySelector('[data-pref="updates.autoCheck"]');
    })()`));
    await desktop.evaluate(`window.__motionTest.updateResponse={status:200,body:{
      tag_name:'v2.3.1',html_url:'https://github.com/jiuxina/jian-translator/releases/tag/v2.3.1'
    }}`);
    await desktop.click('#it-update-check');
    await desktop.until(`document.getElementById('it-update-status').textContent.includes('2.3.1')`);
    check('检查发现新版本并提供固定仓库发布链接', await desktop.evaluate(`(() => {
      const link=document.getElementById('it-update-release');
      return link.href==='https://github.com/jiuxina/jian-translator/releases/tag/v2.3.1' &&
        link.textContent==='获取 2.3.1' && link.rel.includes('noopener');
    })()`));
    await desktop.evaluate(`window.__motionTest.updateResponse={status:429}`);
    await desktop.click('#it-update-check');
    await desktop.until(`document.getElementById('it-update-status').textContent.includes('检查失败')`);
    check('更新限流会显示失败并允许重试', await desktop.evaluate(`
      document.getElementById('it-update-status').textContent.includes('次数受限') &&
      !document.getElementById('it-update-check').disabled`));
    await desktop.evaluate(`(() => {
      const control=document.querySelector('[data-pref="updates.autoCheck"]');
      control.checked=false;control.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await desktop.key('Escape');
    await desktop.until(`document.querySelector('.it-set-mask').getAttribute('aria-hidden')==='true'`);
    await desktop.until(`window.__motionTest.savedSettings?.preferences.updates.autoCheck === false`);
    check('自动检查开关即时保存完整设置', await desktop.evaluate(`
      window.__motionTest.savedSettings.preferences.updates.autoCheck===false &&
      JSON.parse(localStorage.getItem('it-preferences')).updates.autoCheck===false`));
  });

  await scenario('macOS 桌面桥接与标题栏约定', async () => {
    ({ targetId: macTargetId } = await controller.send('Target.createTarget', { url: 'about:blank' }));
    const mac = await connectOwnTarget(macTargetId);
    await prepare(mac, 'mac');
    await mac.until(`!document.documentElement.classList.contains('it-settings-boot')`);
    check('macOS 使用桌面桥并为原生交通灯预留标题栏空间', await mac.evaluate(`(() => {
      const bar = document.getElementById('appbar');
      const actions = document.getElementById('win-actions');
      return document.documentElement.classList.contains('it-desktop') &&
        document.documentElement.classList.contains('it-macos') &&
        bar.getBoundingClientRect().height === 40 &&
        parseFloat(getComputedStyle(bar).paddingLeft) >= 80 &&
        actions.hidden && actions.getClientRects().length === 0 &&
        !document.querySelector('.rz') && !window.__TAURI_INTERNALS__ &&
        window.__motionTest.invoked.some((entry) => entry.command === 'it_get_settings');
    })()`));
    await mac.evaluate(`window.__motionTest.nativeAction({ type: 'open-settings' })`);
    await mac.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'false' &&
      !document.getElementById('it-pref-theme').disabled`);
    check('macOS 原生设置入口加载桌面设置与系统字体列表', await mac.evaluate(`(() => {
      const fonts = document.querySelector('[data-pref="appearance.systemFontFamily"]');
      return document.querySelector('.it-set').contains(document.activeElement) &&
        document.getElementById('it-set-selection').value === 'Cmd+Alt+T' &&
        document.getElementById('it-set-activation').value === 'Cmd+Alt+I' &&
        !fonts.closest('#it-pref-font-family-row').hidden &&
        [...fonts.options].some((option) => option.value === 'Arial') &&
        window.__motionTest.invoked.some((entry) => entry.command === 'it_list_system_fonts');
    })()`));
    await selectSettingsSection(mac, 'desktop');
    await mac.click('#it-set-selection');
    await mac.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 5,
    });
    await mac.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75,
    });
    check('macOS 快捷键录制识别 Command 与 Option', await mac.evaluate(`
      document.getElementById('it-set-selection').value === 'Cmd+Alt+K'`));
    await mac.key('Escape');
    await mac.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'true'`);
    await mac.until(`window.__motionTest.savedSettings?.selection_shortcut === 'Cmd+Alt+K'`);
    check('macOS 即时保存 Command 快捷键与分组玻璃参数', await mac.evaluate(`(() => {
      const saved = window.__motionTest.savedSettings;
      return saved?.selection_shortcut === 'Cmd+Alt+K' &&
        saved.preferences.version === 3 &&
        Object.keys(saved.preferences.liquidGlass).join(',') === 'card,pill,button';
    })()`));
  });

  await scenario('悬浮窗背景范围与滚动条', async () => {
    const popupSource = await readFile('desktop/patch/setup.rs', 'utf8');
    const marker = 'const POPUP_BOOTSTRAP: &str = r#"';
    const start = popupSource.indexOf(marker);
    const end = popupSource.indexOf('"#;', start + marker.length);
    if (start < 0 || end < 0) throw new Error('Missing popup bootstrap');
    const bootstrap = popupSource.slice(start + marker.length, end);
    ({ targetId: popupTargetId } = await controller.send('Target.createTarget', { url: 'about:blank' }));
    const popup = await connectOwnTarget(popupTargetId);
    await popup.send('Page.enable');
    await popup.send('Runtime.enable');
    await popup.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await popup.send('Emulation.setDeviceMetricsOverride', {
      width: 436, height: 282, deviceScaleFactor: 1, mobile: false,
    });
    await popup.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await popup.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    const liquidGlassEngine = await readFile('web/liquid-glass.js', 'utf8');
    await popup.evaluate(liquidGlassEngine);
    await popup.evaluate(bootstrap);
    const image = await popup.evaluate(`(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 240;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f027ad'; ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = '#1fd2db'; ctx.fillRect(20, 20, 280, 200);
      return canvas.toDataURL('image/png');
    })()`);
    await popup.evaluate(`window.__popupApplyPreferences({
      appearance: { mode: 'light', motion: 'off' },
      liquidGlass: { card: { refractionLevel: 100, specularOpacity: 40,
        specularSaturation: 6, blurLevel: 1, progressiveBlurStrength: 1, backgroundOpacity: 60 } },
      background: { data: ${JSON.stringify(image)}, opacity: 0, blur: 0, fit: 'contain' },
      popup: { backgroundData: '' }
    });
    document.getElementById('out').textContent = '正文超出时，滚动条保持透明轨道与圆角。\\n'.repeat(80);`);
    check('悬浮窗背景与卡片同矩形且圆角裁剪', await popup.evaluate(`(() => {
      const card = document.getElementById('card'), image = document.getElementById('popup-background');
      const frame = document.getElementById('card-frame');
      const a = card.getBoundingClientRect(), b = image.getBoundingClientRect();
      return card.parentElement === frame && image.parentElement === frame &&
        ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) < .1) &&
        getComputedStyle(image).overflow === 'hidden' &&
        getComputedStyle(image).borderRadius === getComputedStyle(card).borderRadius &&
        getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)';
    })()`));
    check('悬浮窗完整显示不把图片放大裁剪且完全透出仍保留外阴影', await popup.evaluate(`(() => {
      const layer = document.getElementById('popup-background');
      const photo = getComputedStyle(layer, '::before'),
        card = getComputedStyle(document.getElementById('card'));
      return photo.backgroundSize === 'contain' &&
        ['top', 'right', 'bottom', 'left'].every((side) => photo[side] === '0px') &&
        card.backdropFilter === 'none' &&
        ItLiquidGlass.stateOf(document.getElementById('card')) === null &&
        !document.querySelector('#card > [data-it-liquid-background], #card > [data-it-liquid-progressive]') &&
        getComputedStyle(document.getElementById('card-frame')).boxShadow !== 'none';
    })()`));
    check('悬浮窗正文使用无箭头的透明轨道滚动条', await popup.evaluate(`(() => {
      const node = document.getElementById('out');
      return node.scrollHeight > node.clientHeight &&
        getComputedStyle(node, '::-webkit-scrollbar-button').display === 'none' &&
        getComputedStyle(node, '::-webkit-scrollbar-track').backgroundColor === 'rgba(0, 0, 0, 0)' &&
        getComputedStyle(node, '::-webkit-scrollbar-thumb').borderRadius === '99px';
    })()`));
    const light = await popup.send('Page.captureScreenshot', { format: 'png' });
    await writeFile('output/preview-popup-clipped-contain.png', Buffer.from(light.data, 'base64'));
    await popup.evaluate(`window.__popupApplyPreferences({
      appearance: { mode: 'dark', motion: 'off' },
      liquidGlass: { card: { refractionLevel: 90, specularOpacity: 50,
        specularSaturation: 7, blurLevel: 1.4, progressiveBlurStrength: 2.4, backgroundOpacity: 55 } },
      background: { data: '', opacity: 34, blur: 20, fit: 'cover' },
      popup: { backgroundData: ${JSON.stringify(image)} }
    });`);
    check('悬浮窗独立图片与模糊淡化仍生效', await popup.evaluate(`(() => {
      const layer = document.getElementById('popup-background');
      const photo = getComputedStyle(layer, '::before');
      return photo.backgroundImage.includes('data:image/png') && photo.filter === 'blur(20px)' &&
        getComputedStyle(layer, '::after').backgroundColor === 'rgba(18, 16, 24, 0.34)' &&
        getComputedStyle(document.getElementById('card')).backdropFilter === 'none' &&
        getComputedStyle(document.getElementById('card')).backgroundImage.includes('repeating-linear-gradient') &&
        ItLiquidGlass.stateOf(document.getElementById('copy'))?.presetName === 'button';
    })()`));
    const dark = await popup.send('Page.captureScreenshot', { format: 'png' });
    await writeFile('output/preview-popup-clipped-dark.png', Buffer.from(dark.data, 'base64'));
  });

  for (const connection of connections.filter((connection) => connection !== controller)) {
    check('页面无 JavaScript 异常', connection.errors.length === 0, connection.errors.join(' | '));
    check('交互验收没有访问外网', connection.blockedRequests.length === 0,
      connection.blockedRequests.join(' | '));
  }
} catch (error) {
  check('验收环境可用', false, error.stack || error.message);
} finally {
  for (const targetId of [popupTargetId, macTargetId, desktopTargetId, mainTargetId].filter(Boolean)) {
    if (controller?.socket.readyState === WebSocket.OPEN) {
      try { await controller.send('Target.closeTarget', { targetId }); }
      catch (error) { check('独立测试页清理', false, error.message); }
    }
  }
  for (const connection of connections) connection.socket.close();
  const passed = results.filter((result) => result.passed).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
}
