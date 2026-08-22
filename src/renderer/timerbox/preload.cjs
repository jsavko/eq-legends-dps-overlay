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
};

const on = (channel) => (handler) =>
  ipcRenderer.on(channel, (_event, payload) => handler(payload));

// No config channel here any more. A box used to read the global text scale itself; it
// is now told its size in pixels with every push, which is one number arriving one way
// instead of two halves of a size arriving on two channels and having to agree.
contextBridge.exposeInMainWorld('api', {
  onTimers: on(CH.TIMERS_PUSH),
  onArranging: on(CH.TIMERS_ARRANGING),
  fit: (size) => ipcRenderer.send(CH.TIMERS_FIT, size),
});
