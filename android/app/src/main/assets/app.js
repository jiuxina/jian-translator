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

   三端共用：Windows 由 pake --use-local-file 打包本目录，Android 放进
   assets/ 用 WebView 加载。平台差异只通过 Bridge 抽象层暴露。
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------- 0. 常量 ---------------- */
  var API_BASE = 'https://index-translate.bilibili.com/v1';
  var CHAT_URL = API_BASE + '/chat/completions';
  var MAX_SRC = 8000;
  var LANGS = window.IT_LANGS || {};
  var COMMON = window.IT_COMMON_LANGS || [];

  var PLATFORM = (function () {
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
  var closeInstructLayer = null;

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
    track.animation.onfinish = null;
    track.animation.cancel();
  }

  function playMotion(el, frames, duration, done, group, hold) {
    stopMotion(el);
    if (motionReduced() || !el.animate) {
      if (done) done();
      return;
    }
    var animation = el.animate(frames, { duration: duration, easing: SCENE_EASE, fill: 'both' });
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
    Array.from(motions.values()).forEach(function (track) { track.finish(); });
    settleTabs();
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

  /* 浏览器 Escape 与 Android 返回键共用；每次只回收最上面一层。 */
  window.__itHandleBack = function () {
    if (openSelect) { closeSelect(); return true; }
    if (closeSettingsLayer && closeSettingsLayer()) return true;
    if (closeMenuLayer && closeMenuLayer()) return true;
    return !!(closeInstructLayer && closeInstructLayer());
  };

  /* ---------------- 2. 平台桥 ---------------- */
  var Bridge = {
    isDesktop: PLATFORM === 'desktop',
    isAndroid: PLATFORM === 'android',

    invoke: function (cmd, args) {
      var internals = window.__TAURI_INTERNALS__;
      if (internals && typeof internals.invoke === 'function') {
        return internals.invoke(cmd, args || {}, {});
      }
      if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        return window.__TAURI__.core.invoke(cmd, args || {});
      }
      return Promise.reject(new Error('Tauri IPC 不可用'));
    },

    /* 选图：桌面用原生 file input，安卓走原生相册/相机 */
    pickImage: function (onPicked) {
      if (Bridge.isAndroid && window.NativeBridge && window.NativeBridge.pickImage) {
        window.__itOnImage = onPicked;
        try { window.NativeBridge.pickImage(); } catch (e) { toast('无法打开相册', true); }
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
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
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
          out.push({ value: opt.value, label: opt.textContent, group: node.label });
        }
      } else if (node.tagName === 'OPTION') {
        out.push({ value: node.value, label: node.textContent, group: '' });
      }
    }
    return out;
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
    var items = collectOptions(select);
    var searchable = items.length > 12;

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'sel-btn';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    var valueEl = document.createElement('span');
    valueEl.className = 'sel-value';
    var reelEl = document.createElement('span');
    reelEl.className = 'sel-reel';
    valueEl.appendChild(reelEl);
    button.appendChild(valueEl);
    wrap.insertBefore(button, select);

    var pop = document.createElement('div');
    pop.className = 'sel-pop';
    pop.setAttribute('aria-hidden', 'true');
    pop.inert = true;
    pop.innerHTML = (searchable
      ? '<input class="sel-search" type="text" placeholder="搜索…" aria-label="搜索">'
      : '') + '<div class="sel-list" role="listbox"></div>';
    document.body.appendChild(pop);

    var listEl = pop.querySelector('.sel-list');
    var searchEl = pop.querySelector('.sel-search');
    var activeIndex = -1;
    var visibleItems = [];

    /* 量字宽：轮盘条带取所有候选里最宽的一条，按钮随之平滑变宽 */
    var measure = document.createElement('span');
    measure.setAttribute('aria-hidden', 'true');
    measure.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap';
    document.body.appendChild(measure);
    var btnFont = getComputedStyle(button);
    if (btnFont.font) measure.style.font = btnFont.font;
    measure.style.fontSize = btnFont.fontSize || '13px';
    measure.style.fontFamily = btnFont.fontFamily || 'inherit';

    function widthOf(text) {
      measure.textContent = text;
      return measure.getBoundingClientRect().width;
    }
    function clampWidth(w) { return Math.max(16, Math.min(124, Math.ceil(w))); }

    var currentLabel = '';
    var currentValue = select.value;   // 记住旧值，才能算出它在列表里的位置
    var spinTimer = 0;

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
      valueEl.style.width = clampWidth(widthOf(text)) + 'px';
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
      clearTimeout(spinTimer);
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
      var widest = 0;
      labels.forEach(function (label) {
        var row = document.createElement('span');
        row.className = 'sel-reel-row';
        row.textContent = label;
        reelEl.appendChild(row);
        widest = Math.max(widest, widthOf(label));
      });
      valueEl.style.width = clampWidth(widest) + 'px';
      reelEl.style.transition = 'none';
      reelEl.style.transform = 'translateY(-' + start + 'px)';
      void reelEl.offsetWidth;
      var reelEase = getComputedStyle(document.documentElement).getPropertyValue('--lg-ease-reel').trim();
      reelEl.style.transition = 'transform ' + duration + 'ms ' + (reelEase || 'cubic-bezier(.16,.84,.28,1)');
      valueEl.style.animationDuration = duration + 'ms';
      valueEl.classList.add('rolling');
      reelEl.style.transform = 'translateY(-' + end + 'px)';

      spinTimer = setTimeout(function () {
        valueEl.classList.remove('rolling');
        valueEl.style.animationDuration = '';
        paintRow(text);
      }, duration + 30);
    }

    function syncButton(animate) { setLabel(labelOf(), animate !== false); }

    function render(filter) {
      var query = (filter || '').trim().toLowerCase();
      listEl.innerHTML = '';
      visibleItems = [];
      activeIndex = -1;

      var lastGroup = null;
      var matched = 0;

      items.forEach(function (item) {
        if (query && item.label.toLowerCase().indexOf(query) === -1) return;
        if (item.group && item.group !== lastGroup) {
          lastGroup = item.group;
          var head = document.createElement('div');
          head.className = 'sel-group';
          head.textContent = item.group;
          listEl.appendChild(head);
        }
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'sel-item';
        row.textContent = item.label;
        row.dataset.value = item.value;
        if (item.value === select.value) {
          row.classList.add('on');
          activeIndex = visibleItems.length;
        }
        row.addEventListener('click', function () { choose(item.value); });
        listEl.appendChild(row);
        visibleItems.push(row);
        matched++;
      });

      if (!matched) {
        var empty = document.createElement('div');
        empty.className = 'sel-empty';
        empty.textContent = '没有匹配的项';
        listEl.appendChild(empty);
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
      if (openSelect && openSelect.select === select) { closeSelect(); return; }
      closeSelect();
      pop.inert = false;
      pop.setAttribute('aria-hidden', 'false');
      button.setAttribute('aria-expanded', 'true');
      openSelect = { select: select, pop: pop, button: button, position: position };
      render('');
      position();
      moveSurface(pop, button, true);
      if (searchEl) { searchEl.value = ''; searchEl.focus(); }
      else highlight(activeIndex);
    }

    function choose(value) {
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

    if (searchEl) {
      searchEl.addEventListener('input', function () { render(this.value); });
    }

    pop.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSelect(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(activeIndex + 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); highlight(activeIndex - 1); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        var row = visibleItems[activeIndex];
        if (row) choose(row.dataset.value);
      }
    });

    pop.addEventListener('click', function (e) { e.stopPropagation(); });

    syncButton(false);
    /* 外部（如语言互换、恢复上次选择）改了值，按钮要跟着转 */
    select.addEventListener('change', function () { syncButton(true); });
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
    image: null,
    running: false,
    controller: null
  };

  /* ---------------- 4a. Saved preferences ---------------- */
  var PREFERENCES_KEY = 'it-preferences';
  var MODEL_OPTIONS = {
    text: ['index-mt-2b', 'index-mt-9b', 'index-mt-35b'],
    syllable: ['index-mt-2b-syllable', 'index-mt-9b-syllable'],
    doc: ['index-nailong-2b', 'index-nailong-9b']
  };
  var DEFAULT_PREFERENCES = {
    version: 1,
    appearance: {
      mode: 'light', palette: 'sakura', material: 'glass', glassStrength: 100,
      radius: 'round', font: 'sans', fontScale: 100, layout: 'standard',
      motion: 'system', ambientLight: true
    },
    background: { data: '', opacity: 34, blur: 0, fit: 'cover' },
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
    var translation = source.translation || {};
    var savedModels = translation.defaultModels || {};
    var result = copyObject(DEFAULT_PREFERENCES);

    result.appearance.mode = enumValue(appearance.mode, ['light', 'dark', 'system'], 'light');
    result.appearance.palette = enumValue(appearance.palette,
      ['sakura', 'mist', 'sage', 'amber'], 'sakura');
    result.appearance.material = enumValue(appearance.material,
      ['glass', 'frosted', 'solid'], 'glass');
    result.appearance.glassStrength = boundedNumber(appearance.glassStrength, 0, 100, 100);
    result.appearance.radius = enumValue(appearance.radius,
      ['round', 'standard', 'small'], 'round');
    result.appearance.font = enumValue(appearance.font,
      ['sans', 'serif', 'mono'], 'sans');
    result.appearance.fontScale = boundedNumber(appearance.fontScale, 90, 140, 100);
    result.appearance.layout = enumValue(appearance.layout,
      ['standard', 'compact'], 'standard');
    result.appearance.motion = enumValue(appearance.motion,
      ['system', 'reduced', 'off'], 'system');
    result.appearance.ambientLight = appearance.ambientLight !== false;

    var image = typeof background.data === 'string' &&
      /^data:image\/(png|jpeg|webp|gif);base64,/i.test(background.data) &&
      background.data.length <= 6000000 ? background.data : '';
    result.background.data = image;
    result.background.opacity = boundedNumber(background.opacity, 0, 80, 34);
    result.background.blur = boundedNumber(background.blur, 0, 20, 0);
    result.background.fit = enumValue(background.fit, ['cover', 'contain'], 'cover');

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
    return normalizePreferences(parsed);
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
    var surface = preferences.appearance.material === 'solid' ?
      (dark ? '#FF302C38' : '#FFF9F6FA') : (dark ? '#C92D2934' : '#D9FFFFFF');
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

  function syncAndroidAppearance(preferences) {
    if (!Bridge.isAndroid || !window.NativeBridge ||
        typeof window.NativeBridge.applyAppearance !== 'function') return;
    try { window.NativeBridge.applyAppearance(JSON.stringify(nativeAppearance(preferences))); }
    catch (e) {}
  }

  function applyPreferences(preferences) {
    activePreferences = normalizePreferences(preferences);
    var root = document.documentElement;
    var appearance = activePreferences.appearance;
    var dark = resolvedAppearance(activePreferences) === 'dark';
    var colors = PALETTE_COLORS[appearance.palette] || PALETTE_COLORS.sakura;
    var palette = colors[dark ? 'dark' : 'light'];
    var background = dark ? '#211F28' : '#F3EFF6';
    var backgroundWarm = dark ? '#2D2934' : '#FCF8FB';
    var ink = dark ? '#F2EDF3' : '#2E2A38';
    var inkSub = dark ? '#BFB8C5' : '#6E687E';
    var inkFaint = dark ? '#908997' : '#A29CAC';
    var strength = appearance.glassStrength / 100;
    function surfaceOpacity(base) {
      if (appearance.material === 'solid') return 1;
      var frosting = appearance.material === 'frosted' ? .2 : 0;
      return Math.min(.98, base + (1 - strength) * (.96 - base) + frosting);
    }
    var blur = appearance.material === 'solid' ? 0 :
      appearance.material === 'frosted' ? (20 + 24 * strength) : 22 * strength;
    var radius = appearance.radius === 'small' ? [12, 9, 7] :
      appearance.radius === 'standard' ? [19, 15, 11] : [26, 20, 14];

    root.dataset.itTheme = dark ? 'dark' : 'light';
    var colorScheme = document.querySelector('meta[name="color-scheme"]');
    if (colorScheme) colorScheme.setAttribute('content', dark ? 'dark light' : 'light dark');
    root.dataset.itThemeMode = appearance.mode;
    root.dataset.itPalette = appearance.palette;
    root.dataset.itMaterial = appearance.material;
    root.dataset.itRadius = appearance.radius;
    root.dataset.itLayout = appearance.layout;
    root.dataset.itMotion = appearance.motion;
    root.dataset.itAmbient = appearance.ambientLight ? 'true' : 'false';
    root.style.setProperty('--lg-bg', background);
    root.style.setProperty('--lg-bg-warm', backgroundWarm);
    root.style.setProperty('--lg-bg-end', dark ? '#18161D' : '#EBE5F4');
    root.style.setProperty('--lg-overlay', dark ? 'rgba(4,3,7,.54)' : 'rgba(46,42,56,.18)');
    root.style.setProperty('--lg-ink', ink);
    root.style.setProperty('--lg-ink-sub', inkSub);
    root.style.setProperty('--lg-ink-faint', inkFaint);
    root.style.setProperty('--lg-accent', palette.accent);
    root.style.setProperty('--lg-accent-deep', palette.deep);
    root.style.setProperty('--lg-lilac', palette.lilac);
    root.style.setProperty('--lg-glow-a', colorRgba(palette.accent, appearance.ambientLight ? (dark ? .2 : .28) : 0));
    root.style.setProperty('--lg-glow-b', colorRgba(palette.lilac, appearance.ambientLight ? (dark ? .14 : .2) : 0));
    root.style.setProperty('--lg-glow-c', dark ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.48)');
    root.style.setProperty('--lg-accent-wash', colorRgba(palette.deep, dark ? .22 : .14));
    root.style.setProperty('--lg-accent-wash-2', colorRgba(palette.deep, dark ? .32 : .24));
    root.style.setProperty('--lg-edge', dark ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.74)');
    root.style.setProperty('--lg-edge-dark', dark ? 'rgba(255,255,255,.12)' : 'rgba(70,52,96,.09)');
    root.style.setProperty('--lg-shadow', dark ?
      '0 12px 34px rgba(0,0,0,.32),0 3px 10px rgba(0,0,0,.18)' :
      '0 12px 34px rgba(70,52,96,.13),0 3px 10px rgba(70,52,96,.06)');
    root.style.setProperty('--lg-shadow-strong', dark ?
      '0 24px 60px rgba(0,0,0,.42),0 5px 14px rgba(0,0,0,.2)' :
      '0 24px 60px rgba(70,52,96,.20),0 5px 14px rgba(70,52,96,.08)');
    root.style.setProperty('--lg-shadow-soft', dark ?
      '0 5px 16px rgba(0,0,0,.24)' : '0 5px 16px rgba(70,52,96,.09)');
    root.style.setProperty('--lg-blur', blur + 'px');
    root.style.setProperty('--lg-blur-strong', Math.round(blur * 1.55) + 'px');
    root.style.setProperty('--lg-saturate', (1 + strength * .7).toFixed(2));
    root.style.setProperty('--lg-tint-0', colorRgba(dark ? '#302C38' : '#FFFFFF', surfaceOpacity(.24)));
    root.style.setProperty('--lg-tint-1', colorRgba(dark ? '#35313F' : '#FFFFFF', surfaceOpacity(.44)));
    root.style.setProperty('--lg-tint-2', colorRgba(dark ? '#393543' : '#FFFFFF', surfaceOpacity(.72)));
    root.style.setProperty('--lg-tint-popup', colorRgba(dark ? '#302C38' : '#FFFFFF', surfaceOpacity(.82)));
    root.style.setProperty('--lg-tint-field', colorRgba(dark ? '#302C38' : '#FFFFFF', surfaceOpacity(.62)));
    root.style.setProperty('--lg-tint-inset', colorRgba(dark ? '#25232C' : '#FFFFFF', surfaceOpacity(.36)));
    root.style.setProperty('--lg-r-lg', radius[0] + 'px');
    root.style.setProperty('--lg-r-md', radius[1] + 'px');
    root.style.setProperty('--lg-r-sm', radius[2] + 'px');
    root.style.setProperty('--it-content-font', appearance.font === 'serif' ?
      '"Noto Serif", "Songti SC", serif' : appearance.font === 'mono' ?
        '"Cascadia Code", "Consolas", monospace' :
        '"PingFang SC", "Microsoft YaHei UI", "Noto Sans SC", system-ui, sans-serif');
    root.style.setProperty('--it-content-scale', String(appearance.fontScale / 100));
    root.style.setProperty('--lg-distance-scene', appearance.motion === 'reduced' ? '0px' : '28px');
    if (appearance.motion === 'reduced') {
      root.style.setProperty('--lg-duration-panel', '180ms');
      root.style.setProperty('--lg-duration-dialog', '140ms');
    } else {
      root.style.setProperty('--lg-duration-panel', '420ms');
      root.style.setProperty('--lg-duration-dialog', '240ms');
    }
    syncMotionConstants();
    applyBackground(activePreferences.background.data, activePreferences.background);
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
    var started = performance.now();
    var firstAt = 0;
    var collected = '';

    return fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: signal
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (body) {
          throw new Error(describeError(resp.status, body));
        });
      }

      /* 个别老 WebView 没有 ReadableStream，退回非流式 */
      if (!resp.body || typeof resp.body.getReader !== 'function') {
        return resp.json().then(function (j) {
          var content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
          if (content && onDelta) onDelta(content);
          collected = content;
          return { text: collected, usage: j.usage || null, ms: performance.now() - started, firstMs: 0 };
        });
      }

      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var usage = null;

      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            return { text: collected, usage: usage, ms: performance.now() - started, firstMs: firstAt ? firstAt - started : 0 };
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          var parts = buffer.split('\n\n');
          buffer = parts.pop();
          for (var i = 0; i < parts.length; i++) {
            var line = parts[i].trim();
            if (line.indexOf('data:') !== 0) continue;
            var raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            var json;
            try { json = JSON.parse(raw); } catch (e) { continue; }
            var delta = json.choices && json.choices[0] && json.choices[0].delta;
            if (delta && delta.content) {
              if (!firstAt) firstAt = performance.now();
              collected += delta.content;
              if (onDelta) onDelta(delta.content);
            }
            if (json.usage) usage = json.usage;
          }
          return pump();
        });
      }
      return pump();
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

  function switchTab(name) {
    if (!panes[name]) return;
    if (name === state.tab) return;

    var oldEl = $(panes[shownTab]);
    var newEl = $(panes[name]);
    if (openSelect && oldEl && oldEl.contains(openSelect.button)) closeSelect();
    var focusWasInOld = !!(oldEl && oldEl.contains(document.activeElement));
    var seq = ++tabSeq;
    var direction = Object.keys(panes).indexOf(name) > Object.keys(panes).indexOf(shownTab) ? 1 : -1;
    var oldRects = oldEl ? tabSurfaces(oldEl).map(function (el) { return el.getBoundingClientRect(); }) : [];
    var samples = new Map();
    var visiblePanels = [];
    var surfaceRects = new Map();
    /* 包括正在退场的页面，反向点回时可以从它尚未消失的位置接续。 */
    Object.keys(panes).forEach(function (key) {
      var panel = $(panes[key]);
      if (!panel || (!panel.classList.contains('on') && !panel.classList.contains('it-tab-leave'))) return;
      visiblePanels.push(panel);
      surfaceRects.set(panel, tabSurfaces(panel).map(function (el) { return el.getBoundingClientRect(); }));
      tabContents(panel).forEach(function (el) { samples.set(el, visualStyle(el)); });
    });
    stopMotionGroup('tab');
    settleTabs();

    state.tab = name;
    try {
      var remembered = JSON.parse(localStorage.getItem('it-state') || '{}');
      remembered.tab = name;
      localStorage.setItem('it-state', JSON.stringify(remembered));
    } catch (e) {}
    shownTab = name;
    document.querySelectorAll('.tabs button').forEach(function (button) {
      var selected = button.getAttribute('data-tab') === name;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('.dock').forEach(function (dock) {
      dock.classList.toggle('on', dock.getAttribute('data-pane') === name);
    });
    if (focusWasInOld) {
      var selectedTab = document.querySelector('.tabs button[data-tab="' + name + '"]');
      if (selectedTab) selectedTab.focus();
    }
    Object.keys(panes).forEach(function (key) {
      var panel = $(panes[key]);
      if (!panel) return;
      var selected = key === name;
      panel.inert = !selected;
      panel.setAttribute('aria-hidden', selected ? 'false' : 'true');
    });

    if (!oldEl || !newEl || motionReduced() || !newEl.animate) {
      settleTabs();
      positionThumbs(false);
      return;
    }

    visiblePanels.forEach(function (panel) {
      if (panel === newEl) return;
      panel.classList.remove('on');
      panel.classList.add('it-tab-leave');
    });
    newEl.classList.remove('it-tab-leave');
    newEl.classList.add('on');
    var nextRects = [];
    tabSurfaces(newEl).forEach(function (el, index) {
      var from = oldRects[index];
      var to = el.getBoundingClientRect();
      nextRects.push(to);
      if (!from || !to.width || !to.height) return;
      playMotion(el, [{ transform: mapRect(from, to) }, { transform: 'none' }],
        PANEL_DURATION, null, 'tab', true);
    });
    /* 三连切时保留每一层尚未淡完的内容，避免丢掉上一段的剩余透明度。 */
    visiblePanels.forEach(function (panel) {
      if (panel === newEl) return;
      var rects = surfaceRects.get(panel);
      tabSurfaces(panel).forEach(function (el, index) {
        var natural = el.getBoundingClientRect();
        if (!rects[index] || !nextRects[index] || !natural.width || !natural.height) return;
        playMotion(el, [{ transform: mapRect(rects[index], natural) },
          { transform: mapRect(nextRects[index], natural) }], PANEL_DURATION, null, 'tab', true);
      });
      tabContents(panel).forEach(function (el) {
        var from = samples.get(el) || visualStyle(el);
        var thumb = el.classList.contains('models-thumb');
        playMotion(el, [thumb ? { opacity: from.opacity } : from,
          thumb ? { opacity: '0' } : { opacity: '0', transform: shiftX(-direction * SCENE_DISTANCE) }],
        PANEL_DURATION, null, 'tab', true);
      });
    });
    tabContents(newEl).forEach(function (el) {
      var from = samples.get(el) || { opacity: '0', transform: shiftX(direction * SCENE_DISTANCE) };
      var thumb = el.classList.contains('models-thumb');
      playMotion(el, [thumb ? { opacity: from.opacity } : from,
        thumb ? { opacity: '1' } : { opacity: '1', transform: 'none' }],
      PANEL_DURATION, null, 'tab', true);
    });
    /* 完成时一次性释放退场内容，避免先释放 fill 帧造成末尾闪回。 */
    playMotion(newEl, [{ opacity: 1 }, { opacity: 1 }], PANEL_DURATION, function () {
      if (seq === tabSeq) settleTabs();
    }, 'tab');

    positionThumbs(true);
  }

  function initTabs() {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('.tabs button'));
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
  function setupThumbs() {
    document.querySelectorAll('.models, .tabs').forEach(function (box) {
      var selector = box.classList.contains('tabs') ? '.tabs-thumb' : '.models-thumb';
      if (box.querySelector(selector)) return;
      var thumb = document.createElement('span');
      thumb.className = selector.slice(1);
      thumb.setAttribute('aria-hidden', 'true');
      box.insertBefore(thumb, box.firstChild);
    });
    positionThumbs();
  }

  function moveThumb(box, btn, animate) {
    var thumb = box.querySelector('.models-thumb, .tabs-thumb');
    if (!thumb || !btn || !btn.offsetWidth) return;
    if (!animate) thumb.style.transition = 'none';
    thumb.style.width = btn.offsetWidth + 'px';
    thumb.style.transform = 'translateX(' + btn.offsetLeft + 'px)';
    thumb.classList.add('ready');
    if (!animate) {
      void thumb.offsetWidth;         // 无动画地就位，避免首次显示从 0 滑过来
      thumb.style.transition = '';
    }
  }

  function positionThumbs(animate) {
    document.querySelectorAll('.models, .tabs').forEach(function (box) {
      var btn = box.querySelector('button.on') || box.querySelector('button');
      moveThumb(box, btn, animate === true);
    });
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
        resize(Math.min(180, box.clientWidth * img.naturalHeight / Math.max(1, img.naturalWidth)), true);
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

  function stopActiveWriter() {
    if (activeWriter) { activeWriter.stop(); activeWriter = null; }
  }

  function startWriter(el) {
    stopActiveWriter();
    var queue = '';
    var raf = 0;
    var done = false;
    var cursor = document.createElement('span');
    cursor.className = 'cursor';

    el.innerHTML = '';
    el.classList.remove('empty');
    el.appendChild(cursor);

    function paintPlain(text, keepCursor) {
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
      /* 按剩余量自适应：长文每帧最多 90 字，短句也不会在尾段变成 3 字/帧的点滴 */
      var n = Math.max(6, Math.min(queue.length, Math.min(90, Math.ceil(queue.length / 14))));
      var seg = queue.slice(0, n);
      queue = queue.slice(n);

      var span = document.createElement('span');
      span.className = 'st-seg';
      span.textContent = seg;
      var settled = false;
      function settle() {
        if (settled) return;
        settled = true;
        if (span.parentNode === el) el.replaceChild(document.createTextNode(seg), span);
      }
      span.addEventListener('animationend', settle);
      setTimeout(settle, cssDuration('--lg-duration-stream', 200) + 60);
      el.insertBefore(span, cursor);
      el.scrollTop = el.scrollHeight;
      raf = requestAnimationFrame(frame);
    }

    var writer = {
      closed: false,
      push: function (text) {
        if (writer.closed || !text) return;
        text = String(text);
        if (motionReduced()) {
          el.insertBefore(document.createTextNode(text), cursor);
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
          if (activeWriter === writer) activeWriter = null;
        }
      },
      stop: function () {
        writer.closed = true;
        done = true;
        queue = '';
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        if (activeWriter === writer) activeWriter = null;
      }
    };
    activeWriter = writer;
    return writer;
  }

  function runText() {
    if (state.running) return;
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

    state.running = true;
    state.controller = new AbortController();
    setBusy(go, true, image ? '视觉翻译中…' : '翻译中…');
    var writer = startWriter(out);
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
      buffer += chunk;
      writer.push(chunk);
    }, state.controller.signal).then(function (result) {
      if (writer.closed) return;
      writer.commit(result.text, true);
      var parts = [];
      if (result.usage) parts.push(result.usage.total_tokens + ' tokens');
      parts.push(fmtSeconds(result.ms));
      meta.textContent = parts.join(' · ');
    }).catch(function (error) {
      writer.stop();
      if (error && error.name === 'AbortError') {
        outText(out, buffer || '', false);
        meta.textContent = '已取消';
        return;
      }
      outText(out, '', false);
      out.textContent = '翻译失败：' + (error && error.message ? error.message : error);
      out.classList.remove('empty');
      meta.textContent = '';
    }).then(function () {
      state.running = false;
      state.controller = null;
      setBusy(go, false);
    });
  }

  function initTextPane() {
    on($('src'), 'input', refreshCount);

    on($('btn-pick-img'), 'click', function () {
      Bridge.pickImage(function (dataUrl) { setImage(dataUrl); });
    });

    on($('img-del'), 'click', function () { setImage(null); });

    on($('btn-paste'), 'click', function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        toast('当前环境不支持读取剪贴板');
        return;
      }
      navigator.clipboard.readText().then(function (text) {
        if (!text) { toast('剪贴板是空的'); return; }
        var src = $('src');
        src.value = (src.value ? src.value + '\n' : '') + text;
        refreshCount();
      }, function () { toast('读取剪贴板被拒绝'); });
    });

    on($('btn-go'), 'click', runText);

    on($('btn-clear'), 'click', function () {
      if (state.controller) state.controller.abort();
      stopActiveWriter();
      $('src').value = '';
      $('instruct').value = '';
      $('instruct-badge').hidden = true;
      setImage(null);
      outText($('out-text'), '', false);
      $('meta-text').textContent = '';
      refreshCount();
    });

    on($('btn-copy'), 'click', function () { copyText($('out-text').textContent); });

    on($('instruct'), 'input', function () {
      $('instruct-badge').hidden = !this.value.trim();
    });

    /* 桌面端划词翻译入口：Rust 侧捕获选区后调用 */
    window.__itTranslateSelection = function (text) {
      text = String(text == null ? '' : text).trim();
      if (!text) return;
      switchTab('text');
      if (text.length > MAX_SRC) text = text.slice(0, MAX_SRC);
      $('src').value = text;
      refreshCount();
      setImage(null);
      setTimeout(runText, 60);
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
      if (pending) setTimeout(function () { window.__itTranslateSelection(pending); }, 300);
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
    if (state.running) return;
    var text = ($('syl-src').value || '').trim();
    if (!text) { toast('先输入原文'); return; }

    var go = $('btn-go-syllable');
    var out = $('out-syllable');
    var meta = $('meta-syllable');
    var syllables = $('syl-count').value;

    state.running = true;
    state.controller = new AbortController();
    setBusy(go, true);
    var writer = startWriter(out);
    meta.textContent = '';

    var payload = basePayload(
      state.model.syllable,
      buildSyllablePrompt(text, syllables, state.tgt),
      maxTokensFor(text)
    );

    var buffer = '';
    chatStream(payload, function (chunk) {
      buffer += chunk;
      writer.push(chunk);
    }, state.controller.signal).then(function (result) {
      if (writer.closed) return;
      writer.commit(result.text, true);
      var parts = [];
      if (result.usage) parts.push(result.usage.total_tokens + ' tokens');
      parts.push(fmtSeconds(result.ms));
      meta.textContent = parts.join(' · ');
    }).catch(function (error) {
      writer.stop();
      if (error && error.name === 'AbortError') { meta.textContent = '已取消'; return; }
      out.textContent = '翻译失败：' + (error && error.message ? error.message : error);
      out.classList.remove('empty');
    }).then(function () {
      state.running = false;
      state.controller = null;
      setBusy(go, false);
    });
  }

  function initSyllablePane() {
    on($('syl-src'), 'input', function () {
      $('syl-count-label').textContent = (this.value || '').length + ' 字';
    });
    on($('btn-go-syllable'), 'click', runSyllable);
    on($('btn-clear-syllable'), 'click', function () {
      if (state.controller) state.controller.abort();
      stopActiveWriter();
      $('syl-src').value = '';
      $('syl-count-label').textContent = '0 字';
      outText($('out-syllable'), '', false);
      $('meta-syllable').textContent = '';
    });
    on($('btn-copy-syllable'), 'click', function () { copyText($('out-syllable').textContent); });
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
    if (state.running) return;
    var text = ($('doc-src').value || '').trim();
    if (!text) { toast('先粘贴长文或打开文件'); return; }

    var size = parseInt($('doc-chunk').value, 10) || 4000;
    var chunks = splitChunks(text, size);
    var go = $('btn-go-doc');
    var out = $('out-doc');
    var meta = $('meta-doc');
    var bar = $('doc-bar');

    state.running = true;
    state.controller = new AbortController();
    setBusy(go, true, '翻译中…');
    var writer = startWriter(out);
    bar.style.width = '0%';

    var done = [];
    var index = 0;

    function next() {
      if (index >= chunks.length) {
        writer.commit(done.join('\n\n'), true);
        meta.textContent = chunks.length + ' 块 · 完成';
        bar.style.width = '100%';
        return Promise.resolve();
      }
      var chunk = chunks[index];
      meta.textContent = '第 ' + (index + 1) + ' / ' + chunks.length + ' 块';
      var payload = basePayload(
        state.model.doc,
        plainPrompt(chunk, state.src, state.tgt),
        maxTokensFor(chunk)
      );

      var buffer = '';
      return chatStream(payload, function (delta) {
        buffer += delta;
        writer.push(delta);
      }, state.controller.signal).then(function (result) {
        done.push((result.text || buffer).trim());
        index++;
        bar.style.width = Math.round(index / chunks.length * 100) + '%';
        if (writer.closed) return Promise.resolve();
        /* 每块结束把已完成的段落校正为最终文本，下一块接着往后流 */
        writer.commit(done.join('\n\n') + (index < chunks.length ? '\n\n' : ''), false);
        return next();
      });
    }

    next().then(function () {
      state.running = false;
      state.controller = null;
      setBusy(go, false);
    }).catch(function (error) {
      state.running = false;
      state.controller = null;
      setBusy(go, false);
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
    on($('doc-src'), 'input', function () {
      var n = (this.value || '').length;
      $('doc-stat').textContent = n ? n.toLocaleString() + ' 字符' : '';
      $('doc-name').textContent = '原文';
    });

    on($('btn-doc-file'), 'click', function () { $('doc-file').click(); });

    on($('doc-file'), 'change', function () {
      var file = this.files && this.files[0];
      this.value = '';
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (ev) {
        $('doc-src').value = ev.target.result || '';
        $('doc-name').textContent = file.name;
        $('doc-stat').textContent = (ev.target.result || '').length.toLocaleString() + ' 字符';
      };
      reader.onerror = function () { toast('读取文件失败', true); };
      reader.readAsText(file);
    });

    on($('btn-go-doc'), 'click', runDoc);

    on($('btn-clear-doc'), 'click', function () {
      if (state.controller) state.controller.abort();
      stopActiveWriter();
      $('doc-src').value = '';
      $('doc-name').textContent = '原文';
      $('doc-stat').textContent = '';
      outText($('out-doc'), '', false);
      $('meta-doc').textContent = '';
      $('doc-bar').style.width = '0%';
    });

    on($('btn-copy-doc'), 'click', function () { copyText($('out-doc').textContent); });

    on($('btn-dl'), 'click', function () {
      var text = $('out-doc').textContent || '';
      if (!text.trim()) { toast('还没有译文'); return; }
      var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '译文.txt';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });
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
      'filter:blur(var(--it-bg-blur));}' +
      '.card{background:var(--lg-tint-0)!important;}' +
      '.card.out{background:var(--lg-tint-1)!important;}';
  }

  function restoreBackground() {
    applyBackground(activePreferences.background.data, activePreferences.background);
  }

  function initMenu() {
    var menu = $('more-menu');
    var brand = $('brand');
    if (!menu || !brand) return;
    menu.setAttribute('aria-hidden', 'true');
    menu.inert = true;
    var menuOrigin = brand;

    function closeMenu() {
      if (!menu.classList.contains('on')) return false;
      if (menu.contains(document.activeElement)) brand.focus({ preventScroll: true });
      menu.setAttribute('aria-hidden', 'true');
      menu.inert = true;
      moveSurface(menu, menuOrigin, false, function () { menu.hidden = true; });
      return true;
    }
    closeMenuLayer = closeMenu;

    function openAt(x, y, origin) {
      closeSelect();
      menuOrigin = origin || brand;
      menu.hidden = false;
      menu.setAttribute('aria-hidden', 'false');
      menu.inert = false;
      /* 先显示再量尺寸，避免贴边时溢出视口 */
      var w = menu.offsetWidth;
      var h = menu.offsetHeight;
      var left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
      var top = Math.max(8, Math.min(y, window.innerHeight - h - 8));
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
      moveSurface(menu, menuOrigin, true);
    }

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

      if (act === 'bg' || act === 'bg-reset' || act === 'settings') {
        if (window.__itOpenSettings) {
          window.__itOpenSettings({
            section: act === 'bg' || act === 'bg-reset' ? 'background' : 'appearance',
            resetBackground: act === 'bg-reset',
            origin: origin,
            trigger: brand
          });
        }
      } else if (act === 'about') {
        alert('笺 · 版本 2.1.0\n\n' +
          '翻译由 bilibili Index-Translate 提供，通过官方公开 API 接入。\n' +
          '本项目为非官方客户端，与哔哩哔哩无隶属关系。');
      }
    });
  }

  /* ---------------- 13. 玻璃折射 ---------------- */
  function initGlass() {
    var supportsBlur = false;
    try {
      supportsBlur = !!(window.CSS && CSS.supports &&
        (CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)')));
    } catch (e) {}
    if (!supportsBlur) {
      document.documentElement.classList.add('no-lg-blur');
      return;
    }
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    } catch (e) {}
  }

  /* ---------------- 14. 桌面端标题栏 ---------------- */
  /* 顶栏本身就是标题栏：右侧窗口按钮 + 空白处拖动，菜单挂在「笺」上 */
  function initTitlebar() {
    if (!Bridge.isDesktop) return;

    var actions = $('win-actions');
    if (actions) {
      actions.hidden = false;
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
    if (!Bridge.isDesktop) return;
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
  var DEFAULT_SETTINGS = {
    selection_shortcut: 'Ctrl+Alt+T', activation_shortcut: 'Ctrl+Alt+I',
    open_main_window: false, target_lang: 'auto', auto_start: false, start_to_tray: true,
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
            <button type="button" class="on" data-pref-tab="appearance">外观</button>
            <button type="button" data-pref-tab="background">背景</button>
            <button type="button" data-pref-tab="reading">阅读与布局</button>
            <button type="button" data-pref-tab="motion">动效</button>
            <button type="button" data-pref-tab="translation">翻译偏好</button>
            <button type="button" data-pref-tab="desktop" data-desktop-only hidden>电脑功能</button>
          </nav>
          <div class="it-set-body">
            <section class="it-set-page" data-pref-section="appearance">
              <h2>外观</h2>
              <div class="it-pref-preview"><span class="it-pref-preview-label">实时预览</span>
                <div class="it-pref-preview-card"><span>笺</span><span>原文 · 译文</span>
                  <b>清楚、舒适的阅读体验</b><i></i></div></div>
              <label class="it-set-row"><span>明暗主题</span><select id="it-pref-theme" data-pref="appearance.mode">
                <option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option>
              </select></label>
              <label class="it-set-row"><span>配色</span><select id="it-pref-palette" data-pref="appearance.palette">
                <option value="sakura">薄樱</option><option value="mist">雾蓝</option>
                <option value="sage">鼠尾草</option><option value="amber">暖杏</option>
              </select></label>
              <label class="it-set-row"><span>材质</span><select data-pref="appearance.material">
                <option value="glass">玻璃</option><option value="frosted">磨砂</option><option value="solid">纯色</option>
              </select></label>
              <label class="it-set-range"><span>玻璃强度 <output data-pref-output="appearance.glassStrength"></output></span>
                <input type="range" min="0" max="100" step="5" data-pref="appearance.glassStrength" data-pref-type="number"></label>
              <label class="it-set-row"><span>卡片圆角</span><select data-pref="appearance.radius">
                <option value="small">小</option><option value="standard">标准</option><option value="round">圆润</option>
              </select></label>
            </section>
            <section class="it-set-page" data-pref-section="reading" hidden>
              <h2>阅读与布局</h2>
              <label class="it-set-row"><span>内容字体</span><select data-pref="appearance.font">
                <option value="sans">系统无衬线</option><option value="serif">系统衬线</option><option value="mono">等宽</option>
              </select></label>
              <label class="it-set-range"><span>内容字号 <output data-pref-output="appearance.fontScale"></output></span>
                <input type="range" min="90" max="140" step="5" data-pref="appearance.fontScale" data-pref-type="number"></label>
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
                <option value="index-mt-2b">2B 快</option><option value="index-mt-9b">9B</option><option value="index-mt-35b">35B</option>
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
              <label class="it-set-row"><span>启动后最小化到托盘</span><input type="checkbox" class="it-set-check" id="it-set-starttotray"></label>
              <div class="it-set-note">自启动和启动到托盘设置下次启动时生效。</div>
            </section>
          </div>
        </div>
        <div class="it-set-foot"><button type="button" class="ghost" data-reset-section>恢复本组默认</button>
          <span class="sp"></span><button type="button" class="ghost" data-close="1">取消</button>
          <button type="button" class="primary" id="it-set-save">保存</button></div>
      </div>`;
    document.body.appendChild(modal);

    var recording = null;
    var dialog = modal.querySelector('.it-set');
    var settingsOrigin = null;
    var returnFocus = null;
    var backgroundState = [];
    var settingsSeq = 0;
    var backgroundPickSeq = 0;
    var settingsSaving = false;
    var activeSection = 'appearance';

    modal.querySelectorAll('[data-pref-tab="desktop"]').forEach(function (tab) {
      tab.hidden = !Bridge.isDesktop;
    });
    var langOptions = '<option value="auto">自动检测</option>';
    Object.keys(LANGS).forEach(function (code) {
      langOptions += '<option value="' + code + '">' + langName(code) + '</option>';
    });
    $('it-pref-source').innerHTML = langOptions;
    $('it-pref-target').innerHTML = langOptions.replace('<option value="auto">自动检测</option>', '');

    function fill() {
      if (!settingsState) return;
      modal.querySelectorAll('[data-pref]').forEach(function (control) {
        var value = valueAtPath(settingsState.preferences, control.getAttribute('data-pref'));
        if (control.type === 'checkbox') control.checked = !!value;
        else control.value = value == null ? '' : String(value);
      });
      modal.querySelectorAll('[data-pref-output]').forEach(function (output) {
        var value = valueAtPath(settingsState.preferences, output.getAttribute('data-pref-output'));
        var suffix = output.getAttribute('data-pref-output') === 'background.blur' ? ' px' :
          output.getAttribute('data-pref-output').indexOf('Scale') >= 0 ||
          output.getAttribute('data-pref-output') === 'background.opacity' ? '%' : '%';
        output.textContent = value + suffix;
      });
      $('it-set-selection').value = settingsState.selection_shortcut || '';
      $('it-set-activation').value = settingsState.activation_shortcut || '未设置';
      $('it-set-mode').value = settingsState.open_main_window ? 'main' : 'popup';
      $('it-set-lang').value = settingsState.target_lang || 'auto';
      $('it-set-autostart').checked = !!settingsState.auto_start;
      $('it-set-starttotray').checked = settingsState.start_to_tray !== false;
      $('it-pref-background-status').textContent = settingsState.preferences.background.data ?
        '已选择背景图片，保存设置后保留。' : '未选择背景图片。';
      modal.querySelectorAll('[data-pref-section]').forEach(function (section) {
        section.hidden = section.getAttribute('data-pref-section') !== activeSection;
      });
      modal.querySelectorAll('[data-pref-tab]').forEach(function (tab) {
        tab.classList.toggle('on', tab.getAttribute('data-pref-tab') === activeSection);
        tab.setAttribute('aria-current', tab.getAttribute('data-pref-tab') === activeSection ? 'page' : 'false');
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
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (!mods.length) { recording.input.value = '需要 Ctrl / Alt / Shift'; return; }
      settingsState[recording.key] = mods.join('+') + '+' + key;
      stopRecord();
      fill();
    }

    function startRecord(input, key) {
      stopRecord();
      recording = { input: input, key: key };
      input.classList.add('recording');
      input.value = '请按组合键…';
      document.addEventListener('keydown', onKey, true);
    }

    function enableControls(enabled) {
      modal.querySelectorAll('.it-set-body input, .it-set-body select, .it-set-body button, #it-set-save, [data-reset-section]')
        .forEach(function (control) { control.disabled = !enabled; });
    }

    function close() {
      if (!modal.classList.contains('on')) return false;
      if (settingsSaving) return true;
      stopRecord();
      closeSelect();
      settingsSeq++;
      settingsState = committedSettings ? copyObject(committedSettings) : copyObject(DEFAULT_SETTINGS);
      applyPreferences(settingsState.preferences);
      fill();
      backgroundState.forEach(function (entry) { entry.el.inert = entry.inert; });
      backgroundState = [];
      if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
      modal.classList.remove('on');
      modal.classList.add('it-surface-leave');
      modal.setAttribute('aria-hidden', 'true');
      modal.inert = true;
      moveSurface(dialog, settingsOrigin, false, function () { modal.classList.remove('it-surface-leave'); });
      if (Bridge.isDesktop) Bridge.invoke('it_set_hotkeys_enabled', { enabled: true }).catch(function () {});
      return true;
    }
    closeSettingsLayer = close;

    window.__itOpenSettings = function (source) {
      if (modal.classList.contains('on')) return;
      closeSelect();
      var seq = ++settingsSeq;
      activeSection = source && source.section ? source.section : 'appearance';
      if (activeSection === 'desktop' && !Bridge.isDesktop) activeSection = 'appearance';
      returnFocus = (source && source.trigger) || document.activeElement;
      settingsOrigin = (source && source.origin) || rectOf(returnFocus);
      settingsState = settingsFromSaved(null, activePreferences);
      var resetBackgroundOnOpen = !!(source && source.resetBackground);
      committedSettings = copyObject(settingsState);
      if (resetBackgroundOnOpen) settingsState.preferences.background.data = '';
      modal.inert = false;
      modal.setAttribute('aria-hidden', 'false');
      modal.classList.remove('it-surface-leave');
      modal.classList.add('on');
      fill();
      backgroundState = Array.prototype.slice.call(document.body.children).filter(function (el) {
        return el !== modal && !/^(SCRIPT|STYLE)$/.test(el.tagName);
      }).map(function (el) {
        var entry = { el: el, inert: el.inert };
        el.inert = true;
        return entry;
      });
      moveSurface(dialog, settingsOrigin, true);
      dialog.querySelector('[data-close]').focus({ preventScroll: true });
      if (resetBackgroundOnOpen) applyPreferences(settingsState.preferences);
      if (Bridge.isDesktop) {
        enableControls(false);
        $('it-set-status').textContent = '读取中';
        Bridge.invoke('it_set_hotkeys_enabled', { enabled: false }).catch(function () {});
        Bridge.invoke('it_get_settings').then(function (saved) {
          if (seq !== settingsSeq || !modal.classList.contains('on')) return;
          settingsState = settingsFromSaved(saved, readSavedPreferences());
          committedSettings = copyObject(settingsState);
          if (resetBackgroundOnOpen) settingsState.preferences.background.data = '';
          applyPreferences(settingsState.preferences);
          fill();
          $('it-set-status').textContent = '';
          enableControls(true);
        }).catch(function (error) {
          if (seq !== settingsSeq) return;
          $('it-set-status').textContent = '读取失败，请关闭后重试';
          toast('设置读取失败：' + error, true);
        });
      } else {
        applyPreferences(settingsState.preferences);
        $('it-set-status').textContent = '';
        enableControls(true);
      }
    };

    on(modal, 'click', function (e) {
      if (e.target === modal || (e.target.closest && e.target.closest('[data-close]'))) close();
      var tab = e.target.closest && e.target.closest('[data-pref-tab]');
      if (tab && !tab.disabled) {
        activeSection = tab.getAttribute('data-pref-tab');
        fill();
      }
      if (e.target.closest && e.target.closest('[data-reset-section]')) {
        var defaults = copyObject(DEFAULT_PREFERENCES);
        if (activeSection === 'desktop') {
          var preservedPreferences = copyObject(settingsState.preferences);
          settingsState = copyObject(DEFAULT_SETTINGS);
          settingsState.preferences = preservedPreferences;
        } else if (activeSection === 'reading') {
          settingsState.preferences.appearance.font = defaults.appearance.font;
          settingsState.preferences.appearance.fontScale = defaults.appearance.fontScale;
          settingsState.preferences.appearance.layout = defaults.appearance.layout;
        } else if (activeSection === 'motion') {
          settingsState.preferences.appearance.motion = defaults.appearance.motion;
          settingsState.preferences.appearance.ambientLight = defaults.appearance.ambientLight;
        } else if (activeSection === 'appearance') {
          ['mode', 'palette', 'material', 'glassStrength', 'radius'].forEach(function (key) {
            settingsState.preferences.appearance[key] = defaults.appearance[key];
          });
        } else {
          settingsState.preferences[activeSection === 'appearance' ? 'appearance' :
            activeSection === 'background' ? 'background' : 'translation'] =
            defaults[activeSection === 'appearance' ? 'appearance' :
              activeSection === 'background' ? 'background' : 'translation'];
        }
        applyPreferences(settingsState.preferences);
        fill();
      }
      if (e.target.closest && e.target.closest('#it-pref-pick-background')) {
        var selection = ++backgroundPickSeq;
        var session = settingsSeq;
        Bridge.pickImage(function (dataUrl) {
          if (!dataUrl || !settingsState || session !== settingsSeq ||
              selection !== backgroundPickSeq || !modal.classList.contains('on')) return;
          shrinkImage(dataUrl, function (compressed) {
            if (!settingsState || session !== settingsSeq || selection !== backgroundPickSeq ||
                !modal.classList.contains('on')) return;
            settingsState.preferences.background.data = compressed;
            applyPreferences(settingsState.preferences);
            fill();
          });
        });
      }
      if (e.target.closest && e.target.closest('#it-pref-reset-background')) {
        backgroundPickSeq++;
        settingsState.preferences.background.data = '';
        applyPreferences(settingsState.preferences);
        fill();
      }
    });
    on(modal, 'keydown', function (e) {
      if (e.key !== 'Tab' || !modal.classList.contains('on')) return;
      var focusable = Array.prototype.slice.call(dialog.querySelectorAll('button, input, select, [tabindex]'))
        .filter(function (el) { return !el.disabled && !el.hidden && el.tabIndex >= 0 && el.getClientRects().length; });
      if (!focusable.length) { e.preventDefault(); dialog.focus(); return; }
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    });
    on($('it-set-selection'), 'click', function () { startRecord(this, 'selection_shortcut'); });
    on($('it-set-activation'), 'click', function () { startRecord(this, 'activation_shortcut'); });
    on($('it-set-mode'), 'change', function () { settingsState.open_main_window = this.value === 'main'; });
    on($('it-set-lang'), 'change', function () { settingsState.target_lang = this.value; });
    on($('it-set-autostart'), 'change', function () { settingsState.auto_start = this.checked; });
    on($('it-set-starttotray'), 'change', function () { settingsState.start_to_tray = this.checked; });

    function updatePreference(control) {
      if (settingsSaving || !settingsState || !control.hasAttribute('data-pref')) return;
      var value = control.type === 'checkbox' ? control.checked : control.value;
      if (control.getAttribute('data-pref-type') === 'number') value = Number(value);
      assignAtPath(settingsState.preferences, control.getAttribute('data-pref'), value);
      settingsState.preferences = normalizePreferences(settingsState.preferences);
      applyPreferences(settingsState.preferences);
      fill();
    }
    on(modal, 'input', function (e) { updatePreference(e.target); });
    on(modal, 'change', function (e) { updatePreference(e.target); });

    on($('it-set-save'), 'click', function () {
      if (settingsSaving) return;
      stopRecord();
      closeSelect();
      backgroundPickSeq++;
      var submission = copyObject(settingsState);
      settingsSaving = true;
      var button = this;
      delete button.dataset.cacheError;
      enableControls(false);
      modal.querySelectorAll('.it-set-nav button, [data-close]').forEach(function (control) {
        control.disabled = true;
      });
      $('it-set-status').textContent = '保存中';
      function unlock() {
        settingsSaving = false;
        enableControls(true);
        modal.querySelectorAll('.it-set-nav button, [data-close]').forEach(function (control) {
          control.disabled = false;
        });
        $('it-set-status').textContent = '';
      }
      var finishSave = function () {
        try {
          localStorage.setItem(PREFERENCES_KEY, JSON.stringify(submission.preferences));
        } catch (error) {
          if (!Bridge.isDesktop) {
            unlock();
            toast('设置保存失败：' + error, true);
            return;
          }
          button.dataset.cacheError = 'true';
        }
        if (Bridge.isAndroid && window.NativeBridge &&
            typeof window.NativeBridge.commitAppearance === 'function') {
          try {
            if (!window.NativeBridge.commitAppearance(nativeAppearanceSnapshot(submission.preferences))) {
              button.dataset.cacheError = 'true';
            }
          } catch (error) {
            button.dataset.cacheError = 'true';
          }
        }
        committedSettings = copyObject(submission);
        settingsState = copyObject(submission);
        applyPreferences(committedSettings.preferences);
        unlock();
        toast(button.dataset.cacheError === 'true' ?
          (Bridge.isAndroid ? '设置已保存；原生外观缓存未能更新' : '设置已保存；本机缓存未能更新') :
          '设置已保存', button.dataset.cacheError === 'true');
        delete button.dataset.cacheError;
        close();
      };
      if (!Bridge.isDesktop) { finishSave(); return; }
      Bridge.invoke('it_save_settings', { settings: submission }).then(function (errors) {
        if (errors && errors.length) {
          unlock();
          toast(errors.join('；'), true);
          return;
        }
        finishSave();
      }).catch(function (error) {
        unlock();
        toast('保存失败：' + error, true);
      });
    });

    if (Bridge.isDesktop) Bridge.invoke('it_set_hotkeys_enabled', { enabled: true }).catch(function () {});
  }

  /* ---------------- 15. 初始化 ---------------- */
  function init() {
    if (PLATFORM === 'desktop') document.documentElement.classList.add('it-desktop');
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

    on(window, 'resize', function () {
      finishMotions();
      positionThumbs(false);
      if (openSelect && openSelect.position) openSelect.position();
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
        if (bootReleased) return;
        if (savedSettings && savedSettings.preferences) {
          activePreferences = normalizePreferences(savedSettings.preferences);
          applyPreferences(activePreferences);
          restoreTranslationPreferences(activePreferences);
        }
      }).catch(function () {}).then(function () {
        if (bootReleased) return;
        clearTimeout(bootTimer);
        document.documentElement.classList.remove('it-settings-boot');
      });
    }

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
