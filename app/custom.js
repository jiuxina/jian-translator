/* ==========================================================================
   Index-Translate 壳：默认模型设为 2B（快）
   --------------------------------------------------------------------------
   官网脚本在末尾写死了 setModel("index-mt-9b")。这里在官网脚本之后调用一次
   setModel("index-mt-2b")，让每次打开都默认落在 2B。
   不改官网任何逻辑：用户仍可手动切到 9B / 35B；输入指令内容时，官网自身
   会把 2B 自动升到 9B（2B 不遵循格式指令），这是官网行为，原样保留。
   仅在文本/图片翻译页生效，其它页面自动跳过。
   ========================================================================== */
(function () {
  var DEFAULT_MODEL = 'index-mt-2b';
  var userPicked = false;

  // 用户自己点过模型按钮就不再干预
  document.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('#modelSeg button')) {
      userPicked = true;
    }
  }, true);

  function apply() {
    try {
      var select = document.getElementById('model');
      var button = document.querySelector('#modelSeg button[data-m="' + DEFAULT_MODEL + '"]');

      // 当前不是文本/图片翻译页
      if (!select && !button) return false;

      // 官网在指令框有内容时会主动把 2B 升到 9B（2B 不遵循格式指令），
      // 这种情况不能抢回来，否则用户和官网逻辑会互相打架。
      var instruct = document.getElementById('instruct');
      if (instruct && instruct.value && instruct.value.trim()) return false;

      // 已经是 2B，不动
      if (select && select.value === DEFAULT_MODEL) return true;

      if (typeof window.setModel === 'function') {
        window.setModel(DEFAULT_MODEL);
      } else if (button) {
        button.click();
      } else if (select) {
        select.value = DEFAULT_MODEL;
      }
      return true;
    } catch (e) {
      // 静默失败：宁可保持官网默认，也不影响页面本身
      return false;
    }
  }

  // 官网脚本里还有异步初始化，可能在 DOMContentLoaded 之后又把模型改回 9B。
  // 这里做 2.4 秒的短轮询兜底，只在这段时间内纠正，不会长期和页面抢状态。
  var tries = 0;
  function tick() {
    if (userPicked) return;
    apply();
    if (++tries < 12) setTimeout(tick, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(tick, 0);
    });
  } else {
    setTimeout(tick, 0);
  }
})();

/* ==========================================================================
   手机端：点「开始翻译」自动滚到译文，点「清空」自动滚回原文
   --------------------------------------------------------------------------
   窄屏下原文框和译文框是上下排列的，译文在屏幕外，翻完还停在原文那一段。
   这里在按钮点击后平滑滚动到对应卡片，桌面宽屏不介入（本来同屏可见）。
   用捕获阶段监听，保证在官网自己的 onclick 之前拿到点击，再延后执行滚动，
   等官网把"翻译中…"/清空后的 DOM 更新完再滚。
   ========================================================================== */
(function () {
  var NARROW = '(max-width: 720px)';

  function isNarrow() {
    try {
      return window.matchMedia(NARROW).matches;
    } catch (e) {
      return false;
    }
  }

  function scrollTo(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      el.scrollIntoView(true);
    }
  }

  function paneAt(index) {
    var panes = document.querySelectorAll('.panes .pane');
    return panes.length > index ? panes[index] : null;
  }

  document.addEventListener('click', function (e) {
    if (!isNarrow()) return;
    var btn = e.target && e.target.closest ? e.target.closest('#go, #clear') : null;
    if (!btn) return;

    var toTranslation = btn.id === 'go';
    setTimeout(function () {
      if (toTranslation) {
        scrollTo(paneAt(1) || document.getElementById('out'));
      } else {
        scrollTo(paneAt(0) || document.getElementById('src'));
      }
    }, 60);
  }, true);
})();

/* ==========================================================================
   安卓原生相机：拍完照片回填后自动开始翻译
   --------------------------------------------------------------------------
   原生的文件选择回调把照片交给页面后，官网要等 FileReader 读完才显示预览，
   这里轮询预览框，等图片真的填进去再点一次「开始翻译」，做到拍完即译。
   ========================================================================== */
(function () {
  window.__itAutoTranslateImage = function () {
    var tries = 0;
    (function poll() {
      var box = document.getElementById('imgPreviewBox');
      var ready = box && box.style.display !== 'none';
      if (ready) {
        var go = document.getElementById('go');
        if (go && !go.disabled) {
          go.click();
        }
        return;
      }
      if (++tries > 50) return;
      setTimeout(poll, 100);
    })();
  };
})();

