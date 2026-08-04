// CommonJS (.cjs) on purpose: package.json sets "type": "module", and a sandboxed
// preload must be CommonJS. The .cjs extension makes Electron load it correctly
// regardless of the type field.
const { contextBridge, ipcRenderer } = require('electron');

const CH = {
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  LOGS_LIST: 'logs:list',
  LOGS_PICK: 'logs:pick',
  LOGS_VALIDATE: 'logs:validate',
  LOGS_CLEAR: 'logs:clear',
  SETUP_COMPLETE: 'setup:complete',
  HISTORY_LIST: 'history:list',
  HISTORY_GET: 'history:get',
  HISTORY_CLEAR: 'history:clear',
};

const modeArg = process.argv.find((a) => a.startsWith('--overlay-mode='));
const tabArg = process.argv.find((a) => a.startsWith('--overlay-tab='));

contextBridge.exposeInMainWorld('api', {
  mode: modeArg ? modeArg.split('=')[1] : 'setup',
  /** Tab to open on ('history' from the tray's History… item), or ''. */
  initialTab: tabArg ? tabArg.split('=')[1] : '',
  getConfig: () => ipcRenderer.invoke(CH.CONFIG_GET),
  setConfig: (patch) => ipcRenderer.invoke(CH.CONFIG_SET, patch),
  listLogs: (dir) => ipcRenderer.invoke(CH.LOGS_LIST, dir),
  pick: (what) => ipcRenderer.invoke(CH.LOGS_PICK, what),
  validate: (filePath) => ipcRenderer.invoke(CH.LOGS_VALIDATE, filePath),
  clearLog: () => ipcRenderer.invoke(CH.LOGS_CLEAR),
  complete: (patch) => ipcRenderer.invoke(CH.SETUP_COMPLETE, patch),

  /** Encounter history: characters + index, one full record, wipe one character. */
  historyList: (key) => ipcRenderer.invoke(CH.HISTORY_LIST, key),
  historyGet: (key, id) => ipcRenderer.invoke(CH.HISTORY_GET, { key, id }),
  historyClear: (key) => ipcRenderer.invoke(CH.HISTORY_CLEAR, key),
});
