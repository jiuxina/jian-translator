/* Production language options and image conversion with synthetic DOM/canvas. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const read = async name => new TextDecoder('utf-8', { fatal: true }).decode(await readFile(new URL(name, import.meta.url)));
const source = (await read('../web/app.js')).replace(/\r\n/g, '\n');
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function node() { return { children: [], appendChild(child) { this.children.push(child); } }; }
const src = node(), tgt = node();
const languages = { zh: '中文', en: '英语', eo: '世界语', is: '冰岛语' };
const context = vm.createContext({ document: { createElement: node }, LANGS: languages, COMMON: ['zh', 'en'],
  $: id => id === 'src-lang' ? src : tgt, langName: code => languages[code] });
vm.runInContext(extract('  function fillLangSelects()', '  /* ---------------- 3.5') + '\nfillLangSelects();', context);
assert.deepEqual(src.children.map(item => item.value), ['auto', 'zh', 'en', 'eo', 'is']);
assert.equal(src.children.find(item => item.value === 'is').textContent, '冰岛语');

const operations = [];
let image;
const imageContext = vm.createContext({ Image: class { constructor() { image = this; this.width = 200; this.height = 100; } },
  document: { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ set fillStyle(value) { operations.push(['color', value]); },
      fillRect: () => operations.push(['white']), drawImage: () => operations.push(['draw']) }),
    toDataURL: type => { operations.push(['encode', type]); return 'opaque-jpeg'; } }) } });
vm.runInContext(extract('  function shrinkImage(', '  /* ---------------- 3.') +
  '\nshrinkImage("synthetic-transparent-png", value => globalThis.result = value);', imageContext);
image.onload();
assert.equal(imageContext.result, 'opaque-jpeg');
assert.deepEqual(operations, [['color', '#FFFFFF'], ['white'], ['draw'], ['encode', 'image/jpeg']]);
const html = await read('../web/index.html');
const css = await read('../web/theme.css');
for (const mode of ['text', 'syllable', 'doc']) assert.match(html, new RegExp(`id="btn-cancel-${mode}" hidden`));
assert.match(css, /\.dock > \[hidden\]\s*\{\s*display:\s*none;/);
assert.ok(html.indexOf('translation-stream.js') < html.indexOf('src="app.js'));
console.log('Audit UX checks passed: all source languages, opaque JPEG, cancel visibility and script wiring.');
