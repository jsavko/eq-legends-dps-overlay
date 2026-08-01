/**
 * Who counts as "us".
 *
 * Two sources feed this, because only one of them is guaranteed to exist:
 *
 *  1. EXPLICIT — group join/leave/disband messages and /who output. Authoritative when
 *     present, but the Phase 0 sample session contained none, so this server's exact
 *     wording for them is unverified (see rules.js).
 *  2. IMPLICIT — anyone who damages an NPC and whose name looks like a player name.
 *     Always available, and it is what makes the overlay populate out of the box.
 *
 * Explicit membership always wins over the implicit heuristic: if the log ever says
 * someone left the group, no amount of swinging puts them back in it.
 */

import { looksLikePlayerName, stripArticle } from './entities.js';

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

    /** Names the game called out as real players via "Targeted (Player): X". */
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
    return this.charmedPets.get(key) ?? this.petOwners.get(key) ?? null;
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
    this.clearOverrides();
  }

  /** Apply a `group`, `who`, `targeted` or `pet-owner` event from the rule table. */
  applyEvent(event) {
    if (event.kind === 'who') {
      this.hasExplicitData = true;
      this.explicit.add(event.who);
      return;
    }

    if (event.kind === 'targeted') {
      if (event.targetKind === 'player') {
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
