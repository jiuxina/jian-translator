/*
 * Targeted checks for gesture-owned slider geometry and batched positioning.
 * Runs the production functions with synthetic DOM metrics, without a browser,
 * user preferences, clipboard contents or translation requests.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const baseline = process.argv.includes('--baseline');
const sourceArg = process.argv.indexOf('--source');
const sourcePath = sourceArg >= 0 ? process.argv[sourceArg + 1] :
  new URL('../web/app.js', import.meta.url);
const source = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(sourcePath))
  .replace(/\r\n/g, '\n');
const start = source.indexOf('  /* ---------------- 8. 玻璃滑块');
const end = source.indexOf('  function initModelGroups()', start);
assert.ok(start >= 0 && end > start, 'Production slider functions are present');
const sliderSource = source.slice(start, end);

function classes(initial = []) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
  };
}

function fixture() {
  const events = new Map();
  const counters = { reads: 0, writes: 0, hiddenReads: 0 };
  const frameQueue = [];
  const document = { activeElement: null };
  const window = { PointerEvent: function () {} };
  let selectedIndex = 0;
  let context;

  function style(initial = {}) {
    return new Proxy({ ...initial }, {
      set(target, property, value) {
        counters.writes++;
        target[property] = value;
        return true;
      },
    });
  }

  function group(hidden = false) {
    const panel = { classList: classes(hidden ? [] : ['on']) };
    const thumb = {
      classList: classes(['ready']),
      style: style({ width: '39px', transform: 'translateX(3px)', transition: '' }),
      animations: [],
      getAnimations() { return this.animations; },
      get offsetWidth() { counters.reads++; return 39; },
    };
    const buttons = [3, 44, 85].map((left, index) => ({
      disabled: false,
      classList: classes(index === 0 ? ['on'] : []),
      get offsetLeft() { counters.reads++; if (hidden) counters.hiddenReads++; return left; },
      get offsetWidth() { counters.reads++; if (hidden) counters.hiddenReads++; return 39; },
      closest(selector) { return selector === '[inert]' ? null : this; },
      focus() { document.activeElement = this; },
      click() {
        selectedIndex = index;
        buttons.forEach((candidate) => candidate.classList.remove('on'));
        this.classList.add('on');
        context.moveThumb(box, this, true);
      },
    }));
    const box = {
      dataset: {},
      classList: classes(['models']),
      get offsetWidth() { counters.reads++; return 127; },
      getBoundingClientRect() {
        counters.reads++;
        return { left: 0, top: 0, width: 127, height: 30 };
      },
      closest(selector) { return selector === '.pane' ? panel : null; },
      querySelectorAll() { return buttons; },
      querySelector(selector) {
        if (selector === '.models-thumb, .tabs-thumb') return thumb;
        if (selector.includes('.on')) return buttons.find((candidate) => candidate.classList.contains('on'));
        return buttons[0];
      },
      setPointerCapture() {},
      hasPointerCapture() { return false; },
      releasePointerCapture() {},
    };
    return { box, buttons, thumb, panel };
  }

  const visible = group();
  const hidden = group(true);
  document.querySelectorAll = () => [visible.box, hidden.box];
  context = vm.createContext({
    document,
    window,
    performance: { now: () => 100 },
    on(target, type, listener) {
      if (!events.has(target)) events.set(target, new Map());
      const types = events.get(target);
      if (!types.has(type)) types.set(type, []);
      types.get(type).push(listener);
    },
    requestAnimationFrame(callback) { frameQueue.push(callback); return frameQueue.length; },
  });
  vm.runInContext(sliderSource, context);
  context.initSegmentDrag(visible.box);

  function emit(target, type, overrides = {}) {
    const event = {
      target: visible.buttons[0], pointerId: 1, pointerType: 'touch',
      button: 0, buttons: 1, isPrimary: true, clientX: 22.5, clientY: 15,
      detail: 0, preventDefault() {}, stopImmediatePropagation() {},
      ...overrides,
    };
    for (const listener of events.get(target)?.get(type) || []) listener(event);
  }
  return {
    context, counters, document, window, visible, hidden, emit,
    selected: () => selectedIndex,
    reset() { counters.reads = counters.writes = counters.hiddenReads = 0; },
  };
}

{
  const test = fixture();
  test.emit(test.visible.box, 'pointerdown');
  test.emit(test.document, 'pointermove', { clientX: 25.5 });
  assert.equal(test.visible.box.classList.contains('is-dragging'), false, 'Small jitter is not a drag');
  test.reset();
  for (let index = 0; index < 100; index++) {
    test.emit(test.document, 'pointermove', { clientX: 31.5 + (index % 12) * .5 });
  }
  console.log(`Steady drag layout reads over 100 pointer moves: ${test.counters.reads}`);
  if (!baseline) assert.equal(test.counters.reads, 0, 'A live gesture only uses its cached geometry');
  assert.equal(test.selected(), 0, 'Movement before the threshold preserves selection');
  test.emit(test.document, 'pointermove', { clientX: 72.5 });
  assert.equal(test.selected(), 1, 'Selection changes before pointer release');
  test.emit(test.document, 'pointermove', { clientX: 118.5 });
  assert.equal(test.selected(), 2, 'The same gesture can cross another threshold');
  test.emit(test.document, 'pointermove', { clientX: 24.5 });
  assert.equal(test.selected(), 0, 'The same gesture can reverse direction');
  test.emit(test.document, 'pointerup');
  assert.equal(test.visible.box.classList.contains('is-dragging'), false, 'Release ends gesture ownership');
  assert.equal(test.visible.thumb.style.transform, 'translateX(3px)', 'Release snaps to the selected button');
}

{
  const test = fixture();
  test.emit(test.visible.box, 'pointerdown');
  test.emit(test.document, 'pointermove', { clientX: 22.5, clientY: 40 });
  assert.equal(test.visible.box.classList.contains('is-dragging'), false, 'A vertical pan stays available');
  test.emit(test.document, 'pointermove', { clientX: 120 });
  assert.equal(test.selected(), 0, 'Vertical intent releases the horizontal gesture');
}

{
  const test = fixture();
  test.emit(test.visible.box, 'pointerdown');
  test.emit(test.document, 'pointermove', { clientX: 72.5 });
  test.emit(test.document, 'pointercancel');
  assert.equal(test.selected(), 1, 'Cancellation preserves the last selected item');
  assert.equal(test.visible.box.classList.contains('is-dragging'), false, 'Cancellation releases the gesture');
  assert.equal(test.visible.thumb.style.transform, 'translateX(44px)', 'Cancellation settles the thumb');
}

{
  const test = fixture();
  test.reset();
  test.context.positionThumbs(false);
  console.log(`Unchanged positioning writes: ${test.counters.writes}; hidden group reads: ${test.counters.hiddenReads}`);
  if (!baseline) {
    assert.equal(test.counters.writes, 0, 'Unchanged thumb targets do not write or flush');
    assert.equal(test.counters.hiddenReads, 0, 'Hidden page groups are not measured');
    let finished = 0;
    test.visible.thumb.animations.push({
      transitionProperty: 'transform', finish() { finished++; },
    });
    test.context.positionThumbs(false);
    assert.equal(finished, 1, 'Immediate boundaries finish an already-targeted transition');
  }
}

console.log('Slider gesture checks passed: thresholds, reversal, cancellation, geometry ownership and positioning.');

if (!baseline) {
  const firstShow = fixture();
  const transitions = [];
  firstShow.hidden.thumb.classList.remove('ready');
  firstShow.hidden.thumb.style = new Proxy({ width: '', transform: '', transition: '' }, {
    set(target, name, value) {
      if (name === 'transition') transitions.push(value);
      target[name] = value;
      return true;
    },
  });
  firstShow.hidden.buttons[1].click();
  assert.equal(firstShow.hidden.thumb.classList.contains('ready'), false,
    'A restored model in a hidden page stays unmeasured');
  firstShow.hidden.panel.classList.add('on');
  firstShow.context.positionThumbs(true);
  assert.equal(firstShow.hidden.thumb.style.transform, 'translateX(44px)',
    'The first visible frame matches the restored non-first model');
  assert.deepEqual(transitions, ['none', ''],
    'The first measurement positions immediately before restoring regular transitions');
  assert.equal(firstShow.hidden.thumb.classList.contains('ready'), true);

  const resizeStart = source.indexOf('    var resizeFrame = 0;\n', source.indexOf('  function init()'));
  const resizeEnd = source.indexOf('    var reducedMotionQuery', resizeStart);
  assert.ok(resizeStart >= 0 && resizeEnd > resizeStart, 'Production resize batching is present');
  const callbacks = [];
  const frames = [];
  const calls = { finish: 0, position: 0, dropdown: 0 };
  const resizeWindow = {};
  const resizeContext = vm.createContext({
    window: resizeWindow,
    on(target, type, callback) {
      assert.equal(target, resizeWindow);
      assert.equal(type, 'resize');
      callbacks.push(callback);
    },
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    finishMotions() { calls.finish++; },
    positionThumbs(animate) { assert.equal(animate, false); calls.position++; },
    openSelect: { position() { calls.dropdown++; } },
  });
  vm.runInContext(source.slice(resizeStart, resizeEnd), resizeContext);
  for (let index = 0; index < 50; index++) callbacks[0]();
  assert.equal(frames.length, 1, 'A burst of viewport changes schedules one frame');
  assert.deepEqual(calls, { finish: 0, position: 0, dropdown: 0 }, 'Resize work waits for the frame');
  frames[0]();
  assert.deepEqual(calls, { finish: 1, position: 1, dropdown: 1 }, 'Each resize stage runs once');
  callbacks[0]();
  assert.equal(frames.length, 2, 'Later viewport changes can schedule another frame');
  console.log('Viewport resize checks passed: 50 events coalesce into one visual update.');
}
