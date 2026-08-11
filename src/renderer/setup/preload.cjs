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
  PETS_STATE: 'pets:state',
  ROSTER_STATE: 'roster:state',
  PETS_NOT_A_PET: 'pets:not-a-pet',
  TRIGGERS_OPEN: 'triggers:open',
  TRIGGERS_LIST: 'triggers:list',
  SESSION_OPEN: 'session:open',
  SESSION_LIST: 'session:list',
  EQCONFIG_STATE: 'eqconfig:state',
  EQCONFIG_ENABLE_LOG: 'eqconfig:enable-log',
};

const modeArg = process.argv.find((a) => a.startsWith('--overlay-mode='));

contextBridge.exposeInMainWorld('api', {
  mode: modeArg ? modeArg.split('=')[1] : 'setup',
  getConfig: () => ipcRenderer.invoke(CH.CONFIG_GET),
  setConfig: (patch) => ipcRenderer.invoke(CH.CONFIG_SET, patch),
  listLogs: (dir) => ipcRenderer.invoke(CH.LOGS_LIST, dir),
  pick: (what) => ipcRenderer.invoke(CH.LOGS_PICK, what),
  validate: (filePath) => ipcRenderer.invoke(CH.LOGS_VALIDATE, filePath),
  clearLog: () => ipcRenderer.invoke(CH.LOGS_CLEAR),
  complete: (patch) => ipcRenderer.invoke(CH.SETUP_COMPLETE, patch),
  petsState: () => ipcRenderer.invoke(CH.PETS_STATE),
  rosterState: () => ipcRenderer.invoke(CH.ROSTER_STATE),
  notAPet: (name) => ipcRenderer.invoke(CH.PETS_NOT_A_PET, name),
  /** The alert switches live in their own window now — this is the way in. */
  openTriggers: () => ipcRenderer.invoke(CH.TRIGGERS_OPEN),
  triggersList: () => ipcRenderer.invoke(CH.TRIGGERS_LIST),
  /** Session stats own this form's switches, but the browsing surface is its own window. */
  openSession: () => ipcRenderer.invoke(CH.SESSION_OPEN),
  sessionList: (key) => ipcRenderer.invoke(CH.SESSION_LIST, key),
  /** EverQuest's own settings file — read what it says, and set Log=1 in it. */
  eqconfigState: () => ipcRenderer.invoke(CH.EQCONFIG_STATE),
  enableGameLogging: () => ipcRenderer.invoke(CH.EQCONFIG_ENABLE_LOG),
});
