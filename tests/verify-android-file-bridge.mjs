/* Android source contracts; no device, user files, clipboard or network. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const decode = new TextDecoder('utf-8', { fatal: true });
const main = decode.decode(await readFile(new URL('../android/app/src/main/java/ink/jian/translate/MainActivity.java', import.meta.url)));
const camera = decode.decode(await readFile(new URL('../android/app/src/main/java/ink/jian/translate/CameraActivity.java', import.meta.url)));
const checks = [
  ['file input delegates to Android chooser', () => assert.match(main, /boolean onShowFileChooser\(WebView[^]*?ValueCallback<Uri\[\]>/)],
  ['document picker uses persistent access', () => assert.match(main, /Intent\.ACTION_OPEN_DOCUMENT/)],
  ['export uses native save destination', () => assert.match(main, /public void saveDocument\(String filename, String text\)[^]*?Intent\.ACTION_CREATE_DOCUMENT/)],
  ['activity results route document operations before images', () => assert.match(main, /if \(requestCode == REQ_DOCUMENT\)[^]*?if \(requestCode == REQ_EXPORT\)[^]*?requestCode != REQ_CAMERA/)],
  ['pending result metadata survives reconstruction', () => assert.match(main, /restorePendingTransfers\(\)/)],
  ['web readiness gates deferred result delivery', () => assert.match(main, /public void bridgeReady\(\)[^]*?deliverPendingTransfers\(\)/)],
  ['image recovery has a dedicated page hook', () => assert.match(main, /__itRestoreImage/)],
  ['document recovery has a dedicated page hook', () => assert.match(main, /__itOnRestoredDocument/)],
  ['shutter has a meaningful accessible name', () => assert.match(camera, /shutter\.setContentDescription\("拍照"\)/)],
  ['lens switch checks availability before rebinding', () => assert.match(camera, /hasCamera\(selector\)/)],
  ['confirmation preview reads EXIF orientation', () => assert.match(camera, /new ExifInterface\(file/)],
  ['confirmation preview applies orientation', () => assert.match(camera, /Bitmap\.createBitmap\(bitmap[^]*?matrix, true\)/)],
  ['cancelled document selection completes the callback', () => assert.match(main, /callback\.onReceiveValue\(uri == null \? null : new Uri\[\]\{uri\}\)/)],
  ['image acknowledgement is bound to its request token', () => assert.match(main, /Objects\.equals\(token, imageCallbackToken\)\) clearPendingImage\(\)/)],
  ['document acknowledgement is bound to its revision', () => assert.match(main, /Objects\.equals\(revision, documentRevision\)/)],
  ['restored payload is deferred until page and hooks are ready', () => assert.match(main, /if \(!bridgeIsReady \|\| !pageLoaded \|\| webView == null/)],
  ['transparent native image import gets an opaque white background', () => assert.match(main, /if \(bitmap\.hasAlpha\(\)\)[^]*?canvas\.drawColor\(Color\.WHITE\)/)],
  ['all mirrored EXIF cases are supported', () => {
    for (const orientation of ['FLIP_HORIZONTAL', 'FLIP_VERTICAL', 'TRANSPOSE', 'TRANSVERSE']) {
      assert.ok(camera.includes(`ExifInterface.ORIENTATION_${orientation}`));
    }
  }],
  ['page changes invalidate old image decoding destinations', () => assert.match(main, /requestPage != pageGeneration/)],
  ['native document completion checks both URI and edit revision', () => assert.match(main, /!java\.util\.Objects\.equals\(revision, documentRevision\)/)],
  ['export writer guards duplicate starts itself', () => assert.match(main, /private void writePendingExport\(\) \{\s+if \(exportRunning/)],
  ['notification acknowledgements check message generation', () => assert.match(main, /notification == exportNotificationSequence/)],
];
let failed = 0;
for (const [name, check] of checks) {
  try { check(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message.split('\n')[0]}`); }
}
assert.equal(failed, 0, `${failed} Android bridge/camera contracts failed`);
console.log(`Android file bridge and camera: ${checks.length} source contracts passed; device acceptance still required.`);
