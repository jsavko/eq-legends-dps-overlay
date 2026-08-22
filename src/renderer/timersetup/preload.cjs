// CommonJS (.cjs) on purpose: package.json sets "type": "module", and a sandboxed
// preload must be CommonJS.
//
// Mirrors CHANNELS in src/main/ipc.js — a preload cannot import an ES module, so the
// names are repeated here and kept in sync by hand, as the other preloads do.
const { contextBridge, ipcRenderer } = require('electron');

const CH = {
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  TIMERS_GET: 'timers:get',
  TIMERS_SAVE_CATEGORY: 'timers:save-category',
  TIMERS_REMOVE_CATEGORY: 'timers:remove-category',
  TIMERS_SAVE_TIMER: 'timers:save-timer',
  TIMERS_REMOVE_TIMER: 'timers:remove-timer',
  TIMERS_ARRANGE: 'timers:arrange',
  TIMERS_PREVIEW: 'timers:preview',
  TIMERS_MEASURE: 'timers:measure',
  TIMERS_CLEAR_PREVIEWS: 'timers:clear-previews',
};

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke(CH.CONFIG_GET),
  setConfig: (patch) => ipcRenderer.invoke(CH.CONFIG_SET, patch),

  get: () => ipcRenderer.invoke(CH.TIMERS_GET),
  saveCategory: (payload) => ipcRenderer.invoke(CH.TIMERS_SAVE_CATEGORY, payload),
  removeCategory: (payload) => ipcRenderer.invoke(CH.TIMERS_REMOVE_CATEGORY, payload),
  saveTimer: (payload) => ipcRenderer.invoke(CH.TIMERS_SAVE_TIMER, payload),
  removeTimer: (payload) => ipcRenderer.invoke(CH.TIMERS_REMOVE_TIMER, payload),
  arrange: (on) => ipcRenderer.invoke(CH.TIMERS_ARRANGE, { on }),
  preview: (payload) => ipcRenderer.invoke(CH.TIMERS_PREVIEW, payload),
  measure: (payload) => ipcRenderer.invoke(CH.TIMERS_MEASURE, payload),
  clearPreviews: (payload) => ipcRenderer.invoke(CH.TIMERS_CLEAR_PREVIEWS, payload),
});
