/**
 * Persistent settings, stored as JSON in the Electron userData directory.
 *
 * The store takes its directory as a constructor argument rather than importing
 * `app` itself, so it can be unit-tested against a temp dir with no Electron present.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SESSION_CATEGORIES } from '../session/rules.js';
import { storeKey } from './history.js';

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

  /**
   * Exactly whose rows to show, PER CHARACTER, or empty for everyone the log sees.
   *
   * Keyed `<Character>_<server>`, the same key the history and session stores use, because
   * the answer is genuinely per character: the alt you take into a public zone wants a
   * different list from the one your main raids with, and a global list would silently
   * apply one to the other.
   *
   * An empty entry — or a character with no entry — means no filter at all, which is the
   * default. This replaced a `groupOnly` switch that filtered on membership the parser had
   * INFERRED from group join and leave lines, and which failed closed and silently: anyone
   * already in the group when logging began was never in that set, so the first join or
   * leave line by anybody else dropped them from the view with nothing on screen to say
   * why. A list the player picked can be read, checked and corrected. An inference cannot.
   * @type {Object<string, string[]>}
   */
  partyMembers: {},
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

  /** Which metric the overlay ranks by: 'damage', 'healing' or 'taken'. */
  metric: 'damage',

  /**
   * The three alert categories, each on its own switch.
   *
   * None of these owns the alert window — `alertsEnabled()` derives its existence from
   * all of them together, so a player who only wants summon banners gets a window with
   * nothing else in it, and turning the last category off closes the window entirely.
   */
  /** Interrupt/cast warnings for enemy casts. NOT the window: see alertsEnabled(). */
  castAlerts: true,

  /**
   * WHICH enemy casts warn — the six group switches under `castAlerts`.
   *
   * These exist because the severity ladder the warnings already had sorts by DANGER,
   * and the player needs to sort by VALUE. Measured over a 149-hour session: roots and
   * snares raise 9/hour and there is usually nothing to do about one, while mez, charm
   * and fear together raise less than 1/hour and are the warnings you drop everything
   * for. A tier floor cannot express "heals yes, roots no"; these can.
   *
   * The values below ARE the Balanced preset — `presetOf(DEFAULTS)` must return
   * 'balanced', and a test pins that so the default and the preset cannot drift apart.
   * The two loud groups start off: at 64 warnings an hour the old behaviour had taught
   * the player to stop looking at the window, which is the one failure a warning
   * surface cannot survive.
   */
  warnHeals: true,
  warnControl: true,
  warnBigHits: true,
  warnLocks: true,
  warnRoutine: false,
  warnUnknown: false,
  /** "Summoned <name>" banners — a fact that already happened, not a call to act. */
  summonAlerts: true,
  /** Crowd control sitting on the group right now: stunned / mezzed / charmed chips. */
  ccAlerts: true,
  /**
   * Chips raised by imported or authored trigger packs.
   *
   * Its own category rather than a branch of `castAlerts`, because it answers a
   * different question: the others are things this app decided are worth saying, and
   * this is everything the PLAYER decided is. A switch that could only silence both
   * together would make importing a pack a bet on the rest of the alerts too.
   *
   * On by default and costs nothing until a pack exists — with no packs imported the
   * engine produces no chips at all, so behaviour is bit-for-bit what it was before.
   */
  triggerAlerts: true,
  /**
   * Countdown rows, in a window of their own.
   *
   * Deliberately NOT one of the alert categories: a countdown is a fixture you consult
   * and a banner is an interruption — they want opposite places on the screen, and
   * sharing one window meant every banner that arrived shoved the countdowns down it.
   *
   * There used to be a second key beside this one, `castTimers`, for the countdowns this
   * app LEARNED by watching a boss recast something. Nothing learns any more: the
   * estimator is gone and the timers it produced ship as a trigger pack like any other,
   * so one switch now covers every row the panel can draw. `migrateTimers` carries a
   * config written under the old scheme forward.
   */
  triggerTimers: true,
  /** Short cue on a NEW tier-3 warning. Off by default — sound is opt-in, always. */
  castAlertSound: false,
  /**
   * Session mute, deliberately separate from the four category switches.
   *
   * The hotkey is a gesture ("shut up for this pull"); the checkboxes are preferences.
   * Folding mute into "uncheck everything" would throw the player's category choices
   * away the moment they hit the key, with nothing to restore them from.
   */
  alertsMuted: false,
  /** Alert window position; null until the player drags it somewhere. */
  alertsBounds: null,
  /**
   * Boss-timer window position; null until the player drags it somewhere.
   *
   * Its own key, written only by that window's own move handler and read only when it
   * is created. The meter's bounds are not a starting point for it: the meter moves
   * itself constantly (auto-fit, bottom-anchoring, hover-widening) and deriving one
   * window's placement from another's live bounds is how the overlay used to climb
   * the screen.
   */
  timersBounds: null,

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
  /** History window position and size; null until the user moves or resizes it. */
  historyBounds: null,
  /** Triggers window position and size; null until the user moves or resizes it. */
  triggersBounds: null,
  /** Session window position and size; null until the user moves or resizes it. */
  sessionBounds: null,

  /**
   * The non-combat half of a play session: kills, loot, coin, experience, faction,
   * skills, zones.
   *
   * `enabled` is OFF by default and that is the whole promise of this block — a raid HUD
   * that is bit-for-bit what it was before this feature existed for anyone who does not
   * want it. Master off means `main.js` never constructs the tracker at all, so a
   * disabled session costs no regex, no memory and no disk.
   *
   * The seven CATEGORIES default ON, which is a deliberate departure from "everything
   * off": a master switch that turns on nothing is not a preference, it is a feature that
   * appears broken the first time it is used. Nothing they gate can reach the screen until
   * `enabled` is set, so the raid HUD is protected by the master alone and the categories
   * are free to mean what they say.
   *
   * They are gated at RULE EVALUATION rather than at display — see
   * `matchSessionRule` — so a category that is off never runs its regex and never
   * accumulates, instead of being computed and then hidden.
   *
   * These live in the settings form, and that does NOT reopen the wound that removed the
   * ALERTS and BOSS TIMERS sections from it. That removal happened because two screens
   * were answering one question, so a pack could be enabled while its surface was off with
   * neither screen saying so. Session categories have exactly one screen; there is no
   * second place to disagree with.
   */
  session: {
    enabled: false,
    kills: true,
    loot: true,
    coin: true,
    xp: true,
    faction: true,
    skills: true,
    zones: true,
    /**
     * One dim line on the meter, under the readout and above the group rows.
     *
     * Its own switch, independent of the categories feeding it: "track my night" and "put
     * my night on the overlay" are different requests, and a player who wants the Session
     * window has not thereby asked for another line between them and the DPS numbers.
     * Off by default for the same reason `enabled` is.
     */
    meterLine: false,
  },

  hotkeys: {
    toggleLock: 'Control+Shift+L',
    toggleVisible: 'Control+Shift+H',
    resetEncounter: 'Control+Shift+R',
    toggleMetric: 'Control+Shift+M',
    toggleAlerts: 'Control+Shift+A',
    /**
     * "That grind is over, start counting again from here."
     *
     * No migration for a config written before this key existed: `load()` merges DEFAULTS
     * one level deep, so an old config simply gains the binding. Nothing changed meaning
     * underneath the player, which is the only thing migrateAlerts-style rescue is for.
     */
    newSession: 'Control+Shift+N',
  },
};

