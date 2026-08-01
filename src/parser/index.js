/**
 * LogParser — feed it log lines, ask it for the current encounter.
 *
 * Deliberately free of any Electron import so it can be unit-tested with `node --test`
 * and replayed offline by scripts/replay.js.
 *
 *   const parser = new LogParser({ selfName: 'Rhale' });
 *   parser.feed('[Fri Jul 31 18:48:15 2026] Rhain smites a froglok for 11 points of damage.');
 *   parser.snapshot();   // -> { active, label, groupDps, rows: [...] }
 */

import { parseTimestamp } from './timestamp.js';
import { matchRule } from './rules.js';
import { resolveEntity, looksLikePlayerName } from './entities.js';
import { Roster, parseLogFilename } from './roster.js';
import { Encounter, DEFAULTS } from './encounter.js';

/** Row name used when damage cannot be attributed to anyone (see attributeNonMelee). */
export const UNKNOWN = 'Unknown';

/** How long after a cast starts we are still willing to blame it for stray damage. */
const CAST_WINDOW_MS = 2000;

/**
 * Charm has a cast time, so the "has been charmed" line lands well after the cast began.
 * Wider than CAST_WINDOW_MS for that reason.
 */
const CHARM_WINDOW_MS = 8000;

/** Entries live this long in the cast table, so charm attribution outlives the 2s window. */
const CAST_TABLE_TTL_MS = 10_000;

/**
 * Spells that take control of a mob. Charm is the only crowd control that makes the
 * mob fight for you — mez and root do not — so only these transfer damage credit.
 * "Beguile" is confirmed in EQ Legends; the rest follow classic EverQuest naming.
 */
const CHARM_SPELL_RE = /\b(?:beguile|charm|allure|dominate|enslave|subjugate)\b/i;

/** "Gann healed himself" — the target of a reflexive heal is the healer. */
const REFLEXIVE_RE = /^(?:him|her|it|them|your|my)sel(?:f|ves)$/i;

export class LogParser {
  /**
   * @param {Object} [options]
   * @param {string} [options.selfName]     logging character; or pass logFilename
   * @param {string} [options.logFilename]  e.g. "eqlog_Rhale_oggok.txt"
   * @param {boolean} [options.groupOnly]   restrict rows to confirmed group members
   * @param {number} [options.timeoutMs]    encounter idle timeout
   * @param {() => number} [options.clock]  time source; replay overrides this
   */
  constructor(options = {}) {
    const fromFile = options.logFilename ? parseLogFilename(options.logFilename) : null;

    this.selfName = options.selfName ?? fromFile?.character ?? 'You';
    this.server = fromFile?.server ?? null;
    this.groupOnly = options.groupOnly ?? false;
    this.clock = options.clock ?? (() => Date.now());
    this.encounterOptions = {
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      postKillGraceMs: options.postKillGraceMs ?? DEFAULTS.postKillGraceMs,
      rollingWindowMs: options.rollingWindowMs ?? DEFAULTS.rollingWindowMs,
    };

    this.roster = new Roster(this.selfName);
    this.roster.setPetOwners(options.petOwners);
    /** @type {Encounter|null} */
    this.current = null;
    /** @type {Encounter|null} the last finished fight, kept on screen after combat */
    this.last = null;
    /** @type {Map<string, {ability: string|null, ts: number}>} in-flight casts */
    this.casts = new Map();
    this.zone = null;
    /** Bumped whenever a snapshot would differ, so the UI can skip idle repaints. */
    this.revision = 0;
    /** Lines that parsed but matched no rule — surfaced in the settings window. */
    this.unmatchedCount = 0;
  }

  setSelfName(name) {
    this.selfName = name;
    this.roster.setSelf(name);
  }

  setLogFilename(filename) {
    const parsed = parseLogFilename(filename);
    if (parsed) {
      this.server = parsed.server;
      this.setSelfName(parsed.character);
    }
  }

  setGroupOnly(groupOnly) {
    this.groupOnly = groupOnly;
    this.revision++;
  }

  /**
   * Apply a pet-ownership mapping from settings.
   *
   * Takes effect on the next encounter, not retroactively: damage already credited to
   * "Gann" cannot be moved into Rhain's totals without re-reading the log, and silently
   * rewriting a fight the player is looking at would be worse than waiting for the next.
   */
  setPetOwners(mapping) {
    this.roster.setPetOwners(mapping);
    this.revision++;
  }