/* ==========================================================================
   自定义背景图片
   --------------------------------------------------------------------------
   安卓：原生「⋯」菜单选图 → 压缩后存内部存储 → 通过官网同域的虚拟地址
         /__app_bg__ 由 shouldInterceptRequest 提供 → 调用 __itSetBackground。
   Windows：没有原生菜单，页面里放一个悬浮按钮，选图压缩成 dataURL 存
            localStorage，重开应用自动恢复。
   两端都加一层半透明白色蒙版，保证照片上文字仍清晰。
   ========================================================================== */
(function () {
  var STYLE_ID = 'it-bg-style';
  var STORE_KEY = 'it-bg-data';

  function rules(url) {
    // 自定义背景模式下不再铺白板：蒙版只压到 .34，卡片/双栏改用玻璃 tint，
    // 让照片透过玻璃。fallback 值偏白，保证主题回退时文字仍然可读。
    return 'body{' +
      'background-image:linear-gradient(rgba(255,255,255,.34),rgba(255,255,255,.34)),' +
      'url("' + url + '")!important;' +
      'background-size:cover!important;background-position:center center!important;' +
      'background-repeat:no-repeat!important;background-attachment:fixed!important;' +
      '}' +
      '.atcard,.card{background:var(--lg-tint-0, rgba(255,255,255,.82))!important;}' +
      '.panes{background:var(--lg-tint-0, rgba(255,255,255,.78))!important;}' +
      '.pane{background:var(--lg-tint-1, rgba(255,255,255,.86))!important;}' +
      '.at-aurora{opacity:.28;}' +
      '.at-glyphs{opacity:.14;}';
  }

  function apply(url) {
    if (!url) return;
    var style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = rules(url);
  }

  function reset() {
    var style = document.getElementById(STYLE_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  }

  // 供安卓原生端调用
  window.__itSetBackground = apply;
  window.__itResetBackground = reset;

  function shrink(dataUrl, done) {
    var img = new Image();
    img.onload = function () {
      try {
        var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        done(canvas.toDataURL('image/jpeg', 0.82));
      } catch (e) {
        done(dataUrl);
      }
    };
    img.onerror = function () { done(dataUrl); };
    img.src = dataUrl;
  }

  function pickImage() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) { input.remove(); return; }
      var reader = new FileReader();
      reader.onload = function (ev) {
        shrink(ev.target.result, function (dataUrl) {
          try { localStorage.setItem(STORE_KEY, dataUrl); } catch (e) {}
          apply(dataUrl);
          input.remove();
        });
      };
      reader.onerror = function () { input.remove(); };
      reader.readAsDataURL(file);
    });
    input.click();
  }

  function initDesktop() {
    // 安卓有原生菜单，网页里不放悬浮按钮
    if (document.documentElement.classList.contains('it-app')) return;
    if (document.getElementById('it-bg-fab')) return;

    try {
      var saved = localStorage.getItem(STORE_KEY);
      if (saved) apply(saved);
    } catch (e) {}

    var fab = document.createElement('button');
    fab.id = 'it-bg-fab';
    fab.className = 'it-bg-fab';
    fab.type = 'button';
    fab.title = '更换背景';
    fab.textContent = '🖼️';
    document.body.appendChild(fab);

    var panel = document.createElement('div');
    panel.id = 'it-bg-panel';
    panel.className = 'it-bg-panel';
    panel.style.display = 'none';
    panel.innerHTML = '<button type="button" data-act="pick">更换背景</button>' +
      '<button type="button" data-act="reset">恢复默认</button>' +
      '<button type="button" data-act="settings">设置…</button>';
    document.body.appendChild(panel);

    fab.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    panel.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest
        ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      panel.style.display = 'none';
      if (btn.getAttribute('data-act') === 'reset') reset();
      else if (btn.getAttribute('data-act') === 'settings') {
        if (typeof window.__itOpenSettings === 'function') window.__itOpenSettings();
      } else pickImage();
    });
    document.addEventListener('click', function (e) {
      if (panel.style.display !== 'none' && e.target !== fab && !panel.contains(e.target)) {
        panel.style.display = 'none';
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDesktop);
  } else {
    initDesktop();
  }
})();

