/**
 * Who counts as "us".
 *
 * Three sources feed this, because only one of them is guaranteed to exist:
 *
 *  1. EXPLICIT — group join/leave/disband messages and /who output. Authoritative.
 *     The Phase 0 sample contained none, so the wording was long recorded as
 *     unverified; it is CONFIRMED now — 21 join/leave lines and 16 self forms appear
 *     in the live log, worded exactly as rules.js already had them.
 *  2. PROOF BY ACTION — things only a player can do (talk in a channel) and things
 *     only an enemy can do (damage a confirmed group member, or be attacked by one).
 *     Behaviour outranks name shape in both directions.
 *  3. IMPLICIT — anyone who damages an NPC and whose name looks like a player name.
 *     Always available, and it is what makes the overlay populate out of the box.
 *
 * Explicit membership always wins over the implicit heuristic: if the log ever says
 * someone left the group, no amount of swinging puts them back in it. Proof by action
 * sits between the two — it cannot overrule the game stating membership outright, but
 * it does overrule a guess made from the shape of a name.
 */

import { looksLikePlayerName, stripArticle } from './entities.js';

/**
 * How long after a summon FLAVOUR line ("Khanvikt animates an undead servant.") a
 * previously-unseen name may still be claimed as that summon's pet.
 *
 * Generous, because the flavour line names its owner outright: the only way it binds
 * the wrong thing is if some unrelated entity happens to appear first, and that
 * mis-bind is undone the moment the entity acts like an enemy (see unbindPet).
 */
const STRONG_SUMMON_WINDOW_MS = 30_000;

/**
 * The same, for a slot armed by a bare cast rather than a flavour line.
 *
 * The magician animation has NO flavour line at all — the only evidence is
 * "Rhain begins casting Sagar's Animation." five seconds before "Gann begins casting
 * Center." — so a cast has to be able to arm the slot. It is much weaker evidence,
 * so the window is short and any second caster in it voids the slot entirely.
 */
const WEAK_SUMMON_WINDOW_MS = 12_000;

export class Roster {
  /**
   * @param {string} selfName the logging character, from the eqlog_<Name>_<server>.txt filename
   */
  constructor(selfName) {
    this.selfName = selfName;
    /** @type {Set<string>} names seen in explicit group messages */
    this.explicit = new Set(selfName ? [selfName] : []);
    /** @type {Set<string>} names inferred from attacking NPCs */
    this.implicit = new Set(selfName ? [selfName] : []);
    /** @type {Set<string>} names the user pinned on or off in settings */
    this.overridesOn = new Set();
    this.overridesOff = new Set();
    /** True once an explicit group message has been seen this session. */
    this.hasExplicitData = false;

    /**
     * Named pets -> their owner, e.g. { Gann: 'Rhain' }.
     *
     * Most pets are written `<Owner>`s warder` and need no table (see entities.js), but
     * summoned pets get a proper name — "Gann" — that looks exactly like a player name.
     * The log never states whose they are, so entries come from two places:
     * a pet calling the logging character "Master" (automatic), and the user's own
     * mapping in settings (for everyone else's pets).
     * @type {Map<string, string>}
     */
    this.petOwners = new Map();

    /**
     * Names proven to belong to real players.
     *
     * Three proofs feed it, all of them things a mob or a pet cannot do:
     * "Targeted (Player): X", a group join/leave line, and speaking on a channel
     * (see rules.js's player-proof rule). Bare `says,` is deliberately NOT one of
     * them — mobs use it for summon call-outs — and neither is `tells you`, which
     * is how a pet reports to its Master.
     *
     * This set is what stops the pet-binding machinery from ever claiming a real
     * player as somebody's pet.
     */
    this.knownPlayers = new Set();
    /** Names the game called out as NPCs — includes every summoned pet. */
    this.knownNpcs = new Set();

    /**
     * Entities proven hostile by what they did, whatever their name looks like.
     *
     * `looksLikePlayerName` is a guess about spelling, and on the Plane of Sky it is
     * simply wrong: the bees are called Bzzazzt, Bazzt and Bzzzt — single capitalized
     * tokens, no article — so the parser read an entire raid zone as friendly, scored
     * none of the damage done to them and raised none of the 639 Deadly Poison
     * warnings that killed the group. Two actions land a name in here, both of them
     * positive proof rather than inference from absence:
     *
     *   - it damaged a CONFIRMED group member (explicit roster or self)
     *   - a confirmed group member damaged IT
     *
     * Confirmed membership only, deliberately: keying off the implicit set would let
     * one bad guess cascade into a second. The mark lasts the session — a mob does not
     * stop being a mob — and is cleared only by a character switch.
     */
    this.hostileByAction = new Set();

    /**
     * Mobs currently charmed, mapped to whoever charmed them.
     *
     * Kept apart from petOwners because the two have opposite lifetimes: petOwners is
     * durable configuration, while a charm lasts seconds and is revoked by inference.
     * Separating them means replacing the configured mapping cannot disturb a live
     * charm, and breaking a charm cannot delete the user's settings.
     * @type {Map<string, string>}
     */
    this.charmedPets = new Map();

    /**
     * Pets bound to an owner by inference from the log — summon adjacency and the
     * pet-only buff pairing — as opposed to petOwners, which holds the user's
     * configuration and the pet-calls-you-Master line.
     *
     * Kept separate for the same reason charmedPets is: replacing the settings
     * mapping must not erase what the log taught us. A pet reports to its Master on
     * every attack command, so that mapping re-learns itself within seconds; a summon
     * happens exactly once and never repeats.
     *
     * `weak` marks a binding made from a bare cast rather than a flavour line, which
     * is the only kind a later contradiction is allowed to tear down.
     * @type {Map<string, {owner: string, weak: boolean}>}
     */
    this.learnedPetOwners = new Map();

    /**
     * Names a learned binding was taken away from, so it can never be re-bound.
     *
     * A mob that briefly consumed a pending summon and then proved itself an enemy
     * must not be re-claimed by the next summon that happens to fire near it —
     * otherwise the same wrong answer arrives again a minute later.
     * @type {Set<string>}
     */
    this.notPets = new Set();

    /**
     * The friendly summon we are waiting to see a pet come out of.
     *
     * Summoned pets get a generated name ("Kibektik", "Gann") that the log never ties
     * to anyone. The tie has to come from adjacency: the summon happened, and the very
     * next never-before-seen name to act is what it produced. `ambiguous` is set when
     * a second friendly summon arrives while this one is still live — two summoners
     * firing at once makes the pairing a coin flip, and the honest answer is to bind
     * nothing and leave the pet its own visible row.
     * @type {{owner: string, ts: number, strong: boolean, ambiguous: boolean}|null}
     */
    this.pendingSummon = null;
  }

