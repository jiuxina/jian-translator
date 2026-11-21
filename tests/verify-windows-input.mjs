/* Source-bound safety contracts; no real clipboard, windows or registry reads. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = new TextDecoder('utf-8', { fatal: true }).decode(
  await readFile(new URL('../desktop/patch/setup.rs', import.meta.url))).replace(/\r\n/g, '\n');
assert.match(source, /clipboard_shortcut:\s*String/, 'Clipboard translation has its own persistent shortcut');
assert.match(source, /DEFAULT_CLIPBOARD_SHORTCUT:\s*&str\s*=\s*"Ctrl\+Alt\+V"/);
assert.match(source, /fn default_clipboard_shortcut\([\s\S]*?Shortcut::from_str\(candidate\)[\s\S]*?occupied\.iter\(\)\.any/,
  'Legacy settings select a clipboard shortcut distinct from existing bindings');
assert.match(source, /if !popup_request_is_current\(generation\)\s*\{\s*return;\s*\}\s*if let Some\(window\) = show_app/,
  'A superseded shortcut cannot later reveal or focus the window');
assert.match(source, /fn run_clipboard_translate\([\s\S]*?window\.show\(\)[\s\S]*?read_clipboard_text\(\)[\s\S]*?window\.eval\(&script\)/,
  'The explicit shortcut reads text, reveals the main window and delivers through the webview');
assert.match(source, /window\.__itTranslateClipboard/);
assert.match(source, /clipboard_shortcut\)\s*\{\s*if hotkey\.eq\(event\)\s*\{\s*run_clipboard_translate/,
  'The native clipboard read is reached from the registered shortcut handler');
assert.match(source, /let clipboard = settings\.clipboard_shortcut\.trim\(\)/);
assert.match(source, /clipboard_shortcut: clipboard\.to_string\(\)/);
const shortcuts = source.slice(source.indexOf('pub fn set_global_shortcut('));
assert.match(shortcuts, /ShortcutState::Pressed/, 'Released events must never trigger actions');
const clipboard = source.slice(source.indexOf('fn read_clipboard_text()'), source.indexOf('pub fn it_write_clipboard_text('));
assert.match(clipboard, /GlobalSize\(handle\)/, 'Allocation size bounds the clipboard read');
assert.doesNotMatch(clipboard, /while\s+\*wide\.add/, 'Never scan an unbounded pointer');
assert.match(clipboard, /position\(/, 'Find the UTF-16 terminator inside the bounded slice');
assert.match(source, /__itTranslateSelection\(t,\s*(?:id|requestId)\)/, 'Native deliveries carry a stable request ID');
assert.match(source, /__itSelectionAccepted/, 'Acknowledged selection is not delivered again');
assert.match(source, /cfg\(debug_assertions\)/, 'Release builds cannot append diagnostic messages');
assert.match(source, /ItTranslationStream\.request/, 'Popup uses the same validated transport as the Web UI');
assert.ok(shortcuts.indexOf('shortcut_event.state()') < shortcuts.indexOf('last_triggered.lock()'),
  'Release filtering precedes debounce state mutation');
assert.match(source, /message\.chars\(\)\.take\(1024\)/, 'Diagnostic payloads have a fixed length limit');
assert.match(source, /metadata\.len\(\) >= 262_144/, 'Development log rotation has a fixed byte bound');
const selectionStart = source.indexOf('"(function(t,id)');
const selectionEnd = source.indexOf('\n                    );', selectionStart);
assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
const literal = source.slice(selectionStart, selectionEnd).trim();
const selectionEval = JSON.parse(literal.replace(/\\\n\s*/g, ''))
  .replaceAll('{{', '{').replaceAll('}}', '}')
  .replace('{json}', JSON.stringify('synthetic selection')).replace('{id}', '42');
