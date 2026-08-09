/**
 * Self-update, tiered by how this copy is actually running.
 *
 * Every release ships two artifacts from one build — an NSIS installer and a portable
 * exe — and only one of them can update itself. A single self-contained exe has no
 * install location to replace, which is exactly why electron-builder's `portable`
 * target is unsupported by electron-updater. Rather than pick one artifact or lie to
 * the other, the mode is decided at runtime from where the exe is sitting:
 *
 *   'auto'   — installed by the NSIS setup under %LOCALAPPDATA%\Programs. Download in
 *              the background, install on quit. The overlay is mid-raid by assumption,
 *              so it is never restarted and never asked to be.
 *   'notify' — launched from the portable exe. Check only, then say a new version
 *              exists and where to get it. Honest about what a lone exe can do, and
 *              nobody sits on a stale build without knowing.
 *   'off'    — anything else: `npm start` in dev, and the `win-unpacked` directory
 *              James launches himself. Left alone deliberately — win-unpacked is
 *              packaged but not installed, so "updating" it would silently install a
 *              SECOND copy into %LOCALAPPDATA%\Programs and leave the running one stale.
 *
 * The electron-updater import is dynamic so the mode logic above can be unit-tested in
 * WSL: electron-updater reaches for `electron` at load time and throws outside it.
 */

import fs from 'node:fs';

/** Sessions run for hours; a launch-only check would miss a release cut mid-raid. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Let the tailer, windows and first snapshots settle before touching the network. */
export const STARTUP_DELAY_MS = 10_000;

export const RELEASES_URL = 'https://github.com/jsavko/eq-legends-dps-overlay/releases/latest';

/**
 * The releases API, for the check the player asks for by hand.
 *
 * Deliberately NOT electron-updater. A manual check has to answer in every mode, including
 * `off` — which is the mode the `win-unpacked` build runs in, and therefore the one the
 * person most likely to press the button is using. electron-updater in that mode has no
 * install to reason about and is not started at all, so asking GitHub directly is the only
 * answer that works everywhere. It also cannot install anything, which is exactly right:
 * pressing a menu item should tell you something, not start replacing files.
 */
export const RELEASES_API =
  'https://api.github.com/repos/jsavko/eq-legends-dps-overlay/releases/latest';

/** Past this the update log is started fresh. Bounded without rotation machinery. */
const LOG_MAX_BYTES = 256 * 1024;

/**
 * A logger for electron-updater that writes to a file instead of a console nobody sees.
 *
 * electron-updater's default logger is `console`, and a packaged Windows app has no console
 * — so everything it knows went nowhere. That included the one line that answers the
 * question this file cannot otherwise answer:
 *
 *   Full: 78.3 MB, To download: 3.1 MB (4%)
 *
 * which is the differential downloader reporting what it actually fetched. Without it,
 * "why was the update the full size" and "was it differential at all" are unanswerable
 * after the fact, and the same blindness made "I don't think the updater works" impossible
 * to settle without cutting a release to watch.
 *
 * Appends, and starts fresh past a quarter-megabyte so a long-running install cannot grow
 * it without bound. Every write is wrapped: a logger that throws would take down the
 * updater it is only supposed to describe, which is the wrong way round.
 *
 * @param {string} file  absolute path to write to
 */
export function fileLogger(file) {
  const write = (level, args) => {
    try {
      const line = args
        .map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* first write */ }
      const stamp = new Date().toISOString();
      if (size > LOG_MAX_BYTES) fs.writeFileSync(file, `${stamp} [log restarted]\n`);
      fs.appendFileSync(file, `${stamp} ${level} ${line}\n`);
    } catch {
      // A full disk, a locked file, a directory that vanished. None of them are reasons to
      // stop updating; the log is a convenience and the updater is the feature.
    }
  };
  return {
    info: (...a) => write('info ', a),
    warn: (...a) => write('warn ', a),
    error: (...a) => write('error', a),
    debug: (...a) => write('debug', a),
  };
}

/** "v0.8.0" / "0.8.0-beta.1" -> [0, 8, 0]. Anything unparseable degrades to a zero. */
function versionParts(v) {
  const core = String(v ?? '').trim().replace(/^v/i, '').split(/[-+]/)[0];
  return core.split('.').map((n) => Number.parseInt(n, 10) || 0);
}

/**
 * Is `latest` a higher version than `current`?
 *
 * Numeric field-by-field, so "0.10.0" beats "0.9.0" — a string compare would get that
 * backwards, and it is the first comparison this project will actually face. Pre-release
 * suffixes are ignored rather than ordered: nothing here ships them, and a wrong guess
 * about `-beta` ordering would announce phantom updates.
 */
export function isNewerVersion(latest, current) {
  const a = versionParts(latest);
  const b = versionParts(current);
  for (let i = 0; i < Math.max(a.length, b.length, 3); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Ask GitHub for the newest published release.
 *
 * `fetchImpl` is injected so this is testable in WSL against a stub — the real one is the
 * global `fetch`, which Electron and Node both have, so this adds no dependency. Draft and
 * pre-release entries are excluded by the API's own `/latest`, so what comes back is what a
 * player would actually be offered.
 *
 * @returns {Promise<string>} the version with no leading "v"
 */
export async function fetchLatestVersion({ fetchImpl, url = RELEASES_API } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('no fetch available');

  const res = await doFetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      // GitHub rejects API requests with no agent, and a nameless 403 in a toast is
      // indistinguishable from being offline.
      'User-Agent': 'eq-legends-dps-overlay',
    },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);

  const body = await res.json();
  const tag = body?.tag_name ?? body?.name;
  if (!tag) throw new Error('the release has no tag');
  return String(tag).trim().replace(/^v/i, '');
}

