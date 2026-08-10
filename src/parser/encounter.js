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

import { spellStem } from './rules.js';

const SECOND = 1000;

export const DEFAULTS = {
  /** No damage for this long ends the encounter. */
  timeoutMs: 15 * SECOND,
  /** After the last engaged NPC dies, wait this long for more damage before closing. */
  postKillGraceMs: 3 * SECOND,
  /** Width of the burst-DPS window shown beside the headline number. */
  rollingWindowMs: 10 * SECOND,
  /**
   * An engaged NPC silent in both directions for this long stops counting as alive.
   *
   * Mobs leave a fight without dying — the group evacuates, the mob flees, it is
   * feared out of range — and `aliveNpcs` used to drain only through a death line, so
   * one of those blocked the all-slain close for the rest of the encounter. The fight
   * could then end only on the 15s idle timeout, and any pull chained inside 15s
   * merged into it; one measured post-evac encounter ran eight minutes that way.
   *
   * 60s, and the floor is what sets it: it has to be longer than a mezzed add's
   * silence, or killing the primary would close the fight and the add breaking mez
   * would open a second one, splitting one pull in two. That is comfortably past a
   * mez tick and still far short of the merge this exists to prevent.
   */
  npcStaleMs: 60 * SECOND,
};

function newCombatant(name) {
  return {
    name,
    damage: 0,
    petDamage: 0,
    /**
     * Damage from abilities that deal damage but are never cast — weapon procs.
     * A separate axis from petDamage, not a slice of it: a player's own weapon procs
     * and their pet's both land here, and pet proc damage is counted in both.
     */
    procDamage: 0,
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

    // Damage taken — the mirror of the outgoing structures above, keyed the same way:
    // the victim is the row, and a pet's beating folds into its owner exactly as its
    // damage does. Answering "what is killing me" needs both axes of the same events,
    // so byAttacker records WHO and takenByAbility records WITH WHAT.
    damageTaken: 0,
    petDamageTaken: 0,
    hitsTaken: 0,
    maxHitTaken: 0,
    /** Deaths of the member themself; a pet dying is petDeaths, never the owner's. */
    deaths: 0,
    petDeaths: 0,
    /** Total incoming swings this member avoided (dodge, parry, riposte, ...). */
    avoidsTaken: 0,
    /** @type {Object<string, number>} avoidance kind -> count */
    avoidedTaken: {},
    /** @type {Map<string, {damage:number, hits:number, max:number}>} who hit them */
    byAttacker: new Map(),
    /** @type {Map<string, {damage:number, hits:number, max:number, type:string|null}>} what hit them */
    takenByAbility: new Map(),
    /**
     * Damage taken per stated type — 'melee', 'fire', 'cold', ... or 'untyped' when
     * the log names none (DoT ticks). This is what tells the player which RESIST
     * would have helped; a type is only ever what the line itself said.
     * @type {Object<string, number>}
     */
    takenByType: {},
    /** @type {Map<number, number>} epoch-second -> damage taken, for rolling DTPS */
    takenWindow: new Map(),

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
    /**
     * NPCs believed to still be up, mapped to when they were last part of the fight.
     * Drained by npcDied, and by going quiet for `npcStaleMs` — a mob that left is not
     * a mob you are still fighting.
     * @type {Map<string, number>}
     */
    this.aliveNpcs = new Map();
    /** Set when the last engaged NPC dies; cleared if damage resumes. */
    this.allSlainAt = null;
    this.totalDamage = 0;
    this.totalHealing = 0;
    this.totalDamageTaken = 0;
    /**
     * Every friendly death in the fight, in order, with who landed the kill. The
     * per-combatant counter answers "how many times"; this answers "when and to what",
     * which is what a post-raid review actually wants to know.
     * @type {Array<{name:string, killer:string|null, ts:number, isPet:boolean}>}
     */
    this.deaths = [];
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
   * @param {boolean} [hit.proc]  true when no cast for this ability has ever been seen
   */
  addDamage({ name, amount, ts, source, ability, isPet, crit, proc }) {
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
    const ab = this.abilityRow(c, key, ability, isPet, proc);
    // A cast has now been seen for an ability we had been calling a proc, so it never
    // was one. Take the credit back BEFORE this hit lands, and keep the one row —
    // splitting proc and non-melee into separate rows would strand a stale one here.
    if (ab.proc && !proc) {
      ab.proc = false;
      c.procDamage -= ab.damage;
    }
    ab.damage += amount;
    ab.hits += 1;
    if (crit) ab.crits += 1;
    if (amount > ab.max) ab.max = amount;
    if (ab.proc) c.procDamage += amount;

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

  /**
   * Get or create the per-ability row.
   *
   * `ability` is stored alongside the key because the key already carries the "(pet)"
   * suffix, and the snapshot needs the bare name back to render "Ykesha (pet proc)".
   */
  abilityRow(c, key, ability, isPet, proc = false) {
    let ab = c.byAbility.get(key);
    if (!ab) {
      ab = {
        ability, damage: 0, hits: 0, crits: 0, max: 0,
        pet: Boolean(isPet), proc: Boolean(proc),
      };
      c.byAbility.set(key, ab);
    }
    return ab;
  }

  /**
   * A cast was finally observed for an ability already credited as a proc, and no
   * further hit is guaranteed to arrive to correct the label. Clear it now, so no
   * fight can end with an ability mislabelled purely because its first hit happened
   * to precede its first cast line.
   *
   * @returns {boolean} true if a row was relabelled
   */
  unmarkProc(name, ability, isPet) {
    const c = this.combatants.get(name);
    if (!c) return false;
    // Matched on the rank-stripped stem, because the cast line carries a rank that the
    // damage line does not: "Frost Storm VIII" has to find the "Frost Storm" row.
    const stem = spellStem(ability);
    let changed = false;
    for (const ab of c.byAbility.values()) {
      if (!ab.proc || ab.pet !== Boolean(isPet)) continue;
      if (spellStem(ab.ability) !== stem) continue;
      ab.proc = false;
      c.procDamage -= ab.damage;
      changed = true;
    }
    return changed;
  }

  /** Record a swing that produced no damage. Misses lower accuracy but not DPS. */
  addMiss({ name, ts, isPet, ability }) {
    const c = this.combatant(name);
    c.misses += 1;
    if (c.firstTs === null) c.firstTs = ts;
    c.lastTs = ts;

    const ab = this.abilityRow(c, isPet ? `${ability} (pet)` : ability, ability, isPet);
    // Deliberately not counted in ab.hits — hits/(hits+misses) must stay a real accuracy.
    ab.misses = (ab.misses ?? 0) + 1;
  }

  /**
   * Credit incoming damage to the friendly who took it.
   *
   * Incoming damage keeps the encounter alive exactly as outgoing does: a tank being
   * pounded while the group meds is still a live fight, and closing it under them
   * would split one pull into two.
   *
   * @param {Object} hit
   * @param {string} hit.name     canonical victim (a pet's owner, already resolved)
   * @param {string} hit.attacker canonical attacker, article-stripped
   * @param {number} hit.amount
   * @param {number} hit.ts
   * @param {string} hit.ability
   * @param {boolean} hit.isPet   true when it was this member's pet that was hit
   * @param {string|null} [hit.type] stated damage type ('fire', 'melee', ...), or null
   */
  addDamageTaken({ name, attacker, amount, ts, ability, isPet, type }) {
    const c = this.combatant(name);

    c.damageTaken += amount;
    if (isPet) c.petDamageTaken += amount;
    c.hitsTaken += 1;
    if (amount > c.maxHitTaken) c.maxHitTaken = amount;

    const typeKey = type ?? 'untyped';
    c.takenByType[typeKey] = (c.takenByType[typeKey] ?? 0) + amount;

    let atk = c.byAttacker.get(attacker);
    if (!atk) {
      atk = { damage: 0, hits: 0, max: 0 };
      c.byAttacker.set(attacker, atk);
    }
    atk.damage += amount;
    atk.hits += 1;
    if (amount > atk.max) atk.max = amount;

    let ab = c.takenByAbility.get(ability);
    if (!ab) {
      ab = { damage: 0, hits: 0, max: 0, type: null };
      c.takenByAbility.set(ability, ab);
    }
    ab.damage += amount;
    ab.hits += 1;
    if (amount > ab.max) ab.max = amount;
    if (type) ab.type = type;   // an ability's type is fixed; any stated one is THE one

    const second = Math.floor(ts / SECOND);
    c.takenWindow.set(second, (c.takenWindow.get(second) ?? 0) + amount);

    if (c.firstTs === null) c.firstTs = ts;
    c.lastTs = ts;

    this.totalDamageTaken += amount;
    this.lastDamageTs = Math.max(this.lastDamageTs, ts);
    this.allSlainAt = null;   // a mob still swinging means the pull is not over
  }

  /** An incoming swing this member avoided. Lowers nothing; it is pure defense credit. */
  addAvoidTaken({ name, avoidance, ts }) {
    const c = this.combatant(name);
    c.avoidsTaken += 1;
    c.avoidedTaken[avoidance] = (c.avoidedTaken[avoidance] ?? 0) + 1;
    if (c.firstTs === null) c.firstTs = ts;
    c.lastTs = ts;
  }

  /**
   * A friendly died. Recorded on their row AND in the encounter-wide list — the row
   * answers "how many times", the list "when and to what". A pet's death never counts
   * as its owner's: "you died twice" must mean the player hit the floor twice.
   */
  recordDeath({ name, killer, ts, isPet }) {
    const c = this.combatant(name);
    if (isPet) c.petDeaths += 1;
    else c.deaths += 1;
    if (c.firstTs === null) c.firstTs = ts;
    c.lastTs = ts;
    this.deaths.push({ name, killer: killer ?? null, ts, isPet: Boolean(isPet) });
  }

  /**
   * Note that an NPC is part of this fight, for the encounter label and end detection.
   *
   * Every line that scores in either direction calls this first — the outgoing path
   * with the target, the incoming path with the attacker — so the timestamp here is
   * the whole liveness signal that `dropStaleNpcs` reads. `engagedNpcs` is never
   * pruned by any of it: the fight must still be able to name every mob that was in
   * it, long after the last of them is dead or gone.
   *
   * @param {number} [ts] when this NPC was last seen fighting; defaults to fight time
   */
  engage(npcName, damage = 0, ts = this.lastDamageTs) {
    this.engagedNpcs.set(npcName, (this.engagedNpcs.get(npcName) ?? 0) + damage);
    this.aliveNpcs.set(npcName, ts);
    this.allSlainAt = null;
  }

  /** An NPC died. When the last one believed alive dies, start the post-kill grace timer. */
  npcDied(npcName, ts) {
    if (!this.aliveNpcs.has(npcName)) return;
    this.aliveNpcs.delete(npcName);
    if (this.aliveNpcs.size === 0) this.allSlainAt = ts;
  }

  /**
   * Forget NPCs that have been silent long enough to have left the fight.
   *
   * Arms the post-kill grace exactly as the last death line does, because the two are
   * the same fact arriving by different routes: nothing the group engaged is still
   * here. The grace period then does its usual job of waiting to be contradicted.
   */
  dropStaleNpcs(now) {
    if (this.aliveNpcs.size === 0) return;
    let dropped = false;
    for (const [name, lastSeen] of this.aliveNpcs) {
      if (now - lastSeen < this.opts.npcStaleMs) continue;
      this.aliveNpcs.delete(name);
      dropped = true;
    }
    if (dropped && this.aliveNpcs.size === 0 && this.allSlainAt === null) {
      this.allSlainAt = now;
    }
  }

  /**
   * Advance encounter time and close it if it is over.
   * @param {number} now current time in ms (log time while feeding, wall clock while idle)
   * @returns {boolean} true if the encounter closed on this call
   */
  update(now) {
    if (this.closed) return false;
    const t = Math.max(now, this.lastDamageTs);

    this.dropStaleNpcs(t);

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
    let shownTaken = 0;

    for (const c of this.combatants.values()) {
      if (includeNames && !includeNames(c.name)) continue;
      // `heals`, not `healing`: a healer whose every point was overheal has healing 0
      // but is precisely the case worth showing — dropping the row would hide the
      // problem instead of reporting it. Same logic on the taken side: a member who
      // only got hit (or only died) never swung, and is exactly who the damage-taken
      // view exists for.
      if (
        c.damage === 0 && c.hits === 0 && c.misses === 0 && c.heals === 0 &&
        c.hitsTaken === 0 && c.avoidsTaken === 0 && c.deaths === 0 && c.petDeaths === 0
      ) continue;

      const swings = c.hits + c.misses;

      rows.push({
        name: c.name,

        damage: c.damage,
        petDamage: c.petDamage,
        procDamage: c.procDamage,
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
            // The label is derived here rather than baked into the map key, so that
            // clearing a proc label retroactively cannot strand a stale row.
            name: a.proc ? `${a.ability} (${a.pet ? 'pet proc' : 'proc'})` : name,
            damage: a.damage,
            hits: a.hits,
            misses: a.misses ?? 0,
            crits: a.crits,
            max: a.max,
            pet: a.pet,
            proc: Boolean(a.proc),
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

        damageTaken: c.damageTaken,
        petDamageTaken: c.petDamageTaken,
        playerDamageTaken: c.damageTaken - c.petDamageTaken,
        dtps: c.damageTaken / durationSec,
        rollingDtps: this.rollingTotal(c.takenWindow, t) / rollingSec,
        hitsTaken: c.hitsTaken,
        maxHitTaken: c.maxHitTaken,
        deaths: c.deaths,
        petDeaths: c.petDeaths,
        avoidsTaken: c.avoidsTaken,
        avoidedTaken: { ...c.avoidedTaken },
        takenByType: { ...c.takenByType },
        attackers: [...c.byAttacker.entries()]
          .map(([name, a]) => ({ name, damage: a.damage, hits: a.hits, max: a.max }))
          .sort((a, b) => b.damage - a.damage),
        takenAbilities: [...c.takenByAbility.entries()]
          .map(([name, a]) => ({ name, damage: a.damage, hits: a.hits, max: a.max, type: a.type }))
          .sort((a, b) => b.damage - a.damage),
      });

      shownDamage += c.damage;
      shownHealing += c.healing;
      shownTaken += c.damageTaken;
    }

    // All three shares are precomputed so the overlay can flip between damage,
    // healing and taken without a round trip to the parser.
    rows.sort((a, b) => b.damage - a.damage);
    for (const r of rows) {
      r.share = shownDamage > 0 ? r.damage / shownDamage : 0;
      r.healShare = shownHealing > 0 ? r.healing / shownHealing : 0;
      r.takenShare = shownTaken > 0 ? r.damageTaken / shownTaken : 0;
    }

    const shownNames = new Set(rows.map((r) => r.name));

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
      totalDamageTaken: shownTaken,
      groupDtps: shownTaken / durationSec,
      // Filtered the same way as the rows, so a narrowed view never names outsiders.
      deaths: this.deaths.filter((d) => shownNames.has(d.name)),
      rows,
    };
  }
}
