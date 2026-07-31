/**
 * Electron main process: owns the parser, the tailer, both windows and the hotkeys.
 *
 * The renderers are pure views. Every piece of state lives here and is pushed to them
 * at a fixed rate (see ipc.js), which keeps a busy raid from turning into an IPC storm.
 */

import { app, BrowserWindow, globalShortcut, ipcMain, dialog, screen, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LogParser } from '../parser/index.js';
import { Tailer, listLogs } from './tailer.js';
import { ConfigStore, DEFAULT_LOG_DIR } from './config.js';
import { CHANNELS, PUSH_INTERVAL_MS } from './ipc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(HERE, '..', 'renderer');

/** A log not written to in this long is probably a session where /log was never enabled. */
const STALE_LOG_MS = 10 * 60 * 1000;

/** @type {BrowserWindow|null} */ let overlayWindow = null;
/** @type {BrowserWindow|null} */ let setupWindow = null;
/** @type {LogParser|null} */    let parser = null;
/** @type {Tailer|null} */       let tailer = null;
/** @type {ConfigStore|null} */  let config = null;

let pushTimer = null;
let lastRevision = -1;
let overlayVisible = true;
/** Set while the cursor is over an interactive part of the overlay. */
let hoverHold = false;
let saveBoundsTimer = null;

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

  registerIpc();

  if (config.isConfigured()) {
    await startTailing(config.get('logPath'));
    createOverlay();
  } else {
    createSetup('setup');
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlay();
  });
}

// macOS convention does not apply: this is a Windows game overlay, so closing the
// last window means the user is done.
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  tailer?.stop();
  clearInterval(pushTimer);
});

// ---------------------------------------------------------------------------
// Parser + tailer
// ---------------------------------------------------------------------------

async function startTailing(logPath) {
  tailer?.stop();

  parser = new LogParser({
    logFilename: path.basename(logPath),
    ...config.parserOptions(),
  });

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
    config.set({ logPath: to });
    toast(`Now following ${character}`);
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
    // Not focusable while locked, so that hovering a row for the breakdown can enable
    // mouse events without a stray click pulling focus out of the game.
    focusable: !config.get('locked'),
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
    pushStatus();
  });

  const remember = () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        config.set({ bounds: overlayWindow.getBounds() });
      }
    }, 400);
  };
  overlayWindow.on('moved', remember);
  // Only remember a resize the player made. Auto-fit resizes fire this too, and
  // persisting those would rewrite config.json every time a row appeared.
  overlayWindow.on('resized', () => { if (!config.get('locked')) remember(); });
  overlayWindow.on('closed', () => { overlayWindow = null; });

  registerHotkeys();
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
    // Closing the first-run screen without choosing a log leaves nothing to show.
    if (!config.isConfigured() && !overlayWindow) app.quit();
  });
}

// ---------------------------------------------------------------------------
// Lock / visibility
// ---------------------------------------------------------------------------

/**
 * Locked: click-through, not focusable, not draggable — the game gets every click.
 * Unlocked: a normal interactive window that can be dragged and resized.
 */
function applyLock(locked) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  if (locked && !hoverHold) {
    // forward:true still delivers mousemove to the renderer, which is what lets a
    // hovered row ask for mouse events back.
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    overlayWindow.setIgnoreMouseEvents(false);
  }
  overlayWindow.setFocusable(!locked);
  overlayWindow.webContents.send(CHANNELS.LOCK_CHANGED, locked);
}

function toggleLock() {
  const locked = !config.get('locked');
  config.set({ locked });
  hoverHold = false;
  applyLock(locked);
  toast(locked ? 'Overlay locked' : 'Overlay unlocked — drag to move');
}

function toggleVisible() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayVisible = !overlayVisible;
  if (overlayVisible) {
    overlayWindow.showInactive();   // show without stealing focus from the game
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  } else {
    overlayWindow.hide();
  }
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
}

/** Flip the overlay between ranking by damage and ranking by healing. */
function toggleMetric() {
  const metric = config.get('metric') === 'healing' ? 'damage' : 'healing';
  config.set({ metric });
  overlayWindow?.webContents.send(CHANNELS.CONFIG_CHANGED, config.all);
  toast(metric === 'healing' ? 'Showing healing' : 'Showing damage');
}

// ---------------------------------------------------------------------------
// Pushes to the renderer
// ---------------------------------------------------------------------------

function toast(message) {
  overlayWindow?.webContents.send(CHANNELS.TOAST, { message });
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

    overlayWindow?.webContents.send(CHANNELS.CONFIG_CHANGED, after);
    pushStatus();
    return after;
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

  ipcMain.handle(CHANNELS.SETUP_COMPLETE, async (_e, patch) => {
    config.set(patch);
    await startTailing(config.get('logPath'));
    if (!overlayWindow) createOverlay();
    setupWindow?.close();
    return config.all;
  });

  ipcMain.handle(CHANNELS.OPEN_SETTINGS, () => createSetup('settings'));

  /**
   * The renderer asks for mouse events back while the cursor is over a row, so the
   * hover breakdown can be read, and gives them up again on mouseleave.
   */
  ipcMain.on(CHANNELS.SET_IGNORE_MOUSE, (_e, ignore) => {
    hoverHold = !ignore;
    applyLock(config.get('locked'));
  });

  /**
   * The renderer measured its content and wants the window to match.
   *
   * Only the height moves — width and position are the player's to choose — and the
   * result is clamped so a raid-sized roster cannot grow the window off the screen.
   */
  ipcMain.on(CHANNELS.FIT_HEIGHT, (_e, height) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (!config.get('locked')) return;

    const maxHeight = Math.floor(screen.getPrimaryDisplay().workAreaSize.height * 0.8);
    const target = Math.max(70, Math.min(Math.round(height), maxHeight));
    const bounds = overlayWindow.getBounds();
    const contentDelta = bounds.height - overlayWindow.getContentBounds().height;

    if (Math.abs(bounds.height - (target + contentDelta)) < 3) return;
    overlayWindow.setBounds({ ...bounds, height: target + contentDelta }, false);
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
