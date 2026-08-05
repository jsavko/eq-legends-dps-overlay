// CommonJS (.cjs): package.json sets "type": "module", and a sandboxed preload must
// be CommonJS. The extension makes Electron load it correctly regardless.
//
// The alert window is a pure listener: it renders what main pushes and asks for the
// config once at startup. It sends nothing back — dragging is native window dragging,
// and lock state arrives on the same channel the overlay uses.
const { contextBridge, ipcRenderer } = require('electron');

const CH = {
  SNAPSHOT: 'overlay:snapshot',
  CONFIG_CHANGED: 'config:changed',
  LOCK_CHANGED: 'overlay:lock-changed',
  CONFIG_GET: 'config:get',
};

const on = (channel) => (handler) =>
  ipcRenderer.on(channel, (_event, payload) => handler(payload));

contextBridge.exposeInMainWorld('api', {
  onSnapshot: on(CH.SNAPSHOT),
  onConfig: on(CH.CONFIG_CHANGED),
  onLockChanged: on(CH.LOCK_CHANGED),
  getConfig: () => ipcRenderer.invoke(CH.CONFIG_GET),
});
