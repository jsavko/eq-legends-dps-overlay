// CommonJS (.cjs) on purpose: package.json sets "type": "module", and a sandboxed
// preload must be CommonJS. The .cjs extension makes Electron load it correctly
// regardless of the type field.
const { contextBridge, ipcRenderer } = require('electron');

// Repeated by hand because a sandboxed preload cannot import ipc.js, which is an ES
// module. `tests/preload-channels.test.js` is the check that the copies stay in step —
// a typo here does not fail loudly, it produces an invoke that hangs forever.
const CH = {
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  SESSION_CLEAR: 'session:clear',
  SESSION_IMPORT: 'session:import',
  SESSION_APPENDED: 'session:appended',
};

contextBridge.exposeInMainWorld('api', {
  sessionList: (key) => ipcRenderer.invoke(CH.SESSION_LIST, key),
  /**
   * One session in full. Serves the night in flight as well as the ones on disk — it is an
   * ordinary row in the rail and asks the ordinary question.
   */
  sessionGet: (args) => ipcRenderer.invoke(CH.SESSION_GET, args),
  sessionClear: (key) => ipcRenderer.invoke(CH.SESSION_CLEAR, key),
  sessionImport: () => ipcRenderer.invoke(CH.SESSION_IMPORT),
  onSessionAppended: (fn) => ipcRenderer.on(CH.SESSION_APPENDED, (_e, payload) => fn(payload)),
});
