// CommonJS (.cjs) on purpose: package.json sets "type": "module", and a sandboxed
// preload must be CommonJS. The .cjs extension makes Electron load it correctly
// regardless of the type field.
const { contextBridge, ipcRenderer } = require('electron');

// Mirrors CHANNELS in src/main/ipc.js — a preload cannot import an ES module, so the
// names are repeated here and must be kept in sync by hand, as the other preloads do.
const CH = {
  MOBILE_STATE: 'mobile:state',
  MOBILE_CHANGED: 'mobile:changed',
  OPEN_SETTINGS: 'window:open-settings',
};

contextBridge.exposeInMainWorld('api', {
  /** Whether the second screen is on, whether it started, and the URL(s) to scan. */
  mobileState: () => ipcRenderer.invoke(CH.MOBILE_STATE),
  /** The state moved (a settings save flipped the switch) — redraw from the payload. */
  onChanged: (handler) =>
    ipcRenderer.on(CH.MOBILE_CHANGED, (_event, state) => handler(state)),
  /** The dialog's one pointer for the off/failed states. */
  openSettings: () => ipcRenderer.invoke(CH.OPEN_SETTINGS),
});
