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
   * "Copy the meter" — the hotkey's half of the COPY button.
   *
   * This one carries an INTENT and no payload, which is the exact opposite of
   * `CLIPBOARD_COPY` below, and for the same reason. The line has to be the rows the
   * overlay is showing with the filters the current metric applies, and that lives in the
   * renderer; so the hotkey asks the renderer to do what the button does, and the renderer
   * comes back through `CLIPBOARD_COPY` with finished text. Main never composes the line.
   *
   * The result is one code path rather than two implementations kept in step — the hotkey
   * and the button cannot disagree about what the meter says, by construction.
   */
  COPY_REPORT: 'overlay:copy-report',
  /**
   * The engaged-drops popup's whole feed: `{ phase, groups }` while a matched Sky
   * boss is engaged or its kill is still being looted, `null` otherwise. Its own
   * channel rather than a rider on SNAPSHOT because the popup is the only window
   * that wants it — the other click-through windows would carry the payload four
   * times a second for nothing — and main pushes it only when it changes.
   */
  DROPS: 'drops:state',
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

  /**
   * The second screen's pairing state moved — the server started, stopped or failed
   * after a settings change. Pushed to an open Second Screen dialog so a switch
   * flipped in Settings redraws the QR code (or the "switched off" note) live,
   * instead of leaving a dialog frozen at whatever was true when it opened.
   */
  MOBILE_CHANGED: 'mobile:changed',

  /**
   * The quest ledger moved — a loot was counted, a flag was toggled, an import landed.
   * Sent to the Quests window so an open one refetches instead of showing a checklist
   * frozen at whatever moment it was opened. Payloadless: the window asks QUESTS_GET
   * for the whole picture, which is small and saves inventing a delta format.
   */
  QUESTS_CHANGED: 'quests:changed',

  // renderer -> main (invoke, returns a value)
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  /**
   * The notification-duration defaults, for the Durations dialog's "reset to
   * defaults". Fetched rather than restated in the renderer so the numbers live in
   * exactly one place (config.js) — a copy over there would drift the first time a
   * default is retuned, and the failure would be a reset button that quietly lies.
   */
  CONFIG_DURATION_DEFAULTS: 'config:duration-defaults',
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
   * Everyone the parser counts as one of us, for the two pickers in settings.
   *
   * Names with enough beside each to tell people apart in a public zone — whether it is
   * you, whether the game said they are in your group, and what they have actually done
   * this fight — plus the character key, because the party list is per character.
   *
   * A picker rather than a text box is the whole point. A mistyped name in a filter does
   * not fail, it hides a person who is right there and says nothing; a mistyped pet OWNER
   * folds real damage into somebody who does not exist. Neither can happen to a name you
   * clicked, so this channel is what makes the typo impossible rather than merely caught.
   */
  ROSTER_STATE: 'roster:state',

  /**
   * Blacklist a name the settings picker says is not a pet.
   *
   * The same gesture `pet <name> = clear` already performs in chat, and it blacklists
   * rather than merely forgetting: without that the next summon that fires nearby
   * re-learns the same wrong answer a minute later.
   */
  PETS_NOT_A_PET: 'pets:not-a-pet',

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

  // ------------------------------------------------------------------ timer boxes
  /**
   * The player's own countdown boxes: categories they name and place, and the timers in
   * them. A separate channel family from TRIGGERS_* on purpose — a timer here is a name,
   * a log line, a duration and a colour, and none of the pack machinery is involved.
   */
  TIMERS_GET: 'timers:get',
  TIMERS_SAVE_CATEGORY: 'timers:save-category',
  TIMERS_REMOVE_CATEGORY: 'timers:remove-category',
  TIMERS_SAVE_TIMER: 'timers:save-timer',
  TIMERS_REMOVE_TIMER: 'timers:remove-timer',
  /** Turn on the mode where every box goes solid, names itself and can be dragged. */
  TIMERS_ARRANGE: 'timers:arrange',
  /** Put a sample row in one box now, so it can be seen and found. */
  TIMERS_PREVIEW: 'timers:preview',
  /** Measure the player's own effects out of their own log — buff length depends on
   *  their level, the rank they cast and their AAs, so it cannot come from a table. */
  TIMERS_MEASURE: 'timers:measure',
  /** Take every preview row off the screen. A button that reveals something and offers
   *  no way to put it back is a button that leaves a mess on the player's screen. */
  TIMERS_CLEAR_PREVIEWS: 'timers:clear-previews',
  /**
   * A click-through panel telling us how big it needs to be.
   *
   * The alerts and the drops popup were sized for their worst realistic content and left
   * that size always — fine while they are click-through, and blocking the moment they
   * are not: an invisible 640x720 rectangle over the top of the screen swallows every
   * click meant for whatever is behind it. Each anchors differently (the alerts by their
   * top CENTRE, the drops by their bottom-right corner), so main keeps the anchor and
   * only the size comes from here.
   */
  PANEL_FIT: 'overlay:panel-fit',
  /** Main → box: the rows for that box, plus its title. */
  TIMERS_PUSH: 'timers:push',
  /** Main → box: arranging on or off. */
  TIMERS_ARRANGING: 'timers:arranging',
  /** Box → main: how big this window needs to be. The one message that keeps a box from
   *  being an oversized invisible rectangle that swallows other windows' clicks. */
  TIMERS_FIT: 'timers:fit',
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
   * The same channel shape history uses, and deliberately no extra channel for the session
   * in FLIGHT. There was one — `session:current` — and it was removed once the live
   * session became an ordinary row in the rail: `SESSION_LIST` includes it and
   * `SESSION_GET` serves it, ids being `String(startTs)` on both sides of the moment it
   * closes. A second way to fetch the same record is a second thing to keep in step.
   */
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
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

  /**
   * The Plane of Sky quest ledger, for the Quests window.
   *
   * `QUESTS_GET` answers with the whole resolved picture — every class, quest and item,
   * data names joined with this character's counts and flags. `SET_OWNED` / `SET_DONE`
   * are the manual toggles, named by the positional refs the dataset defines
   * ("bard:0:0" / "bard:0"). `QUESTS_IMPORT` opens a file dialog for an eqlposky.com
   * progress export and returns the import report — what it set, dated by the export's
   * own `exportedAt` — because an import is a snapshot claim, not a sync.
   */
  QUESTS_GET: 'quests:get',
  QUESTS_SET_OWNED: 'quests:set-owned',
  QUESTS_SET_DONE: 'quests:set-done',
  QUESTS_IMPORT: 'quests:import',
  /** Open the Quests window — the settings form's entry point to it. */
  QUESTS_OPEN: 'quests:open',

  /**
   * Everything the Second Screen dialog needs to draw itself: whether the feature is
   * on, whether the server actually started, and the URL(s) a phone can reach —
   * token included, because the URL IS the pairing. The dialog renders the QR code
   * itself (vendored encoder, src/renderer/vendor/qrcode.js); main only states facts.
   */
  MOBILE_STATE: 'mobile:state',
  /** Open the Second Screen dialog — the settings form's entry point to it. */
  MOBILE_OPEN: 'mobile:open',

  /**
   * Put a finished line of text on the Windows clipboard.
   *
   * The renderer sends the TEXT, not a "copy the meter" intent, which is the opposite of
   * how `TRIGGERS_SET_BUILTIN` names a row rather than a config key — and deliberately.
   * The line has to be the rows the overlay is showing, in the order it is showing them,
   * with the filters the current metric applies; main would have to re-derive all of
   * that from `parser.snapshot()` and `config.metric`, and the failure mode of the two
   * drifting apart is silent — a copied line that disagrees with the meter, discovered
   * only once it is in guild chat. `report.js` is that logic, shared with `render()`,
   * and it lives in the renderer because that is where the rows are.
   *
   * `invoke`, not a send, so the renderer can toast after the write actually happened.
   */
  CLIPBOARD_COPY: 'clipboard:copy',

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
