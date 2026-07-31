/**
 * Encounter state machine and per-combatant aggregation.
 *
 * An encounter opens on the first damage event involving a friendly combatant and
 * closes on whichever comes first:
 *   - idle timeout (no damage for `timeoutMs`, default 15s)
 *   - a zone change
 *   - every engaged NPC slain, after a short grace period
 *
 * The grace period exists because EverQuest mob names are generic: two
 * "a froglok shin knight" mobs are indistinguishable in the log, so a death line
 * cannot prove the pull is over. Waiting a few seconds for further damage
 * distinguishes "the fight ended" from "the first of three adds died" without
 * making the player stare at a stale number for the full 15s timeout.
 */

const SECOND = 1000;

export const DEFAULTS = {
  /** No damage for this long ends the encounter. */
  timeoutMs: 15 * SECOND,
  /** After the last engaged NPC dies, wait this long for more damage before closing. */
  postKillGraceMs: 3 * SECOND,
  /** Width of the burst-DPS window shown beside the headline number. */
  rollingWindowMs: 10 * SECOND,
};

function newCombatant(name) {
  return {
    name,
    damage: 0,
    petDamage: 0,
    hits: 0,
    misses: 0,
    crits: 0,
    maxHit: 0,
    bySource: { melee: 0, spell: 0, dot: 0, ds: 0, nonmelee: 0 },
    /** @type {Map<string, {damage:number, hits:number, crits:number, max:number, pet:boolean}>} */
    byAbility: new Map(),
    /** @type {Map<number, number>} epoch-second -> damage, for the rolling window */
    window: new Map(),

    // Healing. Kept alongside damage rather than in a separate structure so one pass
    // over the combatants can answer either question.
    healing: 0,          // effective: hit points actually restored
    overhealing: 0,      // potential - effective, exact because EQ prints both
    petHealing: 0,
    heals: 0,
    maxHeal: 0,
    /** @type {Map<string, {healing:number, overhealing:number, casts:number, pet:boolean}>} */
    byHealAbility: new Map(),
    /** @type {Map<string, number>} who this combatant healed, and for how much */
    healTargets: new Map(),
    /** @type {Map<number, number>} epoch-second -> healing, for rolling HPS */
    healWindow: new Map(),

    firstTs: null,
    lastTs: null,
  };
}

export class Encounter {
  constructor(startTs, options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.startTs = startTs;
    this.lastDamageTs = startTs;
    this.endTs = null;
    this.closed = false;
    this.closeReason = null;

    /** @type {Map<string, ReturnType<typeof newCombatant>>} */
    this.combatants = new Map();
    /**
     * NPC name -> total damage taken. Entries are never removed, so the encounter can
     * still name the mob it was about after that mob is dead.
     * @type {Map<string, number>}
     */
    this.engagedNpcs = new Map();
    /** NPCs believed to still be up; drained by npcDied. @type {Set<string>} */
    this.aliveNpcs = new Set();
    /** Set when the last engaged NPC dies; cleared if damage resumes. */
    this.allSlainAt = null;
    this.totalDamage = 0;
    this.totalHealing = 0;
  }

  combatant(name) {
    let c = this.combatants.get(name);
    if (!c) {
      c = newCombatant(name);
      this.combatants.set(name, c);
    }
    return c;
  }

  /**
   * Credit outgoing damage to a friendly combatant.
   *
   * @param {Object} hit
   * @param {string} hit.name     canonical combatant (a pet's owner, already resolved)
   * @param {number} hit.amount
   * @param {number} hit.ts
   * @param {string} hit.source   'melee' | 'spell' | 'dot' | 'ds' | 'nonmelee'
   * @param {string} hit.ability
   * @param {boolean} hit.isPet   true when the swing came from this member's pet
   * @param {boolean} hit.crit
   */
  addDamage({ name, amount, ts, source, ability, isPet, crit }) {
    const c = this.combatant(name);

    c.damage += amount;
    if (isPet) c.petDamage += amount;
    c.hits += 1;
    if (crit) c.crits += 1;
    if (amount > c.maxHit) c.maxHit = amount;
    if (c.bySource[source] === undefined) c.bySource[source] = 0;
    c.bySource[source] += amount;

    // Pet swings get their own ability rows so the breakdown can tell
    // "your Crush" apart from "your warder's Crush".
    const key = isPet ? `${ability} (pet)` : ability;
    let ab = c.byAbility.get(key);
    if (!ab) {
      ab = { damage: 0, hits: 0, crits: 0, max: 0, pet: Boolean(isPet) };
      c.byAbility.set(key, ab);
    }
    ab.damage += amount;
    ab.hits += 1;
    if (crit) ab.crits += 1;
    if (amount > ab.max) ab.max = amount;

    const second = Math.floor(ts / SECOND);
    c.window.set(second, (c.window.get(second) ?? 0) + amount);

    if (c.firstTs === null) c.firstTs = ts;
    c.lastTs = ts;

    this.totalDamage += amount;
    this.lastDamageTs = Math.max(this.lastDamageTs, ts);
    this.allSlainAt = null;   // damage is still flowing, so the pull is not over
  }

