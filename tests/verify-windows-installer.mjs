/* Executes installer custom actions against a synthetic, memory-only HKCU. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = async (file) => new TextDecoder('utf-8', { fatal: true })
  .decode(await readFile(new URL(`../${file}`, import.meta.url)));
const patcher = await read('desktop/patch_apply.py');
assert.match(patcher, /install_autostart_wix/, 'The patcher must install the MSI lifecycle actions');
const fragment = await read('desktop/patch/autostart.wxi');
const action = (id) => {
  const match = new RegExp(`<CustomAction Id="${id}"[^>]*>[\\s\\S]*?<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>[\\s\\S]*?</CustomAction>`).exec(fragment);
  assert.ok(match, `${id} has an executable custom action`);
  return match[1];
};
function run(id, value, properties = {}, behavior = {}) {
  const changes = [];
  let reads = 0;
  const props = {
    JIAN_CURRENT_EXE: 'C:\\Apps\\New\\jian.exe',
    JIAN_PREVIOUS_INSTALL_DIR: 'C:\\Apps\\Old\\',
    ...properties,
  };
  const shell = {
    RegRead() {
      if (behavior.denied) throw Object.assign(new Error('denied'), { number: 5 });
      reads++;
      if (reads > 1 && behavior.changed) value = '"D:\\Portable\\jian.exe"';
      if (value == null) throw Object.assign(new Error('missing'), { number: 2 });
      return value;
    },
    RegWrite(key, next) { changes.push(['write', key, next]); value = next; },
    RegDelete(key) { changes.push(['delete', key]); value = null; },
    ExpandEnvironmentStrings(input) { return input.replace('%OLD%', 'C:\\Apps\\Old'); },
  };
  const context = vm.createContext({
    Session: { Property: (name) => props[name] || '' },
    ActiveXObject: function () { return shell; },
  });
  vm.runInContext(action(id), context);
  return { value, changes };
}

assert.equal(run('JianUpdateAutostart', null).value, null, 'Fresh install defaults to disabled');
assert.equal(run('JianUpdateAutostart', '"C:\\Apps\\Old\\jian.exe"').value,
  '"C:\\Apps\\New\\jian.exe"', 'An enabled old installation follows the new location');
assert.equal(run('JianUpdateAutostart', '"%OLD%\\jian.exe" --startup').value,
  '"C:\\Apps\\New\\jian.exe"', 'Environment-expanded registrations retain enabled state');
for (const value of ['"D:\\Portable\\jian.exe"', '"C:\\Apps\\OldOther\\jian.exe"',
  '"C:\\Apps\\Old\\other.exe"', 'relative.exe', 'C:\\Program Files\\jian.exe']) {
  assert.deepEqual(run('JianUpdateAutostart', value).changes, [], 'Other or malformed registrations are preserved');
  assert.deepEqual(run('JianRemoveAutostart', value).changes, [], 'Uninstall preserves other registrations');
}
assert.equal(run('JianRemoveAutostart', '"c:/apps/new/JIAN.EXE"').value, null,
  'Uninstall removes only the exact current executable, ignoring path case and slashes');
assert.deepEqual(run('JianRemoveAutostart', '"C:\\Apps\\Old\\jian.exe"').changes, [],
  'Uninstall cannot remove another installation');
assert.deepEqual(run('JianUpdateAutostart', '"C:\\Apps\\Old\\jian.exe"', {}, { changed: true }).changes, [],
  'A concurrently replaced startup registration is not overwritten');
assert.deepEqual(run('JianRemoveAutostart', '"C:\\Apps\\New\\jian.exe"', {}, { changed: true }).changes, [],
  'A concurrently replaced startup registration is not removed');
assert.throws(() => run('JianUpdateAutostart', null, {}, { denied: true }), /denied/,
  'Access errors fail installation rather than pretending startup was disabled');
assert.match(fragment, /REMOVE = &quot;ALL&quot;.*NOT UPGRADINGPRODUCTCODE/,
  'Major upgrade removal preserves the registration for the new installer to update');
assert.match(fragment, /Action="JianUpdateAutostart" After="InstallFinalize"/,
  'Installation cannot update startup before the MSI transaction succeeds');
assert.match(fragment, /Action="JianRemoveAutostart" After="JianUpdateAutostart"/,
  'Uninstall cleanup runs only after finalization, with an unambiguous action order');
assert.match(fragment, /JIAN_PREVIOUS_INSTALL_DIR[\s\S]*RegistrySearch/,
  'The old installation path is captured before registry entries are replaced');
console.log('Windows MSI lifecycle: synthetic registry ownership checks passed.');
