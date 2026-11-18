/* Source-bound safety contracts; no real clipboard, windows or registry reads. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
console.log('Windows input safety and shared transport contracts passed.');