/* ==========================================================================
   电脑端划词翻译
   --------------------------------------------------------------------------
   两条触发路径：
   · 全局热键 Ctrl+Alt+T（Rust 侧模拟 Ctrl+C 读剪贴板）→ 调用
     window.__itTranslateSelection(text)，并唤起/聚焦窗口；
   · 页面内用鼠标选中文字 → 选区上方出现「译」浮标 → 点击即翻译。
   只在桌面版生效（安卓用 html.it-app 标记，这里直接跳过）。
   ========================================================================== */
(function () {
  if (document.documentElement.classList.contains('it-app')) return;

  var lastText = '';
  var lastAt = 0;
  var bubble = null;

  function isTranslatePage() {
    return !!(document.getElementById('model') && document.getElementById('go'));
  }

  function translate(text) {
    text = String(text == null ? '' : text).trim();
    if (!text) return;

    // 热键可能被系统重复触发，短时间内相同文本只处理一次
    var now = Date.now();
    if (text === lastText && now - lastAt < 2500) return;
    lastText = text;
    lastAt = now;
    text = text.slice(0, 8000);

    if (!isTranslatePage()) {
      try { sessionStorage.setItem('it-pending-selection', text); } catch (e) {}
      location.href = 'https://index-translate.bilibili.com/site/translate.html?lang=zh';
      return;
    }

    var src = document.getElementById('src');
    if (!src) return;
    // 图片翻译与划词互斥，先清掉可能已有的图片
    if (typeof window.clearImage === 'function') {
      try { window.clearImage(); } catch (e) {}
    }
    src.value = text;
    src.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(function () {
      var go = document.getElementById('go');
      if (go && !go.disabled) go.click();
    }, 80);
  }

  window.__itTranslateSelection = translate;

  function consumePending() {
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
    if (pending) setTimeout(function () { translate(pending); }, 450);
  }
  consumePending();

  function hideBubble() {
    if (bubble) {
      bubble.remove();
      bubble = null;
    }
  }

  function showBubble(text, x, y) {
    hideBubble();
    bubble = document.createElement('button');
    bubble.className = 'it-sel-btn';
    bubble.type = 'button';
    bubble.textContent = '译';
    bubble.title = '翻译选中文字';
    bubble.style.left = x + 'px';
    bubble.style.top = y + 'px';
    bubble.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
    });
    bubble.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var value = text;
      hideBubble();
      translate(value);
    });
    document.body.appendChild(bubble);
  }

  document.addEventListener('mouseup', function () {
    setTimeout(function () {
      var sel = window.getSelection();
      var text = sel ? String(sel).trim() : '';
      if (!text || text.length > 8000 || sel.rangeCount === 0) {
        hideBubble();
        return;
      }
      // 输入框里的选中不弹浮标，避免误替换正在编辑的内容
      var node = sel.anchorNode;
      var el = node && (node.nodeType === 3 ? node.parentElement : node);
      if (el && el.closest && el.closest('input, textarea, [contenteditable="true"]')) {
        hideBubble();
        return;
      }
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) {
        hideBubble();
        return;
      }
      showBubble(text,
        Math.max(24, Math.min(window.innerWidth - 24, rect.left + rect.width / 2)),
        Math.max(40, rect.top - 10));
    }, 10);
  });

  document.addEventListener('mousedown', function (e) {
    if (bubble && !bubble.contains(e.target)) hideBubble();
  });
  window.addEventListener('scroll', hideBubble, true);
  window.addEventListener('resize', hideBubble);
})();

/* ==========================================================================
   电脑端设置面板
   --------------------------------------------------------------------------
   快捷键、划词展示方式、悬浮窗目标语言都保存在 Rust 侧
   （%APPDATA%/com.bilibili.index-translate/desktop-settings.json），
   保存时通过 Tauri 命令热更新全局快捷键，不需要重启应用。
   ========================================================================== */