  /**
   * Feed one raw log line.
   * @returns {Object|null} the typed event, or null if the line was not understood
   */
  feed(line) {
    const parsed = parseTimestamp(line);
    if (!parsed) return null;

    const event = matchRule(parsed.body);
    if (!event) {
      this.unmatchedCount++;
      return null;
    }
    event.ts = parsed.ts;

    // Advance to this line's time BEFORE handling it, so a fight that ended during a
    // quiet stretch is closed out and the next pull opens a fresh encounter rather than
    // being appended to the stale one.
    this.tick(event.ts);

    switch (event.kind) {
      case 'damage':
        this.handleDamage(event);
        break;
      case 'nonmelee-unattributed':
        this.handleUnattributed(event);
        break;
      case 'miss':
        this.handleMiss(event);
        break;
      case 'death':
        this.handleDeath(event);
        break;
      case 'cast':
        this.casts.set(this.resolve(event.attacker).name, {
          ability: event.ability,
          ts: event.ts,
        });
        break;
      case 'heal':
        this.handleHeal(event);
        break;
      case 'charm':
        this.handleCharm(event);
        break;
      case 'zone':
        this.handleZone(event);
        break;
      case 'group':
      case 'who':
      case 'targeted':
      case 'pet-owner':
        this.roster.applyEvent(event);
        this.revision++;
        break;
      default:
        break;   // chat, environmental, logging — typed but not scored
    }

    return event;
  }