/** The category switches, in the order they read in the settings form and the tray. */
export const ALERT_CATEGORIES = ['castAlerts', 'summonAlerts', 'ccAlerts', 'triggerAlerts'];

/** Every key that can change whether the alert window should exist. */
export const ALERT_KEYS = [...ALERT_CATEGORIES, 'alertsMuted'];

/** Every key that can change whether the boss-timer window should exist. */
export const TIMER_KEYS = ['triggerTimers', 'alertsMuted'];

/**
 * The seven session categories, in the order they read in the settings form.
 *
 * Re-exported from `src/session/rules.js` rather than restated, because the rule table is
 * where a category becomes real — a name here with no rules behind it would be a switch
 * that does nothing, and a rule with a category not listed here would be data the player
 * cannot turn off. `tests/config.test.js` pins the two together.
 */
export { SESSION_CATEGORIES };

/**
 * The seven switches in the shape `SessionTracker` wants, with absent reading as ON.
 *
 * Derived rather than handed over wholesale so the tracker is never passed `enabled` and
 * `meterLine` as if they were categories, and so a config written before a category
 * existed gains it switched on rather than silently off.
 */
export function sessionCategories(cfg) {
  const block = cfg?.session ?? {};
  return Object.fromEntries(SESSION_CATEGORIES.map((c) => [c, block[c] !== false]));
}

