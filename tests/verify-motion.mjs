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
const ORIGIN = process.env.IT_PREVIEW_ORIGIN || 'http://127.0.0.1:8899';
const DEBUG_ORIGIN = process.env.IT_CDP_ORIGIN || 'http://127.0.0.1:9223';
const PAGE_URL = `${ORIGIN}/?debug=1`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const connections = [];
let mainTargetId;
let desktopTargetId;

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
      baselineScript + (desktop ? desktopScript : ''),
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
  await connection.click('#brand');
  await connection.key('Escape');
  check('Escape 关闭更多菜单',
    await connection.evaluate(`document.getElementById('more-menu').getAttribute('aria-hidden') === 'true'`));
  await connection.click('#brand');
  check('系统返回关闭更多菜单',
    await connection.evaluate(`window.__itHandleBack() === true &&
      document.getElementById('more-menu').getAttribute('aria-hidden') === 'true'`));
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
try {
  const targets = await (await fetch(`${DEBUG_ORIGIN}/json`)).json();
  const controlTarget = targets.find((item) => item.type === 'page' && item.url.startsWith(ORIGIN));
  if (!controlTarget) throw new Error('Open the isolated preview page on port 8899 before running this check.');
  controller = await Cdp.connect(controlTarget.webSocketDebuggerUrl);
  const created = await controller.send('Target.createTarget', { url: 'about:blank' });
  mainTargetId = created.targetId;
  const ownTargets = await (await fetch(`${DEBUG_ORIGIN}/json`)).json();
  const target = ownTargets.find((item) => item.id === mainTargetId);
  if (!target) throw new Error('CDP did not expose the isolated main test tab.');
  page = await Cdp.connect(target.webSocketDebuggerUrl);
  await prepare(page, false, true);

  await scenario('双向页面承接', async () => {
    await directionAndShells(page, 'text', 'syllable', 1);
    await directionAndShells(page, 'syllable', 'text', -1);
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
    await page.click('#langbar .sel-btn');
    const rows = await page.evaluate(`[...document.querySelector('.sel-pop[aria-hidden="false"]')
      .querySelectorAll('.sel-item')].slice(0, 7).map((row) => ({
        value: row.dataset.value, label: row.textContent
      }))`);
    if (rows.length < 7) throw new Error('Source language list needs at least seven options.');
    await page.evaluate(`document.querySelector('.sel-pop[aria-hidden="false"] .sel-item').click()`);
    await pause(700);
    await page.click('#langbar .sel-btn');
    const wheel = await page.evaluate(`(async () => {
      document.querySelector('.sel-pop[aria-hidden="false"]').querySelectorAll('.sel-item')[6].click();
      const reel = document.querySelector('#langbar .sel-reel');
      const labels = [...reel.children].map((row) => row.textContent);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const first = new DOMMatrixReadOnly(getComputedStyle(reel).transform).m42;
      await new Promise((resolve) => setTimeout(resolve, 90));
      const second = new DOMMatrixReadOnly(getComputedStyle(reel).transform).m42;
      return { labels, first, second };
    })()`);
    check('轮盘逐项经过语言列表且朝正确方向滚动',
      JSON.stringify(wheel.labels) === JSON.stringify(rows.map((row) => row.label)) &&
      wheel.second < wheel.first - 1, JSON.stringify(wheel));
    await pause(700);
    check('轮盘最终语言与所选项一致',
      await page.evaluate(`document.getElementById('src-lang').value === ${JSON.stringify(rows[6].value)}`));
    await page.click('#langbar .sel-btn');
    const reverse = await page.evaluate(`(async () => {
      document.querySelector('.sel-pop[aria-hidden="false"] .sel-item').click();
      const reel = document.querySelector('#langbar .sel-reel');
      await new Promise((resolve) => setTimeout(resolve, 60));
      const first = new DOMMatrixReadOnly(getComputedStyle(reel).transform).m42;
      await new Promise((resolve) => setTimeout(resolve, 90));
      return { first, second: new DOMMatrixReadOnly(getComputedStyle(reel).transform).m42 };
    })()`);
    check('反向选择沿同一列表回滚', reverse.second > reverse.first + 1);
    await pause(700);
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
        return { navBottom: nav.bottom, navTop: nav.top, dockBottom: dock.bottom,
          touch, width: innerWidth, height: innerHeight };
      })()`);
      check(`${width}×${height} 导航触控与安全区`,
        layout.touch >= 48 && layout.navBottom <= height &&
        layout.dockBottom <= layout.navTop - 4, JSON.stringify(layout));
      await page.click('#src');
      check(`${width}×${height} 输入焦点使底栏让位`,
        await page.evaluate(`document.activeElement.id === 'src' &&
          getComputedStyle(document.querySelector('.tabs')).display === 'none'`));
      await page.evaluate(`document.getElementById('src').blur()`);
      await page.until(`getComputedStyle(document.querySelector('.tabs')).display !== 'none'`);
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
        await page.evaluate(`window.__itOpenSettings()`);
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
        await page.key('Escape');
        await page.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'true'`);
      }
    });
  }

  await scenario('通用偏好预览、撤销和保存', async () => {
    check('偏好配置公开可测试的归一化入口', await page.evaluate(`
      !!window.__itDebug.preferences &&
      typeof window.__itDebug.preferences.normalize === 'function'`));
    check('偏好默认值保留薄樱浅色玻璃', await page.evaluate(`(() => {
      const defaults = window.__itDebug.preferences?.normalize({});
      return defaults?.appearance?.mode === 'light' &&
        defaults?.appearance?.palette === 'sakura' &&
        defaults?.appearance?.material === 'glass' &&
        defaults?.appearance?.glassStrength === 100 &&
        defaults?.translation?.defaultTab === 'text';
    })()`));
    await page.evaluate(`window.__itDebug.preferences.apply(
      window.__itDebug.preferences.normalize({
        background: { data: 'data:image/png;base64,AA==' }
      }))`);
    await page.click('#brand');
    await page.click('#more-menu [data-act="bg-reset"]');
    await page.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'false'`);
    check('更多菜单恢复默认背景会预览清除且可撤销', await page.evaluate(`
      document.getElementById('it-pref-background-status').textContent === '未选择背景图片。' &&
      !document.getElementById('it-bg-style')`));
    await page.key('Escape');
    await page.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'true'`);
    check('取消背景恢复会保留原图', await page.evaluate(`!!document.getElementById('it-bg-style')`));
    await page.evaluate(`window.__itDebug.preferences.apply(window.__itDebug.preferences.defaults)`);
    const nativeSnapshotCheck = await page.evaluate(`(() => {
      const api = window.__itDebug.preferences;
      const preferences = api.normalize({ appearance: { mode: 'system', palette: 'sage' } });
      const snapshot = JSON.parse(api.nativeSnapshot(preferences));
      const allModesValid = ['system', 'light', 'dark'].every((mode) => {
        const candidate = api.normalize({ appearance: { mode: mode, material: 'solid' } });
        const stored = JSON.parse(api.nativeSnapshot(candidate));
        return stored.mode === mode && stored.light.dark === false && stored.dark.dark === true &&
          stored.dark.surface === '#FF302C38';
      });
      return { valid: allModesValid && snapshot.mode === 'system' && snapshot.light.dark === false && snapshot.dark.dark === true &&
        snapshot.light.accent === '#FF66876F' && snapshot.dark.accent === '#FF83A58B' &&
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
    check('纯色材质使用不透明卡片并关闭玻璃模糊', await page.evaluate(`(() => {
      const api = window.__itDebug.preferences;
      api.apply(api.normalize({ appearance: { material: 'solid' } }));
      const card = getComputedStyle(document.querySelector('.card'));
      const opaque = card.backgroundColor === 'rgb(255, 255, 255)' &&
        card.backdropFilter === 'none';
      api.apply(api.defaults);
      return opaque;
    })()`));

    await page.click('#brand');
    await page.click('#more-menu [data-act="settings"]');
    await page.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'false'`);
    check('网页与安卓界面可直接打开通用设置',
      await page.evaluate(`!!document.querySelector('#it-pref-theme') &&
        !!document.querySelector('[data-pref-section="appearance"]')`));

    await page.evaluate(`(() => {
      const control = document.getElementById('it-pref-theme');
      if (!control) return;
      control.value = 'dark';
      control.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    check('外观草稿实时预览深色主题', await page.evaluate(`
      document.documentElement.dataset.itTheme === 'dark'`));
    await page.key('Escape');
    await page.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'true'`);
    check('Escape 取消恢复已保存外观', await page.evaluate(`
      document.documentElement.dataset.itTheme === 'light'`));

    await page.click('#brand');
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
        const input = document.querySelector('[data-pref="' + path + '"]');
        if (input.type === 'checkbox') input.checked = value;
        else input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setPreference('translation.defaultTab', 'doc');
      setPreference('translation.sourceLanguage', 'auto');
      setPreference('translation.targetLanguage', 'en');
      setPreference('translation.defaultModels.text', 'index-mt-9b');
      setPreference('translation.rememberLanguages', false);
      setPreference('translation.rememberModels', false);
    })()`);
    await page.click('#it-set-save');
    await page.until(`document.querySelector('.it-set-mask')?.getAttribute('aria-hidden') === 'true'`);
    check('网页保存偏好后保留预览并持久化完整配置', await page.evaluate(`(() => {
      const saved = JSON.parse(localStorage.getItem('it-preferences') || 'null');
      return document.documentElement.dataset.itTheme === 'dark' &&
        saved?.appearance?.mode === 'dark' && saved?.appearance?.palette === 'sage' &&
        saved?.translation?.defaultTab === 'doc' &&
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
    const created = await page.send('Target.createTarget', { url: 'about:blank' });
    desktopTargetId = created.targetId;
    const desktopTargets = await (await fetch(`${DEBUG_ORIGIN}/json`)).json();
    const target = desktopTargets.find((item) => item.id === desktopTargetId);
    if (!target) throw new Error('CDP did not expose the isolated desktop test tab.');
    const desktop = await Cdp.connect(target.webSocketDebuggerUrl);
    await prepare(desktop, true);
    await desktop.click('#brand');
    await desktop.click('#more-menu [data-act="settings"]');
    await desktop.until(`document.querySelector('.it-set-mask').getAttribute('aria-hidden') === 'false'`);
    check('桌面设置将焦点带入对话框',
      await desktop.evaluate(`document.querySelector('.it-set').contains(document.activeElement)`));
    check('桌面设置隔离背景输入焦点',
      await desktop.evaluate(`(() => {
        document.getElementById('src').focus();
        return document.activeElement.id !== 'src';
      })()`));
    await desktop.until(`!document.getElementById('it-set-save').disabled`);
    await desktop.click('[data-pref-tab="desktop"]');
    await desktop.click('[data-reset-section]');
    check('恢复电脑功能默认值不会重置通用外观', await desktop.evaluate(`
      document.documentElement.dataset.itTheme === 'dark' &&
      document.documentElement.dataset.itPalette === 'sage'`));
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
      !document.getElementById('it-set-save').disabled`);
    await desktop.evaluate(`(() => {
      const setPreference = (path, value) => {
        const control = document.querySelector('[data-pref="' + path + '"]');
        if (control.type === 'checkbox') control.checked = value;
        else control.value = value;
        control.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setPreference('appearance.mode', 'dark');
      setPreference('appearance.palette', 'amber');
      setPreference('appearance.material', 'frosted');
      setPreference('appearance.glassStrength', 45);
      setPreference('appearance.radius', 'small');
      setPreference('appearance.fontScale', 130);
      setPreference('appearance.layout', 'compact');
      setPreference('appearance.motion', 'reduced');
      setPreference('appearance.ambientLight', false);
    })()`);
    await desktop.click('[data-pref-tab="appearance"]');
    await desktop.click('[data-reset-section]');
    check('恢复外观默认值保留阅读布局与动效分组草稿', await desktop.evaluate(`(() => {
      const value = (path) => document.querySelector('[data-pref="' + path + '"]').value;
      return value('appearance.mode') === 'light' && value('appearance.palette') === 'sakura' &&
        value('appearance.material') === 'glass' && value('appearance.glassStrength') === '100' &&
        value('appearance.radius') === 'round' && value('appearance.fontScale') === '130' &&
        value('appearance.layout') === 'compact' && value('appearance.motion') === 'reduced' &&
        !document.querySelector('[data-pref="appearance.ambientLight"]').checked;
    })()`));
    await desktop.evaluate(`(() => {
      const theme = document.getElementById('it-pref-theme');
      theme.value = 'dark';
      theme.dispatchEvent(new Event('change', { bubbles: true }));
      window.__motionTest.saveDelay = 10000;
    })()`);
    await desktop.click('#it-set-save');
    check('保存处理中禁用编辑、类别导航和关闭控件', await desktop.evaluate(`(() => {
      const controls = [...document.querySelectorAll(
        '.it-set-mask .it-set-body input, .it-set-mask .it-set-body select, ' +
        '.it-set-mask .it-set-nav button, .it-set-mask [data-close], ' +
        '.it-set-mask [data-reset-section], #it-set-save')];
      return controls.length > 0 && controls.every((control) => control.disabled);
    })()`));
    await desktop.key('Escape');
    check('保存处理中 Escape 不撤销或关闭提交', await desktop.evaluate(`
      document.querySelector('.it-set-mask').getAttribute('aria-hidden') === 'false' &&
      document.documentElement.dataset.itTheme === 'dark'`));
    await desktop.evaluate(`window.__motionTest.resolveSave()`);
    await desktop.until(`document.querySelector('.it-set-mask').getAttribute('aria-hidden') === 'true'`);
    check('异步保存使用提交快照并在完成后保留同一份偏好', await desktop.evaluate(`(() => {
      const submitted = window.__motionTest.submittedSettings;
      const saved = window.__motionTest.savedSettings;
      const local = JSON.parse(localStorage.getItem('it-preferences') || 'null');
      return submitted && saved && JSON.stringify(submitted) === JSON.stringify(saved) &&
        JSON.stringify(saved.preferences) === JSON.stringify(local) &&
        local.appearance.mode === 'dark' && local.appearance.fontScale === 130 &&
        local.appearance.layout === 'compact' && local.appearance.motion === 'reduced' &&
        local.appearance.ambientLight === false && document.documentElement.dataset.itTheme === 'dark';
    })()`));
  });

  for (const connection of connections.filter((connection) => connection !== controller)) {
    check('页面无 JavaScript 异常', connection.errors.length === 0, connection.errors.join(' | '));
    check('交互验收没有访问外网', connection.blockedRequests.length === 0,
      connection.blockedRequests.join(' | '));
  }
} catch (error) {
  check('验收环境可用', false, error.stack || error.message);
} finally {
  for (const targetId of [desktopTargetId, mainTargetId].filter(Boolean)) {
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
