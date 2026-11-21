/* Production dock handoff with synthetic geometry; never opens a user session. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = async (name) => new TextDecoder('utf-8', { fatal: true }).decode(
  await readFile(new URL(name, import.meta.url))).replace(/\r\n/g, '\n');
const source = await read('../web/app.js');
const html = await read('../web/index.html');
const android = await read('../android/app/src/main/java/ink/jian/translate/MainActivity.java');
const begin = source.indexOf('  function animateDockHandoff(');
const end = source.indexOf('  function stopTaskDockMotion(', begin);
assert.ok(begin >= 0 && end > begin, 'Production dock handoff is present');
const cases = [];
const test = (name, run) => cases.push({ name, run });
const rect = (left, top, width = 72, height = 40) =>
  ({ left, right: left + width, top, bottom: top + height, width, height });

function handoff(previous, next, viewport = { width: 390, height: 844 }) {
  const motions = [];
  const buttons = Object.fromEntries(Object.keys(next).map((role) => [role, { role }]));
  const context = vm.createContext({ window: { innerWidth: viewport.width, innerHeight: viewport.height },
    PANEL_DURATION: 420,
    playMotion(button, frames, duration, done, group, preserve) {
      motions.push({ role: button.role, frames, duration, group, preserve });
    },
  });
  vm.runInContext(source.slice(begin, end), context);
  context.animateDockHandoff(previous, buttons, next);
  return motions;
}

function shift(frame) {
  assert.equal(Object.hasOwn(frame, 'opacity'), false, 'Handoff must preserve the current button opacity');
  const value = frame.translate;
  assert.equal(typeof value, 'string', 'Independent translation preserves the pressed-button transform');
  return value.split(/\s+/).map(parseFloat);
}

test('mobile actions occupy the original/output gap without duplicated controls', () => {
  for (const [mode, input, output, go, clear] of [
    ['text', 'src', 'out-text', 'btn-go', 'btn-clear'],
    ['syllable', 'syl-src', 'out-syllable', 'btn-go-syllable', 'btn-clear-syllable'],
    ['doc', 'doc-src', 'out-doc', 'btn-go-doc', 'btn-clear-doc'],
  ]) {
    const start = html.indexOf(`id="pane-${mode}"`);
    const stop = html.indexOf('</section>', start);
    const panel = html.slice(start, stop);
    const inputAt = panel.indexOf(`id="${input}"`);
    const dockAt = panel.indexOf(`data-pane="${mode}"`);
    const outputAt = panel.indexOf(`id="${output}"`);
    assert.ok(inputAt >= 0 && dockAt > inputAt && outputAt > dockAt,
      `${mode}: the existing dock is between source and output in the same panel`);
    for (const id of [go, clear, `btn-cancel-${mode}`]) {
      assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} remains a single control`);
      assert.ok(panel.includes(`id="${id}"`), `${id} stays in its mode's dock`);
    }
  }
});

test('same-state buttons continuously hand off vertically between mobile modes', () => {
  const previous = { clear: rect(90, 300), go: rect(180, 300) };
  const next = { clear: rect(90, 350), go: rect(180, 350) };
  const motions = handoff(previous, next);
  assert.equal(motions.length, 2, 'Equal labels and states still need a vertical geometry handoff');
  for (const motion of motions) {
    assert.deepEqual(shift(motion.frames[0]), [0, -50]);
    assert.deepEqual(shift(motion.frames.at(-1)), [0, 0]);
    assert.equal(motion.group, 'dock');
    assert.equal(motion.duration, 420);
  }
});

test('horizontal handoff remains available for the desktop action group', () => {
  const motions = handoff({ clear: rect(40, 600), go: rect(160, 600) },
    { clear: rect(56, 600), go: rect(176, 600) }, { width: 1180, height: 900 });
  assert.equal(motions.length, 2);
  for (const motion of motions) assert.deepEqual(shift(motion.frames[0]), [-16, 0]);
});

test('interrupted handoff resumes from the supplied current two-dimensional position', () => {
  const motions = handoff({ go: rect(60.25, 326.25) }, { go: rect(56, 350) });
  assert.equal(motions.length, 1);
  assert.deepEqual(shift(motions[0].frames[0]), [4.25, -23.75]);
  assert.deepEqual(shift(motions[0].frames.at(-1)), [0, 0]);
});

test('stationary controls do not receive a pointless replacement animation', () => {
  const next = { clear: rect(90, 350), go: rect(180, 350) };
  assert.equal(handoff(next, next).length, 0);
});

test('a vertical swept path cannot cross a stationary cancel button', () => {
  const previous = { cancel: rect(150, 350), go: rect(150, 250) };
  const next = { cancel: rect(150, 350), go: rect(150, 450) };
  assert.equal(handoff(previous, next).length, 0, 'Unsafe two-dimensional travel falls back to settled positions');
});

test('a swept path must remain inside both viewport axes', () => {
  for (const previous of [{ go: rect(150, -12) }, { go: rect(150, 820) }, { go: rect(-10, 350) }]) {
    assert.equal(handoff(previous, { go: rect(150, 350) }).length, 0);
  }
});

test('Android exposes a lifecycle-safe UI-thread IME hide operation without clearing WebView focus', () => {
  const method = android.match(/@JavascriptInterface\s+public void hideKeyboard\(\)\s*\{([\s\S]*?)\n        \}/)?.[1];
  assert.ok(method, 'The optional JavaScript keyboard bridge is present');
  assert.match(method, /runOnUiThread\(/);
  assert.match(method, /isFinishing\(\)|isDestroyed\(\)/);
  assert.match(method, /webView\s*==\s*null/);
  assert.match(method, /WindowCompat\.getInsetsController\(getWindow\(\),\s*webView\)/);
  assert.match(method, /\.hide\(WindowInsetsCompat\.Type\.ime\(\)\)/);
  assert.doesNotMatch(method, /clearFocus|requestFocus|setLayoutParams|setSoftInputMode/);
});

const failures = [];
for (const entry of cases) {
  try { await entry.run(); console.log(`PASS ${entry.name}`); }
  catch (error) { failures.push(entry.name); console.error(`FAIL ${entry.name}: ${error.message}`); }
}
assert.deepEqual(failures, [], `Mobile action failures: ${failures.join('; ')}`);
console.log(`Mobile action handoff and keyboard contracts: ${cases.length}/${cases.length} passed.`);
