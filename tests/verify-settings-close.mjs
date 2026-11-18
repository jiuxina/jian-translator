/*
 * Exercises the production settings-surface close callback with a synthetic
 * DOM/animation boundary. It does not open a browser or read user data.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = new TextDecoder('utf-8', { fatal: true })
  .decode(await readFile(new URL('../web/app.js', import.meta.url))).replace(/\r\n/g, '\n');

function productionFunction(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `production function exists: ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated production function: ${name}`);
}

const css = new TextDecoder('utf-8', { fatal: true })
  .decode(await readFile(new URL('../web/theme.css', import.meta.url))).replace(/\r\n/g, '\n');
const state = {
  classes: new Set(['on', 'it-surface-leave']),
  properties: new Map(),
  frames: [],
  animation: null,
  reduced: false,
  done: false,
};
const surface = {
  classList: {
    toggle(name, enabled) {
      if (enabled) state.classes.add(name); else state.classes.delete(name);
    },
    contains(name) { return state.classes.has(name); },
    remove(name) { state.classes.delete(name); },
  },
  style: {
    setProperty(name, value) { state.properties.set(name, String(value)); },
    removeProperty(name) { state.properties.delete(name); },
  },
  children: [],
  childNodes: [],
  matches() { return false; },
};

const context = vm.createContext({
  getComputedStyle() {
    return {
      transform: 'none',
      getPropertyValue(name) { return state.properties.get(name) || '1'; },
    };
  },
  document: { createElement() { throw new Error('no DOM creation expected'); } },
  settingsRevealProperty: true,
  DIALOG_DURATION: 240,
  SCENE_EASE: 'linear',
  motions: new Map(),
  motionReduced() { return state.reduced; },
  surfaceTransform() { return 'translate(0px, 0px) scale(0.5)'; },
  requestAnimationFrame() { return 1; },
  cancelAnimationFrame() {},
  followSettingsReveal() {},
});
surface.animate = function (frames) {
  const animation = {
    frames,
    effect: { getComputedTiming() { return { progress: 1 }; } },
    cancel() {},
    onfinish: null,
  };
  state.animation = animation;
  state.frames.push(frames);
  return animation;
};
vm.runInContext(productionFunction('stopMotion'), context);
vm.runInContext(productionFunction('playMotion'), context);
vm.runInContext(productionFunction('moveSettingsSurface'), context);
context.surface = surface;
context.state = state;

function completeAnimation() {
  assert.equal(typeof state.animation.onfinish, 'function', 'animation has a completion handler');
  state.animation.onfinish();
}

vm.runInContext('moveSettingsSurface(surface, null, false, function () { state.done = true; })', context);
assert.equal(state.properties.get('--it-settings-reveal'), '1', 'closing begins from fully visible');
assert.equal(state.frames.at(-1)[1]['--it-settings-reveal'], '0', 'close animates to transparent');
completeAnimation();

assert.equal(state.done, true, 'close animation completes');
assert.equal(state.properties.get('--it-settings-reveal'), '0',
  'closed settings surface stays transparent after animation fill is cancelled');
assert.equal(state.classes.has('it-surface-leave'), false, 'close callback releases the leave marker');

state.done = false;
vm.runInContext('moveSettingsSurface(surface, null, true, function () { state.done = true; })', context);
assert.equal(state.properties.get('--it-settings-reveal'), '0', 'reopen starts from the stored hidden state');
assert.equal(state.frames.at(-1)[1]['--it-settings-reveal'], '1', 'reopen animates to visible');
completeAnimation();
assert.equal(state.properties.get('--it-settings-reveal'), '1', 'reopen leaves the visible terminal value');
assert.equal(state.classes.has('on'), true, 'reopened surface remains active');
console.log('PASS close and reopen retain their visual terminal states');

vm.runInContext('moveSettingsSurface(surface, null, false)', context);
const staleCloseFinish = state.animation.onfinish;
vm.runInContext('moveSettingsSurface(surface, null, true)', context);
staleCloseFinish();
assert.equal(state.classes.has('on'), true, 'cancelled close callback cannot hide a reopened surface');
completeAnimation();
assert.equal(state.properties.get('--it-settings-reveal'), '1', 'latest open animation owns final state');
console.log('PASS reopening during close invalidates the stale completion callback');

state.reduced = true;
state.done = false;
vm.runInContext('moveSettingsSurface(surface, null, false, function () { state.done = true; })', context);
assert.equal(state.done, true, 'reduced motion completes synchronously');
assert.equal(state.properties.get('--it-settings-reveal'), '0', 'reduced motion still leaves the surface hidden');
assert.equal(state.classes.has('it-surface-leave'), false, 'reduced motion clears the leave marker');
assert.match(css, /\.it-set-mask\s*\{[\s\S]*?transition:\s*none;/,
  'mask visibility does not remain visible after its exit callback');
console.log('PASS reduced motion hides without a post-close flash');
