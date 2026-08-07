/**
 * rhythm — learned recast timers for named casters.
 *
 * A timer here is an ESTIMATE, and everything in this module exists to keep that
 * estimate honest. The live-log analysis behind the design: of 220 (caster, spell)
 * pairs with five or more in-fight recasts, only 11 were regular enough to predict
 * (spread under a quarter of the interval). Quag Maelstrom's Mana Drain lands every
 * 19s ± 1.5s — a timer for that is a service. Gonobn's Stun wanders ± 14s around a
 * 28s median — a countdown for that would routinely lie by half a cycle. So a rhythm
 * must EARN a timer: enough observed gaps, low spread, and the moment reality stops
 * matching the prediction the timer retracts rather than counting into fiction.
 *
 * The tracker knows nothing about encounters, hostility or spell categories — the
 * parser decides which casts to feed it (named hostile casters only) and when a
 * fight is over. It also carries "known" rhythms — medians learned in PREVIOUS
 * fights and persisted by the main process — which warm-start a timer from the first
 * observed cast instead of the third, the difference between a raid's learning pull
 * and every pull after it.
 *
 * Statistics are median + MAD (scaled to estimate a standard deviation) rather than
 * mean + sd: a boss that skips one cycle (stunned, moved, out of mana) produces a
 * single double-length gap, and with only three to six samples one outlier through a
 * mean would wreck the estimate that the median shrugs off.
 */

/** Gaps this long are a lull or a fight boundary, not a recast cycle. */
const MAX_GAP_MS = 90_000;

/** A rhythm qualifies once this many gaps agree... */
export const QUALIFY_MIN_GAPS = 3;
/** ...within this relative spread (spread / interval). */
export const QUALIFY_MAX_CV = 0.25;

/**
 * A prediction this far past due is wrong — retract it. Two spreads is where "a bit
 * late" ends and "the pattern broke" begins; the floor keeps a suspiciously tight
 * spread from retracting over a one-second wobble.
 */
const RETRACT_SPREAD_FACTOR = 2;
const RETRACT_FLOOR_MS = 2000;

/**
 * A stored rhythm needs this many pooled samples before it may warm-start a timer.
 * Matches QUALIFY_MIN_GAPS on purpose: three agreeing gaps is exactly the evidence
 * that shows a timer live mid-fight, and the same evidence written down should not
 * become too weak to use on the next pull. (Was 4; several genuinely tight measured
 * rhythms — Warlord Skarlon's 8s ±0.5 Greater Healing among them — carry n=3.)
 */
export const WARM_START_MIN_SAMPLES = 3;

/** Bound per-key memory; a raid boss casts well under this in any one fight. */
const MAX_GAPS_KEPT = 30;

/**
 * Landed-evidence lines closer together than this are ONE volley, not a new cycle:
 * an AE prints a damage line per group member in the same second or two, and
 * learning those as gaps would bury the real interval under zeros.
 */
const VOLLEY_MS = 2500;

const key = (caster, ability) => `${caster}|${ability}`;

/**
 * A fresh per-fight entry.
 *
 * `armedTs` is null until the entry first produces a prediction — it is the moment
 * the pair CLAIMED a slot in the timers window, and it never moves afterwards. That
 * is what keeps a row where the player learned to find it: ordering by `dueMs` would
 * reshuffle the panel every time one countdown overtook another.
 */