/**
 * Is the session tracker on at all?
 *
 * Its own predicate for the same reason `alertsEnabled` is: one switch decides whether a
 * whole subsystem gets constructed, and putting that decision in an Electron-shaped
 * conditional in main.js would make it the one piece of this feature that cannot be
 * tested in WSL. A missing block reads as OFF — unlike the alert categories, where absent
 * means on. That asymmetry is deliberate: the alert rule protects warnings a player
 * already had from being swallowed by an upgrade, and nobody has ever had this.
 */
export function sessionEnabled(cfg) {
  return cfg?.session?.enabled === true;
}

/** Should the meter draw its session line? Both switches, because both are real. */
export function sessionLineEnabled(cfg) {
  return sessionEnabled(cfg) && cfg?.session?.meterLine === true;
}

/**
 * The six warning groups a cast can land in, in the order they read in the settings
 * form and the tray. These are the `group` values `spellwatch.js` stamps on a warning,
 * plus 'unknown' for the casts it does not recognize.
 */
export const WARN_GROUPS = ['heals', 'control', 'bigHits', 'locks', 'routine', 'unknown'];

/**
 * The config key that gates a group — by CONVENTION rather than by a lookup table.
 *
 * The alerts renderer needs this same mapping and cannot import this module (it reaches
 * for `fs`), so the choice was between duplicating a six-row table over there and
 * duplicating a one-line rule. A rule cannot drift halfway: either both sides agree or
 * nothing resolves at all, which a single render makes obvious. `tests/config.test.js`
 * pins the convention against DEFAULTS, so a group added without its key fails loudly.
 */
export const warnKeyFor = (group) => `warn${group[0].toUpperCase()}${group.slice(1)}`;

/** Every group-switch key, for the callers that only need to know what to watch. */
export const WARN_KEYS = WARN_GROUPS.map(warnKeyFor);

/**
 * The three presets, as the complete set of six booleans each one writes.
 *
 * Complete rather than partial on purpose: a preset that only listed what it turns ON
 * would leave whatever the player had switched on before still on, so clicking
 * "Essential" after "Everything" would silently do nothing much. Every preset states
 * all six, so selecting one always lands on exactly the state it names.
 */
export const ALERT_PRESETS = {
  essential: {
    warnHeals: true, warnControl: true, warnBigHits: true,
    warnLocks: false, warnRoutine: false, warnUnknown: false,
  },
  balanced: {
    warnHeals: true, warnControl: true, warnBigHits: true,
    warnLocks: true, warnRoutine: false, warnUnknown: false,
  },
  everything: {
    warnHeals: true, warnControl: true, warnBigHits: true,
    warnLocks: true, warnRoutine: true, warnUnknown: true,
  },
};