(function () {
  if (document.documentElement.classList.contains('it-app')) return;

  var DEFAULTS = {
    selection_shortcut: 'Ctrl+Alt+T',
    activation_shortcut: 'Ctrl+Alt+I',
    open_main_window: false,
    target_lang: 'auto',
    auto_start: false,
    start_to_tray: true
  };
  var state = null;
  var modal = null;
  var recording = null;
  var toastTimer = 0;

  function tauriInvoke(cmd, args) {
    // 远程页面不一定注入 window.__TAURI__，但底层 IPC 入口一定存在
    var internals = window.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function') {
      return internals.invoke(cmd, args || {}, {});
    }
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      return window.__TAURI__.core.invoke(cmd, args);
    }
    return Promise.reject(new Error('Tauri IPC 不可用'));
  }

  function toast(message, isError) {
    var box = document.getElementById('it-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'it-toast';
      box.className = 'it-toast';
      document.body.appendChild(box);
    }
    box.textContent = message;
    box.classList.toggle('error', !!isError);
    box.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.remove('on'); }, 2600);
  }

  function build() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'it-set-mask';
    modal.innerHTML =
      '<div class="it-set" role="dialog" aria-label="设置">' +
        '<div class="it-set-head"><b>设置</b>' +
          '<button type="button" class="it-set-x" data-close="1" aria-label="关闭">×</button></div>' +
        '<div class="it-set-body">' +
          '<label class="it-set-row"><span>划词翻译快捷键</span>' +
            '<input type="text" id="it-set-selection" readonly placeholder="点击后按组合键"></label>' +
          '<label class="it-set-row"><span>显示 / 隐藏窗口</span>' +
            '<input type="text" id="it-set-activation" readonly placeholder="点击后按组合键"></label>' +
          '<label class="it-set-row"><span>划词结果显示</span>' +
            '<select id="it-set-mode">' +
              '<option value="popup">鼠标旁悬浮窗</option>' +
              '<option value="main">打开主窗口</option>' +
            '</select></label>' +
          '<label class="it-set-row"><span>悬浮窗目标语言</span>' +
            '<select id="it-set-lang">' +
              '<option value="auto">自动判断</option>' +
              '<option value="zh">中文</option>' +
              '<option value="en">英文</option>' +
            '</select></label>' +
          '<label class="it-set-row"><span>开机自动启动</span>' +
            '<input type="checkbox" class="it-set-check" id="it-set-autostart"></label>' +
          '<label class="it-set-row"><span>启动后最小化到托盘</span>' +
            '<input type="checkbox" class="it-set-check" id="it-set-starttotray"></label>' +
          '<div class="it-set-note" id="it-set-note">点击快捷键输入框后直接按组合键（需包含 Ctrl / Alt / Shift）。开机自启、启动到托盘在下次启动生效。</div>' +
        '</div>' +
        '<div class="it-set-foot">' +
          '<button type="button" class="ghost" id="it-set-default">恢复默认</button>' +
          '<span class="sp"></span>' +
          '<button type="button" class="ghost" data-close="1">取消</button>' +
          '<button type="button" class="primary" id="it-set-save">保存</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    modal.addEventListener('click', function (e) {
      if (e.target === modal || (e.target.closest && e.target.closest('[data-close]'))) {
        close();
      }
    });

    document.getElementById('it-set-selection').addEventListener('click', function () {
      startRecord(this, 'selection_shortcut');
    });
    document.getElementById('it-set-activation').addEventListener('click', function () {
      startRecord(this, 'activation_shortcut');
    });

    document.getElementById('it-set-default').addEventListener('click', function () {
      state = JSON.parse(JSON.stringify(DEFAULTS));
      fill();
    });

    document.getElementById('it-set-mode').addEventListener('change', function () {
      state.open_main_window = this.value === 'main';
    });
    document.getElementById('it-set-lang').addEventListener('change', function () {
      state.target_lang = this.value;
    });
    document.getElementById('it-set-autostart').addEventListener('change', function () {
      state.auto_start = this.checked;
    });
    document.getElementById('it-set-starttotray').addEventListener('change', function () {
      state.start_to_tray = this.checked;
    });

    document.getElementById('it-set-save').addEventListener('click', function () {
      var button = this;
      button.disabled = true;
      tauriInvoke('it_save_settings', { settings: state }).then(function (errors) {
        button.disabled = false;
        if (errors && errors.length) {
          toast(errors.join('；'), true);
        } else {
          toast('设置已保存');
          close();
        }
      }).catch(function (error) {
        button.disabled = false;
        toast('保存失败：' + error, true);
      });
    });

    return modal;
  }

  function fill() {
    document.getElementById('it-set-selection').value = state.selection_shortcut;
    document.getElementById('it-set-activation').value = state.activation_shortcut || '未设置';
    document.getElementById('it-set-mode').value = state.open_main_window ? 'main' : 'popup';
    document.getElementById('it-set-lang').value = state.target_lang || 'auto';
    document.getElementById('it-set-autostart').checked = !!state.auto_start;
    // 旧版设置文件没有这个字段时，按默认开启处理
    document.getElementById('it-set-starttotray').checked = state.start_to_tray !== false;
  }

  function startRecord(input, key) {
    if (recording) stopRecord();
    recording = { input: input, key: key };
    input.classList.add('recording');
    input.value = '请按组合键…';
    document.addEventListener('keydown', onKeyDown, true);
  }

  function stopRecord() {
    if (!recording) return;
    recording.input.classList.remove('recording');
    document.removeEventListener('keydown', onKeyDown, true);
    recording = null;
  }

  function onKeyDown(e) {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      stopRecord();
      fill();
      return;
    }
    var key = e.key;
    if (key.length === 1) {
      key = key.toUpperCase();
    } else if (!/^F([1-9]|1[0-2])$/.test(key)) {
      return; // 忽略 Tab / Shift 这类键
    }
    var mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (!mods.length) {
      recording.input.value = '需要 Ctrl / Alt / Shift';
      return;
    }
    state[recording.key] = mods.join('+') + '+' + key;
    stopRecord();
    fill();
  }

  function open() {
    if (!state) state = JSON.parse(JSON.stringify(DEFAULTS));
    build().classList.add('on');
    fill();
    // 录快捷键时先停掉全局热键，避免按下旧组合键直接触发翻译
    tauriInvoke('it_set_hotkeys_enabled', { enabled: false }).catch(function () {});
    tauriInvoke('it_get_settings').then(function (saved) {
      if (saved) {
        state = saved;
        fill();
      }
    }).catch(function () {
      var note = document.getElementById('it-set-note');
      note.textContent = '读取系统设置失败：' + (arguments[0] && arguments[0].message ? arguments[0].message : '未知错误');
      note.classList.add('warn');
    });
  }

  function close() {
    stopRecord();
    if (modal) modal.classList.remove('on');
    tauriInvoke('it_set_hotkeys_enabled', { enabled: true }).catch(function () {});
  }

  window.__itOpenSettings = open;

  // 页面重新加载后恢复全局热键（防止上次开着设置面板退出）
  if (document.readyState === 'complete') {
    tauriInvoke('it_set_hotkeys_enabled', { enabled: true }).catch(function () {});
  } else {
    window.addEventListener('load', function () {
      tauriInvoke('it_set_hotkeys_enabled', { enabled: true }).catch(function () {});
    });
  }
})();

