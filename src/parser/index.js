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
import { matchRule, spellStem } from './rules.js';
import { resolveEntity, looksLikePlayerName, nearestName, stripArticle } from './entities.js';
import { Roster, parseLogFilename } from './roster.js';
import { Encounter, DEFAULTS } from './encounter.js';
import { classify, UNKNOWN_GROUP } from './spellwatch.js';

/** Row name used when damage cannot be attributed to anyone (see attributeNonMelee). */
export const UNKNOWN = 'Unknown';

/** How long after a cast starts we are still willing to blame it for stray damage. */
const CAST_WINDOW_MS = 2000;

/**
 * How long after a pet-only buff's cast its landing line may still be paired with it.
 * The observed gap is 5–7s ("Khanvikt begins casting Augment Death IV." → "Kibektik's
 * eyes gleam with madness."), which is what the cast table's own TTL already covers.
 */
const PET_BUFF_WINDOW_MS = 10_000;

/**
 * Spells that can only ever land on a pet.
 *
 * Matched by NAME for exactly the reason charm attribution is: several people are
 * casting at any moment, and only one of them is casting Augment Death. The landing
 * line alone proves nothing — "Khanvikt shrinks." follows the shaman's Shrink and
 * Khanvikt is a player — so it is the pairing that carries the evidence.
 */
const PET_BUFF_SPELL_RE = /\b(?:augment death|tiny companion)\b/i;

/**
 * Casts that are summoning a pet, recognised by the SHAPE of the spell name.
 *
 * The plan hoped a bare cast would be enough — "any friendly cast arms a weak slot
 * that only a previously-unseen name can consume" — but that does not survive the
 * live log or the test suite. Two players casting seconds apart is structurally
 * identical to a summon followed by its pet:
 *
 *   Emalina casts Greater Healing V, then Rhain casts Beguile   <- Rhain is a PLAYER
 *   Rhain casts Sagar's Animation,  then Gann casts Center      <- Gann is a PET
 *
 * Every player is previously-unseen exactly once, so "unseen" cannot tell them apart
 * and the unconstrained version folded a groupmate into a healer's row. The spell name
 * is the only thing that distinguishes the two, which is the same conclusion charm
 * attribution reached (see CHARM_SPELL_RE).
 *
 * Deliberately structural rather than enumerated: every magician animation in the log
 * is "<Something>'s Animation" (Sagar's, Aanya's, Yegoreff's, Boltran's, Shalee's,
 * Kintaz's, with and without roman numerals), so the family is matched by its form and
 * a new one needs no maintenance. Necromancer and shadowknight pets need none of this
 * — they print "animates an undead servant.", which names the owner outright.
 */
