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
import { DEFAULT_MOBILE_PORT } from './mobile.js';

/** Where the Daybreak launcher installs EverQuest Legends by default. */
export const DEFAULT_LOG_DIR =
  'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends\\Logs';

/**
 * The seven notification-duration defaults, in seconds, in the order the Durations
 * dialog lists them.
 *
 * Each value IS the hard-coded constant it replaced (HOSTILE_CAST_TTL_MS and friends
 * in the parser, TRIGGER_WARN_TTL_MS in the trigger engine, QUEST_CHIP_TTL_MS in
 * main.js, the 2600ms toast default in the overlay renderer) — the whole promise of
 * making these configurable is that an untouched config changes nothing. Declared
 * before DEFAULTS because DEFAULTS spreads it.
 */
export const DURATION_DEFAULTS = Object.freeze({
  castChipSec: 6,
  summonChipSec: 5,
  charmBreakChipSec: 6,
  questChipSec: 6,
  noticeChipSec: 6,
  triggerChipSec: 8,
  toastSec: 2.6,
});

/** The duration keys, for the dialog and for "is this patch a duration change" tests. */
export const DURATION_KEYS = Object.keys(DURATION_DEFAULTS);

/**
 * One duration in seconds, clamped to a range a chip can survive being set to.
 *
 * The clamp lives at READ time rather than at save time so a hand-edited config.json
 * cannot smuggle a 0 (a chip that dies before the 4 Hz push ever draws it — reads as
 * "alerts are broken", the failure the identify-don't-mute rule exists to prevent) or
 * a 10-minute banner past the dialog. Anything non-numeric reads as the default.
 */
export function durationSec(cfg, key) {
  const v = Number(cfg?.[key]);
  if (!Number.isFinite(v)) return DURATION_DEFAULTS[key];
  return Math.min(30, Math.max(1, v));
}

/**
 * The parser's four chip lifetimes in the shape LogParser takes them (ms), derived
 * here so main.js never does seconds-to-ms arithmetic inline — the same reason
 * parserOptions() exists.
 */
export function alertTtls(cfg) {
  return {
    hostileCastMs: durationSec(cfg, 'castChipSec') * 1000,
    summonMs: durationSec(cfg, 'summonChipSec') * 1000,
    charmBreakMs: durationSec(cfg, 'charmBreakChipSec') * 1000,
    noticeMs: durationSec(cfg, 'noticeChipSec') * 1000,
  };
}

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
   * "Your charm broke" — the freed mob is turning on you right now.
   *
   * On by default because it is tier-3 class information for anyone who charms: the
   * parser already detects the break (the worn-off line ending a live charm) and until
   * this key existed it acted on it silently, dropping the pet from the charm store
   * while the player found out from their own health bar.
   */
  charmBreakAlerts: true,
  /**
   * Chips for looted Plane of Sky quest items — "Wind Rune Azia — 7 class tests".
   *
   * A moment of recognition at the loot window, not a call to act; the ledger itself
   * lives in the Quests window whether or not this is on.
   */
  questLootAlerts: true,
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
   * A second, DESCENDING cue for a charm break, audibly distinct from the rising cast
   * cue — the whole point is being heard while you look elsewhere. Off by default:
   * sound is opt-in, always.
   */
  charmBreakSound: false,
  /**
   * How long each notification category stays on screen, in seconds.
   *
   * Flat keys spread from DURATION_DEFAULTS below so the defaults live once, next to
   * the clamp that guards them. Every default equals the constant it replaced —
   * including the odd-looking 2.6 for toasts — so a player who never opens the
   * Durations dialog sees timing bit-for-bit what it was when these were hard-coded.
   * Edited only by that dialog (Triggers window); the settings form deliberately does
   * not touch these, for the same one-place reason it lost its ALERTS section.
   */
  ...DURATION_DEFAULTS,

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
  /** The Timers manager window's size and position. A real window like History and
   *  Triggers, so it remembers both rather than only where it sits. */
  timerSetupBounds: null,

  /**
   * The engaged-boss drops popup: a small click-through panel that appears when a
   * Sky boss with quest drops still needed is engaged, listing those drops and the
   * classes they are owed to. One switch, living in the settings form — it backs no
   * other surface, so the two-places failure that removed the ALERTS section from
   * settings cannot recur here.
   */
  dropsOverlay: true,
  /**
   * How far the popup's question reaches: every mob this character's own log has
   * PROVED drops something still outstanding (on), or only the bosses the dataset
   * names (off — exactly what shipped before the drop index existed).
   *
   * Its own key beside the master switch rather than folded into it, because the two
   * answer different questions and the wider reach is the louder one: a spiroc camp
   * fires the popup on most pulls, which is the requested behaviour and also the
   * thing somebody may want back off without losing the popup entirely. Both live in
   * the one Needed drops section of the settings form — the only place either is
   * written, so the two-places failure that removed the ALERTS section cannot recur.
   * Absent reads as ON, like every other key here: a config predating the key must
   * not silently swallow the feature its next update ships.
   */
  dropsAnyMob: true,
  /** Drops popup position; null until the player drags it somewhere. Its own key,
   *  written only by that window's own move handler — never derived from another
   *  window's bounds, for the usual climbing-window reason. */
  dropsBounds: null,

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
  /** Quests window position and size; null until the user moves or resizes it. */
  questsBounds: null,

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

  /**
   * The second screen: a phone or tablet on the same LAN, watching over HTTP.
   *
   * OFF by default on the session tracker's promise — `main` never constructs the
   * server, no port opens, no firewall prompt appears, and the app is bit-for-bit what
   * it was before the feature existed. The token is generated ONCE, the first time the
   * screen is enabled, and then kept: it rides in the QR code, and a token that
   * changed on every launch would silently orphan every phone that had scanned one.
   */
  mobileEnabled: false,
  mobilePort: DEFAULT_MOBILE_PORT,
  /** @type {string|null} pairing token; null until first enabled. */
  mobileToken: null,

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
    /**
     * "Put this fight in chat" — the COPY button, without unlocking to reach it.
     *
     * The button is only on screen while the overlay is unlocked, which is precisely the
     * state it is not in during a pull; reaching it meant unlock, mouse, click, lock. This
     * binding fires the same action from the game.
     *
     * Same no-migration story as `newSession` above: an existing config gains the key on
     * the one-level-deep merge in `load()`, and nothing already bound changes meaning.
     */
    copyReport: 'Control+Shift+C',
    /**
     * "Show me the quest ledger" — the tray's Quests… row, without leaving the game.
     *
     * A toggle, not open-only: every other binding here works in both directions (H
     * hides what it showed, M keeps cycling), and a hotkey that can summon a window but
     * not dismiss it forces the mouse trip it exists to avoid.
     *
     * Same no-migration story as `newSession` above: an existing config gains the key on
     * the one-level-deep merge in `load()`, and nothing already bound changes meaning.
     */
    openQuests: 'Control+Shift+Q',
    /**
     * The Timers window.
     *
     * Its own key for the same reason Quests has one: it is a window you open to change
     * something and close again, and the tray is three clicks away with the icon hidden
     * in Windows 11's overflow. No migration needed — `load()` merges DEFAULTS one level
     * deep, so an existing config gains it and nothing already bound changes meaning.
     */
    openTimers: 'Control+Shift+T',
  },
};