/**
 * Is one group switched on?
 *
 * A missing key reads as its DEFAULT, and that is a deliberate departure from the rule
 * the other alert switches follow (`alertsEnabled` treats absent as ON). That rule
 * exists to protect a choice the player MADE — a config predating a category must not
 * silently swallow the alerts that category draws. Nobody ever chose these six, and the
 * behaviour "absent means on" would preserve here is exactly the 64-an-hour flood being
 * fixed. `ConfigStore.load()` merges DEFAULTS, so in practice this only governs a
 * renderer talking to a newer main process, where quiet is also the safer answer.
 */
export function warnGroupOn(cfg, key) {
  return (cfg?.[key] ?? DEFAULTS[key]) !== false;
}

/**
 * Which preset the current switches amount to, or null for "Custom".
 *
 * DERIVED, never stored — the six booleans are the only truth. Storing the preset
 * alongside them would create two things that can disagree, and the one that would be
 * wrong is the one on screen: tick a box in settings and a stored preset would still
 * claim "Balanced". The same reasoning that makes alertsEnabled() derived rather than
 * owned by any single switch.
 */
export function presetOf(cfg) {
  if (!cfg) return null;
  for (const [name, preset] of Object.entries(ALERT_PRESETS)) {
    if (WARN_KEYS.every((key) => warnGroupOn(cfg, key) === preset[key])) return name;
  }
  return null;
}

/**
 * Should the alert window exist at all?
 *
 * Four independent switches collapse to one OS window, and getting that wrong either
 * strands a renderer process for a feature nobody asked for or drops warnings on the
 * floor — so the decision lives here, pure and testable in WSL, rather than in an
 * Electron-shaped conditional in main.js. Mute wins over every category: it suppresses
 * the window wholesale while leaving the preferences underneath it intact.
 */
export function alertsEnabled(cfg) {
  if (!cfg || cfg.alertsMuted) return false;
  // A missing key reads as its default (on) rather than off: a config that predates a
  // category must not silently swallow the warnings that category draws.
  return ALERT_CATEGORIES.some((key) => cfg[key] !== false);
}

/**
 * Should the boss-timer window exist at all?
 *
 * One switch again. It was briefly two — one for the countdowns this app learned and one
 * for the countdowns a pack states outright — which was an honest distinction while both
 * existed. Only the second kind exists now, including for the bosses this app ships
 * timers for, so a second switch would name a source with nothing behind it.
 *
 * Mute still wins: "shut up for this pull" that left this panel talking would be the one
 * surface ignoring the hotkey.
 */
export function timersEnabled(cfg) {
  if (!cfg || cfg.alertsMuted) return false;
  return cfg.triggerTimers !== false;
}

/**
 * The six warning groups get NO migration, deliberately.
 *
 * An existing config simply gains them from DEFAULTS on the next load() and therefore
 * lands on Balanced — quieter than what it had. The migrateAlerts() precedent below
 * does not apply: that one exists because a stored key CHANGED MEANING underneath the
 * player, so honouring it literally would have done something they never asked for.
 * Nothing changes meaning here. There is no old key whose intent has to be carried
 * forward, only a new default that is the entire point of the change — a config that
 * kept the old firehose would be preserving the bug.
 */

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
      this.data = merge(
        DEFAULTS,
        migrateParty(migrateTimers(migrateAlerts(JSON.parse(raw)))),
      );
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
      petOwners: this.data.petOwners,
    };
  }
}

/**
 * One-shot upgrade for configs written before the alert switch was split in four.
 *
 * `castAlerts: false` used to mean "no alerts at all" — it created and destroyed the
 * whole window. It now means only "no interrupt warnings", so a stored false would let
 * summon banners and CC chips appear for a player who had explicitly turned alerts off.
 * The tell is the absence of `summonAlerts`: no version that writes that key ever meant
 * the old thing, so the rule can never fire twice or fight a deliberate later choice.
 *
 * A stored `castTimers: true` is overridden rather than respected, because under the old
 * scheme it was inert: the settings form wrote it on every save, but with no window to
 * draw in it never showed a countdown. Honouring it now would spring one on a player who
 * has had silence for months. A stored `castAlerts: true` needs nothing — it already
 * means what it says.
 *
 * The two trigger keys are switched off here for exactly that reason, one step further
 * on: they are absent from such a config entirely, so they would arrive from DEFAULTS
 * switched ON, and a player who said "no alerts" would get a chip stack and a countdown
 * panel the first time they imported a pack. Taking the same silence forward is the only
 * reading of their choice that does not contradict it. Both are one click away in
 * settings, and the import screen says so when it sees them off.
 */