  /**
   * Credit healing to a friendly combatant.
   *
   * `effective` is what actually landed and is what HPS is built from; the difference
   * from `potential` is overhealing. Both are recorded because a cleric throwing 400-point
   * heals onto a full-health tank is doing something very different from one whose heals
   * all land, and only the pair distinguishes them.
   *
   * Healing does NOT touch lastDamageTs: a heal must not keep an encounter alive, or a
   * healer topping the group up after a pull would stretch the fight indefinitely and
   * drag everyone's DPS down.
   */
  addHeal({ name, effective, potential, ts, ability, isPet, target }) {
    const c = this.combatant(name);
    const overheal = Math.max(0, potential - effective);

    c.healing += effective;
    c.overhealing += overheal;
    if (isPet) c.petHealing += effective;
    c.heals += 1;
    if (effective > c.maxHeal) c.maxHeal = effective;

    const key = isPet ? `${ability} (pet)` : ability;
    let ab = c.byHealAbility.get(key);
    if (!ab) {
      ab = { healing: 0, overhealing: 0, casts: 0, pet: Boolean(isPet) };
      c.byHealAbility.set(key, ab);
    }
    ab.healing += effective;
    ab.overhealing += overheal;
    ab.casts += 1;

    if (target) c.healTargets.set(target, (c.healTargets.get(target) ?? 0) + effective);

    const second = Math.floor(ts / SECOND);
    c.healWindow.set(second, (c.healWindow.get(second) ?? 0) + effective);

    if (c.firstTs === null) c.firstTs = ts;
    c.lastTs = ts;
    this.totalHealing += effective;
  }

  /** Record a swing that produced no damage. Misses lower accuracy but not DPS. */
  addMiss({ name, ts, isPet, ability }) {
    const c = this.combatant(name);
    c.misses += 1;
    if (c.firstTs === null) c.firstTs = ts;
    c.lastTs = ts;

    const key = isPet ? `${ability} (pet)` : ability;
    let ab = c.byAbility.get(key);
    if (!ab) {
      ab = { damage: 0, hits: 0, crits: 0, max: 0, pet: Boolean(isPet) };
      c.byAbility.set(key, ab);
    }
    // Deliberately not counted in ab.hits — hits/(hits+misses) must stay a real accuracy.
    ab.misses = (ab.misses ?? 0) + 1;
  }

  /** Note that an NPC is part of this fight, for the encounter label and end detection. */
  engage(npcName, damage = 0) {
    this.engagedNpcs.set(npcName, (this.engagedNpcs.get(npcName) ?? 0) + damage);
    this.aliveNpcs.add(npcName);
    this.allSlainAt = null;
  }

  /** An NPC died. When the last one believed alive dies, start the post-kill grace timer. */
  npcDied(npcName, ts) {
    if (!this.aliveNpcs.has(npcName)) return;
    this.aliveNpcs.delete(npcName);
    if (this.aliveNpcs.size === 0) this.allSlainAt = ts;
  }

  /**
   * Advance encounter time and close it if it is over.
   * @param {number} now current time in ms (log time while feeding, wall clock while idle)
   * @returns {boolean} true if the encounter closed on this call
   */
  update(now) {
    if (this.closed) return false;
    const t = Math.max(now, this.lastDamageTs);

    if (this.allSlainAt !== null && t - this.allSlainAt >= this.opts.postKillGraceMs) {
      this.close('killed', this.lastDamageTs);
      return true;
    }
    if (t - this.lastDamageTs >= this.opts.timeoutMs) {
      this.close('timeout', this.lastDamageTs);
      return true;
    }
    return false;
  }

