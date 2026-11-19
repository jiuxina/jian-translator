/* Test-server-only preload. Never referenced by shipped production assets. */
(function () {
  'use strict';
  var originalFetch = window.fetch.bind(window);
  var channel = new BroadcastChannel('jian-internal-browser-audit');
  var scenario = 'hold';
  var sequence = 0;
  var requests = [];
  var pendingFiles = [];
  var pendingClipboard = [];
  var encoder = new TextEncoder();
  function record(type, detail) {
    var event = { type: type, detail: detail || {}, at: Date.now() };
    channel.postMessage(event);
    originalFetch('/__audit/evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event) }).catch(function () {});
  }
  function event(json, newline) { return 'data: ' + JSON.stringify(json) + (newline || '\n') + (newline || '\n'); }
  function write(request, raw) {
    try { request.stream.enqueue(encoder.encode(raw)); } catch (_) {}
  }
  function complete(request, kind) {
    if (request.completed) return;
    request.completed = true;
    if (kind === 'empty') write(request, event({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    else if (kind === 'error') write(request, 'event: error\ndata: {"error":{"message":"合成服务错误"}}\n\n');
    else if (kind === 'length') write(request, event({ choices: [{ delta: {}, finish_reason: 'length' }] }));
    else if (kind === 'eof') { /* Intentionally omit any finish reason. */ }
    else {
      var newline = kind === 'crlf' ? '\r\n' : '\n';
      write(request, event({ choices: [{ delta: { content: '【完整合成译文】' }, finish_reason: null }] }, newline));
      if (kind === 'tail') write(request, 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      else write(request, event({ choices: [{ delta: {}, finish_reason: 'stop' }] }, newline) + 'data: [DONE]' + newline + newline);
    }
    try { request.stream.close(); } catch (_) {}
    record('completed', { id: request.id, kind: kind || 'stop' });
  }
  window.fetch = function (url, options) {
    if (String(url).indexOf('https://index-translate.bilibili.com/v1/chat/completions') === 0) {
      var payload = JSON.parse(options.body);
      var request = { id: ++sequence, payload: payload, scenario: scenario, completed: false };
      requests.push(request);
      var stream = new ReadableStream({ start: function (controller) { request.stream = controller; },
        cancel: function () { record('reader-cancelled', { id: request.id }); } });
      if (options.signal) options.signal.addEventListener('abort', function () { record('aborted', { id: request.id }); });
      record('request', { id: request.id, scenario: scenario, model: payload.model,
        prompt: payload.messages[0].content, maxTokens: payload.max_tokens });
      if (scenario !== 'empty') write(request, event({ choices: [{ delta: { content: '【合成预览】' }, finish_reason: null }] }, scenario === 'crlf' ? '\r\n' : '\n'));
      if (['normal', 'length', 'error', 'eof', 'crlf', 'tail', 'empty'].indexOf(scenario) !== -1) {
        setTimeout(function () { complete(request, request.scenario === 'normal' ? 'stop' : request.scenario); }, 60);
      }
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    if (String(url).indexOf('https://api.github.com/') === 0) {
      return Promise.resolve(new Response(JSON.stringify({ tag_name: 'v2.4.2',
        html_url: 'https://github.com/jiuxina/jian-translator/releases/tag/v2.4.2' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    var resolved = new URL(String(url), location.href);
    if (resolved.origin === location.origin || resolved.protocol === 'data:' || resolved.protocol === 'blob:') return originalFetch(url, options);
    record('blocked-external', { origin: resolved.origin });
    return Promise.reject(new Error('External requests blocked by synthetic fixture'));
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: function (text) { record('copied', { text: text }); return Promise.resolve(); },
    readText: function () { return Promise.resolve('合成剪贴板文本'); },
    read: function () {
      function image() { return [{ types: ['image/png'], getType: function () {
        var bytes = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMCAO+aH9sAAAAASUVORK5CYII=');
        return Promise.resolve(new Blob([Uint8Array.from(bytes, function (value) { return value.charCodeAt(0); })], { type: 'image/png' }));
      } }]; }
      if (scenario === 'clipboard-hold') return new Promise(function (resolve) { pendingClipboard.push(function () { resolve(image()); }); record('clipboard-waiting'); });
      return Promise.resolve(scenario === 'clipboard-image' ? image() : []);
    }
  } });
  var inputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.id !== 'doc-file') return inputClick.call(this);
    var file = new File(['合成文件旧内容'], 'synthetic-audit.txt', { type: 'text/plain' });
    Object.defineProperty(this, 'files', { configurable: true, value: [file] });
    this.dispatchEvent(new Event('change'));
  };
  var readAsText = FileReader.prototype.readAsText;
  FileReader.prototype.readAsText = function (file, encoding) {
    var reader = this;
    if (file.name === 'synthetic-audit.txt' && scenario === 'import-hold') {
      pendingFiles.push(function () { readAsText.call(reader, file, encoding); }); record('file-waiting'); return;
    }
    return readAsText.call(this, file, encoding);
  };
  channel.onmessage = function (message) {
    var data = message.data;
    if (data.type === 'scenario') { scenario = data.value; record('scenario-ready', { scenario: scenario }); }
    if (data.type === 'finish') requests.forEach(function (request) { complete(request, data.value || 'stop'); });
    if (data.type === 'release-file') pendingFiles.splice(0).forEach(function (release) { release(); });
    if (data.type === 'release-clipboard') pendingClipboard.splice(0).forEach(function (release) { release(); });
    if (data.type === 'native-selection' && window.__itTranslateSelection) {
      window.__itTranslateSelection('合成原生划词', 'internal-browser-selection-' + data.value);
      record('selection-delivered', { id: data.value });
    }
    if (data.type === 'ping') record('scenario-ready', { scenario: scenario });
  };
  window.addEventListener('error', function (error) { record('page-error', { message: error.message }); });
  window.addEventListener('unhandledrejection', function (error) { record('page-rejection', { message: String(error.reason) }); });
  record('fixture-ready', { scenario: scenario });
})();