  /** Record that `owner` has charmed `pet`. Names are stored article-stripped. */
  charm(pet, owner) {
    const key = stripArticle(String(pet).trim());
    if (!key || !owner) return;
    // One charm per charmer: landing a new one releases the old.
    for (const [existing, holder] of this.charmedPets) {
      if (holder === owner) this.charmedPets.delete(existing);
    }
    this.charmedPets.set(key, owner);
  }

  uncharm(pet) {
    return this.charmedPets.delete(stripArticle(String(pet).trim()));
  }

  isCharmed(name) {
    return this.charmedPets.has(stripArticle(String(name).trim()));
  }

  clearCharms() {
    this.charmedPets.clear();
  }

  /**
   * Replace the pet-ownership table with the configured mapping.
   *
   * A wholesale replace, not a merge, so removing an entry in settings actually removes
   * it. Nothing is lost by dropping log-learned entries: a pet reports to its master on
   * every single attack command, so an automatic mapping reappears within seconds.
   */
  setPetOwners(mapping) {
    this.petOwners = new Map(
      Object.entries(mapping ?? {})
        .filter(([pet, owner]) => pet && owner)
        // Article-stripped, because that is the form every lookup arrives in. Without
        // this a mob-named pet entered as "a tal ghoul wizard" could never match.
        .map(([pet, owner]) => [stripArticle(pet.trim()), owner.trim()])
    );
  }

  /** @returns {string|null} the owner if `name` is a charmed mob or a known named pet */
  ownerOf(name) {
    const key = stripArticle(String(name).trim());
    return this.charmedPets.get(key)
      ?? this.petOwners.get(key)
      ?? this.learnedPetOwners.get(key)?.owner
      ?? null;
  }

  /**
   * Record that `pet` belongs to `owner`, learned from the log rather than configured.
   *
   * Refuses outright when the name has player proof: a real player must never be
   * folded into somebody else's row, and that guard is the whole reason knownPlayers
   * is fed from channel chat and group messages. A weak binding never displaces a
   * strong one, and a name already torn down once is never re-bound.
   *
   * @returns {string|null} the owner actually bound, or null if nothing was
   */
  bindPet(pet, owner, { weak = false } = {}) {
    const key = stripArticle(String(pet ?? '').trim());
    const ownerName = String(owner ?? '').trim();
    if (!key || !ownerName || key === ownerName) return null;
    if (this.notPets.has(key)) return null;
    if (this.hasPlayerProof(key)) return null;
    if (this.hostileByAction.has(key)) return null;
    if (this.petOwners.has(key)) return null;   // configuration and the Master line win

    const existing = this.learnedPetOwners.get(key);
    if (existing && !existing.weak && weak) return existing.owner;

    this.learnedPetOwners.set(key, { owner: ownerName, weak: Boolean(weak) });
    this.implicit.delete(key);
    return ownerName;
  }

