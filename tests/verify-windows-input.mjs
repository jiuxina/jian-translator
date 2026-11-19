/* Source-bound safety contracts; no real clipboard, windows or registry reads. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = new TextDecoder('utf-8', { fatal: true }).decode(
  await readFile(new URL('../desktop/patch/setup.rs', import.meta.url))).replace(/\r\n/g, '\n');
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
const bootstrapMarker = 'const POPUP_BOOTSTRAP: &str = r#"';
const bootstrapStart = source.indexOf(bootstrapMarker) + bootstrapMarker.length;
const bootstrapEnd = source.indexOf('"#;', bootstrapStart);
new vm.Script(source.slice(bootstrapStart, bootstrapEnd));
console.log('Windows input safety and shared transport contracts passed.');
