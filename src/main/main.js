/**
 * Electron main process: owns the parser, the tailer, every window and the hotkeys.
 *
 * Four float over the game or sit beside it — the meter, the alert banners, the boss
 * timers and the history browser — plus the settings form. Each keeps its own bounds
 * key and none derives its placement from another's; what they share is the lock
 * gesture and the hide hotkey, not a position.
 *
 * The renderers are pure views. Every piece of state lives here and is pushed to them
 * at a fixed rate (see ipc.js), which keeps a busy raid from turning into an IPC storm.
 */

import {
  app, BrowserWindow, clipboard, globalShortcut, ipcMain, dialog, screen, shell, Tray, Menu, nativeImage,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LogParser } from '../parser/index.js';
import { parseTimestamp } from '../parser/timestamp.js';
import { nearestName } from '../parser/entities.js';
import { Tailer, listLogs } from './tailer.js';
import {
  ConfigStore, DEFAULT_LOG_DIR, ALERT_KEYS, TIMER_KEYS, DROPS_KEYS, MOBILE_KEYS,
  alertsEnabled, timersEnabled, dropsEnabled, partyListFor,
  ALERT_PRESETS, warnKeyFor, presetOf, sessionEnabled, sessionCategories,
  DURATION_KEYS, DURATION_DEFAULTS, durationSec, alertTtls,
} from './config.js';
import { MobileServer, generateToken, lanAddresses, DEFAULT_MOBILE_PORT } from './mobile.js';
import { EncounterStore, RECORD_VERSION, storeKey, combatBetween } from './history.js';
import { SessionStore, sessionKey, listEntry, CHECKPOINT_INTERVAL_MS } from './session-store.js';
import { SessionTracker } from '../session/session.js';
import { QuestProgress } from '../quests/progress.js';
import { parseInventory } from '../quests/inventory.js';
import { bossNeeds, engagedNeeds, nextDropsState, dropsDisplay } from '../quests/needs.js';
import { TriggerStore } from './triggers-store.js';
import { builtinPack, builtinPatch, builtinPresetPatch } from './builtin-pack.js';
import { TriggerEngine } from '../triggers/engine.js';
import { parseGinaPackage } from '../triggers/gina.js';
import { exportGinaPackage } from '../triggers/gina-export.js';
import { createTrigger, updateTrigger, deleteTrigger, packStats } from '../triggers/pack.js';
import { installSeedPack } from '../triggers/seed-pack.js';
import { patternTemplate } from '../triggers/tokens.js';
import { dryRunLog, readLogTail, testPattern } from '../triggers/dryrun.js';
import { mineBuffsLog } from '../triggers/mine-buffs.js';
import { TimersStore } from './timers-store.js';
import { TimersRuntime } from '../timers/runtime.js';
import {
  addCategory, updateCategory, removeCategory, addTimer, updateTimer, removeTimer,
  BOSS_CATEGORY, PALETTE, LOOK, boxLook, clampLook,
} from '../timers/model.js';
import {
  setLogEnabled, isLogEnabled, eqclientIniPath, runningLogReaders, GAME_PROCESS,
} from './eqconfig.js';
import { CHANNELS, PUSH_INTERVAL_MS } from './ipc.js';
import { clampHeight, clampWidth, placeWindow } from './layout.js';
import {
  startUpdater, updateMode, fetchLatestVersion, isNewerVersion, RELEASES_URL,
  STARTUP_DELAY_MS, CHECK_INTERVAL_MS, fileLogger,
} from './updater.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(HERE, '..', 'renderer');
const ASSETS = path.join(HERE, '..', 'assets');

/**
 * A log not written to in this long is probably a session where /log was never enabled.
 *
 * One caller now: `LOG_VALIDATE`, which the settings window asks about a file the player is
 * choosing. That is the right question there — nothing is tailing that file, so its mtime
 * is the only evidence there is, and the answer is wanted at the moment of choosing rather
 * than continuously.
 *
 * It is emphatically NOT the right question about the file being tailed, which is why the
 * overlay's own stale warning is gone: see `pushStatus`. If a live staleness check is ever
 * wanted again, the honest source is the tailer, which knows when it last read bytes —
 * `tailer.js` rejected mtime for its own switch detection for exactly this reason.
 */
const STALE_LOG_MS = 10 * 60 * 1000;

/** @type {BrowserWindow|null} */ let overlayWindow = null;
/** @type {BrowserWindow|null} */ let setupWindow = null;
/** @type {BrowserWindow|null} */ let historyWindow = null;
/** @type {BrowserWindow|null} */ let triggersWindow = null;
/** @type {BrowserWindow|null} */ let alertsWindow = null;
/**
 * The player's timer boxes, keyed by category id.
 *
 * A Map rather than named handles because there is no fixed number of them: the player
 * adds and removes boxes, and every window list in this file has to reach these too.
 * `boxWindows()` is the accessor those lists use, so a new list cannot quietly forget
 * them.
 * @type {Map<string, BrowserWindow>}
 */
const timerBoxes = new Map();
/** @type {BrowserWindow|null} the Timers manager */ let timerSetupWindow = null;
/** @type {TimersStore|null} */ let timersStore = null;
/** @type {TimersRuntime|null} */ let timersRuntime = null;
/** True while the player is placing boxes: they go solid, name themselves and drag. */
let arrangingBoxes = false;
/** @type {Map<string, NodeJS.Timeout>} per-box bounds debounce, keyed by category id */
const saveBoxBoundsTimers = new Map();
/** @type {BrowserWindow|null} */ let dropsWindow = null;
/** @type {LogParser|null} */    let parser = null;
/** @type {Tailer|null} */       let tailer = null;
/** @type {ConfigStore|null} */  let config = null;
/** @type {Tray|null} */         let tray = null;
/** @type {EncounterStore|null} */ let history = null;
/** @type {TriggerStore|null} */  let triggerStore = null;
/**
 * The trigger runtime — a SIBLING of the parser, fed the same lines.
 *
 * It lives beside `parser` rather than inside it so a regex out of a stranger's pack can
 * never reach the code that decides who did the damage: a bad pack costs the triggers in
 * that pack, and the meter and the history carry on. See src/triggers/engine.js.
 */
/** @type {TriggerEngine|null} */ let triggers = null;
/**
 * The session tracker — a SECOND sibling of the parser, on the same terms as the triggers.
 *
 * Null whenever `session.enabled` is off, and that is the entire cost of the feature to
 * someone who does not want it: `main` never constructs it, so no session regex ever runs,
 * nothing accumulates, and the tray has no entry. The store is built either way, because
 * the window has to be able to read what past sessions recorded even after tracking is
 * switched back off.
 */
/** @type {SessionTracker|null} */ let session = null;
/** @type {SessionStore|null} */  let sessionStore = null;
/**
 * The second-screen server — pure Node like the parser, constructed only while
 * `mobileEnabled` is on, on exactly the session tracker's terms: switched off, it is
 * never built, no port opens, and the feature costs nothing.
 */
/** @type {MobileServer|null} */  let mobileServer = null;
/** @type {BrowserWindow|null} */ let secondScreenWindow = null;
/** @type {BrowserWindow|null} */ let sessionWindow = null;
/**
 * The Plane of Sky quest ledger — a THIRD sibling of the parser, same terms again.
 * Always constructed: unlike the session tracker it has no master switch, because its
 * whole cost when idle is four anchored regexes per line and a lookup that misses.
 */
/** @type {QuestProgress|null} */ let quests = null;
/** @type {BrowserWindow|null} */ let questsWindow = null;
let saveQuestsBoundsTimer = null;
/** Polls for a fresh `/outputfile inventory` dump beside the log. */
let inventoryPollTimer = null;
const INVENTORY_POLL_MS = 5000;

/**
 * Quest-loot chips in flight, merged into the warning stack by buildSnapshot. Kept
 * here rather than in the parser (which knows nothing about quests) or the tracker
 * (which is pure bookkeeping): a chip is a presentation fact, and this is the
 * presentation process. Ids start far above the parser's and the trigger engine's
 * (WARNING_ID_BASE = 1e9) so the renderer's per-id chip map can never collide.
 */
let questChips = [];
let questChipSeq = 2_000_000_000;
/** Bumped when a chip arrives or expires, so the push loop cannot strand a stale one. */
let questChipsRevision = 0;
let lastQuestChipsRevision = -1;

let pushTimer = null;
let checkpointTimer = null;
let saveSessionBoundsTimer = null;
let lastSessionRevision = -1;
let stopUpdater = null;
/** Runs the background updater's own check now. Null in `off` mode, where there is none. */
let backgroundUpdateCheck = null;
/** Which of the three update behaviours this copy has, decided once at startup. */
let currentUpdateMode = 'off';
/**
 * The standing "there is a newer version" notice, or null.
 *
 * State rather than only a toast because it stays true until it is acted on. A toast is
 * gone in twelve seconds and takes the news with it — which is most of why an update could
 * be sitting there for a week without the player ever being told twice.
 *
 * `auto` is carried alongside because "there is a newer version" means two different things
 * depending on the copy: one is being handled for you and one is a job you have to do. A
 * notice that cannot tell them apart makes an installed copy look as helpless as a portable
 * one, which is the whole reason the modes exist.
 *
 * @type {{version: string, ready: boolean, auto: boolean}|null}
 */
let updateNotice = null;
/** One check at a time, so a double-click on the tray item cannot start two. */
let updateCheckBusy = false;
/** The startup and recurring handles for the read-only check that runs in every mode. */
const quietUpdateTimers = [];
let lastRevision = -1;
let lastTimersRevision = -1;
let lastTriggerRevision = -1;
let overlayVisible = true;
let saveBoundsTimer = null;
let saveHistoryBoundsTimer = null;
let saveTriggersBoundsTimer = null;
let saveAlertsBoundsTimer = null;
let saveTimersBoundsTimer = null;
let saveDropsBoundsTimer = null;
/**
 * The engaged-drops popup's lifetime, advanced once per push tick by the pure state
 * machine in needs.js — engaged, lingering while the corpse is looted, or null.
 * `lastDropsJson` is the change gate: the popup gets a push only when its payload
 * actually differs, which between pulls means it gets nothing at all.
 */
let dropsState = null;
let lastDropsJson = 'null';
let hoverTimer = null;
/**
 * Where the player put the window. Auto-fit reads these and never writes them.
 *
 * All three axes that auto-fit touches need one: the breakdown borrows height AND
 * width, and against the right screen edge extra width moves x. Fitting from current
 * bounds instead of resting ones is how the overlay once climbed the screen — each
 * open moved it, the next open started from the moved position, and `remember`
 * persisted the drift as the player's own choice.
 */
let restingY = null;
let restingX = null;
let restingWidth = null;
/** Our last auto-fit, so `remember` can tell our moves from the player's. */
let lastFitY = null;
let lastFitX = null;
let lastFitWidth = null;

// A second instance would fight the first for the same log and hotkeys.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = overlayWindow ?? setupWindow;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
    }
  });
  app.whenReady().then(main);
}

async function main() {
  config = new ConfigStore(app.getPath('userData'));
  config.load();
  history = new EncounterStore(path.join(app.getPath('userData'), 'history'));
  sessionStore = new SessionStore(path.join(app.getPath('userData'), 'sessions'));
  recoverSessions();
  quests = new QuestProgress({
    dir: path.join(app.getPath('userData'), 'quests'),
    // The history store's policy: a full disk must not take the live overlay down.
    onWriteError: (err) => toast(`Quest ledger write failed: ${err.message}`),
  });
  triggerStore = new TriggerStore(path.join(app.getPath('userData'), 'triggers'));
  installSeedTimers();
  // The player's own countdown boxes. Its own store and its own runtime, sharing only
  // the line stream — a timer here is a name, a log line, a duration and a colour, and
  // none of the pack machinery is involved.
  timersStore = new TimersStore(app.getPath('userData'));
  timersRuntime = new TimersRuntime();
  timersRuntime.setModel(timersStore.load());
  triggers = new TriggerEngine({
    warnTtlMs: durationSec(config.all, 'triggerChipSec') * 1000,
  });
  reloadTriggerPacks();

  registerIpc();
  createTray();

  if (config.isConfigured()) {
    await startTailing(config.get('logPath'));
    createOverlay();
    // One window, three switches: it exists if ANY category is on and mute is off.
    if (alertsEnabled(config.all)) createAlerts();
    // The timers get their own, on their own switch — see createTimersWindow.
    // The boss-timer box and the player's own are the same kind of window now.
    syncTimerBoxes();
    // And the engaged-drops popup, likewise — see createDropsWindow.
    if (dropsEnabled(config.all)) createDropsWindow();
  } else {
    createSetup('setup');
  }

  // Never awaited: a port squatter must not stand between the player and the overlay.
  void syncMobileServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlay();
  });

  // Last, and never awaited: an updater that cannot start — no network, a tree without
  // the dependency installed — must not stand between the player and their overlay.
  currentUpdateMode = updateMode({
    isPackaged: app.isPackaged, exePath: process.execPath, env: process.env,
  });
  startUpdater({
    mode: currentUpdateMode,
    toast,
    onUpdate: noteUpdate,
    version: app.getVersion(),
    logPath: updateLogPath(),
  })
    .then(({ stop, check }) => { stopUpdater = stop; backgroundUpdateCheck = check; })
    .catch((err) => { console.warn('[updater] failed to start:', err?.message ?? err); });

  // Runs in EVERY mode, `off` included, and the distinction it rests on is the whole point:
  // win-unpacked is excluded from INSTALLING an update, not from knowing one exists. This
  // only ever reads a version number, so it cannot violate that rule — and without it the
  // footer notice would never appear on the build James actually launches, which is the one
  // that most needs telling, since nothing else will ever mention it.
  quietUpdateTimers.push(setTimeout(quietUpdateCheck, STARTUP_DELAY_MS));
  quietUpdateTimers.push(setInterval(quietUpdateCheck, CHECK_INTERVAL_MS));
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/**
 * The version this copy compares itself against.
 *
 * `EQL_UPDATE_TEST_VERSION` overrides it, and exists because the update path is otherwise
 * impossible to exercise without cutting a release: the newest release IS this version for
 * everyone running the current build, so a check honestly finds nothing and there is no way
 * to tell "working, nothing to do" from "not working". Launch with the variable set to an
 * older number and the whole path — the check, the footer notice, the tray entry — behaves
 * exactly as it will on the day a real release lands.
 *
 * Read every time rather than cached at startup so it cannot go stale, and read from the
 * environment rather than config so it can never be left switched on by accident.
 */
/**
 * Where the update log lives: beside the config, in `%APPDATA%\eq-legends-dps-overlay`.
 *
 * Not in the install directory — that gets replaced by the very updates the log describes,
 * which would throw away the record of the thing that just happened.
 */
function updateLogPath() {
  return path.join(app.getPath('userData'), 'update.log');
}

/** The same log electron-updater writes to, so both halves of a check land in one file. */
let updateLog = null;
function logUpdate(message) {
  updateLog ??= fileLogger(updateLogPath());
  updateLog.info(message);
}

function selfVersion() {
  const override = process.env.EQL_UPDATE_TEST_VERSION;
  return override ? String(override).trim() : app.getVersion();
}

/**
 * Record that a newer version exists, and put it where it can be seen.
 *
 * The footer notice and the tray both re-derive from this, so the two can never disagree
 * about whether there is an update.
 */
function noteUpdate({ version, ready }) {
  // A download that has finished must not be talked back down to "available" by a later
  // check reporting the same version — `ready` only ever moves forwards for a given one.
  const stillReady = ready || (updateNotice?.ready === true && updateNotice.version === version);
  updateNotice = { version, ready: stillReady, auto: reportsAsAuto() };
  pushStatus();
  refreshTrayMenu();
}

/**
 * Should the notice SAY this copy is updating itself?
 *
 * `EQL_UPDATE_TEST_AUTO` forces a yes, and is deliberately narrower than it looks: it
 * changes only what the footer and the tray say, never what the updater does. The real
 * mode still governs `startUpdater`, so a win-unpacked copy under this flag talks like an
 * installed one and still downloads and installs nothing — which is the entire point.
 * Forcing the real mode instead would hand `autoDownload` to a copy that must never have
 * it, and quietly install a second app under Programs: exactly the accident `updateMode`
 * exists to prevent.
 *
 * It earns its place because the auto wording is otherwise unreachable without a genuine
 * NSIS install plus a genuine newer release, and that is a lot of setup to read one line.
 */
function reportsAsAuto() {
  if (process.env.EQL_UPDATE_TEST_AUTO) return true;
  return currentUpdateMode === 'auto';
}

/**
 * Look for a newer version without saying anything unless there is one.
 *
 * The silent twin of `checkForUpdatesNow`. Nothing is toasted, including failures: this
 * runs on a timer the player did not ask for, and a toast about a GitHub rate limit
 * mid-raid is noise about something they cannot act on. It only ever raises the footer
 * notice, and only when there is genuinely something to say.
 */
async function quietUpdateCheck() {
  try {
    const latest = await fetchLatestVersion();
    const newer = isNewerVersion(latest, selfVersion());
    logUpdate(`background check: latest v${latest}, running v${selfVersion()} — ` +
      (newer ? 'newer version available' : 'up to date'));
    if (newer) noteUpdate({ version: latest, ready: false });
  } catch (err) {
    logUpdate(`background check failed: ${err?.message ?? err}`);
    console.warn('[updater] background check failed:', err?.message ?? err);
  }
}

/** What a newly-found version means for THIS copy, which depends on what it may do. */
function updateFoundMessage(version) {
  if (currentUpdateMode === 'auto') return `v${version} is out — downloading, installs when you quit`;
  if (currentUpdateMode === 'notify') return `v${version} is out — grab it from the GitHub releases page`;
  // 'off' is the win-unpacked and dev case. Saying "an update is available" and stopping
  // would leave the player waiting for something that is never going to happen here.
  return `v${version} is out — this copy does not self-update, get it from GitHub`;
}

