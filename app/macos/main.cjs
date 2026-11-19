'use strict';

const {
  app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage,
  net, protocol, screen, session, shell, systemPreferences, Tray
} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  MAIN_URL, POPUP_URL, MAX_SETTINGS_BYTES, defaultSettings, normalizeSettings,
  canonicalShortcut, authorizeCommand, resolveResource
} = require('./core.cjs');

const runFile = promisify(execFile);
const shellRoot = __dirname;
const webRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'web')
  : path.resolve(__dirname, '../../web');
const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.resolve(__dirname, '../icon.png');
let mainWindow = null;
let popupWindow = null;
let tray = null;
let quitting = false;
let settings = defaultSettings();
let hotkeysEnabled = true;
let saving = false;
let captureRunning = false;
let activeSelectionOperation = null;
let popupSequence = 0;
let popupState = null;
let popupRequest = null;
let fontFamilies = null;
let rendererReady = false;
let pendingActions = [];

protocol.registerSchemesAsPrivileged([{
  scheme: 'jian',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

function settingsPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}

function notifyAction(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (rendererReady) mainWindow.webContents.send('jian:action', action);
    else if (action.type !== 'window-state') {
      // Shortcuts can arrive during local page startup; do not lose the first
      // selected text or menu action before the preload callback is registered.
      pendingActions = pendingActions.slice(-7);
      pendingActions.push(action);
    }
  }
}

function notifyWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  notifyAction({
    type: 'window-state',
    fullscreen: mainWindow.isFullScreen(),
    maximized: mainWindow.isMaximized()
  });
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function showSettings() {
  showMain();
  notifyAction({ type: 'open-settings' });
}

async function loadSettings() {
  try {
    const stat = await fs.stat(settingsPath());
    if (stat.size > MAX_SETTINGS_BYTES) throw new Error('设置文件过大');
    settings = normalizeSettings(JSON.parse(await fs.readFile(settingsPath(), 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Keep the file in place for recovery; do not overwrite unreadable preferences.
      dialog.showErrorBox('无法读取笺的设置', '本次使用默认设置。原设置文件已保留，可检查文件权限或格式。');
    }
  }
  settings.auto_start = app.getLoginItemSettings().openAtLogin;
}

async function persistSettings(next) {
  const destination = settingsPath();
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(next, null, 2), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // POSIX rename replaces atomically; no delete or clearing of prior preferences.
  await fs.rename(temporary, destination);
}

function shortcutHandlers(next) {
  return [
    [canonicalShortcut(next.activation_shortcut), () => {
      if (!hotkeysEnabled) return;
      if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
      else showMain();
    }],
    [canonicalShortcut(next.selection_shortcut), () => {
      if (hotkeysEnabled) void translateSelection();
    }]
  ].filter(([accelerator]) => accelerator);
}

function registerShortcuts(next) {
  const registered = [];
  for (const [accelerator, handler] of shortcutHandlers(next)) {
    let success = false;
    try { success = globalShortcut.register(accelerator, handler); } catch { /* invalid key */ }
    if (!success) {
      for (const previous of registered) globalShortcut.unregister(previous);
      throw new Error(`快捷键「${accelerator}」无效或已被其他应用占用`);
    }
    registered.push(accelerator);
  }
}

async function saveSettings(input) {
  if (saving) throw new Error('设置正在保存，请稍后重试');
  saving = true;
  const previous = settings;
  const originalLoginItem = app.getLoginItemSettings().openAtLogin;
  let shortcutsChanged = false;
  let loginChanged = false;
  try {
    const next = normalizeSettings(input);
    shortcutsChanged = next.selection_shortcut !== previous.selection_shortcut ||
      next.activation_shortcut !== previous.activation_shortcut;
    if (shortcutsChanged) {
      cancelSelectionCapture(activeSelectionOperation);
      globalShortcut.unregisterAll();
      registerShortcuts(next);
    }
    loginChanged = next.auto_start !== originalLoginItem;
    if (loginChanged) {
      if (!app.isPackaged) throw new Error('登录时启动需在安装后的应用中设置');
      app.setLoginItemSettings({ openAtLogin: next.auto_start, openAsHidden: true });
      if (app.getLoginItemSettings().openAtLogin !== next.auto_start) {
        throw new Error('macOS 未能更新登录项，请检查系统设置');
      }
    }
    await persistSettings(next);
    settings = next;
    if (popupWindow && !popupWindow.isDestroyed()) {
      try { await applyPopupAppearance(); } catch {
        // Successful persistence must keep the shared frontend's [] success
        // contract. A popup that was closed concurrently picks up next launch.
        void dialog.showMessageBox(mainWindow, {
          type: 'info', title: '设置已保存',
          message: '悬浮窗外观将在下次打开时更新。',
          buttons: ['好']
        });
      }
    }
    return [];
  } catch (error) {
    const rollbackErrors = [];
    if (shortcutsChanged) {
      globalShortcut.unregisterAll();
      try { registerShortcuts(previous); } catch { rollbackErrors.push('原快捷键恢复失败'); }
    }
    if (loginChanged) {
      try {
        app.setLoginItemSettings({ openAtLogin: originalLoginItem, openAsHidden: true });
      } catch { rollbackErrors.push('原登录项恢复失败'); }
    }
    throw new Error(`${error.message}${rollbackErrors.length ? `；${rollbackErrors.join('；')}` : ''}`);
  } finally {
    saving = false;
  }
}

function configureWindowSecurity(window, expectedUrl) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    // The about page's explicit repository link opens in the system browser.
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && parsed.hostname === 'github.com' &&
          !parsed.port && !parsed.username && !parsed.password &&
          /^\/jiuxina\/jian-translator(?:\/|$)/.test(parsed.pathname)) {
        void shell.openExternal(parsed.href).catch(() => {
          dialog.showErrorBox('无法打开链接', '请在浏览器中打开 github.com/jiuxina/jian-translator。');
        });
      }
    } catch { /* Block malformed and non-HTTPS external navigation. */ }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== expectedUrl) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
}

