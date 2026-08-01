/**
 * Persistent settings, stored as JSON in the Electron userData directory.
 *
 * The store takes its directory as a constructor argument rather than importing
 * `app` itself, so it can be unit-tested against a temp dir with no Electron present.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Where the Daybreak launcher installs EverQuest Legends by default. */
export const DEFAULT_LOG_DIR =
  'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends\\Logs';

export const DEFAULTS = {
  /** Absolute path to the eqlog_*.txt being followed; null forces the setup screen. */
  logPath: null,
  logDir: DEFAULT_LOG_DIR,
  /** Follow the player to a different character automatically. */
  autoSwitchCharacter: true,

  /** Seconds without damage before the encounter is considered over. */
  combatTimeoutSec: 15,
  /** Seconds to wait after the last engaged mob dies before closing. */
  postKillGraceSec: 3,
  rollingWindowSec: 10,

  /** Show only confirmed group members, versus every player the log sees. */
  groupOnly: false,
  /** Fold pet damage into the owner's row (v1 always does; false is not yet wired). */
  mergePets: true,

  /**
   * Named summoned pets and who owns them, e.g. { "Gann": "Rhain" }.
   *
   * Pets written `` <Owner>`s warder `` need no entry — the name says who owns them.
   * Summoned pets get a proper name that is indistinguishable from a player's, and the
   * log never says whose they are, so those go here. Your own named pet is detected
   * automatically when it reports to you as "Master".
   */
  petOwners: {},

  /** Which metric the overlay ranks by: 'damage' or 'healing'. */
  metric: 'damage',

  /**
   * Whether the "where the controls live" hint has been shown.
   *
   * The overlay is frameless and stays out of the taskbar, and Windows 11 files new tray
   * icons into the hidden overflow — so without a nudge on first run there is nothing on
   * screen telling you how to reach settings or quit.
   */
  seenTrayHint: false,

  opacity: 0.85,
  scale: 1,
  /** Click-through and undraggable. Unlocked lets the window be moved and resized. */
  locked: true,
  /** Overlay window position and size; null until the user moves it. */
  bounds: null,

  hotkeys: {
    toggleLock: 'Control+Shift+L',
    toggleVisible: 'Control+Shift+H',
    resetEncounter: 'Control+Shift+R',
    toggleMetric: 'Control+Shift+M',
  },
};

export class ConfigStore {
  /** @param {string} dir directory to hold config.json (Electron's userData) */
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    this.data = { ...DEFAULTS };
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = merge(DEFAULTS, JSON.parse(raw));
    } catch {
      // Missing or corrupt config is not an error — the defaults are the answer, and
      // a corrupt file gets overwritten on the next save rather than blocking startup.
      this.data = { ...DEFAULTS };
    }
    return this.data;
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    return this.data;
  }

  get all() {
    return this.data;
  }

  get(key) {
    return this.data[key];
  }

  /** Shallow-merge a patch and persist. Nested objects (hotkeys) merge one level deep. */
  set(patch) {
    this.data = merge(this.data, patch);
    this.save();
    return this.data;
  }

  /** True once a usable log file has been chosen — otherwise show the setup screen. */
  isConfigured() {
    return Boolean(this.data.logPath) && fs.existsSync(this.data.logPath);
  }

  /** Encounter tuning in the shape the parser wants (seconds -> ms). */
  parserOptions() {
    return {
      timeoutMs: this.data.combatTimeoutSec * 1000,
      postKillGraceMs: this.data.postKillGraceSec * 1000,
      rollingWindowMs: this.data.rollingWindowSec * 1000,
      groupOnly: this.data.groupOnly,
      petOwners: this.data.petOwners,
    };
  }
}

/**
 * Keys whose object value is replaced wholesale rather than merged.
 *
 * petOwners is a complete mapping, not a set of tweaks: merging it would make a
 * deleted pet entry impossible to remove, since the old key would survive every save.
 */
const REPLACE_KEYS = new Set(['petOwners']);

/** Merge `patch` over `base`, recursing one level into plain objects. */
function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!REPLACE_KEYS.has(k) &&
        v !== null && typeof v === 'object' && !Array.isArray(v) &&
        base[k] !== null && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = { ...base[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}