  /**
   * Tear down a learned binding that the log has since contradicted, and remember
   * never to make it again. Strong bindings — a flavour line that named the owner
   * outright — are left alone; only the cast-adjacency guess is this cheap to undo.
   *
   * @returns {boolean} true if a binding was removed
   */
  unbindPet(pet, { includeStrong = false } = {}) {
    const key = stripArticle(String(pet ?? '').trim());
    const existing = this.learnedPetOwners.get(key);
    if (!existing) return false;
    if (!existing.weak && !includeStrong) return false;
    this.learnedPetOwners.delete(key);
    this.notPets.add(key);
    return true;
  }

  /** True when `name` holds a LEARNED binding made from the weaker cast adjacency. */
  isWeaklyBoundPet(name) {
    return this.learnedPetOwners.get(stripArticle(String(name).trim()))?.weak === true;
  }

  /** Pets bound from the log that the user has not confirmed in settings. */
  learnedPets() {
    return [...this.learnedPetOwners.entries()]
      .map(([pet, v]) => ({ pet, owner: v.owner, weak: v.weak }))
      .sort((a, b) => a.pet.localeCompare(b.pet));
  }

  /**
   * Arm the "a pet is about to appear" slot.
   * @param {boolean} strong true for a summon flavour line, false for a bare cast
   */
  notePendingSummon(owner, ts, { strong = false } = {}) {
    const ownerName = String(owner ?? '').trim();
    if (!ownerName) return;

    const p = this.pendingSummon;
    const window = p?.strong ? STRONG_SUMMON_WINDOW_MS : WEAK_SUMMON_WINDOW_MS;
    const live = p && ts >= p.ts && ts - p.ts <= window;

    if (!live) {
      this.pendingSummon = { owner: ownerName, ts, strong: Boolean(strong), ambiguous: false };
      return;
    }
    if (p.owner === ownerName) {
      p.ts = ts;
      p.strong = p.strong || Boolean(strong);
      return;
    }
    // A flavour line is real evidence and simply replaces a guess; a guess never
    // disturbs a flavour line. Two of the same weight cancel each other out.
    if (strong && !p.strong) {
      this.pendingSummon = { owner: ownerName, ts, strong: true, ambiguous: false };
      return;
    }
    if (!strong && p.strong) return;
    p.ambiguous = true;
  }

  /**
   * Consume the pending summon, if one is live and unambiguous.
   * @returns {{owner: string, weak: boolean}|null}
   */
  takePendingSummon(ts) {
    const p = this.pendingSummon;
    if (!p) return null;
    const window = p.strong ? STRONG_SUMMON_WINDOW_MS : WEAK_SUMMON_WINDOW_MS;
    if (ts < p.ts || ts - p.ts > window) {
      this.pendingSummon = null;
      return null;
    }
    if (p.ambiguous) return null;
    this.pendingSummon = null;
    return { owner: p.owner, weak: !p.strong };
  }

  /** A member the game itself named: the logging character, or an explicit group line. */
  isConfirmedMember(name) {
    return name === this.selfName || this.explicit.has(name);
  }

  /**
   * True when something only a player can do has been seen from this name.
   * Deliberately excludes the implicit roster, which is itself a name-shape guess.
   */
  hasPlayerProof(name) {
    return this.knownPlayers.has(name) || this.isConfirmedMember(name);
  }

  /** Record that `name` is an enemy, proven by action rather than guessed from shape. */
  noteHostileByAction(name) {
    const key = stripArticle(String(name).trim());
    if (!key || this.hasPlayerProof(key)) return false;
    if (this.hostileByAction.has(key)) return false;
    this.hostileByAction.add(key);
    this.implicit.delete(key);
    // Whatever we thought it was a pet of, it is not — and must never be again.
    this.learnedPetOwners.delete(key);
    this.notPets.add(key);
    return true;
  }

  isHostileByAction(name) {
    return this.hostileByAction.has(stripArticle(String(name).trim()));
  }

  /**
   * Mark a name as a proven player. Guarded on shape so that a mob shouting — or a
   * multi-word name arriving from a malformed chat line — can never land here and
   * quietly turn an NPC into a group member.
   */
  noteKnownPlayer(name) {
    const key = String(name ?? '').trim();
    if (!key || !looksLikePlayerName(key)) return false;
    if (this.knownPlayers.has(key)) return false;
    this.knownPlayers.add(key);
    this.knownNpcs.delete(key);
    // A proven player is nobody's pet and nobody's enemy.
    this.learnedPetOwners.delete(key);
    this.hostileByAction.delete(key);
    return true;
  }