/**
 * Which update behavior this process has earned.
 *
 * @param {object} opts
 * @param {boolean} opts.isPackaged   app.isPackaged — false for `npm start`
 * @param {string} opts.exePath       process.execPath
 * @param {Record<string,string|undefined>} [opts.env]  process.env
 * @returns {'auto'|'notify'|'off'}
 */
export function updateMode({ isPackaged, exePath, env = {} }) {
  if (!isPackaged) return 'off';

  // electron-builder's portable launcher extracts to a temp directory and hands the
  // real exe's path down in the environment — the only reliable way to know a portable
  // run from the inside, since the extracted copy looks like any other unpacked build.
  if (env.PORTABLE_EXECUTABLE_FILE) return 'notify';

  // The per-user NSIS default (`oneClick`, `perMachine: false`) installs here, and only
  // an install that lives here can be replaced by the updater.
  const normalized = String(exePath ?? '').replace(/\//g, '\\').toLowerCase();
  if (normalized.includes('\\appdata\\local\\programs\\')) return 'auto';

  return 'off';
}

/**
 * Start checking for updates, if this copy is one that should.
 *
 * Check failures — offline, GitHub rate limit, a release mid-upload — go to the console
 * and nowhere else. A toast per failed check would nag through a raid about something
 * the player cannot act on, and the next check is at most four hours away.
 *
 * @param {object} opts
 * @param {'auto'|'notify'|'off'} opts.mode
 * @param {(message: string, ms?: number) => void} opts.toast
 * @param {(notice: {version: string, ready: boolean}) => void} [opts.onUpdate]
 *   Called when a release newer than this copy is seen. `ready` means it is downloaded and
 *   waiting for the quit; false means it exists and this copy cannot fetch it itself. Main
 *   uses it to put a standing notice in the overlay footer — a toast is gone in twelve
 *   seconds, and "there is a newer version" stays true until you act on it.
 * @returns {Promise<{stop: () => void, check: () => void}>}
 *   `check` runs the background updater's own check immediately, so the tray item can start
 *   a download rather than only reporting that one is available.
 */
export async function startUpdater({ mode, toast, onUpdate, logPath, version }) {
  const log = logPath ? fileLogger(logPath) : null;
  // Written even in `off` mode, and first: "which copy is this, and is the updater running
  // at all" is the opening question of every update problem, and `off` is the answer that
  // surprises people.
  log?.info(`--- launch: v${version ?? '?'}, mode ${mode} ---`);

  if (mode === 'off') {
    log?.info('this copy does not self-update (not installed under Programs)');
    return { stop: () => {}, check: () => {} };
  }

  const { default: electronUpdater } = await import('electron-updater');
  const { autoUpdater } = electronUpdater;

  // The whole reason the log exists: electron-updater's own reporting, including the
  // differential downloader's "Full: X, To download: Y (Z%)".
  if (log) autoUpdater.logger = log;

  // Where to look is baked into app-update.yml at build time from `build.publish`, so
  // there is no feed URL and no token here — the releases repo is public.
  autoUpdater.autoDownload = mode === 'auto';
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.warn('[updater]', err?.message ?? err);
  });

  // Registered in BOTH modes: knowing a newer version exists is what the footer notice is
  // for, and in `auto` this fires before the download finishes — so the player learns at
  // the earliest honest moment rather than at the end of an 80 MB transfer.
  autoUpdater.on('update-available', (info) => {
    onUpdate?.({ version: info.version, ready: false });
    if (mode !== 'auto') {
      toast(`v${info.version} is out — grab it from the GitHub releases page`, 15_000);
    }
  });

  if (mode === 'auto') {
    // Bytes actually moved, recorded next to electron-updater's own differential line so
    // "how big was the update really" has an answer after the fact rather than a guess.
    let lastLoggedPercent = -1;
    autoUpdater.on('download-progress', (p) => {
      const percent = Math.floor(p.percent / 25) * 25;
      if (percent === lastLoggedPercent) return;
      lastLoggedPercent = percent;
      log?.info(`download ${Math.round(p.percent)}% — ` +
        `${(p.transferred / 1048576).toFixed(1)} of ${(p.total / 1048576).toFixed(1)} MB`);
    });

    autoUpdater.on('update-downloaded', (info) => {
      onUpdate?.({ version: info.version, ready: true });
      // Deliberately a meter toast, not a cast-alert chip: the alerts window is for
      // combat warnings the player must react to right now, and it floats top-center
      // over the game. An update notice is not that.
      toast(`v${info.version} downloaded — installs when you quit`, 12_000);
    });
  }

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[updater] check failed:', err?.message ?? err);
    });
  };

  const startupTimer = setTimeout(check, STARTUP_DELAY_MS);
  const interval = setInterval(check, CHECK_INTERVAL_MS);

  return {
    stop: () => {
      clearTimeout(startupTimer);
      clearInterval(interval);
    },
    check,
  };
}
