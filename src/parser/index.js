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
import { resolveEntity, looksLikePlayerName, stripArticle } from './entities.js';
import { Roster, parseLogFilename } from './roster.js';
import { Encounter, DEFAULTS } from './encounter.js';
import { classify } from './spellwatch.js';
import { RhythmTracker } from './rhythm.js';

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
 * How long a hostile-cast warning stays on screen with no resolution.
 *
 * The log never states cast times, and guessing one to draw a DBM-style progress bar
 * would be exactly the kind of invented number this project refuses to show. Instead a
 * warning simply lives for a fixed window generously past any EQ cast time (most sit
 * at 2–4s) and then expires. It leaves earlier if the cast is interrupted, the caster
 * dies, or the player zones — the three resolutions the log actually confirms.
 */
export const HOSTILE_CAST_TTL_MS = 6000;

/**
 * How long a SUMMONED chip stays up. Shorter than the cast window because a summon
 * is over the moment it is announced — the chip is an announcement ("the boss just
 * yanked the cleric"), not a countdown to anything.
 */
export const SUMMON_TTL_MS = 5000;

/**
 * Ceiling on how long a CC state chip may live without an explicit end-line.
 *
 * Stun and mez clear on the log's own "no longer"/"awakened" lines; charm on a member
 * has NO break line at all. The cap is a safety net so a missed or nonexistent
 * end-line cannot leave a stale MEZZED chip on screen forever — it is not a claim
 * about how long any of these effects actually last.
 */
export const CC_STATE_CAP_MS = 30_000;

/**
 * The mez family as this server words it, plus stun — the effects worth a member
 * state chip. Rooted/poisoned/lacerated members are deliberately absent: constant
 * grind noise that no raid decision hangs on.
 */
