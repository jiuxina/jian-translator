/* Reproducible offline preview: the app is unchanged; only platform/network boundaries are synthetic. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.build', 'mobile-actions-preview');
const resources = ['index.html', 'theme.css', 'app.js', 'langs.js', 'liquid-glass.js', 'updates.js', 'translation-stream.js'];
const decoder = new TextDecoder('utf-8', { fatal: true });
const fixture = String.raw`
(function () {
  'use strict';
  var query = new URLSearchParams(location.search);
  var evidence = { fixture: 'offline-mobile-actions', platform: query.get('platform') === 'desktop' ? 'desktop' : 'android',
    hold: query.get('hold') === '1', hideCount: 0, requests: [], events: [], transitions: [], errors: [] };
  var serial = 0;
  function now() { return Math.round(performance.now() * 100) / 100; }
  function focus() {
    var active = document.activeElement;
    return active ? { id: active.id || null, tag: active.tagName || null, editable: !!active.isContentEditable } : null;
  }
  function publish() {
    var node = document.getElementById('mobile-actions-evidence');
    if (!node && document.body) {
      node = document.createElement('script');
      node.id = 'mobile-actions-evidence';
      node.type = 'application/json';
      document.body.appendChild(node);
    }
    if (node) node.textContent = JSON.stringify(evidence);
  }
  function record(kind, detail) {
    evidence.events.push(Object.assign({ sequence: ++serial, kind: kind, at: now() }, detail || {}));
    if (evidence.events.length > 80) evidence.events.shift();
    publish();
  }
  function memoryStorage() {
    var entries = new Map();
    return { getItem: function (key) { return entries.has(String(key)) ? entries.get(String(key)) : null; },
      setItem: function (key, value) { entries.set(String(key), String(value)); },
      removeItem: function (key) { entries.delete(String(key)); }, clear: function () { entries.clear(); },
      key: function (index) { return Array.from(entries.keys())[index] || null; },
      get length() { return entries.size; } };
  }
  // Each fixture session starts empty and never inspects persisted browser preferences.
  Object.defineProperty(window, 'localStorage', { value: memoryStorage() });
  Object.defineProperty(window, 'sessionStorage', { value: memoryStorage() });
  if (evidence.platform === 'desktop') {
    window.__JIAN_DESKTOP__ = { platform: 'win32', invoke: function (command) {
      if (command === 'it_get_settings') return Promise.resolve({});
      if (command === 'it_list_system_fonts') return Promise.resolve([]);
      return Promise.resolve([]);
    } };
  } else {
    window.NativeBridge = { platform: function () { return 'android'; },
      getSystemAppearance: function () { return 'light'; }, applyAppearance: function () {},
      commitAppearance: function () { return true; }, bridgeReady: function () {},
      hideKeyboard: function () { evidence.hideCount++; record('native-hide', { focus: focus(), count: evidence.hideCount }); },
      acknowledgeImage: function () {}, acknowledgeDocumentImport: function () {},
      pickImage: function () {}, pickImageWithToken: function () {}, toast: function () {} };
  }
  var originalFetch = window.fetch.bind(window);
  window.fetch = function (input, options) {
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.href !== 'https://index-translate.bilibili.com/v1/chat/completions') {
      if (url.origin === location.origin || url.protocol === 'data:' || url.protocol === 'blob:') return originalFetch(input, options);
      record('blocked-external-request', { origin: url.origin });
      return Promise.reject(new Error('Offline mobile preview blocks external requests'));
    }
    var request = { id: evidence.requests.length + 1, at: now(), focus: focus(), hideCount: evidence.hideCount,
      held: evidence.hold, aborted: false, cancelled: false, completed: false };
    evidence.requests.push(request);
    record('translation-request', { id: request.id, focus: request.focus, hideCount: request.hideCount });
    var encoder = new TextEncoder(), timer = 0, active = true, controller;
    var signal = options && options.signal;
    function cleanup() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort); }
    function abort() {
      request.aborted = true;
      if (active) { active = false; controller.error(new DOMException('Offline request cancelled', 'AbortError')); }
      cleanup(); record('translation-abort', { id: request.id, completed: request.completed });
    }
    function frame(value) { return encoder.encode('data: ' + JSON.stringify(value) + '\n\n'); }
    var body = new ReadableStream({
      start: function (stream) {
        controller = stream;
        if (signal && signal.aborted) { abort(); return; }
        if (signal) signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(function () {
          if (!active) return;
          stream.enqueue(frame({ choices: [{ delta: { content: '这是离线测试译文。' }, finish_reason: null }] }));
          if (evidence.hold) { record('translation-preview', { id: request.id }); return; }
          stream.enqueue(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
          stream.enqueue(encoder.encode('data: [DONE]\n\n'));
          request.completed = true; active = false; stream.close(); cleanup();
          record('translation-complete', { id: request.id });
        }, 150);
      },
      cancel: function () { request.cancelled = true; active = false; cleanup(); record('translation-reader-cancel', { id: request.id }); },
    });
    return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  };
  function rectangle(element) {
    var box = element.getBoundingClientRect();
    function value(number) { return Math.round(number * 100) / 100; }
    return { left: value(box.left), top: value(box.top), right: value(box.right), bottom: value(box.bottom),
      width: value(box.width), height: value(box.height) };
  }
  function animationState(element) {
    return element.getAnimations().map(function (animation) {
      var effect = animation.effect;
      return { state: animation.playState, currentTime: animation.currentTime,
        duration: effect && effect.getTiming().duration,
        frames: effect ? effect.getKeyframes().map(function (frame) {
          var selected = {};
          ['offset', 'computedOffset', 'opacity', 'transform', 'translate'].forEach(function (key) {
            if (frame[key] != null) selected[key] = frame[key];
          });
          return selected;
        }) : [] };
    });
  }
  function panelSnapshot(mode) {
    var panel = document.getElementById('pane-' + mode);
    if (!panel) return null;
    var surfaces = Array.from(panel.querySelectorAll('.models, .panes > .card, .dock > button:not([hidden])'));
    return { mode: mode, selected: panel.classList.contains('on'), leaving: panel.classList.contains('it-tab-leave'),
      scrollTop: panel.scrollTop,
      elements: surfaces.map(function (element, index) {
        var style = getComputedStyle(element);
        return { key: element.id || element.className + ':' + index, rect: rectangle(element),
          style: { opacity: style.opacity, transform: style.transform, translate: style.translate,
            display: style.display, visibility: style.visibility }, animations: animationState(element) };
      }) };
  }
  function selected() { var panel = document.querySelector('.pane.on'); return panel ? panel.id : null; }
  function sampleTransition(button) {
    var mode = button.getAttribute('data-tab');
    var oldPanel = document.querySelector('.pane.on');
    var from = oldPanel ? oldPanel.id.slice(5) : mode;
    var modes = Array.from(new Set([from, mode]));
    var transition = { id: ++serial, from: from, to: mode, at: now(),
      before: modes.map(panelSnapshot), samples: [] };
    evidence.transitions.push(transition);
    if (evidence.transitions.length > 8) evidence.transitions.shift();
    var start = performance.now();
    function tick() {
      if (evidence.transitions.indexOf(transition) < 0) return;
      transition.samples.push({ elapsed: Math.round(performance.now() - start), selected: selected(),
        panels: modes.map(panelSnapshot) });
      publish();
      if (performance.now() - start < 650 && transition.samples.length < 50) requestAnimationFrame(tick);
      else { transition.finished = true; publish(); }
    }
    requestAnimationFrame(tick); publish();
  }
  document.addEventListener('click', function (event) {
    var element = event.target instanceof Element ? event.target.closest('button') : null;
    if (!element) return;
    record('click', { id: element.id || null, focus: focus(), selected: selected(), rect: rectangle(element) });
    if (element.matches('.tabs button[data-tab]')) sampleTransition(element);
  }, true);
  document.addEventListener('focusin', function () { record('focusin', { focus: focus() }); });
  document.addEventListener('focusout', function () { record('focusout', { focus: focus() }); });
  window.addEventListener('resize', function () { record('resize', { width: innerWidth, height: innerHeight }); });
  window.addEventListener('error', function (event) { evidence.errors.push({ type: 'error', message: event.message }); publish(); });
  window.addEventListener('unhandledrejection', function (event) {
    evidence.errors.push({ type: 'unhandledrejection', message: String(event.reason && event.reason.message || event.reason) }); publish();
  });
  document.addEventListener('DOMContentLoaded', function () { record('ready', { focus: focus(), width: innerWidth, height: innerHeight }); });
})();
`;

await mkdir(output, { recursive: true });
for (const name of resources) {
  const bytes = await readFile(path.join(root, 'web', name));
  const text = decoder.decode(bytes);
  if (name === 'index.html') {
    assert.ok(text.includes('</head>'), 'Preview HTML has a head for the offline boundary fixture');
    const preload = `<script>\n${fixture}\n</script>\n`;
    await writeFile(path.join(output, name), text.replace('</head>', preload + '</head>'), 'utf8');
  } else await writeFile(path.join(output, name), bytes);
}
console.log(`Prepared offline mobile actions preview: ${output}`);
console.log('Serve with: node tests/serve-preview.mjs .build/mobile-actions-preview 8901');
console.log('Options: ?hold=1 keeps a cancellable stream open; ?platform=desktop selects the isolated desktop bridge.');