  /** Feed a whole blob of text (used by the tailer and by replay). */
  feedChunk(text) {
    const events = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const e = this.feed(line);
      if (e) events.push(e);
    }
    return events;
  }

  /**
   * Resolve a raw log name to a canonical combatant.
   *
   * Two kinds of pet fold into an owner here. The `` <Owner>`s warder `` form is
   * structural and handled by entities.js. A *named* summoned pet — "Gann" — carries
   * no such marker, so it is looked up in the roster's ownership table, which is fed
   * by the pet-calls-you-Master line and by the user's settings.
   */
  resolve(raw) {
    const entity = resolveEntity(raw, this.selfName);
    if (entity.isPet) return entity;

    const owner = this.roster.ownerOf(entity.name);
    if (owner) {
      return { name: owner, owner, isPet: true, display: entity.display };
    }
    return entity;
  }

  /** A name we are willing to show as a damage-dealing row. */
  isFriendly(name) {
    if (name === UNKNOWN) return true;
    // A name the game called an NPC is not a player, whatever its shape. This keeps a
    // single-word named mob ("Zevrex") from being mistaken for a group member.
    if (this.roster.knownNpcs.has(name) && !this.roster.knownPlayers.has(name)) {
      return this.roster.includes(name, false);
    }
    return this.roster.includes(name, false) || looksLikePlayerName(name);
  }

  ensureEncounter(ts) {
    if (this.current && !this.current.closed) return this.current;
    this.current = new Encounter(ts, this.encounterOptions);
    this.revision++;
    return this.current;
  }

  /**
   * A summoned pet whose owner we have not been told.
   *
   * Once the game says `Targeted (NPC): Gann`, Gann is known not to be a player — but
   * it is still hitting the mob the group is fighting, and that damage is real group
   * damage. Discarding it would make the group total quietly wrong; giving it a row
   * keeps the number honest and makes it obvious that the pet needs mapping.
   *
   * The guard against scoring an actual enemy is that a mob the group is fighting is
   * already in the encounter's engaged list, and never reaches this test.
   */
  isUnownedPet(name) {
    if (!this.roster.knownNpcs.has(name)) return false;
    if (this.roster.knownPlayers.has(name)) return false;
    if (this.current && !this.current.closed && this.current.engagedNpcs.has(name)) return false;
    return true;
  }

  handleDamage(event) {
    const attacker = this.resolve(event.attacker);
    const target = this.resolve(event.target);

    const attackerFriendly = this.isFriendly(attacker.name) || this.isUnownedPet(attacker.name);
    const targetFriendly = this.isFriendly(target.name);

    if (attackerFriendly && targetFriendly) {
      // A charmed mob resolves to its owner, so it counts as friendly. The only way one
      // friendly hits another is therefore that a charm just broke — retry the line once
      // the charm is released so it is scored as the ordinary combat it now is.
      if (this.breakCharm(event)) {
        this.handleDamage(event);
        return;
      }
      // Otherwise this is a mis-parse; scoring it would inflate someone's DPS.
      return;
    }

    if (attackerFriendly) {
      this.roster.noteFriendlyCombatant(attacker.name);
      const enc = this.ensureEncounter(event.ts);
      enc.engage(target.name, event.amount);
      enc.addDamage({
        name: attacker.name,
        amount: event.amount,
        ts: event.ts,
        source: event.source,
        ability: event.ability,
        isPet: attacker.isPet,
        crit: event.mods?.includes('critical') ?? false,
      });
      this.revision++;
      return;
    }

    if (targetFriendly) {
      // An NPC hitting us still means a fight is on, so the encounter opens and its
      // clock runs — but incoming damage is not scored (damage-taken is out of scope).
      const enc = this.ensureEncounter(event.ts);
      enc.engage(attacker.name, 0);
      enc.lastDamageTs = Math.max(enc.lastDamageTs, event.ts);
      enc.allSlainAt = null;
      this.revision++;
    }
  }

  /**
   * `<T> was hit by non-melee for <N> damage.` names no attacker.
   *
   * In EverQuest Legends this is usually environmental — every instance in the Phase 0
   * sample was fall damage, confirmed by the `YOU were injured by falling.` line that
   * follows each one. So an unattributed hit on a FRIENDLY is ignored entirely: it
   * neither scores nor opens an encounter, which keeps a fall down a cliff from
   * spawning a phantom fight.
   *
   * Against an NPC it is real outgoing damage, and we try in order:
   *   1. the only friendly with a cast in flight in the last 2s gets the credit
   *   2. otherwise it lands in an explicit "Unknown" row, never guessed onto a player
   */
  handleUnattributed(event) {
    const target = this.resolve(event.target);
    if (this.isFriendly(target.name)) return;

    const enc = this.ensureEncounter(event.ts);
    const attribution = this.attributeNonMelee(event.ts);
    if (attribution) this.roster.noteFriendlyCombatant(attribution.name);

    enc.engage(target.name, event.amount);
    enc.addDamage({
      name: attribution?.name ?? UNKNOWN,
      amount: event.amount,
      ts: event.ts,
      source: attribution ? 'spell' : 'nonmelee',
      ability: attribution?.ability ?? 'Unknown',
      isPet: false,
      crit: false,
    });
    this.revision++;
  }

  /** Drop cast-table entries too old to explain anything. */
  pruneCasts(ts) {
    for (const [name, cast] of this.casts) {
      if (ts - cast.ts > CAST_TABLE_TTL_MS || cast.ts > ts) this.casts.delete(name);
    }
  }

  /** @returns {{name: string, ability: string}|null} the sole in-flight caster, if unambiguous */
  attributeNonMelee(ts) {
    this.pruneCasts(ts);
    const candidates = [];
    for (const [name, cast] of this.casts) {
      // Pruning uses a longer TTL than this window so charm attribution still works;
      // filter here rather than delete.
      if (ts - cast.ts > CAST_WINDOW_MS) continue;
      if (this.isFriendly(name)) candidates.push({ name, ability: cast.ability ?? 'Unknown' });
    }
    // Two people casting at once makes attribution a coin flip; a visible "Unknown"
    // row is more honest than a wrong name, and immediately shows the rules need work.
    return candidates.length === 1 ? candidates[0] : null;
  }

  handleMiss(event) {
    const attacker = this.resolve(event.attacker);
    const target = this.resolve(event.target);
    if (!this.isFriendly(attacker.name) || this.isFriendly(target.name)) return;

    // A miss alone does not start a fight — otherwise a stray swing at a passing mob
    // opens an encounter with 0 damage and an ever-growing duration.
    if (!this.current || this.current.closed) return;

    this.current.addMiss({
      name: attacker.name,
      ts: event.ts,
      isPet: attacker.isPet,
      ability: event.ability,
    });
    this.revision++;
  }

  /**
   * Credit healing.
   *
   * Healing never OPENS an encounter, only joins one already running. A group being
   * topped up between pulls would otherwise start a fight with no damage in it, whose
   * duration then grows until the idle timeout — dragging the next real fight's DPS
   * down with it. It also never extends one, for the same reason.
   */
  handleHeal(event) {
    if (!this.current || this.current.closed) return;

    const healer = this.resolve(event.attacker);
    if (!this.isFriendly(healer.name) && !this.isUnownedPet(healer.name)) return;

    // "Gann healed himself", "Emalina healed herself" — the reflexive is the healer.
    const target = REFLEXIVE_RE.test(event.target)
      ? { name: healer.name, display: healer.display }
      : this.resolve(event.target);

    this.roster.noteFriendlyCombatant(healer.name);
    this.current.addHeal({
      name: healer.name,
      effective: event.effective,
      potential: event.potential,
      ts: event.ts,
      ability: event.ability,
      isPet: healer.isPet,
      target: target.name,
    });
    this.revision++;
  }

  /**
   * A mob was charmed and now fights for the group.
   *
   * The line names the mob but not who charmed it, so the charmer is the friendly whose
   * most recent in-flight cast was a charm spell. Matching on the spell NAME rather than
   * on "the only caster in flight" is what makes this work: several people are usually
   * casting at once, and only one of them is casting Beguile.
   *
   * With no charm caster identified, the mob is left alone rather than credited to a
   * guess — its damage then simply goes uncounted, which is the honest outcome.
   */
  handleCharm(event) {
    const mob = this.resolve(event.who);
    const charmer = this.attributeCharm(event.ts);
    if (!charmer) return;

    this.roster.charm(mob.name, charmer);
    this.revision++;
  }

  /** @returns {string|null} the friendly whose recent cast was a charm spell */
  attributeCharm(ts) {
    this.pruneCasts(ts);
    let best = null;
    for (const [name, cast] of this.casts) {
      if (ts - cast.ts > CHARM_WINDOW_MS) continue;
      if (!cast.ability || !CHARM_SPELL_RE.test(cast.ability)) continue;
      if (!this.isFriendly(name)) continue;
      if (!best || cast.ts > best.ts) best = { name, ts: cast.ts };
    }
    return best?.name ?? null;
  }

  /**
   * Infer that a charm has ended.
   *
   * EQ Legends logs no charm-break message whatsoever, so the break has to be deduced.
   * A charmed pet resolves to its owner, who is friendly — so a "friendly hitting a
   * friendly" line involving a charmed mob can only mean the charm just broke, in either
   * direction (the ex-pet turning on the group, or the group turning on it).
   *
   * @returns {boolean} true if something was un-charmed and the event deserves a retry
   */
  breakCharm(event) {
    let broke = false;
    for (const raw of [event.attacker, event.target]) {
      if (raw && this.roster.isCharmed(raw)) {
        this.roster.uncharm(raw);
        broke = true;
      }
    }
    if (broke) this.revision++;
    return broke;
  }

  handleDeath(event) {
    // A charm ends with the mob, whichever side killed it.
    this.roster.uncharm(event.target);

    if (!this.current || this.current.closed) return;
    const target = this.resolve(event.target);
    if (this.isFriendly(target.name)) return;   // a player dying does not end the pull
    this.current.npcDied(target.name, event.ts);
    this.revision++;
  }

  handleZone(event) {
    if (event.phase === 'entered') this.zone = event.zone;
    this.closeCurrent('zone', event.ts);
    // Group membership deliberately survives zoning — a group zones together, and
    // dropping members here would blank rows from the fight still on screen. Charms do
    // not survive: the mob is in the zone you left.
    this.roster.clearCharms();
    this.casts.clear();
    this.revision++;
  }

  closeCurrent(reason, ts) {
    if (!this.current || this.current.closed) return;
    this.current.close(reason, ts ?? this.current.lastDamageTs);
    this.last = this.current;
    this.current = null;
  }

  /**
   * Advance time without feeding a line. Called on a timer by the main process so an
   * encounter still times out when the log goes quiet.
   * @param {number} [now]
   */
  tick(now = this.clock()) {
    if (this.current && !this.current.closed && this.current.update(now)) {
      this.last = this.current;
      this.current = null;
      this.revision++;
    }
  }

  /** Discard the running encounter (the Ctrl+Shift+R hotkey). */
  reset() {
    this.current = null;
    this.last = null;
    this.casts.clear();
    this.roster.clearCharms();
    this.revision++;
  }

  /**
   * The view the overlay renders.
   *
   * When no fight is running the last one stays on screen — a number that vanishes the
   * instant combat ends is useless, since reading it is the whole point.
   */
  snapshot(now = this.clock()) {
    const enc = this.current ?? this.last;
    if (!enc) {
      return {
        active: false,
        idle: true,
        label: null,
        zone: this.zone,
        self: this.selfName,
        durationMs: 0,
        totalDamage: 0,
        groupDps: 0,
        totalHealing: 0,
        groupHps: 0,
        rows: [],
      };
    }

    // Rows only ever exist for combatants that damage was credited to, and damage is
    // only credited to friendlies, so "show everyone" needs no filter at all. The
    // roster is consulted purely to narrow that set down to the group.
    const include = (name) =>
      !this.groupOnly || name === UNKNOWN || this.roster.includes(name, true);
    const snap = enc.snapshot(now, { includeNames: include });
    return { ...snap, idle: false, zone: this.zone, self: this.selfName };
  }
}

export { parseLogFilename };
