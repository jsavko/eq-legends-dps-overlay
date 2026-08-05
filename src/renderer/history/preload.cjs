// CommonJS (.cjs) on purpose: package.json sets "type": "module", and a sandboxed
// preload must be CommonJS. The .cjs extension makes Electron load it correctly
// regardless of the type field.
const { contextBridge, ipcRenderer } = require('electron');

// Mirrors CHANNELS in src/main/ipc.js — a preload cannot import an ES module, so the
// names are repeated here and must be kept in sync by hand, as the other preloads do.
const CH = {
  HISTORY_LIST: 'history:list',
  HISTORY_GET: 'history:get',
  HISTORY_CLEAR: 'history:clear',
  HISTORY_APPENDED: 'history:appended',
};

contextBridge.exposeInMainWorld('api', {
  /** Encounter history: characters + index, one full record, wipe one character. */
  historyList: (key) => ipcRenderer.invoke(CH.HISTORY_LIST, key),
  historyGet: (key, id) => ipcRenderer.invoke(CH.HISTORY_GET, { key, id }),
  historyClear: (key) => ipcRenderer.invoke(CH.HISTORY_CLEAR, key),
  /** A fight was just persisted (`{ key }`) — the cue to refresh the rail live. */
  onAppended: (handler) =>
    ipcRenderer.on(CH.HISTORY_APPENDED, (_event, payload) => handler(payload)),
});