const context = vm.createContext({ window: {} });
vm.runInContext(selectionEval, context);
assert.equal(context.window.__itPendingSelection.text, 'synthetic selection');
assert.equal(context.window.__itPendingSelection.id, 42, 'A not-ready page retains request identity');
let calls = 0;
context.window.__itTranslateSelection = (text, id) => {
  calls++;
  context.window.__itSelectionAccepted = id;
  context.window.input = text;
};
vm.runInContext(selectionEval, context);
context.window.input = 'newer manual edit';
for (let retry = 0; retry < 4; retry++) vm.runInContext(selectionEval, context);
assert.equal(calls, 1, 'Acknowledged retry never re-enters the translation handler');
assert.equal(context.window.input, 'newer manual edit', 'Acknowledged retry preserves newer manual input');

const clipboardDeliveryStart = source.indexOf('"(function(t,id){{', source.indexOf('fn run_clipboard_translate('));
const clipboardDeliveryEnd = source.indexOf('\n        );', clipboardDeliveryStart);
assert.ok(clipboardDeliveryStart >= 0 && clipboardDeliveryEnd > clipboardDeliveryStart,
  'Native clipboard delivery script is extractable');
const clipboardDeliveryLiteral = source.slice(clipboardDeliveryStart, clipboardDeliveryEnd).trim();
const clipboardDelivery = JSON.parse(clipboardDeliveryLiteral.replace(/\\\n\s*/g, ''))
  .replaceAll('{{', '{').replaceAll('}}', '}')
  .replace('{text}', JSON.stringify('synthetic clipboard')).replace('{id}', '43');
const deliveryContext = vm.createContext({ window: {} });
vm.runInContext(clipboardDelivery, deliveryContext);
assert.deepEqual(JSON.parse(JSON.stringify(deliveryContext.window.__itPendingSelection)), {
  text: 'synthetic clipboard', id: 43, kind: 'clipboard'
});
let clipboardDeliveryCalls = 0;
deliveryContext.window.__itTranslateClipboard = (text, id) => {
  clipboardDeliveryCalls++;
  deliveryContext.window.__itClipboardTranslationAccepted = String(id);
  deliveryContext.window.input = text;
};
vm.runInContext(clipboardDelivery, deliveryContext);
deliveryContext.window.input = 'newer clipboard edit';
vm.runInContext(clipboardDelivery, deliveryContext);
assert.equal(clipboardDeliveryCalls, 1, 'Acknowledged clipboard delivery cannot override a later edit');
assert.equal(deliveryContext.window.input, 'newer clipboard edit');

const appSource = new TextDecoder('utf-8', { fatal: true }).decode(
  await readFile(new URL('../web/app.js', import.meta.url))).replace(/\r\n/g, '\n');
const clipboardHandlerStart = appSource.indexOf('window.__itTranslateClipboard = function');
const clipboardHandlerEnd = appSource.indexOf('function consumePendingSelection()', clipboardHandlerStart);
assert.ok(clipboardHandlerStart >= 0 && clipboardHandlerEnd > clipboardHandlerStart,
  'The clipboard callback can be exercised independently');
const clipboardCalls = [];
const notices = [];
const appContext = vm.createContext({
  window: { __itTranslateSelection: (text, id) => clipboardCalls.push([text, id]) },
  toast: message => notices.push(message), String
});
vm.runInContext(appSource.slice(clipboardHandlerStart, clipboardHandlerEnd), appContext);
appContext.window.__itTranslateClipboard(' synthetic clipboard ', 7);
appContext.window.__itTranslateClipboard('duplicate', 7);
appContext.window.__itTranslateClipboard('  ', 8);
assert.deepEqual(clipboardCalls, [[' synthetic clipboard ', '7']],
  'One clipboard request forwards through the existing auto-translation entry point');
assert.deepEqual(notices, ['剪贴板是空的']);
const bootstrapMarker = 'const POPUP_BOOTSTRAP: &str = r#"';
const bootstrapStart = source.indexOf(bootstrapMarker) + bootstrapMarker.length;
const bootstrapEnd = source.indexOf('"#;', bootstrapStart);
new vm.Script(source.slice(bootstrapStart, bootstrapEnd));
console.log('Windows input safety and shared transport contracts passed.');