function webPreferences() {
  return {
    preload: path.join(shellRoot, 'preload.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: false
  };
}

function createMain() {
  mainWindow = new BrowserWindow({
    title: '笺',
    width: 1180, height: 900, minWidth: 680, minHeight: 500,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 14 },
    transparent: true,
    backgroundColor: '#00000000',
    roundedCorners: true,
    hasShadow: true,
    webPreferences: webPreferences()
  });
  configureWindowSecurity(mainWindow, MAIN_URL);
  mainWindow.webContents.on('render-process-gone', () => { rendererReady = false; });
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    mainWindow.on(event, notifyWindowState);
  }
  mainWindow.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.on('did-fail-load', (_event, code) => {
    if (code === -3) return;
    dialog.showErrorBox('笺界面加载失败', '本地界面资源无法加载，请重新安装应用。');
  });
  mainWindow.once('ready-to-show', () => {
    if (!settings.start_to_tray) showMain();
  });
  void mainWindow.loadURL(MAIN_URL).catch(() => {
    // did-fail-load reports the local-resource error; consume the Promise too.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
}

function createMenuAndTray() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '笺', submenu: [
      { label: '关于笺', click: () => { showMain(); notifyAction({ type: 'open-about' }); } },
      { label: '设置…', accelerator: 'Cmd+,', click: showSettings },
      { type: 'separator' }, { role: 'hide', label: '隐藏笺' },
      { role: 'hideOthers', label: '隐藏其他应用' }, { role: 'unhide', label: '显示全部' },
      { type: 'separator' }, { role: 'quit', label: '退出笺' }
    ] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }
    ] },
    { label: '窗口', submenu: [
      { role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' },
      { role: 'togglefullscreen', label: '进入/退出全屏' }
    ] }
  ]));
  const image = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  tray = new Tray(image);
  tray.setToolTip('笺');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示笺', click: showMain },
    { label: '划词翻译', click: () => { void translateSelection(); } },
    { label: '设置…', click: showSettings },
    { type: 'separator' },
    { label: '退出笺', click: () => app.quit() }
  ]));
}

