import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const updates = require('../web/updates.js');
assert.deepEqual(updates.parseVersion('v2.2.1'), [2, 2, 1]);
assert.equal(updates.parseVersion('v2.2.1-beta'), null);
assert.equal(updates.parseVersion('2.2'), null);
assert.equal(updates.compareVersions('2.10.0', '2.9.9'), 1);
assert.equal(updates.compareVersions('2.2.0', 'v2.2.0'), 0);
assert.equal(updates.compareVersions('2.1.9', '2.2.0'), -1);
assert.equal(updates.shouldAutoCheck(false, 0, Date.now()), false);
assert.equal(updates.shouldAutoCheck(true, 1000, 1001), false);
assert.equal(updates.shouldAutoCheck(true, 1000, 1000 + updates.interval), true);
assert.equal(updates.shouldAutoCheck(true, 2000, 1000), true);
assert.equal(updates.releaseUrl('https://github.com.evil.test/jiuxina/jian-translator/releases/tag/v9.0.0'),
  updates.releases);
assert.equal(updates.releaseUrl('javascript:alert(1)'), updates.releases);
assert.equal(updates.releaseUrl('https://github.com/jiuxina/jian-translator/releases/tag/v2.3.0'),
  'https://github.com/jiuxina/jian-translator/releases/tag/v2.3.0');
const fakeRelease = (tag, html_url) => async (_url, options) => {
  assert.equal(options.credentials, 'omit');
  return { status: 200, ok: true, json: async () => ({
    tag_name: tag, html_url: html_url || updates.releases
  }) };
};
assert.equal((await updates.checkLatest('2.2.0', fakeRelease('v2.3.0'))).status, 'available');
assert.equal((await updates.checkLatest('2.2.0', fakeRelease('v2.2.0'))).status, 'current');
assert.equal((await updates.checkLatest('2.2.0', fakeRelease('v2.1.0'))).status, 'current');
assert.equal((await updates.checkLatest('2.2.0',
  async () => ({ status: 404, ok: false }))).status, 'unpublished');
await assert.rejects(updates.checkLatest('2.2.0', fakeRelease('invalid')), /有效的正式版本/);
await assert.rejects(updates.checkLatest('2.2.0',
  async () => ({ status: 429, ok: false })), /次数受限/);
await assert.rejects(updates.checkLatest('2.2.0',
  async () => { throw new TypeError('fetch failed'); }), /检查网络/);
console.log('Update version comparison, public release metadata, cooldown and failures passed.');