  close(reason, ts) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.endTs = ts ?? this.lastDamageTs;
  }

  /**
   * Encounter length in ms, floored at one second.
   *
   * Log timestamps have one-second resolution, so a fight resolved inside a single
   * second reports duration 0 and would divide by zero. Flooring at 1s makes such a
   * burst report "all of it in one second", which is the honest reading.
   */
  durationMs(now) {
    const end = this.closed ? this.endTs : Math.max(now ?? this.lastDamageTs, this.lastDamageTs);
    return Math.max(SECOND, end - this.startTs);
  }

  /** Whichever engaged NPC has taken the most damage — the fight's headline name. */
  primaryTarget() {
    let best = null;
    let bestDamage = -1;
    for (const [name, dmg] of this.engagedNpcs) {
      if (dmg > bestDamage) {
        best = name;
        bestDamage = dmg;
      }
    }
    return best;
  }

  /** Total in the trailing rolling window. Prunes as it goes, so the map stays ~10 entries. */
  rollingTotal(buckets, now) {
    const cutoff = Math.floor((now - this.opts.rollingWindowMs) / SECOND);
    let sum = 0;
    for (const [second, value] of buckets) {
      if (second > cutoff) sum += value;
      else buckets.delete(second);
    }
    return sum;
  }

  /**
   * Immutable view of the encounter for the renderer.
   *
   * Every row's DPS uses the SAME encounter duration, so the per-member numbers add up
   * to the group total and the share percentages agree with the bar widths. Dividing
   * each member by their own active time would be a different (and non-additive) metric.
   */
  snapshot(now, { includeNames = null } = {}) {
    const t = this.closed ? this.endTs : Math.max(now ?? this.lastDamageTs, this.lastDamageTs);
    const durationMs = this.durationMs(now);
    const durationSec = durationMs / SECOND;
    const rollingSec = Math.max(
      1,
      Math.min(this.opts.rollingWindowMs, durationMs) / SECOND
    );

    const rows = [];
    let shownDamage = 0;
    let shownHealing = 0;

    for (const c of this.combatants.values()) {
      if (includeNames && !includeNames(c.name)) continue;
      // `heals`, not `healing`: a healer whose every point was overheal has healing 0
      // but is precisely the case worth showing — dropping the row would hide the
      // problem instead of reporting it.
      if (c.damage === 0 && c.hits === 0 && c.misses === 0 && c.heals === 0) continue;

      const swings = c.hits + c.misses;

      rows.push({
        name: c.name,

        damage: c.damage,
        petDamage: c.petDamage,
        playerDamage: c.damage - c.petDamage,
        dps: c.damage / durationSec,
        rollingDps: this.rollingTotal(c.window, t) / rollingSec,
        hits: c.hits,
        misses: c.misses,
        crits: c.crits,
        maxHit: c.maxHit,
        accuracy: swings > 0 ? c.hits / swings : 0,
        bySource: { ...c.bySource },
        abilities: [...c.byAbility.entries()]
          .map(([name, a]) => ({
            name,
            damage: a.damage,
            hits: a.hits,
            misses: a.misses ?? 0,
            crits: a.crits,
            max: a.max,
            pet: a.pet,
          }))
          .sort((a, b) => b.damage - a.damage),

        healing: c.healing,
        petHealing: c.petHealing,
        playerHealing: c.healing - c.petHealing,
        overhealing: c.overhealing,
        // Share of everything the heal COULD have restored that actually landed.
        healEfficiency: c.healing + c.overhealing > 0
          ? c.healing / (c.healing + c.overhealing)
          : 0,
        hps: c.healing / durationSec,
        rollingHps: this.rollingTotal(c.healWindow, t) / rollingSec,
        heals: c.heals,
        maxHeal: c.maxHeal,
        healAbilities: [...c.byHealAbility.entries()]
          .map(([name, a]) => ({
            name,
            healing: a.healing,
            overhealing: a.overhealing,
            casts: a.casts,
            pet: a.pet,
          }))
          .sort((a, b) => b.healing - a.healing),
        healTargets: [...c.healTargets.entries()]
          .map(([name, healing]) => ({ name, healing }))
          .sort((a, b) => b.healing - a.healing),
      });

      shownDamage += c.damage;
      shownHealing += c.healing;
    }

    // Both shares are precomputed so the overlay can flip between damage and healing
    // without a round trip to the parser.
    rows.sort((a, b) => b.damage - a.damage);
    for (const r of rows) {
      r.share = shownDamage > 0 ? r.damage / shownDamage : 0;
      r.healShare = shownHealing > 0 ? r.healing / shownHealing : 0;
    }

    return {
      active: !this.closed,
      closeReason: this.closeReason,
      label: this.primaryTarget() ?? 'Combat',
      startTs: this.startTs,
      durationMs,
      totalDamage: shownDamage,
      groupDps: shownDamage / durationSec,
      totalHealing: shownHealing,
      groupHps: shownHealing / durationSec,
      rows,
    };
  }
}
