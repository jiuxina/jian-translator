'use strict';

const path = require('node:path');

const MAIN_URL = 'jian://app/index.html';
const POPUP_URL = 'jian://app/__popup/index.html';
const MAX_SETTINGS_BYTES = 16 * 1024 * 1024;
const COMMANDS = new Set([
  'it_get_settings', 'it_save_settings', 'it_set_hotkeys_enabled',
  'it_list_system_fonts', 'it_write_clipboard_text', 'it_read_clipboard_text', 'it_window_action'
]);

function defaultSettings() {
  return {
    selection_shortcut: 'Cmd+Alt+T',
    activation_shortcut: 'Cmd+Alt+I',
    open_main_window: false,
    target_lang: 'auto',
    auto_start: false,
    start_to_tray: true,
    preferences: null
  };
}

function normalizeSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('桌面设置格式无效');
  }
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SETTINGS_BYTES) {
    throw new Error('设置及背景图片过大，请使用较小图片');
  }
  const defaults = defaultSettings();
  const result = { ...defaults };
  for (const key of ['selection_shortcut', 'activation_shortcut']) {
    const value = input[key] === undefined ? defaults[key] : input[key];
    if (typeof value !== 'string' || value.length > 120) {
      throw new Error('快捷键格式无效');
    }
    result[key] = value.trim();
  }
  if (result.selection_shortcut && result.activation_shortcut &&
      result.selection_shortcut.toLowerCase() === result.activation_shortcut.toLowerCase()) {
    throw new Error('划词翻译与显示窗口不能使用相同快捷键');
  }
  for (const key of ['open_main_window', 'auto_start', 'start_to_tray']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') {
      throw new Error('桌面开关设置格式无效');
    }
    result[key] = input[key] === undefined ? defaults[key] : input[key];
  }
  if (input.target_lang !== undefined && !['auto', 'zh', 'en'].includes(input.target_lang)) {
    throw new Error('划词目标语言无效');
  }
  result.target_lang = input.target_lang || defaults.target_lang;
  if (input.preferences !== null && input.preferences !== undefined) {
    if (typeof input.preferences !== 'object' || Array.isArray(input.preferences)) {
      throw new Error('界面设置格式无效');
    }
    // IPC provides structured-clone data; retain a plain JSON snapshot only.
    result.preferences = JSON.parse(JSON.stringify(input.preferences));
  }
  return result;
}

function canonicalShortcut(value) {
  return value.replace(/\bCommand\b/gi, 'Cmd')
    .replace(/\bOption\b/gi, 'Alt')
    .replace(/\bControl\b/gi, 'Ctrl');
}

function isAppUrl(value, expected) {
  // Exact documents, without alternate hosts, credentials, queries or fragments.
  return value === expected;
}

function authorizeCommand(event, command, mainWindow, popupWindow) {
  if (!COMMANDS.has(command) || !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame) {
    throw new Error('原生命令来源无效');
  }
  const sender = event.sender;
  if (command === 'it_write_clipboard_text') {
    if (!popupWindow || popupWindow.isDestroyed() || sender !== popupWindow.webContents ||
        !isAppUrl(event.senderFrame.url, POPUP_URL)) {
      throw new Error('剪贴板写入仅允许应用悬浮窗调用');
    }
    return 'popup';
  }
  if (!mainWindow || mainWindow.isDestroyed() || sender !== mainWindow.webContents ||
      !isAppUrl(event.senderFrame.url, MAIN_URL)) {
    throw new Error('原生命令仅允许应用主窗口调用');
  }
  return 'main';
}

function resolveResource(value, webRoot, shellRoot) {
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'jian:' || parsed.hostname !== 'app' || parsed.port ||
      parsed.username || parsed.password || parsed.hash) return null;
  let pathname;
  try { pathname = decodeURIComponent(parsed.pathname); } catch { return null; }
  if (pathname.includes('\0') || pathname.includes('\\') ||
      pathname.split('/').some(segment => segment === '..' || segment === '.')) return null;
  const shellResources = {
    '/__popup/index.html': 'popup.html',
    '/__popup/bootstrap.js': '.generated/popup-bootstrap.js'
  };
  if (Object.hasOwn(shellResources, pathname)) {
    return path.join(shellRoot, shellResources[pathname]);
  }
  if (pathname.startsWith('/__popup/')) return null;
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(webRoot, relative);
  const relation = path.relative(webRoot, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) return null;
  // The application has no directory listing or arbitrary file endpoint.
  if (!/\.(?:html|css|js|png|jpe?g|webp|avif|gif|svg|woff2?)$/i.test(target)) return null;
  return target;
}

module.exports = {
  MAIN_URL, POPUP_URL, MAX_SETTINGS_BYTES, COMMANDS,
  defaultSettings, normalizeSettings, canonicalShortcut,
  authorizeCommand, isAppUrl, resolveResource
};
