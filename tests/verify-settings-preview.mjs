/*
 * Runs production settings scheduling and appearance projection against
 * synthetic DOM/clock/native fixtures. No stored settings or user data.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const glass = require('../web/liquid-glass.js');
const source = new TextDecoder('utf-8', { fatal: true }).decode(
  await readFile(new URL('../web/app.js', import.meta.url))).replace(/\r\n/g, '\n');
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Production section exists: ${startMarker}`);
  return source.slice(start, end);
}

const normalization = section('  var MODEL_OPTIONS = {', '  function readSavedPreferences()');
const appearance = section('  var PALETTE_COLORS = {', '  window.__itGetAppearance =');
const pathHelpers = section('  function valueAtPath(', '  function settingsFromSaved(');
const previewHelpers = section('    function updatePreferenceControl(', '    function fill()');
const preferenceEvents = section('    function updatePreference(control, final)', "    on($('it-set-save'), 'click'");
const closeSource = section('    function close() {\n      if (!modal.classList.contains', '    closeSettingsLayer = close;');
const saveSource = section("    on($('it-set-save'), 'click'", "    if (Bridge.isDesktop) Bridge.invoke('it_set_hotkeys_enabled', { enabled: true })");

function styleFixture(onWrite = () => {}) {
  const properties = new Map();
  return {
    getPropertyValue: (name) => properties.get(name) || '',
    setProperty: (name, value) => { properties.set(name, value); onWrite(name, value); },
  };
}

function appearanceFixture() {
  const counts = { style: 0, data: 0, meta: 0, background: 0, configure: 0, refresh: 0, reads: 0 };
  const root = {
    style: styleFixture(() => counts.style++),
    dataset: new Proxy({}, { set(target, name, value) {
      counts.data++;
      target[name] = value;
      return true;
    } }),
  };
  const attributes = new Map();
  const meta = {
    getAttribute: (name) => attributes.get(name),
    setAttribute: (name, value) => { attributes.set(name, value); counts.meta++; },
  };
  const calls = [];
  const native = { applyAppearance: (json) => calls.push(JSON.parse(json)) };
  const context = vm.createContext({
    window: { NativeBridge: native, ItLiquidGlass: {
      defaults: glass.defaults, normalize: glass.normalize,
      configure: () => counts.configure++,
      refresh: () => counts.refresh++,
    } },
    document: { documentElement: root, querySelector: () => meta },
    Bridge: { isAndroid: true, isDesktop: false },
    LANGS: { en: 'English', zh: 'Chinese' },
    currentSystemAppearance: 'light',
    applyBackground: () => counts.background++,
    cssDuration: (name, fallback) => { counts.reads++; return fallback; },
    cssNumber: (name, fallback) => { counts.reads++; return fallback; },
  });
  vm.runInContext(`${normalization}\nvar activePreferences = normalizePreferences();\n${appearance}`, context);
  return { context, counts, calls, root };
}

{
  const test = appearanceFixture();
  vm.runInContext('applyPreferences(activePreferences)', test.context);
  const first = { ...test.counts };
  vm.runInContext('applyPreferences(activePreferences)', test.context);
  assert.equal(test.counts.style, first.style, 'Same appearance avoids root CSS rewrites');
  assert.equal(test.counts.data, first.data, 'Same appearance avoids root attribute mutations');
  assert.equal(test.counts.meta, first.meta, 'Same color scheme avoids metadata mutations');
  assert.equal(test.counts.background, first.background, 'Same background avoids rebuilding its style sheet');
  assert.equal(test.counts.reads, first.reads, 'Same motion does not force computed-style reads');
  assert.equal(test.calls.length, 1, 'Same native appearance crosses the Android bridge once');
  vm.runInContext('activePreferences.liquidGlass.pill.refractionLevel = 30; applyPreferences(activePreferences)', test.context);
  assert.equal(test.calls.length, 1, 'Optical-only changes do not repaint native Android chrome');
  vm.runInContext('activePreferences.appearance.radius = "small"; applyPreferences(activePreferences)', test.context);
  assert.equal(test.counts.refresh, first.refresh + 1, 'Radius changes still refresh exact glass geometry');
  vm.runInContext('activePreferences.appearance.layout = "compact"; applyPreferences(activePreferences)', test.context);
  assert.equal(test.counts.refresh, first.refresh + 2, 'Compact layout still refreshes glass geometry');
  vm.runInContext('activePreferences.appearance.mode = "dark"; applyPreferences(activePreferences)', test.context);
  assert.equal(test.calls.length, 2, 'A visible native color change is delivered');
  assert.equal(test.calls[1].dark, true);
  vm.runInContext('activePreferences.background.data = "data:image/png;base64,c3ludGhldGlj"; applyPreferences(activePreferences)', test.context);
  assert.equal(test.counts.background, first.background + 2,
    'Changed backgrounds apply even when a bootstrap overwrites activePreferences first');
  let attempts = 0;
  test.context.window.NativeBridge = { applyAppearance() {
    attempts++;
    if (attempts === 1) throw new Error('Synthetic bridge failure');
  } };
  vm.runInContext('syncAndroidAppearance(activePreferences); syncAndroidAppearance(activePreferences)', test.context);
  assert.equal(attempts, 2, 'A failed native delivery is retried and not cached as successful');
}

function settingsFixture() {
  let frameId = 0;
  const frames = new Map();
  const handlers = new Map();
  const elements = new Map();
  const snapshots = [];
  const writes = [];
  const counts = { fill: 0, popup: 0 };
  const classes = new Set(['on']);
  const modal = {
    id: 'modal',
    classList: {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
    setAttribute() {},
    querySelectorAll: () => [],
  };
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, value: '', textContent: '', dataset: {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    window: { ItLiquidGlass: { defaults: glass.defaults, normalize: glass.normalize } },
    LANGS: { en: 'English', zh: 'Chinese' },
    requestAnimationFrame: (callback) => { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    modal, dialog: {}, settingsOrigin: null, returnFocus: null, backgroundState: [],
    settingsSeq: 1, backgroundPickSeq: 0, popupBackgroundPickSeq: 0,
    preferencePreviewFrame: 0, preferencePreviewPending: false, preferencePreviewSequence: 0,
    settingsSaving: false, settingsOpening: null, activeSection: 'glass',
    applyPreferences: (preferences) => snapshots.push(JSON.parse(JSON.stringify(preferences))),
    updatePopupPreview: () => counts.popup++,
    fill: () => counts.fill++,
    setPreferenceStyle: (el, name, value) => {
      if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
    },
    $: element,
    on: (target, type, callback) => handlers.set(`${target.id}:${type}`, callback),
    stopRecord() {}, closeSelect() {}, cancelSettingsSectionTransition() {}, enableControls() {},
    moveSurface: (target, origin, opening, done) => done(),
    Bridge: { isDesktop: false, isAndroid: false },
    PREFERENCES_KEY: 'synthetic-preferences',
    localStorage: { setItem: (key, value) => writes.push({ key, value: JSON.parse(value) }) },
    toast() {},
    scheduleAppUpdateCheck: null,
  });
  vm.runInContext(`${normalization}\n${pathHelpers}
    var settingsState = { preferences: normalizePreferences() };
    var committedSettings = copyObject(settingsState);
    var DEFAULT_SETTINGS = copyObject(settingsState);
    ${previewHelpers}\n${preferenceEvents}\n${closeSource}\n${saveSource}`, context);
  const control = (path, type = 'range', min = 0, max = 100) => {
    const output = {
      textContent: '',
      getAttribute: (name) => name === 'data-pref-output' ? path : null,
    };
    const row = { querySelectorAll: () => [output] };
    const attributes = { 'data-pref': path, ...(type === 'range' ? { 'data-pref-type': 'number' } : {}) };
    return {
      type, value: '', min, max, output,
      style: styleFixture(),
      hasAttribute: (name) => Object.hasOwn(attributes, name),
      getAttribute: (name) => attributes[name] || null,
      closest: () => row,
    };
  };
  return {
    context, frames, snapshots, counts, writes, control,
    event(type, input) { handlers.get(`modal:${type}`)({ target: input }); },
    frame() {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback());
    },
    close() { vm.runInContext('close()', context); },
    save() { handlers.get('it-set-save:click').call(element('it-set-save')); },
  };
}

{
  const test = settingsFixture();
  const input = test.control('liquidGlass.pill.refractionLevel');
  for (const value of ['80', '65', '40']) {
    input.value = value;
    test.event('input', input);
  }
  assert.equal(test.context.settingsState.preferences.liquidGlass.pill.refractionLevel, 40);
  assert.equal(input.output.textContent, '40%', 'The active value label follows the finger immediately');
  assert.equal(input.style.getPropertyValue('--it-range-fill'), '40%');
  assert.equal(test.frames.size, 1, 'Multiple inputs schedule only one preview frame');
  assert.equal(test.snapshots.length, 0, 'The input handler does not repaint the whole application');
  assert.equal(test.counts.fill, 0, 'Range input does not refill every settings control');
  test.frame();
  assert.equal(test.snapshots.length, 1);
  assert.equal(test.snapshots[0].liquidGlass.pill.refractionLevel, 40, 'The frame applies the latest draft');
  test.event('change', input);
  assert.equal(test.snapshots.length, 1, 'An unchanged change event does not repeat the preview');
  input.value = '25';
  test.event('input', input);
  test.event('change', input);
  assert.equal(test.frames.size, 0);
  assert.equal(test.snapshots.at(-1).liquidGlass.pill.refractionLevel, 25, 'Release flushes the last value');
}

{
  const test = settingsFixture();
  const color = test.control('appearance.fontColor', 'color');
  color.value = '#aabbcc';
  test.event('input', color);
  assert.equal(test.context.settingsState.preferences.appearance.fontColor, '#AABBCC');
  assert.equal(test.frames.size, 1, 'Color drags share the same per-frame preview path');
  const checkbox = test.control('appearance.ambientLight', 'checkbox');
  checkbox.checked = false;
  test.event('input', checkbox);
  assert.equal(test.frames.size, 0);
  assert.equal(test.snapshots.length, 1, 'A discrete selection flushes the whole latest draft synchronously');
  assert.equal(test.snapshots[0].appearance.fontColor, '#AABBCC');
  assert.equal(test.snapshots[0].appearance.ambientLight, false);
  assert.equal(test.counts.fill, 1, 'Dependent discrete controls still receive a full fill');
}

{
  const test = settingsFixture();
  const input = test.control('background.blur', 'range', 0, 20);
  input.value = '17';
  test.event('input', input);
  const stale = [...test.frames.values()][0];
  test.close();
  assert.equal(test.frames.size, 0, 'Cancel removes the pending preview frame');
  assert.equal(test.snapshots.at(-1).background.blur, 0, 'Cancel restores the committed appearance');
  stale();
  assert.equal(test.snapshots.at(-1).background.blur, 0, 'A stale callback cannot revive a canceled draft');
}

{
  const test = settingsFixture();
  const input = test.control('background.opacity', 'range', 0, 80);
  input.value = '52';
  test.event('input', input);
  test.save();
  assert.equal(test.frames.size, 0, 'Save flushes and consumes any pending preview');
  assert.equal(test.writes.length, 1);
  assert.equal(test.writes[0].value.background.opacity, 52, 'Save persists the latest synchronous draft');
  assert.equal(test.context.committedSettings.preferences.background.opacity, 52);
  assert.equal(test.snapshots.at(-1).background.opacity, 52, 'Closing after save keeps the submitted value');
}

console.log('Settings preview checks passed: frame batching, flush/cancel, native dedupe and exact geometry refresh.');
