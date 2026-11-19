/* Portable synthetic/offline release gate; native device/build acceptance is separate. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [
  'verify-version-consistency.mjs',
  'verify-updates.mjs',
  'verify-stream-writer.mjs',
  'verify-image-import.mjs',
  'verify-settings-preview.mjs',
  'verify-autostart-ui.mjs',
  'verify-macos-popup-lifecycle.mjs',
  'verify-macos.mjs',
  'verify-translation-stream.mjs',
  'verify-stream-boundaries.mjs',
  'verify-task-ownership.mjs',
  'verify-transfer-recovery.mjs',
  'verify-audit-ux.mjs',
  'verify-android-file-bridge.mjs',
  'verify-windows-input.mjs',
  'verify-windows-installer.mjs',
  'verify-release-preparation.mjs',
];
execFileSync(process.execPath, [path.join(root, 'app/macos/build.mjs'), '--prepare-only'], {
  cwd: root, stdio: 'inherit', windowsHide: true, timeout: 30000,
});
const results = [];
for (const test of checks) {
  console.log(`Release gate: ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'tests', test)], {
    cwd: root, stdio: 'inherit', windowsHide: true, timeout: 120000,
  });
  results.push({ test, passed: result.status === 0 && !result.error,
    status: result.status, error: result.error ? result.error.message : null });
}
await mkdir(path.join(root, '.build'), { recursive: true });
await writeFile(path.join(root, '.build/audit-release-verification.json'), JSON.stringify({
  recordedAt: new Date().toISOString(), scope: 'Portable synthetic/offline regression; excludes native/browser/device acceptance',
  results,
}, null, 2) + '\n', 'utf8');
const passed = results.filter(result => result.passed).length;
console.log(`Release gate: ${passed}/${checks.length} portable checks passed. Native/browser acceptance is separate.`);
if (passed !== checks.length) process.exitCode = 1;
