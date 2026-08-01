// CommonJS (.cjs): package.json sets "type": "module", and a sandboxed preload must
// be CommonJS. The extension makes Electron load it correctly regardless.
const { contextBridge, ipcRenderer } = require('electron');

const CH = {
  SNAPSHOT: 'overlay:snapshot',
  STATUS: 'overlay:status',
  CONFIG_CHANGED: 'config:changed',
  TOAST: 'overlay:toast',
  LOCK_CHANGED: 'overlay:lock-changed',
  HOVER: 'overlay:hover',
  SET_IGNORE_MOUSE: 'window:set-ignore-mouse',
  FIT_HEIGHT: 'window:fit-height',
  CLOSE_WINDOW: 'window:close',
  RESET_ENCOUNTER: 'overlay:reset',
  TOGGLE_LOCK: 'overlay:toggle-lock',
  TOGGLE_METRIC: 'overlay:toggle-metric',
  OPEN_SETTINGS: 'window:open-settings',
  CONFIG_GET: 'config:get',
};

const on = (channel) => (handler) =>
  ipcRenderer.on(channel, (_event, payload) => handler(payload));

contextBridge.exposeInMainWorld('api', {
  onSnapshot: on(CH.SNAPSHOT),
  onStatus: on(CH.STATUS),
  onConfig: on(CH.CONFIG_CHANGED),
  onToast: on(CH.TOAST),
  onLockChanged: on(CH.LOCK_CHANGED),
  /** Window-relative cursor position while click-through, or null when outside. */
  onHover: on(CH.HOVER),

  getConfig: () => ipcRenderer.invoke(CH.CONFIG_GET),
  openSettings: () => ipcRenderer.invoke(CH.OPEN_SETTINGS),

  /** Give mouse events back to the game, or take them so a row can be hovered. */
  setIgnoreMouse: (ignore) => ipcRenderer.send(CH.SET_IGNORE_MOUSE, ignore),
  /** Ask the window to shrink or grow to exactly fit the rows currently shown. */
  fitHeight: (height) => ipcRenderer.send(CH.FIT_HEIGHT, height),
  toggleLock: () => ipcRenderer.send(CH.TOGGLE_LOCK),
  toggleMetric: () => ipcRenderer.send(CH.TOGGLE_METRIC),
  resetEncounter: () => ipcRenderer.send(CH.RESET_ENCOUNTER),
  close: () => ipcRenderer.send(CH.CLOSE_WINDOW),
});