/* ==========================================================================
   自绘标题栏（无边框窗口）
   --------------------------------------------------------------------------
   rebuild.sh 用 --hide-window-decorations 去掉系统边框，这里画一条与页面同
   风格的标题栏。窗口动作全部走 it_window_action，并先用 it_debug_log 记录
   事件，方便确认点击链路。
   ========================================================================== */
(function () {
  if (document.documentElement.classList.contains('it-app')) return;
  if (!window.__TAURI_INTERNALS__ && !(window.__TAURI__ && window.__TAURI__.core)) return;
  if (window.pakeConfig && window.pakeConfig.hide_window_decorations === false) return;

  function invoke(cmd, args) {
    var internals = window.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function') {
      return internals.invoke(cmd, args || {}, {});
    }
    return window.__TAURI__.core.invoke(cmd, args);
  }

  function log(message) {
    try {
      invoke('it_debug_log', { message: message }).catch(function () {});
    } catch (e) {}
  }

  function pageLabel() {
    var path = location.pathname;
    var en = document.documentElement.lang === 'en' ||
      /[?&]lang=en(?:&|$)/.test(location.search);
    if (/syllable/.test(path)) return en ? 'Syllable-controlled translation' : '音节控制翻译';
    if (/\/doc\.html/.test(path)) return en ? 'Long document translation' : '长文本翻译';
    if (/\/index\.html/.test(path) || /echo/i.test(path)) return en ? 'Speech translation' : '语音翻译';
    return en ? 'Text & image translation' : '文本与图片翻译';
  }

  var ICONS = {
    minimize: '<svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M1.5 5.5h8"/></svg>',
    maximize: '<svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1.8" y="1.8" width="7.4" height="7.4" rx="1"/></svg>',
    close: '<svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 2l7 7M9 2l-7 7"/></svg>'
  };

  document.documentElement.classList.add('it-titlebar-on');

  var bar = document.createElement('div');
  bar.className = 'it-titlebar';
  bar.innerHTML =
    '<div class="it-tb-left">' +
      '<span class="it-tb-dot"></span>' +
      '<span class="it-tb-brand">笺</span>' +
      '<span class="it-tb-sep"></span>' +
      '<span class="it-tb-page" id="it-tb-page"></span>' +
    '</div>' +
    '<div class="it-tb-actions">' +
      '<button type="button" data-act="minimize" title="最小化">' + ICONS.minimize + '</button>' +
      '<button type="button" data-act="maximize" title="最大化 / 还原">' + ICONS.maximize + '</button>' +
      '<button type="button" class="it-tb-close" data-act="close" title="关闭（隐藏到托盘）">' + ICONS.close + '</button>' +
    '</div>';
  document.body.appendChild(bar);

  function refreshLabel() {
    var label = document.getElementById('it-tb-page');
    if (label) label.textContent = pageLabel();
  }
  refreshLabel();
  document.addEventListener('atlang', refreshLabel);

  function act(name) {
    // 统一走自定义命令：内置 window 插件命令在远程页面被 ACL 拒绝
    invoke('it_window_action', { action: name }).catch(function () {});
  }

  // 关键：用 mousedown 而不是 click，避免被拖动区的指针处理吞掉
  bar.querySelector('.it-tb-actions').addEventListener('mousedown', function (e) {
    var button = e.target.closest && e.target.closest('button[data-act]');
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    act(button.getAttribute('data-act'));
  }, true);

  // 空白处：拖动；快速双击：最大化/还原
  var lastDown = 0;
  bar.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest('button[data-act]')) return;
    e.preventDefault();
    var now = Date.now();
    if (now - lastDown < 320) {
      lastDown = 0;
      act('maximize');
    } else {
      lastDown = now;
      act('drag');
    }
  });
})();

