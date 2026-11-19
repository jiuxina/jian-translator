/*
 * Executes the real macOS popup lifecycle with synthetic Electron windows and
 * a manually resolved selection operation. No Electron app, user preferences,
 * clipboard, accessibility process or external request is used.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = new TextDecoder('utf-8', { fatal: true })
  .decode(await readFile('app/macos/main.cjs')).replace(/\r\n/g, '\n');
const start = source.indexOf('async function applyPopupAppearance(');
const end = source.indexOf('\nasync function handleCommand(', start);
assert.ok(start > 0 && end > start, 'The real popup lifecycle is extractable');
assert.match(source, /createMenuAndTray\(\);\s+prewarmPopup\(\);/,
  'Startup prepares the hidden local document');
const lifecycle = source.slice(start, end);
const report = { checks: [], source: 'app/macos/main.cjs', synthetic: true };

function check(name, condition) {
  assert.ok(condition, name);
  report.checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const windows = [];
  const captures = [];
  const events = [];
  const dialogs = [];
  const actions = [];
  const shortcuts = new Map();
  let foregroundPid = 42;
  let afterReadyDelivery = null;
  class SyntheticWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.visible = false;
      this.focusable = true;
      this.loaded = deferred();
      this.payloads = [];
      this.presentations = 0;
      this.webContents = new EventEmitter();
      this.webContents.executeJavaScript = async (script) => {
        if (this.destroyed) throw new Error('Synthetic window destroyed');
        if (script.includes('window.__itPopupPayload=')) {
          const json = script.slice(script.indexOf('=') + 1, script.indexOf(';'));
          this.payloads.push(JSON.parse(json));
          events.push(`payload:${this.payloads.at(-1).phase}`);
          if (this.payloads.at(-1).phase === 'ready' && afterReadyDelivery) afterReadyDelivery();
        }
        if (script.includes('window.__popupPresent()')) {
          this.presentations++;
          events.push('present');
        }
      };
      windows.push(this);
      events.push('create');
    }
    loadURL(url) {
      this.url = url;
      return this.loaded.promise;
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    setPosition(x, y) { this.position = [x, y]; }
    setFocusable(value) {
      const lostFocus = this.focused && !value;
      this.focusable = value;
      if (lostFocus) {
        this.focused = false;
        this.emit('blur');
      }
      events.push(`focusable:${value}`);
    }
    hide() {
      const lostFocus = this.focused;
      this.visible = false;
      if (lostFocus) {
        this.focused = false;
        this.emit('blur');
      }
      events.push('hide');
    }
    showInactive() {
      this.visible = true;
      events.push('show-inactive');
    }
    focus() { this.focused = true; events.push('focus'); }
    close() { this.destroy(); }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      events.push('closed');
      this.emit('closed');
    }
  }
  const context = vm.createContext({
    BrowserWindow: SyntheticWindow,
    POPUP_URL: 'jian://app/__popup/index.html',
    configureWindowSecurity() {},
    webPreferences: () => ({ isolatedSyntheticFixture: true }),
    screen: {
      getCursorScreenPoint: () => ({ x: 500, y: 300 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } })
    },
    foregroundApplicationPid: async () => foregroundPid,
    globalShortcut: {
      isRegistered: key => shortcuts.has(key),
      register(key, callback) {
        if (shortcuts.has(key)) return false;
        shortcuts.set(key, callback);
        return true;
      },
      unregister: key => shortcuts.delete(key)
    },
    AbortController,
    captureSelection: (expectedPid, signal) => {
      const operation = deferred();
      operation.expectedPid = expectedPid;
      operation.signal = signal;
      captures.push(operation);
      events.push('capture');
      return operation.promise;
    },
    showMain: () => events.push('show-main'),
    notifyAction: action => actions.push(action),
    dialog: { showErrorBox: (title, message) => dialogs.push({ title, message }) },
    queueMicrotask, JSON,
  });
  vm.runInContext(`
    let popupWindow = null, popupState = null, popupRequest = null;
    let popupSequence = 0, captureRunning = false, quitting = false, activeSelectionOperation = null;
    const settings = { preferences: {}, target_lang: 'auto', open_main_window: false };
    ${lifecycle}
    globalThis.api = { prewarmPopup, translateSelection,
      window: () => popupWindow, state: () => popupState,
      setMain: value => { settings.open_main_window = value; },
      setQuitting: () => { quitting = true; },
      isCapturing: () => captureRunning };
  `, context);
  return { ...context.api, windows, captures, events, dialogs, actions, shortcuts,
    setForeground: pid => { foregroundPid = pid; },
    onReadyDelivery: callback => { afterReadyDelivery = callback; } };
}

async function until(condition, description) {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    // A full event-loop turn drains Promise jobs from both the host and VM
    // realms without depending on how many awaits the production flow uses.
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function captureStarted(test, count) {
  await until(() => test.captures.length === count, `selection capture ${count}`);
}

async function readyWarmWindow(test) {
  test.prewarmPopup();
  const window = test.windows.at(-1);
  window.loaded.resolve();
  await test.state().ready;
  return window;
}

{
  const test = fixture();
  const window = await readyWarmWindow(test);
  const first = test.translateSelection();
  await captureStarted(test, 1);
  test.captures[0].resolve('First selection');
  await first;
  const firstId = window.payloads.at(-1).id;
  const second = test.translateSelection();
  await captureStarted(test, 2);
  check('A shortcut while the previous result is visible hides and reuses its window',
    test.windows.length === 1 && !window.destroyed && window.visible &&
    window.payloads.length === 3 && window.payloads.at(-1).phase === 'pending' &&
    window.payloads.at(-1).id > firstId && test.captures.length === 2);
  check('Hiding the old focused result cannot let its blur callback close the new pending request',
    test.isCapturing() && test.events.includes('hide') &&
    !test.events.slice(test.events.indexOf('payload:pending', test.events.indexOf('payload:ready') + 1))
      .includes('closed'));
  test.captures[1].resolve('Second selection');
  await second;
  check('The reused popup delivers the second result under the newest request ID',
    test.windows.length === 1 && window.payloads.at(-1).phase === 'ready' &&
    window.payloads.at(-1).id > firstId && window.payloads.at(-1).text === 'Second selection' &&
    window.presentations === 2);
}

{
  const test = fixture();
  const window = await readyWarmWindow(test);
  check('Prewarming neither displays a window nor reads selection',
    test.windows.length === 1 && !window.visible && test.captures.length === 0);
  const operation = test.translateSelection();
  await captureStarted(test, 1);
  check('The pending popup is shown before selection completes',
    window.visible && test.captures.length === 1 && window.payloads[0]?.phase === 'pending');
  check('The source application retains focus throughout pending capture',
    !window.focusable && !test.events.includes('focus') &&
    test.events.indexOf('show-inactive') < test.events.indexOf('capture'));
  await test.translateSelection();
  check('Repeated shortcuts cannot overlap the active copy operation',
    test.captures.length === 1 && test.windows.length === 1);
  test.captures[0].resolve('Synthetic selection');
  await operation;
  check('Captured text updates the same popup and request exactly once',
    test.windows.length === 1 && window.payloads.length === 2 &&
    window.payloads[0].id === window.payloads[1].id &&
    window.payloads[1].phase === 'ready' && window.payloads[1].text === 'Synthetic selection');
  check('The arrival hook runs once and focus starts only after ready delivery',
    window.presentations === 1 && test.events.filter(value => value === 'show-inactive').length === 1 &&
    test.events.indexOf('focus') > test.events.indexOf('payload:ready') && window.focusable);
  window.emit('blur');
  await until(() => test.windows.length === 2, 'hidden popup replacement after blur');
  check('Blur after capture closes and prepares a hidden next popup',
    window.destroyed && test.windows.length === 2 && !test.windows[1].visible &&
    test.captures.length === 1);
}

{
  const test = fixture();
  const window = await readyWarmWindow(test);
  const operation = test.translateSelection();
  await captureStarted(test, 1);
  window.close();
  await until(() => test.windows.length === 2, 'hidden popup replacement after close');
  await test.translateSelection();
  check('Closing pending capture invalidates it without starting an overlapping copy',
    window.destroyed && test.captures.length === 1 && test.isCapturing());
  test.captures[0].resolve('Late stale selection');
  await operation;
  check('Late selection after close cannot reopen or populate a replacement',
    window.payloads.length === 1 && test.windows.length === 2 &&
    !test.windows[1].visible && test.windows[1].payloads.length === 0 &&
    test.dialogs.length === 0 && !test.isCapturing());
  test.windows[1].loaded.resolve();
  await test.state().ready;
  const next = test.translateSelection();
  await captureStarted(test, 2);
  test.captures[1].resolve('New selection');
  await next;
  check('A later shortcut can use the next warm popup after the previous copy settles',
    test.windows[1].payloads.at(-1).text === 'New selection' &&
    test.windows[1].payloads[0].id > window.payloads[0].id);
}

{
  const test = fixture();
  const window = await readyWarmWindow(test);
  const operation = test.translateSelection();
  await captureStarted(test, 1);
  test.captures[0].resolve('');
  await operation;
  check('An empty selection becomes a notice in the existing popup',
    window.payloads.length === 2 && window.payloads[1].phase === 'notice' &&
    window.payloads[1].notice.includes('没有取到') && window.presentations === 1);
}

{
  const test = fixture();
  const window = await readyWarmWindow(test);
  const operation = test.translateSelection();
  await captureStarted(test, 1);
  test.captures[0].reject(new Error('Synthetic accessibility denial'));
  await operation;
  check('Capture failure updates the pending popup without opening a blocking dialog',
    window.payloads.at(-1).phase === 'notice' &&
    window.payloads.at(-1).notice === 'Synthetic accessibility denial' &&
    test.dialogs.length === 0 && !test.isCapturing());
}

{
  const test = fixture();
  test.prewarmPopup();
  test.windows[0].loaded.reject(new Error('Synthetic missing local document'));
  await until(() => test.windows[0].destroyed, 'failed prewarm cleanup');
  await new Promise(resolve => setImmediate(resolve));
  check('Failed idle prewarming neither loops nor interrupts another application',
    test.windows.length === 1 && test.windows[0].destroyed && test.dialogs.length === 0);
  const operation = test.translateSelection();
  test.windows[1].loaded.resolve();
  await captureStarted(test, 1);
  test.captures[0].resolve('Explicit retry');
  await operation;
  check('An explicit shortcut retries a failed local document once',
    test.windows.length === 2 && test.windows[1].payloads.at(-1).text === 'Explicit retry');
}

{
  const test = fixture();
  const operation = test.translateSelection();
  const window = test.windows[0];
  window.close();
  window.loaded.reject(new Error('Synthetic interrupted load'));
  await operation;
  check('Closing during initial document load does not capture or show an error',
    test.captures.length === 0 && !window.visible && test.dialogs.length === 0);
}

{
  const test = fixture();
  await readyWarmWindow(test);
  test.setMain(true);
  const operation = test.translateSelection();
  await captureStarted(test, 1);
  check('Main-window preference keeps its original capture-first destination',
    test.captures.length === 1 && !test.windows[0].visible &&
    !test.events.includes('show-main'));
  test.captures[0].resolve('Main selection');
  await operation;
  check('Main-window translation receives text after capture without popup activation',
    test.events.includes('show-main') && test.actions[0]?.type === 'translate-selection' &&
    test.actions[0]?.text === 'Main selection' && !test.windows[0].visible);
}

{
  const test = fixture();
  const window = await readyWarmWindow(test);
  const operation = test.translateSelection();
  await captureStarted(test, 1);
  check('Pending capture owns a temporary Escape shortcut without focusing the popup',
    test.shortcuts.has('Escape') && !window.focusable && !test.events.includes('focus'));
  test.shortcuts.get('Escape')();
  check('Escape invalidates and aborts pending capture while the source retains focus',
    window.destroyed && test.captures[0].signal?.aborted && !test.events.includes('focus'));
  test.captures[0].resolve('Late selection after Escape');
  await operation;
  check('An Escape-canceled request cannot publish a late result or leak its shortcut',
    window.payloads.length === 1 && !test.shortcuts.has('Escape') &&
    test.dialogs.length === 0 && !test.isCapturing());
}

{
  const test = fixture();
  const window = await readyWarmWindow(test);
  const operation = test.translateSelection();
  await captureStarted(test, 1);
  test.setForeground(99);
  test.captures[0].resolve('Selection from the previous application');
  await operation;
  check('A foreground change during capture discards the result without activating a popup',
    window.destroyed && !test.events.includes('focus') && window.payloads.length === 1 &&
    test.dialogs.length === 0 && !test.shortcuts.has('Escape'));
}

{
  const test = fixture();
  await readyWarmWindow(test);
  test.setMain(true);
  const operation = test.translateSelection();
  await captureStarted(test, 1);
  test.setForeground(99);
  test.captures[0].resolve('Old main-window selection');
  await operation;
  check('Main-window selection also refuses to steal focus from a newly active application',
    !test.events.includes('show-main') && test.actions.length === 0);
}

{
  const test = fixture();
  const window = await readyWarmWindow(test);
  test.onReadyDelivery(() => test.setForeground(99));
  const operation = test.translateSelection();
  await captureStarted(test, 1);
  test.captures[0].resolve('Selection delivered during an application switch');
  await operation;
  check('The final IPC delivery cannot bypass the foreground check before focus',
    window.destroyed && !test.events.includes('focus') && !test.shortcuts.has('Escape'));
}

{
  const test = fixture();
  await readyWarmWindow(test);
  const existingEscape = () => {};
  test.shortcuts.set('Escape', existingEscape);
  const operation = test.translateSelection();
  await captureStarted(test, 1);
  test.captures[0].resolve('Selection with an existing Escape shortcut');
  await operation;
  check('Capture never replaces or unregisters an Escape shortcut it does not own',
    test.shortcuts.get('Escape') === existingEscape);
}

const captureStart = source.indexOf('async function captureSelection(');
const captureEnd = source.indexOf('\nasync function applyPopupAppearance(', captureStart);
const scripts = [];
let captureResult = '"Synthetic text"';
const captureContext = vm.createContext({
  systemPreferences: { isTrustedAccessibilityClient: () => true },
  runFile: async (_file, args, options) => {
    scripts.push({ script: args.at(-1), options });
    return { stdout: captureResult };
  },
  JSON
});
const capture = vm.runInContext(`${source.slice(captureStart, captureEnd)}\ncaptureSelection;`, captureContext);
const signal = new AbortController().signal;
assert.equal(await capture(42, signal), 'Synthetic text');
check('The native copy script checks the expected foreground PID immediately before Cmd+C',
  scripts[0].script.indexOf('frontmostApplication') >= 0 &&
  scripts[0].script.indexOf('expectedPid') >= 0 &&
  scripts[0].script.indexOf('expectedPid', scripts[0].script.indexOf('delay(0.3)')) <
    scripts[0].script.indexOf("keystroke('c'"));
check('Canceling capture can terminate its pending helper process', scripts[0].options.signal === signal);
captureResult = 'null';
await assert.rejects(capture(42, signal), { name: 'AbortError' });
check('A native source-change result is cancellation rather than a permission error', true);

const foregroundStart = source.indexOf('async function foregroundApplicationPid(');
const foregroundSource = source.slice(foregroundStart, captureStart);
let pidResult = '42\n';
const pidContext = vm.createContext({
  runFile: async () => ({ stdout: pidResult }),
  Number
});
const foreground = vm.runInContext(`${foregroundSource}\nforegroundApplicationPid;`, pidContext);
assert.equal(await foreground(), 42);
for (pidResult of ['not-a-pid', '0', '-1', '']) assert.equal(await foreground(), null);
check('Foreground identity accepts only a positive PID and fails closed on malformed output', true);

report.passed = report.checks.length;
await mkdir('.build', { recursive: true });
await writeFile('.build/macos-popup-lifecycle.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`macOS popup lifecycle: ${report.passed}/${report.passed} targeted checks passed.`);
