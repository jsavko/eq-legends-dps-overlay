// CommonJS (.cjs) on purpose: package.json sets "type": "module", and a sandboxed
// preload must be CommonJS.
//
// A timer box listens for its rows and sends back one thing: how big it needs to be.
// That one message is what keeps the window from being an oversized invisible rectangle
// that swallows clicks meant for whatever is behind it.
const { contextBridge, ipcRenderer } = require('electron');

const CH = {
  TIMERS_PUSH: 'timers:push',
  TIMERS_ARRANGING: 'timers:arranging',
  TIMERS_FIT: 'timers:fit',
  CONFIG_CHANGED: 'config:changed',
  CONFIG_GET: 'config:get',
};

const on = (channel) => (handler) =>
  ipcRenderer.on(channel, (_event, payload) => handler(payload));

contextBridge.exposeInMainWorld('api', {
  onTimers: on(CH.TIMERS_PUSH),
  onArranging: on(CH.TIMERS_ARRANGING),
  onConfig: on(CH.CONFIG_CHANGED),
  getConfig: () => ipcRenderer.invoke(CH.CONFIG_GET),
  fit: (size) => ipcRenderer.send(CH.TIMERS_FIT, size),
});
