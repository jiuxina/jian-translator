import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const core = require('../app/macos/core.cjs');
const webRoot = path.resolve('web');
const shellRoot = path.resolve('app/macos');
assert.equal(core.defaultSettings().selection_shortcut, 'Cmd+Alt+T');
assert.equal(core.defaultSettings().activation_shortcut, 'Cmd+Alt+I');
assert.equal(core.defaultSettings().clipboard_shortcut, 'Cmd+Alt+V');
assert.equal(core.canonicalShortcut('Command+Option+K'), 'Cmd+Alt+K');
assert.deepEqual(core.normalizeSettings({}), core.defaultSettings());
assert.equal(core.normalizeSettings({ selection_shortcut: 'Cmd+Alt+V' }).clipboard_shortcut,
  'Cmd+Ctrl+Alt+V', 'Legacy shortcut settings migrate to a non-conflicting clipboard key');
assert.throws(() => core.normalizeSettings({ target_lang: 'bad' }), /语言/);
assert.throws(() => core.normalizeSettings({ auto_start: 'yes' }), /开关/);
assert.throws(() => core.normalizeSettings({
  selection_shortcut: 'Cmd+Alt+I', activation_shortcut: 'cmd+alt+i'
}), /不能重复/);
assert.throws(() => core.normalizeSettings({
  selection_shortcut: 'Cmd+Alt+V', clipboard_shortcut: 'cmd+alt+v'
}), /不能重复/);
const input = { preferences: { version: 3, updates: { autoCheck: false } } };
const normalized = core.normalizeSettings(input);
input.preferences.updates.autoCheck = true;
assert.equal(normalized.preferences.updates.autoCheck, false, 'settings must keep an independent JSON snapshot');
assert.equal(core.resolveResource(core.MAIN_URL, webRoot, shellRoot), path.join(webRoot, 'index.html'));
assert.equal(core.resolveResource('jian://app/theme.css?v=19', webRoot, shellRoot), path.join(webRoot, 'theme.css'));
assert.equal(core.resolveResource(core.POPUP_URL, webRoot, shellRoot), path.join(shellRoot, 'popup.html'));
assert.equal(core.resolveResource('jian://app/__popup/bootstrap.js', webRoot, shellRoot),
  path.join(shellRoot, '.generated/popup-bootstrap.js'));
for (const url of [
  'file:///etc/passwd', 'https://app/index.html', 'jian://app.evil/index.html',
  'jian://app:123/index.html', 'jian://user@app/index.html',
  'jian://app/%2f..%2fsecret.js', 'jian://app/%5c..%5csecret.js',
  'jian://app/a%00.js', 'jian://app/__popup/secret.js', 'jian://app/local.properties'
]) assert.equal(core.resolveResource(url, webRoot, shellRoot), null, url);
function windowFixture(url) {
  const frame = { url };
  return {
    isDestroyed: () => false,
    webContents: { mainFrame: frame }
  };
}
const main = windowFixture(core.MAIN_URL);
const popup = windowFixture(core.POPUP_URL);
const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
assert.equal(core.authorizeCommand(event(main), 'it_get_settings', main, popup), 'main');
assert.equal(core.authorizeCommand(event(main), 'it_read_clipboard_text', main, popup), 'main');
assert.equal(core.authorizeCommand(event(popup), 'it_write_clipboard_text', main, popup), 'popup');
assert.throws(() => core.authorizeCommand(event(main), 'it_write_clipboard_text', main, popup), /悬浮窗/);
assert.throws(() => core.authorizeCommand(event(popup), 'it_list_system_fonts', main, popup), /主窗口/);
assert.throws(() => core.authorizeCommand(event(popup), 'it_read_clipboard_text', main, popup), /主窗口/);
assert.throws(() => core.authorizeCommand(event(main), 'arbitrary-command', main, popup), /来源/);
assert.throws(() => core.authorizeCommand({
  sender: main.webContents, senderFrame: { url: core.MAIN_URL }
}, 'it_get_settings', main, popup), /来源/);
main.webContents.mainFrame.url = 'https://github.com/jiuxina/jian-translator';
assert.throws(() => core.authorizeCommand(event(main), 'it_get_settings', main, popup), /主窗口/);
const source = await readFile('desktop/patch/setup.rs', 'utf8');
const marker = 'const POPUP_BOOTSTRAP: &str = r#"';
const start = source.indexOf(marker) + marker.length;
const end = source.indexOf('"#;', start);
const shared = source.slice(start, end);
assert.equal(await readFile('app/macos/.generated/popup-bootstrap.js', 'utf8'), shared);
assert.ok(shared.includes("window.__JIAN_DESKTOP__.invoke('it_write_clipboard_text'"));