/** The category switches, in the order they read in the settings form and the tray. */
export const ALERT_CATEGORIES = [
  'castAlerts', 'summonAlerts', 'ccAlerts', 'charmBreakAlerts', 'questLootAlerts', 'triggerAlerts',
];

/** Every key that can change whether the alert window should exist. */
export const ALERT_KEYS = [...ALERT_CATEGORIES, 'alertsMuted'];

/** Every key that can change whether the boss-timer window should exist. */
export const TIMER_KEYS = ['triggerTimers', 'alertsMuted'];

/**
 * Every key that can change whether the engaged-drops popup should exist or what it
 * may contain. `dropsAnyMob` decides only the latter, and rides here because the
 * window sync is idempotent and the alternative is a second, near-identical list
 * whose only job would be to be forgotten when a third key arrives.
 */
export const DROPS_KEYS = ['dropsOverlay', 'dropsAnyMob', 'alertsMuted'];

/** Every key whose change means the second-screen server must be rebuilt. The token
 *  is deliberately absent: nothing edits it after first generation, and a patch that
 *  wrote it arrives FROM the rebuild path — reacting to it would loop. */
export const MOBILE_KEYS = ['mobileEnabled', 'mobilePort'];

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
 * Should the engaged-drops popup window exist at all?
 *
 * One switch, and mute wins over it exactly as it does for the timers: the popup is
 * a consult surface like the countdown panel, and "shut up for this pull" that left
 * it talking would be the one surface ignoring the hotkey. Absent reads as on for
 * the same reason the timers key does — a config predating the key must not
 * silently swallow the feature its next update ships.
 */
export function dropsEnabled(cfg) {
  if (!cfg || cfg.alertsMuted) return false;
  return cfg.dropsOverlay !== false;
}

/**
 * May the popup speak for mobs the dataset never named — the ones this character's
 * own log has proved drop something still outstanding? Deliberately NOT gated on
 * `dropsEnabled`: this answers how far the question reaches, not whether it is asked,
 * and one switch answering two questions is what the separate key exists to avoid.
 */
export function dropsAnyMob(cfg) {
  return cfg?.dropsAnyMob !== false;
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

  /** Encounter tuning and chip lifetimes in the shape the parser wants (seconds -> ms). */
  parserOptions() {
    return {
      timeoutMs: this.data.combatTimeoutSec * 1000,
      postKillGraceMs: this.data.postKillGraceSec * 1000,
      rollingWindowMs: this.data.rollingWindowSec * 1000,
      petOwners: this.data.petOwners,
      alertTtls: alertTtls(this.data),
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
    // Later categories, same reasoning again: absent from a config this old, so
    // without these they would arrive from DEFAULTS switched ON under a player who
    // had said "no alerts".
    charmBreakAlerts: false,
    questLootAlerts: false,
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
