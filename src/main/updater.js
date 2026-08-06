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

/** Sessions run for hours; a launch-only check would miss a release cut mid-raid. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Let the tailer, windows and first snapshots settle before touching the network. */
export const STARTUP_DELAY_MS = 10_000;

export const RELEASES_URL = 'https://github.com/jsavko/eq-legends-dps-overlay/releases/latest';

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
 * @returns {Promise<() => void>} stop function — clears the recurring check
 */
export async function startUpdater({ mode, toast }) {
  if (mode === 'off') return () => {};

  const { default: electronUpdater } = await import('electron-updater');
  const { autoUpdater } = electronUpdater;

  // Where to look is baked into app-update.yml at build time from `build.publish`, so
  // there is no feed URL and no token here — the releases repo is public.
  autoUpdater.autoDownload = mode === 'auto';
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.warn('[updater]', err?.message ?? err);
  });

  if (mode === 'auto') {
    autoUpdater.on('update-downloaded', (info) => {
      // Deliberately a meter toast, not a cast-alert chip: the alerts window is for
      // combat warnings the player must react to right now, and it floats top-center
      // over the game. An update notice is not that.
      toast(`v${info.version} downloaded — installs when you quit`, 12_000);
    });
  } else {
    autoUpdater.on('update-available', (info) => {
      toast(`v${info.version} is out — grab it from the GitHub releases page`, 15_000);
    });
  }

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[updater] check failed:', err?.message ?? err);
    });
  };

  const startupTimer = setTimeout(check, STARTUP_DELAY_MS);
  const interval = setInterval(check, CHECK_INTERVAL_MS);

  return () => {
    clearTimeout(startupTimer);
    clearInterval(interval);
  };
}