function newEntry(caster, ability, ts, source) {
  return { caster, ability, gaps: [], lastTs: ts, skipNextGap: false, source, armedTs: null };
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation, scaled by 1.4826 to estimate a standard deviation. */
function spreadOf(values, mid) {
  const deviations = values.map((v) => Math.abs(v - mid));
  return Math.max(500, median(deviations) * 1.4826);
}

export class RhythmTracker {
  constructor() {
    /**
     * In-fight state per caster|ability.
     * @type {Map<string, {caster: string, ability: string, gaps: number[],
     *                     lastTs: number, skipNextGap: boolean}>}
     */
    this.entries = new Map();
    /**
     * Rhythms learned in previous fights, from the persistent store.
     * @type {Map<string, {intervalMs: number, spreadMs: number, samples: number}>}
     */
    this.known = new Map();
  }

  /** @param {Array<{caster, ability, intervalMs, spreadMs, samples}>} rhythms */
  setKnown(rhythms) {
    this.known = new Map();
    for (const r of rhythms ?? []) {
      this.known.set(key(r.caster, r.ability), {
        intervalMs: r.intervalMs,
        spreadMs: r.spreadMs,
        samples: r.samples,
      });
    }
  }

  noteCast(caster, ability, ts) {
    this.record(caster, ability, ts, 'cast');
  }

  /**
   * Evidence from a spell LANDING (damage or resist line) rather than a cast line.
   *
   * This exists for innate breath weapons: Lord Nagafen's Lava Breath never prints
   * "begins casting" — its ~13s cycle is visible only as landed damage on the group
   * and the occasional "You resist" — so the landings are the only clock there is.
   */
  noteLanded(caster, ability, ts) {
    this.record(caster, ability, ts, 'landed');
  }

  record(caster, ability, ts, source) {
    const k = key(caster, ability);
    let entry = this.entries.get(k);
    if (!entry) {
      this.entries.set(k, newEntry(caster, ability, ts, source));
      return;
    }

    // A spell with BOTH cast lines and landing lines must never mix the two: each
    // cycle would contribute a full gap AND a tiny cast-to-landing gap, wrecking the
    // median. Cast-start evidence wins — it anchors earlier, which is when the
    // warning matters — so landings are ignored once casts exist, and the first cast
    // seen restarts a landings-built entry from scratch.
    if (source === 'landed' && entry.source === 'cast') return;
    if (source === 'cast' && entry.source === 'landed') {
      // The slot is not re-claimed: `armedTs` carries over so a spell that switches
      // evidence mid-fight keeps the row the player has already learned to look at.
      this.entries.set(k, { ...newEntry(caster, ability, ts, source), armedTs: entry.armedTs });
      return;
    }

    if (source === 'landed' && entry.lastTs !== null) {
      const sinceVolley = ts - entry.lastTs;
      if (sinceVolley >= 0 && sinceVolley < VOLLEY_MS) return;   // same volley echo
    }

    const gap = ts - entry.lastTs;
    entry.lastTs = ts;

    if (gap <= 0 || gap > MAX_GAP_MS || Number.isNaN(gap)) return;
    if (entry.skipNextGap) {
      // The previous cast was interrupted, and EQ mobs retry early — a real effect
      // that would drag the learned median down if this gap were counted.
      entry.skipNextGap = false;
      return;
    }
    entry.gaps.push(gap);
    if (entry.gaps.length > MAX_GAPS_KEPT) entry.gaps.shift();
  }

  noteInterrupt(caster, ability) {
    const entry = this.entries.get(key(caster, ability));
    if (entry) entry.skipNextGap = true;
  }

  /**
   * A dead caster predicts nothing further. Its slots survive as 'ended' rows until
   * the fight closes — collapsing them would move every row below — and its learned
   * gaps still count at export.
   */
  dropCaster(caster) {
    for (const entry of this.entries.values()) {
      if (entry.caster === caster) entry.lastTs = null;
    }
  }

  /** The qualified in-fight estimate for one entry, or null. */
  inFightEstimate(entry) {
    if (entry.gaps.length < QUALIFY_MIN_GAPS) return null;
    const intervalMs = median(entry.gaps);
    const spreadMs = spreadOf(entry.gaps, intervalMs);
    if (spreadMs / intervalMs >= QUALIFY_MAX_CV) return null;
    return { intervalMs, spreadMs };
  }

  /**
   * The best estimate available for one entry, or null if none is earned yet.
   *
   * In-fight evidence outranks the stored prior: what THIS pull is doing beats what
   * last week's pull did. The prior only fills in before three gaps exist.
   */
  estimate(entry, k) {
    const inFight = this.inFightEstimate(entry);
    if (inFight) return { ...inFight, warm: false };

    const prior = this.known.get(k ?? key(entry.caster, entry.ability));
    if (prior && prior.samples >= WARM_START_MIN_SAMPLES) {
      return { intervalMs: prior.intervalMs, spreadMs: prior.spreadMs, warm: true };
    }
    return null;
  }

  /**
   * Every slot this fight has claimed, in the order it claimed them.
   *
   * This returns SLOTS, not live countdowns: once a (caster, ability) pair has armed
   * once it stays in the list for the rest of the fight, and the caller paints it
   * wherever it first appeared. That is the whole point — the previous design dropped
   * an entry the moment its prediction retracted and re-added it on the next cast,
   * which measured out as 72 vanish-and-return cycles in one live session and made a
   * row impossible to read. Nothing is dropped here; the fight ending drops all of it
   * at once, via reset().
   *
   * `state` says what the row may claim:
   *   'armed'  — a live prediction; `dueMs` counts down.
   *   'lapsed' — the pattern broke (or never re-qualified). `dueMs` is null, and the
   *              UI must show a dash: a retracted prediction has no honest number.
   *   'ended'  — the caster is dead. Also null; the row dims rather than collapsing
   *              the panel and shoving the surviving rows up.
   *
   * @returns {Array<{caster, ability, dueMs, intervalMs, spreadMs, warm, since, state}>}
   *   `warm` marks a prediction running on a stored rhythm rather than this fight's
   *   own gaps — the UI labels both as estimates, but a warm one is the weaker claim.
   *   `since` is when the slot was claimed, and the sort key.
   */
  timers(now) {
    const out = [];
    for (const [k, entry] of this.entries) {
      const est = this.estimate(entry, k);

      // A LIVE prediction needs all three: an estimate, a caster still alive, and
      // reality not yet past the point where "a bit late" became "the pattern broke".
      let dueMs = null;
      if (est && entry.lastTs !== null) {
        const overdue = now - (entry.lastTs + est.intervalMs);
        const tolerance = Math.max(est.spreadMs * RETRACT_SPREAD_FACTOR, RETRACT_FLOOR_MS);
        if (overdue <= tolerance) dueMs = Math.max(0, -overdue);
      }

      // A slot is claimed the first time the pair actually predicts something, and
      // never afterwards — so a re-arm, a re-anchor or a retraction all reuse the row
      // the player already knows. A pair that has never predicted has no row at all.
      if (dueMs !== null && entry.armedTs === null) entry.armedTs = now;
      if (entry.armedTs === null) continue;

      out.push({
        caster: entry.caster,
        ability: entry.ability,
        dueMs,
        intervalMs: est?.intervalMs ?? null,
        spreadMs: est?.spreadMs ?? null,
        warm: est?.warm ?? false,
        since: entry.armedTs,
        state: dueMs !== null ? 'armed' : entry.lastTs === null ? 'ended' : 'lapsed',
      });
    }
    // First-claimed first, and never re-sorted by what is due next. Ties keep Map
    // insertion order, since Array#sort is stable — two slots arming in the same
    // tick still land in a deterministic order.
    return out.sort((a, b) => a.since - b.since);
  }

  /**
   * Everything this fight taught us, for the persistent store. Only qualified
   * rhythms export — an unqualified spread is noise, and pooling noise into the
   * store would erode exactly the priors that make warm starts trustworthy.
   */
  learned() {
    const out = [];
    for (const entry of this.entries.values()) {
      const est = this.inFightEstimate(entry);
      if (!est) continue;
      out.push({
        caster: entry.caster,
        ability: entry.ability,
        intervalMs: est.intervalMs,
        spreadMs: est.spreadMs,
        samples: entry.gaps.length,
      });
    }
    return out;
  }

  reset() {
    this.entries = new Map();
  }
}