async function listSystemFonts() {
  if (fontFamilies) return fontFamilies;
  const source = [
    "ObjC.import('AppKit');",
    'JSON.stringify(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies));'
  ].join('\n');
  try {
    const { stdout } = await runFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source],
      { timeout: 10000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
    const names = JSON.parse(stdout);
    if (!Array.isArray(names)) throw new Error('invalid font result');
    fontFamilies = [...new Set(names.filter(name =>
      typeof name === 'string' && name.length > 0 && name.length < 256))]
      .sort((left, right) => left.localeCompare(right));
    if (!fontFamilies.length) { fontFamilies = null; throw new Error('empty font result'); }
    return fontFamilies;
  } catch {
    throw new Error('无法通过 macOS NSFontManager 获取系统字体，请检查系统脚本权限');
  }
}

async function foregroundApplicationPid() {
  try {
    const { stdout } = await runFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
      "ObjC.import('AppKit'); Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);"],
    { timeout: 1500, maxBuffer: 1024, encoding: 'utf8' });
    const pid = Number(stdout.trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    // A missing foreground identity is not permission to activate our window.
    return null;
  }
}

async function captureSelection(expectedPid, signal) {
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    throw new Error('请在“系统设置 → 隐私与安全性 → 辅助功能”中允许笺，然后重新划词。');
  }
  // Called only after the user's selection shortcut/menu action. No clipboard is
  // read on launch, while idle, or during tests. changeCount prevents stale text.
  const source = `
ObjC.import('AppKit');
var expectedPid = ${JSON.stringify(expectedPid)};
JSON.stringify((function () {
function sourceIsCurrent() {
  return Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) === expectedPid;
}
if (!sourceIsCurrent()) return null;
var pasteboard = $.NSPasteboard.generalPasteboard;
var previous = Number(pasteboard.changeCount);
delay(0.3);
if (Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) !== expectedPid) return null;
Application('System Events').keystroke('c', {using: 'command down'});
var text = '';
for (var tick = 0; tick < 20; tick++) {
  delay(0.05);
  if (!sourceIsCurrent()) return null;
  if (Number(pasteboard.changeCount) !== previous) {
    var value = pasteboard.stringForType($.NSPasteboardTypeString);
    if (value) text = ObjC.unwrap(value);
    break;
  }
}
return text;
})());
`;
  try {
    const { stdout } = await runFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source],
      { timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8', signal });
    const text = JSON.parse(stdout);
    if (text === null) {
      const error = new Error('选区来源已改变');
      error.name = 'AbortError';
      throw error;
    }
    return typeof text === 'string' ? text.slice(0, 200000) : '';
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('无法复制当前选区；请检查笺的辅助功能及“自动化 → System Events”权限。');
  }
}

async function applyPopupAppearance(window = popupWindow) {
  if (!window || window.isDestroyed()) return;
  const preferences = JSON.stringify(settings.preferences || {});
  await window.webContents.executeJavaScript(
    `window.__itPopupAppearance=${preferences};` +
    'if(window.__popupApplyPreferences)window.__popupApplyPreferences(window.__itPopupAppearance);'
  );
}

function ensurePopup() {
  if (popupState && !popupState.window.isDestroyed()) return popupState;
  const window = new BrowserWindow({
    title: '划词翻译', width: 436, height: 282, show: false,
    frame: false, transparent: true, backgroundColor: '#00000000',
    roundedCorners: true, hasShadow: false, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, webPreferences: webPreferences()
  });
  const state = { window, ready: null, failed: false };
  popupState = state;
  popupWindow = window;
  configureWindowSecurity(window, POPUP_URL);
  window.on('close', () => {
    if (popupRequest && popupRequest.window === window) cancelPopupRequest(popupRequest);
    if (popupWindow === window) {
      popupWindow = null;
      popupState = null;
    }
    void window.webContents.executeJavaScript(
      'if(window.__popupDismiss)window.__popupDismiss();'
    ).catch(() => { /* Destroying the WebContents also cancels its request. */ });
  });
  window.on('closed', () => {
    if (popupRequest && popupRequest.window === window) cancelPopupRequest(popupRequest);
    if (popupWindow === window) {
      popupWindow = null;
      popupState = null;
    }
    // Keep the next shortcut's local document ready without touching selection
    // or clipboard data. A failed local load is retried only by a later action.
    if (!quitting && !state.failed) queueMicrotask(prewarmPopup);
  });
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      window.close();
    }
  });
  state.ready = window.loadURL(POPUP_URL).then(async () => {
    if (!window.isDestroyed() && popupWindow === window) await applyPopupAppearance(window);
  }).catch(error => {
    if (window.isDestroyed()) return;
    state.failed = true;
    window.destroy();
    throw error;
  });
  return state;
}

