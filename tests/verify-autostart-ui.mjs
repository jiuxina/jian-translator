/* Executes production settings handlers with synthetic DOM and native IPC. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = new TextDecoder('utf-8', { fatal: true }).decode(
  await readFile(new URL('../web/app.js', import.meta.url))).replace(/\r\n/g, '\n');
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Production section exists: ${startMarker}`);
  return source.slice(start, end);
}
const statusFunctions = section('    function renderAutostartStatus()', '    function queueSettingsPersistence(');
const persistenceFunctions = section('    function queueSettingsPersistence(', '    function fill()');
const autostartEvents = section("    on($('it-set-autostart'), 'change'", "    on($('it-set-starttotray'), 'change'");
const openSettings = section('    window.__itOpenSettings = function (source)', '    prewarmSettingsGlass = function ()');
const enableControls = section('    function enableControls(enabled)', '    function close()');
const resetSettings = section("      if (e.target.closest && e.target.closest('[data-reset-section]'))",
  "      if (e.target.closest && e.target.closest('#it-pref-pick-background'))");
const currentTarget = { enabled: true, target_path: 'C:\\Apps\\笺 B.exe', target_exists: true, target_is_current: true };
const otherTarget = { ...currentTarget, target_path: 'C:\\Apps\\笺 A.exe', target_is_current: false };
const disabled = { enabled: false, target_path: null, target_exists: false, target_is_current: false };

function fixture({ mac = false } = {}) {
  const elements = new Map();
  const handlers = new Map();
  const calls = [];
  const notices = [];
  const classes = new Set();
  function element(id) {
    if (!elements.has(id)) {
      const ownClasses = new Set();
      elements.set(id, {
        id, hidden: false, disabled: false, checked: false, indeterminate: false,
        textContent: '', value: '', style: {}, focus() {},
        classList: {
          add: (name) => ownClasses.add(name), remove: (name) => ownClasses.delete(name),
          toggle(name, on) { if (on) ownClasses.add(name); else ownClasses.delete(name); },
          contains: (name) => ownClasses.has(name),
        },
      });
    }
    return elements.get(id);
  }
  const modal = {
    classList: {
      contains: (name) => classes.has(name), add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
    querySelector: element,
    querySelectorAll: () => [...elements.values()],
    setAttribute() {},
  };
  const preferences = { background: { data: '' }, appearance: { fontColorMode: 'default' }, popup: {} };
  const settings = { auto_start: true, start_to_tray: true, preferences };
  const context = vm.createContext({
    $, on, Promise, AbortController,
    window: {}, document: { activeElement: element('trigger'), body: { children: [] } },
    Bridge: { isDesktop: true, isMac: mac, isAndroid: false, invoke(command, args) {
      if (command === 'it_set_hotkeys_enabled') return Promise.resolve();
      return new Promise((resolve, reject) => calls.push({ command, args, resolve, reject }));
    } },
    modal, dialog: { querySelector: element }, fontFamilySelect: null,
    systemFontsReady: true, systemFonts: [],
    settingsState: structuredClone(settings), committedSettings: structuredClone(settings),
    DEFAULT_PREFERENCES: preferences, DEFAULT_SETTINGS: { ...settings, auto_start: false },
    settingsLoaded: true, settingsSeq: 1, settingsOpening: null,
    settingsSaving: false, settingsDirty: false, persistenceFailure: '',
    persistenceTimer: 0, persistenceRevision: 0, persistedSettingsJson: '',
    autostartStatus: null, autostartError: '', autostartBusy: false,
    autostartSequence: 0, autostartPending: null,
    activePreferences: preferences, activeSection: 'desktop',
    backgroundState: [], returnFocus: null, settingsOrigin: null,
    scheduleAppUpdateCheck: null, PREFERENCES_KEY: 'synthetic',
    copyObject: (value) => JSON.parse(JSON.stringify(value)),
    settingsFromSaved: (value) => structuredClone(value || settings),
    readSavedPreferences: () => preferences,
    cancelPreferencePreview() {}, closeSelect() {}, cancelSettingsSectionTransition() {},
    applyPreferences() {}, refreshSelectButtons() {}, renderUpdateStatus() {},
    flushPreferencePreview() {}, renderPersistenceStatus() {},
    rectOf: () => ({}), loadSystemFonts: () => Promise.resolve([]),
    preparePageGlass: () => null, moveSurface() {},
    fill() { vm.runInContext('renderAutostartStatus()', context); },
    toast: (message) => notices.push(message),
    clearTimeout() {}, setTimeout() { return 1; },
    localStorage: { setItem() {} },
  });
  function $(id) { return element(id); }
  function on(target, event, handler) { handlers.set(`${target.id}:${event}`, handler); }
  vm.runInContext(`${statusFunctions}\n${persistenceFunctions}\n${enableControls}\n${autostartEvents}\n${openSettings}`, context);
  return {
    context, calls, notices, element, classes,
    run(code) { return vm.runInContext(code, context); },
    event(id, event = 'click') { handlers.get(`${id}:${event}`).call(element(id)); },
    open() { context.window.__itOpenSettings({ section: 'desktop' }); },
    close() { classes.delete('on'); context.settingsSeq++; context.settingsOpening = null; },
  };
}
async function flush() { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); }
let checks = 0;
function check(name) { checks++; console.log(`PASS ${name}`); }

{
  const test = fixture();
  test.run('renderAutostartStatus()');
  assert.equal(test.element('it-set-autostart').disabled, true);
  assert.equal(test.element('it-set-autostart').indeterminate, true);
  assert.equal(test.element('it-set-autostart').checked, false,
    'Legacy cached true must never appear as known Windows system state');
  check('Unknown system state disables the checkbox instead of using legacy settings');
}

{
  const test = fixture();
  test.open();
  await flush();
  test.calls.find((call) => call.command === 'it_get_settings').resolve(test.context.settingsState);
  test.calls.find((call) => call.command === 'it_get_autostart_status').reject(new Error('Synthetic access denied'));
  await flush();
  assert.equal(test.classes.has('on'), true, 'Startup read failure must not block the settings panel');
  assert.equal(test.element('it-set-autostart').disabled, true);
  assert.equal(test.element('it-set-autostart-retry').hidden, false);
  test.event('it-set-autostart-retry');
  await flush();
  test.calls.at(-1).resolve(otherTarget);
  await flush();
  assert.equal(test.element('it-set-autostart').checked, true);
  assert.equal(test.element('it-set-autostart-current').hidden, false);
  assert.match(test.element('it-set-autostart-status').textContent, /笺 A.exe/);
  check('Read failure keeps ordinary settings available and can retry actual status');
}

{
  const test = fixture();
  test.context.autostartStatus = otherTarget;
  test.run('renderAutostartStatus()');
  test.event('it-set-autostart-current');
  test.element('it-set-autostart').checked = false;
  test.event('it-set-autostart', 'change');
  await flush();
  assert.equal(test.calls.length, 1, 'Double interaction must not send overlapping registry writes');
  assert.equal(test.calls[0].command, 'it_set_autostart');
  assert.equal(test.calls[0].args.enabled, true);
  test.calls[0].resolve(currentTarget);
  await flush();
  assert.equal(test.element('it-set-autostart-current').hidden, true);
  assert.equal(test.element('it-set-autostart').checked, true);
  test.context.autostartStatus = otherTarget;
  test.run('renderAutostartStatus()');
  test.element('it-set-autostart').checked = false;
  test.event('it-set-autostart', 'change');
  await flush();
  assert.equal(test.calls.at(-1).args.enabled, false, 'Another target can be disabled globally');
  test.calls.at(-1).resolve(disabled);
  await flush();
  assert.equal(test.element('it-set-autostart').checked, false);
  check('Explicit version selection and global disable use serialized dedicated writes');
}

{
  const test = fixture();
  test.context.autostartStatus = otherTarget;
  test.event('it-set-autostart-current');
  await flush();
  test.calls[0].reject(new Error('Synthetic write failure'));
  await flush();
  assert.equal(test.calls.at(-1).command, 'it_get_autostart_status');
  test.calls.at(-1).resolve(disabled);
  await flush();
  assert.equal(test.element('it-set-autostart').checked, false);
  assert.equal(test.notices.some((message) => /已将当前版本/.test(message)), false);
  assert.equal(test.element('it-set-autostart-retry').hidden, false);
  check('Write failure re-reads actual system state and never reports switching success');
}

{
  const test = fixture();
  test.context.autostartStatus = disabled;
  test.element('it-set-autostart').checked = true;
  test.event('it-set-autostart', 'change');
  await flush();
  assert.equal(test.calls[0].args.enabled, true);
  test.calls[0].resolve(otherTarget);
  await flush();
  assert.equal(test.calls.at(-1).command, 'it_get_autostart_status',
    'A mismatched write verification must be reconciled');
  test.calls.at(-1).reject(new Error('Synthetic verification access failure'));
  await flush();
  assert.equal(test.element('it-set-autostart').disabled, true);
  assert.equal(test.element('it-set-autostart').indeterminate, true);
  assert.equal(test.element('it-set-autostart-retry').hidden, false);
  assert.equal(test.notices.some((message) => /已将当前版本/.test(message)), false);
  check('A conflicting write result and failed refresh leave an unknown disabled control');
}

{
  const test = fixture();
  test.context.autostartStatus = { ...otherTarget, target_exists: false };
  test.run('renderAutostartStatus()');
  assert.match(test.element('it-set-autostart-status').textContent, /不存在/);
  assert.equal(test.element('it-set-autostart-current').hidden, false);
  test.context.autostartStatus = { ...otherTarget, target_path: null, target_exists: false };
  test.run('renderAutostartStatus()');
  assert.match(test.element('it-set-autostart-status').textContent, /格式无效/);
  assert.equal(test.element('it-set-autostart').checked, true,
    'A registered malformed target still permits explicit global disable');
  test.context.autostartStatus = { ...otherTarget, target_path: '<script>alert(1)</script>.exe' };
  test.run('renderAutostartStatus()');
  assert.match(test.element('it-set-autostart-status').textContent, /<script>/);
  assert.equal(Object.hasOwn(test.element('it-set-autostart-status'), 'innerHTML'), false);
  check('Missing and malformed targets can be repaired, and target text never becomes HTML');
}

{
  const test = fixture();
  test.context.settingsDirty = true;
  test.open();
  await flush();
  test.calls[0].resolve(null);
  await flush();
  assert.equal(test.classes.has('on'), true);
  assert.equal(test.element('it-set-autostart').disabled, true);
  assert.equal(test.element('it-set-autostart-retry').hidden, false);
  assert.match(test.element('it-set-autostart-status').textContent, /有效/);
  check('An unsupported or malformed native reply is shown as unknown, not enabled');
}

{
  const test = fixture();
  test.context.autostartStatus = otherTarget;
  test.event('it-set-autostart-current');
  await flush();
  test.close();
  test.context.settingsDirty = true;
  test.open();
  await flush();
  assert.equal(test.calls.length, 1, 'Reopen read waits for the already requested write');
  test.calls[0].resolve(currentTarget);
  await flush();
  assert.equal(test.calls.at(-1).command, 'it_get_autostart_status');
  assert.equal(test.context.autostartStatus, null, 'A closed-session write cannot populate a reopened panel');
  test.calls.at(-1).resolve(otherTarget);
  await flush();
  assert.match(test.element('it-set-autostart-status').textContent, /笺 A.exe/);
  assert.equal(test.notices.length, 0, 'A closed-session completion must not show stale success');
  check('Reopening with unsaved settings refreshes after pending writes and ignores stale callbacks');
}

{
  const test = fixture();
  test.context.settingsDirty = true;
  test.open();
  await flush();
  const oldRead = test.calls[0];
  test.close();
  test.open();
  await flush();
  assert.equal(test.calls.length, 1, 'Repeated opens serialize system reads');
  oldRead.resolve(currentTarget);
  await flush();
  assert.equal(test.context.autostartStatus, null);
  assert.equal(test.calls.length, 2);
  test.calls[1].resolve(otherTarget);
  await flush();
  assert.match(test.element('it-set-autostart-status').textContent, /笺 A.exe/);
  check('A previous panel read cannot overwrite the newly opened panel status');
}

{
  const test = fixture();
  test.context.settingsDirty = true;
  test.run('persistSettings()');
  await flush();
  assert.equal(test.calls.length, 1);
  assert.equal(test.calls[0].command, 'it_save_settings');
  assert.equal(Object.hasOwn(test.calls[0].args.settings, 'auto_start'), false);
  test.calls[0].resolve([]);
  await flush();
  check('Ordinary Windows preferences do not send or mutate startup state');
}

{
  const test = fixture();
  test.context.autostartStatus = otherTarget;
  test.context.e = { target: { closest: () => ({}) } };
  test.run(resetSettings);
  await flush();
  assert.equal(test.calls.length, 1);
  assert.equal(test.calls[0].command, 'it_save_settings');
  assert.equal(Object.hasOwn(test.calls[0].args.settings, 'auto_start'), false);
  assert.equal(test.element('it-set-autostart').checked, true);
  assert.match(test.element('it-set-autostart-status').textContent, /笺 A.exe/);
  test.calls[0].resolve([]);
  await flush();
  check('Restoring desktop defaults preserves the shared Windows startup target');
}

{
  const test = fixture({ mac: true });
  test.run('renderAutostartStatus()');
  assert.equal(test.element('it-set-autostart-current').hidden, true);
  assert.equal(test.element('it-set-autostart').checked, true);
  test.element('it-set-autostart').checked = false;
  test.event('it-set-autostart', 'change');
  await flush();
  assert.equal(test.calls[0].command, 'it_save_settings');
  assert.equal(test.calls[0].args.settings.auto_start, false);
  test.calls[0].resolve([]);
  await flush();
  check('macOS keeps the existing login-item preference contract');
}

console.log(`Windows autostart UI: ${checks}/${checks} passed`);