/**
 * Check for updates because the player asked, from the tray.
 *
 * Answers in every mode, including `off`, by asking GitHub directly rather than going
 * through electron-updater — see `RELEASES_API`. Every outcome says something: the point of
 * a button like this is to convert "I don't think it's working" into a sentence, so
 * "you are up to date" and "the check failed" are both results, not silence.
 */
async function checkForUpdatesNow() {
  if (updateCheckBusy) return;
  updateCheckBusy = true;
  refreshTrayMenu();
  toast('Checking for updates…', 4000);

  try {
    const latest = await fetchLatestVersion();
    const current = selfVersion();
    if (isNewerVersion(latest, current)) {
      noteUpdate({ version: latest, ready: false });
      toast(updateFoundMessage(latest), 15_000);
      // Let the background updater get on with the part this cannot do. In `auto` that is
      // the download; in the other modes there is nothing to start.
      backgroundUpdateCheck?.();
    } else {
      updateNotice = null;
      pushStatus();
      toast(`Up to date — v${current}`, 6000);
    }
  } catch (err) {
    toast(`Update check failed — ${err?.message ?? err}`, 8000);
  } finally {
    updateCheckBusy = false;
    refreshTrayMenu();
  }
}

// Deliberately NOT quitting here: the tray is the app's home, and closing the settings
// window while the overlay is hidden should leave it running, reachable from the tray.
app.on('window-all-closed', () => {});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  tailer?.stop();
  clearInterval(pushTimer);
  clearInterval(hoverTimer);
  clearInterval(checkpointTimer);
  // A quit is the end of the sitting, so the session in flight is closed and written here
  // rather than left for the next launch to recover. Recovery exists for the crash case;
  // using it for the ordinary one would mislabel every clean shutdown as a crash.
  closeSession('shutdown');
  mobileServer?.stop();
  stopUpdater?.();
  // setTimeout and setInterval handles alike — clearInterval accepts both.
  for (const timer of quietUpdateTimers) clearInterval(timer);
  clearInterval(inventoryPollTimer);
  tray?.destroy();
});

// ---------------------------------------------------------------------------
// Parser + tailer
// ---------------------------------------------------------------------------

/**
 * Point the parser at the list belonging to whoever is logged in.
 *
 * Called on every route by which the answer can change — a new tail, a character switch,
 * a settings save — rather than being read once at construction, because the character
 * is not known until the filename is parsed and can change under a running app.
 */
function applyPartyList() {
  if (!parser) return;
  parser.setPartyMembers(partyListFor(config.all, parser.selfName, parser.server));
}

async function startTailing(logPath) {
  tailer?.stop();

  parser = new LogParser({
    logFilename: path.basename(logPath),
    ...config.parserOptions(),
    onEncounterEnd: persistEncounter,
    onPetOwnersChanged: persistPetOwners,
  });

  tailer = new Tailer({
    filePath: logPath,
    watchDirectory: config.get('autoSwitchCharacter'),
  });

  triggers?.setCharacter(parser.selfName);
  applyPartyList();
  syncSessionTracker();
  quests?.setCharacter(parser.selfName, parser.server);

  tailer.on('lines', (lines) => {
    for (const line of lines) {
      const event = parser.feed(line);
      // The same line, to the sibling engine. Two consumers of one stream is the price
      // of keeping a stranger's regexes out of the scoring pipeline, and it is cheap:
      // the engine prefilters with String.includes before any regex runs.
      triggers?.feed(line);
      // ...and the player's own timers, from the same line. Its own runtime rather than
      // a corner of the trigger engine: a timer here is a name, a log line, a duration
      // and a colour, and none of the pack machinery is involved.
      if (timersRuntime) {
        const parsedLine = parseTimestamp(line);
        if (parsedLine) timersRuntime.feed(parsedLine.body, parsedLine.ts);
      }
      // And to the third consumer, WITH what the parser made of it. That second argument
      // is the whole chat guard: the parser classifies speech first by design, so a
      // player quoting "You have slain a froglok shin knight!" in guild chat arrives
      // already labelled and never reaches the night's kill count.
      session?.feed(line, event);
      // The fourth consumer, same contract. It counts loot AND hand-ins, and answers
      // with what it counted plus the slots that still NEEDED the item — a judgement
      // the store makes BEFORE the event lands, so the first pickup of a wanted item
      // reads as needed rather than deriving "owned" and silencing itself. Every
      // counted LOOT chips (the store words the coverage and keeps the one silence,
      // fully-covered runes); a hand-in is ledger movement worth a window refresh,
      // never a chip — except the one that flips its quest to done, which is the
      // moment the grind existed for and the store announces exactly once.
      const questCounted = quests?.feedLine(line, event);
      if (questCounted) {
        notifyQuestsChanged();
        if (questCounted.kind === 'loot') noteQuestLoot(questCounted);
        else if (questCounted.completed) noteQuestComplete(questCounted.completed);
      }
    }
    // The parser learns the character's own name from the log rather than only from the
    // filename, so `{C}` patterns may only become resolvable partway into a session.
    triggers?.setCharacter(parser.selfName);
    session?.setCharacter(parser.selfName, parser.server);
    quests?.setCharacter(parser.selfName, parser.server);
  });

  tailer.on('switch', ({ to, character }) => {
    // A different character means a different group and a different set of totals.
    parser.setLogFilename(path.basename(to));
    parser.reset();
    // A different character has a different party list, and applying the old one would
    // filter the new character's meter by names from somebody else's group.
    applyPartyList();
    // Every `{C}` in every pattern has to be resubstituted — which is exactly why the
    // token survives into the stored pattern instead of being baked in at import.
    triggers?.reset();
    triggers?.setCharacter(character ?? parser.selfName);
    // The session closes and is written rather than continuing under the new name — a
    // different character is a different purse, level and faction standing.
    session?.setCharacter(character ?? parser.selfName, parser.server);
    // The quest ledger swaps files the same way — a different character has different
    // checkmarks, and their counts must not land in each other's ledgers.
    quests?.setCharacter(character ?? parser.selfName, parser.server);
    notifyQuestsChanged();
    config.set({ logPath: to });
    toast(`Now following ${character}`);
    refreshTrayMenu();
    pushStatus();
  });

  tailer.on('reset', ({ reason }) => {
    // The log was rotated or truncated; anything in flight refers to bytes that are gone.
    parser.reset();
    triggers?.reset();
    toast(reason === 'truncated' ? 'Log truncated — restarting' : 'Log replaced — restarting');
  });

  tailer.on('error', (err) => {
    toast(`Log error: ${err.message}`);
  });

  await tailer.start();
  startPushLoop();
  clearInterval(inventoryPollTimer);
  inventoryPollTimer = setInterval(pollInventoryDump, INVENTORY_POLL_MS);
  pollInventoryDump();
  refreshTrayMenu();
}

/**
 * Watch for a fresh `/outputfile inventory` dump and feed it to the quest ledger.
 *
 * The in-game flow this exists for is two keystrokes: run the command, alt-tab. The
 * game writes `<Char>_<server>-Inventory.txt` into its own directory — the parent of
 * the Logs folder being tailed (confirmed live) — so every few seconds this stats the
 * file belonging to the character being followed and applies one whose mtime the
 * ledger has not seen. The ledger dedups on that mtime itself, so a poll, a relaunch
 * and a character switch-and-back all re-offer the same dump for free. Everything is
 * re-derived per tick (path included) rather than cached, because the tailer can
 * switch characters under a running app and a poll must follow it.
 */
function pollInventoryDump() {
  if (!quests || !parser?.selfName) return;
  const logPath = tailer?.filePath ?? config.get('logPath');
  if (!logPath) return;
  const name = `${parser.selfName}_${parser.server ?? 'unknown'}-Inventory.txt`;
  const logDir = path.dirname(logPath);
  // The EQ install dir first (where the game writes), then beside the log itself as a
  // fallback for a log that does not live in the standard Logs/ folder.
  for (const file of [path.join(path.dirname(logDir), name), path.join(logDir, name)]) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;   // no dump written yet — the normal case, not an error
    }
    try {
      // Same encoding rule as the log itself: EQ writes single-byte text.
      const result = quests.applyInventory(
        parseInventory(fs.readFileSync(file, 'latin1')), stat.mtimeMs,
      );
      if (result.ok && !result.unchanged) {
        notifyQuestsChanged();
        toast(`Inventory snapshot read — ${result.matched} quest item${result.matched === 1 ? '' : 's'}`);
      }
    } catch (err) {
      toast(`Inventory snapshot failed: ${err.message}`);
    }
    return;   // first existing file wins; the fallback is for when the first is absent
  }
}

/**
 * Persist a closed encounter to the history store.
 *
 * The snapshot is built UNFILTERED — the party list never narrows it — so the record holds
 * everything the fight contained; the history browser applies view-time filters.
 * Encounters with no damage in either direction are skipped: they are phantom opens
 * (a stray engage with nothing behind it), not fights anyone would want to review.
 * A manual reset never reaches here at all — the parser's onEncounterEnd contract.
 */