function prewarmPopup() {
  if (quitting) return;
  void ensurePopup().ready.catch(() => {
    // A shortcut reports a load failure. Do not repeatedly recreate a failed
    // hidden document, and do not interrupt another app during idle prewarming.
  });
}

function isCurrentPopup(request) {
  return request && request === popupRequest && !request.canceled &&
    popupWindow === request.window && !request.window.isDestroyed();
}

function cancelPopupRequest(request) {
  if (!request) return;
  request.canceled = true;
  if (request.pending && request.operation) {
    request.operation.canceled = true;
    request.operation.controller.abort();
    releaseCaptureEscape(request.operation);
  }
  if (request.blurHandler) request.window.removeListener('blur', request.blurHandler);
  if (popupRequest === request) popupRequest = null;
}

function releaseCaptureEscape(operation) {
  if (!operation || !operation.escapeRegistered) return;
  operation.escapeRegistered = false;
  globalShortcut.unregister('Escape');
}

function cancelSelectionCapture(operation) {
  if (!operation) return;
  operation.canceled = true;
  operation.controller.abort();
  releaseCaptureEscape(operation);
  if (operation.request && isCurrentPopup(operation.request)) closePopup(operation.request.window);
}

function registerCaptureEscape(operation) {
  // Do not replace or later unregister another handler's registration.
  try {
    if (!globalShortcut.isRegistered('Escape')) {
      operation.escapeRegistered = globalShortcut.register('Escape', () => cancelSelectionCapture(operation));
    }
  } catch { /* The source application remains active if Escape is unavailable. */ }
}

async function selectionSourceIsCurrent(operation) {
  if (!operation || operation.canceled || !operation.sourcePid) return false;
  const pid = await foregroundApplicationPid();
  return !operation.canceled && pid === operation.sourcePid;
}

function closePopup(window) {
  if (!window || window.isDestroyed()) return;
  const request = popupRequest && popupRequest.window === window ? popupRequest : null;
  cancelPopupRequest(request);
  if (popupWindow === window) {
    popupWindow = null;
    popupState = null;
  }
  window.close();
}

function positionPopup(window) {
  const cursor = screen.getCursorScreenPoint();
  const work = screen.getDisplayNearestPoint(cursor).workArea;
  const x = Math.max(work.x, Math.min(cursor.x + 18 - 22, work.x + work.width - 436));
  const y = Math.max(work.y, Math.min(cursor.y + 22 - 22, work.y + work.height - 282));
  window.setPosition(Math.round(x), Math.round(y));
}

async function beginPopup(operation) {
  const state = ensurePopup();
  const previous = popupRequest && popupRequest.window === state.window ? popupRequest : null;
  cancelPopupRequest(previous);
  const request = {
    id: ++popupSequence, window: state.window, state, canceled: false, target: settings.target_lang,
    operation, pending: true
  };
  if (operation) operation.request = request;
  popupRequest = request;
  request.window.setFocusable(false);
  if (request.window.isVisible()) request.window.hide();
  try {
    await state.ready;
    if (!isCurrentPopup(request)) return null;
    const payload = JSON.stringify({
      id: request.id, phase: 'pending', text: '', notice: '', target: request.target
    });
    await request.window.webContents.executeJavaScript(
      `window.__itPopupPayload=${payload};` +
      'if(window.__popupApply)window.__popupApply(window.__itPopupPayload);'
    );
    if (!isCurrentPopup(request)) return null;
    positionPopup(request.window);
    // Showing must not activate this app: System Events still has to copy from
    // the original application. Focus and blur dismissal begin after capture.
    request.window.showInactive();
    await request.window.webContents.executeJavaScript(
      'window.__itPopupPresentRequested=true;' +
      'if(window.__popupPresent)window.__popupPresent();'
    );
    return isCurrentPopup(request) ? request : null;
  } catch (error) {
    if (!state.failed && !isCurrentPopup(request)) return null;
    throw error;
  }
}

