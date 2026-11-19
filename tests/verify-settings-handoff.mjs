/* Production category transactions with synthetic DOM, optical work and animation samples. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = new TextDecoder('utf-8', { fatal: true })
  .decode(await readFile(new URL('../web/app.js', import.meta.url))).replace(/\r\n/g, '\n');
const start = source.indexOf('    function setSettingsSection(section)');
const end = source.indexOf('    function updatePreferenceControl(control)', start);
assert.ok(start >= 0 && end > start, 'Production category transaction functions exist');
const transactions = source.slice(start, end);
const revealProperty = '--it-settings-page-reveal';

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    contains(name) { return values.has(name); },
    toggle(name, enabled) { if (enabled) values.add(name); else values.delete(name); },
  };
}

function style() {
  const values = new Map();
  const result = {
    getPropertyValue(name) { return values.get(name) || ''; },
    setProperty(name, value) { values.set(name, String(value)); },
    removeProperty(name) { const previous = values.get(name) || ''; values.delete(name); return previous; },
  };
  for (const [property, css] of [['transform', 'transform'], ['transition', 'transition'], ['zIndex', 'z-index']]) {
    Object.defineProperty(result, property, {
      get() { return result.getPropertyValue(css); },
      set(value) { result.setProperty(css, value); },
    });
  }
  return result;
}

function fixture({ reduced = false } = {}) {
  const names = ['appearance', 'reading', 'background', 'motion'];
  const tracks = new Map();
  const preparations = [];
  const ready = new Set(['appearance']);
  const notices = [];
  const attributes = () => {
    const values = new Map();
    return {
      setAttribute(name, value) { values.set(name, String(value)); },
      getAttribute(name) { return values.get(name) ?? null; },
      removeAttribute(name) { values.delete(name); },
    };
  };
  const pages = new Map(names.map((name, index) => {
    const page = {
      name, hidden: index !== 0, inert: index !== 0, scrollTop: 80 + index * 20,
      classList: classList(), style: style(), offsetWidth: 500,
      ...attributes(), contains(node) { return node?.page === page; },
    };
    page.setAttribute('data-pref-section', name);
    page.setAttribute('aria-hidden', index === 0 ? 'false' : 'true');
    return [name, page];
  }));
  const tabs = new Map(names.map((name) => [name, {
    focus() { context.document.activeElement = this; },
  }]));
  const body = attributes();
  const reset = { disabled: false };
  const modal = {
    classList: classList(['on']),
    querySelector(selector) {
      if (selector === '.it-set-body') return body;
      if (selector === '[data-reset-section]') return reset;
      const page = selector.match(/^\[data-pref-section="([^"]+)"\]$/);
      if (page) return pages.get(page[1]) || null;
      const tab = selector.match(/^\[data-pref-tab="([^"]+)"\]$/);
      if (tab) return tabs.get(tab[1]) || null;
      throw new Error(`Unexpected selector: ${selector}`);
    },
    querySelectorAll(selector) {
      if (selector === '[data-pref-section]') return [...pages.values()];
      if (selector === '[data-pref-section]:not([hidden])') return [...pages.values()].filter((page) => !page.hidden);
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };
  const root = {};
  const context = vm.createContext({
    AbortController, Number, modal,
    window: { ItLiquidGlass: { isReady: (page) => ready.has(page.name) } },
    document: { activeElement: null, documentElement: root },
    shownSection: 'appearance', activeSection: 'appearance', sectionIntent: 'appearance',
    sectionTransitionTarget: '', sectionPaintTarget: '', sectionTransitionFrom: '',
    sectionTransitionSources: [], sectionTransitionPhase: '', sectionTransitionSeq: 0,
    sectionTransitionTimer: 0, sectionTransitionFrame: 0, sectionPreparation: null,
    stagedSections: new WeakMap(), settingsLoaded: true, recording: null,
    settingsRevealProperty: true, SCENE_EASE: 'linear', settleSettingsSection: null,
    motionReduced: () => reduced,
    cssDuration: () => 140,
    closeSelect() {}, flushPreferencePreview() {}, stopRecord() {}, fill() {},
    updateSettingsNavigation() {}, clearTimeout() {}, cancelAnimationFrame() {},
    toast(message) { notices.push(message); },
    getComputedStyle(page) {
      if (page === root) return { getPropertyValue: () => 'linear' };
      return {
        transform: page.sample?.transform || page.style.transform ||
          (page.classList.contains('is-entering') ? 'matrix(1, 0, 0, 1, 0, 5)' : 'none'),
        getPropertyValue(name) {
          if (name === revealProperty && page.sample) return String(page.sample.reveal);
          return page.style.getPropertyValue(name) ||
            (page.classList.contains('is-leaving') || page.classList.contains('is-entering') ? '0' : '1');
        },
      };
    },
    stopMotion(page) { tracks.delete(page); delete page.sample; },
    stopMotionGroup() { tracks.clear(); },
    playMotion(page, frames, duration, done) { tracks.set(page, { frames, duration, done }); },
    followSettingsReveal() {},
    preparePageGlass(page, signal) {
      if (ready.has(page.name)) return null;
      return new Promise((resolve, reject) => {
        const entry = { page, signal, resolve() { ready.add(page.name); resolve(true); }, reject };
        preparations.push(entry);
        signal.addEventListener('abort', () => {
          const error = new Error('Synthetic cancellation');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  });
  vm.runInContext(transactions, context);
  return {
    context, pages, tabs, modal, body, reset, ready, tracks, preparations, notices,
    run(code) { return vm.runInContext(code, context); },
    visible() { return [...pages.values()].filter((page) => !page.hidden).map((page) => page.name); },
    complete() {
      const target = pages.get(context.sectionPaintTarget);
      assert.equal(typeof tracks.get(target)?.done, 'function', 'Target owns transaction completion');
      tracks.get(target).done();
    },
  };
}

async function flush() { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); }
let checks = 0;
function check(message) { checks++; console.log(`PASS ${message}`); }

{
  const test = fixture();
  const current = test.pages.get('appearance');
  const target = test.pages.get('reading');
  test.run("switchSettingsSection('reading')");
  assert.deepEqual(test.visible(), ['appearance']);
  assert.equal(current.inert, false, 'The old category remains interactive during optical work');
  assert.equal(target.hidden && target.inert, true);
  assert.equal(target.classList.contains('it-glass-section-preparing'), true);
  assert.equal(test.tracks.size, 0, 'Optical preparation does not start the transition');
  test.preparations[0].resolve();
  await flush();
  assert.deepEqual(test.visible(), ['appearance', 'reading']);
  assert.equal(current.inert && target.inert, true, 'Both pages are inert during the handoff');
  assert.equal(test.reset.disabled, true);
  assert.equal(test.body.getAttribute('aria-busy'), 'true');
  assert.equal(test.tracks.get(target).duration, 140);
  test.complete();
  assert.deepEqual(test.visible(), ['reading']);
  assert.equal(target.inert, false);
  assert.equal(target.getAttribute('aria-hidden'), 'false');
  assert.equal(current.scrollTop, 80, 'Page scroll positions survive the transaction');
  assert.equal(test.reset.disabled, false);
  assert.equal(test.body.getAttribute('aria-busy'), null);
  check('Slow optical preparation keeps the old category until a single completed handoff');
}

{
  const test = fixture();
  test.run("switchSettingsSection('reading'); switchSettingsSection('background'); switchSettingsSection('reading')");
  await flush();
  const [first, middle, latest] = test.preparations;
  assert.equal(first.signal.aborted && middle.signal.aborted, true);
  assert.equal(latest.signal.aborted, false);
  assert.deepEqual(test.visible(), ['appearance']);
  assert.equal(test.pages.get('reading').classList.contains('it-glass-section-preparing'), true,
    'An aborted owner cannot remove the latest staging marker for the same page');
  assert.equal(test.pages.get('background').classList.contains('it-glass-section-preparing'), false);
  latest.resolve();
  await flush();
  test.complete();
  assert.deepEqual(test.visible(), ['reading']);
  assert.equal(test.notices.length, 0);
  check('Overlapping preparations commit only the latest request and preserve its staging owner');
}

{
  const test = fixture();
  test.ready.add('reading');
  test.run("switchSettingsSection('reading')");
  const staleFinish = test.tracks.get(test.pages.get('reading')).done;
  test.pages.get('appearance').sample = { reveal: .35, transform: 'matrix(1, 0, 0, 1, 0, -2.4)' };
  test.pages.get('reading').sample = { reveal: .65, transform: 'matrix(1, 0, 0, 1, 0, 1.7)' };
  test.run("switchSettingsSection('background')");
  test.preparations[0].resolve();
  await flush();
  assert.deepEqual(test.visible(), ['appearance', 'reading', 'background']);
  assert.equal(test.context.shownSection, 'appearance', 'The superseded page is not committed');
  assert.deepEqual(Array.from(test.context.sectionTransitionSources, (entry) => entry.page.name),
    ['appearance', 'reading']);
  staleFinish();
  assert.equal(test.context.sectionPaintTarget, 'background', 'A superseded completion cannot own the new target');
  test.complete();
  assert.deepEqual(test.visible(), ['background']);
  assert.equal(test.pages.get('background').inert, false);
  check('A ready third category retargets all painted sources and ignores the stale completion');
}

{
  const test = fixture();
  test.ready.add('reading');
  test.run("switchSettingsSection('reading')");
  const staleFinish = test.tracks.get(test.pages.get('reading')).done;
  test.pages.get('appearance').sample = { reveal: .45, transform: 'matrix(1, 0, 0, 1, 0, -2.2)' };
  test.pages.get('reading').sample = { reveal: .55, transform: 'matrix(1, 0, 0, 1, 0, 2.2)' };
  test.run("switchSettingsSection('appearance')");
  assert.equal(test.context.sectionPaintTarget, 'appearance');
  assert.deepEqual(test.visible(), ['appearance', 'reading']);
  staleFinish();
  assert.equal(test.context.shownSection, 'appearance');
  assert.equal(test.pages.get('reading').inert, true);
  test.complete();
  assert.deepEqual(test.visible(), ['appearance']);
  assert.equal(test.pages.get('appearance').inert, false);
  check('A rapid reversal continues the existing pages and never commits the superseded target');
}

{
  const test = fixture();
  test.ready.add('reading');
  test.run("switchSettingsSection('reading')");
  test.ready.delete('reading');
  test.complete();
  assert.deepEqual(test.visible(), ['appearance'], 'A geometry change cannot commit outdated optical maps');
  assert.equal(test.pages.get('appearance').inert, false);
  assert.equal(test.pages.get('reading').classList.contains('it-glass-section-preparing'), true);
  test.preparations[0].resolve();
  await flush();
  test.complete();
  assert.deepEqual(test.visible(), ['reading']);
  assert.equal(test.context.sectionTransitionPhase, '');
  check('Invalidated target geometry returns to preparation before committing its latest maps');
}

{
  const test = fixture();
  test.ready.add('reading');
  test.run("switchSettingsSection('reading')");
  const staleFinish = test.tracks.get(test.pages.get('reading')).done;
  const samples = new Map([
    ['appearance', { reveal: .6, transform: 'matrix(1, 0, 0, 1, 0, -1.6)' }],
    ['reading', { reveal: .4, transform: 'matrix(1, 0, 0, 1, 0, 3)' }],
  ]);
  for (const [name, sample] of samples) test.pages.get(name).sample = sample;
  test.run('freezeSettingsSectionHandoff()');
  for (const [name, sample] of samples) {
    const page = test.pages.get(name);
    assert.equal(page.style.getPropertyValue(revealProperty), String(sample.reveal));
    assert.equal(page.style.transform, sample.transform, 'Closing freezes the actual transform sample');
  }
  test.modal.classList.remove('on');
  staleFinish();
  assert.deepEqual(test.visible(), ['appearance', 'reading'], 'A closing dialog retains its painted composition');
  test.pages.get('background').classList.add('it-glass-section-preparing');
  test.run("cancelSettingsSectionTransition('background')");
  test.modal.classList.add('on');
  staleFinish();
  assert.deepEqual(test.visible(), ['background']);
  for (const page of test.pages.values()) {
    assert.equal(page.style.transform, '', 'Reopening clears each frozen inline transform');
    assert.equal(page.style.getPropertyValue(revealProperty), '');
    assert.equal(page.style.zIndex, '');
    assert.equal(page.classList.contains('it-glass-section-preparing'), false);
    assert.equal(page.classList.contains('is-entering') || page.classList.contains('is-entered') ||
      page.classList.contains('is-leaving'), false);
    assert.equal(page.inert, page.name !== 'background');
  }
  assert.equal(test.context.sectionTransitionPhase, '');
  assert.equal(test.tracks.size, 0);
  check('Closing freezes the composite and reopening clears frozen transforms, staging and stale tracks');
}

{
  const test = fixture({ reduced: true });
  test.run("switchSettingsSection('motion')");
  assert.deepEqual(test.visible(), ['appearance']);
  test.preparations[0].resolve();
  await flush();
  assert.deepEqual(test.visible(), ['motion']);
  assert.equal(test.pages.get('motion').inert, false);
  assert.equal(test.tracks.size, 0);
  check('Reduced motion still waits for optical readiness before the immediate category change');
}

{
  const test = fixture();
  test.run("switchSettingsSection('reading')");
  test.preparations[0].reject(new Error('Synthetic optical failure'));
  await flush();
  assert.deepEqual(test.visible(), ['appearance']);
  assert.equal(test.pages.get('appearance').inert, false);
  assert.equal(test.pages.get('reading').classList.contains('it-glass-section-preparing'), false);
  assert.equal(test.context.sectionIntent, 'appearance');
  assert.equal(test.context.sectionPreparation, null);
  assert.equal(test.notices.length, 1);
  check('A preparation failure restores the old category and releases the hidden staging state');
}

console.log(`Settings handoff: ${checks}/${checks} synthetic transaction checks passed.`);
