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
const hotkeyContext = vm.createContext({
  canonicalShortcut: core.canonicalShortcut,
  clipboard: { readText: () => { hotkeyContext.reads++; return 'synthetic clipboard'; } },
  hotkeysEnabled: true,
  showMain: () => { hotkeyContext.shown++; },
  notifyAction: action => hotkeyContext.actions.push(action),
  translateSelection() {},
  cancelSelectionCapture() {}, activeSelectionOperation: null, popupWindow: null,
  clipboardTranslationSequence: 0,
  reads: 0, shown: 0, actions: [],
  JSON, globalShortcut: { register() {}, unregister() {} }
});
vm.runInContext(`${mainSource.slice(hotkeyStart, hotkeyEnd)}\nglobalThis.handlers = shortcutHandlers({
  activation_shortcut: 'Cmd+Alt+I', selection_shortcut: 'Cmd+Alt+T', clipboard_shortcut: 'Cmd+Alt+V'
});`, hotkeyContext);
const clipboardHandler = hotkeyContext.handlers.find(([accelerator]) => accelerator === 'Cmd+Alt+V')[1];
clipboardHandler();
assert.equal(hotkeyContext.reads, 1, 'The shortcut reads synthetic clipboard text only when invoked');
assert.equal(hotkeyContext.shown, 1, 'The clipboard shortcut shows the main window');
assert.deepEqual(JSON.parse(JSON.stringify(hotkeyContext.actions[0])), {
  type: 'translate-clipboard', text: 'synthetic clipboard', id: 1
});
hotkeyContext.hotkeysEnabled = false;
clipboardHandler();
assert.equal(hotkeyContext.reads, 1, 'Disabled hotkeys do not read clipboard contents');
hotkeyContext.hotkeysEnabled = true;
hotkeyContext.clipboard.readText = () => { throw new Error('synthetic read failure'); };
clipboardHandler();
assert.equal(hotkeyContext.actions.at(-1).type, 'clipboard-translation-error',
  'A clipboard read failure is reported to the visible main window');
console.log('macOS native IPC boundaries, resource paths, settings and shared popup passed.');