async function finishPopup(request, text, notice) {
  if (!isCurrentPopup(request)) return;
  if (request.operation && !await selectionSourceIsCurrent(request.operation)) {
    closePopup(request.window);
    return;
  }
  const payload = JSON.stringify({
    id: request.id, phase: notice ? 'notice' : 'ready', text, notice, target: request.target
  });
  await request.window.webContents.executeJavaScript(
    `window.__itPopupPayload=${payload};` +
    'if(window.__popupApply)window.__popupApply(window.__itPopupPayload);'
  );
  if (!isCurrentPopup(request)) return;
  // Rendering may itself wait for IPC; recheck before claiming focus.
  if (request.operation && !await selectionSourceIsCurrent(request.operation)) {
    closePopup(request.window);
    return;
  }
  if (!isCurrentPopup(request)) return;
  request.pending = false;
  releaseCaptureEscape(request.operation);
  request.window.setFocusable(true);
  request.window.focus();
  request.blurHandler = () => { if (isCurrentPopup(request)) closePopup(request.window); };
  request.window.once('blur', request.blurHandler);
}

async function showPopup(text, notice, operation) {
  const request = await beginPopup(operation);
  if (request) await finishPopup(request, text, notice);
}

async function translateSelection() {
  if (captureRunning) return;
  captureRunning = true;
  const operation = { canceled: false, sourcePid: null, controller: new AbortController(), escapeRegistered: false };
  activeSelectionOperation = operation;
  registerCaptureEscape(operation);
  let request = null;
  try {
    const inMain = settings.open_main_window;
    if (inMain) {
      if (popupWindow && !popupWindow.isDestroyed() && popupWindow.isVisible()) closePopup(popupWindow);
    } else {
      request = await beginPopup(operation);
      if (!request) return;
    }
    operation.sourcePid = await foregroundApplicationPid();
    if (operation.canceled || !operation.sourcePid) {
      cancelSelectionCapture(operation);
      return;
    }
    const text = await captureSelection(operation.sourcePid, operation.controller.signal);
    if (!await selectionSourceIsCurrent(operation)) {
      cancelSelectionCapture(operation);
      return;
    }
    if (request && !isCurrentPopup(request)) return;
    if (!text.trim()) {
      const notice = '没有取到选中文字。请先选中文本，再按划词快捷键；部分软件不支持自动复制。';
      if (request) await finishPopup(request, '', notice);
      else await showPopup('', notice, operation);
    } else if (inMain) {
      showMain();
      notifyAction({ type: 'translate-selection', text });
    } else {
      await finishPopup(request, text, '');
    }
  } catch (error) {
    if (operation.canceled || error.name === 'AbortError') {
      cancelSelectionCapture(operation);
      return;
    }
    if (request && isCurrentPopup(request)) {
      await finishPopup(request, '', error.message).catch(() => {
        if (isCurrentPopup(request)) dialog.showErrorBox('划词翻译不可用', error.message);
      });
    } else if (!request || request.state.failed) {
      dialog.showErrorBox('划词翻译不可用', error.message);
    }
  } finally {
    releaseCaptureEscape(operation);
    if (activeSelectionOperation === operation) activeSelectionOperation = null;
    captureRunning = false;
  }
}