function migrateAlerts(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if (raw.castAlerts !== false || 'summonAlerts' in raw) return raw;
  return {
    ...raw,
    summonAlerts: false,
    ccAlerts: false,
    castTimers: false,
    triggerAlerts: false,
    triggerTimers: false,
  };
}

/**
 * One-shot upgrade for configs written while the timer panel had two switches.
 *
 * `castTimers` was the countdowns this app learned by watching a boss; `triggerTimers`
 * was the ones a pack stated outright. There is one source now, so there is one switch,
 * and the question is what a config holding both should mean.
 *
 * Either one being ON keeps the panel on. The player asked for countdowns; there is now
 * exactly one place countdowns come from, and it includes the bosses the learned column
 * used to cover — so honouring a `castTimers: true` by leaving `triggerTimers` off would
 * take away the very rows that choice was about. Only a config that had switched BOTH
 * off gets silence, which is the only reading under which neither key is contradicted.
 *
 * Unlike `migrateAlerts` this needs no tell to keep it from firing twice: `castTimers` is
 * no longer in DEFAULTS, so it survives only in a file written by an older version, and
 * the rule is idempotent besides — running it over its own output changes nothing.
 */
function migrateTimers(raw) {
  if (!raw || typeof raw !== 'object' || !('castTimers' in raw)) return raw;
  const { castTimers, ...rest } = raw;
  return { ...rest, triggerTimers: castTimers !== false || raw.triggerTimers !== false };
}

/**
 * The party list a given character is filtered by, or [] for "show everyone".
 *
 * A free function rather than a method so the renderer and the tests can ask the same
 * question without a store — and so the "no entry means no filter" rule lives in exactly
 * one place instead of at every call site.
 */
export function partyListFor(config, character, server) {
  const map = config?.partyMembers;
  if (!map || Array.isArray(map)) return [];
  const list = map[storeKey(character, server)];
  return Array.isArray(list) ? list.filter(Boolean) : [];
}

/**
 * Drop the old `groupOnly` switch, which the party list replaced.
 *
 * A stored `true` migrates to an EMPTY list — showing more, not less. There is nothing
 * honest to migrate it to: the names it was hiding came from what the parser inferred
 * about the group at the time, and that set does not exist until the log is read, so
 * writing anything into the list here would be inventing a party the player never typed.
 * Showing everyone is also the safe direction to be wrong in, and it is visible: a row
 * that appears can be filtered out in one line of settings, whereas the failure this
 * whole change exists to fix is a row that is missing and says nothing.
 */
function migrateParty(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const { groupOnly, ...rest } = raw;
  // The list was global for one day before it became per character. An array cannot be
  // migrated honestly — there is nobody to attribute it to, since the config does not
  // record which character was logged in when it was typed — so it becomes no filter at
  // all. Showing more is the safe direction, and it is the direction the empty default
  // already points.
  if (Array.isArray(rest.partyMembers)) rest.partyMembers = {};
  return rest;
}

/**
 * Keys whose object value is replaced wholesale rather than merged.
 *
 * petOwners is a complete mapping, not a set of tweaks: merging it would make a
 * deleted pet entry impossible to remove, since the old key would survive every save.
 * partyMembers is an array and so is replaced by `merge` anyway; it is named here for
 * the reader, because the reason is the same one and the consequence of getting it
 * wrong is worse — a name that could not be deleted is a person permanently hidden.
 */
const REPLACE_KEYS = new Set(['petOwners', 'partyMembers']);

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
