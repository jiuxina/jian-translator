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

function fixture() {
  const elements = new Map();
  const handlers = new Map();
  const pending = [];
  const state = { image: 'synthetic-existing-image', controller: null };
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, value: '', textContent: '', hidden: false });
    return elements.get(id);
  };
  const context = vm.createContext({
    window: {},
    state,
    imageSeq: 0,
    textEditRevision: 0,
    $: element,
    on: (target, type, handler) => handlers.set(`${target.id}:${type}`, handler),
    Bridge: { pickImage: (callback) => pending.push(callback), isMac: false },
    sessionStorage: { getItem: () => null },
    setImage: (image) => {
      state.image = image || null;
      context.imageSeq++;
    },
    refreshCount() {},
    runText() {},
    stopActiveWriter() {},
    bindCancel() {},
    cancelTask() {},
    copyResult() {},
    outText() {},
    copyText() {},
  });
  vm.runInContext(`${source.slice(start, end)}\ninitTextPane();`, context);
  return {
    state,
    pending,
    click: (id) => handlers.get(`${id}:click`)(),
    replace: (image) => context.setImage(image),
  };
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
