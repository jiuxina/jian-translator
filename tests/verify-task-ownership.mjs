/* Real pane handlers with synthetic DOM, network and file reader callbacks. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = new TextDecoder('utf-8', { fatal: true }).decode(
  await readFile(new URL('../web/app.js', import.meta.url))).replace(/\r\n/g, '\n');
function section(from, to) { return source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from))); }
const helpers = source.includes('  /* ---------------- Translation tasks')
  ? section('  /* ---------------- Translation tasks', '  function runText()') : '';
function fixture(initialWindow = {}) {
  const elements = new Map(), handlers = new Map(), pending = [], readers = [], copied = [], decodes = [], notices = [];
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, { id, value: '', textContent: '', dataset: {}, style: {}, hidden: false,
      classList: { add() {}, remove() {}, toggle() {} }, click() {} });
    return elements.get(id);
  };
  const context = vm.createContext({ window: initialWindow, state: { model: { text: 'text', doc: 'doc', syllable: 'syl' },
    src: 'auto', tgt: 'zh', image: null, running: false, controller: null },
    document: { createElement: () => ({ remove() {} }), body: { appendChild() {} } },
    performance, AbortController, MAX_SRC: 8000, imageSeq: 0, imageImportRevision: 0, docEditRevision: 0, docImportSequence: 0,
    nativeImagePickPrefix: 'test', nativeImagePickSequence: 0,
    $: el, on: (target, type, handler) => handlers.set(target.id + ':' + type, handler),
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    readPendingTransfer: () => null, writePendingTransfer() {}, removePendingTransfer() {},
    Bridge: { isMac: false, isAndroid: false }, setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    toast: message => notices.push(message), switchTab() {}, refreshCount() {}, fmtSeconds: () => '1s',
    stopTaskDockMotion() {}, setBusy: (button, busy) => { button.disabled = busy; },
    setImage: (value) => { context.state.image = value; context.imageSeq++; context.imageImportRevision++; },
    shrinkImage: (image, done, fail) => decodes.push({ image, done, fail }),
    outText: (element, text) => { element.textContent = text; }, copyText: (text) => copied.push(text),
    startWriter: (out) => ({ closed: false, push(text) { if (!this.closed) out.textContent += text; },
      commit(text) { if (!this.closed) out.textContent = text; }, stop() { this.closed = true; } }),
    stopActiveWriter() {}, basePayload: (model, prompt) => ({ model, prompt, messages: [{ content: prompt }] }),
    buildInstructionPrompt: (text) => text, buildImagePrompt: (text) => text,
    buildSyllablePrompt: (text) => text, plainPrompt: (text, src, tgt) => ({ text, src, tgt }), maxTokensFor: () => 2000,
    chatStream: (payload, onDelta, signal) => new Promise((resolve, reject) => pending.push({ payload, onDelta, signal, resolve, reject })),
    FileReader: class { constructor() { readers.push(this); } readAsText() {} abort() {} },
  });
  vm.runInContext(helpers + '\n' + section('  function runText()', '  /* 展开和回收') + '\n' +
    section('  function runSyllable()', '  /* ---------------- 12.') +
    '\ninitTextPane(); initSyllablePane(); initDocPane();', context);
  return { context, el, pending, readers, copied, decodes, notices,
    event(id, type = 'click') { handlers.get(id + ':' + type).call(el(id), {}); } };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
{
  const test = fixture();
  test.el('src').value = 'original';
  test.context.runText();
  test.pending[0].onDelta('old partial');
  test.event('btn-clear');
  const error = new Error('cancelled'); error.name = 'AbortError';
  test.pending[0].reject(error);
  await flush();
  assert.equal(test.el('out-text').textContent, '', 'A late abort must not revive cleared text');
}
{
  const test = fixture();
  test.el('src').value = 'text'; test.el('syl-src').value = 'syllable';
  test.context.runText(); test.context.runSyllable();
  assert.equal(test.pending.length, 2, 'Modes own independent tasks');
  test.event('btn-clear-syllable');
  assert.equal(test.pending[0].signal.aborted, false, 'Clearing another mode never aborts text');
  test.event('btn-copy'); assert.deepEqual(test.copied, [], 'No placeholder or incomplete text can be copied');
  test.pending[0].resolve({ text: 'complete', ms: 1 }); await flush();
  test.event('btn-copy'); assert.deepEqual(test.copied, ['complete']);
}
{
  const test = fixture(); test.el('doc-src').value = 'first。second'; test.el('doc-chunk').value = '6';
  test.context.runDoc(); test.context.state.model.doc = 'changed'; test.context.state.tgt = 'en';
  test.pending[0].resolve({ text: 'one', ms: 1 }); await flush();
  assert.equal(test.pending[1].payload.model, 'doc', 'Document model is fixed at task start');
  assert.equal(test.pending[1].payload.prompt.tgt, 'zh', 'Document language is fixed at task start');
}
{
  const test = fixture(); test.el('doc-file').files = [{ name: 'old.txt' }];
  test.event('doc-file', 'change'); test.el('doc-src').value = 'new edit'; test.event('doc-src', 'input');
  test.readers[0].onload({ target: { result: 'late file' } });
  assert.equal(test.el('doc-src').value, 'new edit', 'A delayed import cannot replace newer edits');
}
{
  const test = fixture();
  test.context.window.__itTranslateSelection('selection', 'request-1');
  test.el('src').value = 'my edit';
  test.context.window.__itTranslateSelection('selection', 'request-1');
  assert.equal(test.el('src').value, 'my edit', 'Duplicate selection delivery cannot overwrite input');
  assert.equal(test.pending.length, 1, 'A native request is translated once');
}
{
  const test = fixture();
  test.context.state.image = 'synthetic old image';
  test.context.window.__itTranslateClipboard('clipboard content', 'clipboard-1');
  assert.equal(test.el('src').value, 'clipboard content', 'The shortcut fills the text input');
  assert.equal(test.context.state.image, null, 'A clipboard text request clears the previous image');
  assert.equal(test.pending.length, 1, 'The shortcut starts translation without a second action');
  assert.equal(test.pending[0].payload.prompt.text, 'clipboard content');
  test.el('src').value = 'newer manual edit';
  test.context.window.__itTranslateClipboard('clipboard content', 'clipboard-1');
  assert.equal(test.el('src').value, 'newer manual edit', 'A retried clipboard request preserves newer input');
  assert.equal(test.pending.length, 1, 'A retried clipboard request never starts another translation');
  test.context.window.__itTranslateClipboard('   ', 'clipboard-empty');
  assert.equal(test.el('src').value, 'newer manual edit', 'An empty clipboard preserves the current input');
  assert.equal(test.pending.length, 1, 'An empty clipboard never submits a translation');
}
{
  const test = fixture({ __itPendingSelection: {
    text: 'early clipboard content', id: 'clipboard-startup', kind: 'clipboard'
  } });
  assert.equal(test.el('src').value, 'early clipboard content', 'A startup shortcut is consumed when the pane is ready');
  assert.equal(test.pending.length, 1, 'A startup clipboard action starts exactly one translation');
}
{
  const test = fixture();
  test.el('src').value = 'old input';
  test.context.window.__itTranslateClipboard({ text: 'image alternative text', image: 'data:image/png;base64,c3ludGhldGlj' }, 'image-1');
  assert.equal(test.el('src').value, 'old input', 'Image preparation preserves the previous input until decoding succeeds');
  assert.equal(test.decodes.length, 1, 'The clipboard image uses the shared resize and white-background pipeline');
  assert.equal(test.pending.length, 0, 'Image translation waits for preprocessing');
  test.decodes[0].done('data:image/jpeg;base64,cHJlcGFyZWQ=');
  assert.equal(test.el('src').value, '', 'A decoded clipboard image replaces old text rather than translating alternative text');
  assert.equal(test.context.state.image, 'data:image/jpeg;base64,cHJlcGFyZWQ=');
  assert.equal(test.pending.length, 1, 'A processed clipboard image starts translation automatically');
  assert.equal(test.pending[0].payload.messages[0].content[1].image_url.url, test.context.state.image);
  test.context.window.__itTranslateClipboard({ image: 'data:image/png;base64,c3ludGhldGlj' }, 'image-1');
  assert.equal(test.decodes.length, 1, 'A repeated image delivery neither decodes nor submits twice');
}
for (const action of ['btn-clear', 'img-del', 'manual-text', 'replacement-image', 'new-text-request', 'new-empty-request']) {
  const test = fixture();
  test.context.window.__itTranslateClipboard({ image: 'data:image/png;base64,b2xk' }, 'old-image');
  if (action === 'manual-text') {
    test.el('src').value = 'new edit'; test.event('src', 'input');
  } else if (action === 'replacement-image') test.context.setImage('synthetic newer image');
  else if (action === 'new-text-request') test.context.window.__itTranslateClipboard('new clipboard text', 'new-text');
  else if (action === 'new-empty-request') test.context.window.__itTranslateClipboard('', 'new-empty');
  else test.event(action);
  const previousInput = test.el('src').value;
  const previousImage = test.context.state.image;
  const submissions = test.pending.length;
  test.decodes[0].done('data:image/jpeg;base64,bGF0ZQ==');
  assert.equal(test.el('src').value, previousInput, `${action} keeps input ownership over late image decoding`);
  assert.equal(test.context.state.image, previousImage, `${action} keeps image ownership over late decoding`);
  assert.equal(test.pending.length, submissions, `${action} prevents a late image translation`);
}
{
  const test = fixture({ __itPendingSelection: {
    image: 'data:image/png;base64,c3RhcnR1cA==', id: 'startup-image', kind: 'clipboard'
  } });
  assert.equal(test.decodes.length, 1, 'Startup image payload is retained until the pane is ready');
  test.decodes[0].done('data:image/jpeg;base64,c3RhcnR1cA==');
  assert.equal(test.pending.length, 1, 'A startup image shortcut starts one visual translation');
}
{
  const test = fixture();
  test.context.window.__itTranslateClipboard({ image: 'data:image/png;base64,aW52YWxpZA==' }, 'bad-image');
  test.decodes[0].fail();
  assert.equal(test.pending.length, 0, 'A decode failure never submits a broken image');
  assert.match(test.notices.at(-1), /图片/);
  test.context.window.__itTranslateClipboard({ error: 'clipboard image is too large' }, 'native-error');
  assert.equal(test.pending.length, 0, 'Native image failures never become text to translate');
}
{
  const test = fixture();
  test.el('src').value = 'existing source';
  test.context.setImage('data:image/jpeg;base64,ZXhpc3Rpbmc=');
  test.context.runText();
  const existingTask = test.pending[0];
  const existingPreviewRevision = test.context.imageSeq;
  test.context.window.__itTranslateClipboard({ image: 'data:image/png;base64,YnJva2Vu' }, 'broken-replacement');
  assert.equal(test.el('src').value, 'existing source', 'Preparing a replacement keeps the previous source');
  assert.equal(test.context.state.image, 'data:image/jpeg;base64,ZXhpc3Rpbmc=', 'Preparing a replacement keeps the previous image');
  assert.equal(existingTask.signal.aborted, false, 'Preparing a replacement leaves the active translation running');
  assert.equal(test.context.imageSeq, existingPreviewRevision, 'Preparing an import preserves the existing preview lifecycle');
  test.decodes[0].fail();
  assert.equal(test.el('src').value, 'existing source', 'A failed image decode preserves the previous source');
  assert.equal(test.context.state.image, 'data:image/jpeg;base64,ZXhpc3Rpbmc=', 'A failed image decode preserves the previous image');
  assert.equal(existingTask.signal.aborted, false, 'A failed image decode preserves the active translation');
  assert.equal(test.pending.length, 1, 'A failed replacement does not start another translation');
}
for (const action of ['manual-text', 'img-del', 'btn-clear', 'replacement-image']) {
  const test = fixture();
  test.context.window.__itBeginClipboardTranslation('native-read');
  if (action === 'manual-text') {
    test.el('src').value = 'typed while reading'; test.event('src', 'input');
  } else if (action === 'replacement-image') test.context.setImage('new image while reading');
  else test.event(action);
  test.context.window.__itBeginClipboardTranslation('native-read');
  const previousInput = test.el('src').value;
  const previousImage = test.context.state.image;
  test.context.window.__itTranslateClipboard({ image: 'data:image/png;base64,bGF0ZQ==' }, 'native-read');
  assert.equal(test.el('src').value, previousInput, `${action} wins over a pending native clipboard read`);
  assert.equal(test.context.state.image, previousImage, `${action} keeps the image after native reading`);
  assert.equal(test.decodes.length, 0, `${action} skips decoding an obsolete native clipboard result`);
  assert.equal(test.context.window.__itClipboardTranslationAccepted, 'native-read', 'Discarded native requests are acknowledged');
}
{
  const test = fixture();
  test.context.window.__itBeginClipboardTranslation('old-native-read');
  test.context.window.__itBeginClipboardTranslation('new-native-read');
  test.context.window.__itBeginClipboardTranslation('old-native-read');
  test.context.window.__itTranslateClipboard('old clipboard', 'old-native-read');
  assert.equal(test.pending.length, 0, 'An older clipboard read cannot replace the latest request');
  test.context.window.__itTranslateClipboard('new clipboard', 'new-native-read');
  assert.equal(test.el('src').value, 'new clipboard');
  assert.equal(test.pending.length, 1, 'The newest native request is translated once');
}
{
  const test = fixture({ __itPendingClipboardStart: 'startup-start', __itPendingSelection: {
    image: 'data:image/png;base64,c3RhcnR1cA==', id: 'startup-start', kind: 'clipboard'
  } });
  assert.equal(test.decodes.length, 1, 'A startup begin marker is consumed before its image payload');
  test.decodes[0].done('data:image/jpeg;base64,c3RhcnR1cA==');
  assert.equal(test.pending.length, 1);
}
{
  const test = fixture();
  let deliver;
  test.context.navigator = { clipboard: { read: () => new Promise((resolve) => { deliver = resolve; }) } };
  test.event('btn-paste');
  test.event('btn-clear');
  deliver([{ types: ['image/png'], getType: async () => ({ synthetic: true }) }]);
  await flush();
  assert.equal(test.readers.length, 0, 'Clearing during clipboard permission wait discards late images');
}
{
  const test = fixture();
  let deliver;
  test.context.navigator = { clipboard: { readText: () => new Promise((resolve) => { deliver = resolve; }) } };
  test.event('btn-paste'); test.event('btn-clear'); deliver('old clipboard'); await flush();
  assert.equal(test.el('src').value, '', 'Clearing during clipboard text read discards late text');
}
{
  const test = fixture();
  let deliver;
  test.context.navigator = { clipboard: { readText: () => new Promise(resolve => { deliver = resolve; }) } };
  test.context.window.__itBeginClipboardTranslation('older-native-read');
  test.event('btn-paste');
  test.context.window.__itTranslateClipboard({ image: 'data:image/png;base64,b2xk' }, 'older-native-read');
  assert.equal(test.decodes.length, 0, 'A newer paste action invalidates a native clipboard read before permissions resolve');
  deliver('newer pasted text');
  await flush();
  assert.equal(test.el('src').value, 'newer pasted text', 'The newer asynchronous paste retains input ownership');
  assert.equal(test.pending.length, 0, 'The superseded native shortcut cannot start an automatic translation');
}
console.log('Translation task ownership and delayed import checks passed.');