  /**
   * Point the roster at a different logging character.
   *
   * A character switch means a different group, so everything learned about the old
   * one is discarded. This is the only event that clears membership — notably NOT
   * zoning, because a group zones together, and because clearing on zone would
   * retroactively hide members from the finished fight still on screen.
   */
  setSelf(name) {
    if (name === this.selfName) return;
    this.selfName = name;
    this.explicit = new Set(name ? [name] : []);
    this.implicit = new Set(name ? [name] : []);
    this.hasExplicitData = false;
    // Everything proven by action belonged to the old character's session too.
    this.hostileByAction.clear();
    this.learnedPetOwners.clear();
    this.notPets.clear();
    this.pendingSummon = null;
    this.clearOverrides();
  }

  /**
   * Apply a `group`, `who`, `targeted`, `pet-owner` or `player-proof` event from the
   * rule table.
   */
  applyEvent(event) {
    if (event.kind === 'player-proof') {
      this.noteKnownPlayer(event.who);
      return;
    }

    if (event.kind === 'who') {
      this.hasExplicitData = true;
      this.explicit.add(event.who);
      this.noteKnownPlayer(event.who);
      return;
    }

    if (event.kind === 'targeted') {
      if (event.targetKind === 'player') {
        this.noteKnownPlayer(event.who);
        this.knownPlayers.add(event.who);
        this.knownNpcs.delete(event.who);
      } else if (event.targetKind === 'npc') {
        this.knownNpcs.add(event.who);
        this.knownPlayers.delete(event.who);
        // An NPC is not a group member, however player-shaped its name looks.
        this.implicit.delete(event.who);
        this.explicit.delete(event.who);
      }
      return;
    }

    if (event.kind === 'pet-owner') {
      const owner = event.owner === 'You' ? this.selfName : event.owner;
      if (event.pet && owner) {
        const key = stripArticle(String(event.pet).trim());
        this.petOwners.set(key, owner);
        this.implicit.delete(key);
      }
      return;
    }

    if (event.kind !== 'group') return;

    this.hasExplicitData = true;
    // Joining or leaving a group is something only a player does — which makes every
    // one of these lines player proof, quite apart from what it says about membership.
    // Someone who left the group is still demonstrably not a pet and not a bee.
    if (event.who && event.who !== 'You') this.noteKnownPlayer(event.who);
    if (event.action === 'join') {
      this.explicit.add(event.who === 'You' ? this.selfName : event.who);
    } else if (event.action === 'leave') {
      this.explicit.delete(event.who === 'You' ? this.selfName : event.who);
    } else if (event.action === 'disband') {
      this.explicit = new Set(this.selfName ? [this.selfName] : []);
    }
  }

  /**
   * Record that `name` dealt damage to something hostile. Only names shaped like
   * player names are admitted, so "a froglok shin knight" attacking another mob
   * never lands in the roster.
   */
  noteFriendlyCombatant(name) {
    if (this.knownNpcs.has(name)) return;   // a pet or a mob, never a group member
    if (this.petOwners.has(name)) return;
    if (this.learnedPetOwners.has(name)) return;
    // Proof of hostility outranks the name-shape guess this method is built on.
    if (this.hostileByAction.has(name)) return;
    if (this.knownPlayers.has(name) || looksLikePlayerName(name)) this.implicit.add(name);
  }

  /** Pin a combatant on or off regardless of what the log says. */
  override(name, include) {
    if (include) {
      this.overridesOn.add(name);
      this.overridesOff.delete(name);
    } else {
      this.overridesOff.add(name);
      this.overridesOn.delete(name);
    }
  }

  clearOverrides() {
    this.overridesOn.clear();
    this.overridesOff.clear();
  }

  /**
   * @param {string} name canonical combatant name (pets already folded into their owner)
   * @param {boolean} groupOnly when true, restrict to confirmed group members
   */
  includes(name, groupOnly) {
    if (this.overridesOff.has(name)) return false;
    if (this.overridesOn.has(name)) return true;
    if (name === this.selfName) return true;
    // Fall back to the implicit set when the log never told us about the group,
    // otherwise "group only" would show just the player and look broken.
    if (groupOnly && this.hasExplicitData) return this.explicit.has(name);
    return this.implicit.has(name) || this.explicit.has(name);
  }

  members(groupOnly) {
    const source = groupOnly && this.hasExplicitData
      ? this.explicit
      : new Set([...this.implicit, ...this.explicit]);
    return [...source].filter((n) => !this.overridesOff.has(n)).sort();
  }
}

/**
 * Pull the character name out of an EverQuest log filename.
 * "eqlog_Rhale_oggok.txt" -> { character: "Rhale", server: "oggok" }
 */
export function parseLogFilename(filename) {
  const base = String(filename).replace(/\\/g, '/').split('/').pop() ?? '';
  const m = /^eqlog_([A-Za-z]+)_(.+?)\.txt$/i.exec(base);
  if (!m) return null;
  return { character: m[1], server: m[2] };
}
