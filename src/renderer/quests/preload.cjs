// CommonJS (.cjs) on purpose: package.json sets "type": "module", and a sandboxed
// preload must be CommonJS. The .cjs extension makes Electron load it correctly
// regardless of the type field.
const { contextBridge, ipcRenderer } = require('electron');

// Mirrors CHANNELS in src/main/ipc.js — a preload cannot import an ES module, so the
// names are repeated here and must be kept in sync by hand, as the other preloads do.
const CH = {
  QUESTS_GET: 'quests:get',
  QUESTS_SET_OWNED: 'quests:set-owned',
  QUESTS_SET_DONE: 'quests:set-done',
  QUESTS_IMPORT: 'quests:import',
  QUESTS_CHANGED: 'quests:changed',
};

contextBridge.exposeInMainWorld('api', {
  /** The whole resolved ledger: classes, quests, items, counts and flags. */
  get: () => ipcRenderer.invoke(CH.QUESTS_GET),
  /** The two manual claims, named by the dataset's positional refs. */
  setOwned: (ref, owned) => ipcRenderer.invoke(CH.QUESTS_SET_OWNED, { ref, owned }),
  setDone: (ref, done) => ipcRenderer.invoke(CH.QUESTS_SET_DONE, { ref, done }),
  /** File dialog for an eqlposky.com progress export; answers with the import report. */
  importExport: () => ipcRenderer.invoke(CH.QUESTS_IMPORT),
  /** The ledger moved (a loot counted, a character switch) — the cue to refetch. */
  onChanged: (handler) => ipcRenderer.on(CH.QUESTS_CHANGED, () => handler()),
});
