import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile, link } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRelease, parseArguments } from '../scripts/prepare-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, '.build'), { recursive: true });
const fixture = await mkdtemp(path.join(root, '.build', 'release-test-'));
const windowsDir = path.join(fixture, 'windows');
const macosDir = path.join(fixture, 'macos');
await mkdir(windowsDir);
await mkdir(macosDir);
await mkdir(path.join(fixture, 'app', 'macos'), { recursive: true });
await mkdir(path.join(fixture, 'docs', 'releases'), { recursive: true });
await writeFile(path.join(fixture, 'app', 'macos', 'package.json'),
  JSON.stringify({ version: '2.3.0' }), 'utf8');
const notes = '# 笺 2.3.0\n\n仅供本地准备测试。\n';
await writeFile(path.join(fixture, 'docs', 'releases', 'v2.3.0.md'), notes, 'utf8');
const inputExe = Buffer.from('synthetic EXE input');
const inputMsi = Buffer.from('synthetic MSI input');
const inputDmg = Buffer.from('synthetic DMG input');
const inputZip = Buffer.from('synthetic ZIP input');
const inputApk = Buffer.from('synthetic APK input');
await writeFile(path.join(windowsDir, '笺.exe'), inputExe);
await writeFile(path.join(windowsDir, '笺.msi'), inputMsi);
await writeFile(path.join(macosDir, '笺-2.3.0-macOS-universal.dmg'), inputDmg);
await writeFile(path.join(macosDir, '笺-2.3.0-macOS-universal.zip'), inputZip);
const androidPath = path.join(fixture, 'android.apk');
await writeFile(androidPath, inputApk);
const options = {
  projectRoot: fixture, windowsDir, macosDir, androidPath, outDir: path.join(fixture, 'prepared'),
  revision: 'a'.repeat(40)
};

assert.deepEqual(parseArguments(
  ['--windows-dir', 'win', '--macos-dir', 'mac', '--android', 'app.apk', '--out-dir', 'out']),
  { windowsDir: 'win', macosDir: 'mac', androidPath: 'app.apk', outDir: 'out' });
for (const args of [['--unknown', 'x'], ['--android'], ['--android', 'a', '--android', 'b']]) {
  assert.throws(() => parseArguments(args));
}
const result = await prepareRelease(options);
assert.equal(result.manifest.version, '2.3.0');
assert.equal(result.manifest.tag, 'v2.3.0');
assert.equal(result.manifest.sourceRevision, options.revision);
assert.equal(result.manifest.draft, true);
assert.equal(result.manifest.prerelease, true);
assert.equal(result.manifest.makeLatest, false);
assert.equal(result.manifest.verification.priorTaskEvidence, null);
assert.deepEqual((await readdir(options.outDir)).sort(), [
  'Jian-2.3.0-android.apk', 'Jian-2.3.0-macOS-universal.dmg', 'Jian-2.3.0-macOS-universal.zip',
  'Jian-2.3.0-windows-x64.exe', 'Jian-2.3.0-windows-x64.msi',
  'RELEASE_NOTES.md', 'SHA256SUMS.txt', 'release-manifest.json'
].sort());
assert.deepEqual(await readFile(path.join(options.outDir, 'Jian-2.3.0-windows-x64.exe')), inputExe);
assert.deepEqual(await readFile(path.join(options.outDir, 'Jian-2.3.0-windows-x64.msi')), inputMsi);
assert.deepEqual(await readFile(path.join(options.outDir, 'Jian-2.3.0-macOS-universal.dmg')), inputDmg);
assert.deepEqual(await readFile(path.join(options.outDir, 'Jian-2.3.0-macOS-universal.zip')), inputZip);
assert.deepEqual(await readFile(path.join(options.outDir, 'Jian-2.3.0-android.apk')), inputApk);
assert.equal(await readFile(path.join(options.outDir, 'RELEASE_NOTES.md'), 'utf8'), notes);
const sums = (await readFile(path.join(options.outDir, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n');
assert.equal(sums.length, 5);
for (const asset of result.manifest.assets) {
  const bytes = await readFile(path.join(options.outDir, asset.name));
  const hash = createHash('sha256').update(bytes).digest('hex').toUpperCase();
  assert.equal(asset.sha256, hash);
  assert.equal(asset.bytes, bytes.length);
  assert.ok(sums.includes(`${hash}  ${asset.name}`));
}
await assert.rejects(prepareRelease(options), /输出目录已存在/);
assert.equal(await readFile(path.join(options.outDir, 'RELEASE_NOTES.md'), 'utf8'), notes);
for (const version of ['v2.3.0', '2.3.0-beta', '02.3.0', '2.3.1', '2.3.0\n']) {
  await assert.rejects(prepareRelease({ ...options, version, outDir: path.join(fixture, version) }));
}
await assert.rejects(prepareRelease({ ...options, revision: 'main', outDir: path.join(fixture, 'bad-revision') }),
  /完整的 Git/);
await assert.rejects(prepareRelease({ ...options, revision: `${options.revision}\n`,
  outDir: path.join(fixture, 'newline-revision') }), /完整的 Git/);
await writeFile(path.join(fixture, 'app', 'macos', 'package.json'),
  JSON.stringify({ version: '2.3.0\n' }), 'utf8');
await assert.rejects(prepareRelease({ ...options, outDir: path.join(fixture, 'newline-manifest') }), /正式三段版本/);
await writeFile(path.join(fixture, 'app', 'macos', 'package.json'),
  JSON.stringify({ version: '2.3.0' }), 'utf8');
await assert.rejects(prepareRelease({ ...options, windowsDir: fixture, outDir: path.join(fixture, 'missing') }));
assert.equal((await readdir(fixture)).includes('missing'), false, 'preflight must leave no output directory');
const aliases = path.join(fixture, 'aliases');
await mkdir(aliases);
await link(path.join(windowsDir, '笺.exe'), path.join(aliases, '笺.exe'));
await link(path.join(windowsDir, '笺.exe'), path.join(aliases, '笺.msi'));
await assert.rejects(prepareRelease({ ...options, windowsDir: aliases, outDir: path.join(fixture, 'alias-output') }),
  /同一个输入/);
console.log(`Release preparation, exact assets, hashes, exclusive output and invalid inputs passed: ${fixture}`);
