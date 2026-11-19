/* ==========================================================================
   笺 · 自绘前端
   --------------------------------------------------------------------------
   取代原先「加载官网 translate.html + 注入 CSS」的方案：界面自己画，请求
   直连官方公开的 OpenAI 兼容接口 https://index-translate.bilibili.com/v1。

   prompt 与官方网页保持同源：
     · 指令模式   —— 逐字移植官网 buildInstructionPrompt()
     · 图片翻译   —— 移植 buildImagePrompt()
     · 音节控制   —— 移植官网 syllable.html 的模板
     · 普通翻译   —— 官网此路径走私有 /translate_stream，服务端模板不可见，
                     这里用等价的单行指令（实测 token 量与输出一致）

   多端共用：Windows 由 Pake 打包本目录，macOS 使用 Chromium 桌面壳，
   Android 放进 assets/ 用 WebView 加载。平台差异只通过 Bridge 暴露。
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------- 0. 常量 ---------------- */
  var API_BASE = 'https://index-translate.bilibili.com/v1';
  var CHAT_URL = API_BASE + '/chat/completions';
  var MAX_SRC = 8000;
  var APP_VERSION = '2.4.3';
  var LANGS = window.IT_LANGS || {};
  var COMMON = window.IT_COMMON_LANGS || [];

  var PLATFORM = (function () {
    if (window.__JIAN_DESKTOP__) return 'desktop';
    if (window.__TAURI_INTERNALS__ || (window.__TAURI__ && window.__TAURI__.core)) return 'desktop';
    if (window.NativeBridge) return 'android';
    return 'web';
  })();

  /* ---------------- 1. 工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn, opt) { if (el) el.addEventListener(ev, fn, opt); }
  function langName(code) { return LANGS[code] || code || ''; }

  var toastTimer = 0;
  function toast(message, isError) {
    var box = $('toast');
    if (!box) return;
    box.textContent = message;
    box.classList.toggle('error', !!isError);
    box.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.remove('on'); }, 2400);
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = label || '翻译中…';
      button.disabled = true;
    } else {
      button.textContent = button.dataset.label || button.textContent;
      button.disabled = false;
    }
  }

  function copyText(text) {
    if (!text) { toast('没有可复制的内容'); return; }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('已复制'); }
      catch (e) { toast('复制失败', true); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制'); }, fallback);
    } else {
      fallback();
    }
  }

  function fmtSeconds(ms) { return (ms / 1000).toFixed(2) + 's'; }

  /* 所有动效统一走这个开关：系统开了「减少动态效果」就退回即时切换 */
  function motionReduced() {
    if (activePreferences && activePreferences.appearance.motion === 'off') return true;
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  function cssDuration(name, fallback) {
    var raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    var value = parseFloat(raw);
    if (!isFinite(value)) return fallback;
    return raw.slice(-2) === 'ms' ? value : value * 1000;
  }

  function cssNumber(name, fallback) {
    var value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
    return isFinite(value) ? value : fallback;
  }

  var PANEL_DURATION = cssDuration('--lg-duration-panel', 280);
  var DIALOG_DURATION = cssDuration('--lg-duration-dialog', 240);
  var SCENE_EASE = getComputedStyle(document.documentElement).getPropertyValue('--lg-ease-scene').trim() ||
    'cubic-bezier(.22,.78,.18,1)';
  var SCENE_DISTANCE = cssNumber('--lg-distance-scene', 28);
  var motions = new Map();
  var closeMenuLayer = null;
  var closeSettingsLayer = null;
  var closeAboutLayer = null;
  var closeInstructLayer = null;
  var settleSettingsSection = null;
  var settingsRevealProperty = false;
  if (typeof CSS !== 'undefined' && typeof CSS.registerProperty === 'function') {
    try {
      CSS.registerProperty({ name: '--it-settings-reveal', syntax: '<number>', inherits: true, initialValue: '1' });
      CSS.registerProperty({ name: '--it-settings-page-reveal', syntax: '<number>', inherits: true, initialValue: '1' });
      settingsRevealProperty = true;
    } catch (error) {
      // A reinjected page may already own the same registered property.
      settingsRevealProperty = error.name === 'InvalidModificationError';
    }
  }

  /* 动画只作用于真实控件。重定向前先读取屏幕上的状态，再取消上一段，
     不克隆输入区，也不把正在翻译的内容换成截图。 */
  function visualStyle(el) {
    var style = getComputedStyle(el);
    return { opacity: style.opacity, transform: style.transform };
  }

  function stopMotion(el) {
    var track = motions.get(el);
    if (!track) return;
    motions.delete(el);
    if (track.revealFrame) cancelAnimationFrame(track.revealFrame);
    track.animation.onfinish = null;
    track.animation.cancel();
  }

  function playMotion(el, frames, duration, done, group, hold, easing) {
    stopMotion(el);
    if (motionReduced() || !el.animate) {
      if (done) done();
      return;
    }
    var animation = el.animate(frames, { duration: duration, easing: easing || SCENE_EASE, fill: 'both' });
    var track = {
      animation: animation,
      group: group,
      finish: function () {
        if (motions.get(el) !== track) return;
        stopMotion(el);
        if (done) done();
      }
    };
    motions.set(el, track);
    animation.onfinish = hold ? null : track.finish;
  }

  function stopMotionGroup(group) {
    Array.from(motions.entries()).forEach(function (entry) {
      if (entry[1].group === group) stopMotion(entry[0]);
    });
  }

  function finishMotions() {
    Array.from(motions.values()).forEach(function (track) {
      if (track.group !== 'settings-page') track.finish();
    });
    settleTabs();
    if (settleSettingsSection) settleSettingsSection();
  }

  function rectOf(origin) {
    return origin && origin.getBoundingClientRect ? origin.getBoundingClientRect() : origin;
  }

  function surfaceTransform(surface, origin) {
    var anchor = rectOf(origin);
    if (!anchor || !anchor.width || !anchor.height) return 'translateY(-8px) scale(.96)';
    var inline = surface.style.transform;
    surface.style.transform = 'none';
    var rect = surface.getBoundingClientRect();
    surface.style.transform = inline;
    var sx = Math.max(.12, Math.min(1, anchor.width / Math.max(1, rect.width)));
    var sy = Math.max(.08, Math.min(1, anchor.height / Math.max(1, rect.height)));
    return 'translate(' + (anchor.left - rect.left) + 'px,' + (anchor.top - rect.top) +
      'px) scale(' + sx + ',' + sy + ')';
  }

  /* 弹层从实际入口所在的位置展开，关闭时沿同一路径回收。
     leave 类只保持绘制；交互与辅助技术状态在操作当帧更新。 */
  function moveSurface(surface, origin, opening, done) {
    if (surface.classList.contains('it-set')) {
      moveSettingsSurface(surface, origin, opening, done);
      return;
    }
    var continuing = motions.has(surface);
    var current = continuing ? visualStyle(surface) : null;
    stopMotion(surface);
    surface.classList.toggle('on', opening);
    surface.classList.toggle('it-surface-leave', !opening);
    var collapsed = surfaceTransform(surface, origin);
    var from = current || {
      opacity: opening ? '0' : '1',
      transform: opening ? collapsed : 'none'
    };
    playMotion(surface, [from, {
      opacity: opening ? '1' : '0',
      transform: opening ? 'none' : collapsed
    }], DIALOG_DURATION, function () {
      surface.classList.remove('it-surface-leave');
      if (done) done();
    }, 'surface');
  }

  function moveSettingsSurface(surface, origin, opening, done) {
    var continuing = motions.has(surface);
    var current = getComputedStyle(surface);
    var reveal = continuing ? parseFloat(current.getPropertyValue('--it-settings-reveal')) : (opening ? 0 : 1);
    if (!Number.isFinite(reveal)) reveal = opening ? 0 : 1;
    var transform = continuing ? current.transform : null;
    stopMotion(surface);
    surface.classList.toggle('on', opening);
    surface.classList.toggle('it-surface-leave', !opening);
    // Opacity on a glass ancestor creates a backdrop root: its descendants
    // cannot refract the scene behind the dialog until that opacity reaches 1.
    // Fade only paint leaves and the glass layer itself; the scene stays opaque.
    var opticalNodes = '[data-it-liquid-preset], [data-it-liquid-background], [data-it-liquid-progressive]';
    function markLeaves(parent) {
      Array.prototype.forEach.call(parent.children, function (child) {
        if (child.matches('[data-it-liquid-background], [data-it-liquid-progressive]') ||
            (!child.matches(opticalNodes) && !child.querySelector(opticalNodes))) {
          child.setAttribute('data-it-settings-fade', '');
        } else {
          child.removeAttribute('data-it-settings-fade');
          markLeaves(child);
        }
      });
      if (parent.matches('[data-it-liquid-preset]')) {
        Array.prototype.slice.call(parent.childNodes).forEach(function (node) {
          if (node.nodeType !== 3 || !node.textContent.trim()) return;
          var label = document.createElement('span');
          label.setAttribute('data-it-settings-fade', '');
          label.textContent = node.textContent;
          parent.replaceChild(label, node);
        });
      }
    }
    markLeaves(surface);
    var collapsed = surfaceTransform(surface, origin);
    var from = { transform: transform || (opening ? collapsed : 'none') };
    var to = { transform: opening ? 'none' : collapsed };
    if (settingsRevealProperty) {
      from['--it-settings-reveal'] = String(reveal);
      to['--it-settings-reveal'] = opening ? '1' : '0';
    }
    surface.style.setProperty('--it-settings-reveal', String(reveal));
    playMotion(surface, [from, to], DIALOG_DURATION, function () {
      // Keep the terminal paint state after cancelling the animation. Removing
      // this property would restore its default (1) for a closing surface.
      surface.style.setProperty('--it-settings-reveal', opening ? '1' : '0');
      surface.classList.remove('it-surface-leave');
      if (done) done();
    }, 'surface');
    // Older WebViews can animate the same paint variable using the existing
    // animation's eased progress instead of dropping the fade.
    if (!settingsRevealProperty) followSettingsReveal(surface, '--it-settings-reveal', reveal, opening ? 1 : 0);
  }

  function followSettingsReveal(surface, property, from, to) {
    var track = motions.get(surface);
    if (!track) return;
    function updateReveal() {
      if (motions.get(surface) !== track) return;
      var progress = track.animation.effect.getComputedTiming().progress;
      if (progress != null) surface.style.setProperty(property, String(from + (to - from) * progress));
      track.revealFrame = requestAnimationFrame(updateReveal);
    }
    updateReveal();
  }

  /* 浏览器 Escape 与 Android 返回键共用；每次只回收最上面一层。 */
  window.__itHandleBack = function () {
    if (openSelect) { closeSelect(); return true; }
    if (closeAboutLayer && closeAboutLayer()) return true;
    if (closeSettingsLayer && closeSettingsLayer()) return true;
    if (closeMenuLayer && closeMenuLayer()) return true;
    return !!(closeInstructLayer && closeInstructLayer());
  };

  /* ---------------- 2. 平台桥 ---------------- */
  var nativeImagePickSequence = 0;
  var nativeImagePickPrefix = Date.now().toString(36) + ':' + Math.random().toString(36).slice(2);
  function readPendingTransfer(key) {
    var raw = null;
    try { raw = localStorage.getItem(key); } catch (_) {}
    if (!raw) { try { raw = sessionStorage.getItem(key); } catch (_) {} }
    try { return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  function writePendingTransfer(key, value) {
    var raw = JSON.stringify(value);
    try { localStorage.setItem(key, raw); } catch (_) {}
    try { sessionStorage.setItem(key, raw); } catch (_) {}
  }
  function removePendingTransfer(key) {
    try { localStorage.removeItem(key); } catch (_) {}
    try { sessionStorage.removeItem(key); } catch (_) {}
  }
  var Bridge = {
    isDesktop: PLATFORM === 'desktop',
    isMac: !!(window.__JIAN_DESKTOP__ && window.__JIAN_DESKTOP__.platform === 'darwin'),
    isAndroid: PLATFORM === 'android',

    invoke: function (cmd, args) {
      if (window.__JIAN_DESKTOP__ && typeof window.__JIAN_DESKTOP__.invoke === 'function') {
        return window.__JIAN_DESKTOP__.invoke(cmd, args || {});
      }
      var internals = window.__TAURI_INTERNALS__;
      if (internals && typeof internals.invoke === 'function') {
        return internals.invoke(cmd, args || {}, {});
      }
      if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        return window.__TAURI__.core.invoke(cmd, args || {});
      }
      return Promise.reject(new Error('桌面通信不可用'));
    },

    /* 选图：桌面用原生 file input，安卓走原生相册/相机 */
    pickImage: function (onPicked, purpose) {
      if (Bridge.isAndroid && window.NativeBridge && window.NativeBridge.pickImage) {
        purpose = purpose || 'translation';
        var token = nativeImagePickPrefix + ':' + (++nativeImagePickSequence);
        var usesTokens = typeof window.NativeBridge.pickImageWithToken === 'function';
        var delivered = false;
        writePendingTransfer('it-image-import', { token: token, purpose: purpose });
        window.__itOnImage = function (dataUrl, returnedToken) {
          if (delivered || (usesTokens && returnedToken !== token)) {
            if (window.NativeBridge.acknowledgeImage) window.NativeBridge.acknowledgeImage(returnedToken || '');
            return;
          }
          delivered = true;
          Promise.resolve(onPicked(dataUrl)).then(function () {
            if (window.NativeBridge.acknowledgeImage) window.NativeBridge.acknowledgeImage(token);
            var pending = readPendingTransfer('it-image-import');
            if (pending && pending.token === token) removePendingTransfer('it-image-import');
          });
        };
        try {
          if (window.NativeBridge.pickImageWithTokenAndPurpose) window.NativeBridge.pickImageWithTokenAndPurpose(token, purpose);
          else if (usesTokens) window.NativeBridge.pickImageWithToken(token);
          else window.NativeBridge.pickImage();
        } catch (e) { toast('无法打开相册', true); }
        return;
      }
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        input.remove();
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function (ev) { shrinkImage(ev.target.result, onPicked); };
        reader.onerror = function () { toast('读取图片失败', true); };
        reader.readAsDataURL(file);
      });
      input.click();
    },

    /* 背景图：桌面存 localStorage，安卓走原生内部存储 */
    setBackground: function (dataUrl) {
      if (Bridge.isAndroid && window.NativeBridge && window.NativeBridge.setBackground) {
        try { window.NativeBridge.setBackground(dataUrl); } catch (e) {}
      }
      try { localStorage.setItem('it-bg-data', dataUrl); } catch (e) {}
      applyBackground(dataUrl);
    },

    resetBackground: function () {
      if (Bridge.isAndroid && window.NativeBridge && window.NativeBridge.resetBackground) {
        try { window.NativeBridge.resetBackground(); } catch (e) {}
      }
      try { localStorage.removeItem('it-bg-data'); } catch (e) {}
      applyBackground('');
    }
  };

  /* 供 Android 原生回填图片 */
  window.__itOnImage = function () {};

  function shrinkImage(dataUrl, done) {
    var img = new Image();
    img.onload = function () {
      try {
        var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        var context = canvas.getContext('2d');
        context.fillStyle = '#FFFFFF';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        done(canvas.toDataURL('image/jpeg', 0.85));
      } catch (e) { done(dataUrl); }
    };
    img.onerror = function () { done(dataUrl); };
    img.src = dataUrl;
  }

  /* ---------------- 3. 语种选择 ---------------- */
  function fillLangSelects() {
    var srcSel = $('src-lang');
    var tgtSel = $('tgt-lang');
    if (!srcSel || !tgtSel) return;

    function opt(value, label) {
      var o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      return o;
    }

    srcSel.appendChild(opt('auto', '自动检测'));
    COMMON.forEach(function (c) { srcSel.appendChild(opt(c, langName(c))); });
    Object.keys(LANGS).forEach(function (c) {
      if (COMMON.indexOf(c) === -1) srcSel.appendChild(opt(c, langName(c)));
    });

    var g1 = document.createElement('optgroup');
    g1.label = '常用';
    COMMON.forEach(function (c) { g1.appendChild(opt(c, langName(c))); });
    var g2 = document.createElement('optgroup');
    g2.label = '全部语种';
    Object.keys(LANGS).forEach(function (c) {
      if (COMMON.indexOf(c) === -1) g2.appendChild(opt(c, langName(c)));
    });
    tgtSel.appendChild(g1);
    tgtSel.appendChild(g2);

    srcSel.value = 'auto';
    tgtSel.value = 'zh';
  }

  /* ---------------- 3.5 自绘下拉 ---------------- */
  /* 原生 select 的弹层由系统绘制，CSS 改不到，所以只留它当数据源，
     视觉全部交给 .sel-btn + .sel-pop。语言列表超过 12 项时附带搜索框。
     当前选定文字用一条竖向轮盘条带呈现：条带严格按列表顺序排列，从旧项
     滚到新项，滚过的格数 = 两项在列表中的距离；往下选向上滚、往上选向下滚。 */
  var openSelect = null;
  var enhancedSelects = [];
  var REEL_ROW = cssNumber('--lg-reel-row-height', 20);
  var REEL_BASE = cssDuration('--lg-duration-reel-base', 240);
  var REEL_PER = cssDuration('--lg-duration-reel-step', 34);
  var REEL_MAX = 900;      // 距离很远时的时长上限

  function collectOptions(select) {
    var out = [];
    for (var i = 0; i < select.children.length; i++) {
      var node = select.children[i];
      if (node.tagName === 'OPTGROUP') {
        for (var j = 0; j < node.children.length; j++) {
          var opt = node.children[j];
          var groupedLabel = opt.textContent;
          out.push({ value: opt.value, label: groupedLabel,
            searchLabel: groupedLabel.trim().toLowerCase(), group: node.label,
            disabled: opt.disabled || node.disabled });
        }
      } else if (node.tagName === 'OPTION') {
        var label = node.textContent;
        out.push({ value: node.value, label: label,
          searchLabel: label.trim().toLowerCase(), group: '', disabled: node.disabled });
      }
    }
    return out;
  }

  function sameOptions(items, next) {
    return items.length === next.length && items.every(function (item, index) {
      var option = next[index];
      return item.value === option.value && item.label === option.label &&
        item.group === option.group && item.disabled === option.disabled;
    });
  }

  function closeSelect() {
    if (!openSelect) return;
    var closing = openSelect;
    openSelect = null;
    if (closing.pop.contains(document.activeElement)) closing.button.focus({ preventScroll: true });
    closing.pop.setAttribute('aria-hidden', 'true');
    closing.pop.inert = true;
    closing.button.setAttribute('aria-expanded', 'false');
    moveSurface(closing.pop, closing.button, false);
  }

  function enhanceSelect(select) {
    if (!select || select.dataset.enhanced === '1') return;
    select.dataset.enhanced = '1';

    var wrap = select.parentNode;
    if (!wrap.classList.contains('sel-wrap')) {
      var fieldWrap = document.createElement('span');
      fieldWrap.className = 'sel-wrap it-set-select-wrap';
      wrap.insertBefore(fieldWrap, select);
      fieldWrap.appendChild(select);
      wrap = fieldWrap;
    }
    var items = collectOptions(select);
    var searchable = items.length > 12;
    var labelText = select.getAttribute('aria-label') || '';
    var settingsRow = select.closest('.it-set-row');
    var labelNode = settingsRow && settingsRow.querySelector(':scope > span:not(.sel-wrap)');
    if (!labelText && labelNode) labelText = labelNode.textContent.trim();

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'sel-btn';
    if (['src-lang', 'tgt-lang', 'it-pref-source', 'it-pref-target', 'it-set-lang'].indexOf(select.id) >= 0) {
      button.classList.add('it-language-select');
    }
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    if (labelText) button.setAttribute('aria-label', labelText);
    var valueEl = document.createElement('span');
    valueEl.className = 'sel-value';
    var reelEl = document.createElement('span');
    reelEl.className = 'sel-reel';
    valueEl.appendChild(reelEl);
    button.appendChild(valueEl);
    wrap.insertBefore(button, select);

    var pop = document.createElement('div');
    pop.className = 'sel-pop';
    pop.id = 'it-select-pop-' + (enhancedSelects.length + 1);
    pop.setAttribute('aria-hidden', 'true');
    pop.inert = true;
    button.setAttribute('aria-controls', pop.id);
    pop.innerHTML = (searchable
      ? '<input class="sel-search" type="text" placeholder="搜索…" aria-label="搜索">'
      : '') + '<div class="sel-list" role="listbox"></div>';
    document.body.appendChild(pop);

    var listEl = pop.querySelector('.sel-list');
    var searchEl = pop.querySelector('.sel-search');
    var activeIndex = -1;
    var selectedItemIndex = -1;
    var visibleItems = [];
    var renderedItems;
    var renderedQuery;
    var renderedValue;

    /* 量字宽：轮盘条带取所有候选里最宽的一条，按钮随之平滑变宽 */
    var measure = document.createElement('span');
    measure.setAttribute('aria-hidden', 'true');
    measure.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap';
    document.body.appendChild(measure);
    function widestLabelWidth(labels) {
      /* 保留浏览器的真实字形排版；先一次写入所有候选，再统一量宽，
         避免长轮盘每插入一行就迫使整页重新布局。字体每次从按钮读取，
         不缓存字宽，系统字体或字距变化后仍按当前显示结果计算。 */
      var btnFont = getComputedStyle(button);
      measure.style.font = btnFont.font || '';
      measure.style.fontSize = btnFont.fontSize || '13px';
      measure.style.fontFamily = btnFont.fontFamily || 'inherit';
      measure.style.fontWeight = btnFont.fontWeight;
      measure.style.fontStyle = btnFont.fontStyle;
      measure.style.fontStretch = btnFont.fontStretch;
      measure.style.fontKerning = btnFont.fontKerning;
      measure.style.fontFeatureSettings = btnFont.fontFeatureSettings;
      measure.style.fontVariationSettings = btnFont.fontVariationSettings;
      measure.style.letterSpacing = btnFont.letterSpacing;
      measure.style.wordSpacing = btnFont.wordSpacing;
      measure.style.textTransform = btnFont.textTransform;
      var fragment = document.createDocumentFragment();
      var samples = labels.map(function (text) {
        var sample = document.createElement('span');
        sample.style.display = 'inline-block';
        sample.textContent = text;
        fragment.appendChild(sample);
        return sample;
      });
      measure.textContent = '';
      measure.appendChild(fragment);
      var widest = 0;
      samples.forEach(function (sample) {
        widest = Math.max(widest, sample.getBoundingClientRect().width);
      });
      return widest;
    }
    function clampWidth(w) { return Math.max(16, Math.min(settingsRow ? 156 : 124, Math.ceil(w))); }

    var currentLabel = '';
    var currentValue = select.value;   // 记住旧值，才能算出它在列表里的位置
    var spinSequence = 0;

    function labelOf() {
      var opt = select.options[select.selectedIndex];
      return opt ? opt.textContent : '';
    }

    /* 轮盘按「当前下拉里看到的顺序」走：搜索过滤后就是过滤结果的顺序，
       没开过弹层则退回完整选项列表。返回旧/新值在这个序列里的下标。 */
    function reelOrder(fromValue, toValue) {
      function locate(seq) {
        var a = -1, b = -1;
        for (var i = 0; i < seq.length; i++) {
          if (a < 0 && seq[i].value === fromValue) a = i;
          if (b < 0 && seq[i].value === toValue) b = i;
        }
        return (a >= 0 && b >= 0) ? { seq: seq, from: a, to: b } : null;
      }
      var visible = visibleItems.map(function (row) {
        return { value: row.dataset.value, label: row.textContent };
      });
      return locate(visible) || locate(items) || null;
    }

    function paintRow(text) {
      reelEl.innerHTML = '';
      var row = document.createElement('span');
      row.className = 'sel-reel-row';
      row.textContent = text;
      reelEl.appendChild(row);
      reelEl.style.transition = 'none';
      reelEl.style.transform = 'translateY(0)';
      valueEl.style.width = clampWidth(widestLabelWidth([text])) + 'px';
      void reelEl.offsetWidth;          // 强制回流，避免下一次 spin 从旧位置起跳
      reelEl.style.transition = '';
    }

    function setLabel(text, animate) {
      text = String(text || '');
      var nextValue = select.value;
      var fromValue = currentValue;
      currentValue = nextValue;          // 即使本次不转，起点也要跟着走
      if (text === currentLabel) return;
      var from = currentLabel || text;
      currentLabel = text;
      var sequence = ++spinSequence;
      valueEl.classList.remove('rolling');
      valueEl.style.animationDuration = '';

      if (!animate || motionReduced() || from === text) {
        paintRow(text);
        return;
      }

      var order = reelOrder(fromValue, nextValue);
      if (!order || order.from === order.to) {
        paintRow(text);
        return;
      }

      /* 条带取 [旧项..新项] 的闭区间，顺序与列表完全一致（不随机、不跳项）。
         translateY 从旧项位置过渡到新项位置：新项在下方 → 值更负 → 条带上滚，
         新项在上方 → 值回正 → 条带下滚。滚过的格数就是两者相隔的项数。 */
      var lo = Math.min(order.from, order.to);
      var hi = Math.max(order.from, order.to);
      var labels = [];
      for (var i = lo; i <= hi; i++) labels.push(order.seq[i].label);

      var start = (order.from - lo) * REEL_ROW;
      var end = (order.to - lo) * REEL_ROW;
      var dist = hi - lo;
      var duration = Math.min(REEL_MAX, Math.max(REEL_BASE, REEL_BASE + dist * REEL_PER));

      reelEl.innerHTML = '';
      var reelRows = document.createDocumentFragment();
      labels.forEach(function (label) {
        var row = document.createElement('span');
        row.className = 'sel-reel-row';
        row.textContent = label;
        reelRows.appendChild(row);
      });
      reelEl.appendChild(reelRows);
      valueEl.style.width = clampWidth(widestLabelWidth(labels)) + 'px';
      reelEl.style.transition = 'none';
      reelEl.style.transform = 'translateY(-' + start + 'px)';
      void reelEl.offsetWidth;
      var reelEase = getComputedStyle(document.documentElement).getPropertyValue('--lg-ease-reel').trim();
      reelEl.style.transition = 'transform ' + duration + 'ms ' + (reelEase || 'cubic-bezier(.16,.84,.28,1)');
      valueEl.style.animationDuration = duration + 'ms';
      valueEl.classList.add('rolling');
      reelEl.style.transform = 'translateY(-' + end + 'px)';

      function settleSpin() {
        if (sequence !== spinSequence) return;
        valueEl.classList.remove('rolling');
        valueEl.style.animationDuration = '';
        paintRow(text);
      }
      // Follow this transition's compositor clock. A wall-clock timer can
      // expire before the first painted frame on a busy renderer. Instance
      // ownership also prevents an old cancellation from settling a new reel.
      var transition = reelEl.getAnimations && reelEl.getAnimations().find(function (animation) {
        return animation.transitionProperty === 'transform';
      });
      if (transition) transition.finished.then(settleSpin, settleSpin);
      else settleSpin();
    }

    function syncButton(animate) {
      button.disabled = select.disabled;
      setLabel(labelOf(), animate !== false);
    }

    function updateSearchControl() {
      if (searchable && !searchEl) {
        searchEl = document.createElement('input');
        searchEl.className = 'sel-search';
        searchEl.type = 'text';
        searchEl.placeholder = '搜索…';
        searchEl.setAttribute('aria-label', '搜索');
        pop.insertBefore(searchEl, listEl);
      } else if (!searchable && searchEl) {
        searchEl.remove();
        searchEl = null;
      }
    }

    function render(filter) {
      var query = (filter || '').trim().toLowerCase();
      var value = select.value;
      if (items === renderedItems && query === renderedQuery && value === renderedValue) return false;
      var fragment = document.createDocumentFragment();
      var nextVisibleItems = [];
      var nextSelectedIndex = -1;

      var lastGroup = null;
      var matched = 0;

      items.forEach(function (item) {
        if (query && item.searchLabel.indexOf(query) === -1) return;
        if (item.group && item.group !== lastGroup) {
          lastGroup = item.group;
          var head = document.createElement('div');
          head.className = 'sel-group';
          head.textContent = item.group;
          fragment.appendChild(head);
        }
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'sel-item';
        row.textContent = item.label;
        row.dataset.value = item.value;
        row.disabled = !!item.disabled;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', item.value === value ? 'true' : 'false');
        if (item.value === value) {
          row.classList.add('on');
          if (!item.disabled) nextSelectedIndex = nextVisibleItems.length;
        }
        fragment.appendChild(row);
        if (!item.disabled) nextVisibleItems.push(row);
        matched++;
      });

      if (!matched) {
        var empty = document.createElement('div');
        empty.className = 'sel-empty';
        empty.textContent = '没有匹配的项';
        fragment.appendChild(empty);
      }
      if (listEl.replaceChildren) listEl.replaceChildren(fragment);
      else {
        listEl.textContent = '';
        listEl.appendChild(fragment);
      }
      visibleItems = nextVisibleItems;
      activeIndex = selectedItemIndex = nextSelectedIndex;
      renderedItems = items;
      renderedQuery = query;
      renderedValue = value;
      return true;
    }

    function refreshOptions() {
      var nextItems = collectOptions(select);
      if (!sameOptions(items, nextItems)) {
        items = nextItems;
        searchable = items.length > 12;
        updateSearchControl();
      }
      var changed = render(searchEl ? searchEl.value : '');
      syncButton(false);
      if (changed && openSelect && openSelect.select === select) {
        position();
        highlight(activeIndex < 0 ? 0 : activeIndex);
      }
    }

    function highlight(next) {
      if (!visibleItems.length) return;
      if (activeIndex >= 0 && visibleItems[activeIndex]) {
        visibleItems[activeIndex].classList.remove('active');
      }
      activeIndex = Math.max(0, Math.min(visibleItems.length - 1, next));
      var row = visibleItems[activeIndex];
      row.classList.add('active');
      if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
      if (!searchEl || document.activeElement !== searchEl) row.focus({ preventScroll: true });
    }

    function position() {
      var rect = button.getBoundingClientRect();
      pop.style.minWidth = Math.max(190, Math.round(rect.width)) + 'px';
      var height = pop.offsetHeight;
      var width = pop.offsetWidth;
      var top = rect.bottom + 6;
      var above = false;
      if (top + height > window.innerHeight - 8) {
        top = Math.max(8, rect.top - height - 6);
        above = true;
      }
      var left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      pop.style.top = top + 'px';
      pop.style.left = left + 'px';
      pop.setAttribute('data-placement', above ? 'above' : 'below');
    }

    function open() {
      if (select.disabled) return;
      if (openSelect && openSelect.select === select) { closeSelect(); return; }
      closeSelect();
      pop.inert = false;
      pop.setAttribute('aria-hidden', 'false');
      button.setAttribute('aria-expanded', 'true');
      openSelect = { select: select, pop: pop, button: button, position: position };
      if (searchEl) searchEl.value = '';
      render('');
      position();
      moveSurface(pop, button, true);
      // Opening a language list must not enter an editable field and summon
      // the mobile keyboard. Search remains available when explicitly tapped.
      highlight(selectedItemIndex < 0 ? 0 : selectedItemIndex);
      if (!visibleItems.length) {
        listEl.tabIndex = -1;
        listEl.focus({ preventScroll: true });
      }
    }

    function choose(value) {
      var option = items.find(function (item) { return item.value === value; });
      if (select.disabled || !option || option.disabled) return;
      if (select.value !== value) {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      syncButton(false);
      closeSelect();
      button.focus();
    }

    button.addEventListener('click', function (e) {
      e.stopPropagation();
      open();
    });

    button.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });

    listEl.addEventListener('click', function (event) {
      var row = event.target && event.target.closest ? event.target.closest('.sel-item') : null;
      if (row && !row.disabled && listEl.contains(row)) choose(row.dataset.value);
    });

    pop.addEventListener('input', function (e) {
      if (e.target === searchEl) render(searchEl.value);
    });

    pop.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSelect(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(activeIndex + 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); highlight(activeIndex - 1); return; }
      if (e.key === 'Home' && e.target !== searchEl) { e.preventDefault(); highlight(0); return; }
      if (e.key === 'End' && e.target !== searchEl) { e.preventDefault(); highlight(visibleItems.length - 1); return; }
      if (e.key === 'Enter' || (e.key === ' ' && e.target !== searchEl)) {
        e.preventDefault();
        var row = visibleItems[activeIndex];
        if (row) choose(row.dataset.value);
      }
    });

    pop.addEventListener('click', function (e) { e.stopPropagation(); });

    syncButton(false);
    /* 外部（如语言互换、恢复上次选择）改了值，按钮要跟着转 */
    select.addEventListener('change', function () { syncButton(true); });
    select.__itRefreshDropdown = refreshOptions;
    enhancedSelects.push(syncButton);
  }

  function enhanceAllSelects() {
    document.querySelectorAll('select').forEach(enhanceSelect);
  }

  /* 程序化改值后统一刷新按钮；animate=false 用于初始化/恢复，避免开场就转 */
  function refreshSelectButtons(animate) {
    enhancedSelects.forEach(function (sync) { sync(animate === true); });
  }

  /* ---------------- 4. 状态 ---------------- */
  var state = {
    tab: 'text',
    src: 'auto',
    tgt: 'zh',
    model: {
      text: 'index-mt-2b',
      syllable: 'index-mt-2b-syllable',
      doc: 'index-nailong-2b'
    },
    image: null
  };

  /* ---------------- 4a. Saved preferences ---------------- */
  var PREFERENCES_KEY = 'it-preferences';
  var MODEL_OPTIONS = {
    text: ['index-mt-2b', 'index-mt-9b', 'index-mt-35b'],
    syllable: ['index-mt-2b-syllable', 'index-mt-9b-syllable'],
    doc: ['index-nailong-2b', 'index-nailong-9b']
  };
  var DEFAULT_PREFERENCES = {
    version: 3,
    appearance: {
      mode: 'light', palette: 'sakura', radius: 'round', font: 'sans', systemFontFamily: '',
      fontScale: 100, fontWeight: 400, fontColorMode: 'theme', fontColor: '#2E2A38', layout: 'standard',
      motion: 'system', ambientLight: true
    },
    liquidGlass: window.ItLiquidGlass.defaults,
    background: { data: '', opacity: 34, blur: 0, fit: 'cover' },
    popup: { backgroundData: '' },
    updates: { autoCheck: true },
    translation: {
      defaultTab: 'text', sourceLanguage: 'auto', targetLanguage: 'zh',
      defaultModels: {
        text: 'index-mt-2b', syllable: 'index-mt-2b-syllable', doc: 'index-nailong-2b'
      },
      rememberLanguages: true, rememberModels: true
    }
  };

  function copyObject(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function enumValue(value, allowed, fallback) {
    return allowed.indexOf(value) >= 0 ? value : fallback;
  }

  function boundedNumber(value, min, max, fallback) {
    var number = Number(value);
    return isFinite(number) ? Math.round(Math.max(min, Math.min(max, number))) : fallback;
  }

  function normalizePreferences(input) {
    var source = input && typeof input === 'object' ? input : {};
    var appearance = source.appearance || {};
    var background = source.background || {};
    var popup = source.popup || {};
    var translation = source.translation || {};
    var updates = source.updates || {};
    var savedModels = translation.defaultModels || {};
    var result = copyObject(DEFAULT_PREFERENCES);

    result.appearance.mode = enumValue(appearance.mode, ['light', 'dark', 'system'], 'light');
    result.appearance.palette = enumValue(appearance.palette,
      ['sakura', 'mist', 'sage', 'amber'], 'sakura');
    result.appearance.radius = enumValue(appearance.radius,
      ['round', 'standard', 'small'], 'round');
    result.appearance.font = enumValue(appearance.font,
      ['sans', 'serif', 'mono'], 'sans');
    var systemFontFamily = typeof appearance.systemFontFamily === 'string' ?
      appearance.systemFontFamily.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128) : '';
    result.appearance.systemFontFamily = systemFontFamily;
    result.appearance.fontScale = boundedNumber(appearance.fontScale, 90, 140, 100);
    result.appearance.fontWeight = boundedNumber(appearance.fontWeight, 300, 700, 400);
    result.appearance.fontWeight = Math.max(300, Math.min(700,
      Math.round(result.appearance.fontWeight / 100) * 100));
    result.appearance.fontColorMode = enumValue(appearance.fontColorMode, ['theme', 'custom'], 'theme');
    result.appearance.fontColor = typeof appearance.fontColor === 'string' &&
      /^#[0-9a-f]{6}$/i.test(appearance.fontColor) ? appearance.fontColor.toUpperCase() : '#2E2A38';
    result.appearance.layout = enumValue(appearance.layout,
      ['standard', 'compact'], 'standard');
    result.appearance.motion = enumValue(appearance.motion,
      ['system', 'reduced', 'off'], 'system');
    result.appearance.ambientLight = appearance.ambientLight !== false;

    result.liquidGlass = window.ItLiquidGlass.normalize(source.liquidGlass);

    var image = normalizeImageData(background.data);
    result.background.data = image;
    result.background.opacity = boundedNumber(background.opacity, 0, 80, 34);
    result.background.blur = boundedNumber(background.blur, 0, 20, 0);
    result.background.fit = enumValue(background.fit, ['cover', 'contain'], 'cover');
    result.popup.backgroundData = normalizeImageData(popup.backgroundData);
    result.updates.autoCheck = updates.autoCheck !== false;

    result.translation.defaultTab = enumValue(translation.defaultTab,
      ['text', 'syllable', 'doc', 'last'], 'text');
    result.translation.sourceLanguage = enumValue(translation.sourceLanguage,
      Object.keys(LANGS).concat(['auto']), 'auto');
    result.translation.targetLanguage = enumValue(translation.targetLanguage,
      Object.keys(LANGS), 'zh');
    Object.keys(MODEL_OPTIONS).forEach(function (group) {
      result.translation.defaultModels[group] = enumValue(savedModels[group], MODEL_OPTIONS[group],
        DEFAULT_PREFERENCES.translation.defaultModels[group]);
    });
    result.translation.rememberLanguages = translation.rememberLanguages !== false;
    result.translation.rememberModels = translation.rememberModels !== false;
    return result;
  }

  function normalizeImageData(value) {
    return typeof value === 'string' &&
      /^data:image\/(png|jpeg|webp|gif);base64,/i.test(value) && value.length <= 6000000 ? value : '';
  }

  function readSavedPreferences() {
    var parsed = null;
    try { parsed = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || 'null'); }
    catch (e) {}
    if (!parsed) {
      try {
        var oldBackground = localStorage.getItem('it-bg-data');
        if (oldBackground) parsed = { background: { data: oldBackground } };
      } catch (e) {}
    }
    var normalized = normalizePreferences(parsed);
    var oldAppearance = parsed && parsed.appearance;
    var legacyGlass = !!(oldAppearance && (
      Object.prototype.hasOwnProperty.call(oldAppearance, 'material') ||
      Object.prototype.hasOwnProperty.call(oldAppearance, 'glassStrength') ||
      Object.prototype.hasOwnProperty.call(oldAppearance, 'cardReveal')) ||
      parsed && parsed.popup && Object.prototype.hasOwnProperty.call(parsed.popup, 'cardReveal'));
    if (legacyGlass || (parsed && parsed.version !== DEFAULT_PREFERENCES.version)) {
      try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(normalized)); }
      catch (e) {}
    }
    return normalized;
  }

  var activePreferences = readSavedPreferences();
  var currentSystemAppearance = 'light';
  var PALETTE_COLORS = {
    sakura: { light: { accent: '#E28BA6', deep: '#C96F90', lilac: '#9A9BE6' },
      dark: { accent: '#F0A8BE', deep: '#E28BA6', lilac: '#B9BAF0' } },
    mist: { light: { accent: '#54AEB2', deep: '#388D94', lilac: '#8EAFC7' },
      dark: { accent: '#7DD0D0', deep: '#54AEB2', lilac: '#ABC9E1' } },
    sage: { light: { accent: '#83A58B', deep: '#66876F', lilac: '#9FAE91' },
      dark: { accent: '#A4C9A5', deep: '#83A58B', lilac: '#C2C69D' } },
    amber: { light: { accent: '#E3A253', deep: '#C88733', lilac: '#C68E80' },
      dark: { accent: '#F2BC72', deep: '#E3A253', lilac: '#E3B0A2' } }
  };

  function colorRgba(hex, alpha) {
    var value = hex.replace('#', '');
    var number = parseInt(value, 16);
    return 'rgba(' + ((number >> 16) & 255) + ',' + ((number >> 8) & 255) + ',' +
      (number & 255) + ',' + alpha + ')';
  }

  function colorArgb(hex, alpha) {
    var opacity = Math.round(alpha * 255).toString(16);
    if (opacity.length < 2) opacity = '0' + opacity;
    return ('#' + opacity + hex.replace('#', '')).toUpperCase();
  }

  function opaqueRgb(red, green, blue) {
    function byte(value) {
      var result = value.toString(16);
      return result.length < 2 ? '0' + result : result;
    }
    return ('#FF' + byte(red) + byte(green) + byte(blue)).toUpperCase();
  }

  function resolvedAppearance(preferences) {
    var appearance = preferences.appearance;
    if (appearance.mode === 'system') return currentSystemAppearance === 'dark' ? 'dark' : 'light';
    return appearance.mode;
  }

  function nativeAppearance(preferences, systemMode) {
    var mode = systemMode || preferences.appearance.mode;
    var dark = mode === 'dark' || (mode === 'system' &&
      currentSystemAppearance === 'dark');
    var colors = PALETTE_COLORS[preferences.appearance.palette] || PALETTE_COLORS.sakura;
    var accent = colors[dark ? 'dark' : 'light'];
    var background = dark ?
      [opaqueRgb(45, 41, 52), opaqueRgb(33, 31, 40), opaqueRgb(26, 25, 32)] :
      [opaqueRgb(252, 248, 251), opaqueRgb(243, 239, 246), opaqueRgb(235, 229, 244)];
    var surface = colorArgb(dark ? '#302C38' : '#FFFFFF', preferences.liquidGlass.card.backgroundOpacity / 100);
    return {
      dark: dark,
      background: background,
      ink: dark ? '#FFF2EDF3' : '#FF2E2A38',
      mutedInk: dark ? '#FFBFB8C5' : '#FF6E687E',
      accent: colorArgb(accent.deep, 1),
      surface: surface,
      edge: dark ? '#7FFFFFFF' : '#9EFFFFFF',
      controlFill: dark ? '#33FFFFFF' : '#24FFFFFF',
      ripple: colorArgb(accent.deep, .20)
    };
  }

  function nativeAppearanceSnapshot(preferences) {
    return JSON.stringify({
      mode: preferences.appearance.mode,
      light: nativeAppearance(preferences, 'light'),
      dark: nativeAppearance(preferences, 'dark')
    });
  }

  var lastAndroidAppearance = '';
  var lastAndroidAppearanceBridge = null;
  var appliedPreferenceBackground = null;

  function syncAndroidAppearance(preferences) {
    if (!Bridge.isAndroid || !window.NativeBridge ||
        typeof window.NativeBridge.applyAppearance !== 'function') return;
    var projection = JSON.stringify(nativeAppearance(preferences));
    if (projection === lastAndroidAppearance &&
        window.NativeBridge === lastAndroidAppearanceBridge) return;
    try {
      window.NativeBridge.applyAppearance(projection);
      lastAndroidAppearance = projection;
      lastAndroidAppearanceBridge = window.NativeBridge;
    } catch (e) {}
  }

  function setPreferenceStyle(element, name, value) {
    if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
  }

  function setPreferenceData(element, name, value) {
    if (element.dataset[name] !== value) element.dataset[name] = value;
  }

  function applyPreferences(preferences) {
    activePreferences = normalizePreferences(preferences);
    var root = document.documentElement;
    var appearance = activePreferences.appearance;
    var dark = resolvedAppearance(activePreferences) === 'dark';
    var geometryChanged = root.dataset.itRadius !== appearance.radius ||
      root.dataset.itLayout !== appearance.layout;
    var motionChanged = root.dataset.itMotion !== appearance.motion;
    var backgroundChanged = !appliedPreferenceBackground ||
      appliedPreferenceBackground.dark !== dark ||
      Object.keys(activePreferences.background).some(function (key) {
        return activePreferences.background[key] !== appliedPreferenceBackground[key];
      });
    var colors = PALETTE_COLORS[appearance.palette] || PALETTE_COLORS.sakura;
    var palette = colors[dark ? 'dark' : 'light'];
    var background = dark ? '#211F28' : '#F3EFF6';
    var backgroundWarm = dark ? '#2D2934' : '#FCF8FB';
    var ink = dark ? '#F2EDF3' : '#2E2A38';
    var inkSub = dark ? '#BFB8C5' : '#6E687E';
    var inkFaint = dark ? '#908997' : '#A29CAC';
    var liquidGlass = activePreferences.liquidGlass;
    var radius = appearance.radius === 'small' ? [12, 9, 7] :
      appearance.radius === 'standard' ? [19, 15, 11] : [26, 20, 14];

    setPreferenceData(root, 'itTheme', dark ? 'dark' : 'light');
    var colorScheme = document.querySelector('meta[name="color-scheme"]');
    var scheme = dark ? 'dark light' : 'light dark';
    if (colorScheme && colorScheme.getAttribute('content') !== scheme) colorScheme.setAttribute('content', scheme);
    setPreferenceData(root, 'itThemeMode', appearance.mode);
    setPreferenceData(root, 'itPalette', appearance.palette);
    setPreferenceData(root, 'itRadius', appearance.radius);
    setPreferenceData(root, 'itLayout', appearance.layout);
    setPreferenceData(root, 'itMotion', appearance.motion);
    setPreferenceData(root, 'itAmbient', appearance.ambientLight ? 'true' : 'false');
    setPreferenceStyle(root, '--lg-bg', background);
    setPreferenceStyle(root, '--lg-bg-warm', backgroundWarm);
    setPreferenceStyle(root, '--lg-bg-end', dark ? '#18161D' : '#EBE5F4');
    setPreferenceStyle(root, '--lg-overlay', dark ? 'rgba(4,3,7,.54)' : 'rgba(46,42,56,.18)');
    setPreferenceStyle(root, '--lg-ink', ink);
    setPreferenceStyle(root, '--lg-ink-sub', inkSub);
    setPreferenceStyle(root, '--lg-ink-faint', inkFaint);
    setPreferenceStyle(root, '--lg-accent', palette.accent);
    setPreferenceStyle(root, '--lg-accent-deep', palette.deep);
    setPreferenceStyle(root, '--lg-lilac', palette.lilac);
    setPreferenceStyle(root, '--lg-glow-a', colorRgba(palette.accent, appearance.ambientLight ? (dark ? .2 : .28) : 0));
    setPreferenceStyle(root, '--lg-glow-b', colorRgba(palette.lilac, appearance.ambientLight ? (dark ? .14 : .2) : 0));
    setPreferenceStyle(root, '--lg-glow-c', dark ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.48)');
    setPreferenceStyle(root, '--lg-accent-wash', colorRgba(palette.deep, dark ? .22 : .14));
    setPreferenceStyle(root, '--lg-accent-wash-2', colorRgba(palette.deep, dark ? .32 : .24));
    setPreferenceStyle(root, '--lg-edge', dark ? 'rgba(255,255,255,.13)' : 'rgba(70,52,96,.12)');
    setPreferenceStyle(root, '--lg-edge-dark', dark ? 'rgba(255,255,255,.12)' : 'rgba(70,52,96,.09)');
    setPreferenceStyle(root, '--lg-shadow', dark ?
      '0 12px 34px rgba(0,0,0,.32),0 3px 10px rgba(0,0,0,.18)' :
      '0 12px 34px rgba(70,52,96,.13),0 3px 10px rgba(70,52,96,.06)');
    setPreferenceStyle(root, '--lg-shadow-strong', dark ?
      '0 24px 60px rgba(0,0,0,.42),0 5px 14px rgba(0,0,0,.2)' :
      '0 24px 60px rgba(70,52,96,.20),0 5px 14px rgba(70,52,96,.08)');
    setPreferenceStyle(root, '--lg-shadow-soft', dark ?
      '0 5px 16px rgba(0,0,0,.24)' : '0 5px 16px rgba(70,52,96,.09)');
    var liquidOpacity = liquidGlass.card.backgroundOpacity / 100;
    var liquidTint = dark ? '#302C38' : '#FFFFFF';
    setPreferenceStyle(root, '--it-liquid-tint-rgb', dark ? '48 44 56' : '255 255 255');
    setPreferenceStyle(root, '--it-liquid-fill', colorRgba(liquidTint, liquidOpacity));
    setPreferenceStyle(root, '--it-liquid-fill-low', colorRgba(liquidTint, liquidOpacity * .35));
    setPreferenceStyle(root, '--it-liquid-fill-mid', colorRgba(liquidTint, liquidOpacity * .65));
    setPreferenceStyle(root, '--it-liquid-fill-high', colorRgba(liquidTint, Math.min(1, liquidOpacity * 1.15)));
    setPreferenceStyle(root, '--lg-r-lg', radius[0] + 'px');
    setPreferenceStyle(root, '--lg-r-md', radius[1] + 'px');
    setPreferenceStyle(root, '--lg-r-sm', radius[2] + 'px');
    var genericFont = appearance.font === 'serif' ?
      '"Noto Serif", "Songti SC", serif' : appearance.font === 'mono' ?
        '"Cascadia Code", "Consolas", monospace' :
        '"PingFang SC", "Microsoft YaHei UI", "Noto Sans SC", system-ui, sans-serif';
    var selectedFont = Bridge.isDesktop && appearance.systemFontFamily ?
      '"' + appearance.systemFontFamily.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '", ' + genericFont :
      genericFont;
    setPreferenceStyle(root, '--it-content-font', selectedFont);
    setPreferenceStyle(root, '--it-content-scale', String(appearance.fontScale / 100));
    setPreferenceStyle(root, '--it-content-weight', String(appearance.fontWeight));
    setPreferenceStyle(root, '--it-content-color', appearance.fontColorMode === 'custom' ?
      appearance.fontColor : ink);
    setPreferenceStyle(root, '--lg-distance-scene', appearance.motion === 'reduced' ? '0px' : '28px');
    if (appearance.motion === 'reduced') {
      setPreferenceStyle(root, '--lg-duration-panel', '180ms');
      setPreferenceStyle(root, '--lg-duration-dialog', '140ms');
    } else {
      setPreferenceStyle(root, '--lg-duration-panel', '420ms');
      setPreferenceStyle(root, '--lg-duration-dialog', '240ms');
    }
    if (motionChanged) syncMotionConstants();
    if (backgroundChanged) {
      applyBackground(activePreferences.background.data, activePreferences.background);
      appliedPreferenceBackground = Object.assign({ dark: dark }, activePreferences.background);
    }
    window.ItLiquidGlass.configure(liquidGlass);
    if (geometryChanged) window.ItLiquidGlass.refresh(document);
    syncAndroidAppearance(activePreferences);
  }

  function syncMotionConstants() {
    PANEL_DURATION = cssDuration('--lg-duration-panel', 420);
    DIALOG_DURATION = cssDuration('--lg-duration-dialog', 240);
    SCENE_DISTANCE = cssNumber('--lg-distance-scene', 28);
  }

  window.__itGetAppearance = function () {
    return JSON.stringify(nativeAppearance(activePreferences));
  };
  window.__itOnSystemAppearance = function (mode) {
    if (mode !== 'light' && mode !== 'dark') return;
    currentSystemAppearance = mode;
    if (activePreferences.appearance.mode === 'system') applyPreferences(activePreferences);
  };

  /* ---------------- 5. API 客户端 ---------------- */
  function describeError(status, body) {
    var message = '';
    try {
      var j = JSON.parse(body);
      message = (j.error && (j.error.message || j.error)) || j.detail || j.message || '';
    } catch (e) {
      message = String(body || '').slice(0, 160);
    }
    if (typeof message !== 'string') message = JSON.stringify(message);
    return message ? message : ('HTTP ' + status);
  }

  /**
   * 流式调用 /v1/chat/completions。
   * @returns {Promise<{text:string, usage:object|null}>}
   */
  function chatStream(payload, onDelta, signal) {
    return window.ItTranslationStream.request(CHAT_URL, payload, {
      onDelta: onDelta, signal: signal, describeError: describeError
    });
  }

  /* ---------------- 6. Prompt 构建（对齐官网） ---------------- */
  function header(srcLang, tgtLang) {
    var tgt = langName(tgtLang) || '中文';
    var src = (srcLang && srcLang !== 'auto') ? langName(srcLang) : '';
    return src ? ('请将以下' + src + '文本翻译为' + tgt + '。')
               : ('请将以下文本翻译为' + tgt + '。');
  }

  /** 逐字移植官网 buildInstructionPrompt() */
  function buildInstructionPrompt(text, instruct, srcLang, tgtLang) {
    var trimmedText = (text || '').trim();
    var trimmedIns = (instruct || '').trim();
    if (!trimmedText) return trimmedIns;

    if (trimmedIns.indexOf('【源文】') !== -1 || trimmedIns.indexOf('【待翻译文本】') !== -1) {
      return trimmedIns + '\n\n' + trimmedText;
    }

    var tgt = langName(tgtLang) || '中文';
    var head = header(srcLang, tgtLang);
    var rawLines = trimmedIns.split('\n').map(function (l) { return l.trim(); })
      .filter(function (l) { return !!l; });
    var constraints = [];

    rawLines.forEach(function (raw) {
      if (raw.charAt(0) === '【') { constraints.push(raw); return; }

      var clean = raw.replace(/^(?:注意[：:]\s*)?(?:\d+[.、\-]\s*)?/, '').trim();
      if (!clean) clean = raw;

      var delim = clean.indexOf('->') !== -1 ? '->'
        : clean.indexOf('→') !== -1 ? '→'
        : clean.indexOf(':') !== -1 ? ':'
        : clean.indexOf('：') !== -1 ? '：' : null;

      if (delim && clean.indexOf('翻译为') === -1 && clean.indexOf('注意') === -1 && clean.indexOf('请将') === -1) {
        var pieces = clean.split(delim);
        if (pieces.length === 2 && pieces[0].trim() && pieces[1].trim()) {
          constraints.push('【术语干预】必须按照术语表翻译：' + pieces[0].trim() + '→' + pieces[1].trim());
          return;
        }
      }

      clean = clean.replace(/目标语言/g, tgt);
      constraints.push('【指令要求】' + clean);
    });

    var reqLines = constraints.length
      ? constraints.map(function (c, i) { return (i + 1) + '. ' + c; }).join('\n')
      : ('1. 【指令要求】' + trimmedIns.replace(/目标语言/g, tgt));

    var isJson = trimmedIns.toLowerCase().indexOf('json') !== -1;
    var footer = isJson
      ? '请以合法的 JSON 格式输出翻译结果。只输出 JSON，不要有任何额外说明。'
      : '只输出译文，不要有任何额外说明。';

    return head + '\n\n【源文】\n' + trimmedText + '\n\n【约束要求】\n' + reqLines + '\n\n' + footer;
  }

  /** 逐字移植官网 buildImagePrompt() */
  function buildImagePrompt(userText, instruct, srcLang, tgtLang) {
    var tgt = langName(tgtLang) || '中文';
    var src = (srcLang && srcLang !== 'auto') ? langName(srcLang) : '';
    var prompt = src
      ? ('请将图片中的' + src + '文本翻译为' + tgt + '，直接输出翻译结果，不要进行任何解释。')
      : ('请将图片中的文本翻译为' + tgt + '，直接输出翻译结果，不要进行任何解释。');

    var extras = [];
    if (userText) extras.push('【参考文本/关注内容】\n' + userText);
    if (instruct) extras.push('【要求与约束】\n' + instruct.replace(/目标语言/g, tgt));
    if (extras.length) {
      prompt += '\n\n' + extras.join('\n\n') + '\n\n只输出翻译结果，不要进行任何解释。';
    }
    return prompt;
  }

  /** 普通翻译：官网此路径走私有端点，这里用等价单行指令 */
  function plainPrompt(text, srcLang, tgtLang) {
    return header(srcLang, tgtLang) + '直接输出翻译结果，不要进行任何解释。\n\n' + text;
  }

  /** 移植官网 syllable.html 模板 */
  function buildSyllablePrompt(text, syllables, tgtLang) {
    var tgt = langName(tgtLang) || '中文';
    return '请将以下文本翻译为' + tgt + '，译文严格控制在 ' + syllables +
      ' 个音节。直接输出翻译结果，不要进行任何解释。\n\n' + text;
  }

  function maxTokensFor(text) {
    return Math.max(1024, Math.min(16000, (text || '').length * 3));
  }

  function basePayload(model, prompt, maxTokens) {
    return {
      model: model,
      stream: true,
      temperature: 0,
      max_tokens: maxTokens || 2048,
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: 'user', content: prompt }]
    };
  }

  /* ---------------- 7. 一镜到底的模式切换 ----------------
     顶栏、语言条和吸底操作固定。新页的玻璃卡壳从旧页的实际矩形接续，
     卡内内容按导航顺序交接；快速反向切换从当前帧继续，不先回到起点。 */
  var panes = { text: 'pane-text', syllable: 'pane-syllable', doc: 'pane-doc' };
  var shownTab = 'text';
  var tabSeq = 0;
  var tabPreparation = null;
  var glassWarmupFrame = 0;
  var prewarmSettingsGlass = null;
  var dockPreparations = new WeakMap();

  function scheduleGlassWarmup() {
    if (glassWarmupFrame) return;
    glassWarmupFrame = requestAnimationFrame(function () {
      glassWarmupFrame = 0;
      Object.keys(panes).forEach(function (key) {
        var pane = $(panes[key]);
        if (pane && !pane.classList.contains('on')) {
          var pending = preparePageGlass(pane);
          if (pending) pending.catch(function () { /* A failed surface reports its own error. */ });
        }
        var dockPending = prepareTabDock(key);
        if (dockPending) dockPending.catch(function () { /* Surface errors are reported by the engine. */ });
      });
      if (prewarmSettingsGlass) prewarmSettingsGlass();
    });
  }

  function selectTabIntent(name) {
    state.tab = name;
    document.querySelectorAll('.tabs button[data-tab]').forEach(function (button) {
      var selected = button.getAttribute('data-tab') === name;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
    });
  }

  function preparePageGlass(scope, signal) {
    setupLiquidGlassSurfaces(scope);
    // Hidden panes still have their real layout. Position their restored model
    // thumb before requesting its map, rather than on its first visible frame.
    var groups = scope.querySelectorAll('.models');
    var instant = [];
    groups.forEach(function (box) {
      var panel = box.closest('.pane');
      if (!panel || panel.classList.contains('on')) return;
      var button = box.querySelector('button.on') || box.querySelector('button');
      applyThumbPosition(measureThumb(box, button, true), false, instant);
    });
    finishThumbPositions(instant);
    if (window.ItLiquidGlass.isReady(scope)) return null;
    return window.ItLiquidGlass.prepare(scope, { signal: signal });
  }

  function prepareTabDock(name, signal) {
    var dock = document.querySelector('.dock[data-pane="' + name + '"]');
    if (!dock) return null;
    var staging = !dock.classList.contains('on');
    if (staging) {
      dock.classList.add('it-glass-preparing');
      dock.inert = true;
    }
    var owners = dockPreparations.get(dock) || new Set();
    var owner = {};
    owners.add(owner);
    dockPreparations.set(dock, owners);
    var pending = preparePageGlass(dock, signal);
    function cleanup() {
      owners.delete(owner);
      if (owners.size) return;
      dockPreparations.delete(dock);
      dock.classList.remove('it-glass-preparing');
      // Revealing a tab owns its active dock's focus state. A background
      // warmup must not re-enable it after a dialog has made the page inert.
      if (!dock.classList.contains('on')) dock.inert = true;
    }
    if (!pending) { cleanup(); return null; }
    return pending.then(function (result) {
      cleanup();
      return result;
    }, function (error) {
      cleanup();
      throw error;
    });
  }

  function tabSurfaces(panel) {
    return Array.prototype.slice.call(panel.querySelectorAll('.models, .panes > .card'));
  }

  function tabContents(panel) {
    return Array.prototype.slice.call(panel.querySelectorAll(
      '.models > *, .card-head, .card-body, .card-foot, .pane > .langbar > :not(.models)'));
  }

  function settleTabs() {
    stopMotionGroup('tab');
    Object.keys(panes).forEach(function (key) {
      var panel = $(panes[key]);
      if (!panel) return;
      panel.classList.remove('it-tab-leave');
      panel.classList.toggle('on', key === shownTab);
    });
  }

  function shiftX(distance) { return 'translateX(' + distance + 'px)'; }

  function mapRect(from, to) {
    return 'translate(' + (from.left - to.left) + 'px,' + (from.top - to.top) +
      'px) scale(' + (from.width / to.width) + ',' + (from.height / to.height) + ')';
  }

  function visibleDockButtons(dock) {
    var buttons = {};
    if (!dock) return buttons;
    dock.querySelectorAll('button:not([hidden])').forEach(function (button) {
      var match = /^btn-(clear|cancel|go)(?:-(?:text|syllable|doc))?$/.exec(button.id);
      if (match) buttons[match[1]] = button;
    });
    return buttons;
  }

  function dockGeometryChanged(previous, next) {
    var roles = Object.keys(next);
    return Object.keys(previous).length !== roles.length || roles.some(function (role) {
      var from = previous[role];
      var to = next[role];
      var track = motions.get(from);
      return !from || (track && track.group === 'dock') || from.className !== to.className ||
        from.disabled !== to.disabled || from.textContent !== to.textContent;
    });
  }

  function dockButtonRects(buttons) {
    var rects = {};
    Object.keys(buttons).forEach(function (role) {
      rects[role] = buttons[role].getBoundingClientRect();
    });
    return rects;
  }

  function animateDockHandoff(previous, buttons, next) {
    var paths = Object.keys(next).map(function (role) {
      var from = previous[role];
      var to = next[role];
      var dx = from && from.width ? (from.left + from.right - to.left - to.right) / 2 : 0;
      if (Math.abs(dx) < 0.5) dx = 0;
      return { button: buttons[role], dx: dx,
        left: to.left + Math.min(dx, 0), right: to.right + Math.max(dx, 0),
        top: to.top, bottom: to.bottom };
    });
    // Check every swept border box against every other button, including a stationary Cancel.
    if (paths.some(function (path, index) {
      return path.left < 0 || path.right > window.innerWidth || paths.some(function (other, i) {
        return i !== index && path.left < other.right && path.right > other.left &&
          path.top < other.bottom && path.bottom > other.top;
      });
    })) return;
    paths.forEach(function (path) {
      if (!path.dx) return;
      playMotion(path.button, [
        { translate: path.dx + 'px 0px' },
        { translate: '0px 0px' }
      ], PANEL_DURATION, null, 'dock', false);
    });
  }

  function stopTaskDockMotion(button) {
    var dock = button && button.closest('.dock.on');
    if (!dock) return;
    Array.prototype.forEach.call(dock.children, function (element) {
      var track = motions.get(element);
      if (track && track.group === 'dock') stopMotion(element);
    });
  }

  function switchTab(name) {
    if (!panes[name]) return;
    if (name === state.tab && !tabPreparation) return;
    if (tabPreparation) tabPreparation.abort();
    tabPreparation = null;
    selectTabIntent(name);
    if (name === shownTab) {
      Object.keys(panes).forEach(function (key) {
        var pane = $(panes[key]);
        pane.inert = key !== name;
        pane.setAttribute('aria-hidden', key === name ? 'false' : 'true');
      });
      document.querySelectorAll('.dock').forEach(function (dock) {
        dock.inert = dock.getAttribute('data-pane') !== name;
      });
      positionThumbs(true);
      return;
    }
    var controller = new AbortController();
    var pagePreparation = preparePageGlass($(panes[name]), controller.signal);
    var dockPreparation = prepareTabDock(name, controller.signal);
    var preparation = pagePreparation || dockPreparation ?
      Promise.all([pagePreparation, dockPreparation]) : null;
    if (!preparation) { showTab(name); return; }
    tabPreparation = controller;
    // Keep the old scene on screen while the target is being prepared. Its
    // text fields must stop taking focus as soon as the user selects a new tab.
    Object.keys(panes).forEach(function (key) {
      var pane = $(panes[key]);
      pane.inert = true;
      pane.setAttribute('aria-hidden', 'true');
    });
    document.querySelectorAll('.dock').forEach(function (dock) { dock.inert = true; });
    var selectedTab = document.querySelector('.tabs button[data-tab="' + name + '"]');
    var visiblePane = $(panes[shownTab]);
    if (visiblePane && visiblePane.contains(document.activeElement) && selectedTab) {
      selectedTab.focus({ preventScroll: true });
    }
    positionThumbs(true);
    preparation.then(function () {
      if (tabPreparation !== controller || controller.signal.aborted) return;
      tabPreparation = null;
      showTab(name);
    }).catch(function (error) {
      if (error.name === 'AbortError' || tabPreparation !== controller) return;
      tabPreparation = null;
      selectTabIntent(shownTab);
      Object.keys(panes).forEach(function (key) {
        var pane = $(panes[key]);
        pane.inert = key !== shownTab;
        pane.setAttribute('aria-hidden', key === shownTab ? 'false' : 'true');
      });
      document.querySelectorAll('.dock').forEach(function (dock) {
        dock.inert = dock.getAttribute('data-pane') !== shownTab;
      });
      positionThumbs(false);
      toast('玻璃效果准备失败，请重试', true);
    });
  }

  function showTab(name) {
    var oldEl = $(panes[shownTab]);
    var newEl = $(panes[name]);
    if (openSelect && oldEl && oldEl.contains(openSelect.button)) closeSelect();
    var focusWasInOld = !!(oldEl && oldEl.contains(document.activeElement));
    var seq = ++tabSeq;
    var names = Object.keys(panes);
    var direction = names.indexOf(name) > names.indexOf(shownTab) ? 1 : -1;
    var animate = !!(oldEl && newEl && !motionReduced() && newEl.animate);
    var docks = document.querySelectorAll('.dock');
    var oldDockButtons;
    var newDockButtons;
    var oldDockRects;
    if (animate && typeof CSS !== 'undefined' && CSS.supports && CSS.supports('translate', '0 0')) {
      docks.forEach(function (dock) {
        var pane = dock.getAttribute('data-pane');
        if (pane === shownTab) oldDockButtons = visibleDockButtons(dock);
        if (pane === name) newDockButtons = visibleDockButtons(dock);
      });
      if (oldDockButtons && newDockButtons && dockGeometryChanged(oldDockButtons, newDockButtons)) {
        oldDockRects = dockButtonRects(oldDockButtons);
      }
    }
    var samples = new Map();
    var scenes = new Map();
    var panels = names.map(function (key) { return $(panes[key]); });
    /* 包括正在退场的页面，反向点回时可以从它尚未消失的位置接续。 */
    if (animate) {
      panels.forEach(function (panel) {
        if (!panel || (!panel.classList.contains('on') && !panel.classList.contains('it-tab-leave'))) return;
        var surfaces = tabSurfaces(panel);
        var contents = tabContents(panel);
        scenes.set(panel, { surfaces: surfaces, contents: contents,
          rects: surfaces.map(function (el) { return el.getBoundingClientRect(); }) });
        contents.forEach(function (el) { samples.set(el, visualStyle(el)); });
      });
    }
    stopMotionGroup('tab');
    stopMotionGroup('dock');

    try {
      var remembered = JSON.parse(localStorage.getItem('it-state') || '{}');
      remembered.tab = name;
      localStorage.setItem('it-state', JSON.stringify(remembered));
    } catch (e) {}
    shownTab = name;
    docks.forEach(function (dock) {
      var selected = dock.getAttribute('data-pane') === name;
      dock.classList.toggle('on', selected);
      dock.inert = !selected;
      dock.classList.remove('it-glass-preparing');
    });
    panels.forEach(function (panel) {
      if (!panel) return;
      var selected = panel === newEl;
      panel.inert = !selected;
      panel.setAttribute('aria-hidden', selected ? 'false' : 'true');
      panel.classList.toggle('it-tab-leave', !selected && scenes.has(panel));
      panel.classList.toggle('on', selected);
    });

    if (!animate) {
      if (focusWasInOld) focusModeTab(name);
      positionThumbs(false);
      return;
    }

    var nextDockRects = oldDockRects && dockButtonRects(newDockButtons);
    var outgoing = scenes.get(oldEl);
    var incoming = scenes.get(newEl);
    var oldRects = outgoing ? outgoing.rects : [];
    var newSurfaces = incoming ? incoming.surfaces : tabSurfaces(newEl);
    var newContents = incoming ? incoming.contents : tabContents(newEl);
    var nextRects = newSurfaces.map(function (el) { return el.getBoundingClientRect(); });
    scenes.forEach(function (scene, panel) {
      if (panel === newEl) return;
      scene.natural = scene.surfaces.map(function (el) { return el.getBoundingClientRect(); });
    });

    if (oldDockRects) animateDockHandoff(oldDockRects, newDockButtons, nextDockRects);
    newSurfaces.forEach(function (el, index) {
      var from = oldRects[index];
      var to = nextRects[index];
      if (!from || !to || !to.width || !to.height) return;
      playMotion(el, [{ transform: mapRect(from, to) }, { transform: 'none' }],
        PANEL_DURATION, null, 'tab', true);
    });
    /* 三连切时保留每一层尚未淡完的内容，避免丢掉上一段的剩余透明度。 */
    scenes.forEach(function (scene, panel) {
      if (panel === newEl) return;
      scene.surfaces.forEach(function (el, index) {
        var natural = scene.natural[index];
        if (!nextRects[index] || !natural.width || !natural.height) return;
        playMotion(el, [{ transform: mapRect(scene.rects[index], natural) },
          { transform: mapRect(nextRects[index], natural) }], PANEL_DURATION, null, 'tab', true);
      });
      scene.contents.forEach(function (el) {
        var from = samples.get(el);
        var thumb = el.classList.contains('models-thumb');
        playMotion(el, [thumb ? { opacity: from.opacity } : from,
          thumb ? { opacity: '0' } : { opacity: '0', transform: shiftX(-direction * SCENE_DISTANCE) }],
        PANEL_DURATION, null, 'tab', true);
      });
    });
    newContents.forEach(function (el) {
      var from = samples.get(el) ||
        { opacity: '0', transform: shiftX(direction * SCENE_DISTANCE) };
      var thumb = el.classList.contains('models-thumb');
      playMotion(el, [thumb ? { opacity: from.opacity } : from,
        thumb ? { opacity: '1' } : { opacity: '1', transform: 'none' }],
      PANEL_DURATION, null, 'tab', true);
    });
    /* 完成时一次性释放退场内容，避免先释放 fill 帧造成末尾闪回。 */
    playMotion(newEl, [{ opacity: 1 }, { opacity: 1 }], PANEL_DURATION, function () {
      if (seq === tabSeq) settleTabs();
    }, 'tab');

    if (focusWasInOld) focusModeTab(name);
    positionThumbs(true);
  }

  function focusModeTab(name) {
    var button = document.querySelector('.tabs button[data-tab="' + name + '"]');
    if (button) button.focus({ preventScroll: true });
  }

  function initTabs() {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('.tabs button[data-tab]'));
    buttons.forEach(function (btn, index) {
      var tab = btn.getAttribute('data-tab');
      var selected = btn.classList.contains('on');
      btn.setAttribute('aria-controls', panes[tab]);
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
      btn.tabIndex = selected ? 0 : -1;
      var panel = $(panes[tab]);
      if (panel) {
        panel.inert = !selected;
        panel.setAttribute('aria-hidden', selected ? 'false' : 'true');
      }
      on(btn, 'click', function () { switchTab(btn.getAttribute('data-tab')); });
      on(btn, 'keydown', function (e) {
        var next = -1;
        if (e.key === 'ArrowRight') next = (index + 1) % buttons.length;
        else if (e.key === 'ArrowLeft') next = (index + buttons.length - 1) % buttons.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = buttons.length - 1;
        if (next < 0) return;
        e.preventDefault();
        buttons[next].focus();
        switchTab(buttons[next].getAttribute('data-tab'));
      });
    });
  }

  function initMobileKeyboardLayout() {
    var mobile = window.matchMedia('(max-width: 760px)');
    function update() {
      var active = document.activeElement;
      var editing = !!(active && (active.isContentEditable ||
        (active.matches && active.matches('textarea, input:not([type="button"]):not([type="checkbox"]):not([type="file"])'))));
      document.documentElement.classList.toggle('it-keyboard-open', mobile.matches && editing);
    }
    on(document, 'focusin', update);
    on(document, 'focusout', function () { setTimeout(update, 0); });
    on(window, 'resize', update);
    if (mobile.addEventListener) mobile.addEventListener('change', update);
    else if (mobile.addListener) mobile.addListener(update);
    update();
  }

  /* ---------------- 8. 玻璃滑块 ----------------
     模式标签和模型组选中态共用同一套玻璃滑块。 */
  var segmentDragGeometry = new WeakMap();

  function initSegmentDrag(box) {
    if (!window.PointerEvent || box.dataset.dragReady === '1') return;
    box.dataset.dragReady = '1';
    var buttonSelector = box.classList.contains('tabs') ? 'button[data-tab]' : 'button[data-model]';
    var buttons = Array.prototype.slice.call(box.querySelectorAll(buttonSelector));
    var thumb = box.querySelector('.models-thumb, .tabs-thumb');
    if (!thumb || buttons.length < 2) return;
    var drag = null;
    var ignoreClickUntil = 0;

    function finishDrag() {
      if (!drag) return;
      var ending = drag;
      drag = null;
      segmentDragGeometry.delete(box);
      box.classList.remove('is-dragging');
      if (ending.dragging) {
        ignoreClickUntil = performance.now() + 500;
        thumb.style.transition = '';
        moveThumb(box, box.querySelector(buttonSelector + '.on'), true);
      }
      try {
        if (box.hasPointerCapture(ending.pointerId)) box.releasePointerCapture(ending.pointerId);
      } catch (e) {}
    }

    on(box, 'pointerdown', function (e) {
      var button = e.target.closest && e.target.closest(buttonSelector);
      if (drag || !button || button.disabled || e.button !== 0 || e.isPrimary === false) return;
      var index = buttons.indexOf(button);
      if (index < 0 || button.closest('[inert]')) return;
      var rect = box.getBoundingClientRect();
      var boxWidth = box.offsetWidth;
      var geometry = buttons.map(function (candidate) {
        var left = candidate.offsetLeft;
        var width = candidate.offsetWidth;
        return { left: left, width: width, center: left + width / 2 };
      });
      ignoreClickUntil = 0;
      drag = {
        pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
        scale: rect.width ? boxWidth / rect.width : 1,
        geometry: geometry,
        startCenter: geometry[index].center,
        index: buttons.indexOf(box.querySelector(buttonSelector + '.on')),
        dragging: false
      };
      segmentDragGeometry.set(box, drag);
    });

    on(document, 'pointermove', function (e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (e.pointerType === 'mouse' && !(e.buttons & 1)) { finishDrag(); return; }
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      if (!drag.dragging) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx) * 1.2) { finishDrag(); return; }
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
        drag.dragging = true;
        box.classList.add('is-dragging');
        thumb.style.transition = 'none';
        try { box.setPointerCapture(e.pointerId); } catch (error) {}
      }
      e.preventDefault();
      var center = drag.startCenter + dx * drag.scale;
      var index = Math.max(0, drag.index);
      var geometry = drag.geometry;
      function centerAt(i) { return geometry[i].center; }
      while (index < buttons.length - 1 && center > (centerAt(index) + centerAt(index + 1)) / 2 + 4) index++;
      while (index > 0 && center < (centerAt(index - 1) + centerAt(index)) / 2 - 4) index--;
      if (index !== drag.index) {
        drag.index = index;
        buttons[index].focus({ preventScroll: true });
        buttons[index].click();
      }
      var width = geometry[index].width + 'px';
      if (thumb.style.width !== width) thumb.style.width = width;
      var left = Math.max(geometry[0].left,
        Math.min(geometry[geometry.length - 1].left, center - geometry[index].width / 2));
      var transform = 'translateX(' + left + 'px)';
      if (thumb.style.transform !== transform) thumb.style.transform = transform;
    }, { passive: false });

    on(document, 'pointerup', function (e) {
      if (drag && e.pointerId === drag.pointerId) finishDrag();
    });
    on(document, 'pointercancel', function (e) {
      if (drag && e.pointerId === drag.pointerId) finishDrag();
    });
    on(box, 'lostpointercapture', function (e) {
      if (e.target === box && drag && e.pointerId === drag.pointerId) finishDrag();
    });
    on(window, 'blur', finishDrag);
    on(window, 'resize', finishDrag);
    on(box, 'keydown', function (e) {
      if (drag && e.key === 'Escape') { finishDrag(); e.preventDefault(); }
    });
    /* 拖动已实时提交选择，吞掉同一手势随后合成的点击；新的按下和键盘点击仍正常处理。 */
    on(box, 'click', function (e) {
      if (e.detail > 0 && performance.now() < ignoreClickUntil) {
        ignoreClickUntil = 0;
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  }

  function setupThumbs() {
    document.querySelectorAll('.models, .tabs').forEach(function (box) {
      var selector = box.classList.contains('tabs') ? '.tabs-thumb' : '.models-thumb';
      if (!box.querySelector(selector)) {
        var thumb = document.createElement('span');
        thumb.className = selector.slice(1);
        thumb.setAttribute('aria-hidden', 'true');
        box.insertBefore(thumb, box.firstChild);
      }
      initSegmentDrag(box);
    });
    positionThumbs();
  }

  function measureThumb(box, btn, includeHidden) {
    var drag = segmentDragGeometry.get(box);
    // The live gesture owns its thumb. Selection handlers may run synchronously
    // at a threshold, but must not snap it or remeasure after changing classes.
    if (drag && drag.dragging) return null;
    var panel = box.closest('.pane');
    if (panel && !panel.classList.contains('on') && !includeHidden) return null;
    var thumb = box.querySelector('.models-thumb, .tabs-thumb');
    if (!thumb || !btn) return null;
    var width = btn.offsetWidth;
    if (!width) return null;
    return { thumb: thumb, width: width + 'px', transform: 'translateX(' + btn.offsetLeft + 'px)' };
  }

  function applyThumbPosition(measurement, animate, instant) {
    if (!measurement) return;
    var thumb = measurement.thumb;
    // Hidden groups are measured when first shown. Their initial position
    // must already match the restored model before regular sliding begins.
    if (!thumb.classList.contains('ready')) animate = false;
    var changed = thumb.style.width !== measurement.width ||
      thumb.style.transform !== measurement.transform || !thumb.classList.contains('ready');
    if (!changed) {
      // A resize/reduced-motion boundary can arrive during a CSS transition
      // whose inline target is already correct. Finish it without another flush.
      if (!animate && thumb.getAnimations) thumb.getAnimations().forEach(function (animation) {
        if (animation.transitionProperty === 'transform' || animation.transitionProperty === 'width') {
          animation.finish();
        }
      });
      return;
    }
    if (!animate) thumb.style.transition = 'none';
    if (thumb.style.width !== measurement.width) thumb.style.width = measurement.width;
    if (thumb.style.transform !== measurement.transform) thumb.style.transform = measurement.transform;
    if (!thumb.classList.contains('ready')) thumb.classList.add('ready');
    if (!animate) instant.push(thumb);
  }

  function finishThumbPositions(instant) {
    if (!instant.length) return;
    // All groups have been measured and written; one flush settles every
    // immediate position before restoring their regular transitions.
    void instant[0].offsetWidth;
    instant.forEach(function (thumb) { thumb.style.transition = ''; });
  }

  function moveThumb(box, btn, animate) {
    var instant = [];
    applyThumbPosition(measureThumb(box, btn), animate, instant);
    finishThumbPositions(instant);
  }

  function positionThumbs(animate) {
    var measurements = Array.prototype.map.call(document.querySelectorAll('.models, .tabs'), function (box) {
      var btn = box.querySelector('button.on') || box.querySelector('button');
      return measureThumb(box, btn);
    });
    var instant = [];
    measurements.forEach(function (measurement) {
      applyThumbPosition(measurement, animate === true, instant);
    });
    finishThumbPositions(instant);
  }

  function initModelGroups() {
    [['model-text', 'text'], ['model-syllable', 'syllable'], ['model-doc', 'doc']].forEach(function (pair) {
      var box = $(pair[0]);
      if (!box) return;
      box.querySelectorAll('button').forEach(function (btn) {
        on(btn, 'click', function () {
          box.querySelectorAll('button').forEach(function (b) { b.classList.remove('on'); });
          btn.classList.add('on');
          state.model[pair[1]] = btn.getAttribute('data-model');
          moveThumb(box, btn, true);
        });
      });
    });
    setupThumbs();
  }

  /* ---------------- 9. 文本 / 图片 Tab ---------------- */
  function refreshCount() {
    var src = $('src');
    var n = (src.value || '').length;
    $('count').textContent = n + ' / ' + MAX_SRC;
    $('count').style.color = n > MAX_SRC ? 'var(--lg-accent-deep)' : '';
  }

  var imageSeq = 0;
  function setImage(dataUrl) {
    var pendingImport = readPendingTransfer('it-image-import');
    if (pendingImport && pendingImport.purpose === 'translation') removePendingTransfer('it-image-import');
    state.image = dataUrl || null;
    var box = $('img-preview');
    var img = $('img-thumb');
    if (!box || !img) return;
    var seq = ++imageSeq;
    var height = box.getBoundingClientRect().height;
    var style = getComputedStyle(box);
    var opacity = style.opacity;
    var margin = style.marginBottom;
    stopMotion(box);
    img.onload = null;
    img.onerror = null;
    box.inert = !dataUrl;
    box.setAttribute('aria-hidden', dataUrl ? 'false' : 'true');

    function resize(nextHeight, showing) {
      box.style.height = nextHeight + 'px';
      playMotion(box, [
        { height: height + 'px', opacity: opacity, marginBottom: margin },
        { height: nextHeight + 'px', opacity: showing ? '1' : '0', marginBottom: showing ? '8px' : '0px' }
      ], PANEL_DURATION, function () {
        if (seq !== imageSeq) return;
        box.classList.toggle('on', showing);
        box.style.height = '';
        if (!showing) img.removeAttribute('src');
      }, 'image');
    }

    if (dataUrl) {
      box.classList.add('on');
      box.style.height = height + 'px';
      var revealed = false;
      function reveal() {
        if (seq !== imageSeq || revealed) return;
        revealed = true;
        // An image is a compact attachment, not another full-height card.
        // Its layout stays stable for portrait, landscape and replacement images.
        var attachmentHeight = parseFloat(getComputedStyle(box).getPropertyValue('--it-attachment-height')) || 88;
        resize(attachmentHeight, true);
      }
      img.onload = reveal;
      img.onerror = function () {
        if (seq === imageSeq) { toast('无法读取图片', true); setImage(null); }
      };
      img.src = dataUrl;
      if (img.complete && img.naturalWidth) reveal();
    } else {
      if (box.contains(document.activeElement)) $('btn-pick-img').focus({ preventScroll: true });
      resize(0, false);
    }
  }

  function outText(el, text, streaming) {
    if (!el) return;
    el.classList.toggle('empty', !text);
    if (!text) {
      el.textContent = '译文将在这里呈现';
      return;
    }
    el.innerHTML = '';
    el.appendChild(document.createTextNode(text));
    if (streaming) {
      var cursor = document.createElement('span');
      cursor.className = 'cursor';
      el.appendChild(cursor);
    }
    el.scrollTop = el.scrollHeight;
  }

  /* ---------------- 译文流式显示 ----------------
     网络 chunk 先排队，再按帧逐字揭示：每帧新揭示的一小段淡入（.st-seg），
     末尾保留闪烁光标。积压越大每帧吐字越多，长文不会变成慢吞吞的打字机。
     commit(text, final) 把文本一次落定；长文分块之间用它做段间校正，
     final=true 时去掉光标并结束 writer。 */
  var activeWriter = null;
  var outputWriters = new Map();

  function stopActiveWriter(el) {
    if (el) {
      var writer = outputWriters.get(el);
      if (writer) writer.stop();
    } else if (activeWriter) { activeWriter.stop(); activeWriter = null; }
  }

  function startWriter(el) {
    if (typeof outputWriters === 'undefined') outputWriters = new Map();
    var previousWriter = outputWriters.get(el);
    if (previousWriter) previousWriter.stop();
    var queue = '';
    var raf = 0;
    var done = false;
    var streamDuration = null;
    var segmentCleanups = new Set();
    var cursor = document.createElement('span');
    cursor.className = 'cursor';

    el.innerHTML = '';
    el.classList.remove('empty');
    el.appendChild(cursor);

    function clearSegments() {
      segmentCleanups.forEach(function (cleanup) { cleanup(); });
    }

    function appendPlain(text) {
      if (!text) return;
      var previous = cursor.previousSibling;
      if (previous && previous.nodeType === 3) previous.appendData(text);
      else el.insertBefore(document.createTextNode(text), cursor);
    }

    function paintPlain(text, keepCursor) {
      clearSegments();
      el.innerHTML = '';
      el.classList.toggle('empty', !text && !keepCursor);
      if (!text && !keepCursor) { el.textContent = '译文将在这里呈现'; return; }
      if (text) el.appendChild(document.createTextNode(text));
      if (keepCursor) el.appendChild(cursor);
      el.scrollTop = el.scrollHeight;
    }

    function frame() {
      raf = 0;
      if (done || !queue.length) return;
      if (motionReduced()) {
        appendPlain(queue);
        queue = '';
        el.scrollTop = el.scrollHeight;
        return;
      }
      /* 按剩余量自适应：长文每帧最多 90 字，短句也不会在尾段变成 3 字/帧的点滴 */
      var n = Math.max(6, Math.min(queue.length, Math.min(90, Math.ceil(queue.length / 14))));
      var seg = queue.slice(0, n);
      queue = queue.slice(n);

      var span = document.createElement('span');
      span.className = 'st-seg';
      span.textContent = seg;
      var settled = false;
      var settleTimer = 0;
      function cleanup() {
        span.removeEventListener('animationend', settle);
        clearTimeout(settleTimer);
        segmentCleanups.delete(cleanup);
      }
      function settle() {
        if (settled) return;
        settled = true;
        cleanup();
        if (span.parentNode !== el) return;
        /* 只合并已经落定的相邻文本；动画中的 span 保留原位置与时钟，
           即使 animationend 乱序到达，也不会重排译文或重启动画。 */
        var previous = span.previousSibling;
        var next = span.nextSibling;
        if (previous && previous.nodeType === 3) {
          previous.appendData(seg);
          el.removeChild(span);
        } else {
          previous = document.createTextNode(seg);
          el.replaceChild(previous, span);
        }
        if (next && next.nodeType === 3) {
          previous.appendData(next.data);
          el.removeChild(next);
        }
      }
      span.addEventListener('animationend', settle);
      segmentCleanups.add(cleanup);
      if (streamDuration == null) streamDuration = cssDuration('--lg-duration-stream', 200);
      settleTimer = setTimeout(settle, streamDuration + 60);
      el.insertBefore(span, cursor);
      el.scrollTop = el.scrollHeight;
      if (queue.length) raf = requestAnimationFrame(frame);
    }

    var writer = {
      closed: false,
      push: function (text) {
        if (writer.closed || !text) return;
        text = String(text);
        if (motionReduced()) {
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          appendPlain(queue + text);
          queue = '';
          el.scrollTop = el.scrollHeight;
          return;
        }
        queue += text;
        if (!raf) raf = requestAnimationFrame(frame);
      },
      commit: function (text, final) {
        if (writer.closed) return;
        queue = '';
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        paintPlain(String(text || ''), !final);
        if (final) {
          done = true;
          if (outputWriters.get(el) === writer) outputWriters.delete(el);
          if (activeWriter === writer) activeWriter = null;
        }
      },
      stop: function () {
        writer.closed = true;
        done = true;
        queue = '';
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        clearSegments();
        if (outputWriters.get(el) === writer) outputWriters.delete(el);
        if (activeWriter === writer) activeWriter = null;
      }
    };
    activeWriter = writer;
    outputWriters.set(el, writer);
    return writer;
  }

  /* ---------------- Translation tasks ---------------- */
  var taskStates = {};
  var docEditRevision = 0;
  var docImportSequence = 0;
  var textEditRevision = 0;
  function taskFor(mode) {
    if (!taskStates[mode]) taskStates[mode] = { sequence: 0, current: null, result: '' };
    return taskStates[mode];
  }
  function resultButtons(mode) {
    var ids = mode === 'text' ? ['btn-copy'] : mode === 'syllable' ? ['btn-copy-syllable'] : ['btn-copy-doc', 'btn-dl'];
    ids.forEach(function (id) { var button = $(id); if (button) button.disabled = !taskFor(mode).result.trim(); });
  }
  function taskCurrent(task) { return taskFor(task.mode).current === task; }
  function beginTask(mode, button, out) {
    var state = taskFor(mode);
    if (state.current) { toast('当前模式正在翻译，请先取消'); return null; }
    stopTaskDockMotion(button);
    state.result = '';
    resultButtons(mode);
    var task = { mode: mode, id: ++state.sequence, controller: new AbortController(),
      writer: startWriter(out), button: button, cancelled: false };
    state.current = task;
    var cancel = $('btn-cancel-' + mode);
    if (cancel) cancel.hidden = false;
    return task;
  }
  function finishTask(task) {
    if (!taskCurrent(task)) return;
    taskFor(task.mode).current = null;
    stopTaskDockMotion(task.button);
    setBusy(task.button, false);
    var cancel = $('btn-cancel-' + task.mode);
    if (cancel) cancel.hidden = true;
    resultButtons(task.mode);
  }
  function cancelTask(mode, clear) {
    var state = taskFor(mode), task = state.current;
    if (task) {
      stopTaskDockMotion(task.button);
      state.current = null;
      task.cancelled = true;
      task.writer.stop();
      task.controller.abort();
      setBusy(task.button, false);
      var cancel = $('btn-cancel-' + mode);
      if (cancel) cancel.hidden = true;
    }
    if (clear) state.result = '';
    resultButtons(mode);
  }
  function copyResult(mode) {
    var result = taskFor(mode).result;
    if (!result.trim()) { toast('还没有完整译文'); return; }
    copyText(result);
  }
  function bindCancel(mode, outId, metaId) {
    on($('btn-cancel-' + mode), 'click', function () {
      if (!taskFor(mode).current) return;
      cancelTask(mode, false);
      outText($(outId), taskFor(mode).result, false);
      $(metaId).textContent = '已取消，保留已完成内容';
    });
    resultButtons(mode);
  }

  function runText() {
    if (taskFor('text').current) { toast('文本正在翻译，请先取消'); return; }
    var src = $('src');
    var text = (src.value || '').trim();
    var instruct = ($('instruct').value || '').trim();
    var image = state.image;

    if (!text && !instruct && !image) { toast('先输入内容或选择图片'); return; }
    if (text.length > MAX_SRC) { toast('原文超过 ' + MAX_SRC + ' 字，请分段翻译'); return; }

    var go = $('btn-go');
    var out = $('out-text');
    var meta = $('meta-text');
    var started = performance.now();

    var task = beginTask('text', go, out);
    if (!task) return;
    setBusy(go, true, image ? '视觉翻译中…' : '翻译中…');
    var writer = task.writer;
    meta.textContent = '';

    var payload;
    if (image) {
      payload = basePayload(state.model.text, buildImagePrompt(text, instruct, state.src, state.tgt), maxTokensFor(text || ''));
      payload.messages[0].content = [
        { type: 'text', text: payload.messages[0].content },
        { type: 'image_url', image_url: { url: image } }
      ];
    } else if (instruct) {
      payload = basePayload(state.model.text, buildInstructionPrompt(text, instruct, state.src, state.tgt), maxTokensFor(text));
    } else {
      payload = basePayload(state.model.text, plainPrompt(text, state.src, state.tgt), maxTokensFor(text));
    }

    var buffer = '';
    chatStream(payload, function (chunk) {
      if (!taskCurrent(task)) return;
      buffer += chunk;
      writer.push(chunk);
    }, task.controller.signal).then(function (result) {
      if (!taskCurrent(task)) return;
      taskFor('text').result = result.text;
      writer.commit(result.text, true);
      var parts = [];
      if (result.usage) parts.push(result.usage.total_tokens + ' tokens');
      parts.push(fmtSeconds(result.ms));
      meta.textContent = parts.join(' · ');
    }).catch(function (error) {
      if (!taskCurrent(task)) return;
      writer.stop();
      if (error && error.name === 'AbortError') {
        outText(out, taskFor('text').result, false);
        meta.textContent = '已取消';
        return;
      }
      outText(out, '', false);
      out.textContent = '翻译失败：' + (error && error.message ? error.message : error);
      out.classList.remove('empty');
      meta.textContent = '';
    }).then(function () {
      finishTask(task);
    });
  }

  function initTextPane() {
    on($('src'), 'input', function () { textEditRevision++; refreshCount(); });
    bindCancel('text', 'out-text', 'meta-text');
    function importPastedImage(file, expectedRevision) {
      if (expectedRevision != null && expectedRevision !== imageSeq) return;
      var revision = ++imageSeq;
      var pending = readPendingTransfer('it-image-import');
      if (pending && pending.purpose === 'translation') removePendingTransfer('it-image-import');
      var reader = new FileReader();
      reader.onload = function (event) {
        shrinkImage(event.target.result, function (dataUrl) {
          if (revision === imageSeq) setImage(dataUrl);
        });
      };
      reader.onerror = function () { if (revision === imageSeq) toast('读取图片失败', true); };
      reader.readAsDataURL(file);
    }
    on($('src'), 'paste', function (event) {
      var items = event.clipboardData && event.clipboardData.items;
      for (var index = 0; items && index < items.length; index++) {
        if (items[index].type.indexOf('image/') !== 0) continue;
        var image = items[index].getAsFile();
        if (image) { event.preventDefault(); importPastedImage(image); return; }
      }
    });

    on($('btn-pick-img'), 'click', function () {
      var requestedImageSeq = imageSeq;
      Bridge.pickImage(function (dataUrl) {
        // A background native import must not undo a later clear, delete or paste.
        if (imageSeq === requestedImageSeq) setImage(dataUrl);
      });
    });

    on($('img-del'), 'click', function () { setImage(null); });

    on($('btn-paste'), 'click', function () {
      var imageRevision = imageSeq;
      var textRevision = textEditRevision;
      function stillCurrent() { return imageRevision === imageSeq && textRevision === textEditRevision; }
      if (!Bridge.isMac && navigator.clipboard && navigator.clipboard.read) {
        navigator.clipboard.read().then(function (items) {
          if (!stillCurrent()) return;
          for (var index = 0; index < items.length; index++) {
            var type = items[index].types.filter(function (value) { return value.indexOf('image/') === 0; })[0];
            if (type) return items[index].getType(type).then(function (file) {
              if (stillCurrent()) importPastedImage(file, imageRevision);
            });
          }
          return navigator.clipboard.readText().then(function (text) {
            if (!stillCurrent()) return;
            if (!text) { toast('剪贴板是空的'); return; }
            textEditRevision++;
            $('src').value += ($('src').value ? '\n' : '') + text;
            refreshCount();
          });
        }).catch(function () { toast('读取剪贴板被拒绝，请在输入框直接粘贴'); });
        return;
      }
      if (!Bridge.isMac && (!navigator.clipboard || !navigator.clipboard.readText)) {
        toast('当前环境不支持读取剪贴板');
        return;
      }
      var read = Bridge.isMac ? Bridge.invoke('it_read_clipboard_text') : navigator.clipboard.readText();
      read.then(function (text) {
        if (!stillCurrent()) return;
        if (!text) { toast('剪贴板是空的'); return; }
        textEditRevision++;
        var src = $('src');
        src.value = (src.value ? src.value + '\n' : '') + text;
        refreshCount();
      }, function () { toast('读取剪贴板被拒绝'); });
    });

    on($('btn-go'), 'click', runText);

    on($('btn-clear'), 'click', function () {
      textEditRevision++;
      cancelTask('text', true);
      stopActiveWriter($('out-text'));
      $('src').value = '';
      $('instruct').value = '';
      $('instruct-badge').hidden = true;
      setImage(null);
      outText($('out-text'), '', false);
      $('meta-text').textContent = '';
      refreshCount();
    });

    on($('btn-copy'), 'click', function () { copyResult('text'); });

    on($('instruct'), 'input', function () {
      $('instruct-badge').hidden = !this.value.trim();
    });

    /* 桌面端划词翻译入口：Rust 侧捕获选区后调用 */
    var acceptedSelections = new Set();
    window.__itTranslateSelection = function (text, requestId) {
      text = String(text == null ? '' : text).trim();
      if (!text) return false;
      if (requestId != null) {
        requestId = String(requestId);
        if (acceptedSelections.has(requestId)) return true;
        acceptedSelections.add(requestId);
        if (acceptedSelections.size > 128) acceptedSelections.delete(acceptedSelections.values().next().value);
        window.__itSelectionAccepted = requestId;
      }
      cancelTask('text', true);
      textEditRevision++;
      switchTab('text');
      if (text.length > MAX_SRC) text = text.slice(0, MAX_SRC);
      $('src').value = text;
      refreshCount();
      setImage(null);
      var selectionRevision = textEditRevision;
      setTimeout(function () {
        if (selectionRevision === textEditRevision && $('src').value === text) runText();
      }, 60);
      return true;
    };

    /* 安卓相机拍完回填后自动翻译 */
    window.__itAutoTranslateImage = function () { setTimeout(runText, 80); };

    /* 待处理选区（热键唤起时页面可能还没准备好） */
    function consumePendingSelection() {
      var pending = '';
      if (window.__itPendingSelection) {
        pending = window.__itPendingSelection;
        delete window.__itPendingSelection;
      } else {
        try {
          pending = sessionStorage.getItem('it-pending-selection') || '';
          if (pending) sessionStorage.removeItem('it-pending-selection');
        } catch (e) {}
      }
      if (pending) {
        if (typeof pending === 'object') window.__itTranslateSelection(pending.text, pending.id);
        else {
          try {
            var parsed = JSON.parse(pending);
            if (parsed && parsed.id != null && parsed.text) { window.__itTranslateSelection(parsed.text, parsed.id); return; }
          } catch (_) {}
          window.__itTranslateSelection(pending);
        }
      }
    }
    consumePendingSelection();
  }

  /* 展开和回收共用一段可反向的轨迹，点击中途不锁操作。 */
  function initInstructBox() {
    var box = $('instruct-box');
    var body = $('instruct-body');
    if (!box || !body) return;
    var summary = box.querySelector('summary');
    if (!summary) return;
    var expanded = box.open;
    body.inert = !expanded;
    body.setAttribute('aria-hidden', expanded ? 'false' : 'true');
    summary.setAttribute('aria-expanded', expanded ? 'true' : 'false');

    function setExpanded(next) {
      var from = visualStyle(body);
      var height = body.getBoundingClientRect().height;
      stopMotion(body);
      expanded = next;
      if (!next && body.contains(document.activeElement)) summary.focus({ preventScroll: true });
      body.inert = !next;
      body.setAttribute('aria-hidden', next ? 'false' : 'true');
      summary.setAttribute('aria-expanded', next ? 'true' : 'false');
      box.dataset.expanded = next ? 'true' : 'false';
      box.open = true;
      var full = body.scrollHeight;
      var target = next ? full : 0;
      body.classList.toggle('show', next);
      body.style.height = target + 'px';
      playMotion(body, [{
        height: height + 'px', opacity: from.opacity, transform: from.transform
      }, {
        height: target + 'px', opacity: next ? '1' : '0',
        transform: next ? 'none' : 'translateY(-8px)'
      }], PANEL_DURATION * Math.max(.35, Math.min(1, Math.abs(target - height) / Math.max(1, full))), function () {
        box.open = next;
        body.style.height = next ? 'auto' : '';
      }, 'fold');
    }

    on(summary, 'click', function (e) {
      e.preventDefault();
      setExpanded(!expanded);
    });
    closeInstructLayer = function () {
      if (!expanded || state.tab !== 'text') return false;
      setExpanded(false);
      return true;
    };
  }

  /* ---------------- 10. 音节 Tab ---------------- */
  function runSyllable() {
    if (taskFor('syllable').current) { toast('音节模式正在翻译，请先取消'); return; }
    var text = ($('syl-src').value || '').trim();
    if (!text) { toast('先输入原文'); return; }

    var go = $('btn-go-syllable');
    var out = $('out-syllable');
    var meta = $('meta-syllable');
    var syllables = $('syl-count').value;

    var task = beginTask('syllable', go, out);
    if (!task) return;
    setBusy(go, true);
    var writer = task.writer;
    meta.textContent = '';

    var payload = basePayload(
      state.model.syllable,
      buildSyllablePrompt(text, syllables, state.tgt),
      maxTokensFor(text)
    );

    var buffer = '';
    chatStream(payload, function (chunk) {
      if (!taskCurrent(task)) return;
      buffer += chunk;
      writer.push(chunk);
    }, task.controller.signal).then(function (result) {
      if (!taskCurrent(task)) return;
      taskFor('syllable').result = result.text;
      writer.commit(result.text, true);
      var parts = [];
      if (result.usage) parts.push(result.usage.total_tokens + ' tokens');
      parts.push(fmtSeconds(result.ms));
      meta.textContent = parts.join(' · ');
    }).catch(function (error) {
      if (!taskCurrent(task)) return;
      writer.stop();
      if (error && error.name === 'AbortError') { meta.textContent = '已取消'; return; }
      out.textContent = '翻译失败：' + (error && error.message ? error.message : error);
      out.classList.remove('empty');
    }).then(function () {
      finishTask(task);
    });
  }

  function initSyllablePane() {
    bindCancel('syllable', 'out-syllable', 'meta-syllable');
    on($('syl-src'), 'input', function () {
      $('syl-count-label').textContent = (this.value || '').length + ' 字';
    });
    on($('btn-go-syllable'), 'click', runSyllable);
    on($('btn-clear-syllable'), 'click', function () {
      cancelTask('syllable', true);
      stopActiveWriter($('out-syllable'));
      $('syl-src').value = '';
      $('syl-count-label').textContent = '0 字';
      outText($('out-syllable'), '', false);
      $('meta-syllable').textContent = '';
    });
    on($('btn-copy-syllable'), 'click', function () { copyResult('syllable'); });
  }

  /* ---------------- 11. 长文本 Tab ---------------- */
  function splitChunks(text, size) {
    if (text.length <= size) return [text];
    var chunks = [];
    var rest = text;
    while (rest.length) {
      if (rest.length <= size) { chunks.push(rest); break; }
      var slice = rest.slice(0, size);
      /* 尽量在段落/句末断开，避免把句子劈开 */
      var cut = Math.max(
        slice.lastIndexOf('\n\n'),
        slice.lastIndexOf('。'),
        slice.lastIndexOf('\n')
      );
      if (cut < size * 0.5) cut = size - 1;
      chunks.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
    return chunks.filter(function (c) { return c.trim(); });
  }

  function runDoc() {
    if (taskFor('doc').current) { toast('长文正在翻译，请先取消'); return; }
    var text = ($('doc-src').value || '').trim();
    if (!text) { toast('先粘贴长文或打开文件'); return; }

    var size = parseInt($('doc-chunk').value, 10) || 4000;
    var chunks = splitChunks(text, size);
    var go = $('btn-go-doc');
    var out = $('out-doc');
    var meta = $('meta-doc');
    var bar = $('doc-bar');

    var task = beginTask('doc', go, out);
    if (!task) return;
    var snapshot = { model: state.model.doc, src: state.src, tgt: state.tgt };
    setBusy(go, true, '翻译中…');
    var writer = task.writer;
    bar.style.width = '0%';

    var done = [];
    var index = 0;

    function next() {
      if (!taskCurrent(task)) return Promise.resolve();
      if (index >= chunks.length) {
        writer.commit(done.join('\n\n'), true);
        meta.textContent = chunks.length + ' 块 · 完成';
        bar.style.width = '100%';
        return Promise.resolve();
      }
      var chunk = chunks[index];
      meta.textContent = '第 ' + (index + 1) + ' / ' + chunks.length + ' 块';
      var payload = basePayload(
        snapshot.model,
        plainPrompt(chunk, snapshot.src, snapshot.tgt),
        maxTokensFor(chunk)
      );

      var buffer = '';
      return chatStream(payload, function (delta) {
        if (!taskCurrent(task)) return;
        buffer += delta;
        writer.push(delta);
      }, task.controller.signal).then(function (result) {
        if (!taskCurrent(task)) return;
        done.push((result.text || buffer).trim());
        taskFor('doc').result = done.join('\n\n');
        index++;
        bar.style.width = Math.round(index / chunks.length * 100) + '%';
        if (writer.closed) return Promise.resolve();
        /* 每块结束把已完成的段落校正为最终文本，下一块接着往后流 */
        writer.commit(done.join('\n\n') + (index < chunks.length ? '\n\n' : ''), false);
        return next();
      });
    }

    next().then(function () {
      finishTask(task);
    }).catch(function (error) {
      if (!taskCurrent(task)) return;
      finishTask(task);
      if (error && error.name === 'AbortError') {
        meta.textContent = '已取消（已完成 ' + done.length + ' 块）';
        return;
      }
      meta.textContent = '第 ' + (index + 1) + ' 块失败：' + (error && error.message ? error.message : error);
      writer.stop();
      outText(out, done.join('\n\n'), false);
    });
  }

  function initDocPane() {
    bindCancel('doc', 'out-doc', 'meta-doc');
    on($('doc-src'), 'input', function () {
      docEditRevision++;
      invalidateDocumentImport();
      var n = (this.value || '').length;
      $('doc-stat').textContent = n ? n.toLocaleString() + ' 字符' : '';
      $('doc-name').textContent = '原文';
    });

    on($('btn-doc-file'), 'click', function () {
      docImportSequence++;
      var revision = nativeImagePickPrefix + ':' + docImportSequence;
      var pending = { token: revision, revision: docEditRevision };
      writePendingTransfer('it-document-import', pending);
      if (Bridge.isAndroid && window.NativeBridge && window.NativeBridge.prepareDocumentImport) {
        window.NativeBridge.prepareDocumentImport(revision);
      }
      $('doc-file').click();
    });

    on($('doc-file'), 'change', function () {
      var file = this.files && this.files[0];
      this.value = '';
      if (!file) return;
      var sequence = ++docImportSequence;
      var editRevision = docEditRevision;
      var pending = readPendingTransfer('it-document-import');
      function acknowledge() {
        if (Bridge.isAndroid && window.NativeBridge && window.NativeBridge.acknowledgeDocumentImport && pending) {
          window.NativeBridge.acknowledgeDocumentImport(pending.token);
        }
        var current = readPendingTransfer('it-document-import');
        if (pending && current && pending.token === current.token) removePendingTransfer('it-document-import');
      }
      var reader = new FileReader();
      reader.onload = function (ev) {
        acknowledge();
        if (sequence !== docImportSequence || editRevision !== docEditRevision) return;
        docEditRevision++;
        $('doc-src').value = ev.target.result || '';
        $('doc-name').textContent = file.name;
        $('doc-stat').textContent = (ev.target.result || '').length.toLocaleString() + ' 字符';
      };
      reader.onerror = function () { acknowledge(); if (sequence === docImportSequence) toast('读取文件失败', true); };
      reader.readAsText(file);
    });

    on($('btn-go-doc'), 'click', runDoc);

    on($('btn-clear-doc'), 'click', function () {
      cancelTask('doc', true);
      stopActiveWriter($('out-doc'));
      docEditRevision++;
      docImportSequence++;
      invalidateDocumentImport();
      $('doc-src').value = '';
      $('doc-name').textContent = '原文';
      $('doc-stat').textContent = '';
      outText($('out-doc'), '', false);
      $('meta-doc').textContent = '';
      $('doc-bar').style.width = '0%';
    });

    on($('btn-copy-doc'), 'click', function () { copyResult('doc'); });

    on($('btn-dl'), 'click', function () {
      var text = taskFor('doc').result;
      if (!text.trim()) { toast('还没有译文'); return; }
      if (Bridge.isAndroid && window.NativeBridge && window.NativeBridge.saveDocument) {
        window.NativeBridge.saveDocument('译文.txt', text);
        return;
      }
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '译文.txt';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });
  }

  function invalidateDocumentImport() {
    var pending = readPendingTransfer('it-document-import');
    if (pending) { pending.invalidated = true; writePendingTransfer('it-document-import', pending); }
  }

  function initRestoredTransfers() {
    window.__itOnRestoredDocument = function (text, name, revision) {
      var pending = readPendingTransfer('it-document-import');
      if (pending && pending.token === revision && !pending.invalidated &&
          !$('doc-src').value) {
        docEditRevision++;
        $('doc-src').value = text;
        $('doc-name').textContent = name;
        $('doc-stat').textContent = text.length.toLocaleString() + ' 字符';
      }
      if (window.NativeBridge && window.NativeBridge.acknowledgeDocumentImport) window.NativeBridge.acknowledgeDocumentImport(revision);
      if (pending && pending.token === revision) removePendingTransfer('it-document-import');
      return true;
    };
    window.__itOnDocumentSaved = function (status, message) { toast(message, status === 'error'); return true; };
    window.__itRestoreImage = function (dataUrl, token, purpose) {
      var pending = readPendingTransfer('it-image-import');
      if (pending && pending.token === token && pending.purpose === purpose) {
        if (purpose === 'translation') setImage(dataUrl);
        else {
          var preferences = copyObject(activePreferences);
          if (purpose === 'background') preferences.background.data = dataUrl;
          else if (purpose === 'popup-background') preferences.popup.backgroundData = dataUrl;
          applyPreferences(preferences);
          try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(activePreferences)); } catch (_) {}
        }
        removePendingTransfer('it-image-import');
      }
      if (window.NativeBridge && window.NativeBridge.acknowledgeImage) window.NativeBridge.acknowledgeImage(token);
      return true;
    };
    if (Bridge.isAndroid && window.NativeBridge && window.NativeBridge.bridgeReady) window.NativeBridge.bridgeReady();
  }

  /* ---------------- 12. 背景 ---------------- */
  var appliedBackgroundData = '';

  function applyBackground(dataUrl, preferences) {
    var id = 'it-bg-style';
    var style = $(id);
    if (!dataUrl || !/^data:image\/(png|jpeg|webp|gif);base64,/i.test(dataUrl)) {
      if (style) style.remove();
      document.documentElement.style.removeProperty('--it-bg-image');
      document.documentElement.style.removeProperty('--it-bg-overlay');
      document.documentElement.style.removeProperty('--it-bg-fit');
      document.documentElement.style.removeProperty('--it-bg-blur');
      document.documentElement.style.removeProperty('--it-bg-inset');
      appliedBackgroundData = '';
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      document.head.appendChild(style);
    }
    preferences = preferences || activePreferences.background;
    var alpha = Math.max(0, Math.min(80, Number(preferences.opacity) || 0)) / 100;
    var overlay = resolvedAppearance(activePreferences) === 'dark' ?
      'rgba(18,16,24,' + alpha + ')' : 'rgba(255,255,255,' + alpha + ')';
    var blur = Math.max(0, Math.min(20, Number(preferences.blur) || 0));
    var fit = preferences.fit === 'contain' ? 'contain' : 'cover';
    if (appliedBackgroundData !== dataUrl) {
      document.documentElement.style.setProperty('--it-bg-image', 'url("' + dataUrl + '")');
      appliedBackgroundData = dataUrl;
    }
    document.documentElement.style.setProperty('--it-bg-overlay', overlay);
    document.documentElement.style.setProperty('--it-bg-fit', fit);
    document.documentElement.style.setProperty('--it-bg-blur', blur + 'px');
    document.documentElement.style.setProperty('--it-bg-inset', blur ? '-40px' : '-2%');
    style.textContent = 'body::before{background-image:linear-gradient(var(--it-bg-overlay),var(--it-bg-overlay)),' +
      'var(--it-bg-image)!important;background-size:var(--it-bg-fit)!important;' +
      'background-position:center!important;background-repeat:no-repeat!important;' +
      'background-attachment:fixed!important;inset:var(--it-bg-inset)!important;' +
      'filter:blur(var(--it-bg-blur));}';
  }

  function restoreBackground() {
    applyBackground(activePreferences.background.data, activePreferences.background);
  }

  function initMenu() {
    var menu = $('more-menu');
    var brand = $('brand');
    var mobileSettings = $('mobile-settings');
    if (!menu || !brand) return;
    var aboutMask = $('it-about-mask');
    var aboutDialog = aboutMask && aboutMask.querySelector('.it-about');
    var repositoryLink = aboutDialog && aboutDialog.querySelector('.it-about-repository');
    if (Bridge.isAndroid && repositoryLink) repositoryLink.target = '_self';
    var aboutReturnFocus = null;
    var aboutOrigin = null;
    var aboutBackgroundState = [];
    menu.setAttribute('aria-hidden', 'true');
    menu.inert = true;
    var menuOrigin = brand;
    var menuTrigger = brand;

    function visibleMenuTrigger(preferred) {
      if (preferred && preferred.isConnected && preferred.getClientRects().length) return preferred;
      return mobileSettings && mobileSettings.getClientRects().length ? mobileSettings : brand;
    }

    function closeMenu() {
      if (!menu.classList.contains('on')) return false;
      if (menu.contains(document.activeElement)) visibleMenuTrigger(menuTrigger).focus({ preventScroll: true });
      if (mobileSettings) mobileSettings.setAttribute('aria-expanded', 'false');
      menu.setAttribute('aria-hidden', 'true');
      menu.inert = true;
      moveSurface(menu, menuOrigin, false, function () { menu.hidden = true; });
      return true;
    }
    closeMenuLayer = closeMenu;

    function closeAbout() {
      if (!aboutMask || !aboutMask.classList.contains('on')) return false;
      aboutMask.classList.remove('on');
      aboutMask.setAttribute('aria-hidden', 'true');
      aboutMask.inert = true;
      moveSurface(aboutDialog, aboutOrigin, false, function () {
        aboutMask.classList.remove('it-surface-leave');
      });
      aboutBackgroundState.forEach(function (entry) { entry.el.inert = entry.inert; });
      aboutBackgroundState = [];
      if (aboutReturnFocus && aboutReturnFocus.isConnected) {
        visibleMenuTrigger(aboutReturnFocus).focus({ preventScroll: true });
      }
      return true;
    }
    closeAboutLayer = closeAbout;

    function openAbout(origin) {
      if (!aboutMask || !aboutDialog) return;
      closeSelect();
      aboutOrigin = origin || rectOf(document.activeElement);
      aboutReturnFocus = visibleMenuTrigger(menuTrigger);
      aboutMask.inert = false;
      aboutMask.setAttribute('aria-hidden', 'false');
      aboutMask.classList.remove('it-surface-leave');
      aboutMask.classList.add('on');
      aboutBackgroundState = Array.prototype.slice.call(document.body.children).filter(function (el) {
        return el !== aboutMask && !/^(SCRIPT|STYLE)$/.test(el.tagName);
      }).map(function (el) {
        var entry = { el: el, inert: el.inert };
        el.inert = true;
        return entry;
      });
      moveSurface(aboutDialog, aboutOrigin, true);
      aboutDialog.querySelector('[data-close-about]').focus({ preventScroll: true });
    }
    window.__itOpenAbout = function () {
      if (closeSettingsLayer) closeSettingsLayer();
      if (document.querySelector('.it-set-mask.on')) return;
      openAbout();
    };

    on(aboutMask, 'click', function (e) {
      if (e.target === aboutMask || (e.target.closest && e.target.closest('[data-close-about]'))) closeAbout();
    });
    on(aboutMask, 'keydown', function (e) {
      if (e.key !== 'Tab' || !aboutMask.classList.contains('on')) return;
      var focusable = Array.prototype.slice.call(aboutDialog.querySelectorAll('button, a, [tabindex]'))
        .filter(function (el) { return !el.disabled && el.tabIndex >= 0 && el.getClientRects().length; });
      if (!focusable.length) { e.preventDefault(); aboutDialog.focus(); return; }
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === aboutDialog)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    });

    function openAt(x, y, origin, above) {
      closeSelect();
      menuTrigger = visibleMenuTrigger(origin && origin.focus ? origin : null);
      menuOrigin = origin || menuTrigger;
      menu.hidden = false;
      menu.setAttribute('aria-hidden', 'false');
      menu.inert = false;
      /* 先显示再量尺寸，避免贴边时溢出视口 */
      var w = menu.offsetWidth;
      var h = menu.offsetHeight;
      if (above) {
        var anchor = menuTrigger.getBoundingClientRect();
        x = anchor.right - w;
        y = anchor.top - h - 10;
      }
      var left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
      var top = Math.max(8, Math.min(y, window.innerHeight - h - 8));
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
      if (mobileSettings) mobileSettings.setAttribute('aria-expanded', menuTrigger === mobileSettings ? 'true' : 'false');
      moveSurface(menu, menuOrigin, true);
    }

    on(mobileSettings, 'click', function (e) {
      e.stopPropagation();
      if (menu.classList.contains('on') && menuTrigger === mobileSettings) {
        closeMenu();
        return;
      }
      openAt(0, 0, mobileSettings, true);
      var firstItem = menu.querySelector('button');
      if (firstItem) firstItem.focus({ preventScroll: true });
    });

    /* 桌面：左键单击或右键「笺」都开菜单 */
    on(brand, 'click', function (e) {
      e.stopPropagation();
      var rect = brand.getBoundingClientRect();
      openAt(rect.left, rect.bottom + 6);
    });

    on(brand, 'contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openAt(e.clientX, e.clientY);
    });

    /* 触摸设备：长按「笺」 */
    var pressTimer = 0;
    on(brand, 'touchstart', function (e) {
      var touch = e.touches[0];
      pressTimer = setTimeout(function () { openAt(touch.clientX, touch.clientY); }, 480);
    }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(function (ev) {
      on(brand, ev, function () { clearTimeout(pressTimer); }, { passive: true });
    });

    /* 键盘：回车 / 空格 */
    on(brand, 'keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      var rect = brand.getBoundingClientRect();
      openAt(rect.left, rect.bottom + 6);
    });

    on(document, 'click', closeMenu);
    on(menu, 'click', function (e) {
      var target = e.target.closest('[data-act]');
      if (!target) return;
      var origin = target.getBoundingClientRect();
      closeMenu();
      var act = target.getAttribute('data-act');

      if (act === 'settings') {
        if (window.__itOpenSettings) {
          window.__itOpenSettings({
            section: 'appearance',
            origin: origin,
            trigger: visibleMenuTrigger(menuTrigger)
          });
        }
      } else if (act === 'about') {
        openAbout(origin);
      }
    });
  }

  /* ---------------- 13. Liquid Glass surfaces ---------------- */
  var LIQUID_GLASS_SURFACES = '.tabs, .tabs-thumb, .models-thumb, .it-set-nav-thumb, ' +
    '.mobile-settings, .sel-btn, .pill, .btn-primary, .btn-secondary, .btn-ghost, ' +
    '.img-preview .del, .it-set-foot button, .it-set-actions button';

  function setupLiquidGlassSurfaces(scope) {
    if (!scope) return;
    function attachSurface(surface) {
      var preset = surface.matches('.tabs-thumb, .models-thumb, .it-set-nav-thumb') ? 'pill' : 'button';
      window.ItLiquidGlass.attach(surface, preset, { material: surface.matches('.tabs-thumb') ? 'clear' : 'default' });
    }
    if (scope.matches && scope.matches(LIQUID_GLASS_SURFACES)) attachSurface(scope);
    if (scope.querySelectorAll) scope.querySelectorAll(LIQUID_GLASS_SURFACES).forEach(function (surface) {
      attachSurface(surface);
    });
  }

  function initGlass() {
    var liquidGlassErrorShown = false;
    function showLiquidGlassError(detail) {
      if (liquidGlassErrorShown) return;
      liquidGlassErrorShown = true;
      var message = detail && detail.code === 'unsupported' ?
        '当前浏览器无法绘制液态玻璃，请使用 Chromium 内核或安装笺桌面版。' :
        '液态玻璃滤镜初始化失败，请重启窗口。';
      var notice = document.createElement('div');
      notice.className = 'it-glass-error';
      notice.setAttribute('role', 'alert');
      notice.textContent = message;
      document.body.appendChild(notice);
    }
    on(document, 'it-liquid-glass-error', function (event) { showLiquidGlassError(event.detail); });
    setupLiquidGlassSurfaces(document);
    if (document.documentElement.dataset.itLiquidGlass === 'unsupported' ||
        document.querySelector('[data-it-liquid-state="error"]')) {
      showLiquidGlassError({ code: document.documentElement.dataset.itLiquidGlass === 'unsupported'
        ? 'unsupported' : 'generation' });
    }
    var observer = new MutationObserver(function (mutations) {
      var refreshScopes = new Set();
      mutations.forEach(function (mutation) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(function (node) {
            if (node.nodeType === 1) setupLiquidGlassSurfaces(node);
          });
        } else if (mutation.target.matches && mutation.target.matches(LIQUID_GLASS_SURFACES)) {
          if (mutation.attributeName === 'data-it-liquid-state' &&
              mutation.target.dataset.itLiquidState === 'error') {
            showLiquidGlassError({ code: 'generation' });
          } else if (mutation.attributeName !== 'data-it-liquid-state') {
            refreshScopes.add(mutation.target);
          }
        }
      });
      refreshScopes.forEach(function (scope) { window.ItLiquidGlass.refresh(scope); });
    });
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['hidden', 'class', 'data-it-liquid-state']
    });
    var pressedPillScope = null;
    var pressedPointer = null;
    function releasePill(event) {
      if (event && event.pointerId != null && pressedPointer != null &&
          event.pointerId !== pressedPointer) return;
      if (pressedPillScope) window.ItLiquidGlass.setInteraction(pressedPillScope, false);
      pressedPillScope = null;
      pressedPointer = null;
    }
    on(document, 'pointerdown', function (event) {
      if (event.button !== 0) return;
      releasePill();
      var scope = event.target.closest && event.target.closest('.tabs, .models, .it-set-nav');
      if (!scope) return;
      pressedPillScope = scope;
      pressedPointer = event.pointerId;
      window.ItLiquidGlass.setInteraction(scope, true);
    }, { passive: true });
    on(document, 'pointerup', releasePill, { passive: true });
    on(document, 'pointercancel', releasePill, { passive: true });
    on(document, 'lostpointercapture', releasePill, { passive: true });
    on(window, 'blur', function () { releasePill(); });
  }
  /* ---------------- 14. 桌面端标题栏 ---------------- */
  /* 顶栏本身就是标题栏：右侧窗口按钮 + 空白处拖动，菜单挂在「笺」上 */
  function initTitlebar() {
    if (!Bridge.isDesktop) return;

    var actions = $('win-actions');
    if (actions) {
      actions.hidden = Bridge.isMac;
      /* 用 mousedown 而不是 click：空白区的拖动处理会吞掉 click */
      actions.addEventListener('mousedown', function (e) {
        var button = e.target.closest && e.target.closest('button[data-act]');
        if (!button) return;
        e.preventDefault();
        e.stopPropagation();
        Bridge.invoke('it_window_action', { action: button.getAttribute('data-act') })
          .catch(function () {});
      }, true);
    }

    var bar = $('appbar');
    if (!bar) return;
    if (Bridge.isMac) return;
    var lastDown = 0;
    bar.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      /* 「笺」自己处理点击（开菜单），不参与拖动 */
      if (e.target.closest && e.target.closest('button, select, input, a, .tabs, .brand')) return;
      e.preventDefault();

      /* 双击最大化：第一次 mousedown 会进系统拖动循环，第二次到达时
         e.detail 已经是 2，这里必须先判定再决定是否 drag，否则永远等不到 dblclick。 */
      var now = Date.now();
      if (e.detail >= 2 || (now - lastDown < 320)) {
        lastDown = 0;
        Bridge.invoke('it_window_action', { action: 'maximize' }).catch(function () {});
        return;
      }
      lastDown = now;
      Bridge.invoke('it_window_action', { action: 'drag' }).catch(function () {});
    });
  }

  /* 无边框窗口没有系统边框，四边/四角用 5px 热区接管缩放 */
  function initResizeHandles() {
    if (!Bridge.isDesktop || Bridge.isMac) return;
    ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach(function (dir) {
      var handle = document.createElement('div');
      handle.className = 'rz rz-' + dir;
      handle.setAttribute('aria-hidden', 'true');
      handle.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        Bridge.invoke('it_window_action', { action: 'resize-' + dir }).catch(function () {});
      });
      document.body.appendChild(handle);
    });
  }

  /* ---------------- 15. Shared settings panel ---------------- */
  var settingsState = null;
  var committedSettings = null;
  var scheduleAppUpdateCheck = null;
  var DEFAULT_SETTINGS = {
    selection_shortcut: Bridge.isMac ? 'Cmd+Alt+T' : 'Ctrl+Alt+T',
    activation_shortcut: Bridge.isMac ? 'Cmd+Alt+I' : 'Ctrl+Alt+I',
    open_main_window: false, target_lang: 'auto', auto_start: false, start_to_tray: false,
    preferences: copyObject(DEFAULT_PREFERENCES)
  };

  function valueAtPath(source, path) {
    return path.split('.').reduce(function (value, key) {
      return value && value[key] != null ? value[key] : undefined;
    }, source);
  }

  function assignAtPath(target, path, value) {
    var parts = path.split('.');
    var cursor = target;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!cursor[parts[i]]) cursor[parts[i]] = {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
  }

  function settingsFromSaved(saved, localPreferences) {
    var result = copyObject(DEFAULT_SETTINGS);
    if (saved && typeof saved === 'object') {
      ['selection_shortcut', 'activation_shortcut', 'open_main_window', 'target_lang',
        'auto_start', 'start_to_tray'].forEach(function (key) {
        if (saved[key] !== undefined) result[key] = saved[key];
      });
    }
    result.preferences = normalizePreferences(
      saved && saved.preferences ? saved.preferences : localPreferences);
    return result;
  }

  function restoreTranslationPreferences(preferences) {
    var translation = normalizePreferences(preferences).translation;
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem('it-state') || 'null'); }
    catch (e) {}

    state.tab = translation.defaultTab === 'last' ? 'text' : translation.defaultTab;
    state.src = translation.sourceLanguage;
    state.tgt = translation.targetLanguage;
    Object.keys(state.model).forEach(function (group) {
      state.model[group] = translation.defaultModels[group];
    });
    if (saved) {
      if (translation.defaultTab === 'last' && ['text', 'syllable', 'doc'].indexOf(saved.tab) >= 0) {
        state.tab = saved.tab;
      }
      if (translation.rememberLanguages) {
        if (Object.prototype.hasOwnProperty.call(LANGS, saved.src) || saved.src === 'auto') state.src = saved.src;
        if (Object.prototype.hasOwnProperty.call(LANGS, saved.tgt)) state.tgt = saved.tgt;
      }
      if (translation.rememberModels && saved.model) {
        Object.keys(MODEL_OPTIONS).forEach(function (group) {
          if (MODEL_OPTIONS[group].indexOf(saved.model[group]) >= 0) state.model[group] = saved.model[group];
        });
      }
    }
    shownTab = state.tab;
    if ($('src-lang').querySelector('option[value="' + state.src + '"]')) $('src-lang').value = state.src;
    if ($('tgt-lang').querySelector('option[value="' + state.tgt + '"]')) $('tgt-lang').value = state.tgt;
    document.querySelectorAll('.models button').forEach(function (button) {
      var group = button.parentElement.id.replace('model-', '');
      button.classList.toggle('on', state.model[group] === button.getAttribute('data-model'));
    });
    document.querySelectorAll('.tabs button[data-tab]').forEach(function (button) {
      var selected = button.getAttribute('data-tab') === state.tab;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('.pane[role="tabpanel"]').forEach(function (pane) {
      var selected = pane.id === 'pane-' + state.tab;
      pane.classList.toggle('on', selected);
      pane.inert = !selected;
      pane.setAttribute('aria-hidden', selected ? 'false' : 'true');
    });
    document.querySelectorAll('.dock').forEach(function (dock) {
      dock.classList.toggle('on', dock.getAttribute('data-pane') === state.tab);
    });
    refreshSelectButtons(false);
    positionThumbs(false);
  }

  function initDesktopSettings() {
    var modal = document.createElement('div');
    modal.className = 'it-set-mask';
    modal.setAttribute('aria-hidden', 'true');
    modal.inert = true;
    modal.innerHTML = `
      <div class="it-set" role="dialog" aria-modal="true" aria-label="设置" tabindex="-1">
        <div class="it-set-head"><b>设置</b><span id="it-set-status" role="status"></span>
          <button type="button" class="it-set-x" data-close="1" aria-label="关闭设置" title="关闭">×</button></div>
        <div class="it-set-layout">
          <nav class="it-set-nav" aria-label="设置类别">
            <span class="it-set-nav-thumb" aria-hidden="true"></span>
            <button type="button" class="on" data-pref-tab="appearance">外观</button>
            <button type="button" data-pref-tab="glass">液态玻璃</button>
            <button type="button" data-pref-tab="background">背景</button>
            <button type="button" data-pref-tab="reading">阅读与布局</button>
            <button type="button" data-pref-tab="motion">动效</button>
            <button type="button" data-pref-tab="translation">翻译偏好</button>
            <button type="button" data-pref-tab="updates">更新</button>
            <button type="button" data-pref-tab="desktop" data-desktop-only hidden>电脑功能</button>
          </nav>
          <div class="it-set-body">
            <section class="it-set-page" data-pref-section="appearance">
              <h2>外观</h2>
              <div class="it-pref-preview"><span class="it-pref-preview-label">实时预览</span>
                <div class="it-pref-preview-card"><span class="it-pref-preview-name">笺</span><span class="it-pref-preview-caption">原文 · 译文</span>
                  <b>清楚、舒适的阅读体验</b><i></i></div></div>
              <label class="it-set-row"><span>明暗主题</span><select id="it-pref-theme" data-pref="appearance.mode">
                <option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option>
              </select></label>
              <label class="it-set-row"><span>配色</span><select id="it-pref-palette" data-pref="appearance.palette">
                <option value="sakura">薄樱</option><option value="mist">雾蓝</option>
                <option value="sage">鼠尾草</option><option value="amber">暖杏</option>
              </select></label>
              <label class="it-set-row"><span>卡片圆角</span><select data-pref="appearance.radius">
                <option value="small">小</option><option value="standard">标准</option><option value="round">圆润</option>
              </select></label>
            </section>
            <section class="it-set-page" data-pref-section="glass" hidden>
              <h2>液态玻璃</h2>
              <div class="it-set-note">液态玻璃仅用于按钮与交互滑块；内容卡片和弹层使用静态磨砂，减少绘制开销。</div>
              <label class="it-set-row"><span>调整对象</span><select id="it-glass-target">
                <option value="card">磨砂面板</option><option value="pill">Tab 与模型滑块</option>
                <option value="button">按钮、底栏与下拉入口</option>
              </select></label>
              <div class="it-set-note" id="it-glass-preset-note"></div>
              <label class="it-set-range" data-glass-control="specularOpacity"><span>镜面高光 <output></output></span>
                <input type="range" min="0" max="100" step="1" data-pref-type="number"></label>
              <label class="it-set-range" data-glass-control="specularSaturation"><span>高光饱和度 <output></output></span>
                <input type="range" min="0" max="50" step="1" data-pref-type="number"></label>
              <label class="it-set-range" data-glass-control="refractionLevel"><span>折射强度 <output></output></span>
                <input type="range" min="0" max="100" step="1" data-pref-type="number"></label>
              <label class="it-set-range" data-glass-control="blurLevel"><span>基础模糊 <output></output></span>
                <input type="range" min="0" max="40" step="0.1" data-pref-type="number"></label>
              <label class="it-set-range" data-glass-control="progressiveBlurStrength"><span>渐进模糊 <output></output></span>
                <input type="range" min="0" max="10" step="0.01" data-pref-type="number"></label>
              <label class="it-set-range" data-glass-control="backgroundOpacity"><span>磨砂不透明度 <output></output></span>
                <input type="range" min="0" max="100" step="1" data-pref-type="number"></label>
            </section>
            <section class="it-set-page" data-pref-section="updates" hidden>
              <h2>更新</h2>
              <p class="it-set-note">当前版本 ${APP_VERSION} · 检查 GitHub 正式发布。</p>
              <label class="it-set-row"><span>启动时自动检查更新</span>
                <input type="checkbox" data-pref="updates.autoCheck"></label>
              <p class="it-set-note">自动检查每 24 小时最多一次，发现新版本后可前往发布页获取安装包。</p>
              <div class="it-set-actions"><button type="button" id="it-update-check">立即检查</button></div>
              <p class="it-set-note" id="it-update-status" role="status" aria-live="polite">尚未检查。</p>
              <a id="it-update-release" class="it-update-release" href="https://github.com/jiuxina/jian-translator/releases"
                target="_blank" rel="noopener noreferrer">查看发布页</a>
            </section>
            <section class="it-set-page" data-pref-section="reading" hidden>
              <h2>阅读与布局</h2>
              <label class="it-set-row"><span>字体类别</span><select data-pref="appearance.font">
                <option value="sans">系统无衬线</option><option value="serif">系统衬线</option><option value="mono">等宽</option>
              </select></label>
              <label class="it-set-row" id="it-pref-font-family-row" hidden><span>系统字体</span><select data-pref="appearance.systemFontFamily" id="it-pref-font-family">
                <option value="">与字体类别相同</option>
              </select></label>
              <div class="it-set-note" id="it-pref-font-status" hidden></div>
              <label class="it-set-range"><span>内容字号 <output data-pref-output="appearance.fontScale"></output></span>
                <input type="range" min="90" max="140" step="5" data-pref="appearance.fontScale" data-pref-type="number"></label>
              <label class="it-set-row"><span>字体粗细</span><select data-pref="appearance.fontWeight">
                <option value="300">300 · 纤细</option><option value="400">400 · 常规</option>
                <option value="500">500 · 中等</option><option value="600">600 · 半粗</option>
                <option value="700">700 · 粗体</option>
              </select></label>
              <div class="it-set-row it-set-color-row"><span>字体颜色</span>
                <select data-pref="appearance.fontColorMode" aria-label="字体颜色模式">
                  <option value="theme">跟随主题</option><option value="custom">自定义</option>
                </select>
                <input type="color" data-pref="appearance.fontColor" aria-label="自定义字体颜色">
              </div>
              <label class="it-set-row"><span>内容间距</span><select data-pref="appearance.layout">
                <option value="standard">标准</option><option value="compact">紧凑</option>
              </select></label>
            </section>
            <section class="it-set-page" data-pref-section="motion" hidden>
              <h2>动效</h2>
              <label class="it-set-row"><span>界面动画</span><select data-pref="appearance.motion">
                <option value="system">跟随系统</option><option value="reduced">减少</option><option value="off">关闭</option>
              </select></label>
              <label class="it-set-row"><span>环境柔光</span><input type="checkbox" class="it-set-check" data-pref="appearance.ambientLight" data-pref-type="boolean"></label>
              <div class="it-set-note">系统启用减少动态效果时，动画会立即关闭。</div>
            </section>
            <section class="it-set-page" data-pref-section="background" hidden>
              <h2>背景</h2>
              <div class="it-set-actions"><button type="button" class="ghost" id="it-pref-pick-background">选择背景图片</button>
                <button type="button" class="ghost" id="it-pref-reset-background">恢复默认背景</button></div>
              <div class="it-set-note" id="it-pref-background-status">背景图片仅保存在本机。</div>
              <label class="it-set-range"><span>背景淡化 <output data-pref-output="background.opacity"></output></span>
                <input type="range" min="0" max="80" step="2" data-pref="background.opacity" data-pref-type="number"></label>
              <label class="it-set-range"><span>背景模糊 <output data-pref-output="background.blur"></output></span>
                <input type="range" min="0" max="20" step="1" data-pref="background.blur" data-pref-type="number"></label>
              <label class="it-set-row"><span>图片显示</span><select data-pref="background.fit">
                <option value="cover">填满背景</option><option value="contain">完整显示</option>
              </select></label>
            </section>
            <section class="it-set-page" data-pref-section="translation" hidden>
              <h2>翻译偏好</h2>
              <label class="it-set-row"><span>默认打开页面</span><select data-pref="translation.defaultTab">
                <option value="text">文本</option><option value="syllable">音节</option>
                <option value="doc">长文</option><option value="last">上次页面</option>
              </select></label>
              <label class="it-set-row"><span>默认源语言</span><select id="it-pref-source" data-pref="translation.sourceLanguage"></select></label>
              <label class="it-set-row"><span>默认目标语言</span><select id="it-pref-target" data-pref="translation.targetLanguage"></select></label>
              <label class="it-set-row"><span>文本默认模型</span><select data-pref="translation.defaultModels.text">
                <option value="index-mt-2b">2B</option><option value="index-mt-9b">9B</option><option value="index-mt-35b">35B</option>
              </select></label>
              <label class="it-set-row"><span>音节默认模型</span><select data-pref="translation.defaultModels.syllable">
                <option value="index-mt-2b-syllable">2B</option><option value="index-mt-9b-syllable">9B</option>
              </select></label>
              <label class="it-set-row"><span>长文默认模型</span><select data-pref="translation.defaultModels.doc">
                <option value="index-nailong-2b">2B</option><option value="index-nailong-9b">9B</option>
              </select></label>
              <label class="it-set-row"><span>记住上次语言</span><input type="checkbox" class="it-set-check" data-pref="translation.rememberLanguages" data-pref-type="boolean"></label>
              <label class="it-set-row"><span>记住上次模型</span><input type="checkbox" class="it-set-check" data-pref="translation.rememberModels" data-pref-type="boolean"></label>
              <div class="it-set-note">关闭记忆后，下次启动使用这里设定的默认项。</div>
            </section>
            <section class="it-set-page" data-pref-section="desktop" hidden>
              <h2>电脑功能</h2>
              <label class="it-set-row"><span>划词翻译快捷键</span><input type="text" id="it-set-selection" readonly placeholder="点击后按组合键"></label>
              <label class="it-set-row"><span>显示 / 隐藏窗口</span><input type="text" id="it-set-activation" readonly placeholder="点击后按组合键"></label>
              <label class="it-set-row"><span>划词结果显示</span><select id="it-set-mode"><option value="popup">鼠标旁悬浮窗</option><option value="main">打开主窗口</option></select></label>
              <label class="it-set-row"><span>悬浮窗目标语言</span><select id="it-set-lang"><option value="auto">自动判断</option><option value="zh">中文</option><option value="en">英文</option></select></label>
              <label class="it-set-row"><span>开机自动启动</span><input type="checkbox" class="it-set-check" id="it-set-autostart"></label>
              <div class="it-set-note" id="it-set-autostart-status" role="status" aria-live="polite"></div>
              <div class="it-set-actions">
                <button type="button" class="ghost" id="it-set-autostart-current" hidden>设为当前版本</button>
                <button type="button" class="ghost" id="it-set-autostart-retry" hidden>重新读取自启动状态</button>
              </div>
              <label class="it-set-row"><span>启动后最小化到托盘</span><input type="checkbox" class="it-set-check" id="it-set-starttotray"></label>
              <div class="it-set-note" id="it-set-autostart-help">启动到托盘设置下次启动时生效。</div>
              <div id="it-popup-settings">
                <div class="it-set-divider"></div>
                <h3>划词悬浮窗</h3>
                <div class="it-popup-preview-scene" id="it-popup-preview-scene" aria-label="悬浮窗卡片预览">
                  <div class="it-popup-preview-frame">
                    <div class="it-popup-preview-image" aria-hidden="true"></div>
                    <div class="it-popup-preview-card">
                      <b>原文 · 译文</b><span>清晰、舒适的阅读体验</span>
                    </div>
                  </div>
                </div>
                <div class="it-set-actions"><button type="button" class="ghost" id="it-popup-pick-background">选择悬浮窗背景</button>
                  <button type="button" class="ghost" id="it-popup-follow-background">跟随主窗口背景</button></div>
                <div class="it-set-note" id="it-popup-background-status">悬浮窗跟随主窗口背景。</div>
              </div>
            </section>
          </div>
        </div>
        <div class="it-set-foot"><button type="button" class="ghost" data-reset-section>恢复本组默认</button>
          <span class="sp"></span><button type="button" class="ghost" id="it-set-retry" hidden>重试保存</button></div>
      </div>`;
    document.body.appendChild(modal);
    setupLiquidGlassSurfaces(modal);

    var recording = null;
    var dialog = modal.querySelector('.it-set');
    var fontFamilyRow = $('it-pref-font-family-row');
    var fontFamilySelect = $('it-pref-font-family');
    var fontStatus = $('it-pref-font-status');
    var popupPreviewScene = $('it-popup-preview-scene');
    var popupPreviewImage = popupPreviewScene && popupPreviewScene.querySelector('.it-popup-preview-image');
    var settingsOrigin = null;
    var returnFocus = null;
    var backgroundState = [];
    var settingsSeq = 0;
    var backgroundPickSeq = 0;
    var popupBackgroundPickSeq = 0;
    var systemFonts = [];
    var systemFontsReady = false;
    var settingsLoaded = false;
    var autostartStatus = null;
    var autostartError = '';
    var autostartBusy = false;
    var autostartSequence = 0;
    var autostartPending = null;
    var popupPreviewData = null;
    var settingsSaving = false;
    var settingsDirty = false;
    var persistenceTimer = 0;
    var persistenceRevision = 0;
    var persistenceFailure = '';
    var persistedSettingsJson = '';
    var settingsOpening = null;
    var glassTarget = 'card';
    var activeSection = 'appearance';
    var shownSection = 'appearance';
    var sectionIntent = 'appearance';
    var sectionTransitionTarget = '';
    var sectionPaintTarget = '';
    var sectionTransitionFrom = '';
    var sectionTransitionSources = [];
    var sectionTransitionPhase = '';
    var sectionTransitionSeq = 0;
    var sectionTransitionTimer = 0;
    var sectionTransitionFrame = 0;
    var sectionPreparation = null;
    var stagedSections = new WeakMap();
    var preferencePreviewFrame = 0;
    var preferencePreviewPending = false;
    var preferencePreviewSequence = 0;
    var updateChecking = false;
    var updateMessage = '尚未检查。';
    var updateError = false;
    var updateLink = window.ItUpdates.releases;
    var updateLinkText = '查看发布页';
    var automaticUpdateTimer = 0;

    function renderUpdateStatus() {
      var button = $('it-update-check');
      button.disabled = updateChecking || (Bridge.isDesktop && !settingsLoaded);
      button.textContent = updateChecking ? '检查中…' : '立即检查';
      var status = $('it-update-status');
      status.textContent = updateMessage;
      status.classList.toggle('it-update-error', updateError);
      var link = $('it-update-release');
      link.href = updateLink;
      link.textContent = updateLinkText;
      if (Bridge.isAndroid) link.target = '_self';
    }

    function checkUpdates(automatic) {
      if (updateChecking) return;
      updateChecking = true;
      updateError = false;
      updateMessage = '正在检查正式发布…';
      renderUpdateStatus();
      try { localStorage.setItem('it-update-last-check', String(Date.now())); } catch (error) {}
      window.ItUpdates.checkLatest(APP_VERSION).then(function (result) {
        updateLink = result.url;
        updateLinkText = result.status === 'available' ? '获取 ' + result.version : '查看发布页';
        updateMessage = result.status === 'available' ? '发现新版本 ' + result.version + '。' :
          result.status === 'unpublished' ? '仓库暂未发布正式版本，可稍后重试。' :
            '当前已是最新版本（' + APP_VERSION + '）。';
        if (automatic && result.status === 'available') {
          toast('发现新版本 ' + result.version + '，可在设置 → 更新中查看。');
        }
      }).catch(function (error) {
        updateError = true;
        updateMessage = '检查失败：' + (error.message || String(error));
      }).then(function () {
        updateChecking = false;
        renderUpdateStatus();
      });
    }
    on($('it-update-check'), 'click', function () { checkUpdates(false); });
    scheduleAppUpdateCheck = function () {
      clearTimeout(automaticUpdateTimer);
      var previous = 0;
      try { previous = localStorage.getItem('it-update-last-check'); } catch (error) {}
      if (!window.ItUpdates.shouldAutoCheck(activePreferences.updates.autoCheck, previous, Date.now())) return;
      automaticUpdateTimer = setTimeout(function () {
        if (activePreferences.updates.autoCheck) checkUpdates(true);
      }, 1200);
    };

    modal.querySelectorAll('[data-pref-tab="desktop"]').forEach(function (tab) {
      tab.hidden = !Bridge.isDesktop;
    });
    if (fontFamilyRow) fontFamilyRow.hidden = !Bridge.isDesktop;
    var popupSettings = modal.querySelector('#it-popup-settings');
    if (popupSettings) popupSettings.hidden = !Bridge.isDesktop;
    var langOptions = '<option value="auto">自动检测</option>';
    Object.keys(LANGS).forEach(function (code) {
      langOptions += '<option value="' + code + '">' + langName(code) + '</option>';
    });
    $('it-pref-source').innerHTML = langOptions;
    $('it-pref-target').innerHTML = langOptions.replace('<option value="auto">自动检测</option>', '');
    modal.querySelectorAll('select').forEach(enhanceSelect);

    function updateGlassControls() {
      var preset = glassTarget === 'card' ? { backgroundOpacity: DEFAULT_PREFERENCES.liquidGlass.card.backgroundOpacity } :
        DEFAULT_PREFERENCES.liquidGlass[glassTarget];
      $('it-glass-target').value = glassTarget;
      $('it-glass-preset-note').textContent = glassTarget === 'card' ?
        '原文、译文、弹层与悬浮窗使用静态磨砂，仅调整面板不透明度。' : glassTarget === 'pill' ?
          'Tab 保持透明玻璃，模型与设置导航滑块始终呈现液态玻璃；静止、按住与拖动时材质不变。' :
          '透明液态玻璃用于按钮、底部导航轨道与下拉入口。';
      modal.querySelectorAll('[data-glass-control]').forEach(function (row) {
        var key = row.getAttribute('data-glass-control');
        var control = row.querySelector('input');
        var output = row.querySelector('output');
        row.hidden = !Object.prototype.hasOwnProperty.call(preset, key);
        if (row.hidden) {
          control.removeAttribute('data-pref');
          output.removeAttribute('data-pref-output');
          output.textContent = '';
        } else {
          var path = 'liquidGlass.' + glassTarget + '.' + key;
          control.setAttribute('data-pref', path);
          output.setAttribute('data-pref-output', path);
        }
      });
    }
    on($('it-glass-target'), 'change', function () {
      flushPreferencePreview();
      glassTarget = enumValue(this.value, ['card', 'pill', 'button'], 'card');
      fill();
    });
    updateGlassControls();

    function populateSystemFonts(fonts) {
      if (!fontFamilySelect) return;
      fontFamilySelect.innerHTML = '<option value="">与字体类别相同</option>';
      systemFonts = Array.from(new Set((Array.isArray(fonts) ? fonts : []).filter(function (font) {
        return typeof font === 'string' && font.trim();
      }))).sort(function (left, right) { return left.localeCompare(right); });
      systemFonts.forEach(function (font) {
        var option = document.createElement('option');
        option.value = font;
        option.textContent = font;
        fontFamilySelect.appendChild(option);
      });
      if (fontFamilySelect.__itRefreshDropdown) fontFamilySelect.__itRefreshDropdown();
    }

    function updatePopupPreview() {
      if (!popupPreviewScene || !settingsState) return;
      var preferences = settingsState.preferences;
      var dark = resolvedAppearance(preferences) === 'dark';
      var image = preferences.popup.backgroundData || preferences.background.data;
      if (image !== popupPreviewData) {
        popupPreviewImage.style.setProperty('--it-popup-preview-image', image ? 'url("' + image + '")' : 'none');
        popupPreviewData = image;
      }
      var overlayAlpha = Math.max(0, Math.min(80, preferences.background.opacity)) / 100;
      var popupCard = popupPreviewScene.querySelector('.it-popup-preview-card');
      setPreferenceStyle(popupPreviewScene, '--it-popup-preview-overlay',
        dark ? 'rgba(18,16,24,' + overlayAlpha + ')' : 'rgba(255,255,255,' + overlayAlpha + ')');
      setPreferenceStyle(popupPreviewScene, '--it-popup-preview-fit', preferences.background.fit);
      setPreferenceStyle(popupPreviewScene, '--it-popup-preview-blur', preferences.background.blur + 'px');
      setPreferenceStyle(popupPreviewScene, '--it-popup-preview-inset',
        (preferences.background.fit === 'contain' ? 0 : -2 * preferences.background.blur) + 'px');
      setPreferenceStyle(popupCard, '--it-liquid-fill',
        colorRgba(dark ? '#302C38' : '#FFFFFF', preferences.liquidGlass.card.backgroundOpacity / 100));
    }

    function updateSettingsNavigation(animate) {
      var nav = modal.querySelector('.it-set-nav');
      var thumb = nav && nav.querySelector('.it-set-nav-thumb');
      var visualSection = sectionTransitionPhase === 'handoff' ? sectionPaintTarget : shownSection;
      var activeTab = nav && nav.querySelector('[data-pref-tab="' + visualSection + '"]');
      modal.querySelectorAll('[data-pref-tab]').forEach(function (tab) {
        var selected = tab.getAttribute('data-pref-tab') === visualSection;
        tab.classList.toggle('on', selected);
        tab.setAttribute('aria-current', selected ? 'page' : 'false');
      });
      if (!thumb || !activeTab || !activeTab.offsetWidth) return;
      if (!animate) thumb.style.transition = 'none';
      thumb.style.width = activeTab.offsetWidth + 'px';
      thumb.style.height = activeTab.offsetHeight + 'px';
      thumb.style.transform = 'translate3d(' + activeTab.offsetLeft + 'px,' + activeTab.offsetTop + 'px,0)';
      thumb.classList.add('ready');
      if (!animate) {
        void thumb.offsetWidth;
        thumb.style.transition = '';
      }
    }

    function setSettingsSection(section) {
      stopMotionGroup('settings-page');
      var current = modal.querySelector('[data-pref-section="' + shownSection + '"]');
      if (current && current.contains(document.activeElement)) {
        var nextTab = modal.querySelector('[data-pref-tab="' + section + '"]');
        if (nextTab) nextTab.focus({ preventScroll: true });
      }
      modal.querySelectorAll('[data-pref-section]').forEach(function (page) {
        stopMotion(page);
        page.style.removeProperty('--it-settings-page-reveal');
        page.style.removeProperty('z-index');
        page.style.removeProperty('transform');
        var selected = page.getAttribute('data-pref-section') === section;
        page.hidden = !selected;
        page.inert = !selected;
        page.setAttribute('aria-hidden', selected ? 'false' : 'true');
        page.classList.remove('is-leaving', 'is-entering', 'is-entered');
        page.classList.remove('it-glass-section-preparing');
      });
      shownSection = section;
      activeSection = section;
      sectionIntent = section;
      sectionTransitionTarget = '';
      sectionPaintTarget = '';
      sectionTransitionFrom = '';
      sectionTransitionSources = [];
      sectionTransitionPhase = '';
      var reset = modal.querySelector('[data-reset-section]');
      if (reset) reset.disabled = !settingsLoaded;
      var body = modal.querySelector('.it-set-body');
      if (body) body.removeAttribute('aria-busy');
    }

    function cancelSettingsSectionTransition(section) {
      if (sectionPreparation) sectionPreparation.abort();
      sectionPreparation = null;
      clearTimeout(sectionTransitionTimer);
      sectionTransitionTimer = 0;
      if (sectionTransitionFrame) cancelAnimationFrame(sectionTransitionFrame);
      sectionTransitionFrame = 0;
      sectionTransitionSeq++;
      setSettingsSection(section || sectionTransitionTarget || shownSection);
    }

    function freezeSettingsSectionHandoff() {
      modal.querySelectorAll('[data-pref-section]:not([hidden])').forEach(function (page) {
        var style = getComputedStyle(page);
        var reveal = parseFloat(style.getPropertyValue('--it-settings-page-reveal'));
        if (!Number.isFinite(reveal)) reveal = 1;
        var transform = style.transform;
        // Freeze the exact sampled paint before canceling the WAAPI transform
        // and CSS custom-property transition for the dialog's own exit.
        page.style.transition = 'none';
        page.style.setProperty('--it-settings-page-reveal', String(reveal));
        page.style.transform = transform;
        void page.offsetWidth;
        stopMotion(page);
        page.style.transition = '';
      });
    }

    function revealPreparedSettingsSection(section) {
      var target = modal.querySelector('[data-pref-section="' + section + '"]');
      if (!target || !modal.classList.contains('on')) return;
      if (sectionPreparation) {
        sectionPreparation.abort();
        sectionPreparation = null;
      }
      var controller = new AbortController();
      // A display:none section cannot be measured. Stage it over its normal
      // content box, fully hidden and inert, until its exact maps are decoded.
      var staging = target.hidden;
      if (staging) target.classList.add('it-glass-section-preparing');
      var owners = stagedSections.get(target) || new Set();
      var owner = {};
      owners.add(owner);
      stagedSections.set(target, owners);
      function cleanup() {
        owners.delete(owner);
        if (owners.size) return;
        stagedSections.delete(target);
        target.classList.remove('it-glass-section-preparing');
      }
      var preparation = preparePageGlass(target, controller.signal);
      function ready() {
        cleanup();
        if (controller.signal.aborted || section !== sectionIntent ||
            !modal.classList.contains('on')) return;
        if (sectionPreparation === controller) sectionPreparation = null;
        if (!window.ItLiquidGlass.isReady(target)) {
          revealPreparedSettingsSection(section);
          return;
        }
        if (sectionTransitionPhase === 'handoff') {
          if (sectionPaintTarget !== section) startSettingsSectionHandoff(section, sectionPaintTarget);
        } else {
          startSettingsSectionHandoff(section);
        }
      }
      if (!preparation) { ready(); return; }
      sectionPreparation = controller;
      if (sectionTransitionPhase !== 'handoff') {
        sectionTransitionTarget = section;
        sectionTransitionPhase = 'prepare';
      }
      preparation.then(ready).catch(function (error) {
        cleanup();
        if (error.name !== 'AbortError' && sectionPreparation === controller) {
          sectionPreparation = null;
          var wasHandoff = sectionTransitionPhase === 'handoff';
          var stableSection = wasHandoff ? sectionPaintTarget : shownSection;
          sectionIntent = stableSection;
          sectionTransitionTarget = wasHandoff ? sectionPaintTarget : '';
          if (!wasHandoff) sectionTransitionPhase = '';
          modal.querySelectorAll('[data-pref-section]').forEach(function (page) {
            var painted = page.getAttribute('data-pref-section') === stableSection;
            if (!wasHandoff) {
              page.hidden = !painted;
              page.inert = !painted;
            }
            page.setAttribute('aria-hidden', painted ? 'false' : 'true');
          });
          var body = modal.querySelector('.it-set-body');
          var reset = modal.querySelector('[data-reset-section]');
          if (!wasHandoff && body) body.removeAttribute('aria-busy');
          if (!wasHandoff && reset) reset.disabled = !settingsLoaded;
          activeSection = stableSection;
          updateSettingsNavigation(false);
          toast('玻璃效果准备失败，请重试', true);
        }
      });
    }

    function finishSettingsSectionHandoff(section, previous, sequence) {
      if (sequence !== sectionTransitionSeq || sectionTransitionPhase !== 'handoff' ||
          sectionPaintTarget !== section ||
          !modal.classList.contains('on')) return;
      var target = modal.querySelector('[data-pref-section="' + section + '"]');
      var leaving = modal.querySelector('[data-pref-section="' + previous + '"]');
      if (!target || !leaving) return;
      if (!window.ItLiquidGlass.isReady(target)) {
        var latest = sectionIntent;
        if (sectionPreparation) sectionPreparation.abort();
        sectionPreparation = null;
        setSettingsSection(previous);
        if (latest !== previous) {
          sectionIntent = latest;
          sectionTransitionTarget = latest;
          revealPreparedSettingsSection(latest);
        }
        return;
      }
      sectionTransitionSources.forEach(function (source) {
        stopMotion(source.page);
        source.page.hidden = true;
        source.page.inert = true;
        source.page.setAttribute('aria-hidden', 'true');
        source.page.classList.remove('is-leaving', 'is-entering', 'is-entered');
        source.page.style.removeProperty('z-index');
        source.page.style.removeProperty('--it-settings-page-reveal');
      });
      stopMotion(target);
      target.hidden = false;
      target.inert = false;
      target.setAttribute('aria-hidden', 'false');
      target.classList.remove('is-leaving', 'is-entering', 'is-entered');
      target.style.removeProperty('z-index');
      target.style.removeProperty('--it-settings-page-reveal');
      shownSection = activeSection = section;
      var body = modal.querySelector('.it-set-body');
      var reset = modal.querySelector('[data-reset-section]');
      if (body) body.removeAttribute('aria-busy');
      if (reset) reset.disabled = !settingsLoaded;
      sectionTransitionSources = [];
      sectionPaintTarget = '';
      sectionTransitionFrom = '';
      if (sectionIntent !== shownSection) {
        sectionTransitionTarget = sectionIntent;
        sectionTransitionPhase = sectionPreparation ? 'prepare' : '';
        activeSection = shownSection;
        updateSettingsNavigation(false);
        if (!sectionPreparation) revealPreparedSettingsSection(sectionIntent);
      } else {
        sectionTransitionTarget = '';
        sectionTransitionPhase = '';
      }
    }

    function startSettingsSectionHandoff(section, previousOverride) {
      var target = modal.querySelector('[data-pref-section="' + section + '"]');
      if (!target || (!previousOverride && section === shownSection) ||
          !window.ItLiquidGlass.isReady(target)) return;
      var previous = previousOverride || shownSection;
      var pages = Array.prototype.slice.call(modal.querySelectorAll('[data-pref-section]'));
      var sourcePages = pages.filter(function (page) { return page !== target && !page.hidden; });
      if (!sourcePages.length) {
        var current = modal.querySelector('[data-pref-section="' + previous + '"]');
        if (current && current !== target && !current.hidden) sourcePages = [current];
      }
      if (!sourcePages.length) { setSettingsSection(section); return; }
      // Read every painted contribution before canceling any WAAPI track so a
      // retarget can continue the existing composite instead of snapping it.
      var sources = sourcePages.map(function (page) {
        var style = getComputedStyle(page);
        var reveal = parseFloat(style.getPropertyValue('--it-settings-page-reveal'));
        return { page: page, reveal: Number.isFinite(reveal) ? reveal : 1, transform: style.transform };
      });
      var targetAlreadyPainted = !target.hidden && sectionTransitionPhase === 'handoff';
      var targetStyle = targetAlreadyPainted ? getComputedStyle(target) : null;
      var targetReveal = targetStyle ?
        parseFloat(targetStyle.getPropertyValue('--it-settings-page-reveal')) : 0;
      if (!Number.isFinite(targetReveal)) targetReveal = 0;
      if (sectionPreparation) {
        sectionPreparation.abort();
        sectionPreparation = null;
      }
      closeSelect();
      flushPreferencePreview();
      var leaving = modal.querySelector('[data-pref-section="' + previous + '"]') || sources[0].page;
      if (recording && leaving.contains(recording.input)) {
        stopRecord();
        fill();
      }
      if (document.activeElement && leaving.contains(document.activeElement)) {
        var tab = modal.querySelector('[data-pref-tab="' + section + '"]');
        if (tab) tab.focus({ preventScroll: true });
      }
      var duration = motionReduced() ? 0 : cssDuration('--it-settings-switch-duration', 140);
      if (duration <= 0) { setSettingsSection(section); return; }
      stopMotionGroup('settings-page');
      var sequence = ++sectionTransitionSeq;
      sectionTransitionTarget = section;
      sectionPaintTarget = section;
      sectionTransitionFrom = previous;
      sectionTransitionPhase = 'handoff';
      activeSection = section;
      updateSettingsNavigation(true);
      var body = modal.querySelector('.it-set-body');
      var reset = modal.querySelector('[data-reset-section]');
      if (body) body.setAttribute('aria-busy', 'true');
      if (reset) reset.disabled = true;
      sectionTransitionSources = sources;
      sources.forEach(function (source, index) {
        source.page.inert = true;
        source.page.setAttribute('aria-hidden', 'true');
        source.page.classList.remove('is-entering', 'is-entered', 'is-leaving');
        source.page.classList.add('is-leaving');
        source.page.style.zIndex = String(index + 1);
      });
      target.hidden = false;
      target.inert = true;
      target.setAttribute('aria-hidden', 'true');
      target.classList.remove('is-leaving', 'is-entered');
      target.classList.add('is-entering');
      if (!targetStyle) targetStyle = getComputedStyle(target);
      target.style.zIndex = String(sources.length + 1);
      // Both pages share the final scroll viewport, so their glass maps remain
      // exact while the two real pages cross-fade over one another.
      sources.forEach(function (source) {
        fadeSettingsSection(source.page, source.reveal, 0, source.transform, duration);
      });
      target.classList.add('is-entered');
      fadeSettingsSection(target, targetReveal, 1,
        targetStyle.transform, duration, function () {
          finishSettingsSectionHandoff(section, previous, sequence);
        });
    }

    settleSettingsSection = function () {
      if (!modal.classList.contains('on') || sectionTransitionPhase === 'closing') return;
      if (sectionTransitionPhase === 'handoff' && sectionPaintTarget) {
        finishSettingsSectionHandoff(sectionPaintTarget, sectionTransitionFrom, sectionTransitionSeq);
      } else if (sectionIntent !== shownSection && !sectionPreparation) {
        revealPreparedSettingsSection(sectionIntent);
      }
      updateSettingsNavigation(false);
    };

    function fadeSettingsSection(page, from, to, transform, duration, done) {
      var property = '--it-settings-page-reveal';
      if (!Number.isFinite(from)) from = 1 - to;
      page.style.setProperty(property, String(from));
      if (settingsRevealProperty) {
        void getComputedStyle(page).getPropertyValue(property);
        page.style.setProperty(property, String(to));
      }
      playMotion(page, [{ transform: transform }, {
        transform: to ? 'translateY(0)' : 'translateY(-4px)'
      }], duration, function () {
        page.style.removeProperty(property);
        if (done) done();
      }, 'settings-page', false,
      getComputedStyle(document.documentElement).getPropertyValue('--lg-ease-enter').trim() || SCENE_EASE);
      if (!settingsRevealProperty) followSettingsReveal(page, property, from, to);
    }

    function switchSettingsSection(section) {
      var target = modal.querySelector('[data-pref-section="' + section + '"]');
      if (!target || section === sectionIntent) return;
      sectionIntent = section;
      flushPreferencePreview();
      closeSelect();
      var duration = motionReduced() ? 0 : cssDuration('--it-settings-switch-duration', 140);
      if (!modal.classList.contains('on')) {
        setSettingsSection(section);
        return;
      }
      if (sectionPreparation) {
        sectionPreparation.abort();
        sectionPreparation = null;
      }
      if (sectionTransitionPhase === 'handoff') {
        if (section === sectionPaintTarget) {
          sectionTransitionTarget = section;
          sectionIntent = section;
          activeSection = section;
          updateSettingsNavigation(false);
          return;
        }
        if (section === sectionTransitionFrom) {
          sectionTransitionTarget = section;
          sectionIntent = section;
          activeSection = section;
          startSettingsSectionHandoff(section, sectionPaintTarget);
          return;
        }
        sectionTransitionTarget = section;
        revealPreparedSettingsSection(section);
        return;
      }
      if (section === shownSection) {
        sectionTransitionTarget = '';
        sectionTransitionPhase = '';
        activeSection = shownSection;
        updateSettingsNavigation(false);
        return;
      }
      updateSettingsNavigation(false);
      revealPreparedSettingsSection(section);
    }

    function updatePreferenceControl(control) {
      var value = valueAtPath(settingsState.preferences, control.getAttribute('data-pref'));
      if (control.type === 'checkbox') {
        if (control.checked !== !!value) control.checked = !!value;
      } else {
        var text = value == null ? '' : String(value);
        if (control.value !== text) control.value = text;
      }
      if (control.type === 'range') {
        var span = Number(control.max) - Number(control.min);
        setPreferenceStyle(control, '--it-range-fill', span > 0 ?
          (100 * (Number(control.value) - Number(control.min)) / span) + '%' : '0%');
      }
    }

    function updatePreferenceOutput(output) {
      var path = output.getAttribute('data-pref-output');
      var value = valueAtPath(settingsState.preferences, path);
      var suffix = path === 'background.blur' || /\.blurLevel$/.test(path) ? ' px' :
        /\.(specularSaturation|progressiveBlurStrength)$/.test(path) ? '' : '%';
      var text = value + suffix;
      if (output.textContent !== text) output.textContent = text;
    }

    function cancelPreferencePreview() {
      preferencePreviewSequence++;
      if (preferencePreviewFrame) cancelAnimationFrame(preferencePreviewFrame);
      preferencePreviewFrame = 0;
      preferencePreviewPending = false;
    }

    function flushPreferencePreview() {
      if (preferencePreviewFrame) cancelAnimationFrame(preferencePreviewFrame);
      preferencePreviewFrame = 0;
      if (!preferencePreviewPending) return;
      preferencePreviewPending = false;
      preferencePreviewSequence++;
      applyPreferences(settingsState.preferences);
      updatePopupPreview();
    }

    function schedulePreferencePreview() {
      preferencePreviewPending = true;
      if (preferencePreviewFrame) return;
      var session = settingsSeq;
      var sequence = ++preferencePreviewSequence;
      preferencePreviewFrame = requestAnimationFrame(function () {
        if (sequence !== preferencePreviewSequence) return;
        preferencePreviewFrame = 0;
        if (session !== settingsSeq || !modal.classList.contains('on')) {
          preferencePreviewPending = false;
          return;
        }
        flushPreferencePreview();
      });
    }

    function renderPersistenceStatus() {
      $('it-set-retry').hidden = !persistenceFailure;
      if (persistenceFailure) {
        $('it-set-status').textContent = '更改已应用，尚未保存';
      } else if (settingsLoaded) {
        $('it-set-status').textContent = '';
      }
    }

    function renderAutostartStatus() {
      var checkbox = $('it-set-autostart');
      var status = $('it-set-autostart-status');
      var switchButton = $('it-set-autostart-current');
      var retryButton = $('it-set-autostart-retry');
      var help = $('it-set-autostart-help');
      if (!checkbox || !status || !switchButton || !retryButton || !settingsState) return;
      if (!Bridge.isDesktop || Bridge.isMac) {
        checkbox.checked = !!settingsState.auto_start;
        checkbox.indeterminate = false;
        status.textContent = Bridge.isMac ? '由 macOS 登录项管理。' : '';
        status.classList.remove('warn');
        switchButton.hidden = true;
        retryButton.hidden = true;
        if (help) help.textContent = '启动到托盘设置下次启动时生效。';
        return;
      }
      if (help) help.textContent = '各版本共用一个自启动开关；关闭会停用全局自启动。' +
        '切换版本前，请从托盘退出已运行的版本，再打开目标版本并选择“设为当前版本”。' +
        '移动或重命名文件后需重新设置目标。启动到托盘设置下次启动时生效。';
      checkbox.checked = !!(autostartStatus && autostartStatus.enabled);
      checkbox.indeterminate = !autostartStatus;
      checkbox.disabled = !settingsLoaded || autostartBusy || !autostartStatus;
      switchButton.disabled = checkbox.disabled;
      switchButton.hidden = !autostartStatus || !autostartStatus.enabled ||
        (autostartStatus.target_is_current && autostartStatus.target_exists);
      retryButton.hidden = !autostartError;
      retryButton.disabled = !settingsLoaded || autostartBusy;
      var message;
      if (!autostartStatus) {
        message = autostartBusy ? '正在读取自启动状态…' : '自启动状态未知。';
      } else if (!autostartStatus.enabled) {
        message = '当前未启用开机自启动。';
      } else if (!autostartStatus.target_path) {
        message = '自启动已登记，但目标格式无效，请设为当前版本。';
      } else if (!autostartStatus.target_exists) {
        message = '启动目标不存在：' + autostartStatus.target_path;
      } else if (!autostartStatus.target_is_current) {
        message = '当前目标：' + autostartStatus.target_path + '（其他版本或位置）';
      } else {
        message = '当前目标：' + autostartStatus.target_path + '（当前版本）';
      }
      status.textContent = autostartError ? autostartError + '；' + message : message;
      status.classList.toggle('warn', !!autostartError || !!(autostartStatus && autostartStatus.enabled &&
        (!autostartStatus.target_exists || !autostartStatus.target_is_current)));
    }

    function validateAutostartStatus(status) {
      if (!status || typeof status.enabled !== 'boolean' ||
          !(status.target_path === null || typeof status.target_path === 'string') ||
          typeof status.target_exists !== 'boolean' || typeof status.target_is_current !== 'boolean') {
        throw new Error('未能读取有效的自启动状态');
      }
      return status;
    }

    function requestAutostartStatus(enabled) {
      if (!Bridge.isDesktop || Bridge.isMac) return Promise.resolve();
      var writing = typeof enabled === 'boolean';
      if (writing && (autostartBusy || !autostartStatus || !settingsLoaded)) {
        renderAutostartStatus();
        return Promise.resolve();
      }
      var sequence = ++autostartSequence;
      var session = settingsSeq;
      function isCurrent() { return sequence === autostartSequence && session === settingsSeq; }
      if (!writing) autostartStatus = null;
      autostartError = '';
      autostartBusy = true;
      renderAutostartStatus();
      // Reopening queues its read behind the previous session's write. Only
      // the newest visible session may publish the resulting status.
      var operation = (autostartPending || Promise.resolve()).then(function () {
        if (!writing && !isCurrent()) return null;
        return Bridge.invoke(writing ? 'it_set_autostart' : 'it_get_autostart_status',
          writing ? { enabled: enabled } : undefined);
      }).then(function (result) {
        if (!isCurrent()) return;
        var status = validateAutostartStatus(result);
        if (writing && (status.enabled !== enabled || (enabled &&
            (!status.target_is_current || !status.target_exists)))) {
          throw new Error('系统登记结果与本次操作不一致');
        }
        autostartStatus = status;
        if (writing) toast(enabled ? '已将当前版本设为自启动目标' : '已关闭全局自启动');
      }).catch(function (error) {
        if (!isCurrent()) return;
        autostartError = (writing ? '自启动设置失败：' : '自启动读取失败：') +
          (error.message || String(error));
        autostartStatus = null;
        if (!writing) return;
        toast(autostartError, true);
        // A write can succeed before its verification fails. Re-read instead
        // of restoring a cached checkbox that may no longer match Windows.
        return Promise.resolve().then(function () {
          return Bridge.invoke('it_get_autostart_status');
        }).then(function (status) {
          if (isCurrent()) autostartStatus = validateAutostartStatus(status);
        }).catch(function (readError) {
          if (!isCurrent()) return;
          autostartStatus = null;
          autostartError += '；状态读取失败：' + (readError.message || String(readError));
        });
      }).then(function () {
        if (autostartPending === operation) autostartPending = null;
        if (!isCurrent()) return;
        autostartBusy = false;
        renderAutostartStatus();
      });
      autostartPending = operation;
      return operation;
    }

    function settingsPersistenceSnapshot() {
      var submission = copyObject(settingsState);
      if (Bridge.isDesktop && !Bridge.isMac) delete submission.auto_start;
      return submission;
    }

    function queueSettingsPersistence(immediate) {
      if (!settingsState) return;
      settingsDirty = true;
      persistenceRevision++;
      clearTimeout(persistenceTimer);
      persistenceTimer = 0;
      if (immediate) persistSettings();
      else persistenceTimer = setTimeout(function () {
        persistenceTimer = 0;
        persistSettings();
      }, 200);
    }

    function persistSettings() {
      if (settingsSaving || !settingsDirty || !settingsState) return;
      flushPreferencePreview();
      var submission = settingsPersistenceSnapshot();
      var revision = persistenceRevision;
      var serialized = JSON.stringify(submission);
      if (serialized === persistedSettingsJson && !persistenceFailure) {
        settingsDirty = false;
        return;
      }
      settingsDirty = false;
      settingsSaving = true;
      function finish(error) {
        settingsSaving = false;
        if (error) {
          settingsDirty = true;
          persistenceFailure = error.message || String(error);
          toast('设置已应用，保存失败：' + persistenceFailure, true);
        } else {
          persistedSettingsJson = serialized;
          committedSettings = copyObject(submission);
          persistenceFailure = '';
          if (scheduleAppUpdateCheck) scheduleAppUpdateCheck();
        }
        renderPersistenceStatus();
        // Only the latest queued snapshot can follow this write. A failed
        // snapshot is retried by the user or a later edit, never in a loop.
        if (settingsDirty && !persistenceTimer &&
            (!error || revision !== persistenceRevision)) persistSettings();
      }
      function cacheSubmission() {
        try {
          // A newer edit remains the live source of truth while an older
          // desktop write completes. Never copy old values back into the UI.
          if (revision === persistenceRevision || serialized === JSON.stringify(settingsPersistenceSnapshot())) {
            localStorage.setItem(PREFERENCES_KEY, JSON.stringify(submission.preferences));
          }
          if (Bridge.isAndroid && window.NativeBridge &&
              typeof window.NativeBridge.commitAppearance === 'function' &&
              !window.NativeBridge.commitAppearance(nativeAppearanceSnapshot(submission.preferences))) {
            throw new Error('原生外观缓存未能更新');
          }
          finish();
        } catch (error) { finish(error); }
      }
      if (!Bridge.isDesktop) { cacheSubmission(); return; }
      Bridge.invoke('it_save_settings', { settings: submission }).then(function (errors) {
        if (errors && errors.length) { finish(new Error(errors.join('；'))); return; }
        cacheSubmission();
      }).catch(finish);
    }
    on($('it-set-retry'), 'click', function () { queueSettingsPersistence(true); });

    function fill() {
      if (!settingsState) return;
      updateGlassControls();
      modal.querySelectorAll('[data-pref]').forEach(updatePreferenceControl);
      modal.querySelectorAll('[data-pref-output]').forEach(updatePreferenceOutput);
      $('it-set-selection').value = settingsState.selection_shortcut || '';
      $('it-set-activation').value = settingsState.activation_shortcut || '未设置';
      $('it-set-mode').value = settingsState.open_main_window ? 'main' : 'popup';
      $('it-set-lang').value = settingsState.target_lang || 'auto';
      $('it-set-autostart').checked = !!settingsState.auto_start;
      $('it-set-starttotray').checked = settingsState.start_to_tray !== false;
      renderAutostartStatus();
      $('it-pref-background-status').textContent = settingsState.preferences.background.data ?
        '已选择背景图片。' : '未选择背景图片。';
      if (fontFamilySelect) {
        var selectedFamily = settingsState.preferences.appearance.systemFontFamily;
        var hasSelectedFamily = Array.prototype.some.call(fontFamilySelect.options, function (option) {
          return option.value === selectedFamily;
        });
        if (selectedFamily && !hasSelectedFamily && !systemFonts.some(function (font) { return font === selectedFamily; })) {
          var unavailable = document.createElement('option');
          unavailable.value = selectedFamily;
          unavailable.textContent = '不可用：' + selectedFamily;
          unavailable.disabled = true;
          fontFamilySelect.appendChild(unavailable);
          if (fontFamilySelect.__itRefreshDropdown) fontFamilySelect.__itRefreshDropdown();
        }
        fontFamilySelect.value = selectedFamily;
        if (fontStatus) {
          fontStatus.hidden = !Bridge.isDesktop || (systemFontsReady && systemFonts.length > 0);
          fontStatus.textContent = systemFontsReady ? '未读取到系统字体列表；已保存的字体选择仍会保留。' : '正在读取系统字体…';
        }
      }
      var colorMode = settingsState.preferences.appearance.fontColorMode;
      var controlsReady = !Bridge.isDesktop || settingsLoaded;
      var colorControl = modal.querySelector('[data-pref="appearance.fontColor"]');
      if (colorControl) colorControl.disabled = !controlsReady || colorMode !== 'custom';
      if (fontFamilySelect) fontFamilySelect.disabled = !controlsReady || !systemFontsReady;
      var popupStatus = $('it-popup-background-status');
      if (popupStatus) popupStatus.textContent = settingsState.preferences.popup.backgroundData ?
        '已选择独立图片。' : '悬浮窗跟随主窗口背景。';
      updatePopupPreview();
      if (!sectionTransitionTarget) updateSettingsNavigation(false);
      refreshSelectButtons(false);
      renderUpdateStatus();
      renderPersistenceStatus();
    }

    function loadSystemFonts(session) {
      if (!Bridge.isDesktop || !fontFamilySelect || systemFontsReady) return Promise.resolve();
      systemFontsReady = false;
      populateSystemFonts([]);
      return Bridge.invoke('it_list_system_fonts').then(function (fonts) {
        if (session !== settingsSeq) return;
        populateSystemFonts(fonts);
        systemFontsReady = true;
      }).catch(function (error) {
        if (session !== settingsSeq) return;
        populateSystemFonts([]);
        systemFontsReady = true;
        fontStatus.textContent = '无法读取系统字体列表：' + error;
        fontStatus.hidden = false;
      });
    }

    function stopRecord() {
      if (!recording) return;
      recording.input.classList.remove('recording');
      document.removeEventListener('keydown', onKey, true);
      recording = null;
    }

    function onKey(e) {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { stopRecord(); fill(); return; }
      var key = e.key;
      if (key.length === 1) key = key.toUpperCase();
      else if (!/^F([1-9]|1[0-2])$/.test(key)) return;
      var mods = [];
      if (Bridge.isMac && e.metaKey) mods.push('Cmd');
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (!mods.length) {
        recording.input.value = Bridge.isMac ? '需要 Cmd / Ctrl / Alt / Shift' : '需要 Ctrl / Alt / Shift';
        return;
      }
      settingsState[recording.key] = mods.join('+') + '+' + key;
      stopRecord();
      fill();
      queueSettingsPersistence(true);
    }

    function startRecord(input, key) {
      stopRecord();
      recording = { input: input, key: key };
      input.classList.add('recording');
      input.value = '请按组合键…';
      document.addEventListener('keydown', onKey, true);
    }

    function enableControls(enabled) {
      var controlsEnabled = enabled && (!Bridge.isDesktop || settingsLoaded);
      modal.querySelectorAll('.it-set-body input, .it-set-body select, .it-set-body button, [data-reset-section]')
        .forEach(function (control) { control.disabled = !controlsEnabled; });
      var resetButton = modal.querySelector('[data-reset-section]');
      if (resetButton && sectionTransitionPhase === 'handoff') resetButton.disabled = true;
      var colorControl = modal.querySelector('[data-pref="appearance.fontColor"]');
      if (colorControl) colorControl.disabled = !controlsEnabled ||
        settingsState.preferences.appearance.fontColorMode !== 'custom';
      if (fontFamilySelect) fontFamilySelect.disabled = !controlsEnabled || !systemFontsReady;
      refreshSelectButtons(false);
      renderUpdateStatus();
      renderAutostartStatus();
    }

    function close() {
      if (!modal.classList.contains('on') && !settingsOpening) return false;
      if (settingsOpening) {
        settingsOpening.abort();
        settingsOpening = null;
        settingsSeq++;
        cancelPreferencePreview();
        return true;
      }
      flushPreferencePreview();
      clearTimeout(persistenceTimer);
      persistenceTimer = 0;
      persistSettings();
      stopRecord();
      closeSelect();
      if (sectionTransitionPhase === 'handoff') {
        // Keep both currently painted pages intact while the dialog itself
        // retracts. Finishing the category transaction here would replace the
        // live composite with one page for a single frame before the close.
        if (sectionPreparation) sectionPreparation.abort();
        sectionPreparation = null;
        freezeSettingsSectionHandoff();
        clearTimeout(sectionTransitionTimer);
        sectionTransitionTimer = 0;
        if (sectionTransitionFrame) cancelAnimationFrame(sectionTransitionFrame);
        sectionTransitionFrame = 0;
        sectionTransitionSeq++;
        sectionIntent = sectionPaintTarget;
        activeSection = sectionPaintTarget;
        sectionTransitionTarget = '';
        sectionTransitionPhase = 'closing';
        var closingBody = modal.querySelector('.it-set-body');
        var closingReset = modal.querySelector('[data-reset-section]');
        if (closingBody) closingBody.removeAttribute('aria-busy');
        if (closingReset) closingReset.disabled = !settingsLoaded;
      } else {
        cancelSettingsSectionTransition(shownSection);
      }
      settingsSeq++;
      backgroundPickSeq++;
      popupBackgroundPickSeq++;
      backgroundState.forEach(function (entry) { entry.el.inert = entry.inert; });
      backgroundState = [];
      if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
      modal.classList.remove('on');
      modal.classList.add('it-surface-leave');
      modal.setAttribute('aria-hidden', 'true');
      modal.inert = true;
      moveSurface(dialog, settingsOrigin, false, function () {
        modal.classList.remove('it-surface-leave');
        if (sectionTransitionPhase === 'closing') {
          setSettingsSection(sectionPaintTarget || shownSection);
        }
      });
      if (Bridge.isDesktop) Bridge.invoke('it_set_hotkeys_enabled', { enabled: true }).catch(function () {});
      return true;
    }
    closeSettingsLayer = close;

    window.__itOpenSettings = function (source) {
      if (modal.classList.contains('on') || settingsOpening) return;
      cancelPreferencePreview();
      closeSelect();
      var seq = ++settingsSeq;
      activeSection = source && source.section ? source.section : 'appearance';
      settingsLoaded = !Bridge.isDesktop;
      if (activeSection === 'desktop' && !Bridge.isDesktop) activeSection = 'appearance';
      if (!modal.querySelector('[data-pref-section="' + activeSection + '"]')) activeSection = 'appearance';
      cancelSettingsSectionTransition(activeSection);
      returnFocus = (source && source.trigger) || document.activeElement;
      settingsOrigin = (source && source.origin) || rectOf(returnFocus);
      var keepLiveSettings = settingsSaving || settingsDirty || !!persistenceFailure;
      if (!keepLiveSettings) settingsState = settingsFromSaved(null, activePreferences);
      var resetBackgroundOnOpen = !!(source && source.resetBackground);
      if (!keepLiveSettings) committedSettings = copyObject(settingsState);
      if (resetBackgroundOnOpen) settingsState.preferences.background.data = '';
      var controller = new AbortController();
      requestAutostartStatus();
      function prepareAndReveal() {
        if (seq !== settingsSeq || controller.signal.aborted) return;
        settingsLoaded = true;
        applyPreferences(settingsState.preferences);
        enableControls(true);
        fill();
        var preparation = preparePageGlass(modal, controller.signal);
        if (preparation) {
          settingsOpening = controller;
          preparation.then(reveal).catch(function (error) {
            if (settingsOpening !== controller || error.name === 'AbortError') return;
            settingsOpening = null;
            toast('玻璃效果准备失败，请重试', true);
          });
        } else reveal();
      }
      function reveal() {
        if (seq !== settingsSeq || controller.signal.aborted) return;
        settingsOpening = null;
        modal.inert = false;
        modal.setAttribute('aria-hidden', 'false');
        modal.classList.remove('it-surface-leave');
        modal.classList.add('on');
        backgroundState = Array.prototype.slice.call(document.body.children).filter(function (el) {
          return el !== modal && !/^(SCRIPT|STYLE)$/.test(el.tagName);
        }).map(function (el) {
          var entry = { el: el, inert: el.inert };
          el.inert = true;
          return entry;
        });
        moveSurface(dialog, settingsOrigin, true);
        dialog.querySelector('[data-close]').focus({ preventScroll: true });
        if (Bridge.isDesktop) {
          Bridge.invoke('it_set_hotkeys_enabled', { enabled: false }).catch(function () {});
        }
        if (resetBackgroundOnOpen) queueSettingsPersistence(true);
      }
      if (Bridge.isDesktop && !keepLiveSettings) {
        settingsOpening = controller;
        Promise.all([Bridge.invoke('it_get_settings'), loadSystemFonts(seq)]).then(function (results) {
          if (seq !== settingsSeq || controller.signal.aborted) return;
          settingsState = settingsFromSaved(results[0], readSavedPreferences());
          committedSettings = copyObject(settingsState);
          persistedSettingsJson = JSON.stringify(settingsPersistenceSnapshot());
          if (resetBackgroundOnOpen) settingsState.preferences.background.data = '';
          prepareAndReveal();
        }).catch(function (error) {
          if (seq !== settingsSeq || controller.signal.aborted) return;
          settingsOpening = null;
          toast('设置读取失败：' + error, true);
        });
      } else {
        if (!persistedSettingsJson && !keepLiveSettings) persistedSettingsJson = JSON.stringify(settingsPersistenceSnapshot());
        prepareAndReveal();
      }
    };

    prewarmSettingsGlass = function () {
      if (modal.classList.contains('on') || settingsOpening || settingsSaving || settingsDirty ||
          persistenceFailure) return;
      settingsState = settingsFromSaved(null, activePreferences);
      fill();
      var preparation = preparePageGlass(modal);
      if (preparation) preparation.catch(function () { /* Surface errors are reported by the engine. */ });
    };

    on(modal, 'click', function (e) {
      if (e.target === modal || (e.target.closest && e.target.closest('[data-close]'))) close();
      var tab = e.target.closest && e.target.closest('[data-pref-tab]');
      if (tab && !tab.disabled) {
        switchSettingsSection(tab.getAttribute('data-pref-tab'));
      }
      if (e.target.closest && e.target.closest('[data-reset-section]')) {
        cancelPreferencePreview();
        var defaults = copyObject(DEFAULT_PREFERENCES);
        if (shownSection === 'desktop') {
          var preservedPreferences = copyObject(settingsState.preferences);
          settingsState = copyObject(DEFAULT_SETTINGS);
          settingsState.preferences = preservedPreferences;
          settingsState.preferences.popup = copyObject(defaults.popup);
        } else if (shownSection === 'reading') {
          settingsState.preferences.appearance.font = defaults.appearance.font;
          settingsState.preferences.appearance.systemFontFamily = defaults.appearance.systemFontFamily;
          settingsState.preferences.appearance.fontScale = defaults.appearance.fontScale;
          settingsState.preferences.appearance.fontWeight = defaults.appearance.fontWeight;
          settingsState.preferences.appearance.fontColorMode = defaults.appearance.fontColorMode;
          settingsState.preferences.appearance.fontColor = defaults.appearance.fontColor;
          settingsState.preferences.appearance.layout = defaults.appearance.layout;
        } else if (shownSection === 'motion') {
          settingsState.preferences.appearance.motion = defaults.appearance.motion;
          settingsState.preferences.appearance.ambientLight = defaults.appearance.ambientLight;
        } else if (shownSection === 'glass') {
          settingsState.preferences.liquidGlass[glassTarget] = copyObject(defaults.liquidGlass[glassTarget]);
        } else if (shownSection === 'updates') {
          settingsState.preferences.updates = copyObject(defaults.updates);
        } else if (shownSection === 'appearance') {
          ['mode', 'palette', 'radius'].forEach(function (key) {
            settingsState.preferences.appearance[key] = defaults.appearance[key];
          });
        } else {
          settingsState.preferences[shownSection === 'appearance' ? 'appearance' :
            shownSection === 'background' ? 'background' : 'translation'] =
            defaults[shownSection === 'appearance' ? 'appearance' :
              shownSection === 'background' ? 'background' : 'translation'];
        }
        applyPreferences(settingsState.preferences);
        fill();
        queueSettingsPersistence(true);
      }
      if (e.target.closest && e.target.closest('#it-pref-pick-background')) {
        var selection = ++backgroundPickSeq;
        var session = settingsSeq;
        Bridge.pickImage(function (dataUrl) {
          if (!dataUrl || !settingsState || session !== settingsSeq ||
              selection !== backgroundPickSeq || !modal.classList.contains('on')) return;
          return new Promise(function (resolve) {
            shrinkImage(dataUrl, function (compressed) {
              if (settingsState && session === settingsSeq && selection === backgroundPickSeq &&
                  modal.classList.contains('on')) {
                settingsState.preferences.background.data = compressed;
                cancelPreferencePreview();
                applyPreferences(settingsState.preferences);
                fill();
                queueSettingsPersistence(true);
              }
              resolve();
            });
          });
        }, 'background');
      }
      if (e.target.closest && e.target.closest('#it-pref-reset-background')) {
        backgroundPickSeq++;
        var pendingBackground = readPendingTransfer('it-image-import');
        if (pendingBackground && pendingBackground.purpose === 'background') removePendingTransfer('it-image-import');
        settingsState.preferences.background.data = '';
        cancelPreferencePreview();
        applyPreferences(settingsState.preferences);
        fill();
        queueSettingsPersistence(true);
      }
      if (e.target.closest && e.target.closest('#it-popup-pick-background')) {
        var popupSelection = ++popupBackgroundPickSeq;
        var popupSession = settingsSeq;
        Bridge.pickImage(function (dataUrl) {
          if (!dataUrl || !settingsState || popupSession !== settingsSeq ||
              popupSelection !== popupBackgroundPickSeq || !modal.classList.contains('on')) return;
          return new Promise(function (resolve) {
            shrinkImage(dataUrl, function (compressed) {
              if (settingsState && popupSession === settingsSeq && popupSelection === popupBackgroundPickSeq && modal.classList.contains('on')) {
                settingsState.preferences.popup.backgroundData = compressed;
                applyPreferences(settingsState.preferences);
                fill();
                queueSettingsPersistence(true);
              }
              resolve();
            });
          });
        }, 'popup-background');
      }
      if (e.target.closest && e.target.closest('#it-popup-follow-background')) {
        popupBackgroundPickSeq++;
        var pendingPopup = readPendingTransfer('it-image-import');
        if (pendingPopup && pendingPopup.purpose === 'popup-background') removePendingTransfer('it-image-import');
        settingsState.preferences.popup.backgroundData = '';
        applyPreferences(settingsState.preferences);
        fill();
        queueSettingsPersistence(true);
      }
    });
    on(document, 'keydown', function (e) {
      if (e.key !== 'Tab' || !modal.classList.contains('on')) return;
      var focusable = Array.prototype.slice.call(dialog.querySelectorAll('button, input, select, [tabindex]'))
        .filter(function (el) { return !el.disabled && !el.hidden && !el.closest('[inert]') &&
          el.tabIndex >= 0 && el.getClientRects().length; });
      if (openSelect && dialog.contains(openSelect.select)) {
        var focusInPopup = openSelect.pop.contains(document.activeElement);
        var trigger = openSelect.button;
        closeSelect();
        if (focusInPopup) {
          e.preventDefault();
          if (!focusable.length) { dialog.focus(); return; }
          var triggerIndex = focusable.indexOf(trigger);
          var nextIndex = triggerIndex < 0 ? (e.shiftKey ? focusable.length - 1 : 0) :
            (triggerIndex + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
          focusable[nextIndex].focus({ preventScroll: true });
          return;
        }
      }
      if (!focusable.length) { e.preventDefault(); dialog.focus(); return; }
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    });
    var settingsNavigationFrame = 0;
    on(window, 'resize', function () {
      if (!modal.classList.contains('on') || settingsNavigationFrame) return;
      settingsNavigationFrame = requestAnimationFrame(function () {
        settingsNavigationFrame = 0;
        if (modal.classList.contains('on')) updateSettingsNavigation(false);
      });
    });
    on(modal.querySelector('.it-set-body'), 'scroll', function () {
      if (openSelect && dialog.contains(openSelect.select)) closeSelect();
    }, { passive: true, capture: true });
    on($('it-set-selection'), 'click', function () { startRecord(this, 'selection_shortcut'); });
    on($('it-set-activation'), 'click', function () { startRecord(this, 'activation_shortcut'); });
    on($('it-set-mode'), 'change', function () {
      settingsState.open_main_window = this.value === 'main'; queueSettingsPersistence(true);
    });
    on($('it-set-lang'), 'change', function () {
      settingsState.target_lang = this.value; queueSettingsPersistence(true);
    });
    on($('it-set-autostart'), 'change', function () {
      if (!Bridge.isDesktop || Bridge.isMac) {
        settingsState.auto_start = this.checked;
        queueSettingsPersistence(true);
        return;
      }
      requestAutostartStatus(this.checked);
    });
    on($('it-set-autostart-current'), 'click', function () {
      requestAutostartStatus(true);
    });
    on($('it-set-autostart-retry'), 'click', function () {
      if (!autostartBusy) requestAutostartStatus();
    });
    on($('it-set-starttotray'), 'change', function () {
      settingsState.start_to_tray = this.checked; queueSettingsPersistence(true);
    });

    function updatePreference(control, final) {
      if (!settingsState || !control.hasAttribute('data-pref')) return;
      var path = control.getAttribute('data-pref');
      var value = control.type === 'checkbox' ? control.checked : control.value;
      if (control.getAttribute('data-pref-type') === 'number') value = Number(value);
      var previous = valueAtPath(settingsState.preferences, path);
      if (previous === value) {
        if (final) {
          flushPreferencePreview();
          if (settingsDirty) queueSettingsPersistence(true);
        }
        return;
      }
      assignAtPath(settingsState.preferences, path, value);
      settingsState.preferences = normalizePreferences(settingsState.preferences);
      updatePreferenceControl(control);
      var row = control.closest('.it-set-range, .it-set-row');
      if (row) row.querySelectorAll('[data-pref-output]').forEach(updatePreferenceOutput);
      if (control.type === 'range' || control.type === 'color') {
        schedulePreferencePreview();
        if (final) flushPreferencePreview();
      } else {
        cancelPreferencePreview();
        applyPreferences(settingsState.preferences);
        fill();
      }
      queueSettingsPersistence(final || (control.type !== 'range' && control.type !== 'color'));
    }
    on(modal, 'input', function (e) { updatePreference(e.target, false); });
    on(modal, 'change', function (e) { updatePreference(e.target, true); });

    if (Bridge.isDesktop) Bridge.invoke('it_set_hotkeys_enabled', { enabled: true }).catch(function () {});
  }

  /* ---------------- 15. 初始化 ---------------- */
  function init() {
    if (PLATFORM === 'desktop') document.documentElement.classList.add('it-desktop');
    if (Bridge.isMac) document.documentElement.classList.add('it-macos');
    if (PLATFORM === 'android') document.documentElement.classList.add('it-android');

    var nativeBootstrap = null;
    if (Bridge.isDesktop) {
      nativeBootstrap = Bridge.invoke('it_get_settings');
      nativeBootstrap.catch(function () {});
    }

    fillLangSelects();
    enhanceAllSelects();
    if (Bridge.isAndroid && window.NativeBridge && typeof window.NativeBridge.getSystemAppearance === 'function') {
      try { currentSystemAppearance = window.NativeBridge.getSystemAppearance() === 'dark' ? 'dark' : 'light'; }
      catch (e) {}
    } else {
      try { currentSystemAppearance = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
      catch (e) {}
    }
    applyPreferences(activePreferences);
    initTabs();
    initMobileKeyboardLayout();
    initModelGroups();
    initTextPane();
    initInstructBox();
    initSyllablePane();
    initDocPane();
    initMenu();
    initGlass();
    initTitlebar();
    initResizeHandles();
    initDesktopSettings();
    if (Bridge.isMac && typeof window.__JIAN_DESKTOP__.onAction === 'function') {
      window.__JIAN_DESKTOP__.onAction(function (action) {
        if (action && action.type === 'window-state') {
          document.documentElement.classList.toggle('it-window-expanded',
            !!(action.fullscreen || action.maximized));
        } else if (action && action.type === 'open-settings' && window.__itOpenSettings) {
          window.__itOpenSettings();
        } else if (action && action.type === 'open-about' && window.__itOpenAbout) {
          window.__itOpenAbout();
        } else if (action && action.type === 'translate-selection' && typeof action.text === 'string' &&
            window.__itTranslateSelection) {
          window.__itTranslateSelection(action.text);
        }
      });
    }
    restoreBackground();
    refreshCount();

    /* 点空白处收起下拉 */
    on(document, 'click', closeSelect);
    on(document, 'keydown', function (e) {
      if (e.key === 'Escape' && !e.defaultPrevented && window.__itHandleBack()) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    on($('src-lang'), 'change', function () { state.src = this.value; });
    on($('tgt-lang'), 'change', function () { state.tgt = this.value; });
    on($('btn-swap'), 'click', function () {
      var src = $('src-lang');
      var tgt = $('tgt-lang');
      /* 自动检测无法作为目标语言，交换时落到中/英 */
      var nextTgt = src.value === 'auto' ? 'en' : src.value;
      var nextSrc = tgt.value;
      tgt.value = nextTgt;
      src.value = nextSrc;
      state.src = src.value;
      state.tgt = tgt.value;
      /* 触发 change：自绘按钮的轮盘动画 + 状态持久化都挂在这个事件上 */
      src.dispatchEvent(new Event('change', { bubbles: true }));
      tgt.dispatchEvent(new Event('change', { bubbles: true }));
    });

    restoreTranslationPreferences(activePreferences);

    /* 恢复的是程序化赋值，不会触发 change：手动把按钮文字与模型滑块对齐 */
    refreshSelectButtons(false);
    positionThumbs();
    scheduleGlassWarmup();

    var resizeFrame = 0;
    on(window, 'resize', function () {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(function () {
        resizeFrame = 0;
        finishMotions();
        positionThumbs(false);
        if (window.ItLiquidGlass && window.ItLiquidGlass.prepare) scheduleGlassWarmup();
        if (openSelect && openSelect.position) openSelect.position();
      });
    });
    var reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    function updateMotionPreference() {
      if (reducedMotionQuery.matches) {
        finishMotions();
        positionThumbs(false);
      }
    }
    if (reducedMotionQuery.addEventListener) reducedMotionQuery.addEventListener('change', updateMotionPreference);
    else if (reducedMotionQuery.addListener) reducedMotionQuery.addListener(updateMotionPreference);

    var colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    function updateSystemAppearance() {
      if (Bridge.isAndroid && window.NativeBridge && typeof window.NativeBridge.getSystemAppearance === 'function') {
        try { currentSystemAppearance = window.NativeBridge.getSystemAppearance() === 'dark' ? 'dark' : 'light'; }
        catch (e) { currentSystemAppearance = colorSchemeQuery.matches ? 'dark' : 'light'; }
      } else {
        currentSystemAppearance = colorSchemeQuery.matches ? 'dark' : 'light';
      }
      if (activePreferences.appearance.mode === 'system') applyPreferences(activePreferences);
    }
    if (colorSchemeQuery.addEventListener) colorSchemeQuery.addEventListener('change', updateSystemAppearance);
    else if (colorSchemeQuery.addListener) colorSchemeQuery.addListener(updateSystemAppearance);
    window.__itOnSystemAppearance = function (mode) {
      if (mode !== 'light' && mode !== 'dark') return;
      currentSystemAppearance = mode;
      if (activePreferences.appearance.mode === 'system') applyPreferences(activePreferences);
    };

    function persist() {
      try {
        localStorage.setItem('it-state', JSON.stringify({
          src: state.src, tgt: state.tgt, model: state.model, tab: state.tab
        }));
      } catch (e) {}
    }
    on($('src-lang'), 'change', persist);
    on($('tgt-lang'), 'change', persist);
    document.querySelectorAll('.models button').forEach(function (b) { on(b, 'click', persist); });

    if (Bridge.isDesktop && nativeBootstrap) {
      var bootReleased = false;
      var bootTimer = setTimeout(function () {
        bootReleased = true;
        document.documentElement.classList.remove('it-settings-boot');
      }, 2500);
      nativeBootstrap.then(function (savedSettings) {
        if (savedSettings && savedSettings.preferences) {
          activePreferences = normalizePreferences(savedSettings.preferences);
          applyPreferences(activePreferences);
          restoreTranslationPreferences(activePreferences);
        }
      }).catch(function () {}).then(function () {
        if (scheduleAppUpdateCheck) scheduleAppUpdateCheck();
        if (bootReleased) return;
        clearTimeout(bootTimer);
        document.documentElement.classList.remove('it-settings-boot');
      });
    } else if (scheduleAppUpdateCheck) {
      scheduleAppUpdateCheck();
    }

    initRestoredTransfers();

    /* 调试钩子：只在 ?debug=1 时挂载，正式运行不暴露内部状态 */
    if (/[?&]debug=1/.test(location.search)) {
      window.__itDebug = {
        state: state,
        setImage: setImage,
        runText: runText,
        runDoc: runDoc,
        switchTab: switchTab,
        startWriter: startWriter,
        preferences: { normalize: normalizePreferences, defaults: copyObject(DEFAULT_PREFERENCES),
          apply: applyPreferences, nativeSnapshot: nativeAppearanceSnapshot }
      };
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
