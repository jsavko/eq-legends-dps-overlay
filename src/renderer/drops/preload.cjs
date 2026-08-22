// CommonJS (.cjs): package.json sets "type": "module", and a sandboxed preload must
// be CommonJS. The extension makes Electron load it correctly regardless.
//
// The drops window is a pure listener like the alerts and timers windows: it renders
// what main pushes and asks for the config once at startup. It sends nothing back —
// dragging is native window dragging, and lock state arrives on the shared channel.
const { contextBridge, ipcRenderer } = require('electron');

const CH = {
  DROPS: 'drops:state',
  CONFIG_CHANGED: 'config:changed',
  LOCK_CHANGED: 'overlay:lock-changed',
  CONFIG_GET: 'config:get',
  PANEL_FIT: 'overlay:panel-fit',
};

const on = (channel) => (handler) =>
  ipcRenderer.on(channel, (_event, payload) => handler(payload));

contextBridge.exposeInMainWorld('api', {
  onDrops: on(CH.DROPS),
  onConfig: on(CH.CONFIG_CHANGED),
  onLockChanged: on(CH.LOCK_CHANGED),
  getConfig: () => ipcRenderer.invoke(CH.CONFIG_GET),
  /** How big this window needs to be. The one message that keeps it from being an
      oversized invisible rectangle swallowing clicks meant for the window behind it. */
  fit: (size) => ipcRenderer.send(CH.PANEL_FIT, size),
});