function persistEncounter(enc) {
  if (!history || !parser) return;
  try {
    // `timeline: true` — the record is where a closed fight's curves live, and it is
    // built once per fight rather than four times a second, so the size argument that
    // keeps the flag off the overlay push does not apply here.
    const snap = enc.snapshot(enc.endTs, { timeline: true });
    if (snap.totalDamage === 0 && snap.totalDamageTaken === 0) return;
    const key = history.append({
      v: RECORD_VERSION,
      id: `${enc.startTs}-${enc.endTs}`,
      character: parser.selfName,
      server: parser.server,
      zone: parser.zone,
      label: snap.label,
      startTs: enc.startTs,
      endTs: enc.endTs,
      durationMs: snap.durationMs,
      closeReason: snap.closeReason,
      snapshot: { ...snap, self: parser.selfName, zone: parser.zone },
    });
    // Only after a successful append — a failed write must not announce a fight that
    // is not actually in the file.
    if (historyWindow && !historyWindow.isDestroyed()) {
      historyWindow.webContents.send(CHANNELS.HISTORY_APPENDED, { key });
    }
  } catch (err) {
    // History is a convenience; a full disk or a locked file must never take the
    // live overlay down with it.
    toast(`History write failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Play sessions
// ---------------------------------------------------------------------------

/**
 * Build, rebuild or tear down the session tracker to match the config.
 *
 * Called on startup, after a settings change and whenever the followed character changes.
 * Wholesale rather than incrementally, for the same reason `reloadTriggerPacks` is: the
 * construction is microseconds and a diffing path would be several ways to reach a
 * slightly wrong state.
 *
 * Switching tracking OFF closes and writes whatever was open rather than dropping it —
 * the player asked to stop recording, not to discard the last three hours.
 */
function syncSessionTracker() {
  if (!sessionEnabled(config.all)) {
    if (session) {
      closeSession('disabled');
      session = null;
      clearInterval(checkpointTimer);
      checkpointTimer = null;
      refreshTrayMenu();
    }
    return;
  }

  const categories = sessionCategories(config.all);
  if (session) {
    session.setCategories(categories);
    session.setCharacter(parser?.selfName ?? null, parser?.server ?? null);
    return;
  }

  session = new SessionTracker({
    categories,
    character: parser?.selfName ?? null,
    server: parser?.server ?? null,
    // The roster's own answer, so a group member's kill counts and a passing stranger's
    // does not. Read through a getter rather than captured, because `startTailing`
    // replaces the parser wholesale on a character switch.
    isOurs: (name) => parser?.roster?.includes(name) === true,
    minTs: lastRecordedSessionTs(),
    onSessionEnd: persistSession,
  });

  clearInterval(checkpointTimer);
  checkpointTimer = setInterval(checkpointSession, CHECKPOINT_INTERVAL_MS);
  refreshTrayMenu();
}

/**
 * The last instant already accounted for on disk, for the character being followed.
 *
 * The tailer seeds itself 64 KB back from the end of the log so a fight in progress is
 * not missed, which means every launch re-reads lines the last one already counted. That
 * is harmless for the combat parser and is double-counting for a session store, so the
 * tracker is given a floor and the floor is a fact from the store rather than a guess.
 */
function lastRecordedSessionTs() {
  if (!sessionStore) return null;
  try {
    const key = sessionKey(parser?.selfName, parser?.server);
    const ends = sessionStore.records(key).map((r) => r.endTs ?? 0);
    return ends.length ? Math.max(...ends) : null;
  } catch {
    return null;   // an unreadable store is not a reason to refuse to track
  }
}

/**
 * Persist a closed session.
 *
 * The same contract `persistEncounter` follows: a write failure toasts rather than
 * propagating, because a full disk must never take the live overlay down. The checkpoint
 * is cleared only after a successful append — a spent checkpoint whose session did not
 * land would lose the night for real.
 */
function persistSession(record) {
  if (!sessionStore) return;
  try {
    const { key, written } = sessionStore.append(record);
    sessionStore.clearCheckpoint(key);
    if (written && sessionWindow && !sessionWindow.isDestroyed()) {
      sessionWindow.webContents.send(CHANNELS.SESSION_APPENDED, { key });
    }
  } catch (err) {
    toast(`Session write failed: ${err.message}`);
  }
}

/** Close whatever is open, with a reason. Safe to call when nothing is. */
function closeSession(reason) {
  try {
    session?.close(reason);
  } catch (err) {
    console.warn('[session] close failed:', err?.message ?? err);
  }
}

/**
 * Write the session in flight to its checkpoint file.
 *
 * Every five minutes, for hours. A session is not an encounter: a crash at hour four with
 * no checkpoint costs the whole night, which is the difference between a feature that
 * records your play and one that records it unless something goes wrong.
 *
 * Failures are swallowed rather than toasted. This runs on a timer the player did not
 * ask for, and a toast every five minutes about a disk that is still full would be worse
 * than the problem it reports; the next successful checkpoint fixes it silently.
 */
function checkpointSession() {
  if (!session || !sessionStore) return;
  const record = session.checkpoint();
  if (!record) return;
  try {
    sessionStore.saveCheckpoint(record);
  } catch (err) {
    console.warn('[session] checkpoint failed:', err?.message ?? err);
  }
}

/**
 * The session in flight as a full record, when it belongs to the key being browsed.
 *
 * Freshly derived on every call rather than read from the checkpoint FILE, which is up to
 * five minutes old — showing someone a five-minute-old version of the night they are
 * currently having is exactly the wrong answer to the question they asked.
 *
 * @param {string|null} browsing  the store key the window is showing
 * @param {string} tracked        the store key the tracker is recording
 */
function liveRecord(browsing, tracked) {
  if (!session || !browsing || browsing !== tracked) return null;
  return session.checkpoint();
}

/** The same record as a rail row, in the identical shape `SessionStore.list()` produces. */
function liveEntry(browsing, tracked) {
  const record = liveRecord(browsing, tracked);
  if (!record) return null;
  // `live` is the only field a stored row does not have, and it exists so the renderer can
  // say "– now" instead of an end time it would otherwise print as fact.
  return { ...listEntry(record), live: true };
}

// ---------------------------------------------------------------------------
// The second screen
// ---------------------------------------------------------------------------

/**
 * Build or tear down the second-screen server to match the config.
 *
 * Wholesale on every call, the syncSessionTracker pattern: enabled state and port
 * both land here, a restart costs microseconds plus one SSE reconnect (the stream
 * asks browsers to retry in 3s, so a phone rides through it), and an incremental
 * path would be several ways to reach a slightly wrong state.
 *
 * A server that cannot start — port taken, no permission — toasts and leaves the
 * feature off rather than propagating: the second screen is a convenience, and the
 * overlay must never pay for it.
 */
async function syncMobileServer() {
  mobileServer?.stop();
  mobileServer = null;
  if (config.get('mobileEnabled') !== true) {
    refreshTrayMenu();
    // The off path notifies too — skipping it here is how "Turn off" once left a
    // dead QR code on screen, which reads as the button doing nothing.
    notifySecondScreen();
    return;
  }

  // Generated exactly once and kept forever after: the token is in every QR code a
  // phone has ever scanned, and rotating it would silently orphan them all.
  let token = config.get('mobileToken');
  if (!token) {
    token = generateToken();
    config.set({ mobileToken: token });
  }

  const server = new MobileServer({
    staticDir: RENDERER,
    token,
    history,
    currentKey: () => storeKey(parser?.selfName, parser?.server),
    // A fresh, timeline-laden snapshot for a phone that connects during a lull —
    // the push loop only speaks when something changed.
    snapshot: ({ timeline }) => (parser ? buildSnapshot({ timeline }) : null),
  });
  try {
    await server.start({ port: Number(config.get('mobilePort')) || DEFAULT_MOBILE_PORT });
    mobileServer = server;
  } catch (err) {
    toast(`Second screen failed to start: ${err.message}`);
  }
  refreshTrayMenu();
  notifySecondScreen();
}

/**
 * Tell an open Second Screen dialog what is true now. Every path through
 * syncMobileServer ends here — enabled (draw the QR), failed (say why), and
 * disabled (clear the code) alike.
 */
function notifySecondScreen() {
  if (secondScreenWindow && !secondScreenWindow.isDestroyed()) {
    secondScreenWindow.webContents.send(CHANNELS.MOBILE_CHANGED, mobileState());
  }
}

/**
 * The URLs a phone could open — one per LAN address, port and token included. Usually
 * one; a machine with a VPN or a second adapter gets them all, because guessing which
 * interface the phone shares would be inventing an answer the dialog can just list.
 */
function mobileUrls() {
  if (!mobileServer) return [];
  return lanAddresses().map(
    (host) => `http://${host}:${mobileServer.port}/?t=${config.get('mobileToken')}`,
  );
}

/** The facts the Second Screen dialog draws from. */
function mobileState() {
  return {
    enabled: config.get('mobileEnabled') === true,
    running: mobileServer !== null,
    port: mobileServer?.port ?? (Number(config.get('mobilePort')) || DEFAULT_MOBILE_PORT),
    urls: mobileUrls(),
  };
}

// ---------------------------------------------------------------------------
// The client's own settings
// ---------------------------------------------------------------------------

/**
 * Which log readers are running right now.
 *
 * Shells out to `tasklist` because that is the one process lister present on every
 * Windows since XP with no dependency and no native module — and a native module is the
 * one thing this project will not take (see CLAUDE.md). The parsing lives in
 * `eqconfig.js`, pure and tested; this function's only job is to produce the text.
 *
 * A listing we cannot obtain reads as "nothing is running", deliberately. The alternative
 * — treating an unavailable process list as "assume everything is running" — would make
 * both features permanently refuse themselves on any machine where the command is
 * missing, which is a worse failure than the one it guards against.
 */
async function runningReaders() {
  if (process.platform !== 'win32') return [];
  try {
    const { execFile } = await import('node:child_process');
    const output = await new Promise((resolve, reject) => {
      execFile('tasklist.exe', ['/fo', 'csv', '/nh'], { timeout: 4000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    return runningLogReaders(output);
  } catch {
    return [];
  }
}

/**
 * Replay a whole log file into the session store.
 *
 * A private parser and a private tracker, never the live ones: the imported log is very
 * often a different character, and an import must not touch the session in flight or the
 * meter the player is looking at.
 *
 * No `minTs` floor here, deliberately — that floor exists to stop the tailer's 64 KB
 * backfill being counted twice, and applying it to an import would refuse exactly the old
 * data the import is for. Duplicates are caught by the store's id dedup instead, so
 * importing the same file twice is a no-op and the report says so.
 *
 * The read yields to the event loop every few thousand lines. A month-old eqlog is over a
 * million lines and blocking the main process through all of it would freeze the overlay,
 * the alerts and the timers for several seconds during a raid.
 *
 * @returns {Promise<{imported: number, duplicates: number, key: string|null, character: string|null}>}
 */
async function importSessionLog(filePath) {
  // latin1, never utf8 — EQ writes single-byte text and utf8 mangles accented mob names.
  const text = await fs.promises.readFile(filePath, 'latin1');
  const lines = text.split(/\r?\n/);
  const name = path.basename(filePath);

  const logParser = new LogParser({
    logFilename: /^eqlog_/.test(name) ? name : 'eqlog_Unknown_unknown.txt',
    ...config.parserOptions(),
  });

  let imported = 0;
  let duplicates = 0;
  const tracker = new SessionTracker({
    categories: sessionCategories(config.all),
    character: logParser.selfName,
    server: logParser.server,
    isOurs: (who) => logParser.roster.includes(who) === true,
    onSessionEnd: (record) => {
      const { written } = sessionStore.append(record);
      if (written) imported += 1;
      else duplicates += 1;
    },
  });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    tracker.feed(line, logParser.feed(line));
    if ((i & 0x1fff) === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  tracker.close('imported');

  const key = sessionKey(logParser.selfName, logParser.server);
  if (imported > 0 && sessionWindow && !sessionWindow.isDestroyed()) {
    sessionWindow.webContents.send(CHANNELS.SESSION_APPENDED, { key });
  }
  return { imported, duplicates, key, character: logParser.selfName };
}

/**
 * Fold any checkpoint left by a previous run into the store, before anything else starts.
 *
 * A checkpoint that survived to this launch means the app went down without closing its
 * session — a crash, a task kill, a power cut. The night happened, so it is written as a
 * finished session marked `recovered`, and the minutes between the last checkpoint and
 * the crash are honestly gone rather than being invented.
 */
function recoverSessions() {
  try {
    const recovered = sessionStore.recover();
    if (recovered.length > 0) {
      console.log(`[session] recovered ${recovered.length} interrupted session(s)`);
    }
  } catch (err) {
    console.warn('[session] recovery failed:', err?.message ?? err);
  }
}

/**
 * Put the shipped boss-timer pack in the store, if the player has not made it theirs.
 *
 * The app's own boss timers are an ordinary pack now, so this is the one moment they get
 * into the store — visible in the Triggers rail, switchable, editable and exportable like
 * anything imported. `installSeedPack` decides whether to write; see it for why an edited
 * copy is never overwritten.
 *
 * A store that cannot be written is not a reason to refuse to start: the player gets no
 * boss timers and everything else works, which is strictly better than no overlay.
 */
function installSeedTimers() {
  try {
    installSeedPack(triggerStore);
  } catch (err) {
    console.warn('[triggers] seed pack not installed:', err?.message ?? err);
  }
}

/**
 * Persist a pet mapping the player typed in-game ("/say pet Kibektik = Khanvikt").
 *
 * Surviving a restart is the entire point of routing it through config rather than
 * leaving it in the parser: having to redo the mapping every session is exactly the
 * friction the command exists to remove. The settings form reads the same key, so a
 * mapping made in-game shows up there and can be edited or removed normally.
 */
function persistPetOwners(mapping) {
  try {
    broadcastConfig(config.set({ petOwners: mapping }));
  } catch (err) {
    toast(`Pet mapping save failed: ${err.message}`);
  }
}

/**
 * Hand the engine every enabled pack, compiled.
 *
 * Called on startup and after any import, removal or switch — wholesale rather than
 * incrementally, because recompiling a few hundred regexes takes microseconds and a
 * diffing path would be several ways to reach a slightly wrong state.
 *
 * A store that cannot be read is not a reason to fail to start: the engine simply has no
 * packs, the overlay is exactly what it was before this feature existed, and the problem
 * is reported rather than fatal.
 */
function reloadTriggerPacks() {
  if (!triggers || !triggerStore) return;
  try {
    triggers.setPacks(triggerStore.enabledPacks());
  } catch (err) {
    triggers.setPacks([]);
    toast(`Trigger packs failed to load: ${err.message}`);
  }
}

/**
 * Replay a pack against the player's own log and report what actually fires.
 *
 * The headline of the whole feature. A shared pack was written by a stranger, usually
 * for a different server, and the only honest thing to say about it is what it does
 * against THIS log — measured, not asserted from ours. See src/triggers/dryrun.js for
 * the measurement that made this the design.
 *
 * A missing or unreadable log is not an error: the pack imports, and the report simply
 * says it could not be measured.
 */
async function measurePack(pack, opts = {}) {
  if (!tailer?.filePath) return null;
  try {
    return await dryRunLog(pack, tailer.filePath, {
      character: parser?.selfName ?? null,
      rankTolerant: opts.rankTolerant === true,
    });
  } catch {
    return null;
  }
}

/**
 * Push a snapshot to the overlay on a fixed cadence.
 *
 * Both the parser and the trigger engine are ticked here so their clocks advance during
 * a lull, when no log lines are arriving to advance them — an encounter has to be able
 * to time out, and a chip raised just before the pull ended must not sit on screen until
 * the next line, which can be minutes away.
 */
function startPushLoop() {
  clearInterval(pushTimer);
  pushTimer = setInterval(() => {
    if (!parser || !overlayWindow || overlayWindow.isDestroyed()) return;
    parser.tick();
    triggers?.tick();
    timersRuntime?.tick();
    // And the session's clock, for the same reason as the other two: a night that ended
    // an hour ago has to be able to close and be written during the silence that ended
    // it, rather than waiting for the player to come back and produce a line.
    session?.tick();

    // A running encounter's elapsed time changes every tick even when the revision has
    // not, so only a closed, unchanged encounter can skip the push. A live trigger row
    // is the same case for the same reason: its countdown moves every tick, and it can
    // be running with no encounter open at all — which is the ONE behaviour change this
    // feature makes to the timers panel, and it only happens once a pack is imported.
    const snapshot = buildSnapshot();
    // The drops popup rides the same tick but keeps its own change gate and its own
    // channel — its lifetime (the 90s loot linger in particular) has to advance
    // during exactly the silence the snapshot skip below exists for.
    pushDrops(snapshot);
    // The boxes ride the same tick but keep their own change gate: a countdown moves
    // every tick, and it can be running with no encounter open at all.
    if (timersRuntime && (timersRuntime.live || timersRuntime.revision !== lastTimersRevision)) {
      lastTimersRevision = timersRuntime.revision;
      pushTimerRows();
    }
    const unchanged = parser.revision === lastRevision &&
      (triggers?.revision ?? -1) === lastTriggerRevision &&
      (session?.revision ?? -1) === lastSessionRevision &&
      questChipsRevision === lastQuestChipsRevision;
    // An open session is the third thing whose display moves every tick even when nothing
    // has happened: its elapsed time, and every per-hour rate divided by it, advance on
    // the clock alone. Same case as a running encounter and a live countdown.
    if (unchanged && !snapshot.active && !triggers?.live && !session?.current) return;
    lastRevision = parser.revision;
    lastTriggerRevision = triggers?.revision ?? -1;
    lastSessionRevision = session?.revision ?? -1;
    lastQuestChipsRevision = questChipsRevision;

    overlayWindow.webContents.send(CHANNELS.SNAPSHOT, snapshot);
    for (const win of [alertsWindow]) {
      if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.SNAPSHOT, snapshot);
    }
    // The phones get their own build, WITH the timeline — and only when somebody is
    // actually watching, so an enabled-but-idle server costs the loop nothing. The
    // server slices each client's unseen buckets out of it; see MobileServer#send.
    if (mobileServer !== null && mobileServer.clientCount > 0) {
      mobileServer.broadcast(buildSnapshot({ timeline: true }));
    }
  }, PUSH_INTERVAL_MS);
}

/**
 * The parser's snapshot, with the trigger engine's two surfaces merged in.
 *
 * Merged HERE rather than in the parser, because the parser knows nothing about packs
 * and must not start to. Trigger chips join `hostileCasts` so they share the stack's
 * severity ordering and the renderer needs no second list; countdowns arrive as
 * `triggerTimers`, which is now the ONLY source the boss-timer panel has — the learned
 * `castTimers` list went with the estimator that produced it, and what used to be the
 * app's own timers is a shipped pack running through this same engine.
 */
function buildSnapshot({ timeline = false } = {}) {
  const now = Date.now();
  const snapshot = parser.snapshot(undefined, { timeline });
  // `session` is a compact summary, never the full record: this crosses the IPC boundary
  // four times a second, and the browse-time shape (every creature, every item, every
  // faction) is fetched by name when the Session window asks for it. Null when tracking
  // is off or no session is open, which is what lets the renderer draw nothing at all
  // rather than an empty row.
  const sessionSummary = session?.summary(now) ?? null;
  const questWarns = questWarnings(now);
  if (!triggers) {
    return {
      ...snapshot,
      hostileCasts: [...snapshot.hostileCasts, ...questWarns],
      triggerTimers: [],
      session: sessionSummary,
    };
  }
  return {
    ...snapshot,
    hostileCasts: [...snapshot.hostileCasts, ...triggers.warnings(now), ...questWarns],
    triggerTimers: triggers.timers(now),
    session: sessionSummary,
  };
}

/**
 * One tick of the engaged-drops popup: advance its lifetime and push its payload —
 * to its own window, on its own channel, only when it changed.
 *
 * All the judgement is imported: `bossNeeds` inverts the ledger (the same inversion
 * the Quests window's "By boss" rail paints, so the two surfaces cannot disagree),
 * `engagedNeeds` matches the fight's enemy names against it by strict equality, and
 * `nextDropsState` owns the lifetime — including the 90s linger past encounter
 * close, which is why this runs BEFORE the snapshot skip: the linger has to expire
 * during exactly the silence that skip exists for.
 *
 * The inversion is recomputed per tick rather than cached, but only while it can
 * matter (a state is live, or an encounter is running with engaged names): out of
 * combat this function is two null checks, and in combat the ledger is ~190 items —
 * cheaper than the snapshot already built this tick. Recomputing is also what makes
 * a drop looted mid-linger leave the list with no invalidation plumbing at all.
 */
function pushDrops(snapshot) {
  let payload = null;
  if (quests && (dropsState || (snapshot.active && snapshot.engagedNames?.length))) {
    const groups = bossNeeds(quests.snapshot());
    const matched = engagedNeeds(groups, snapshot.active ? snapshot.engagedNames : [])
      .map((g) => g.mob);
    dropsState = nextDropsState(dropsState, {
      active: Boolean(snapshot.active),
      startTs: snapshot.startTs ?? null,
      matchedMobs: matched,
      now: Date.now(),
    });
    const display = dropsDisplay(dropsState, groups);
    if (display.length) payload = { phase: dropsState.phase, groups: display };
  } else {
    dropsState = null;
  }

  const json = JSON.stringify(payload);
  if (json === lastDropsJson) return;
  lastDropsJson = json;
  if (dropsWindow && !dropsWindow.isDestroyed()) {
    dropsWindow.webContents.send(CHANNELS.DROPS, payload);
  }
}

/**
 * A looted quest item, as an alert chip: the item up top, what it builds underneath.
 *
 * Every counted quest drop chips — identification, not need-alerting: "what can be
 * made from this" is the question being asked mid-farm, and the ledger's coverage
 * rides in the wording ("· already turned in") rather than muting the surface. See
 * `QuestProgress#lootChip` for the wording rules and the one deliberate silence.
 */
function noteQuestLoot({ refs, needed }) {
  // The store decides the wording and the one silence (a fully-covered rune) —
  // this is just the push into the chip stack.
  const chip = quests?.lootChip(refs, needed);
  if (!chip) return;
  questChips.push({ id: ++questChipSeq, ...chip, ts: Date.now() });
  questChipsRevision++;
}

/**
 * The hand-in that finished a quest, as a chip: the reward earned up top, the class
 * test it closes underneath. Fires only on the not-done → done flip — feed() reports
 * `completed` exactly once per quest — so unlike the loot chip this one never has to
 * word its own repetition away.
 */
function noteQuestComplete(completed) {
  const chip = quests?.completionChip(completed);
  if (!chip) return;
  questChips.push({ id: ++questChipSeq, ...chip, ts: Date.now() });
  questChipsRevision++;
}

/** The ledger moved — an open Quests window refetches rather than showing a freeze. */
function notifyQuestsChanged() {
  if (questsWindow && !questsWindow.isDestroyed()) {
    questsWindow.webContents.send(CHANNELS.QUESTS_CHANGED, {});
  }
}

/**
 * Live quest chips in the warning shape, pruned in place on the way out.
 *
 * The lifetime is read from config on every call rather than held anywhere, so the
 * Durations dialog needs no hook here — the next 4 Hz push simply measures against
 * the new value. A chip mid-flight when the number shrinks may leave early; quest
 * chips are the one category where that is fine, because unlike the parser's stamped
 * ttlMs there is no per-chip claim to honor.
 */
function questWarnings(now) {
  const ttlMs = durationSec(config.all, 'questChipSec') * 1000;
  const before = questChips.length;
  questChips = questChips.filter((c) => now - c.ts <= ttlMs);
  if (questChips.length !== before) questChipsRevision++;
  return questChips.map((c) => ({
    id: c.id,
    category: 'quest',
    // Tier 2: worth looking up for, never a siren — and never the tier-3 cue.
    tier: 2,
    text: c.text,
    sub: c.sub,
    remainingMs: Math.max(0, ttlMs - (now - c.ts)),
  }));
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function createOverlay() {
  const saved = config.get('bounds');
  const area = screen.getPrimaryDisplay().workAreaSize;
  const bounds = saved ?? {
    width: 360,
    height: 260,
    x: area.width - 380,
    y: 80,
  };

  overlayWindow = new BrowserWindow({
    ...bounds,
    minWidth: 240,
    minHeight: 70,   // low enough that auto-fit can collapse to the header alone
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    icon: path.join(ASSETS, 'icon-256.png'),
    focusable: true,
    webPreferences: {
      preload: path.join(RENDERER, 'overlay', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 'screen-saver' is the highest level Electron exposes and is what keeps the overlay
  // above a borderless-windowed game. Exclusive fullscreen still wins — see the README.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  overlayWindow.loadFile(path.join(RENDERER, 'overlay', 'index.html'));

  overlayWindow.on('ready-to-show', () => {
    applyLock(config.get('locked'));
    startHoverPolling();
    pushStatus();

    // Once only, and long enough to actually read: there is otherwise no on-screen clue
    // that the tray exists, which is the one thing a new user needs to know.
    if (!config.get('seenTrayHint')) {
      config.set({ seenTrayHint: true });
      setTimeout(() => toast('Settings and Quit are in the tray icon', 9000), 1200);
    }
  });

  restingY = bounds.y;
  restingX = bounds.x;
  restingWidth = bounds.width;

  // Height is always derived from content, so only the resting width and position are
  // remembered. Persisting an auto-fitted size would rewrite config.json every time
  // the breakdown opened, and would restore a hover-widened window on the next launch.
  const remember = () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      const { x, y, width, height } = overlayWindow.getBounds();

      // An auto-fit moves and resizes the window without the player touching it.
      // Taking those bounds as the new resting place is how the overlay used to climb
      // the screen — and would now also walk it leftward a panel-width per hover.
      // Only a change we did not make is the player's.
      if (y !== lastFitY) restingY = y;
      if (x !== lastFitX) restingX = x;
      if (width !== lastFitWidth) restingWidth = width;

      const saved = config.get('bounds');
      config.set({
        bounds: {
          x: restingX,
          y: restingY,
          width: restingWidth,
          height: saved?.height ?? height,
        },
      });
    }, 400);
  };
  overlayWindow.on('moved', remember);
  overlayWindow.on('resized', remember);
  overlayWindow.on('closed', () => { overlayWindow = null; });

  registerHotkeys();
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

/**
 * The tray is the overlay's only always-available control surface.
 *
 * The window is frameless, has `skipTaskbar: true`, and hides its own buttons while
 * locked — so without a tray icon there is genuinely no discoverable way to reach
 * settings or quit, only hotkeys the user has to already know.
 */
function createTray() {
  if (tray) return;

  const icon = nativeImage.createFromPath(path.join(ASSETS, 'icon-16.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('EQL DPS Overlay');
  refreshTrayMenu();

  // Double-click is the conventional Windows "show me the thing" gesture.
  tray.on('double-click', () => {
    if (!overlayVisible) toggleVisible();
    else createSetup('settings');
  });
}

/** The presets and the six groups, in menu order, with the wording the tray shows. */
const WARN_PRESET_LABELS = [
  ['essential', 'Essential — heals and hard crowd control'],
  ['balanced', 'Balanced — and roots, snares, stuns'],
  ['everything', 'Everything the log names'],
];
const WARN_GROUP_LABELS = [
  ['heals', 'Heals & gates'],
  ['control', 'Mez, charm & fear'],
  ['bigHits', 'Big hits'],
  ['locks', 'Roots, snares & stuns'],
  ['routine', 'Routine nukes & lifetaps'],
  ['unknown', 'Unrecognized casts'],
];

/**
 * One tray checkbox for one boolean config key.
 *
 * `checked` reads the stored value every rebuild rather than caching it, so the tray
 * and the settings form can never disagree about what is on — refreshTrayMenu runs
 * from CONFIG_SET for exactly that reason.
 */
function alertToggle(label, key) {
  return {
    label,
    type: 'checkbox',
    checked: config.get(key) !== false,
    click: () => setAlertOption({ [key]: config.get(key) === false }),
  };
}

/** Rebuild the menu so the checkmarks and labels reflect current state. */
function refreshTrayMenu() {
  if (!tray) return;

  const locked = config.get('locked');
  const metricIdx = METRIC_CYCLE.indexOf(config.get('metric'));
  const nextMetric = METRIC_CYCLE[(metricIdx + 1) % METRIC_CYCLE.length];
  const keys = config.get('hotkeys');

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tailer?.character ? `Following ${tailer.character}` : 'No log selected', enabled: false },
    { type: 'separator' },
    {
      label: 'Show overlay',
      type: 'checkbox',
      checked: overlayVisible,
      accelerator: keys.toggleVisible,
      click: toggleVisible,
    },
    {
      label: 'Lock overlay',
      type: 'checkbox',
      checked: locked,
      accelerator: keys.toggleLock,
      // Unlocking is how the overlay gets moved and resized, so say so.
      toolTip: 'Unlock to drag, resize and reveal the overlay buttons',
      click: toggleLock,
    },
    { type: 'separator' },
    {
      label: `Show ${METRIC_LABEL[nextMetric]}`,
      accelerator: keys.toggleMetric,
      click: toggleMetric,
    },
    // The COPY button, reachable without unlocking to reach it. Here rather than only in
    // the settings form because the accelerator is the point: this row is how a player
    // finds out the gesture exists, and it reads the binding from config on every rebuild
    // so it cannot go stale the way a hardcoded tooltip would.
    {
      label: 'Copy meter to chat',
      accelerator: keys.copyReport,
      toolTip: 'The metric on screen, as one line to paste',
      click: copyReport,
    },
    {
      label: 'Reset encounter',
      accelerator: keys.resetEncounter,
      click: resetEncounter,
    },
    // Below the encounter reset because it is the same gesture at the other timescale —
    // and present only while tracking is on, following the `Session…` item further down:
    // a row that can only ever do nothing is a promise the app cannot keep. The tooltip
    // carries the one thing that separates it from the row above, which is that this one
    // keeps what it closes.
    ...(sessionEnabled(config.all) ? [{
      label: 'Start new session',
      accelerator: keys.newSession,
      toolTip: 'Saves the night so far and starts counting again',
      click: startNewSession,
    }] : []),
    { type: 'separator' },
    // A submenu, not five more top-level items: the menu is already nine entries, and
    // these are settings you reach for occasionally rather than the every-pull controls
    // above. Mute rides here too, next to the categories it silences.
    {
      label: 'Alerts',
      submenu: [
        {
          label: 'Mute alerts',
          type: 'checkbox',
          checked: config.get('alertsMuted') === true,
          accelerator: keys.toggleAlerts,
          toolTip: 'Silence every alert for now, without losing the choices below',
          click: toggleAlerts,
        },
        { type: 'separator' },
        alertToggle('Interrupt warnings', 'castAlerts'),
        {
          // Which casts warn, one level down: the presets are the every-pull control
          // ("quieten this down"), the six groups underneath are the ones you set once.
          // Both live here rather than only in settings because the moment you want
          // them is mid-raid, with the game fullscreen in front of you.
          label: 'Warn about',
          enabled: config.get('castAlerts') !== false,
          submenu: [
            ...WARN_PRESET_LABELS.map(([name, label]) => ({
              label,
              // Checkbox rather than radio: "Custom" is a state the player lands in by
              // ticking a group below, not an option they pick, and a radio group would
              // have to invent a row for it or silently light nothing.
              type: 'checkbox',
              checked: presetOf(config.all) === name,
              click: () => setAlertOption({ ...ALERT_PRESETS[name] }),
            })),
            { type: 'separator' },
            ...WARN_GROUP_LABELS.map(([group, label]) => alertToggle(label, warnKeyFor(group))),
          ],
        },
        alertToggle('Summon announcements', 'summonAlerts'),
        alertToggle('Crowd control on the group', 'ccAlerts'),
        {
          ...alertToggle('Charm breaks', 'charmBreakAlerts'),
          toolTip: 'Your charm wore off — the freed mob is turning on you',
        },
        {
          ...alertToggle('Quest loot', 'questLootAlerts'),
          toolTip: 'A looted item matches a Plane of Sky class test',
        },
        {
          ...alertToggle('Trigger packs', 'triggerAlerts'),
          toolTip: 'Chips raised by imported or authored triggers',
        },
        {
          ...alertToggle('Sound for interrupt warnings', 'castAlertSound'),
          // A beep for a warning that isn't drawn is a noise with no explanation.
          enabled: config.get('castAlerts') !== false,
        },
        {
          ...alertToggle('Sound for charm breaks', 'charmBreakSound'),
          // Same rule as the cast cue: no beep for a chip that cannot draw.
          enabled: config.get('charmBreakAlerts') !== false,
        },
        { type: 'separator' },
        // Below the line because it is not one of the categories above: the timers
        // draw in a window of their own, placed on their own. It stays in this menu
        // because the mute at the top still silences it.
        //
        // One switch, not two. There used to be a second for the countdowns this app
        // learned by watching a boss, and there is no longer anything that learns —
        // every row in that panel now comes from a pack, including the one we ship.
        {
          ...alertToggle('Boss spell timers', 'triggerTimers'),
          toolTip: 'A panel of its own — unlock the overlay to place it',
        },
      ],
    },
    { type: 'separator' },
    // "Show me past fights" is a destination people look for by name, so it gets its
    // own window and its own menu item rather than hiding inside settings.
    // Its own entry, beside Triggers rather than inside it. "Remind me to recast this"
    // and "run this pack somebody sent me" are different jobs, and burying the first
    // inside the second is what made it undiscoverable.
    { label: 'Timers…', accelerator: keys.openTimers, click: createTimerSetup },
    { label: 'Triggers…', click: createTriggers },
    { label: 'History…', click: createHistory },
    // Present only while session tracking is on. A menu entry for a window that can only
    // ever be empty is a promise the app cannot keep, and the switch that would fill it
    // is one screen away in Settings.
    ...(sessionEnabled(config.all) ? [{ label: 'Session…', click: createSession }] : []),
    // The accelerator is display only in a tray menu, but that display is how a player
    // finds out the gesture exists — same deal as "Copy meter to chat" above, and it
    // reads from config on every rebuild so it cannot go stale. The click stays
    // open/focus (not toggle): a menu row named "Quests…" that closed the window
    // would be the menu lying about what it does.
    { label: 'Quests…', accelerator: keys.openQuests, click: createQuests },
    // Always present, enabled or not: the dialog is where you find out the feature
    // exists, and when it is off it says so and points at Settings — a hidden entry
    // would just read as the feature not existing.
    { label: 'Second screen…', click: createSecondScreen },
    { label: 'Settings…', click: () => createSetup('settings') },
    { type: 'separator' },
    // The version is the first half of the answer to "am I on the latest?", and it is the
    // half the app can always give instantly. Disabled because it is a fact, not a control.
    { label: `Version ${selfVersion()}`, enabled: false },
    {
      label: updateCheckBusy ? 'Checking…' : 'Check for updates',
      enabled: !updateCheckBusy,
      toolTip: currentUpdateMode === 'auto'
        ? 'Downloads in the background and installs when you quit'
        : 'Checks only — this copy cannot replace itself',
      click: checkForUpdatesNow,
    },
    // Only once there is something to get. A permanent "Releases…" row would be one more
    // entry in an already long menu for a page nobody needs on an ordinary night.
    //
    // An installed copy gets a statement and no click: it is handling the update itself,
    // and a row that opened a download page would be inviting the player to do by hand the
    // thing already in progress — which is how you end up with two copies.
    ...(updateNotice ? [updateNotice.auto
      ? {
        label: updateNotice.ready
          ? `v${updateNotice.version} installs when you quit`
          : `v${updateNotice.version} downloading — installs when you quit`,
        enabled: false,
      }
      : {
        label: `Get v${updateNotice.version}…`,
        click: () => shell.openExternal(RELEASES_URL),
      }] : []),
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

/**
 * The Second Screen dialog: the QR code a phone scans, and nothing else. A dialog
 * rather than a settings section because the moment it exists for is holding a phone
 * up to the monitor — the code wants to be big, alone and reachable in two clicks
 * from the tray. The switch and the port stay in Settings; this window only states
 * what is true right now, so the two can never disagree about who owns the config.
 */
function createSecondScreen() {
  if (secondScreenWindow && !secondScreenWindow.isDestroyed()) {
    secondScreenWindow.focus();
    return;
  }

  secondScreenWindow = new BrowserWindow({
    width: 480,
    height: 640,
    resizable: false,
    title: 'EQL DPS Overlay — Second Screen',
    backgroundColor: '#100d0a',
    icon: path.join(ASSETS, 'icon-256.png'),
    webPreferences: {
      preload: path.join(RENDERER, 'secondscreen', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  secondScreenWindow.setMenuBarVisibility(false);
  secondScreenWindow.loadFile(path.join(RENDERER, 'secondscreen', 'index.html'));
  secondScreenWindow.on('closed', () => { secondScreenWindow = null; });
}

/** @param {'setup'|'settings'} mode */
function createSetup(mode) {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 860,
    height: 660,
    title: mode === 'setup' ? 'EQL DPS Overlay — Setup' : 'EQL DPS Overlay — Settings',
    backgroundColor: '#12141a',
    icon: path.join(ASSETS, 'icon-256.png'),
    webPreferences: {
      preload: path.join(RENDERER, 'setup', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--overlay-mode=${mode}`],
    },
  });

  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(RENDERER, 'setup', 'index.html'));
  setupWindow.on('closed', () => {
    setupWindow = null;
    // Closing the first-run screen without choosing a log leaves nothing to run.
    if (!config.isConfigured() && !overlayWindow) app.quit();
  });
}

/**
 * The encounter history browser: a dedicated window, because it is a reading surface
 * with three fixed panes and its own footprint — an 860×660 settings form can hold
 * neither. Sized and placed by the player, remembered across launches.
 */
function createHistory() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.focus();
    return;
  }

  historyWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    ...(config.get('historyBounds') ?? {}),
    minWidth: 900,
    minHeight: 540,
    title: 'EQL DPS Overlay — Encounter History',
    backgroundColor: '#100d0a',
    icon: path.join(ASSETS, 'icon-256.png'),
    webPreferences: {
      preload: path.join(RENDERER, 'history', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  historyWindow.setMenuBarVisibility(false);
  historyWindow.loadFile(path.join(RENDERER, 'history', 'index.html'));

  // The overlay's debounced remember, minus its resting/fitted split: nothing ever
  // auto-fits this window, so its current bounds are always the player's own.
  const remember = () => {
    clearTimeout(saveHistoryBoundsTimer);
    saveHistoryBoundsTimer = setTimeout(() => {
      if (!historyWindow || historyWindow.isDestroyed()) return;
      config.set({ historyBounds: historyWindow.getBounds() });
    }, 400);
  };
  historyWindow.on('moved', remember);
  historyWindow.on('resized', remember);
  historyWindow.on('closed', () => { historyWindow = null; });
}

/**
 * The Triggers window: every source of a warning, in one place.
 *
 * Same construction as History and for the same reasons — a real window that takes
 * mouse input, scrolls its panes internally, and keeps its own bounds key. It is not
 * part of the HUD: it does not float, does not answer to the lock gesture, and is not
 * hidden by Ctrl+Shift+H, because you open it between pulls rather than during one.
 */
function createTriggers() {
  if (triggersWindow && !triggersWindow.isDestroyed()) {
    triggersWindow.focus();
    return;
  }

  triggersWindow = new BrowserWindow({
    width: 1160,
    height: 760,
    ...(config.get('triggersBounds') ?? {}),
    minWidth: 940,
    minHeight: 560,
    title: 'EQL DPS Overlay — Triggers',
    backgroundColor: '#100d0a',
    icon: path.join(ASSETS, 'icon-256.png'),
    webPreferences: {
      preload: path.join(RENDERER, 'triggers', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  triggersWindow.setMenuBarVisibility(false);
  triggersWindow.loadFile(path.join(RENDERER, 'triggers', 'index.html'));

  const remember = () => {
    clearTimeout(saveTriggersBoundsTimer);
    saveTriggersBoundsTimer = setTimeout(() => {
      if (!triggersWindow || triggersWindow.isDestroyed()) return;
      config.set({ triggersBounds: triggersWindow.getBounds() });
    }, 400);
  };
  triggersWindow.on('moved', remember);
  triggersWindow.on('resized', remember);
  triggersWindow.on('closed', () => { triggersWindow = null; });
}

/**
 * The Session window: what the night earned, beside what it killed.
 *
 * Third of the reading surfaces, built exactly like History and Triggers — a real window
 * with three fixed panes that take mouse input and scroll internally, its own bounds key,
 * and no part in the click-through HUD. It is not a mode of the History window on
 * purpose: that window's entire reason to exist is three panes that never reflow, and a
 * mode switch changing what all three mean is the accordion it replaced wearing a hat.
 * They also answer different questions on different clocks — you read history after a
 * pull and a session after a night.
 */
function createSession() {
  if (sessionWindow && !sessionWindow.isDestroyed()) {
    sessionWindow.focus();
    return;
  }

  sessionWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    ...(config.get('sessionBounds') ?? {}),
    minWidth: 940,
    minHeight: 560,
    title: 'EQL DPS Overlay — Session',
    backgroundColor: '#100d0a',
    icon: path.join(ASSETS, 'icon-256.png'),
    webPreferences: {
      preload: path.join(RENDERER, 'session', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  sessionWindow.setMenuBarVisibility(false);
  sessionWindow.loadFile(path.join(RENDERER, 'session', 'index.html'));

  const remember = () => {
    clearTimeout(saveSessionBoundsTimer);
    saveSessionBoundsTimer = setTimeout(() => {
      if (!sessionWindow || sessionWindow.isDestroyed()) return;
      config.set({ sessionBounds: sessionWindow.getBounds() });
    }, 400);
  };
  sessionWindow.on('moved', remember);
  sessionWindow.on('resized', remember);
  sessionWindow.on('closed', () => { sessionWindow = null; });
}

/**
 * The Quests window: the Plane of Sky class-test ledger.
 *
 * Fourth of the reading surfaces, built exactly like History, Triggers and Session —
 * a real window with three fixed panes that take mouse input and scroll internally,
 * its own bounds key, and no part in the click-through HUD. Its shape was approved as
 * docs/design/2026-08-14-quests-window-mockups.html; the 2026-08-14 cleanup pass was
 * approved as the Pencil mock "Quests Window — cleanup" (collapsible rail, parsed
 * reward cards, provenance labels).
 */
function createQuests() {
  if (questsWindow && !questsWindow.isDestroyed()) {
    questsWindow.focus();
    return;
  }

  // Sized for the rebuilt type scale (15px body, nothing under 12px): the window
  // grows so the type never has to shrink, per the approved Pencil mock at 1:1.
  questsWindow = new BrowserWindow({
    width: 1280,
    height: 960,
    ...(config.get('questsBounds') ?? {}),
    minWidth: 1160,
    minHeight: 640,
    title: 'EQL DPS Overlay — Plane of Sky Quests',
    backgroundColor: '#100d0a',
    icon: path.join(ASSETS, 'icon-256.png'),
    webPreferences: {
      preload: path.join(RENDERER, 'quests', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  questsWindow.setMenuBarVisibility(false);
  questsWindow.loadFile(path.join(RENDERER, 'quests', 'index.html'));

  const remember = () => {
    clearTimeout(saveQuestsBoundsTimer);
    saveQuestsBoundsTimer = setTimeout(() => {
      if (!questsWindow || questsWindow.isDestroyed()) return;
      config.set({ questsBounds: questsWindow.getBounds() });
    }, 400);
  };
  questsWindow.on('moved', remember);
  questsWindow.on('resized', remember);
  questsWindow.on('closed', () => { questsWindow = null; });
}

/**
 * The floating cast-warning window: an invisible fixed-size box whose renderer paints
 * only the warning chips, defaulting to top-center — where raid eyes already are.
 *
 * Deliberately none of the overlay's geometry machinery: nothing here auto-fits,
 * auto-moves or bottom-anchors, so there is no resting/fitted split to get wrong.
 * The box is generously sized for the worst realistic stack, the chips center inside
 * it, and the only bounds that ever change are the ones the player drags to — which
 * is why the simple history-window remember is enough. It shares the overlay's lock:
 * click-through while locked, draggable (via CSS app-region) while not.
 */
function createAlerts() {
  if (alertsWindow && !alertsWindow.isDestroyed()) return;

  const area = screen.getPrimaryDisplay().workArea;
  const width = 640;
  // Sized for the worst stack a real session produced — a raid AE pull put 15
  // warnings up at once (~480px) — with headroom, because a clipped warning is a
  // silently hidden one. The box is invisible and click-through; height is free.
  const height = 720;
  const bounds = config.get('alertsBounds') ?? {
    width,
    height,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + 16,
  };

  alertsWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    icon: path.join(ASSETS, 'icon-256.png'),
    focusable: true,
    webPreferences: {
      preload: path.join(RENDERER, 'alerts', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  alertsWindow.setAlwaysOnTop(true, 'screen-saver');
  alertsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  alertsWindow.loadFile(path.join(RENDERER, 'alerts', 'index.html'));

  alertsWindow.on('ready-to-show', () => {
    if (!alertsWindow || alertsWindow.isDestroyed()) return;
    alertsWindow.setIgnoreMouseEvents(config.get('locked'));
    alertsWindow.webContents.send(CHANNELS.LOCK_CHANGED, config.get('locked'));
    // Ctrl+Shift+H hides the whole HUD; a warning window that survived it would be
    // the one piece of UI the player explicitly asked to go away.
    if (!overlayVisible) alertsWindow.hide();
  });

  const remember = () => {
    clearTimeout(saveAlertsBoundsTimer);
    saveAlertsBoundsTimer = setTimeout(() => {
      if (!alertsWindow || alertsWindow.isDestroyed()) return;
      config.set({ alertsBounds: alertsWindow.getBounds() });
    }, 400);
  };
  alertsWindow.on('moved', remember);
  alertsWindow.on('closed', () => { alertsWindow = null; });
  // Hangs from its top centre: a warning must stay on your eyeline as the stack grows.
  trackPanelFit(alertsWindow, 'top-center');
}

/**
 * One timer box: a framed row list inside a window sized to exactly what it draws.
 *
 * This replaced the boss-timer panel, and it replaced it by absorbing it. That panel was
 * one window with one position, one switch and one source; a box is the same window
 * generalised — the player makes as many as they want, names them, places them, and the
 * boss timers are simply the one box that ships prebuilt and gets its rows from the
 * trigger packs instead of from timers they typed.
 *
 * Two things differ from every other click-through window here, and both come from one
 * requirement: a box has to be draggable, and a draggable window is not click-through.
 *
 *  - **It is sized to its content, not oversized.** Every other panel buys its safety
 *    with a generously large invisible box. That is fine while it is click-through and
 *    disastrous the moment it is not: an invisible 620x900 rectangle swallows every
 *    click that lands in the empty part of it, including clicks meant for the settings
 *    window behind it. The renderer measures itself and `TIMERS_FIT` resizes the window,
 *    so a box is never bigger than what it draws — and an idle box is nothing at all.
 *  - **Placement is a MODE, not a side effect of the lock.** `arrangingBoxes` makes every
 *    box solid, named and grabbable at once. Unlocking the whole HUD and hoping is not a
 *    way to find a window that draws nothing.
 *
 * Only the position is stored. The size is measured every frame, so there is no stale
 * geometry to go wrong and nothing to migrate when a row height changes.
 */
function createTimerBox(category) {
  if (timerBoxes.has(category.id)) return;

  const area = screen.getPrimaryDisplay().workArea;
  // A whole box's worth of stagger, not a nudge: boxes landing 40px apart overlap, and
  // two windows you cannot tell apart are one window you cannot drag.
  const index = timersRuntime?.categories.findIndex((c) => c.id === category.id) ?? 0;
  const x = Number.isFinite(category.x)
    ? category.x
    : area.x + area.width - 320;
  const y = Number.isFinite(category.y)
    ? category.y
    : area.y + Math.round(area.height * 0.35) + Math.max(0, index) * 160;

  const win = new BrowserWindow({
    x, y, width: 320, height: 60,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    icon: path.join(ASSETS, 'icon-256.png'),
    webPreferences: {
      preload: path.join(RENDERER, 'timerbox', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  timerBoxes.set(category.id, win);
  // Top-left anchored: a box grows down and right from where the player put its corner.
  // `applyPanelFit` parks it off-screen while it has nothing to draw, so an idle box
  // blocks nothing without ever being hidden — a hidden renderer stops painting and
  // could never ask to come back.
  trackPanelFit(win, 'top-left');

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(RENDERER, 'timerbox', 'index.html'), { query: { category: category.id } });

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    // Click-through unless the player is placing it. Nothing else about the HUD lock
    // applies: these are not part of the drag-everything gesture, they have a mode of
    // their own, and that mode is the only time they should take a click.
    win.setIgnoreMouseEvents(!arrangingBoxes);
    win.webContents.send(CHANNELS.TIMERS_ARRANGING, arrangingBoxes);
    pushTimerRows();
  });

  // Read-modify-write into the document, debounced, because one drag fires many moves.
  const remember = () => {
    clearTimeout(saveBoxBoundsTimers.get(category.id));
    saveBoxBoundsTimers.set(category.id, setTimeout(() => {
      if (win.isDestroyed() || !timersStore || !timersRuntime) return;
      const bounds = win.getBounds();
      // Never remember the park as a position the player chose.
      if (bounds.x <= PARKED.x || bounds.y <= PARKED.y) return;
      const model = timersStore.load();
      const next = {
        ...model,
        categories: model.categories.map((c) => (
          c.id === category.id ? { ...c, x: bounds.x, y: bounds.y } : c
        )),
      };
      timersStore.save(next);
      timersRuntime.setModel(next);
    }, 400));
  };
  win.on('moved', remember);
  win.on('closed', () => {
    if (timerBoxes.get(category.id) === win) timerBoxes.delete(category.id);
  });
}

/**
 * The Timers manager: where boxes are made, named and placed, and timers are written.
 *
 * A real window that takes real mouse input and scrolls its panes, like History and
 * Triggers — not a click-through HUD surface. It is the single place that answers "what
 * countdowns do I have and where do they draw", which is why the boss timers appear here
 * as a box like any other rather than as a switch somewhere else.
 */
function createTimerSetup() {
  if (timerSetupWindow && !timerSetupWindow.isDestroyed()) {
    timerSetupWindow.show();
    timerSetupWindow.focus();
    return;
  }
  const bounds = config.get('timerSetupBounds') ?? { width: 1000, height: 720 };
  timerSetupWindow = new BrowserWindow({
    ...bounds,
    minWidth: 820,
    minHeight: 560,
    title: 'EQL DPS Overlay — Timers',
    backgroundColor: '#17130f',
    icon: path.join(ASSETS, 'icon-256.png'),
    webPreferences: {
      preload: path.join(RENDERER, 'timersetup', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  timerSetupWindow.setMenuBarVisibility(false);
  timerSetupWindow.loadFile(path.join(RENDERER, 'timersetup', 'index.html'));

  let save = null;
  const remember = () => {
    clearTimeout(save);
    save = setTimeout(() => {
      if (!timerSetupWindow || timerSetupWindow.isDestroyed()) return;
      config.set({ timerSetupBounds: timerSetupWindow.getBounds() });
    }, 400);
  };
  timerSetupWindow.on('resize', remember);
  timerSetupWindow.on('moved', remember);
  timerSetupWindow.on('closed', () => {
    timerSetupWindow = null;
    // Placement mode must not outlive the window that turned it on, or every box stays
    // solid and clickable over the game with nothing left on screen to switch it off.
    if (arrangingBoxes) setArrangingBoxes(false);
    timersRuntime?.clearPreviews();
    pushTimerRows();
  });
}

/**
 * Persist a new timer document and make every surface agree with it at once.
 *
 * One funnel rather than four copies of "save, recompile, resync, redraw" — the failure
 * that shape prevents is a box that exists in the file, does not exist on screen, and
 * cannot be explained by anything the player did.
 */
function commitTimers(model, extra = {}) {
  const saved = timersStore.save(model);
  if (!saved.ok) {
    // A write failure toasts rather than propagating: a full disk must not take the
    // overlay down, and the player has to know their edit did not stick.
    toast('Timers could not be saved');
    return { ok: false, errors: saved.errors };
  }
  timersRuntime.setModel(saved.model);
  syncTimerBoxes();
  timerSetupWindow?.webContents.send(CHANNELS.TIMERS_PUSH, { changed: true });
  return { ok: true, model: saved.model, ...extra };
}

/**
 * Anchored auto-fit for the click-through panels.
 *
 * The alerts and the drops popup were each sized for their worst realistic content and
 * left that size forever. That is fine while they are click-through and blocking the
 * moment they are not: an invisible 640x720 rectangle across the top of the screen, or a
 * 620x760 one rising from the bottom-right corner, swallows every click that lands in
 * the empty part of it — including clicks meant for the window behind it. The player
 * cannot see the rectangle, so the symptom is a settings window that ignores the mouse
 * in a region with nothing in it.
 *
 * Fitting them means the WINDOW moves whenever the content resizes, so the anchor has to
 * be explicit or the panel walks across the screen — the "window climbs the screen" bug
 * this project has already fixed twice. Each panel has a fixed point it grows away from:
 * the alerts hang from their top CENTRE (a warning must stay on your eyeline), the drops
 * popup hangs from its bottom-right CORNER (it grows up and left into dead space). That
 * point is captured when the window is made and recaptured whenever the PLAYER drags it,
 * never from a fit.
 *
 * @type {Map<BrowserWindow, {mode: 'top-center'|'bottom-right', x: number, y: number}>}
 */
const panelAnchors = new Map();
/** Set while a fit is applying its own bounds, so the `move` it causes is not mistaken
 *  for the player dragging and used to recompute the anchor. */
const fitting = new WeakSet();

function anchorOf(bounds, mode) {
  if (mode === 'top-center') return { mode, x: Math.round(bounds.x + bounds.width / 2), y: bounds.y };
  if (mode === 'bottom-right') return { mode, x: bounds.x + bounds.width, y: bounds.y + bounds.height };
  return { mode, x: bounds.x, y: bounds.y };
}

/**
 * Where an empty panel goes.
 *
 * Off the screen, NOT hidden — and the difference is a bug that cost an afternoon.
 * Hiding was the obvious answer and it is a trap: Electron throttles a hidden window's
 * renderer, so the `ResizeObserver` that would notice the panel had something to show
 * again never fires. The popup works once and is gone for the session. Parked off-screen
 * the renderer keeps painting, keeps measuring, and asks to come back the instant it has
 * content — and it blocks nothing meanwhile, which was the whole point.
 */
const PARKED = { x: -32000, y: -32000, width: 64, height: 64 };

/** Start keeping this window's size in step with its content. */
function trackPanelFit(win, mode) {
  panelAnchors.set(win, anchorOf(win.getBounds(), mode));
  win.on('move', () => {
    // Ignore our own moves — including the park, whose coordinates would otherwise be
    // remembered as where the player wants the panel.
    if (fitting.has(win) || win.isDestroyed()) return;
    const bounds = win.getBounds();
    if (bounds.x <= PARKED.x || bounds.y <= PARKED.y) return;
    panelAnchors.set(win, anchorOf(bounds, mode));
  });
  win.on('closed', () => panelAnchors.delete(win));
}

/** Resize a tracked panel around its anchor, or park it when it has nothing to draw. */
function applyPanelFit(win, width, height) {
  const anchor = win && !win.isDestroyed() ? panelAnchors.get(win) : null;
  if (!anchor) return;

  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  const current = win.getBounds();

  const next = (!w || !h)
    ? PARKED
    : anchor.mode === 'top-center'
      ? { x: Math.round(anchor.x - w / 2), y: anchor.y, width: w, height: h }
      : anchor.mode === 'bottom-right'
        ? { x: anchor.x - w, y: anchor.y - h, width: w, height: h }
        : { x: anchor.x, y: anchor.y, width: w, height: h };

  if (next.x === current.x && next.y === current.y
    && next.width === current.width && next.height === current.height) return;

  fitting.add(win);
  win.setBounds(next);
  // Released on the next turn of the loop: `setBounds` emits `move` synchronously on
  // some platforms and asynchronously on others, and the guard has to cover both.
  setImmediate(() => fitting.delete(win));
}

/** Every live box, in model order. The one accessor every window list uses, so adding a
 *  box never means remembering N call sites. */
function boxWindows() {
  return [...timerBoxes.values()].filter((w) => w && !w.isDestroyed());
}

/**
 * Bring the boxes into line with the document.
 *
 * A box that should exist and does not is opened, one that should not is closed, and one
 * that merely changed its NAME keeps its window and its position and is simply told the
 * new title — rebuilding it on a rename would drop it back to its default corner, and the
 * player would have paid for a typo with a window they had placed.
 */
function syncTimerBoxes() {
  if (!overlayWindow || overlayWindow.isDestroyed() || !timersRuntime) return;
  // Mute wins here as it does for every other consult surface: "shut up for this pull"
  // that left the countdowns running would be the one surface ignoring the hotkey.
  const muted = config.get('alertsMuted') === true;
  const wanted = muted ? [] : timersRuntime.categories.filter((c) => c.enabled);
  const keep = new Set(wanted.map((c) => c.id));

  for (const [id, win] of timerBoxes) {
    if (keep.has(id)) continue;
    timerBoxes.delete(id);
    if (win && !win.isDestroyed()) win.close();
  }
  for (const category of wanted) {
    if (timerBoxes.has(category.id)) continue;
    createTimerBox(category);
  }
  pushTimerRows();
}

/**
 * Send every box its rows.
 *
 * ONE list built once and filtered by each box on its own side — the same call the other
 * panels make, and for the same reason: the push loop skips unchanged ticks, so a
 * renderer that can only learn about a change from the NEXT push sits wrong for minutes
 * during a lull.
 *
 * The boss box's rows come from the trigger engine and are mapped into this shape here.
 * That mapping is the whole of what makes the boss timers "a category like any other":
 * one renderer, one look, one way to place a box.
 */
function pushTimerRows() {
  if (!timersRuntime) return;
  const now = Date.now();
  const rows = timersRuntime.rows(now);

  if (triggers) {
    for (const t of triggers.timers(now)) {
      rows.push({
        id: `boss:${t.key}`,
        categoryId: BOSS_CATEGORY,
        name: t.ability,
        // The boss box has no per-timer colour to inherit: those rows come from packs,
        // which have no colour field. Ember, which is what that panel has always been.
        color: '#b9702a',
        durationMs: t.intervalMs,
        remainingMs: t.dueMs ?? 0,
        spent: t.state !== 'armed',
        since: t.since,
        preview: false,
      });
    }
  }
  rows.sort((a, b) => a.since - b.since);

  // The box's shape travels with its rows, the way its name does, so a resize applies
  // without rebuilding the window — a rebuild would drop the box back to its default
  // corner, which is the same reason a rename does not rebuild it either. The scale
  // multiplication happens here rather than in the renderer so there is one place that
  // knows what a stored 296 means in pixels, and that place is unit-tested.
  const scale = config.get('scale');
  for (const [id, win] of timerBoxes) {
    if (!win || win.isDestroyed()) continue;
    const category = timersRuntime.categories.find((c) => c.id === id);
    win.webContents.send(CHANNELS.TIMERS_PUSH, {
      name: category?.name ?? '',
      look: boxLook(category, scale),
      rows,
    });
  }
}

/**
 * The size fields out of whatever the manager sent, clamped, and nothing else.
 *
 * A whitelist rather than a spread, because this patch is applied straight onto a
 * category: an unfiltered object from the renderer could rewrite `x`, `y` or `builtin`
 * and move a box the player had placed, or make the boss box deletable.
 */
function lookPatch(look) {
  if (!look || typeof look !== 'object') return {};
  const patch = {};
  for (const field of Object.keys(LOOK)) {
    if (look[field] == null) continue;
    patch[field] = clampLook(field, look[field]);
  }
  return patch;
}

/** Turn placement mode on or off across every box at once. */
function setArrangingBoxes(on) {
  arrangingBoxes = Boolean(on);
  for (const win of boxWindows()) {
    win.setIgnoreMouseEvents(!arrangingBoxes);
    win.webContents.send(CHANNELS.TIMERS_ARRANGING, arrangingBoxes);
  }
  pushTimerRows();
}


/**
 * The engaged-drops popup: the quest ledger's answer to "we are fighting this boss —
 * what do I still need from it", floating in a corner while the fight runs and while
 * the corpse is looted.
 *
 * The timers window's contract exactly, for the same reasons: an invisible
 * generously-sized box, click-through on the shared lock, no geometry machinery, its
 * own bounds key written only by its own move handler. The panel bottom-anchors
 * inside the box (see drops.css) so the default placement reads as a corner popup:
 * the box's bottom-right corner sits near the screen's, the panel sits in it, and
 * growth extends up and left into the dead space. The box is sized for the worst
 * realistic list — a fresh ledger meeting an island-8 boss owes ~19 items — with the
 * same "generosity is load-bearing" caveat as the other two, since a clipped row
 * would be a silently hidden one.
 */
function createDropsWindow() {
  if (dropsWindow && !dropsWindow.isDestroyed()) return;

  const area = screen.getPrimaryDisplay().workArea;
  const width = 620;
  const height = 760;
  const bounds = config.get('dropsBounds') ?? {
    width,
    height,
    x: area.x + area.width - width - 20,
    y: area.y + area.height - height - 20,
  };

  dropsWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    icon: path.join(ASSETS, 'icon-256.png'),
    focusable: true,
    webPreferences: {
      preload: path.join(RENDERER, 'drops', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  dropsWindow.setAlwaysOnTop(true, 'screen-saver');
  dropsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  dropsWindow.loadFile(path.join(RENDERER, 'drops', 'index.html'));

  dropsWindow.on('ready-to-show', () => {
    if (!dropsWindow || dropsWindow.isDestroyed()) return;
    dropsWindow.setIgnoreMouseEvents(config.get('locked'));
    dropsWindow.webContents.send(CHANNELS.LOCK_CHANGED, config.get('locked'));
    // A window created mid-fight (the switch flipped in settings) must not sit empty
    // until the next change — hand it whatever the last tick decided.
    dropsWindow.webContents.send(CHANNELS.DROPS, JSON.parse(lastDropsJson));
    if (!overlayVisible) dropsWindow.hide();
  });

  const remember = () => {
    clearTimeout(saveDropsBoundsTimer);
    saveDropsBoundsTimer = setTimeout(() => {
      if (!dropsWindow || dropsWindow.isDestroyed()) return;
      config.set({ dropsBounds: dropsWindow.getBounds() });
    }, 400);
  };
  dropsWindow.on('moved', remember);
  dropsWindow.on('closed', () => { dropsWindow = null; });
  // Hangs from its bottom-right corner, growing up and left into dead space — which is
  // what it was already doing visually inside its oversized box.
  trackPanelFit(dropsWindow, 'bottom-right');
}

/**
 * Bring the alert window into line with the settings — the single place that decides
 * whether it exists.
 *
 * Called from every path that can change an alert key (settings, tray, mute hotkey) so
 * no caller has to remember the create-or-close half of a toggle. Closed rather than
 * hidden: a hidden window still costs a renderer process for a feature the player just
 * said no to. Gated on the overlay existing because during first-run setup there is no
 * HUD yet for a warning to float over.
 */
function syncAlertsWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (alertsEnabled(config.all)) createAlerts();
  else alertsWindow?.close();
}

/** The same create-or-close decision for the timer boxes. `syncTimerBoxes` owns it —
 *  the name survives because every caller of it means "bring the countdowns into line
 *  with the settings", which is exactly what it still does. */
function syncTimersWindow() {
  syncTimerBoxes();
}

/** And for the engaged-drops popup, from its own one switch (mute wins here too). */
function syncDropsWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (dropsEnabled(config.all)) createDropsWindow();
  else dropsWindow?.close();
}

/**
 * Push the current config to every window that listens for it.
 *
 * The alert window gates each category at render time, so a toggle only takes effect
 * when this lands — which is what makes a tray checkbox flip chips off mid-fight. The
 * timers window needs it for `--scale`, and to drop its slots the instant it is
 * switched off rather than at whatever minute the next snapshot arrives.
 */
function broadcastConfig(cfg) {
  for (const win of [overlayWindow, alertsWindow, ...boxWindows(), dropsWindow, setupWindow, timerSetupWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.CONFIG_CHANGED, cfg);
  }
}

/**
 * Flip one alert setting from the tray: persist, resync the windows, redraw the menu.
 *
 * Both syncs run for every switch rather than one per key. Mute is the reason — it is
 * the one key that owns both windows — and a per-key routing table here would be a
 * second copy of what `alertsEnabled`/`timersEnabled` already decide.
 */
function setAlertOption(patch) {
  const after = config.set(patch);
  syncAlertsWindow();
  syncTimersWindow();
  // Mute owns this window too — it is a consult surface like the timers.
  syncDropsWindow();
  broadcastConfig(after);
  refreshTrayMenu();
}

/**
 * Mute: the session gesture, bound to a hotkey because the moment you want it is
 * mid-pull with a boss on the screen.
 *
 * Deliberately not "uncheck every category" — the categories are preferences and this
 * is a temporary silence, so it suppresses the window without touching them. It is also
 * narrower than Ctrl+Shift+H: that hides the whole HUD including the meter, this leaves
 * the numbers up and only takes the warnings away.
 */
function toggleAlerts() {
  const alertsMuted = !config.get('alertsMuted');
  setAlertOption({ alertsMuted });
  toast(alertsMuted ? 'Alerts muted' : 'Alerts unmuted');
}

// ---------------------------------------------------------------------------
// Lock / visibility
// ---------------------------------------------------------------------------

/**
 * Locked: click-through, not focusable, not draggable — the game gets every click.
 * Unlocked: a normal interactive window that can be dragged and resized.
 */
function applyLock(locked) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    // No `forward: true`. It is the documented way to keep receiving mouse moves under
    // click-through, but it delivered nothing here, so hover is driven by cursor polling
    // instead (see startHoverPolling). The upside is that the window never needs mouse
    // events back, so the game keeps every click even while the breakdown is open.
    overlayWindow.setIgnoreMouseEvents(locked);
    overlayWindow.webContents.send(CHANNELS.LOCK_CHANGED, locked);
  }

  // One lock for the whole HUD: unlocking to reposition the meter is the moment to
  // reposition the warnings, the timers and the drops popup too, and a separate
  // hotkey per window would just be things to forget instead of one. Placement stays
  // separate — only the GESTURE is shared.
  for (const win of [alertsWindow, dropsWindow]) {
    if (!win || win.isDestroyed()) continue;
    win.setIgnoreMouseEvents(locked);
    win.webContents.send(CHANNELS.LOCK_CHANGED, locked);
  }
  // The timer boxes are deliberately NOT part of this. They have a placement mode of
  // their own (`setArrangingBoxes`) because a box that draws nothing between fights
  // cannot be found by unlocking everything and hoping — and because a box left
  // clickable would swallow clicks meant for whatever is behind it.
}

/**
 * Track the cursor so the overlay can show a hover breakdown while staying click-through.
 *
 * Only runs while locked; unlocked the window is ordinary and DOM mouse events work.
 * 16 Hz is far below what a cursor poll costs and well above what reads as responsive.
 */
function startHoverPolling() {
  clearInterval(hoverTimer);
  let last = null;

  hoverTimer = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (!overlayVisible || !config.get('locked')) {
      if (last !== null) {
        last = null;
        overlayWindow.webContents.send(CHANNELS.HOVER, null);
      }
      return;
    }

    const pt = screen.getCursorScreenPoint();
    const b = overlayWindow.getBounds();
    const inside =
      pt.x >= b.x && pt.x < b.x + b.width &&
      pt.y >= b.y && pt.y < b.y + b.height;

    // getCursorScreenPoint and getBounds are both in device-independent pixels, which
    // is also what CSS pixels are at zoom 1 — so this maps straight onto the DOM.
    const next = inside ? { x: pt.x - b.x, y: pt.y - b.y } : null;
    if (next === null && last === null) return;
    if (next && last && next.x === last.x && next.y === last.y) return;

    last = next;
    overlayWindow.webContents.send(CHANNELS.HOVER, next);
  }, 60);
}

function toggleLock() {
  const locked = !config.get('locked');
  config.set({ locked });
  applyLock(locked);
  // The timer boxes join the unlock gesture even though they have a mode of their own.
  // Ctrl+Shift+L is the muscle memory for "let me move things", and a set of windows
  // that did not respond to it would be a set of windows the player concludes cannot be
  // moved at all. The Timers window's own button stays — it is how you place them
  // without unlocking the meter — and both drive the same mode.
  setArrangingBoxes(!locked);
  refreshTrayMenu();
  toast(locked ? 'Overlay locked' : 'Overlay unlocked — drag to move');
}

function toggleVisible() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayVisible = !overlayVisible;
  if (overlayVisible) {
    overlayWindow.showInactive();   // show without stealing focus from the game
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    for (const win of [alertsWindow, ...boxWindows(), dropsWindow]) {
      if (!win || win.isDestroyed()) continue;
      win.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver');
    }
  } else {
    overlayWindow.hide();
    alertsWindow?.hide();
    for (const win of boxWindows()) win.hide();
    dropsWindow?.hide();
  }
  refreshTrayMenu();
}

/**
 * "Put this fight in chat" — the hotkey and the tray row, both asking the overlay to do
 * what its COPY button does.
 *
 * Main deliberately does NOT compose the line here, even though it holds the parser and
 * the stored metric. What has to reach the clipboard is the rows the overlay is showing,
 * in its order, with its filters — `report.js`, shared with `render()` — and a second
 * derivation of that from `parser.snapshot()` would drift silently, discovered only once
 * the wrong line was in guild chat. So this sends an intent and the renderer comes back
 * through CLIPBOARD_COPY with finished text. See the note on COPY_REPORT in `ipc.js`.
 *
 * The toast belongs to the renderer for the same reason: only it knows whether the line
 * was shortened or lost members. With the HUD hidden that toast draws into a hidden
 * window and the copy still lands — the same deal `resetEncounter` has always had, and
 * the snapshot push loop keeps feeding a hidden window, so the line is current rather
 * than whatever was on screen when it was hidden.
 */
function copyReport() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send(CHANNELS.COPY_REPORT);
}

/**
 * The Quests… tray row as a keyboard gesture, in both directions: open the window if
 * it is gone, close it if it is up. One-way "open or focus" was considered and
 * rejected — a binding that cannot dismiss what it summoned forces the mouse trip it
 * exists to avoid, and no other hotkey here is one-way. The known edge: a window that
 * is open but buried behind the game closes on the first press instead of raising.
 * Worst case is a second press, and the closing press itself answers "was it open?".
 */
function toggleQuests() {
  if (questsWindow && !questsWindow.isDestroyed()) {
    questsWindow.close();
    return;
  }
  createQuests();
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const keys = config.get('hotkeys');

  const bind = (accelerator, fn, label) => {
    if (!accelerator) return;
    try {
      if (!globalShortcut.register(accelerator, fn)) {
        toast(`Hotkey ${accelerator} is taken by another app (${label})`);
      }
    } catch {
      toast(`Hotkey ${accelerator} is not valid (${label})`);
    }
  };

  bind(keys.toggleLock, toggleLock, 'lock');
  bind(keys.toggleVisible, toggleVisible, 'show/hide');
  bind(keys.resetEncounter, resetEncounter, 'reset');
  bind(keys.toggleMetric, toggleMetric, 'damage/healing');
  bind(keys.toggleAlerts, toggleAlerts, 'mute alerts');
  bind(keys.newSession, startNewSession, 'new session');
  bind(keys.copyReport, copyReport, 'copy');
  bind(keys.openQuests, toggleQuests, 'quests');
  bind(keys.openTimers, createTimerSetup, 'timers');
}

/**
 * "Start again from here" — the hotkey, the tray item and the overlay button.
 *
 * One function because it now has to clear TWO things, and three call sites each
 * remembering to do both is three chances to forget the second. A reset is the player
 * saying the screen no longer describes anything they care about, and a trigger chip or
 * countdown left standing would be the one part of the HUD that disagreed.
 *
 * Deliberately NOT recorded in history, unchanged — the parser's onEncounterEnd contract
 * is that a manual reset closes nothing.
 */
function resetEncounter() {
  parser?.reset();
  triggers?.reset();
  toast('Encounter reset');
}

/**
 * "That grind is over" — close the night's record and start a fresh one from here.
 *
 * Deliberately NOT part of `resetEncounter` above, and the difference is the whole point:
 * an encounter reset DISCARDS (the parser's onEncounterEnd contract is that a manual reset
 * closes nothing), while this one SAVES. The last three hours happened, so they are
 * written as a finished session with `closeReason: 'manual'` and appear in the Session
 * window immediately; only the counting starts again. Folding this into the every-pull
 * reset hotkey would end the night's record every time the player cleared a stale meter
 * mid-fight, which is a very different cost to get wrong.
 *
 * `close()` does the rest of the work: it hands the record to `persistSession`, and it
 * moves its own `minTs` floor to the last tracked event so the session that opens next
 * cannot re-count anything the closed one already had.
 *
 * The checkpoint is cleared unconditionally rather than left to `persistSession`, which
 * only clears it when a record actually arrives. A session holding nothing but zone lines
 * has `events === 0`, so `close()` discards it and calls nothing — and the checkpoint file
 * written five minutes ago would then survive to the next launch, where `recover()`
 * appends without re-checking `events` and resurrects the very session the player just
 * ended. One line here shuts that.
 */
function startNewSession() {
  // Honest about WHICH nothing happened. A global shortcut that silently does nothing is
  // worse than one that explains itself — and the tray row for this is hidden while
  // tracking is off, so the hotkey is the only way to reach the first branch. The two are
  // separated because they are separate states: the switch being off is a preference, while
  // a tracker that does not exist yet means no log is being followed at all.
  if (!sessionEnabled(config.all)) {
    toast('Session tracking is off');
    return;
  }
  if (!session) {
    toast('No session in progress');
    return;
  }

  const record = session.close('manual');
  try {
    sessionStore?.clearCheckpoint(sessionKey(parser?.selfName, parser?.server));
  } catch {
    // An unremovable checkpoint costs a duplicate-suppressed recovery at worst; it is not
    // a reason to tell the player their session did not close, because it did.
  }
  // The toast is frequently the ONLY confirmation: the meter's session line is off by
  // default and the Session window is usually shut during a grind.
  toast(record ? 'Session saved — starting a new one' : 'No session in progress');
}

/** The metric cycle: damage → healing → taken → damage. */
const METRIC_CYCLE = ['damage', 'healing', 'taken'];
const METRIC_LABEL = { damage: 'damage', healing: 'healing', taken: 'damage taken' };

function toggleMetric() {
  // indexOf on an unknown stored value is -1, which +1 lands on 'damage' — so a
  // config written by a future version degrades to the default instead of sticking.
  const idx = METRIC_CYCLE.indexOf(config.get('metric'));
  const metric = METRIC_CYCLE[(idx + 1) % METRIC_CYCLE.length];
  config.set({ metric });
  overlayWindow?.webContents.send(CHANNELS.CONFIG_CHANGED, config.all);
  refreshTrayMenu();
  toast(`Showing ${METRIC_LABEL[metric]}`);
}

// ---------------------------------------------------------------------------
// Pushes to the renderer
// ---------------------------------------------------------------------------

function toast(message, ms) {
  // A caller that names no duration gets the player's configured default. The callers
  // that DO pass one (update notices, the first-run hint, error toasts) sized it to
  // their message, and the Durations dialog deliberately does not reach them.
  overlayWindow?.webContents.send(CHANNELS.TOAST, {
    message,
    ms: ms ?? (config ? durationSec(config.all, 'toastSec') * 1000 : undefined),
  });
}

/**
 * Who we are following, and how the overlay should look. Sent rarely, on purpose.
 *
 * This deliberately carries no staleness verdict. It used to: the footer read "log is
 * stale — type /log on", computed here from the file's mtime. But this function runs three
 * times in a session — when the overlay window appears, on a character switch, and after a
 * settings save — while the snapshot that fills the meter is pushed four times a second on
 * a different channel. So the verdict was reached once, at startup, and then frozen. Launch
 * the overlay before the game is writing and the warning latched on and stayed on all
 * night, over rows of live numbers that disproved it.
 *
 * It was deleted rather than repaired, and that is the interesting decision. The meter
 * already answers "is my log live" continuously and unambiguously: the numbers move. A
 * second claim in words, one that can disagree with the numbers beside it, is worse than
 * no claim — and even repaired it could only ever restate what an empty meter already says.
 * The nudge for a player who genuinely has logging off survives where it is actually
 * useful: the settings window checks the file it is about to adopt and says so
 * (`LOG_VALIDATE`, and `validate()` in the setup renderer), which is a real check made at
 * the moment of choosing and is on screen at first run.
 *
 * What DOES live in that footer slot now is the update notice, and it is the opposite kind
 * of claim: it is pushed at the moment it becomes true, it stays true until acted on, and
 * nothing on screen can contradict it. The old warning failed all three.
 */
function pushStatus() {
  if (!overlayWindow || overlayWindow.isDestroyed() || !tailer) return;
  overlayWindow.webContents.send(CHANNELS.STATUS, {
    logPath: tailer.filePath,
    character: tailer.character,
    update: updateNotice,
    locked: config.get('locked'),
    opacity: config.get('opacity'),
    scale: config.get('scale'),
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle(CHANNELS.CONFIG_GET, () => config.all);
  ipcMain.handle(CHANNELS.CONFIG_DURATION_DEFAULTS, () => ({ ...DURATION_DEFAULTS }));
  ipcMain.handle(CHANNELS.MOBILE_STATE, () => mobileState());
  ipcMain.handle(CHANNELS.MOBILE_OPEN, () => { createSecondScreen(); });

  ipcMain.handle(CHANNELS.CONFIG_SET, async (_e, patch) => {
    const before = config.all;
    const after = config.set(patch);

    if (patch.hotkeys) registerHotkeys();
    if (patch.partyMembers !== undefined) applyPartyList();
    if (patch.petOwners) parser?.setPetOwners(after.petOwners);
    if (parser && (patch.combatTimeoutSec || patch.postKillGraceSec || patch.rollingWindowSec)) {
      // Encounter tuning only affects fights started from here; rewriting a running
      // encounter's thresholds mid-fight would move the number under the player.
      Object.assign(parser.encounterOptions, {
        timeoutMs: after.combatTimeoutSec * 1000,
        postKillGraceMs: after.postKillGraceSec * 1000,
        rollingWindowMs: after.rollingWindowSec * 1000,
      });
    }
    if (DURATION_KEYS.some((key) => patch[key] !== undefined)) {
      // The same contract as encounter tuning: a chip already up keeps the ttlMs it
      // was stamped with, and the new length applies from the next one. Quest chips
      // and the toast default read config live, so only the parser and the trigger
      // engine hold copies that need refreshing.
      if (parser) Object.assign(parser.alertTtls, alertTtls(after));
      triggers?.setWarnTtl(durationSec(after, 'triggerChipSec') * 1000);
    }
    if (patch.logPath && patch.logPath !== before.logPath) {
      await startTailing(patch.logPath);
    }
    // Any of the three categories, or the mute, can be what brings the alert window
    // into or out of existence — the predicate decides, not the individual key. The
    // timers window answers to its own switch, and to the same mute.
    if (ALERT_KEYS.some((key) => patch[key] !== undefined)) syncAlertsWindow();
    if (TIMER_KEYS.some((key) => patch[key] !== undefined)) syncTimersWindow();
    // The boxes are told their size in pixels rather than working it out from the scale
    // themselves, so the settings slider has to re-send it. Without this the whole HUD
    // resizes and the timer boxes alone sit at the old size until the next timer fires.
    if (patch.scale !== undefined) pushTimerRows();
    if (DROPS_KEYS.some((key) => patch[key] !== undefined)) syncDropsWindow();
    // One block, one predicate — the master switch decides whether the tracker exists at
    // all and the seven categories decide what it reads, so any touch of it re-derives
    // both rather than trying to work out which half moved.
    if (patch.session !== undefined) syncSessionTracker();
    // Same wholesale contract for the second screen: any touched key rebuilds it.
    if (MOBILE_KEYS.some((key) => patch[key] !== undefined)) await syncMobileServer();

    broadcastConfig(after);
    // The tray carries the same switches as the settings form, so a change made in
    // one has to redraw the other — without this the checkmarks quietly go stale.
    refreshTrayMenu();
    pushStatus();
    return after;
  });

  // ---------------------------------------------------------------- triggers

  ipcMain.handle(CHANNELS.TRIGGERS_GET, (_e, id) => triggerStore.get(id) ?? null);

  /**
   * Flip one built-in rule.
   *
   * The renderer names a ROW and `builtin-pack.js` decides which config key that is —
   * an unknown name writes nothing rather than setting whatever key it happened to
   * spell. Same reload path as a pack change, because the alerts and timers windows
   * have to be re-derived either way.
   */
  ipcMain.handle(CHANNELS.TRIGGERS_SET_BUILTIN, (_e, { key, enabled }) => {
    const patch = builtinPatch(key, enabled);
    if (!patch) return { ok: false };
    setAlertOption(patch);
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.TRIGGERS_SET_PRESET, (_e, name) => {
    const patch = builtinPresetPatch(name);
    if (!patch) return { ok: false };
    setAlertOption(patch);
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.TRIGGERS_OPEN, () => { createTriggers(); });

  ipcMain.handle(CHANNELS.TRIGGERS_LIST, () => ({
    /**
     * The rules this app ships with, first in the rail.
     *
     * Built from live config every time rather than cached, because the same keys are
     * still writable from the tray — a stale copy here would show the player a switch
     * in the position it was in when the window opened.
     */
    builtin: builtinPack(config.all),
    // `packs` and `problems` — a pack file that would not parse is skipped rather than
    // thrown over, and named here so a corrupt one is visible instead of just absent.
    ...triggerStore.summary(),
    // Patterns that ARE loaded but are not running: one that would not compile, or one
    // the budget guard switched off for overrunning. Named rather than left to be
    // discovered mid-raid as a trigger that mysteriously stopped.
    silenced: triggers?.problems() ?? [],
    // So the form can say "imported, but the chips are switched off" instead of leaving
    // the player to wonder why nothing appears.
    alertsOn: config.get('triggerAlerts') !== false && config.get('alertsMuted') !== true,
    timersOn: config.get('triggerTimers') !== false && config.get('alertsMuted') !== true,
  }));

  /**
   * Import a `.gtp` or a bare `SharedData.xml`, and report honestly on what arrived.
   *
   * The dry-run runs on import rather than on request: it takes about two seconds
   * against a 79 MB log, and a report the player has to go and ask for is a report most
   * of them will never see. The pack is saved either way — what fires is information
   * about the pack, not a condition of keeping it.
   */
  ipcMain.handle(CHANNELS.TRIGGERS_IMPORT, async () => {
    const result = await dialog.showOpenDialog(setupWindow ?? overlayWindow, {
      title: 'Import a GINA trigger package',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'GINA packages', extensions: ['gtp', 'xml'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };

    const imported = [];
    for (const file of result.filePaths) {
      try {
        const { pack, dropped } = parseGinaPackage(fs.readFileSync(file), {
          name: path.basename(file).replace(/\.\w+$/i, ''),
        });
        const saved = triggerStore.add(pack);
        if (!saved.ok) {
          imported.push({ file: path.basename(file), ok: false, errors: saved.errors });
          continue;
        }
        imported.push({
          file: path.basename(file),
          ok: true,
          pack: { id: saved.pack.id, name: saved.pack.name, ...packStats(saved.pack) },
          dropped,
          dryRun: await measurePack(saved.pack),
        });
      } catch (err) {
        imported.push({ file: path.basename(file), ok: false, errors: [err.message] });
      }
    }

    reloadTriggerPacks();
    return { canceled: false, imported };
  });

  ipcMain.handle(CHANNELS.TRIGGERS_EXPORT, async (_e, id) => {
    const pack = triggerStore.get(id);
    if (!pack) return { ok: false, error: 'no such pack' };

    const result = await dialog.showSaveDialog(setupWindow ?? overlayWindow, {
      title: 'Export as a GINA package',
      defaultPath: `${pack.id}.gtp`,
      filters: [{ name: 'GINA packages', extensions: ['gtp'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    try {
      const { buffer, lost } = exportGinaPackage(pack);
      await fs.promises.writeFile(result.filePath, buffer);
      // `lost` is returned rather than swallowed: GINA's schema has no element for a
      // warning group, a severity tier or provenance, and a file that silently means
      // less than the one it came from is the same failure as a lossy import.
      return { ok: true, path: result.filePath, lost };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle(CHANNELS.TRIGGERS_REMOVE, (_e, id) => {
    const removed = triggerStore.remove(id);
    reloadTriggerPacks();
    return { ok: removed };
  });

  ipcMain.handle(CHANNELS.TRIGGERS_SET_ENABLED, (_e, { id, enabled }) => {
    const pack = triggerStore.setEnabled(id, enabled);
    reloadTriggerPacks();
    return { ok: Boolean(pack) };
  });

  ipcMain.handle(CHANNELS.TRIGGERS_SET_PART_ENABLED, (_e, { id, groupId, triggerId, enabled }) => {
    const pack = groupId
      ? triggerStore.setGroupEnabled(id, groupId, enabled)
      : triggerStore.setTriggerEnabled(id, triggerId, enabled);
    reloadTriggerPacks();
    return { ok: Boolean(pack) };
  });

  /**
   * Create an empty pack of the player's own.
   *
   * The name arrives from a renderer and becomes a FILENAME, which is the whole reason
   * this goes through `triggerStore.add()`: that routes it through `freeId`/`safeId`, so
   * a pack called `../../config` lands as `config.json` inside the triggers directory
   * rather than anywhere else, and a second pack sharing a name gets its own id instead
   * of silently replacing the first.
   */
  ipcMain.handle(CHANNELS.TRIGGERS_CREATE_PACK, (_e, { name } = {}) => {
    const clean = String(name ?? '').trim();
    if (!clean) return { ok: false, errors: ['a name is required'] };

    const saved = triggerStore.add({
      id: clean,
      name: clean,
      comments: 'Triggers written here.',
      origin: 'native',
      enabled: true,
      groups: [],
      triggers: [],
    });
    if (!saved.ok) return { ok: false, errors: saved.errors };
    reloadTriggerPacks();
    return { ok: true, packId: saved.pack.id };
  });

  /**
   * Save an authored trigger into "My Triggers".
   *
   * The player's own work goes into a pack of its own rather than into whichever
   * imported pack happens to be open — which matters the moment that pack is removed,
   * re-imported, or exported back out with an attribution it no longer deserves.
   */
  ipcMain.handle(CHANNELS.TRIGGERS_SAVE_TRIGGER, (_e, { packId, triggerId, form }) => {
    const pack = packId ? triggerStore.get(packId) : triggerStore.myTriggers();
    if (!pack) return { ok: false, errors: ['no such pack'] };

    const result = triggerId ? updateTrigger(pack, triggerId, form) : createTrigger(pack, form);
    if (!result.ok) return { ok: false, errors: result.errors };

    const saved = triggerStore.save(result.pack);
    if (!saved.ok) return { ok: false, errors: saved.errors };
    reloadTriggerPacks();
    return { ok: true, packId: saved.pack.id, trigger: result.trigger };
  });

  ipcMain.handle(CHANNELS.TRIGGERS_DELETE_TRIGGER, (_e, { packId, triggerId }) => {
    const pack = triggerStore.get(packId);
    if (!pack) return { ok: false, errors: ['no such pack'] };
    const result = deleteTrigger(pack, triggerId);
    if (!result.ok) return { ok: false, errors: result.errors };
    triggerStore.save(result.pack);
    reloadTriggerPacks();
    return { ok: true };
  });

  /**
   * The Test button: one pattern, replayed against the player's OWN log.
   *
   * This is what GINA users do by hand-grepping their logs, and it is the whole
   * authoring loop — write a pattern, press Test, see it fired 989 times in your own
   * 149 hours with a sample line.
   */
  ipcMain.handle(CHANNELS.TRIGGERS_TEST_PATTERN, async (_e, { pattern, literal }) => {
    if (!tailer?.filePath) return { ok: false, error: 'no log is being followed' };
    try {
      const built = patternTemplate(pattern ?? '', !literal);
      const tail = await readLogTail(tailer.filePath);
      return {
        ...testPattern(built.template, tail.lines, { character: parser?.selfName ?? null }),
        // Stated so the result reads "in the last N lines" rather than implying the
        // whole file, which the tail read deliberately does not cover.
        truncated: tail.truncated,
      };
    } catch (err) {
      return { ok: false, error: err.message, hits: 0, samples: [], lines: 0 };
    }
  });

  ipcMain.handle(CHANNELS.TRIGGERS_DRY_RUN, async (_e, { id, rankTolerant }) => {
    const pack = triggerStore.get(id);
    if (!pack) return { ok: false, error: 'no such pack' };
    try {
      return { ok: true, ...(await measurePack(pack, { rankTolerant })) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ------------------------------------------------------------------ timer boxes

  /** Everything the manager draws: the boxes, the timers, and what is silenced. */
  ipcMain.handle(CHANNELS.TIMERS_GET, () => ({
    ...(timersStore?.load() ?? { categories: [], timers: [] }),
    palette: PALETTE,
    // The ranges the size sliders may take. Sent rather than repeated in the renderer,
    // so the clamp the model enforces and the limit the control offers are the same
    // numbers — a slider that could ask for a width the model would refuse is a control
    // that silently does nothing at one end.
    lookLimits: LOOK,
    // So the manager can say "your timers are muted" rather than leaving the player to
    // discover it by watching nothing happen.
    muted: config.get('alertsMuted') === true,
    arranging: arrangingBoxes,
    problems: timersRuntime?.problems() ?? [],
  }));

  ipcMain.handle(CHANNELS.TIMERS_SAVE_CATEGORY, (_e, { id, name, enabled, look } = {}) => {
    const model = timersStore.load();
    const result = id
      ? updateCategory(model, id, {
        ...(name != null ? { name } : {}),
        ...(enabled != null ? { enabled } : {}),
        ...lookPatch(look),
      })
      : addCategory(model, name);
    if (!result.ok) return { ok: false, errors: result.errors };
    return commitTimers(result.model, { id: result.id ?? id });
  });

  ipcMain.handle(CHANNELS.TIMERS_REMOVE_CATEGORY, (_e, { id } = {}) => {
    const result = removeCategory(timersStore.load(), id);
    if (!result.ok) return { ok: false, errors: result.errors };
    return commitTimers(result.model);
  });

  ipcMain.handle(CHANNELS.TIMERS_SAVE_TIMER, (_e, { id, form } = {}) => {
    const model = timersStore.load();
    const result = id ? updateTimer(model, id, form) : addTimer(model, form);
    if (!result.ok) return { ok: false, errors: result.errors };
    return commitTimers(result.model, { timerId: result.timer?.id });
  });

  ipcMain.handle(CHANNELS.TIMERS_REMOVE_TIMER, (_e, { id } = {}) => {
    const result = removeTimer(timersStore.load(), id);
    if (!result.ok) return { ok: false, errors: result.errors };
    return commitTimers(result.model);
  });

  /** Placement mode: every box goes solid, names itself and can be dragged. */
  ipcMain.handle(CHANNELS.TIMERS_ARRANGE, (_e, { on } = {}) => {
    setArrangingBoxes(on);
    return { ok: true, arranging: arrangingBoxes };
  });

  /**
   * Put a sample row in one box now.
   *
   * The answer to "where did that box go" and "is two minutes long enough", asked at the
   * moment the player is deciding both. It reports what they will actually SEE, because
   * a preview that silently did nothing because alerts were muted would send them
   * looking for a broken timer instead of a muted overlay.
   */
  ipcMain.handle(CHANNELS.TIMERS_PREVIEW, (_e, { categoryId, name, durationSec, color, one } = {}) => {
    if (!timersRuntime) return { ok: false, drawing: false, reason: 'the timer runtime is not running' };

    if (one) {
      // One row — the editor previewing the timer being typed, which may not be saved
      // yet and so is not in the model to be found.
      timersRuntime.preview({
        categoryId,
        key: 'draft',
        name: String(name ?? '').trim() || 'Preview',
        durationMs: Math.max(1000, Math.round(Number(durationSec ?? 45) * 1000)),
        color: color ?? null,
      });
    } else {
      // A box preview shows the box as it will actually LOOK: its own timers, with their
      // own names, durations and colours, at staggered fill levels. A single stand-in row
      // answers "where is this box" and not "can I read three of these at a glance",
      // which is the question somebody placing it is actually asking.
      const model = timersStore.load();
      const mine = model.timers.filter((t) => t.categoryId === categoryId && t.enabled);
      // The boss box has no timers of its own — its rows come from the trigger packs —
      // so it gets a couple of stand-ins rather than nothing.
      const rows = mine.length
        ? mine.slice(0, 8).map((t) => ({
          key: t.id, timerId: t.id, name: t.name, durationMs: t.durationMs, color: t.color,
        }))
        : [
            { key: 's1', name: 'A boss cast', durationMs: 62_000, color: '#b9702a' },
            { key: 's2', name: 'Another one', durationMs: 30_000, color: '#b9702a' },
          ];
      rows.forEach((row, i) => {
        timersRuntime.preview({
          categoryId,
          key: row.key,
          // Null for the two stand-ins the boss box gets: they mock no timer, so an edit
          // elsewhere must not reach in and take them down.
          timerId: row.timerId ?? null,
          name: row.name,
          durationMs: row.durationMs,
          color: row.color,
          // Staggered, so the bars sit at different lengths instead of all being full.
          remainingMs: Math.max(4000, Math.round(row.durationMs * (0.85 - (i * 0.18) % 0.7))),
        });
      });
    }
    pushTimerRows();

    if (config.get('alertsMuted') === true) {
      return { ok: true, drawing: false, reason: 'alerts are muted, which silences the timer boxes too' };
    }
    const category = timersRuntime.categories.find((c) => c.id === categoryId);
    if (!category) return { ok: true, drawing: false, reason: 'that box no longer exists' };
    if (!category.enabled) return { ok: true, drawing: false, reason: `"${category.name}" is switched off` };
    if (!overlayVisible) return { ok: true, drawing: false, reason: 'the HUD is hidden — Ctrl+Shift+H brings it back' };
    return { ok: true, drawing: true, reason: null };
  });

  /** A click-through panel reporting its content size. See `trackPanelFit`. */
  ipcMain.on(CHANNELS.PANEL_FIT, (event, { width, height } = {}) => {
    applyPanelFit(BrowserWindow.fromWebContents(event.sender), width, height);
  });

  ipcMain.handle(CHANNELS.TIMERS_CLEAR_PREVIEWS, (_e, { categoryId } = {}) => {
    const removed = timersRuntime?.clearPreviews(categoryId ?? null) ?? 0;
    if (removed) pushTimerRows();
    return { ok: true, removed };
  });

  /**
   * Measure the player's own effects out of their own log.
   *
   * There is no honest shortcut: buff length depends on their level, on the RANK of the
   * spell — `Spirit of the Puma V` and `VI` differ by thirteen seconds in one session of
   * the live log — and on their AAs. A table we shipped would be wrong for everybody in
   * a slightly different way, and wrong in the direction that matters, because a
   * countdown that ends early is one you learn to trust before it lies to you.
   */
  ipcMain.handle(CHANNELS.TIMERS_MEASURE, async (_e, { categoryId } = {}) => {
    if (!tailer?.filePath) return { ok: false, errors: ['no log file is being read yet'] };
    try {
      const result = await mineBuffsLog(tailer.filePath, { minObs: 5, maxCv: 0.15 });
      const model = timersStore.load();
      const target = categoryId ?? model.categories.find((c) => !c.builtin)?.id;
      if (!target) return { ok: false, errors: ['make a box for them first'] };

      // Anything already here is left alone: re-measuring must not silently overwrite a
      // duration the player has corrected by hand.
      const have = new Set(model.timers.filter((t) => t.categoryId === target)
        .map((t) => t.startsOn.toLowerCase()));
      let next = model;
      const added = [];
      for (const c of result.candidates) {
        if (have.has(c.land.toLowerCase())) continue;
        const step = addTimer(next, {
          categoryId: target,
          name: c.name,
          startsOn: c.land,
          match: 'contains',
          durationSec: Math.round(c.durationMs / 1000),
          color: PALETTE[added.length % PALETTE.length],
          endsOn: c.wearOff,
        });
        if (!step.ok) continue;
        next = step.model;
        added.push({ ...c, id: step.timer.id });
      }
      commitTimers(next);
      return { ok: true, added, found: result.candidates.length, lines: result.lines };
    } catch (err) {
      return { ok: false, errors: [err.message] };
    }
  });

  /**
   * A box telling us how big it needs to be.
   *
   * `send` rather than `invoke` because it fires on every render and wants no answer, and
   * position is deliberately untouched here — main owns the bounds, and deriving
   * placement from live bounds is the "window climbs the screen" bug this project has
   * already fixed twice.
   */
  ipcMain.on(CHANNELS.TIMERS_FIT, (event, { width, height } = {}) => {
    applyPanelFit(BrowserWindow.fromWebContents(event.sender), width, height);
  });

  ipcMain.handle(CHANNELS.PETS_STATE, () => ({
    mapped: parser?.petMappings() ?? [],
    unmapped: parser?.unmappedEntities() ?? [],
  }));

  ipcMain.handle(CHANNELS.ROSTER_STATE, () => {
    if (!parser) return { ok: false, character: null, key: null, seen: [], group: [], tracked: [] };
    const enc = parser.current ?? parser.last;
    const damageOf = (name) => enc?.combatants.get(name)?.damage ?? 0;
    // Everyone the parser counts as one of us, with just enough beside each name to tell
    // people apart in a public zone — whether they are you, whether the game said they
    // are in your group, and what they have actually done.
    const seen = parser.friendlyNames()
      .map((name) => ({
        name,
        self: name === parser.selfName,
        inGroup: parser.roster.explicit.has(name),
        damage: damageOf(name),
      }))
      .sort((a, b) => Number(b.self) - Number(a.self)
        || Number(b.inGroup) - Number(a.inGroup)
        || b.damage - a.damage
        || a.name.localeCompare(b.name));
    return {
      ok: true,
      character: parser.selfName,
      server: parser.server,
      key: storeKey(parser.selfName, parser.server),
      seen,
      group: [...parser.roster.explicit],
      tracked: [...parser.roster.partyMembers],
    };
  });

  // "Not a pet" from the settings picker. The parser already has this gesture — it is
  // what `pet <name> = clear` does in chat — and it must blacklist rather than merely
  // forget, or the next summon nearby re-learns the same wrong answer a minute later.
  ipcMain.handle(CHANNELS.PETS_NOT_A_PET, (_e, name) => {
    const pet = String(name ?? '').trim();
    if (!parser || !pet) return { ok: false };
    parser.roster.petOwners.delete(pet);
    parser.roster.unbindPet(pet, { includeStrong: true });
    parser.roster.notPets.add(pet);
    parser.revision++;
    const owners = { ...config.get('petOwners') };
    delete owners[pet];
    config.set({ petOwners: owners });
    parser.setPetOwners(owners);
    return { ok: true, petOwners: owners };
  });

  ipcMain.handle(CHANNELS.LOGS_LIST, async (_e, dir) => {
    const target = dir || config.get('logDir') || DEFAULT_LOG_DIR;
    try {
      const logs = await listLogs(target);
      return { ok: true, dir: target, logs };
    } catch (err) {
      return { ok: false, dir: target, logs: [], error: err.message };
    }
  });

  ipcMain.handle(CHANNELS.LOGS_PICK, async (_e, mode) => {
    const win = setupWindow ?? overlayWindow;
    const result = await dialog.showOpenDialog(win, {
      title: mode === 'directory' ? 'Choose the EverQuest Logs folder' : 'Choose an eqlog file',
      defaultPath: config.get('logDir') || DEFAULT_LOG_DIR,
      properties: mode === 'directory' ? ['openDirectory'] : ['openFile'],
      filters: mode === 'directory' ? undefined : [{ name: 'EverQuest logs', extensions: ['txt'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });

  /**
   * Prove a file is really an EverQuest log before letting the user commit to it,
   * so a wrong pick fails on the setup screen rather than as a silently empty overlay.
   */
  ipcMain.handle(CHANNELS.LOGS_VALIDATE, async (_e, filePath) => {
    try {
      const st = await fs.promises.stat(filePath);
      const handle = await fs.promises.open(filePath, 'r');
      let sample;
      try {
        const size = Math.min(st.size, 16 * 1024);
        const buf = Buffer.alloc(size);
        await handle.read(buf, 0, size, Math.max(0, st.size - size));
        sample = buf.toString('latin1');
      } finally {
        await handle.close();
      }

      const probe = new LogParser({ logFilename: path.basename(filePath) });
      const lines = sample.split(/\r?\n/).filter(Boolean);
      let timestamped = 0;
      for (const line of lines) {
        if (probe.feed(line) !== null) timestamped++;
      }

      return {
        ok: lines.length > 0 && timestamped > 0,
        character: probe.selfName,
        server: probe.server,
        lines: lines.length,
        recognized: timestamped,
        stale: Date.now() - st.mtimeMs > STALE_LOG_MS,
        mtimeMs: st.mtimeMs,
        size: st.size,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * Empty the followed eqlog on disk.
   *
   * Safe for the overlay — the tailer notices the shrink, emits 'reset', and the parser
   * starts clean — and safe for the game, which appends per line. It is NOT safe for
   * anything else tailing the same file by byte position. GINA and GamParse both do, and
   * truncating under them leaves them reading from an offset past the end: silently dead
   * until restarted, with nothing on screen saying so. EQBuddy shipped that bug and then
   * fixed it; we can have the fix without the bug.
   *
   * Refused rather than warned-and-proceeded. The player can close the other tool and try
   * again in five seconds, and there is no undo for the alternative.
   */
  ipcMain.handle(CHANNELS.LOGS_CLEAR, async () => {
    if (!tailer?.filePath) return { ok: false, error: 'no log is being followed' };

    const holding = await runningReaders();
    if (holding.length > 0) {
      return {
        ok: false,
        blockedBy: holding,
        error: `${holding.join(' and ')} ${holding.length > 1 ? 'are' : 'is'} reading this ` +
          'log by position — emptying it now would leave them stuck past the end. ' +
          'Close them first.',
      };
    }

    try {
      await fs.promises.truncate(tailer.filePath, 0);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * What the client currently does about logging, and where that is written down.
   *
   * Read-only, so the settings form can say what the state is before offering to change
   * it. Every failure reads as "we cannot tell", never as "it is off": claiming a setting
   * is off when the file simply could not be found would send the player to fix something
   * that is not broken.
   */
  ipcMain.handle(CHANNELS.EQCONFIG_STATE, async () => {
    const iniPath = eqclientIniPath(tailer?.filePath ?? config.get('logPath'));
    if (!iniPath) return { ok: false, reason: 'no-path' };
    try {
      const text = await fs.promises.readFile(iniPath, 'latin1');
      return {
        ok: true,
        iniPath,
        logEnabled: isLogEnabled(text),
        gameRunning: (await runningReaders()).includes(GAME_PROCESS),
      };
    } catch (err) {
      return { ok: false, reason: 'unreadable', iniPath, error: err.message };
    }
  });

  /**
   * Set `Log=1` in the client's own settings, so `/log on` stops being a ritual.
   *
   * Three guards, in order, and each one is load-bearing:
   *
   *   1. The path is DERIVED from the log we were told to follow, never searched for. A
   *      function that writes to a path must not invent one.
   *   2. The game must not be running. EverQuest reads this file at startup and writes it
   *      back on exit, so editing it under a live client means the client overwrites us.
   *   3. The original is backed up once, before the first write, and never overwritten
   *      afterwards — so the backup is always the file as it was before this app first
   *      touched it, not as it was one edit ago.
   */
  ipcMain.handle(CHANNELS.EQCONFIG_ENABLE_LOG, async () => {
    const iniPath = eqclientIniPath(tailer?.filePath ?? config.get('logPath'));
    if (!iniPath) return { ok: false, error: 'could not work out where eqclient.ini lives' };

    if ((await runningReaders()).includes(GAME_PROCESS)) {
      return {
        ok: false,
        error: 'EverQuest is running. It rewrites this file when it exits, so close the ' +
          'game first or the change will be undone.',
      };
    }

    try {
      // latin1, like the logs: this is a file a Windows game wrote, and utf8 would mangle
      // any non-ASCII byte in a path or a comment on the way through.
      const before = await fs.promises.readFile(iniPath, 'latin1');
      const { text, changed, action } = setLogEnabled(before, true);
      if (!changed) return { ok: true, changed: false, action, iniPath };

      const backup = `${iniPath}.eqoverlay-backup`;
      // `wx` fails if it exists, which is exactly the behaviour wanted: the backup is the
      // file as it was before this app ever touched it.
      await fs.promises.writeFile(backup, before, { encoding: 'latin1', flag: 'wx' })
        .catch(() => {});

      await fs.promises.writeFile(iniPath, text, 'latin1');
      return { ok: true, changed: true, action, iniPath, backup };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle(CHANNELS.SETUP_COMPLETE, async (_e, patch) => {
    config.set(patch);
    await startTailing(config.get('logPath'));
    if (!overlayWindow) createOverlay();
    // First-run setup carries the same keys the settings form does, so the same
    // rebuilds apply — someone who switched the second screen on during setup must
    // not have to reopen settings to make it true.
    if (MOBILE_KEYS.some((key) => patch[key] !== undefined)) await syncMobileServer();
    setupWindow?.close();
    return config.all;
  });

  ipcMain.handle(CHANNELS.OPEN_SETTINGS, () => createSetup('settings'));

  /**
   * History, for the history window. The default key is whoever is being followed
   * right now, but every character with a file on disk is offered — reviewing last
   * night's raid on an alt while logged into the main is a real case.
   */
  ipcMain.handle(CHANNELS.HISTORY_LIST, (_e, key) => {
    const current = storeKey(parser?.selfName, parser?.server);
    const characters = history.characters();
    const selected = key ?? (characters.some((c) => c.key === current) ? current : characters[0]?.key);
    return {
      characters,
      selected: selected ?? null,
      encounters: selected ? history.list(selected) : [],
    };
  });

  ipcMain.handle(CHANNELS.HISTORY_GET, (_e, { key, id }) => history.get(key, id));

  ipcMain.handle(CHANNELS.HISTORY_CLEAR, (_e, key) => history.clear(key));

  // ---------------------------------------------------------------- sessions

  /**
   * Sessions, for the session window. Same shape as HISTORY_LIST and for the same
   * reasons — the default key is whoever is being followed, and every character with a
   * file on disk is offered.
   */
  ipcMain.handle(CHANNELS.SESSION_LIST, (_e, key) => {
    const current = sessionKey(parser?.selfName, parser?.server);
    const characters = sessionStore.characters();
    let selected = key ?? (characters.some((c) => c.key === current) ? current : characters[0]?.key);
    // A first night has no file yet, so `characters()` is empty and nothing would be
    // selected — which would hide the session in flight behind the very emptiness it
    // disproves. The tracked character is offered whether or not it has been written yet.
    if (!selected && session) selected = current;

    const sessions = selected ? sessionStore.list(selected) : [];
    const live = liveEntry(selected, current);
    // Newest first is the rail's order and the session in flight is always the newest, so
    // it goes on the front. The id guard is for the recovery path: a checkpoint that
    // outlived a crash is appended to the store on the next launch, and for the moment
    // both could name the same night, one row is the right number of rows.
    if (live && !sessions.some((s) => s.id === live.id)) sessions.unshift(live);

    return {
      characters,
      selected: selected ?? null,
      sessions,
      /** Which character the tracker is actually recording, so the rail can say so. */
      tracking: session ? current : null,
    };
  });

  /**
   * One session in full, with the fights that happened inside it.
   *
   * The combat block is JOINED from the encounter store on time rather than counted by
   * the session tracker. `src/session/` is a sibling of the combat parser precisely so it
   * never has to score damage — a second damage pipeline there would be a second answer
   * to one question, and the one on screen would be the wrong one. Both stores stamp real
   * timestamps, so joining them is a fact.
   *
   * The session in FLIGHT is served from here too, on the same path and with the same
   * combat join, because it is an ordinary row in the rail and deserves the ordinary
   * answer. It is not on disk, so the store misses and the tracker is asked instead — and
   * the ids line up by construction, both being `String(startTs)`, which is what lets the
   * row keep its identity through the moment the night ends and it becomes a stored record.
   */
  ipcMain.handle(CHANNELS.SESSION_GET, (_e, { key, id }) => {
    let record = sessionStore.get(key, id);
    if (!record) {
      const live = liveRecord(key, sessionKey(parser?.selfName, parser?.server));
      record = live && live.id === id ? live : null;
    }
    if (!record) return null;
    let combat = null;
    try {
      combat = combatBetween(
        history.records(storeKey(record.character, record.server)),
        record.startTs,
        record.endTs,
        { character: record.character },
      );
    } catch {
      // No encounter history for this character is not an error — the Combat row simply
      // says so, and every other category is unaffected.
    }
    return { record, combat };
  });

  ipcMain.handle(CHANNELS.SESSION_CLEAR, (_e, key) => sessionStore.clear(key));

  ipcMain.handle(CHANNELS.SESSION_OPEN, () => { createSession(); });

  // ------------------------------------------------------------------- quests

  ipcMain.handle(CHANNELS.QUESTS_GET, () => quests?.snapshot() ?? null);

  ipcMain.handle(CHANNELS.QUESTS_SET_OWNED, (_e, { ref, owned }) => {
    quests?.setOwned(String(ref), Boolean(owned));
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.QUESTS_SET_DONE, (_e, { ref, done }) => {
    quests?.setDone(String(ref), Boolean(done));
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.QUESTS_OPEN, () => { createQuests(); });

  /**
   * Import an eqlposky.com progress export.
   *
   * The report is the headline, exactly as it is for a GINA pack: an export is a dated
   * snapshot of what the site knew, so what crossed over — and as of when — is the only
   * honest thing to show. The store enforces the one-way rule (an import only ever SETS
   * flags); this handler just moves the file.
   */
  ipcMain.handle(CHANNELS.QUESTS_IMPORT, async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Import an eqlposky.com progress export',
      filters: [{ name: 'eqlposky progress export', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };

    let data;
    try {
      data = JSON.parse(fs.readFileSync(picked.filePaths[0], 'utf8'));
    } catch (err) {
      return { ok: false, error: `could not read the file: ${err.message}` };
    }
    const result = quests?.applyImport(data) ?? { ok: false, error: 'no character yet' };
    if (result.ok) notifyQuestsChanged();
    return result;
  });

  /**
   * Replay a log file into the session store.
   *
   * The whole point is that this is reachable without a terminal. A player who has been
   * running the game for weeks before installing this has all of it in their eqlog, and
   * the parser can read it — it just could not, before, be asked to.
   *
   * A private tracker is used rather than the live one: importing must not disturb the
   * session in flight, and the imported log may be a different character entirely. The
   * store's own id dedup makes re-importing the same file a no-op rather than a doubling.
   */
  ipcMain.handle(CHANNELS.SESSION_IMPORT, async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Import a log file',
      defaultPath: config.get('logDir') ?? DEFAULT_LOG_DIR,
      filters: [{ name: 'EverQuest logs', extensions: ['txt'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };

    try {
      return { ok: true, ...importSessionLog(picked.filePaths[0]) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---------------------------------------------------------------- clipboard

  /**
   * The overlay's COPY button, landing.
   *
   * Main owns the write because Electron's main-process `clipboard` has none of the
   * conditions the renderer's `navigator.clipboard` does — no focused document, no user
   * gesture — and the overlay is a transparent, always-on-top, click-through window that
   * satisfies neither.
   *
   * An empty or non-string payload writes NOTHING and says so. The clipboard already
   * holds something the player put there, and clearing it on a button that failed to
   * build a line is a worse outcome than the button doing nothing.
   */
  ipcMain.handle(CHANNELS.CLIPBOARD_COPY, (_e, text) => {
    if (typeof text !== 'string' || text.trim() === '') return { ok: false };
    clipboard.writeText(text);
    return { ok: true };
  });

  /**
   * The renderer measured its content and wants the window to match.
   *
   * While the breakdown is closed only the height moves, capped at 80% of the work
   * area — width and position stay the player's. While it is open the window may
   * borrow BOTH dimensions up to the full work area: the panel promises every ability
   * with its name whole, and this window cannot scroll, so a promise without room on
   * screen is content silently gone. Everything borrowed is returned, to exactly the
   * resting bounds, on the close message.
   *
   * The renderer sends measurements (`height`, `extraWidth`, `panelOpen`), never
   * bounds: main alone knows the resting position, the display and the clamps. Width
   * grows from the CURRENT width — after a grow the renderer's shortfall reads zero,
   * and computing from resting would snap the window back mid-hover.
   */
  ipcMain.on(CHANNELS.FIT_WINDOW, (_e, spec) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const { height, extraWidth = 0, panelOpen = false } = spec ?? {};

    const bounds = overlayWindow.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const contentDelta = bounds.height - overlayWindow.getContentBounds().height;
    const nextH = clampHeight(height, area, { panelOpen }) + contentDelta;

    if (restingY === null) restingY = bounds.y;
    if (restingX === null) restingX = bounds.x;
    if (restingWidth === null) restingWidth = bounds.width;

    const nextW = panelOpen
      ? clampWidth(bounds.width + extraWidth, area, { minWidth: restingWidth })
      : restingWidth;

    // Down-and-right from the resting position when there is room, edge-anchored when
    // there is not — in which case the renderer draws the panel above the rows so they
    // hold still under the cursor.
    const { x, y, above } = placeWindow({
      restingX, restingY, width: nextW, height: nextH, area,
    });

    overlayWindow.webContents.send(CHANNELS.PANEL_SIDE, above ? 'above' : 'below');

    if (
      Math.abs(bounds.height - nextH) < 3 &&
      Math.abs(bounds.width - nextW) < 3 &&
      bounds.y === y &&
      bounds.x === x
    ) return;

    // Our own move, not the player's — `remember` must not mistake it for a reposition.
    lastFitY = y;
    lastFitX = x;
    lastFitWidth = nextW;
    overlayWindow.setBounds({ x, y, width: nextW, height: nextH }, false);
  });

  ipcMain.on(CHANNELS.TOGGLE_LOCK, toggleLock);
  ipcMain.on(CHANNELS.TOGGLE_METRIC, toggleMetric);
  ipcMain.on(CHANNELS.RESET_ENCOUNTER, resetEncounter);
  ipcMain.on(CHANNELS.CLOSE_WINDOW, () => app.quit());
  ipcMain.on('open-external', (_e, url) => shell.openExternal(url));
}