/* ==========================================================================
   薄樱信笺主题：液态玻璃 / 译文淡入 / 文字精简
   --------------------------------------------------------------------------
   只在主题层启用时生效（检测 theme-sakura.css 注入的 --sk-accent）。
   液态玻璃的 SVG 折射滤镜与三层 DOM 原样取自
   lucasromerodb/liquid-glass-effect-macos (826★)：
   https://github.com/lucasromerodb/liquid-glass-effect-macos
   原仓库未附 LICENSE，分发前请确认授权（见 docs/ui-theme.md）。
   ========================================================================== */
(function () {
  var THEME_GLASS = true;   // 关掉即完全不注入玻璃层
  var THEME_FADE  = true;   // 译文出现时淡入（等效 animate.css 的 fadeInUp）

  // v3 液态玻璃主题带 --lg-tint-1：折射由 __itLiquidGlassSystem 接管，
  // 但译文淡入两代主题都要用，所以这里只判断「有没有启用任意一代主题」。
  function v3On() {
    try {
      return getComputedStyle(document.documentElement)
        .getPropertyValue('--lg-tint-1').trim() !== '';
    } catch (e) { return false; }
  }

  function themeOn() {
    try {
      var style = getComputedStyle(document.documentElement);
      return style.getPropertyValue('--sk-accent').trim() !== '' ||
             style.getPropertyValue('--lg-tint-1').trim() !== '';
    } catch (e) { return false; }
  }

  /* 原仓库 index.html 末尾的 <svg><filter id="glass-distortion">，逐节点照搬 */
  var GLASS_SVG =
    '<svg width="0" height="0" style="position:absolute" aria-hidden="true">' +
      '<filter id="glass-distortion" x="0%" y="0%" width="100%" height="100%"' +
        ' filterUnits="objectBoundingBox">' +
        '<feTurbulence type="fractalNoise" baseFrequency="0.01 0.01" numOctaves="1"' +
          ' seed="5" result="turbulence"/>' +
        '<feComponentTransfer in="turbulence" result="mapped">' +
          '<feFuncR type="gamma" amplitude="1" exponent="10" offset="0.5"/>' +
          '<feFuncG type="gamma" amplitude="0" exponent="1" offset="0"/>' +
          '<feFuncB type="gamma" amplitude="0" exponent="1" offset="0.5"/>' +
        '</feComponentTransfer>' +
        '<feGaussianBlur in="turbulence" stdDeviation="3" result="softMap"/>' +
        '<feSpecularLighting in="softMap" surfaceScale="5" specularConstant="1"' +
          ' specularExponent="100" lighting-color="white" result="specLight">' +
          '<fePointLight x="-200" y="-200" z="300"/>' +
        '</feSpecularLighting>' +
        '<feComposite in="specLight" operator="arithmetic" k1="0" k2="1" k3="1"' +
          ' k4="0" result="litImage"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="softMap" scale="150"' +
          ' xChannelSelector="R" yChannelSelector="G"/>' +
      '</filter>' +
    '</svg>';

  function glassLayers() {
    return '<div class="liquidGlass-effect"></div>' +
           '<div class="liquidGlass-tint"></div>' +
           '<div class="liquidGlass-shine"></div>' +
           '<div class="liquidGlass-text"></div>';
  }

  function addGlass() {
    if (!THEME_GLASS || document.getElementById('glass-distortion')) return;

    var svgHost = document.createElement('div');
    svgHost.id = 'it-glass-svg';
    svgHost.innerHTML = GLASS_SVG;
    document.body.appendChild(svgHost);

    // 玻璃只给译文 pane 一处；用官网自己的 .panes .pane 结构，不改官网 DOM 语义
    var panes = document.querySelectorAll('.panes .pane');
    if (panes.length < 2) return;
    var target = panes[panes.length - 1];
    if (target.classList.contains('it-glass')) return;
    target.classList.add('it-glass');

    var wrap = document.createElement('div');
    wrap.className = 'it-glass-layers';
    wrap.innerHTML = glassLayers();
    // 三层铺满，文字层放空（官网译文仍在原本的 textarea/.output 里）
    var layers = wrap.children;
    for (var i = 0; i < layers.length; i++) {
      layers[i].style.position = 'absolute';
      layers[i].style.inset = '0';
      layers[i].style.pointerEvents = 'none';
    }
    target.insertBefore(wrap, target.firstChild);

    // 官网原有内容抬到文字层之上，保证能选中/复制
    var content = target.querySelector('textarea, .output');
    if (content) {
      content.style.position = 'relative';
      content.style.zIndex = '3';
      content.style.background = 'transparent';
    }
  }

  function addFade() {
    if (!THEME_FADE || document.getElementById('it-fade-style')) return;
    var style = document.createElement('style');
    style.id = 'it-fade-style';
    // 单条 keyframe，等效 animate.css fadeInUp，不引入整库
    style.textContent =
      '@keyframes itFadeInUp{from{opacity:0;transform:translateY(6px)}' +
      'to{opacity:1;transform:translateY(0)}}' +
      '.it-fade-in{animation:itFadeInUp .28s cubic-bezier(.22,.8,.28,1) both}' +
      '@media(prefers-reduced-motion:reduce){.it-fade-in{animation:none}}';
    (document.head || document.documentElement).appendChild(style);

    var out = document.getElementById('out') ||
              document.querySelector('.panes .pane:last-child .output');
    if (!out) return;
    var last = '';
    var observer = new MutationObserver(function () {
      var now = (out.value !== undefined ? out.value : out.textContent) || '';
      if (now && now !== last) {
        last = now;
        out.classList.remove('it-fade-in');
        void out.offsetWidth;
        out.classList.add('it-fade-in');
      }
    });
    observer.observe(out, { childList: true, subtree: true, characterData: true, attributes: true });
  }

  function init() {
    if (!themeOn()) return;      // 主题没启用时，零开销、零副作用
    if (!v3On()) addGlass();     // v3 的折射由新注入器接管，避免两套玻璃层打架
    addFade();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 300); });
  } else {
    setTimeout(init, 300);
  }
  // 官网异步重建译文卡片时补一次
  setTimeout(init, 1600);
})();

