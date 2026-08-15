// CommonJS (.cjs) on purpose: package.json sets "type": "module", and a sandboxed
// preload must be CommonJS. The .cjs extension makes Electron load it correctly
// regardless of the type field.
const { contextBridge, ipcRenderer } = require('electron');

// Mirrors CHANNELS in src/main/ipc.js — a preload cannot import an ES module, so the
// names are repeated here and must be kept in sync by hand, as the other preloads do.
const CH = {
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_DURATION_DEFAULTS: 'config:duration-defaults',
  TRIGGERS_LIST: 'triggers:list',
  TRIGGERS_GET: 'triggers:get',
  TRIGGERS_IMPORT: 'triggers:import',
  TRIGGERS_EXPORT: 'triggers:export',
  TRIGGERS_REMOVE: 'triggers:remove',
  TRIGGERS_SET_ENABLED: 'triggers:set-enabled',
  TRIGGERS_SET_PART_ENABLED: 'triggers:set-part-enabled',
  TRIGGERS_CREATE_PACK: 'triggers:create-pack',
  TRIGGERS_SAVE_TRIGGER: 'triggers:save-trigger',
  TRIGGERS_DELETE_TRIGGER: 'triggers:delete-trigger',
  TRIGGERS_TEST_PATTERN: 'triggers:test-pattern',
  TRIGGERS_DRY_RUN: 'triggers:dry-run',
  TRIGGERS_SET_BUILTIN: 'triggers:set-builtin',
  TRIGGERS_SET_PRESET: 'triggers:set-preset',
};

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke(CH.CONFIG_GET),
  /** Only the two surface switches and the seven duration keys are ever written from
      here — see triggers.js. */
  setConfig: (patch) => ipcRenderer.invoke(CH.CONFIG_SET, patch),
  getDurationDefaults: () => ipcRenderer.invoke(CH.CONFIG_DURATION_DEFAULTS),

  list: () => ipcRenderer.invoke(CH.TRIGGERS_LIST),
  get: (id) => ipcRenderer.invoke(CH.TRIGGERS_GET, id),
  import: () => ipcRenderer.invoke(CH.TRIGGERS_IMPORT),
  export: (id) => ipcRenderer.invoke(CH.TRIGGERS_EXPORT, id),
  remove: (id) => ipcRenderer.invoke(CH.TRIGGERS_REMOVE, id),
  setEnabled: (id, enabled) => ipcRenderer.invoke(CH.TRIGGERS_SET_ENABLED, { id, enabled }),
  setPartEnabled: (payload) => ipcRenderer.invoke(CH.TRIGGERS_SET_PART_ENABLED, payload),

  createPack: (name) => ipcRenderer.invoke(CH.TRIGGERS_CREATE_PACK, { name }),
  saveTrigger: (payload) => ipcRenderer.invoke(CH.TRIGGERS_SAVE_TRIGGER, payload),
  deleteTrigger: (payload) => ipcRenderer.invoke(CH.TRIGGERS_DELETE_TRIGGER, payload),
  testPattern: (payload) => ipcRenderer.invoke(CH.TRIGGERS_TEST_PATTERN, payload),
  dryRun: (payload) => ipcRenderer.invoke(CH.TRIGGERS_DRY_RUN, payload),

  setBuiltin: (key, enabled) => ipcRenderer.invoke(CH.TRIGGERS_SET_BUILTIN, { key, enabled }),
  setPreset: (name) => ipcRenderer.invoke(CH.TRIGGERS_SET_PRESET, name),
});
