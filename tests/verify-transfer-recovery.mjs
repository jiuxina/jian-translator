/* Executes the production restored-transfer handlers with synthetic storage/DOM/native hooks. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = new TextDecoder('utf-8', { fatal: true }).decode(
  await readFile(new URL('../web/app.js', import.meta.url))).replace(/\r\n/g, '\n');
const storageStart = source.indexOf('  function readPendingTransfer(key) {');
const storageEnd = source.indexOf('  var Bridge = {', storageStart);
const hooksStart = source.indexOf('  function invalidateDocumentImport() {');
const hooksEnd = source.indexOf('\n  /* ---------------- 12.', hooksStart);
assert.ok(storageStart >= 0 && storageEnd > storageStart, 'Production pending-transfer helpers exist');
assert.ok(hooksStart >= 0 && hooksEnd > hooksStart, 'Production transfer recovery handlers exist');
assert.equal((source.match(/\binitRestoredTransfers\(\);/g) || []).length, 1,
  'The shared startup installs transfer recovery exactly once');

function storage() {
  const values = new Map();
  return {
    values,
    blocked: false,
    getItem(key) { if (this.blocked) throw new Error('Synthetic denied storage'); return values.get(key) ?? null; },
    setItem(key, value) { if (this.blocked) throw new Error('Synthetic denied storage'); values.set(key, String(value)); },
    removeItem(key) { if (this.blocked) throw new Error('Synthetic denied storage'); values.delete(key); },
  };
}

function fixture({ android = true, localBlocked = false } = {}) {
  const localStorage = storage();
  const sessionStorage = storage();
  localStorage.blocked = localBlocked;
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '' });
    return elements.get(id);
  };
  const calls = { ready: 0, documents: [], images: [], setImages: [], preferences: [], toasts: [] };
  const context = vm.createContext({
    localStorage, sessionStorage, JSON,
    Bridge: { isAndroid: android },
    window: { NativeBridge: {
      bridgeReady() {
        calls.ready++;
        assert.equal(typeof context.window.__itOnRestoredDocument, 'function', 'Document hook precedes readiness');
        assert.equal(typeof context.window.__itRestoreImage, 'function', 'Image hook precedes readiness');
        assert.equal(typeof context.window.__itOnDocumentSaved, 'function', 'Export feedback hook precedes readiness');
      },
      acknowledgeDocumentImport: token => calls.documents.push(token),
      acknowledgeImage: token => calls.images.push(token),
    } },
    $: element,
    docEditRevision: 4,
    PREFERENCES_KEY: 'synthetic-preferences',
    activePreferences: {
      appearance: { theme: 'synthetic-theme' },
      background: { data: 'existing-background', opacity: 42 },
      popup: { backgroundData: 'existing-popup', enabled: true },
    },
    copyObject: value => JSON.parse(JSON.stringify(value)),
    setImage: value => calls.setImages.push(value),
    applyPreferences: value => {
      calls.preferences.push(JSON.parse(JSON.stringify(value)));
      context.activePreferences = value;
    },
    toast: (message, error) => calls.toasts.push({ message, error }),
  });
  vm.runInContext(`${source.slice(storageStart, storageEnd)}\n${source.slice(hooksStart, hooksEnd)}\ninitRestoredTransfers();`, context);
  return {
    context, calls, localStorage, sessionStorage, element,
    put(key, value) { context.writePendingTransfer(key, value); },
    pending(key) { const value = context.readPendingTransfer(key); return value && JSON.parse(JSON.stringify(value)); },
    document(text, name, token) { return context.window.__itOnRestoredDocument(text, name, token); },
    image(data, token, purpose) { return context.window.__itRestoreImage(data, token, purpose); },
  };
}

const checks = [];
function check(name, run) {
  try { run(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, passed: false }); console.error(`FAIL ${name}: ${error.message}`); }
}

check('Android initialization announces readiness after installing every native callback', () => {
  assert.equal(fixture().calls.ready, 1);
  assert.equal(fixture({ android: false }).calls.ready, 0);
});

check('Pending metadata is written and removed in both storage scopes', () => {
  const test = fixture();
  const pending = { token: 'synthetic-both', purpose: 'translation' };
  test.put('it-image-import', pending);
  assert.deepEqual(JSON.parse(test.localStorage.getItem('it-image-import')), pending);
  assert.deepEqual(JSON.parse(test.sessionStorage.getItem('it-image-import')), pending);
  test.context.removePendingTransfer('it-image-import');
  assert.equal(test.localStorage.getItem('it-image-import'), null);
  assert.equal(test.sessionStorage.getItem('it-image-import'), null);
});

check('A matching document survives lost sessionStorage and is accepted exactly once', () => {
  const test = fixture();
  test.put('it-document-import', { token: 'synthetic-doc', revision: 4 });
  test.sessionStorage.values.clear();
  assert.equal(test.document('合成文档\nsecond line', 'synthetic.md', 'synthetic-doc'), true);
  assert.equal(test.element('doc-src').value, '合成文档\nsecond line');
  assert.equal(test.element('doc-name').textContent, 'synthetic.md');
  assert.match(test.element('doc-stat').textContent, /字符$/);
  assert.equal(test.context.docEditRevision, 5);
  assert.equal(test.pending('it-document-import'), null);
  test.document('duplicate must not overwrite', 'duplicate.md', 'synthetic-doc');
  assert.equal(test.element('doc-src').value, '合成文档\nsecond line');
  assert.equal(test.context.docEditRevision, 5);
  assert.deepEqual(test.calls.documents, ['synthetic-doc', 'synthetic-doc']);
});

check('Invalidation persists and prevents an empty restored editor from resurrecting old content', () => {
  const test = fixture();
  test.put('it-document-import', { token: 'synthetic-invalidated', revision: 4 });
  test.context.invalidateDocumentImport();
  test.sessionStorage.values.clear();
  assert.equal(test.pending('it-document-import').invalidated, true);
  test.document('stale content', 'stale.txt', 'synthetic-invalidated');
  assert.equal(test.element('doc-src').value, '');
  assert.equal(test.context.docEditRevision, 4);
  assert.deepEqual(test.calls.documents, ['synthetic-invalidated']);
  assert.equal(test.pending('it-document-import'), null);
});

check('A user edit wins over a matching delayed document', () => {
  const test = fixture();
  test.put('it-document-import', { token: 'synthetic-edited', revision: 4 });
  test.element('doc-src').value = 'new manual content';
  test.element('doc-name').textContent = '原文';
  test.document('late file content', 'late.md', 'synthetic-edited');
  assert.equal(test.element('doc-src').value, 'new manual content');
  assert.equal(test.element('doc-name').textContent, '原文');
  assert.equal(test.context.docEditRevision, 4);
  assert.deepEqual(test.calls.documents, ['synthetic-edited']);
});

check('Stale document acknowledgement cannot remove the newest pending request', () => {
  const test = fixture();
  const newest = { token: 'synthetic-newest', revision: 5 };
  test.put('it-document-import', newest);
  test.document('old import', 'old.md', 'synthetic-old');
  assert.equal(test.element('doc-src').value, '');
  assert.deepEqual(test.pending('it-document-import'), newest);
  assert.deepEqual(test.calls.documents, ['synthetic-old']);
});

for (const purpose of ['translation', 'background', 'popup-background']) {
  check(`Restored ${purpose} image routes once and acknowledges duplicate delivery`, () => {
    const test = fixture();
    const token = `synthetic-${purpose}`;
    const data = 'data:image/png;base64,c3ludGhldGlj';
    test.put('it-image-import', { token, purpose });
    test.sessionStorage.values.clear();
    assert.equal(test.image(data, token, purpose), true);
    test.image('data:image/png;base64,ZHVwbGljYXRl', token, purpose);
    assert.deepEqual(test.calls.images, [token, token]);
    assert.equal(test.pending('it-image-import'), null);
    if (purpose === 'translation') {
      assert.deepEqual(test.calls.setImages, [data]);
      assert.equal(test.calls.preferences.length, 0);
    } else {
      assert.equal(test.calls.setImages.length, 0);
      assert.equal(test.calls.preferences.length, 1);
      const preferences = test.calls.preferences[0];
      assert.equal(preferences.appearance.theme, 'synthetic-theme');
      assert.equal(preferences.background.opacity, 42);
      assert.equal(preferences.popup.enabled, true);
      assert.equal(preferences.background.data, purpose === 'background' ? data : 'existing-background');
      assert.equal(preferences.popup.backgroundData, purpose === 'popup-background' ? data : 'existing-popup');
      assert.deepEqual(JSON.parse(test.localStorage.getItem('synthetic-preferences')), preferences);
    }
  });
}

check('A stale image token cannot mutate a newer pending image or its destination', () => {
  const test = fixture();
  const newest = { token: 'synthetic-new-picture', purpose: 'background' };
  test.put('it-image-import', newest);
  test.image('synthetic-old-picture', 'synthetic-old-token', 'translation');
  assert.deepEqual(test.pending('it-image-import'), newest);
  assert.equal(test.calls.preferences.length, 0);
  assert.equal(test.calls.setImages.length, 0);
  assert.deepEqual(test.calls.images, ['synthetic-old-token']);
});

check('A mismatched image purpose is discarded without changing preferences', () => {
  const test = fixture();
  test.put('it-image-import', { token: 'synthetic-wrong-destination', purpose: 'popup-background' });
  test.image('synthetic-picture', 'synthetic-wrong-destination', 'background');
  assert.equal(test.calls.preferences.length, 0);
  assert.equal(test.calls.setImages.length, 0);
  assert.deepEqual(test.calls.images, ['synthetic-wrong-destination']);
});

check('Native export status uses the existing feedback channel', () => {
  const test = fixture();
  test.context.window.__itOnDocumentSaved('saved', '合成保存完成');
  test.context.window.__itOnDocumentSaved('cancelled', '合成取消');
  test.context.window.__itOnDocumentSaved('error', '合成失败');
  assert.deepEqual(test.calls.toasts, [
    { message: '合成保存完成', error: false },
    { message: '合成取消', error: false },
    { message: '合成失败', error: true },
  ]);
});

check('Session metadata remains usable when persistent storage is unavailable', () => {
  const test = fixture({ localBlocked: true });
  test.put('it-document-import', { token: 'synthetic-session-only', revision: 4 });
  test.document('session-only document', 'session.txt', 'synthetic-session-only');
  assert.equal(test.element('doc-src').value, 'session-only document');
  assert.deepEqual(test.calls.documents, ['synthetic-session-only']);
});

const failed = checks.filter(check => !check.passed);
assert.equal(failed.length, 0, `${failed.length} transfer recovery runtime cases failed`);
console.log(`Transfer recovery runtime: ${checks.length}/${checks.length} cases passed using synthetic storage and native hooks.`);