const SUMMON_SPELL_RE = /(?:'s Animation\b|\bSummoning\b|\bFamiliar\b|\bAnimate Dead\b)/i;

/** How long a mapping-command acknowledgement stays on screen. */
export const NOTICE_TTL_MS = 6000;

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

/**
 * "Gann healed himself" — the target of a reflexive heal is the healer.
 *
 * The pronoun is ONLY ever used to redirect the target back to the healer. It is not,
 * and must not become, a classification signal: it tracks the healing EFFECT, not the
 * entity. That was tested against the full live log and is wrong in both directions —
 * "Emalina healed itself" 903 times (Blessing of the Knight) and Emalina is a real
 * player; "Gann healed himself" 366 times (Blessing of the Squire) and Gann is
 * provably a pet, summoned five seconds after "Rhain begins casting Sagar's Animation."
 * Both are proc-heals, which report neuter or gendered by their own definition
 * whatever owns them. Do not rediscover this.
 */
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
    this.zone = null;
    /** Bumped whenever a snapshot would differ, so the UI can skip idle repaints. */
    this.revision = 0;
    /** Lines that parsed but matched no rule — surfaced in the settings window. */
    this.unmatchedCount = 0;

    /**
     * Every canonical name this session has ever resolved.
     *
     * "Previously unseen" is the whole basis of summon binding: a summoned pet's
     * generated name has, by construction, never appeared before the summon that
     * created it, so a name that HAS appeared before cannot be the pet that just
     * came out of one.
     * @type {Set<string>}
     */
    this.seenNames = new Set();
    /** Log time of the last line fed, so resolve() can reason about the pending summon. */
    this.lastTs = 0;

    /**
     * Every `caster|ability` pair seen CAST this session.
     *
     * Unlike this.casts it is never pruned: it records what has ever been cast, not
     * what is in flight, and that is exactly the question "is this a proc?" asks. The
     * warder's abilities split cleanly — Ice Spear, Tainted Breath and Sicken are cast
     * thousands of times, while Ykesha, Ignite and the Spirit of <element> Strike
     * family deal 2,700 hits and are never cast once.
     * @type {Set<string>}
     */
    this.castObserved = new Set();

    /**
     * Acknowledgements for the in-game mapping command, riding the same snapshot as
     * the warnings. The player cannot see the parser, so a command that silently does
     * nothing is worse than no command at all.
     * @type {Array<{id: number, text: string, ts: number}>}
     */
    this.notices = [];
    this.noticeSeq = 0;
    /**
     * Called with the full pet mapping whenever the in-game command changes it, so
     * main can persist it to config. The parser stays pure Node and owns no files.
     */
    this.onPetOwnersChanged = options.onPetOwnersChanged ?? null;
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
    this.lastTs = event.ts;

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
        const caster = this.resolve(event.attacker, true);
        this.casts.set(caster.name, {
          ability: event.ability,
          ts: event.ts,
        });
        this.noteCastObserved(caster, event.ability);
        // A summon-shaped cast weakly arms the "a pet is about to appear" slot. The
        // magician animation prints no flavour line at all, so the cast is the only
        // evidence there is for that class — and requiring PROVEN standing (not merely
        // a player-shaped name) is what keeps a bee that has done nothing but sting the
        // group from arming it.
        if (!caster.isPet && event.ability && SUMMON_SPELL_RE.test(event.ability) &&
            this.isProvenFriendly(caster.name)) {
          this.roster.notePendingSummon(caster.name, event.ts, { strong: false });
        }
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
      case 'pet-summon':
        this.handlePetSummon(event);
        break;
      case 'pet-buff':
        this.handlePetBuff(event);
        break;
      case 'pet-command':
        this.handlePetCommand(event);
        break;
      case 'group':
      case 'who':
      case 'targeted':
      case 'pet-owner':
      case 'player-proof':
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
  /**
   * @param {string} raw
   * @param {boolean} [acting] true when this name is the one DOING something on the
   *   line. Only an acting name may consume a pending summon: a pet announces itself
   *   by swinging, casting or healing, whereas the first thing the log usually says
   *   about a MOB is that we hit it — and binding on that would fold an enemy
   *   straight into a player's row.
   */
  resolve(raw, acting = false) {
    const entity = resolveEntity(raw, this.selfName);
    if (entity.isPet) return entity;

    const firstSight = entity.name !== '' && !this.seenNames.has(entity.name);
    if (entity.name) this.seenNames.add(entity.name);

    const owner = this.roster.ownerOf(entity.name)
      ?? (firstSight && acting ? this.bindPendingSummon(entity.name) : null);
    if (owner) {
      return { name: owner, owner, isPet: true, display: entity.display };
    }
    return entity;
  }

  /**
   * A name we are willing to show as a damage-dealing row.
   *
   * The order below is the order of how much the log actually proves. Membership the
   * game stated outright comes first; then behaviour, which is fact; and only last the
   * shape of the name, which is a guess. That last step is what read the whole Plane
   * of Sky bee island as friendly — "Bzzazzt" is a single capitalized token with no
   * article, so it passed for a player, and the parser scored no damage in either
   * direction and raised none of the 639 Deadly Poison warnings that killed the group.
   */
  isFriendly(name) {
    if (name === UNKNOWN) return true;

    // The user's own pin, and the game stating membership, outrank everything below.
    if (this.roster.overridesOff.has(name)) return false;
    if (this.roster.overridesOn.has(name)) return true;
    if (this.roster.isConfirmedMember(name)) return true;

    // Behaviour outranks name shape. An entity the group is currently fighting is an
    // enemy however player-shaped its name is — the same reasoning isHostileCaster has
    // always used, which isFriendly simply never learned — and so is one caught
    // trading damage with a confirmed member.
    if (this.roster.isHostileByAction(name)) return false;
    if (this.current && !this.current.closed && this.current.engagedNpcs.has(name)) return false;

    // A name the game called an NPC is not a player, whatever its shape. This keeps a
    // single-word named mob ("Zevrex") from being mistaken for a group member.
    if (this.roster.knownNpcs.has(name) && !this.roster.knownPlayers.has(name)) {
      return this.roster.includes(name, false);
    }
    return this.roster.includes(name, false) || looksLikePlayerName(name);
  }

  /**
   * A friendly with standing beyond the spelling of their name.
   *
   * This is the third state the identity work needed. An article-less single token
   * that nobody has proven anything about is UNKNOWN — not a player — and while it
   * still gets its own visible row (dropping its damage would make the group total
   * quietly wrong, and requiring proof before showing ANYTHING is what made the
   * "target everything first" approach unusable), it is not trusted to explain stray
   * damage or to have summoned a pet. Standing means one of: the user pinned it, it is
   * the logging character, the log said it joined the group, it spoke on a channel,
   * or it has actually damaged an NPC.
   */
  isProvenFriendly(name) {
    if (name === UNKNOWN) return false;
    if (!this.isFriendly(name)) return false;
    return this.roster.includes(name, false) || this.roster.knownPlayers.has(name);
  }

  /**
   * First sight of a name while a summon is pending — bind it to the summoner.
   *
   * Guarded on the same principle everywhere else here: positive proof in both
   * directions, never inference from absence. A name with player proof is never
   * claimed, one already proven hostile is never claimed, and one torn down before
   * is never claimed again.
   *
   * @returns {string|null} the owner bound, or null
   */
  bindPendingSummon(name) {
    // A summoned pet's generated name is player-SHAPED ("Kibektik", "Gann"); anything
    // carrying an article or a space is a mob and was never in question.
    if (!looksLikePlayerName(name)) return null;
    if (this.roster.hasPlayerProof(name)) return null;
    if (this.roster.isHostileByAction(name)) return null;

    const pending = this.roster.takePendingSummon(this.lastTs);
    if (!pending) return null;

    const owner = this.roster.bindPet(name, pending.owner, { weak: pending.weak });
    if (owner) this.revision++;
    return owner;
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
    const attacker = this.resolve(event.attacker, true);
    const target = this.resolve(event.target);

    const attackerFriendly = this.isFriendly(attacker.name) || this.isUnownedPet(attacker.name);
    const targetFriendly = this.isFriendly(target.name);

    if (attackerFriendly && targetFriendly) {
      // One of the two is misclassified — friendlies do not damage each other. Work
      // through the possibilities in order of how much the log proves, and re-score
      // the line the moment one of them resolves.
      if (this.resolveFriendlyFire(event, attacker, target)) {
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
        proc: this.isProc(attacker, event),
      });
      this.revision++;
      return;
    }

    if (targetFriendly) {
      // The spell landed, so the cast it was warning about is over. Spells only: a
      // melee swing carries the ability "Hit", which keys no warning and must never
      // be allowed to clear one.
      if (event.source === 'spell') {
        this.resolveHostileCast(attacker.display, event.ability);
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
   * Both sides of a damage line read as friendly, which cannot be true. Work out
   * which reading was wrong, in order of how much the log actually proves.
   *
   *   1. A charm broke. A charmed mob resolves to its owner and so IS friendly right
   *      up until the break, which EQ Legends announces with no line whatsoever.
   *   2. A pet binding made from bare cast adjacency was wrong. That guess is the
   *      cheapest thing on the table, so it is what gives way first — an entity
   *      trading blows with the group was never anybody's pet.
   *   3. One side is an enemy whose name merely looks like a player's. Whichever side
   *      is NOT a confirmed group member is the enemy. Confirmed membership only, on
   *      purpose: keying off the implicit set would let one bad guess cascade.
   *
   * @returns {boolean} true when something changed and the line deserves a re-score
   */
  resolveFriendlyFire(event, attacker, target) {
    if (this.breakCharm(event)) return true;
    if (this.breakWeakPetBinding(attacker, target)) return true;
    return this.markHostileFromDamage(attacker, target);
  }

  /**
   * Tear down a weak pet binding that has just produced an impossible line.
   *
   * Deliberately not conditioned on who the other side is: a weak binding is a guess
   * made from nothing but "a friendly was casting and then this name appeared", and
   * the first time it implies a friendly hitting a friendly, the guess is what is
   * wrong. unbindPet also blacklists the name, so the next summon that happens to
   * fire nearby cannot claim it all over again.
   */
  breakWeakPetBinding(attacker, target) {
    for (const side of [attacker, target]) {
      if (!side.isPet || !side.owner) continue;
      if (!this.roster.isWeaklyBoundPet(side.display)) continue;
      if (this.roster.unbindPet(side.display)) {
        this.revision++;
        return true;
      }
    }
    return false;
  }

  /** Mark whichever side of a friendly-fire line is not a confirmed member as hostile. */
  markHostileFromDamage(attacker, target) {
    for (const [side, other] of [[attacker, target], [target, attacker]]) {
      // A pet resolves to its OWNER, so marking here would brand the owner an enemy.
      if (side.isPet) continue;
      if (!this.roster.isConfirmedMember(other.name)) continue;
      if (this.roster.isConfirmedMember(side.name)) continue;
      if (this.roster.knownPlayers.has(side.name)) continue;
      if (this.roster.noteHostileByAction(side.name)) {
        this.revision++;
        return true;
      }
    }
    return false;
  }

  /**
   * A summon flavour line — "Khanvikt animates an undead servant." — arms the slot
   * that the next previously-unseen name will be bound to.
   *
   * The rule table hands us whoever the line named without vetting them, because the
   * same wording arrives from "a shadowknight" and "a necro acolyte". Requiring PROVEN
   * standing here is what keeps an enemy's pet from ever folding into a group row.
   */
  handlePetSummon(event) {
    const owner = this.resolve(event.owner, true);
    if (owner.isPet || !this.isProvenFriendly(owner.name)) return;
    this.roster.notePendingSummon(owner.name, event.ts, { strong: true });
    this.revision++;
  }

  /**
   * A pet-only buff landed on someone — bind them to whoever cast it.
   *
   * The tighter of the two bindings, and the one that corrects a mis-bind the temporal
   * path may have made: matching on the SPELL name rather than on "the only caster in
   * flight" survives a busy fight, which is exactly why charm attribution works the
   * same way.
   */
  handlePetBuff(event) {
    const who = this.resolve(event.who);
    if (who.isPet) return;                          // already bound, or a backtick pet
    if (this.roster.hasPlayerProof(who.name)) return;

    const caster = this.attributePetBuff(event.ts);
    if (!caster || caster === who.name) return;
    if (this.roster.bindPet(who.name, caster, { weak: false })) this.revision++;
  }

  /** @returns {string|null} the friendly whose recent cast was a pet-only buff */
  attributePetBuff(ts) {
    this.pruneCasts(ts);
    let best = null;
    for (const [name, cast] of this.casts) {
      if (ts - cast.ts > PET_BUFF_WINDOW_MS) continue;
      if (!cast.ability || !PET_BUFF_SPELL_RE.test(cast.ability)) continue;
      if (!this.isProvenFriendly(name)) continue;
      if (!best || cast.ts > best.ts) best = { name, ts: cast.ts };
    }
    return best?.name ?? null;
  }

  /**
   * The in-game mapping command, typed into any chat channel the player has available.
   *
   * The parser's only input is the log, so a line the client writes to the log is the
   * one control channel that needs no alt-tab. Note that your OWN pet usually needs no
   * command at all — pet-reports-to-master learns it from "<Pet> told you, '… Master.'"
   * and that fires solo. This exists for OTHER players' pets and for a pet that never
   * reports.
   */
  handlePetCommand(event) {
    if (event.action === 'list') {
      const entries = this.petMappings();
      this.noteNotice(
        entries.length
          ? `Pets: ${entries.map((e) => `${e.pet} = ${e.owner}`).join(', ')}`
          : 'No pet mappings yet',
        event.ts,
      );
      return;
    }

    // Say so rather than doing nothing. There is no echo on this channel, so silence
    // is indistinguishable from the feature being broken — which is exactly how it was
    // reported after `pets Jonarn = Khanvikt` fell through on the plural. Note this only
    // ever answers something that already looked like an attempt at the command: the
    // rule required the keyword AND an equals sign to get here, so ordinary talk about
    // pets still passes through as chat and says nothing.
    if (event.action === 'malformed') return this.notePetSyntax(event.ts);

    const pet = stripArticle(String(event.pet ?? '').trim());
    if (!looksLikePlayerName(pet)) return this.notePetSyntax(event.ts);

    if (event.action === 'clear') {
      const had = this.roster.petOwners.delete(pet) ||
        this.roster.unbindPet(pet, { includeStrong: true });
      // Blacklisted either way: "not a pet" is the user overruling the log, and the
      // log would otherwise re-learn the same binding from the next summon.
      this.roster.notPets.add(pet);
      this.noteNotice(had ? `${pet} unmapped` : `${pet} was not mapped`, event.ts);
      this.emitPetOwners();
      this.revision++;
      return;
    }

    const typed = String(event.owner ?? '').trim();
    if (!/^[A-Za-z]{2,32}$/.test(typed) || typed.toLowerCase() === pet.toLowerCase()) {
      return this.notePetSyntax(event.ts);
    }

    // The owner is the half a typo actually damages. Get the pet's name wrong and the
    // mapping just lies there matching nothing; get the OWNER wrong and the pet's damage
    // is dutifully folded into a person who does not exist, so the overlay grows a
    // phantom row beside the real one. That is what `pets Jaber = Kodomony` did — one
    // letter away from Kadomony, typed twice, acknowledged both times as a success.
    const owner = this.matchFriendly(typed);
    if (!owner) {
      const near = nearestName(typed, this.friendlyNames());
      // Refuse rather than auto-correct. A near miss is nearly always a typo, but
      // "nearly" is not the standard this overlay holds itself to anywhere else, and
      // retyping one line costs less than silently scoring a pet onto the wrong player.
      if (near) return this.noteNotice(`No ${typed} here — did you mean ${near}?`, event.ts);
      if (!looksLikePlayerName(typed)) return this.notePetSyntax(event.ts);
    }

    const name = owner ?? typed;
    this.roster.notPets.delete(pet);
    this.roster.learnedPetOwners.delete(pet);
    this.roster.petOwners.set(pet, name);
    this.roster.implicit.delete(pet);
    // A name nobody here answers to is honoured — the owner may simply not have acted
    // yet — but never silently: said plainly, it is a typo the player can still catch.
    this.noteNotice(owner ? `${pet} = ${name}` : `${pet} = ${name} (not seen yet)`, event.ts);
    this.emitPetOwners();
    this.revision++;
  }

  /**
   * The names of everyone currently fighting alongside us, pets excluded.
   *
   * Used only to sanity-check a name the player typed, never to attribute damage, so it
   * pools every notion of "one of us" the roster holds rather than picking the strictest.
   * Anything already owned by somebody is dropped: a pet is not a candidate to own a pet.
   */
  friendlyNames() {
    const out = new Set([this.selfName, ...this.roster.members(false), ...this.roster.knownPlayers]);
    for (const name of out) {
      if (this.roster.ownerOf(name)) out.delete(name);
    }
    return [...out];
  }

  /** @returns {string|null} the friendly this typed name IS, fixing capitalization only */
  matchFriendly(typed) {
    if (this.roster.hasPlayerProof(typed) || this.roster.includes(typed, false)) return typed;
    const lower = typed.toLowerCase();
    return this.friendlyNames().find((n) => n.toLowerCase() === lower) ?? null;
  }

  /**
   * Reprint the syntax after a command we heard but could not read.
   *
   * Deliberately the same line for every kind of near miss rather than a diagnosis per
   * failure: the player does not need to know WHICH of the two names offended the name
   * rules, only what a correct line looks like, and one sentence they can copy is worth
   * more than a precise complaint they then have to translate.
   */
  notePetSyntax(ts) {
    this.noteNotice('Pet command: pet <Pet> = <Owner>', ts);
  }

  /**
   * Names that are getting a row of their own but that nothing has proven to be
   * players — the list of things that may need a pet mapping.
   *
   * The `petOwners` setting has existed since the beginning and nothing ever told the
   * player WHICH names needed it, so the feature was unusable unless you already knew
   * the answer. A name lands here when it fights alongside the group, has said nothing
   * on any channel, has never joined the group, has no owner and has never traded
   * damage with a confirmed member. That is precisely the honest "unknown" state:
   * probably somebody's pet, possibly a passer-by, and not for the parser to decide.
   */
  unmappedEntities() {
    const out = new Set();
    for (const name of this.roster.implicit) {
      if (name === this.selfName) continue;
      if (this.roster.hasPlayerProof(name)) continue;
      if (this.roster.ownerOf(name)) continue;
      if (this.roster.isHostileByAction(name)) continue;
      out.add(name);
    }
    // Anything the game itself called an NPC while it was fighting for us is a pet by
    // definition — this is the `Targeted (NPC): Gann` case, which is as sure as it gets.
    for (const name of this.roster.knownNpcs) {
      if (this.roster.ownerOf(name) || this.roster.hasPlayerProof(name)) continue;
      if (this.roster.isHostileByAction(name)) continue;
      if (this.isUnownedPet(name)) out.add(name);
    }
    return [...out].sort();
  }

  /** Every pet mapping in force, configured and learned alike. */
  petMappings() {
    const out = new Map();
    for (const { pet, owner, weak } of this.roster.learnedPets()) out.set(pet, { pet, owner, weak });
    for (const [pet, owner] of this.roster.petOwners) out.set(pet, { pet, owner, weak: false });
    return [...out.values()].sort((a, b) => a.pet.localeCompare(b.pet));
  }

  /** Hand the configured mapping to whoever persists it (main writes it to config). */
  emitPetOwners() {
    this.onPetOwnersChanged?.(Object.fromEntries(this.roster.petOwners));
  }

  /** Show the player a short-lived line in the alerts window. */
  noteNotice(text, ts) {
    this.notices.push({ id: ++this.noticeSeq, text, ts });
    this.revision++;
  }

  pruneNotices(now) {
    const before = this.notices.length;
    this.notices = this.notices.filter((n) => now - n.ts <= NOTICE_TTL_MS && n.ts <= now);
    if (this.notices.length !== before) this.revision++;
  }

  /**
   * Record that this caster has been seen casting this ability, and un-label any proc
   * row already credited for the pair.
   *
   * Keyed on the DISPLAY name so a beastlord and their warder do not share a bucket:
   * "Rhale`s warder" casting Ice Spear says nothing about whether Rhale procs it.
   */
  noteCastObserved(caster, ability) {
    if (!ability) return;
    const key = `${caster.display}|${spellStem(ability)}`;
    if (this.castObserved.has(key)) return;
    this.castObserved.add(key);
    // A fight must never end with an ability mislabelled because its first hit
    // happened to arrive before its first cast line.
    if (this.current && !this.current.closed &&
        this.current.unmarkProc(caster.name, ability, caster.isPet)) {
      this.revision++;
    }
  }

  /**
   * Is this damage a weapon proc — an ability that deals damage but is never cast?
   *
   * Spell-source damage only. A DoT tick arrives long after its cast and is already
   * its own bucket; melee and damage shields are not spells at all. The test is
   * simply whether a cast line for this exact caster and ability has ever been seen,
   * which is what makes it read the log rather than guess from a table of names.
   */
  isProc(attacker, event) {
    if (event.source !== 'spell' || !event.ability) return false;
    return !this.castObserved.has(`${attacker.display}|${spellStem(event.ability)}`);
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
      // Proven standing, not a player-shaped name: an entity nobody has established
      // anything about is UNKNOWN, and crediting it with damage on the strength of its
      // spelling is the same mistake that made a PoSky bee a group member.
      if (this.isProvenFriendly(name)) candidates.push({ name, ability: cast.ability ?? 'Unknown' });
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
      // Which of the player's six switches decides whether this draws. An unlisted
      // cast lands in the "unrecognized" group rather than in no group at all — a
      // warning with nothing to gate it on would be ungovernable by settings, and the
      // parser must not be the thing deciding what the player wants to see.
      group: cls?.group ?? UNKNOWN_GROUP,
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
      // Summons keep their own switch (`summonAlerts`) rather than joining the six:
      // they announce a fact that already happened in a banner shape of their own,
      // and they had a switch before the groups existed.
      group: 'summon',
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
   * A friendly resisted a hostile caster's spell.
   *
   * A resist is a resolution: the volley fired and we shrugged it off, so the warning
   * has nothing left to warn about. Outgoing resists — the mob shrugging off OURS —
   * say nothing about what the mob is doing to us and are ignored.
   */
  handleResist(event) {
    if (!event.ability) return;
    const attacker = this.resolve(event.attacker);
    const target = this.resolve(event.target);
    if (!this.isFriendly(target.name)) return;
    if (this.isFriendly(attacker.name)) return;

    this.resolveHostileCast(attacker.display, event.ability);
  }

  /**
   * A cast RESOLVED — its spell landed or was resisted — so its warning is spent.
   *
   * The third resolution alongside the interrupt confirmation and the caster's death,
   * and the one that does most of the work: measured over the live log, 3,857 warnings
   * had their spell resolve while the chip was still up, a median of one second in,
   * and every one of them then sat out the rest of a six-second TTL. That made 75% of
   * their screen time a cast that had already happened — which is precisely how a
   * warning window teaches the player to stop reading it. After this, a chip on screen
   * means the cast is still in flight and can still be stopped.
   *
   * Only the named spell clears, unlike the interrupt path which clears every warning
   * from that caster: an interrupt line cannot say WHICH same-named mob was stopped,
   * but a damage line names the spell that landed, so there is no ambiguity to be
   * generous about.
   *
   * NPC heals print no landing line at all — the log never says a mob healed itself
   * except for the spells that do it visibly — so this never shortens a heal banner.
   * That is correct rather than an oversight: an uninterrupted heal has no observable
   * end, and the TTL is the only honest way to retire it.
   */
  resolveHostileCast(casterDisplay, ability) {
    if (!ability) return;
    const before = this.hostileCasts.length;
    this.hostileCasts = this.hostileCasts.filter(
      (c) => c.caster !== casterDisplay || c.ability !== ability || c.category === 'summon',
    );
    if (this.hostileCasts.length !== before) this.revision++;
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
    const attacker = this.resolve(event.attacker, true);
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

    const healer = this.resolve(event.attacker, true);
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
    // so this is a no-op for player and pet deaths. Its countdown rows leave at the
    // same moment — a countdown for a corpse is not information — but that is the
    // trigger engine's doing now: each shipped boss timer names its own caster's death
    // line as an early ender, which puts the rule in a pack a player can read rather
    // than in a tracker nobody could see. See src/triggers/seed-pack.js.
    this.clearHostileCastsFrom(target.display);
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
  }

  /**
   * Advance time without feeding a line. Called on a timer by the main process so an
   * encounter still times out when the log goes quiet.
   * @param {number} [now]
   */
  tick(now = this.clock()) {
    this.pruneHostileCasts(now);
    this.pruneCcStates(now);
    this.pruneNotices(now);
    if (this.current && !this.current.closed && this.current.update(now)) {
      this.last = this.current;
      this.current = null;
      this.revision++;
      this.onEncounterEnd?.(this.last);
    }
  }

  /** Discard the running encounter (the Ctrl+Shift+R hotkey). */
  reset() {
    this.current = null;
    this.last = null;
    this.casts.clear();
    this.hostileCasts = [];
    this.ccStates = [];
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
        group: c.group ?? UNKNOWN_GROUP,
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

    // Acknowledgements for the in-game mapping command. They ride the snapshot for
    // the same reason warnings do — the alerts window is the one surface that floats
    // over the game without taking a click away from it.
    const notices = this.notices.map((n) => ({
      id: n.id,
      text: n.text,
      remainingMs: Math.max(0, NOTICE_TTL_MS - (now - n.ts)),
    }));

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
        memberEffects,
        notices,
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
      memberEffects,
      notices,
    };
  }
}

export { parseLogFilename };
