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
  PANEL_SIDE: 'overlay:panel-side',
  SET_IGNORE_MOUSE: 'window:set-ignore-mouse',
  FIT_WINDOW: 'window:fit',
  CLOSE_WINDOW: 'window:close',
  RESET_ENCOUNTER: 'overlay:reset',
  TOGGLE_LOCK: 'overlay:toggle-lock',
  TOGGLE_METRIC: 'overlay:toggle-metric',
  OPEN_SETTINGS: 'window:open-settings',
  CONFIG_GET: 'config:get',
  CLIPBOARD_COPY: 'clipboard:copy',
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
  /** Whether the breakdown should render below the rows or above them. */
  onPanelSide: on(CH.PANEL_SIDE),

  getConfig: () => ipcRenderer.invoke(CH.CONFIG_GET),
  openSettings: () => ipcRenderer.invoke(CH.OPEN_SETTINGS),
  /**
   * Put a finished line on the clipboard, and say whether it landed.
   *
   * Main does the write: the Async Clipboard API wants a focused document and a user
   * gesture, neither of which this always-on-top click-through window reliably has.
   */
  copyText: (text) => ipcRenderer.invoke(CH.CLIPBOARD_COPY, text),

  /** Give mouse events back to the game, or take them so a row can be hovered. */
  setIgnoreMouse: (ignore) => ipcRenderer.send(CH.SET_IGNORE_MOUSE, ignore),
  /**
   * Ask the window to fit its content: `{ height, extraWidth, panelOpen }`.
   * Height is the measured content; extraWidth is how short the breakdown's name
   * columns are of showing every name in full. Main owns the resting bounds and the
   * clamps, so the renderer reports measurements and never names absolute bounds.
   */
  fitWindow: (spec) => ipcRenderer.send(CH.FIT_WINDOW, spec),
  toggleLock: () => ipcRenderer.send(CH.TOGGLE_LOCK),
  toggleMetric: () => ipcRenderer.send(CH.TOGGLE_METRIC),
  resetEncounter: () => ipcRenderer.send(CH.RESET_ENCOUNTER),
  close: () => ipcRenderer.send(CH.CLOSE_WINDOW),
});
