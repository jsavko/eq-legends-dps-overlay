/**
 * Electron main process: owns the parser, the tailer, both windows and the hotkeys.
 *
 * The renderers are pure views. Every piece of state lives here and is pushed to them
 * at a fixed rate (see ipc.js), which keeps a busy raid from turning into an IPC storm.
 */

import {
  app, BrowserWindow, globalShortcut, ipcMain, dialog, screen, shell, Tray, Menu, nativeImage,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LogParser } from '../parser/index.js';
import { Tailer, listLogs } from './tailer.js';
import { ConfigStore, DEFAULT_LOG_DIR, ALERT_KEYS, alertsEnabled } from './config.js';
import { EncounterStore, RECORD_VERSION, storeKey } from './history.js';
import { RhythmStore } from './rhythms.js';
import { CHANNELS, PUSH_INTERVAL_MS } from './ipc.js';
import { clampHeight, clampWidth, placeWindow } from './layout.js';
import { startUpdater, updateMode } from './updater.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(HERE, '..', 'renderer');
const ASSETS = path.join(HERE, '..', 'assets');

/** A log not written to in this long is probably a session where /log was never enabled. */
const STALE_LOG_MS = 10 * 60 * 1000;

/** @type {BrowserWindow|null} */ let overlayWindow = null;
/** @type {BrowserWindow|null} */ let setupWindow = null;
/** @type {BrowserWindow|null} */ let historyWindow = null;
/** @type {BrowserWindow|null} */ let alertsWindow = null;
/** @type {LogParser|null} */    let parser = null;
/** @type {Tailer|null} */       let tailer = null;
/** @type {ConfigStore|null} */  let config = null;
/** @type {Tray|null} */         let tray = null;
/** @type {EncounterStore|null} */ let history = null;
/** @type {RhythmStore|null} */   let rhythmStore = null;

let pushTimer = null;
let stopUpdater = null;
let lastRevision = -1;
let overlayVisible = true;
let saveBoundsTimer = null;
let saveHistoryBoundsTimer = null;
let saveAlertsBoundsTimer = null;
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
  rhythmStore = new RhythmStore(path.join(app.getPath('userData'), 'rhythms'), loadBaselineRhythms());

  registerIpc();
  createTray();

  if (config.isConfigured()) {
    await startTailing(config.get('logPath'));
    createOverlay();
    // One window, four switches: it exists if ANY category is on and mute is off.
    if (alertsEnabled(config.all)) createAlerts();
  } else {
    createSetup('setup');
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlay();
  });

  // Last, and never awaited: an updater that cannot start — no network, a tree without
  // the dependency installed — must not stand between the player and their overlay.
  const mode = updateMode({ isPackaged: app.isPackaged, exePath: process.execPath, env: process.env });
  startUpdater({ mode, toast })
    .then((stop) => { stopUpdater = stop; })
    .catch((err) => { console.warn('[updater] failed to start:', err?.message ?? err); });
}

// Deliberately NOT quitting here: the tray is the app's home, and closing the settings
// window while the overlay is hidden should leave it running, reachable from the tray.
app.on('window-all-closed', () => {});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  tailer?.stop();
  clearInterval(pushTimer);
  clearInterval(hoverTimer);
  stopUpdater?.();
  tray?.destroy();
});

// ---------------------------------------------------------------------------
// Parser + tailer
// ---------------------------------------------------------------------------

async function startTailing(logPath) {
  tailer?.stop();

  parser = new LogParser({
    logFilename: path.basename(logPath),
    ...config.parserOptions(),
    onEncounterEnd: persistEncounter,
    onRhythmsLearned: persistRhythms,
    onPetOwnersChanged: persistPetOwners,
  });
  provideKnownRhythms();

  tailer = new Tailer({
    filePath: logPath,
    watchDirectory: config.get('autoSwitchCharacter'),
  });

  tailer.on('lines', (lines) => {
    for (const line of lines) parser.feed(line);
  });

  tailer.on('switch', ({ to, character }) => {
    // A different character means a different group and a different set of totals.
    parser.setLogFilename(path.basename(to));
    parser.reset();
    // The server may have changed with the character, and rhythms are per server.
    provideKnownRhythms();
    config.set({ logPath: to });
    toast(`Now following ${character}`);
    refreshTrayMenu();
    pushStatus();
  });

  tailer.on('reset', ({ reason }) => {
    // The log was rotated or truncated; anything in flight refers to bytes that are gone.
    parser.reset();
    toast(reason === 'truncated' ? 'Log truncated — restarting' : 'Log replaced — restarting');
  });

  tailer.on('error', (err) => {
    toast(`Log error: ${err.message}`);
  });

  await tailer.start();
  startPushLoop();
  refreshTrayMenu();
}