async function handleCommand(event, command, args) {
  authorizeCommand(event, command, mainWindow, popupWindow);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('命令参数无效');
  switch (command) {
    case 'it_get_settings':
      return { ...settings, auto_start: app.getLoginItemSettings().openAtLogin };
    case 'it_save_settings':
      return saveSettings(args.settings);
    case 'it_set_hotkeys_enabled':
      if (typeof args.enabled !== 'boolean') throw new Error('快捷键状态无效');
      hotkeysEnabled = args.enabled;
      return null;
    case 'it_list_system_fonts':
      return listSystemFonts();
    case 'it_read_clipboard_text':
      // The only caller is the explicit main-window Paste action. This command
      // is excluded from popup authorization and is never called during startup.
      return clipboard.readText();
    case 'it_write_clipboard_text':
      if (typeof args.text !== 'string' || args.text.length > 1000000) throw new Error('复制文本无效或过长');
      clipboard.writeText(args.text);
      return null;
    case 'it_window_action':
      switch (args.action) {
        case 'drag': return null; // Native CSS app-region handles dragging on macOS.
        case 'minimize': mainWindow.minimize(); return null;
        case 'maximize':
          if (mainWindow.isMaximized()) mainWindow.unmaximize();
          else mainWindow.maximize();
          return null;
        case 'close': mainWindow.close(); return null;
        default: throw new Error('未知窗口动作');
      }
    default: throw new Error('未知原生命令');
  }
}

async function registerProtocol() {
  protocol.handle('jian', async request => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const target = resolveResource(request.url, webRoot, shellRoot);
    if (!target) return new Response(null, { status: 404 });
    try {
      const response = await net.fetch(pathToFileURL(target).toString());
      const headers = new Headers(response.headers);
      // Permit only the trusted boot snippets shipped in local HTML, rather than
      // unsafe-inline JavaScript. Dynamic SVG/style generation still needs styles.
      let scriptHashes = '';
      if (target.endsWith('.html')) {
        const html = await fs.readFile(target, 'utf8');
        scriptHashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
          .map(match => `'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`)
          .join(' ');
      }
      headers.set('Content-Security-Policy', [
        "default-src 'self'",
        `script-src 'self' ${scriptHashes}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' https://index-translate.bilibili.com https://api.github.com",
        "object-src 'none'", "base-uri 'none'", "frame-src 'none'", "form-action 'none'"
      ].join('; '));
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(request.method === 'HEAD' ? null : response.body, {
        status: response.status, headers
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

if (process.platform !== 'darwin') {
  app.whenReady().then(() => {
    dialog.showErrorBox('此安装包适用于 macOS', 'Windows 请使用笺的 EXE 或 MSI 安装包。');
    app.quit();
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);
  app.on('activate', showMain);
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', (event, item, contents) => {
      // Long-document exports are renderer-created blobs, never remote downloads.
      if (!mainWindow || mainWindow.isDestroyed() || contents !== mainWindow.webContents ||
          contents.mainFrame.url !== MAIN_URL || !item.getURL().startsWith('blob:jian://app/')) {
        event.preventDefault();
        return;
      }
      // No programmatic save path: Chromium shows the native Save dialog.
      item.setSaveDialogOptions({
        title: '导出译文',
        defaultPath: '笺-译文.txt',
        filters: [{ name: '纯文本', extensions: ['txt'] }]
      });
    });
    await registerProtocol();
    await loadSettings();
    ipcMain.handle('jian:invoke', handleCommand);
    ipcMain.on('jian:renderer-ready', event => {
      try {
        authorizeCommand(event, 'it_get_settings', mainWindow, popupWindow);
        rendererReady = true;
        notifyWindowState();
        const queued = pendingActions;
        pendingActions = [];
        for (const action of queued) notifyAction(action);
      } catch { /* Other frames never receive native state. */ }
    });
    createMain();
    createMenuAndTray();
    prewarmPopup();
    try { registerShortcuts(settings); } catch (error) {
      dialog.showErrorBox('快捷键注册失败', `${error.message}。可从菜单栏打开设置后更改。`);
    }
  }).catch(error => {
    dialog.showErrorBox('笺启动失败', error.message);
    app.quit();
  });
}
