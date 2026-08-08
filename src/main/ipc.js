/**
 * The IPC contract between the main process and both renderers.
 *
 * Kept in one file, imported by main.js and by the preload scripts, so a renamed
 * channel breaks at import time instead of silently doing nothing at runtime.
 */

export const CHANNELS = {
  // main -> renderer (pushes)
  SNAPSHOT: 'overlay:snapshot',
  STATUS: 'overlay:status',
  CONFIG_CHANGED: 'config:changed',
  TOAST: 'overlay:toast',
  LOCK_CHANGED: 'overlay:lock-changed',
  HOVER: 'overlay:hover',
  /** 'below' (the usual) or 'above', when the window is against the bottom of the screen. */
  PANEL_SIDE: 'overlay:panel-side',
  /**
   * A fight was appended to the history store — `{ key }` names whose file grew. Sent
   * to the history window so an open one can refresh its rail live instead of showing
   * a list frozen at whatever moment it was opened.
   */
  HISTORY_APPENDED: 'history:appended',
  /**
   * A play session was written — `{ key }` names whose file grew. The session window's
   * twin of HISTORY_APPENDED, and it matters more here: a session closes after an hour of
   * silence, so an open window would otherwise show a rail frozen at whatever moment it
   * was opened, with last night's session permanently missing from it.
   */
  SESSION_APPENDED: 'session:appended',

  // renderer -> main (invoke, returns a value)
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  LOGS_LIST: 'logs:list',
  LOGS_PICK: 'logs:pick',
  LOGS_VALIDATE: 'logs:validate',
  /**
   * Truncate the followed eqlog to zero bytes; the tailer's reset path handles the rest.
   *
   * Refuses while GINA or GamParse is running — both tail the same file by byte position,
   * and emptying it under them leaves them reading past the end and silently dead.
   */
  LOGS_CLEAR: 'logs:clear',
  /**
   * The game client's own settings file.
   *
   * `EQCONFIG_STATE` reports whether `Log=1` is set and where the file is; `ENABLE_LOG`
   * sets it. Separate from the config channels because this writes to a file that is not
   * ours — it belongs to the player and to EverQuest — and a channel that could be
   * mistaken for our own settings is the wrong shape for that.
   */
  EQCONFIG_STATE: 'eqconfig:state',
  EQCONFIG_ENABLE_LOG: 'eqconfig:enable-log',
  SETUP_COMPLETE: 'setup:complete',
  OPEN_SETTINGS: 'window:open-settings',
  /** Encounter history (history window): list index, fetch one record, wipe a file. */
  HISTORY_LIST: 'history:list',
  HISTORY_GET: 'history:get',
  HISTORY_CLEAR: 'history:clear',
  /**
   * What the parser currently knows about pets: mappings in force, and names that are
   * getting their own row with nothing proving they are players. The settings form has
   * always been able to WRITE a mapping; this is what finally tells the player which
   * names need one.
   */
  PETS_STATE: 'pets:state',

  /**
   * Trigger packs, for the settings window.
   *
   * `TRIGGERS_IMPORT` opens a file dialog and returns the import REPORT — what arrived,
   * what was dropped and by name — rather than a bare ok/failed. That report is the
   * headline of the feature: a GINA pack is a stranger's work written for a different
   * server, and the only honest thing to show is exactly what crossed over.
   */
  TRIGGERS_LIST: 'triggers:list',
  /** One pack in full — the groups and triggers the list only counts. Fetched per pack
   *  rather than bundled into the list, because a rail of ten packs needs ten names and
   *  the body of exactly one. */
  TRIGGERS_GET: 'triggers:get',
  TRIGGERS_IMPORT: 'triggers:import',
  TRIGGERS_EXPORT: 'triggers:export',
  TRIGGERS_REMOVE: 'triggers:remove',
  TRIGGERS_SET_ENABLED: 'triggers:set-enabled',
  /** One group or one trigger inside a pack — how a pack that ships EnableByDefault=False
   *  gets switched on a group at a time, which is how its author meant it to be used. */
  TRIGGERS_SET_PART_ENABLED: 'triggers:set-part-enabled',
  /**
   * Make a new, empty pack.
   *
   * Its own channel rather than a side effect of `saveTrigger`, which is how "My
   * Triggers" comes into being — conjured on the first save and invisible in the rail
   * until it holds something. That is fine for the one pack the app can name in advance
   * and wrong for every other: a player organising their own triggers into a pack per
   * boss needs the pack to exist before it has contents, and "save a trigger somewhere
   * else to create the thing you wanted to save it in" is not an order anyone would
   * guess. Creating and filling are two intents, so they are two channels.
   */
  TRIGGERS_CREATE_PACK: 'triggers:create-pack',
  /** Authoring: save, delete, and test a pattern against the player's own log. */
  TRIGGERS_SAVE_TRIGGER: 'triggers:save-trigger',
  TRIGGERS_DELETE_TRIGGER: 'triggers:delete-trigger',
  TRIGGERS_TEST_PATTERN: 'triggers:test-pattern',
  /** Replay a whole pack against the player's log and report what actually fires. */
  TRIGGERS_DRY_RUN: 'triggers:dry-run',
  /**
   * The rules this app ships with, switched from the same window as imported packs.
   *
   * These write ordinary config keys — `castAlerts`, the six `warn*`, `summonAlerts`,
   * `ccAlerts` — rather than anything pack-shaped; `builtin-pack.js` owns the
   * translation. They get their own channels instead of riding CONFIG_SET so the
   * renderer names a ROW, not a config key: a window that could set arbitrary keys by
   * name is a wider door than this one needs.
   */
  TRIGGERS_SET_BUILTIN: 'triggers:set-builtin',
  TRIGGERS_SET_PRESET: 'triggers:set-preset',
  /** Open the Triggers window — the settings form's entry point to it. */
  TRIGGERS_OPEN: 'triggers:open',

  /**
   * Play sessions, for the session window.
   *
   * The same three-channel shape history uses, plus one that history does not need:
   * `SESSION_CURRENT` returns the session in FLIGHT. A fight is over by the time you
   * browse it, but the session you most want to read is usually the one you are in, and
   * it is not on disk yet — only a checkpoint of it is.
   */
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  SESSION_CURRENT: 'session:current',
  SESSION_CLEAR: 'session:clear',
  /**
   * Replay a log file into the session store.
   *
   * `scripts/backfill-history.js` has done this for encounters from the command line
   * since the history window shipped, which is a capability nobody without a terminal
   * has. Same logic, reachable from the window that shows the result.
   */
  SESSION_IMPORT: 'session:import',
  /** Open the Session window — the settings form's entry point to it. */
  SESSION_OPEN: 'session:open',

  // renderer -> main (fire and forget)
  SET_IGNORE_MOUSE: 'window:set-ignore-mouse',
  /**
   * `{ height, extraWidth, panelOpen }`. The renderer measures, main decides: it alone
   * knows the resting bounds, the display and the clamps. `extraWidth` is how many
   * pixels the breakdown's name columns are short — main widens the CURRENT width by
   * that much while the panel is open, and restores the RESTING width when it closes.
   */
  FIT_WINDOW: 'window:fit',
  CLOSE_WINDOW: 'window:close',
  RESET_ENCOUNTER: 'overlay:reset',
  TOGGLE_LOCK: 'overlay:toggle-lock',
  TOGGLE_METRIC: 'overlay:toggle-metric',
};

/**
 * Snapshots are pushed at this rate, not on every log line.
 *
 * A busy raid produces hundreds of lines per second; forwarding each one would spend
 * the whole frame budget on IPC and structured cloning. 4 Hz is well past the point
 * where a DPS number reads as live.
 */
export const PUSH_HZ = 4;
export const PUSH_INTERVAL_MS = 1000 / PUSH_HZ;