/**
 * Persist a closed encounter to the history store.
 *
 * The snapshot is built UNFILTERED — no group-only narrowing — so the record holds
 * everything the fight contained; the history browser applies view-time filters.
 * Encounters with no damage in either direction are skipped: they are phantom opens
 * (a stray engage with nothing behind it), not fights anyone would want to review.
 * A manual reset never reaches here at all — the parser's onEncounterEnd contract.
 */
function persistEncounter(enc) {
  if (!history || !parser) return;
  try {
    const snap = enc.snapshot(enc.endTs);
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

/**
 * Boss rhythms shipped with the app: measured from real session logs by
 * scripts/seed-rhythms.js and copied into src/main/baseline-rhythms.json — never
 * hand-written numbers. A missing or damaged file just means no baselines.
 */
function loadBaselineRhythms() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'baseline-rhythms.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Persist a closing fight's learned boss rhythms.
 *
 * Same failure posture as history: the store is a convenience, and a full disk must
 * not take the live overlay down — or even interrupt the fight report.
 */
function persistRhythms(learned) {
  if (!rhythmStore || !parser) return;
  try {
    rhythmStore.merge(parser.server, learned, Date.now());
  } catch (err) {
    toast(`Rhythm save failed: ${err.message}`);
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

/** Hand the parser what previous fights on this server taught. */
function provideKnownRhythms() {
  if (!rhythmStore || !parser) return;
  try {
    parser.setKnownRhythms(rhythmStore.knownFor(parser.server));
  } catch {
    parser.setKnownRhythms([]);
  }
}

/**
 * Push a snapshot to the overlay on a fixed cadence.
 *
 * The parser is also ticked here so an encounter times out during a lull, when no log
 * lines are arriving to advance its clock.
 */
function startPushLoop() {
  clearInterval(pushTimer);
  pushTimer = setInterval(() => {
    if (!parser || !overlayWindow || overlayWindow.isDestroyed()) return;
    parser.tick();

    // A running encounter's elapsed time changes every tick even when the revision
    // has not, so only a closed, unchanged encounter can skip the push.
    const snapshot = parser.snapshot();
    if (parser.revision === lastRevision && !snapshot.active) return;
    lastRevision = parser.revision;

    overlayWindow.webContents.send(CHANNELS.SNAPSHOT, snapshot);
    if (alertsWindow && !alertsWindow.isDestroyed()) {
      alertsWindow.webContents.send(CHANNELS.SNAPSHOT, snapshot);
    }
  }, PUSH_INTERVAL_MS);
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
    {
      label: 'Reset encounter',
      accelerator: keys.resetEncounter,
      click: () => { parser?.reset(); toast('Encounter reset'); },
    },
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
        alertToggle('Summon announcements', 'summonAlerts'),
        alertToggle('Crowd control on the group', 'ccAlerts'),
        alertToggle('Boss spell timers', 'castTimers'),
        { type: 'separator' },
        {
          ...alertToggle('Sound for interrupt warnings', 'castAlertSound'),
          // A beep for a warning that isn't drawn is a noise with no explanation.
          enabled: config.get('castAlerts') !== false,
        },
      ],
    },
    { type: 'separator' },
    // "Show me past fights" is a destination people look for by name, so it gets its
    // own window and its own menu item rather than hiding inside settings.
    { label: 'History…', click: createHistory },
    { label: 'Settings…', click: () => createSetup('settings') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
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

/**
 * Push the current config to every window that listens for it.
 *
 * The alert window gates each category at render time, so a toggle only takes effect
 * when this lands — which is what makes a tray checkbox flip chips off mid-fight.
 */
function broadcastConfig(cfg) {
  for (const win of [overlayWindow, alertsWindow, setupWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.CONFIG_CHANGED, cfg);
  }
}

/** Flip one alert setting from the tray: persist, resync the window, redraw the menu. */
function setAlertOption(patch) {
  const after = config.set(patch);
  syncAlertsWindow();
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
  // reposition the warnings too, and a separate second hotkey would just be a thing
  // to forget.
  if (alertsWindow && !alertsWindow.isDestroyed()) {
    alertsWindow.setIgnoreMouseEvents(locked);
    alertsWindow.webContents.send(CHANNELS.LOCK_CHANGED, locked);
  }
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
  refreshTrayMenu();
  toast(locked ? 'Overlay locked' : 'Overlay unlocked — drag to move');
}

function toggleVisible() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayVisible = !overlayVisible;
  if (overlayVisible) {
    overlayWindow.showInactive();   // show without stealing focus from the game
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    if (alertsWindow && !alertsWindow.isDestroyed()) {
      alertsWindow.showInactive();
      alertsWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  } else {
    overlayWindow.hide();
    alertsWindow?.hide();
  }
  refreshTrayMenu();
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
  bind(keys.resetEncounter, () => {
    parser?.reset();
    toast('Encounter reset');
  }, 'reset');
  bind(keys.toggleMetric, toggleMetric, 'damage/healing');
  bind(keys.toggleAlerts, toggleAlerts, 'mute alerts');
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
  overlayWindow?.webContents.send(CHANNELS.TOAST, { message, ms });
}

function pushStatus() {
  if (!overlayWindow || overlayWindow.isDestroyed() || !tailer) return;
  let stale = false;
  try {
    stale = Date.now() - fs.statSync(tailer.filePath).mtimeMs > STALE_LOG_MS;
  } catch {
    stale = true;
  }
  overlayWindow.webContents.send(CHANNELS.STATUS, {
    logPath: tailer.filePath,
    character: tailer.character,
    stale,
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

  ipcMain.handle(CHANNELS.CONFIG_SET, async (_e, patch) => {
    const before = config.all;
    const after = config.set(patch);

    if (patch.hotkeys) registerHotkeys();
    if (patch.groupOnly !== undefined) parser?.setGroupOnly(patch.groupOnly);
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
    if (patch.logPath && patch.logPath !== before.logPath) {
      await startTailing(patch.logPath);
    }
    // Any of the four categories, or the mute, can be what brings the window into or
    // out of existence — the predicate decides, not the individual key.
    if (ALERT_KEYS.some((key) => patch[key] !== undefined)) syncAlertsWindow();

    broadcastConfig(after);
    // The tray carries the same switches as the settings form, so a change made in
    // one has to redraw the other — without this the checkmarks quietly go stale.
    refreshTrayMenu();
    pushStatus();
    return after;
  });

  ipcMain.handle(CHANNELS.PETS_STATE, () => ({
    mapped: parser?.petMappings() ?? [],
    unmapped: parser?.unmappedEntities() ?? [],
  }));

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
   * Empty the followed eqlog on disk. Safe while the game runs — EQ appends per
   * line, and truncation is the classic way players manage these files — and safe
   * for the overlay: the tailer notices the shrink, emits 'reset', and the parser
   * starts clean. Encounter history is untouched; persisting fights is exactly what
   * makes clearing the raw log a loss of nothing.
   */
  ipcMain.handle(CHANNELS.LOGS_CLEAR, async () => {
    if (!tailer?.filePath) return { ok: false, error: 'no log is being followed' };
    try {
      await fs.promises.truncate(tailer.filePath, 0);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle(CHANNELS.SETUP_COMPLETE, async (_e, patch) => {
    config.set(patch);
    await startTailing(config.get('logPath'));
    if (!overlayWindow) createOverlay();
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
  ipcMain.on(CHANNELS.RESET_ENCOUNTER, () => {
    parser?.reset();
    toast('Encounter reset');
  });
  ipcMain.on(CHANNELS.CLOSE_WINDOW, () => app.quit());
  ipcMain.on('open-external', (_e, url) => shell.openExternal(url));
}
