/**
 * What the session has learned about who is who, carried between fights.
 *
 * Read this alongside the note at the top of index.js: **the roster no longer decides
 * whose damage counts.** The fight decides that — anyone who hits the mob we are
 * fighting is contributing, whoever they are — and this file exists only to SEED that
 * decision on the first line of a pull, and to answer identity questions the fight
 * cannot (whose pet is that, who did the player pin, who is the logging character).
 *
 * That demotion is the whole point. When membership gated scoring, one wrong answer
 * deleted a person for a session; now the worst a wrong answer does is put a row in
 * the wrong column of one fight, and the next line usually corrects it.
 *
 * Four sources, in descending order of how much they prove:
 *
 *  1. FACTS — the logging character (from the filename) and the party list the player
 *     typed in settings. Not inferred from anything.
 *  2. EXPLICIT — group join/leave/disband messages, /who output, "Targeted (Player)"
 *     and "Targeted (NPC)". The game stating it outright. Confirmed wording: 21
 *     join/leave lines and 16 self forms appear in the live log.
 *  3. PLAYER PROOF — speaking on a channel, which no mob and no pet does.
 *  4. IMPLICIT — anyone who has damaged something we were fighting, whose name looks
 *     like a player's. Always available, and what makes the overlay populate out of
 *     the box on the very first pull.
 *
 * Note what is NOT here any more: a hostile-by-action brand. It existed because name
 * shape read Plane of Sky bees as players, and it was removed because the fight answers
 * that question without asking about names at all.
 */

import { looksLikeMobName, looksLikePetName, looksLikePlayerName, stripArticle, stripPetSuffix } from './entities.js';

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

    /**
     * The party list from settings: exactly whose rows the player wants to see.
     *
     * Empty means no filter at all — everyone the log produces gets a row. This
     * replaced a "group only" switch that filtered on INFERRED membership, which
     * failed closed and failed silently: anyone already in the group when logging
     * began was never in `explicit`, so the first join or leave line by anybody else
     * quietly dropped them from the view with nothing on screen to say so.
     *
     * Deliberately a display filter and nothing more. It is read where rows are
     * chosen and by nothing in the scoring path, so leaving someone off hides their row
     * without changing a single attribution decision — turn the filter off again and
     * the fight you are looking at is unchanged.
     * @type {Set<string>}
     */
    this.partyMembers = new Set();
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

  /**
   * Record that `owner` has charmed `pet`. Names are stored article-stripped and
   * suffix-stripped — the charm line always uses the plain name, but the typed command
   * may carry the game's " pet" marker and both spellings must land on one key.
   *
   * A charm write EVICTS the name from the durable and learned tables: mappings
   * override, they do not layer. Leaving a stale entry underneath would let it
   * resurface the moment the charm ends — which is exactly the "basilisk = Rhale"
   * failure, where a name mapped once kept branding every same-named wild mob 'ours'
   * long after any charm was live.
   */
  charm(pet, owner) {
    const key = stripPetSuffix(stripArticle(String(pet).trim()));
    if (!key || !owner) return;
    // One charm per charmer: landing a new one releases the old.
    for (const [existing, holder] of this.charmedPets) {
      if (holder === owner) this.charmedPets.delete(existing);
    }
    this.petOwners.delete(key);
    this.learnedPetOwners.delete(key);
    this.charmedPets.set(key, owner);
  }

  uncharm(pet) {
    const key = stripArticle(String(pet).trim());
    return this.charmedPets.delete(key) || this.charmedPets.delete(stripPetSuffix(key));
  }

  isCharmed(name) {
    const key = stripArticle(String(name).trim());
    return this.charmedPets.has(key) || this.charmedPets.has(stripPetSuffix(key));
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
    const direct = this.charmedPets.get(key)
      ?? this.petOwners.get(key)
      ?? this.learnedPetOwners.get(key)?.owner
      ?? null;
    if (direct) return direct;

    // The game writes every pet that is not your own as `<base> pet` ("a ghoul pet"),
    // while the charm line, the Master report and the typed command all use the base
    // name — so a mapping recorded against "ghoul" must still reach the spelling the
    // pet actually fights under. One direction only: a suffixed SIGHTING falls back to
    // its base, but a mapping keyed with the suffix (a summon-adjacency binding on
    // "dark boned skeleton pet", say) never claims the plain name — that would hand
    // every wild dark boned skeleton to the pet's owner on adjacency-grade evidence.
    const base = stripPetSuffix(key);
    if (base === key) return null;
    return this.charmedPets.get(base)
      ?? this.petOwners.get(base)
      ?? this.learnedPetOwners.get(base)?.owner
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
    // A proven player is nobody's pet.
    this.learnedPetOwners.delete(key);
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
    // Everything learned by watching belonged to the old character's session too.
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
        const key = stripPetSuffix(stripArticle(String(event.pet).trim()));
        // A backtick pet needs no table: `Rhale`s warder` resolves to Rhale by string
        // split before any lookup happens. Storing it anyway did no harm to the numbers
        // but leaked into the saved mapping — the next in-game command persists this
        // whole table — and so into the settings box, where a line the player neither
        // wrote nor needs reads as something they are expected to maintain.
        if (!key.includes('`')) {
          if (looksLikeMobName(key)) {
            // A mob-named pet reporting to its Master is a CHARM report — summoned pets
            // get generated player-shaped names, so a mob name here means a charmed mob
            // announcing whose it is right now. It gets a charm's lifetime, not a durable
            // entry: writing "skeletal monk = Rhale" into petOwners is how the mapping
            // outlived the charm, and — via the command persisting the whole table —
            // how "basilisk = Rhale" reached the saved config.
            this.charm(key, owner);
          } else {
            this.petOwners.set(key, owner);
            // Override, not layer: the newest statement is the one in force, and a
            // stale charm entry would otherwise outrank this in ownerOf.
            this.charmedPets.delete(key);
            this.learnedPetOwners.delete(key);
          }
          this.implicit.delete(key);
        }
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
   * Replace the party list with what settings holds.
   *
   * A wholesale replace, like setPetOwners, so deleting a name in settings actually
   * deletes it rather than leaving a filter running that the player thinks they removed.
   */
  setPartyMembers(names) {
    this.partyMembers = new Set(
      (Array.isArray(names) ? names : [])
        .map((n) => String(n ?? '').trim())
        .filter(Boolean)
    );
  }

  /** True when the player has named the people they want, so the filter is live. */
  hasPartyList() {
    return this.partyMembers.size > 0;
  }

  /**
   * Should this combatant have a row?
   *
   * With no list, everyone does — that is the whole point of the setting being empty
   * by default. With a list, it means the list: an exact answer the player typed and
   * can see, rather than an inference they cannot.
   */
  inParty(name) {
    if (!this.hasPartyList()) return true;
    return this.partyMembers.has(name);
  }

  /**
   * Is this name one of ours, in the loosest sense the roster can vouch for?
   *
   * Note this is an IDENTITY question, not a display one — the party list is not
   * consulted here on purpose, so hiding a row never changes who damage is credited to.
   *
   * @param {string} name canonical combatant name (pets already folded into their owner)
   */
  includes(name) {
    if (this.overridesOff.has(name)) return false;
    if (this.overridesOn.has(name)) return true;
    if (name === this.selfName) return true;
    return this.implicit.has(name) || this.explicit.has(name);
  }

  members() {
    const source = new Set([...this.implicit, ...this.explicit]);
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