const CC_EFFECTS = {
  mesmerized: 'mez',
  entranced: 'mez',
  captivated: 'mez',
  stunned: 'stun',
};

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
   * @param {(enc: Encounter) => void} [options.onEncounterEnd]
   *   Called with each encounter as it CLOSES (timeout, kill, zone) — the hook main
   *   uses to persist history. Deliberately not called by reset(): a manual reset is
   *   the player saying "this one doesn't count". The parser stays pure Node; whatever
   *   the callback does with the encounter is the caller's business.
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

    this.onEncounterEnd = options.onEncounterEnd ?? null;
    this.roster = new Roster(this.selfName);
    this.roster.setPetOwners(options.petOwners);
    /** @type {Encounter|null} */
    this.current = null;
    /** @type {Encounter|null} the last finished fight, kept on screen after combat */
    this.last = null;
    /** @type {Map<string, {ability: string|null, ts: number}>} in-flight casts */
    this.casts = new Map();
    /**
     * Enemy casts currently worth warning about, oldest first. Summons ride this
     * list too (category 'summon', a victim, and a shorter per-entry ttlMs) — they
     * share the warning shape exactly: instant fact, tier 3, cue-worthy, short TTL.
     * @type {Array<{id: number, caster: string|null, ability: string|null,
     *               category: string|null, tier: number, ts: number,
     *               victim?: string, ttlMs?: number}>}
     */
    this.hostileCasts = [];
    /** Monotonic id so the overlay can tell a NEW warning from a refreshed push. */
    this.hostileCastSeq = 0;
    /**
     * Crowd control currently sitting ON a group member, oldest first. Keyed by
     * who|effect: the same member can be stunned and mezzed at once, but a repeat
     * of the same effect refreshes rather than stacks. Kept apart from hostileCasts
     * because the lifecycles differ in every particular — victim-keyed, tens of
     * seconds long, cleared by explicit end-lines rather than interrupt or death
     * of a caster (see the plan's rejected approach 1).
     * @type {Array<{who: string, effect: string, ts: number}>}
     */
    this.ccStates = [];
    /** Recast rhythms of named casters — the learned spell timers. */
    this.rhythms = new RhythmTracker();
    /**
     * Called with the qualified rhythms a closing encounter taught us, on the same
     * close paths as onEncounterEnd — and, like it, deliberately NOT on a manual
     * reset: a fight the player disowned teaches nothing on the record.
     */
    this.onRhythmsLearned = options.onRhythmsLearned ?? null;
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
      case 'cast': {
        const caster = this.resolve(event.attacker);
        this.casts.set(caster.name, {
          ability: event.ability,
          ts: event.ts,
        });
        this.noteHostileCast(event, caster);
        break;
      }
      case 'interrupt':
        this.handleInterrupt(event);
        break;
      case 'resist':
        this.handleResist(event);
        break;
      case 'heal':
        this.handleHeal(event);
        break;
      case 'charm':
        this.handleCharm(event);
        break;
      case 'summon':
        this.handleSummon(event);
        break;
      case 'effect':
        this.handleEffect(event);
        break;
      case 'effect-end':
        this.handleEffectEnd(event);
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
      // A named boss's spell LANDING is rhythm evidence too: innate breath weapons
      // (Lava Breath) never print a cast line, so their cycle is visible only here.
      // Spells only — melee is continuous and DoT ticks are periodic by mechanic,
      // not by the boss's decision, so both would learn garbage rhythms.
      if (event.source === 'spell' && event.ability &&
          stripArticle(event.attacker) === String(event.attacker).trim()) {
        this.rhythms.noteLanded(attacker.display, event.ability, event.ts);
      }

      // An NPC hitting us means a fight is on — and the incoming side is scored too:
      // the victim's row records who hit them and with what, which is the entire
      // "what is killing me" view. addDamageTaken also keeps the encounter clock
      // running, exactly as outgoing damage does.
      const enc = this.ensureEncounter(event.ts);
      enc.engage(attacker.name, 0);
      enc.addDamageTaken({
        name: target.name,
        // The resolved name, not the raw one, so "A froglok" and "a froglok" collapse
        // to one attacker entry — and an enemy pet reads as the pet, not its owner.
        attacker: attacker.isPet ? attacker.display : attacker.name,
        amount: event.amount,
        ts: event.ts,
        ability: event.ability,
        isPet: target.isPet,
        // Melee is typed as such (armor mitigates it); spells carry the element the
        // line stated; anything else is honestly untyped, never guessed.
        type: event.source === 'melee' ? 'melee' : event.damageType ?? null,
      });
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

  /**
   * Is this resolved caster an enemy whose cast deserves a warning?
   *
   * Engagement outranks the name-shape heuristics for the same reason it does in the
   * roster: a mob the group is actively fighting is hostile whatever its name looks
   * like, including single-token named bosses that would otherwise pass for players.
   * Beyond that, anyone friendly is out — which also silently excludes out-of-group
   * players ("Steven begins casting Gate.") via looksLikePlayerName, and every pet
   * that resolves to a friendly owner. Unowned pets (Gann before mapping) fight FOR
   * the group and are not warned about either.
   *
   * The known gap: a single-token named mob casting before anyone has engaged or
   * targeted it reads as a player and raises no warning until the fight starts.
   * That is the price of never alerting on random passing players, and engagement
   * closes it within the first swing of every real pull.
   */
  isHostileCaster(name) {
    if (this.current && !this.current.closed && this.current.engagedNpcs.has(name)) return true;
    if (this.isFriendly(name)) return false;
    if (this.isUnownedPet(name)) return false;
    return true;
  }

  /**
   * Record a warning for a hostile cast.
   *
   * Same-named mobs are indistinguishable in the log — three cyclopes all cast as
   * "a cyclops" — so a repeat of the same caster+spell REFRESHES the existing warning
   * rather than stacking a duplicate row: the warning for "cyclops casting Instill"
   * is already on screen, and whether it came from one mob or two changes nothing
   * about the response. A different spell from the same name gets its own entry,
   * because it might genuinely be a second mob and hiding it would be a guess.
   */
  noteHostileCast(event, caster) {
    if (!this.isHostileCaster(caster.name)) return;

    // Named casters — no leading article on the RAW name — feed the rhythm tracker.
    // Every cast counts, including ones that merely refresh a warning below: each
    // real cast is what re-anchors the prediction clock. Generic article-mobs never
    // get timers ("a ghoul scribe" rebuffing every 11s is metronomic and worthless),
    // and the anonymous cast form has no spell to key a rhythm on.
    if (event.ability && stripArticle(event.attacker) === String(event.attacker).trim()) {
      this.rhythms.noteCast(caster.display, event.ability, event.ts);
    }

    const existing = this.hostileCasts.find(
      (c) => c.caster === caster.display && c.ability === event.ability,
    );
    if (existing) {
      existing.ts = event.ts;
      this.revision++;
      return;
    }

    const cls = classify(event.ability);
    this.hostileCasts.push({
      id: ++this.hostileCastSeq,
      caster: caster.display,
      ability: event.ability,
      category: cls?.category ?? null,
      tier: cls?.tier ?? 0,
      ts: event.ts,
    });
    this.revision++;
  }

  /**
   * A boss summoned someone — the single most DBM-shaped mechanic in the live log.
   *
   * Two lines can announce the same yank: the boss's say-line naming the victim, and
   * the victim's own "You have been summoned!" confirmation. They are keyed by VICTIM
   * so the pair folds into one warning — the confirmation refreshes the say-line's
   * entry (and vice versa, whichever lands first) instead of stacking a duplicate.
   *
   * The say form carries a hostility guard: the rule table hands us whoever SAID the
   * sentence, and with summon-say now outranking chat, a player typing it in /say
   * reaches this method looking exactly like Master Yael. isHostileCaster is what
   * keeps that troll from ringing a raid alert. The self-confirmation form has no
   * sayer to vet — the game itself printed it, which is as authoritative as it gets.
   */
  handleSummon(event) {
    let caster = null;
    if (event.attacker) {
      const resolved = this.resolve(event.attacker);
      if (!this.isHostileCaster(resolved.name)) return;
      caster = resolved.display;
    }

    // The victim's DISPLAY name, so a summoned pet reads as the pet ("Rhale`s
    // warder"), not as its owner — the owner was not the one yanked.
    const victim = this.resolve(event.victim).display;

    const existing = this.hostileCasts.find(
      (c) => c.category === 'summon' && c.victim === victim,
    );
    if (existing) {
      existing.ts = event.ts;
      // A say-line arriving after the confirmation fills in who did the yanking.
      existing.caster ??= caster;
      this.revision++;
      return;
    }

    this.hostileCasts.push({
      id: ++this.hostileCastSeq,
      caster,
      ability: null,
      category: 'summon',
      tier: 3,
      victim,
      ts: event.ts,
      ttlMs: SUMMON_TTL_MS,
    });
    this.revision++;
  }

  /**
   * A cast was confirmed interrupted — clear its warning.
   *
   * Every entry matching the caster is cleared, not just the named spell: with
   * same-named mobs the log cannot say WHICH cyclops was stopped, and a warning that
   * lingers after the group saw "interrupted" reads as broken. A missed real cast
   * re-alerts on the mob's next attempt within a couple of seconds; a stale warning
   * has no such self-repair. Anonymous-cast entries (ability null) match too.
   *
   * The attribution cast table drops the entry as well — an interrupted spell can no
   * longer explain stray non-melee damage or a charm landing.
   */
  handleInterrupt(event) {
    const caster = this.resolve(event.attacker);

    // The mob will retry early; the gap after an interruption must not be learned.
    this.rhythms.noteInterrupt(caster.display, event.ability);

    const cast = this.casts.get(caster.name);
    if (cast && (cast.ability === event.ability || cast.ability === null)) {
      this.casts.delete(caster.name);
    }

    const before = this.hostileCasts.length;
    // A summon entry survives: it is a fact that already happened, not a cast in
    // progress — interrupting the boss's NEXT spell does not un-summon the cleric.
    this.hostileCasts = this.hostileCasts.filter(
      (c) => c.caster !== caster.display || c.category === 'summon',
    );
    if (this.hostileCasts.length !== before) this.revision++;
  }

  /**
   * A friendly resisted a hostile named caster's spell — the volley still FIRED,
   * which is what the rhythm tracker needs to know. A wholly-resisted breath AE
   * leaves no damage line at all; without this, a clean resist reads as a skipped
   * beat and retracts a perfectly healthy timer.
   *
   * Outgoing resists (the mob resisting OUR spells) teach nothing about the mob's
   * own rhythm and are ignored.
   */
  handleResist(event) {
    if (!event.ability) return;
    const attacker = this.resolve(event.attacker);
    const target = this.resolve(event.target);
    if (!this.isFriendly(target.name)) return;
    if (this.isFriendly(attacker.name)) return;
    if (stripArticle(event.attacker) !== String(event.attacker).trim()) return;
    this.rhythms.noteLanded(attacker.display, event.ability, event.ts);
  }

  /** Clear warnings from a caster who is now dead (a corpse finishes no casts). */
  clearHostileCastsFrom(casterDisplay) {
    const before = this.hostileCasts.length;
    this.hostileCasts = this.hostileCasts.filter((c) => c.caster !== casterDisplay);
    if (this.hostileCasts.length !== before) this.revision++;
  }

  /** Expire warnings past their window. Runs from tick(), so alerts clear during lulls. */
  pruneHostileCasts(now) {
    const before = this.hostileCasts.length;
    this.hostileCasts = this.hostileCasts.filter(
      (c) => now - c.ts <= (c.ttlMs ?? HOSTILE_CAST_TTL_MS) && c.ts <= now,
    );
    if (this.hostileCasts.length !== before) this.revision++;
  }

  handleMiss(event) {
    const attacker = this.resolve(event.attacker);
    const target = this.resolve(event.target);
    const attackerFriendly = this.isFriendly(attacker.name);
    const targetFriendly = this.isFriendly(target.name);

    // A miss alone does not start a fight — otherwise a stray swing at a passing mob
    // opens an encounter with 0 damage and an ever-growing duration.
    if (!this.current || this.current.closed) return;

    if (attackerFriendly && !targetFriendly) {
      this.current.addMiss({
        name: attacker.name,
        ts: event.ts,
        isPet: attacker.isPet,
        ability: event.ability,
      });
      this.revision++;
      return;
    }

    // The other direction — a mob swinging at a friendly who avoided it — is defense
    // credit for the taken view: dodges and ripostes are why the damage-taken number
    // is as low as it is, and hiding them would make a good tank look merely lucky.
    if (!attackerFriendly && targetFriendly) {
      this.current.addAvoidTaken({
        name: target.name,
        avoidance: event.avoidance ?? 'miss',
        ts: event.ts,
      });
      this.revision++;
    }
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
    const who = this.resolve(event.who);

    // Direction check: "<who> has been charmed." covers BOTH a mob joining us and an
    // enemy taking a group member. When the who resolves friendly it is the latter —
    // roster-charming a player would credit the enemy's new weapon to the group, so
    // it becomes a member-state alert instead. The isPet exclusion keeps an already-
    // charmed mob (which resolves to its friendly owner) on the mob path, where a
    // re-charm re-attributes it rather than raising a false member alert.
    if (!who.isPet && this.isFriendly(who.name)) {
      this.startCcState(who.display, 'charm', event.ts);
      return;
    }

    const charmer = this.attributeCharm(event.ts);
    if (!charmer) return;

    // The RAW name, not the resolved one: a re-charm of an already-charmed mob
    // resolves to its OWNER (that is the fold that makes its damage count), and
    // registering the owner as their own pet would silently drop the real charm.
    this.roster.charm(event.who, charmer);
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

  /**
   * A status effect landed on someone.
   *
   * Only effects on FRIENDLIES become member states — "a shin ghoul knight has been
   * mesmerized." is the group's own CC working as intended, seen 535 times in the
   * live log, and alerting on it would bury the one line that matters: the same
   * wording with the cleric's name in it. The raw effect word is folded through
   * CC_EFFECTS so mesmerized/entranced/captivated all read as the one mez state,
   * and everything outside the table (rooted, poisoned) is deliberately dropped.
   *
   * "awakened" is a mez END in disguise and clears rather than starts a state.
   */
  handleEffect(event) {
    const who = this.resolve(event.who);

    if (event.effect === 'awakened') {
      this.endCcState(who.display, 'mez');
      return;
    }

    const effect = CC_EFFECTS[event.effect];
    if (!effect) return;
    // A pet resolves to its owner, so a friendly pet passes here through the owner's
    // name while an enemy's pet fails with its enemy owner — no pet special-casing.
    if (!this.isFriendly(who.name)) return;
    this.startCcState(who.display, effect, event.ts);
  }

  /** "You are no longer stunned." — the explicit end-line the state was waiting for. */
  handleEffectEnd(event) {
    const effect = CC_EFFECTS[event.effect];
    if (!effect) return;
    this.endCcState(this.resolve(event.who).display, effect);
  }

  /** Start or refresh a member CC state. Keyed who|effect: refresh, never stack. */
  startCcState(who, effect, ts) {
    const existing = this.ccStates.find((s) => s.who === who && s.effect === effect);
    if (existing) {
      existing.ts = ts;
    } else {
      this.ccStates.push({ who, effect, ts });
    }
    this.revision++;
  }

  /** Clear a member CC state, or with effect null every state the member holds. */
  endCcState(who, effect) {
    const before = this.ccStates.length;
    this.ccStates = this.ccStates.filter(
      (s) => s.who !== who || (effect !== null && s.effect !== effect),
    );
    if (this.ccStates.length !== before) this.revision++;
  }

  /**
   * Expire CC states past the cap. Runs from tick(), like warning pruning, so a
   * chip whose end-line never came (charm has none) still leaves during a lull.
   */
  pruneCcStates(now) {
    const before = this.ccStates.length;
    this.ccStates = this.ccStates.filter(
      (s) => now - s.ts <= CC_STATE_CAP_MS && s.ts <= now,
    );
    if (this.ccStates.length !== before) this.revision++;
  }

  handleDeath(event) {
    // A charm ends with the mob, whichever side killed it.
    this.roster.uncharm(event.target);

    const target = this.resolve(event.target);
    // Encounter or not, a dead caster's warning is over. Friendlies never have one,
    // so this is a no-op for player and pet deaths. Its timers stop predicting too —
    // though what the fight already learned still exports when the encounter closes.
    this.clearHostileCastsFrom(target.display);
    this.rhythms.dropCaster(target.display);
    // Death outlives every status effect — a MEZZED chip on a corpse is a lie.
    this.endCcState(target.display, null);

    if (!this.current || this.current.closed) return;
    if (this.isFriendly(target.name)) {
      // A player dying does not end the pull — but it is the single most important
      // fact in the damage-taken view, so it is recorded before the early return.
      // A pet's death is marked as such and never counts as its owner's.
      this.current.recordDeath({
        name: target.name,
        killer: event.attacker ? this.resolve(event.attacker).name : null,
        ts: event.ts,
        isPet: target.isPet,
      });
      this.revision++;
      return;
    }
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
    // The casters are in the zone you left; their warnings go with them — and a
    // zone line means the player is MOVING, which no mez or stun survives.
    this.hostileCasts = [];
    this.ccStates = [];
    this.revision++;
  }

  closeCurrent(reason, ts) {
    if (!this.current || this.current.closed) return;
    this.current.close(reason, ts ?? this.current.lastDamageTs);
    this.last = this.current;
    this.current = null;
    this.onEncounterEnd?.(this.last);
    this.flushRhythms();
  }

  /**
   * Hand a closing fight's qualified rhythms to whoever persists them, then start
   * the tracker clean. Runs on the real close paths only — reset() skips it.
   */
  flushRhythms() {
    const learned = this.rhythms.learned();
    if (learned.length) this.onRhythmsLearned?.(learned);
    this.rhythms.reset();
  }

  /** Rhythms learned in previous fights, from the persistent store (see main). */
  setKnownRhythms(rhythms) {
    this.rhythms.setKnown(rhythms);
  }

  /**
   * Advance time without feeding a line. Called on a timer by the main process so an
   * encounter still times out when the log goes quiet.
   * @param {number} [now]
   */
  tick(now = this.clock()) {
    this.pruneHostileCasts(now);
    this.pruneCcStates(now);
    if (this.current && !this.current.closed && this.current.update(now)) {
      this.last = this.current;
      this.current = null;
      this.revision++;
      this.onEncounterEnd?.(this.last);
      this.flushRhythms();
    }
  }

  /** Discard the running encounter (the Ctrl+Shift+R hotkey). */
  reset() {
    this.current = null;
    this.last = null;
    this.casts.clear();
    this.hostileCasts = [];
    this.ccStates = [];
    // No flush: a disowned fight teaches nothing on the record, same as history.
    this.rhythms.reset();
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
    // Warnings ride the snapshot rather than a channel of their own, and they exist
    // in BOTH branches: the pull often opens with the mob's first cast, before any
    // damage line has created an encounter — precisely the moment a warning matters.
    // `remainingMs` is computed here so the renderer needs no notion of log time.
    const hostileCasts = this.hostileCasts.map((c) => {
      const ttl = c.ttlMs ?? HOSTILE_CAST_TTL_MS;
      return {
        id: c.id,
        caster: c.caster,
        ability: c.ability,
        category: c.category,
        tier: c.tier,
        victim: c.victim ?? null,
        remainingMs: Math.min(ttl, Math.max(0, ttl - (now - c.ts))),
      };
    });

    // Member CC states travel alongside the warnings for the same reason they do:
    // the cleric getting mezzed on the pull, before any damage line, is precisely
    // when the chip matters. remainingMs runs against the safety cap, not against
    // any claimed effect duration — the log states none and we invent none.
    const memberEffects = this.ccStates.map((s) => ({
      who: s.who,
      effect: s.effect,
      remainingMs: Math.max(0, CC_STATE_CAP_MS - (now - s.ts)),
    }));

    // Timers only exist while a fight is running: a prediction about a mob nobody is
    // fighting is a promise the log can't keep. Warnings are facts and show anytime;
    // timers are estimates and need the fight live to stay grounded.
    const castTimers = this.current && !this.current.closed
      ? this.rhythms.timers(now).map((t) => {
          const cls = classify(t.ability);
          return { ...t, category: cls?.category ?? null, tier: cls?.tier ?? 0 };
        })
      : [];

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
        hostileCasts,
        castTimers,
        memberEffects,
      };
    }

    // Rows only ever exist for combatants that damage was credited to, and damage is
    // only credited to friendlies, so "show everyone" needs no filter at all. The
    // roster is consulted purely to narrow that set down to the group.
    const include = (name) =>
      !this.groupOnly || name === UNKNOWN || this.roster.includes(name, true);
    const snap = enc.snapshot(now, { includeNames: include });
    return {
      ...snap,
      idle: false,
      zone: this.zone,
      self: this.selfName,
      hostileCasts,
      castTimers,
      memberEffects,
    };
  }
}

export { parseLogFilename };
