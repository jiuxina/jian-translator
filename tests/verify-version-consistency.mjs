/* Checks the release version across every shipped platform manifest. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFile(path.join(root, file), 'utf8');
const version = '2.4.5';

const macPackage = JSON.parse(await read('app/macos/package.json'));
const macLock = JSON.parse(await read('app/macos/package-lock.json'));
assert.equal(macPackage.version, version, 'macOS package version');
assert.equal(macLock.version, version, 'macOS lockfile version');
assert.equal(macLock.packages[''].version, version, 'macOS lockfile root package version');

const androidGradle = await read('android/app/build.gradle');
assert.match(androidGradle, new RegExp(`versionName ['"]${version.replaceAll('.', '\\.')}['"]`));
assert.match(androidGradle, /versionCode\s+12/);

const webApp = await read('web/app.js');
const androidApp = await read('android/app/src/main/assets/app.js');
const webIndex = await read('web/index.html');
const androidIndex = await read('android/app/src/main/assets/index.html');
for (const [name, source] of [['web app', webApp], ['Android app asset', androidApp]]) {
  assert.equal(source.match(/var APP_VERSION = '([^']+)'/)?.[1], version, name);
}
for (const [name, source] of [['web about page', webIndex], ['Android about page', androidIndex]]) {
  assert.match(source, /class="it-about-version">版本 2\.4\.5<\/p>/, name);
}
for (const name of ['index.html', 'theme.css', 'app.js', 'langs.js', 'liquid-glass.js', 'updates.js', 'translation-stream.js']) {
  assert.deepEqual(await readFile(path.join(root, 'web', name)),
    await readFile(path.join(root, 'android/app/src/main/assets', name)),
    `${name}: Android must ship the same public frontend bytes`);
}

const rebuild = await read('app/rebuild.sh');
assert.match(rebuild, new RegExp(`--app-version ${version.replaceAll('.', '\\.')}`));
const releaseNotes = await read('docs/releases/v2.4.5.md');
assert.match(releaseNotes, /^# 笺 v2\.4\.5/m);
assert.match(releaseNotes, /versionCode 12/);
const preparation = await read('docs/release-preparation.md');
assert.match(preparation, /^## 当前版本：v2\.4\.5/m);

console.log('Version consistency: 2.4.5 / Android versionCode 12 passed.');
