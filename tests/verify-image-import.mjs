/*
 * Delayed image delivery must respect later clear/delete/replacement actions.
 * Uses the production text-pane handlers and synthetic callbacks only.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = new TextDecoder('utf-8', { fatal: true }).decode(
  await readFile(new URL('../web/app.js', import.meta.url))).replace(/\r\n/g, '\n');
const start = source.indexOf('  function initTextPane() {');
const end = source.indexOf('\n  /* 展开和回收', start);
assert.ok(start >= 0 && end > start, 'Production text-pane handlers are present');

function fixture(withProductionPreview = false) {
  const elements = new Map();
  const handlers = new Map();
  const pending = [];
  const decodes = [];
  const translations = [];
  const state = { image: 'synthetic-existing-image', controller: null };
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, value: '', textContent: '', hidden: false,
      style: {}, classList: { add() {}, toggle() {} }, setAttribute() {}, contains: () => false,
      getBoundingClientRect: () => ({ height: 0 }), removeAttribute() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    window: {},
    state,
    imageSeq: 0,
    imageImportRevision: 0,
    textEditRevision: 0,
    $: element,
    on: (target, type, handler) => handlers.set(`${target.id}:${type}`, handler),
    Bridge: { pickImage: (callback) => pending.push(callback), isMac: false },
    sessionStorage: { getItem: () => null },
    setImage: (image) => {
      state.image = image || null;
      context.imageSeq++;
      context.imageImportRevision++;
    },
    shrinkImage: (image, done, fail) => decodes.push({ image, done, fail }),
    refreshCount() {},
    runText: () => translations.push(state.image),
    switchTab() {}, toast() {},
    document: { activeElement: null },
    getComputedStyle: () => ({ opacity: '1', marginBottom: '0px', getPropertyValue: () => '88' }),
    stopMotion() {}, playMotion: (_box, _frames, _duration, complete) => complete(), PANEL_DURATION: 200,
    readPendingTransfer: () => null, removePendingTransfer() {},
    stopActiveWriter() {},
    bindCancel() {},
    cancelTask() {},
    copyResult() {},
    outText() {},
    copyText() {},
  });
  if (withProductionPreview) {
    const previewStart = source.indexOf('  function setImage(');
    const previewEnd = source.indexOf('\n  function outText(', previewStart);
    vm.runInContext(source.slice(previewStart, previewEnd), context);
  }
  vm.runInContext(`${source.slice(start, end)}\ninitTextPane();`, context);
  return {
    state,
    pending,
    decodes,
    translations,
    clipboard: (content, id) => context.window.__itTranslateClipboard(content, id),
    beginClipboard: id => context.window.__itBeginClipboardTranslation(id),
    element,
    click: (id) => handlers.get(`${id}:click`)(),
    replace: (image) => context.setImage(image),
  };
}

{
  const test = fixture();
  test.clipboard({ image: 'data:image/png;base64,b2xk' }, 'clipboard-old');
  test.click('btn-pick-img');
  test.decodes[0].done('synthetic-late-clipboard-image');
  assert.deepEqual(test.translations, [], 'Opening the image picker supersedes pending clipboard decoding');
  test.pending[0]('synthetic-new-picked-image');
  assert.equal(test.state.image, 'synthetic-new-picked-image', 'The newer native picker retains its callback');
}
{
  const test = fixture();
  test.beginClipboard('clipboard-read');
  test.click('btn-pick-img');
  test.clipboard({ image: 'data:image/png;base64,bGF0ZQ==' }, 'clipboard-read');
  assert.equal(test.decodes.length, 0, 'Opening the image picker supersedes a pending native clipboard read');
  test.pending[0]('synthetic-new-picked-image');
  assert.equal(test.state.image, 'synthetic-new-picked-image');
}

{
  const test = fixture();
  test.clipboard({ image: 'data:image/png;base64,b2xk' }, 'clipboard-old');
  test.clipboard({ image: 'data:image/png;base64,bmV3' }, 'clipboard-new');
  test.decodes[0].done('synthetic-late-clipboard-image');
  assert.deepEqual(test.translations, [], 'The earlier clipboard image cannot submit after a newer shortcut');
  test.decodes[1].done('synthetic-new-clipboard-image');
  assert.deepEqual(test.translations, ['synthetic-new-clipboard-image']);
}
{
  const test = fixture(true);
  test.replace('synthetic-existing-image');
  const revealExistingPreview = test.element('img-thumb').onload;
  assert.equal(test.element('img-preview').style.height, '0px');
  test.clipboard({ image: 'data:image/png;base64,YnJva2Vu' }, 'failed-preview-replacement');
  test.decodes[0].fail();
  revealExistingPreview();
  assert.equal(test.element('img-preview').style.height, '', 'A failed replacement cannot cancel the existing thumbnail reveal');
  assert.equal(test.state.image, 'synthetic-existing-image');
}

const shrinkStart = source.indexOf('  function shrinkImage(');
const shrinkEnd = source.indexOf('\n  /* ---------------- 3.', shrinkStart);
assert.ok(shrinkStart >= 0 && shrinkEnd > shrinkStart, 'Production image preparation is extractable');
function shrinkFixture() {
  const images = [];
  const context = vm.createContext({
    Image: class { constructor() { images.push(this); } },
    document: { createElement: () => ({
      getContext: () => ({ fillRect() {}, drawImage() {} }),
      toDataURL: () => 'data:image/jpeg;base64,cHJlcGFyZWQ='
    }) }
  });
  vm.runInContext(source.slice(shrinkStart, shrinkEnd), context);
  return { images, prepare: context.shrinkImage };
}
{
  const test = shrinkFixture();
  const results = [];
  const failures = [];
  test.prepare('data:image/png;base64,YnJva2Vu', value => results.push(value), () => failures.push(true));
  test.images[0].onerror();
  assert.deepEqual(results, [], 'Strict image preparation cannot promote unreadable source bytes');
  assert.deepEqual(failures, [true], 'Strict preparation reports decode failures');
  test.prepare('synthetic-legacy-image', value => results.push(value));
  test.images[1].onerror();
  assert.deepEqual(results, ['synthetic-legacy-image'], 'Existing picker imports retain their fallback behavior');
}

for (const action of ['btn-clear', 'img-del']) {
  const test = fixture();
  test.click('btn-pick-img');
  test.click(action);
  test.pending[0]('synthetic-delayed-image');
  assert.equal(test.state.image, null, `${action} wins over delayed native decoding`);
}

{
  const test = fixture();
  test.click('btn-pick-img');
  test.replace('synthetic-newer-image');
  test.pending[0]('synthetic-delayed-image');
  assert.equal(test.state.image, 'synthetic-newer-image', 'Newer pasted image keeps ownership');
}

{
  const test = fixture();
  test.click('btn-pick-img');
  test.pending[0]('synthetic-selected-image');
  assert.equal(test.state.image, 'synthetic-selected-image', 'Uninterrupted imports still display');
  test.pending[0]('synthetic-duplicate-delivery');
  assert.equal(test.state.image, 'synthetic-selected-image', 'An import is accepted only once');
}

const pickStart = source.indexOf('    pickImage: function (onPicked, purpose) {');
const pickEnd = source.indexOf('\n    /* 背景图', pickStart);
assert.ok(pickStart >= 0 && pickEnd > pickStart, 'Production image bridge is present');
const pickSource = source.slice(pickStart, pickEnd).trim()
  .replace(/^pickImage: /, '').replace(/,$/, '');

function nativeFixture(withTokens) {
  const requests = [];
  const native = { pickImage: () => requests.push(null) };
  if (withTokens) native.pickImageWithToken = (token) => requests.push(token);
  const context = vm.createContext({
    window: { NativeBridge: native },
    Bridge: { isAndroid: true },
    nativeImagePickSequence: 0,
    nativeImagePickPrefix: 'synthetic-page',
    writePendingTransfer() {},
    readPendingTransfer: () => null,
    removePendingTransfer() {},
    toast: () => assert.fail('Synthetic picker should open normally'),
  });
  vm.runInContext(`Bridge.pickImage = ${pickSource};`, context);
  return {
    requests,
    pick: (callback) => context.Bridge.pickImage(callback),
    deliver: (image, token) => context.window.__itOnImage(image, token),
  };
}

{
  const test = nativeFixture(true);
  const images = [];
  const backgrounds = [];
  test.pick((image) => images.push(image));
  test.pick((image) => backgrounds.push(image));
  assert.notEqual(test.requests[0], test.requests[1], 'Every native picker has its own token');
  test.deliver('synthetic-old-translation-image', test.requests[0]);
  test.deliver('synthetic-tokenless-result');
  assert.deepEqual(images, [], 'The replaced image callback stays inactive');
  assert.deepEqual(backgrounds, [], 'A stale import cannot become the new wallpaper');
  test.deliver('synthetic-wallpaper', test.requests[1]);
  test.deliver('synthetic-duplicate-wallpaper', test.requests[1]);
  assert.deepEqual(backgrounds, ['synthetic-wallpaper'], 'The matching result is accepted once');
}

{
  const test = nativeFixture(false);
  const images = [];
  test.pick((image) => images.push(image));
  test.deliver('synthetic-legacy-image');
  assert.deepEqual(test.requests, [null], 'Older native bridges keep their original picker');
  assert.deepEqual(images, ['synthetic-legacy-image'], 'Older native callbacks remain supported');
}

console.log('Delayed image import ownership checks passed.');