const mainSource = await readFile('app/macos/main.cjs', 'utf8');
const hotkeyStart = mainSource.indexOf('function shortcutHandlers(');
const hotkeyEnd = mainSource.indexOf('\nfunction registerShortcuts(', hotkeyStart);
assert.ok(hotkeyStart >= 0 && hotkeyEnd > hotkeyStart, 'Clipboard shortcut logic is independently testable');
function clipboardFixture() {
  const context = vm.createContext({
    canonicalShortcut: core.canonicalShortcut,
    clipboard: {
      read: async () => {
        context.reads++;
        return [{ types: ['text/plain'], getType: async () => new Blob(['synthetic clipboard']) }];
      },
      readText: async () => { context.textReads++; return 'synthetic clipboard'; }
    },
    hotkeysEnabled: true,
    mainWindow: null,
    showMain: () => { context.shown++; },
    notifyAction: action => context.actions.push(action),
    translateSelection() {},
    cancelSelectionCapture() {}, activeSelectionOperation: null, popupWindow: null,
    clipboardTranslationSequence: 0,
    reads: 0, textReads: 0, shown: 0, actions: [],
    Buffer, JSON, globalShortcut: { register() {}, unregister() {} }
  });
  vm.runInContext(`${mainSource.slice(hotkeyStart, hotkeyEnd)}\nglobalThis.handlers = shortcutHandlers({
    activation_shortcut: 'Cmd+Alt+I', selection_shortcut: 'Cmd+Alt+T', clipboard_shortcut: 'Cmd+Alt+V'
  });`, context);
  return {
    context,
    trigger: key => context.handlers.find(([accelerator]) => accelerator === key)[1](),
    actions: () => JSON.parse(JSON.stringify(context.actions.filter(action => action.type !== 'clipboard-translation-start')))
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
{
  const test = clipboardFixture();
  assert.equal(test.context.reads, 0, 'Registering shortcuts never reads the clipboard');
  await test.trigger('Cmd+Alt+V');
  assert.equal(test.context.reads, 1, 'The shortcut reads a clipboard snapshot only when invoked');
  assert.equal(test.context.shown, 1, 'The clipboard shortcut immediately shows the main window');
  assert.deepEqual(test.actions(), [{
    type: 'translate-clipboard', text: 'synthetic clipboard', image: '', id: 1
  }]);
  test.context.hotkeysEnabled = false;
  await test.trigger('Cmd+Alt+V');
  assert.equal(test.context.reads, 1, 'Disabled hotkeys never read clipboard contents');
}
{
  const test = clipboardFixture();
  test.context.clipboard.read = async () => [{
    types: ['text/plain', 'image/png'],
    getType: async type => {
      assert.equal(type, 'image/png', 'Images take precedence over text in one clipboard snapshot');
      return new Blob(['synthetic png'], { type });
    }
  }];
  await test.trigger('Cmd+Alt+V');
  assert.deepEqual(test.actions(), [{ type: 'translate-clipboard', text: '',
    image: `data:image/png;base64,${Buffer.from('synthetic png').toString('base64')}`, id: 1 }]);
  assert.equal(test.context.textReads, 0, 'Image translation never reads unrelated clipboard text');
}
{
  const test = clipboardFixture();
  test.context.clipboard.read = async () => [{
    types: ['text/plain'], getType: async () => new Blob(['snapshot text'], { type: 'text/plain' })
  }];
  await test.trigger('Cmd+Alt+V');
  assert.equal(test.actions()[0].text, 'snapshot text');
  assert.equal(test.context.textReads, 0, 'Plain text uses the same clipboard snapshot');
}
{
  const test = clipboardFixture();
  test.context.clipboard.read = async () => [];
  await test.trigger('Cmd+Alt+V');
  assert.deepEqual(test.actions(), [{ type: 'translate-clipboard', text: '', image: '', id: 1 }],
    'An empty clipboard is delivered as empty content for the existing UI notice');
}
{
  const test = clipboardFixture();
  const oldRead = deferred();
  test.context.clipboard.read = () => oldRead.promise;
  const older = test.trigger('Cmd+Alt+V');
  assert.equal(test.context.actions[0].type, 'clipboard-translation-start',
    'The frontend observes the request before asynchronous clipboard access finishes');
  test.context.clipboard.read = async () => [];
  await test.trigger('Cmd+Alt+V');
  oldRead.resolve([]);
  await older;
  assert.deepEqual(test.actions().map(action => action.id), [2], 'A newer clipboard shortcut discards the previous read');
  assert.equal(test.context.shown, 2, 'Late clipboard completion never reveals the window again');
}
{
  const test = clipboardFixture();
  const oldBytes = deferred();
  const started = deferred();
  test.context.clipboard.read = async () => [{ types: ['image/png'], getType: async () => ({
    size: 10, arrayBuffer() { started.resolve(); return oldBytes.promise; }
  }) }];
  const older = test.trigger('Cmd+Alt+V');
  await started.promise;
  await test.trigger('Cmd+Alt+I');
  oldBytes.resolve(Buffer.from('stale image'));
  await older;
  assert.equal(test.actions().length, 0, 'Another desktop shortcut discards delayed image decoding');
}
{
  const test = clipboardFixture();
  const oldRead = deferred();
  test.context.clipboard.read = () => oldRead.promise;
  const pending = test.trigger('Cmd+Alt+V');
  test.context.hotkeysEnabled = false;
  oldRead.resolve([]);
  await pending;
  assert.equal(test.actions().length, 0, 'Disabling hotkeys also suppresses an already pending read');
}
{
  const test = clipboardFixture();
  test.context.clipboard.read = async () => { throw new Error('synthetic read failure'); };
  await test.trigger('Cmd+Alt+V');
  assert.deepEqual(test.actions(), [{ type: 'translate-clipboard', error: '读取剪贴板失败', id: 1 }]);
  const delayedFailure = deferred();
  test.context.clipboard.read = () => delayedFailure.promise;
  const older = test.trigger('Cmd+Alt+V');
  test.context.clipboard.read = async () => [];
  await test.trigger('Cmd+Alt+V');
  delayedFailure.reject(new Error('stale failure'));
  await older;
  assert.deepEqual(test.actions().map(action => action.id), [1, 3], 'A stale read failure never reports against the latest request');
}
{
  const test = clipboardFixture();
  test.context.clipboard.read = async () => [{ types: ['image/png'], getType: async () => ({
    size: 32 * 1024 * 1024 + 1, arrayBuffer() { throw new Error('must reject before materializing an oversized image'); }
  }) }];
  await test.trigger('Cmd+Alt+V');
  assert.equal(test.actions()[0].error, '读取剪贴板失败', 'Oversized clipboard images produce a visible failure');
}
console.log('macOS native IPC boundaries, resource paths, settings and shared popup passed.');