/* ==========================================================================
   液态玻璃 v3 · 统一材质注入器
   --------------------------------------------------------------------------
   主题层（app/theme-liquid-glass.css）已经把玻璃铺满整页，这里只负责 CSS
   做不到的一件事：给译文 pane 加一层真折射。

   · 滤镜是本项目自研的等价实现（feTurbulence → 模糊 → 位移 → 远光源高光
     → 合成），替换掉 v2 vendor 的无 LICENSE 折射滤镜，分发不再有授权风险。
   · 只在检测到 --lg-tint-1 时启用；主题回退到 v2 时本段零开销。
   · 不支持 backdrop-filter、LG_REFRACTION=false、或 prefers-reduced-motion
     时只保留纯 CSS 玻璃（tint + 镜面高光），视觉仍然统一，不会露出空白。
   · 官网会异步重建译文卡片，用 MutationObserver 幂等补挂；三层永远
     pointer-events:none，官网内容全部抬到 .lg-content（z-index:3）。
   ========================================================================== */
(function () {
  var LG_REFRACTION = true;    // 关掉即退化为纯 CSS 玻璃
  var TARGETS = '.panes .pane:last-child, [data-lg-refraction="on"]';

  function root() { return document.documentElement; }

  function lgOn() {
    try {
      return getComputedStyle(root()).getPropertyValue('--lg-tint-1').trim() !== '';
    } catch (e) { return false; }
  }

  function cssSupports(prop, value) {
    try { return !!(window.CSS && CSS.supports && CSS.supports(prop, value)); }
    catch (e) { return false; }
  }

  function blurSupported() {
    return cssSupports('backdrop-filter', 'blur(1px)') ||
           cssSupports('-webkit-backdrop-filter', 'blur(1px)');
  }

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  var LG_SVG =
    '<svg width="0" height="0" style="position:absolute" aria-hidden="true">' +
      '<filter id="lg-distortion" x="-10%" y="-10%" width="120%" height="120%"' +
        ' color-interpolation-filters="sRGB">' +
        '<feTurbulence type="fractalNoise" baseFrequency="0.012 0.016"' +
          ' numOctaves="2" seed="7" result="noise"/>' +
        '<feGaussianBlur in="noise" stdDeviation="2.4" result="soft"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="soft" scale="42"' +
          ' xChannelSelector="R" yChannelSelector="G" result="warp"/>' +
        '<feSpecularLighting in="soft" surfaceScale="3" specularConstant=".7"' +
          ' specularExponent="24" lighting-color="#ffffff" result="spec">' +
          '<feDistantLight azimuth="225" elevation="55"/>' +
        '</feSpecularLighting>' +
        '<feComposite in="spec" in2="warp" operator="in" result="specClip"/>' +
        '<feComposite in="warp" in2="specClip" operator="arithmetic"' +
          ' k1="0" k2="1" k3=".35" k4="0"/>' +
      '</filter>' +
    '</svg>';

  function installSvg() {
    if (document.getElementById('lg-distortion')) return;
    var host = document.createElement('div');
    host.id = 'lg-svg-host';
    host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    host.innerHTML = LG_SVG;
    (document.body || document.documentElement).appendChild(host);
  }

  function addLayers(el) {
    if (!el || el.getAttribute('data-lg-ready') === '1') return;
    el.setAttribute('data-lg-ready', '1');
    el.setAttribute('data-lg-refraction', 'on');
    el.classList.add('lg-refractive');

    var wrap = document.createElement('div');
    wrap.className = 'lg-layers';
    wrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none';
    wrap.innerHTML = '<div class="lg-effect"></div>' +
                     '<div class="lg-tint"></div>' +
                     '<div class="lg-shine"></div>';
    el.insertBefore(wrap, el.firstChild);

    // 官网原有内容（标题、textarea、译文）全部抬到玻璃层之上
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] !== wrap) kids[i].classList.add('lg-content');
    }
  }

  var observer = null;

  function scan() {
    if (observer) observer.disconnect();
    try {
      var list = document.querySelectorAll(TARGETS);
      for (var i = 0; i < list.length; i++) addLayers(list[i]);
    } finally {
      if (observer) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    }
  }

  function watch() {
    if (!window.MutationObserver || !document.body) return;
    var timer = 0;
    observer = new MutationObserver(function () {
      clearTimeout(timer);
      timer = setTimeout(scan, 120);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    if (!lgOn()) return;                 // 回退到 v2 / 官网时，零开销
    if (!LG_REFRACTION || !blurSupported() || reducedMotion()) {
      if (!blurSupported()) root().classList.add('no-lg-blur');
      return;                           // 纯 CSS 玻璃兜底，主题层已经画好
    }
    installSvg();
    scan();
    watch();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 300); });
  } else {
    setTimeout(init, 300);
  }
  // 官网异步重建译文卡片 / 晚注入样式时补一次
  setTimeout(init, 1600);
})();
