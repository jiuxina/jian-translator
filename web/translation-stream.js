/* Shared Web / desktop popup transport. No UI state lives in this module. */
(function (root) {
  'use strict';
  function request(url, payload, options) {
    options = options || {};
    var started = performance.now(), firstAt = 0, collected = '', usage = null;
    var finishReason = null, terminal = false, timer = 0, reader = null, timedOut = false;
    var controller = new AbortController();
    var signal = options.signal;
    var rejectAbort;
    var aborted = new Promise(function (_, reject) { rejectAbort = reject; });
    function abortError() { var error = new Error('已取消'); error.name = 'AbortError'; return error; }
    function abort() { controller.abort(); rejectAbort(abortError()); }
    if (signal) signal.addEventListener('abort', abort, { once: true });
    if (signal && signal.aborted) abort();
    function arm(ms) {
      clearTimeout(timer);
      timer = setTimeout(function () {
        timedOut = true;
        controller.abort();
        rejectAbort(new Error('请求超时，请重试'));
      }, ms);
    }
    function wait(promise) { return Promise.race([promise, aborted]); }
    function accept(json) {
      if (json.error) throw new Error(json.error.message || String(json.error) || '服务返回错误');
      var choice = json.choices && json.choices[0];
      if (choice && choice.finish_reason != null) {
        finishReason = choice.finish_reason;
        if (finishReason === 'length') throw new Error('译文已截断（length），请缩短原文后重试');
        if (finishReason !== 'stop') throw new Error('翻译未正常完成：' + finishReason);
      }
      var delta = choice && ((choice.delta && choice.delta.content) || (choice.message && choice.message.content));
      if (typeof delta === 'string' && delta) {
        if (!firstAt) firstAt = performance.now();
        collected += delta;
        if (options.onDelta) options.onDelta(delta);
      }
      if (json.usage) usage = json.usage;
    }
    function result() {
      if (finishReason !== 'stop') throw new Error('响应中断，未收到完整结束信息，请重试');
      if (!collected.trim()) throw new Error('服务返回空译文，请重试');
      return { text: collected, usage: usage, ms: performance.now() - started,
        firstMs: firstAt ? firstAt - started : 0, finishReason: finishReason };
    }
    arm(options.connectTimeoutMs || 30000);
    return wait(fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal })).then(function (response) {
      arm(options.idleTimeoutMs || 60000);
      if (!response.ok) return wait(response.text()).then(function (body) {
        throw new Error(options.describeError ? options.describeError(response.status, body) : 'HTTP ' + response.status);
      });
      var contentType = response.headers && response.headers.get('content-type') || '';
      if (/application\/json/i.test(contentType) || !response.body || typeof response.body.getReader !== 'function') {
        return wait(response.json()).then(function (json) { accept(json); return result(); });
      }
      reader = response.body.getReader();
      var decoder = new TextDecoder(), buffer = '', data = [], eventName = '';
      function dispatch() {
        if (!data.length) { eventName = ''; return; }
        var raw = data.join('\n'); data = [];
        var kind = eventName; eventName = '';
        if (raw.trim() === '[DONE]') {
          if (finishReason !== 'stop') throw new Error('响应中断，缺少完整结束原因');
          terminal = true;
          return;
        }
        var json;
        try { json = JSON.parse(raw); } catch (_) { throw new Error('流式响应格式解析失败'); }
        if (kind === 'error') throw new Error(json.error && json.error.message || json.message || '服务返回错误');
        accept(json);
      }
      function line(value) {
        if (terminal) return;
        if (!value) { dispatch(); return; }
        if (value.charAt(0) === ':') return;
        var colon = value.indexOf(':');
        var key = colon === -1 ? value : value.slice(0, colon);
        var val = colon === -1 ? '' : value.slice(colon + 1);
        if (val.charAt(0) === ' ') val = val.slice(1);
        if (key === 'data') data.push(val);
        if (key === 'event') eventName = val;
      }
      function drain(eof) {
        var begin = 0;
        for (var index = 0; index < buffer.length; index++) {
          var ch = buffer.charAt(index);
          if (ch !== '\r' && ch !== '\n') continue;
          if (ch === '\r' && index === buffer.length - 1 && !eof) break;
          line(buffer.slice(begin, index));
          if (ch === '\r' && buffer.charAt(index + 1) === '\n') index++;
          begin = index + 1;
        }
        buffer = buffer.slice(begin);
        if (eof) { if (buffer) line(buffer); buffer = ''; dispatch(); }
      }
      function pump() {
        return wait(reader.read()).then(function (chunk) {
          if (chunk.done) { buffer += decoder.decode(); drain(true); return result(); }
          arm(options.idleTimeoutMs || 60000);
          buffer += decoder.decode(chunk.value, { stream: true });
          drain(false);
          if (terminal) return result();
          return pump();
        });
      }
      return pump();
    }).catch(function (error) {
      if (timedOut) throw new Error('请求超时，请重试');
      throw error;
    }).finally(function () {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      if (reader) {
        try { var cancelled = reader.cancel(); if (cancelled && cancelled.catch) cancelled.catch(function () {}); } catch (_) {}
      }
      controller.abort();
    });
  }
  root.ItTranslationStream = Object.freeze({ request: request });
})(typeof window !== 'undefined' ? window : globalThis);
