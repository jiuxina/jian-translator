'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const allowedCommands = new Set([
  'it_get_settings', 'it_save_settings', 'it_set_hotkeys_enabled',
  'it_list_system_fonts', 'it_write_clipboard_text', 'it_read_clipboard_text', 'it_window_action'
]);

// No raw ipcRenderer, Node.js, filesystem or arbitrary channel is exposed.
contextBridge.exposeInMainWorld('__JIAN_DESKTOP__', Object.freeze({
  platform: 'darwin',
  invoke(command, args = {}) {
    if (!allowedCommands.has(command)) return Promise.reject(new Error('未知原生命令'));
    return ipcRenderer.invoke('jian:invoke', command, args);
  },
  onAction(callback) {
    if (typeof callback !== 'function') throw new TypeError('回调必须是函数');
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('jian:action', listener);
    // Listener exists before asking main for the initial native window state.
    ipcRenderer.send('jian:renderer-ready');
    return () => ipcRenderer.removeListener('jian:action', listener);
  }
}));
