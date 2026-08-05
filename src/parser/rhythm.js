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
      entry = { caster, ability, gaps: [], lastTs: ts, skipNextGap: false, source };
      this.entries.set(k, entry);
      return;
    }

    // A spell with BOTH cast lines and landing lines must never mix the two: each
    // cycle would contribute a full gap AND a tiny cast-to-landing gap, wrecking the
    // median. Cast-start evidence wins — it anchors earlier, which is when the
    // warning matters — so landings are ignored once casts exist, and the first cast
    // seen restarts a landings-built entry from scratch.
    if (source === 'landed' && entry.source === 'cast') return;
    if (source === 'cast' && entry.source === 'landed') {
      this.entries.set(k, { caster, ability, gaps: [], lastTs: ts, skipNextGap: false, source });
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

  /** A dead caster's timers are over; its learned gaps still count at export. */
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
   * Active predictions at `now`.
   *
   * In-fight evidence outranks the stored prior: what THIS pull is doing beats what
   * last week's pull did. The prior only fills in before three gaps exist.
   *
   * @returns {Array<{caster, ability, dueMs, intervalMs, spreadMs, warm}>}
   *   `warm` marks a prediction running on a stored rhythm rather than this fight's
   *   own gaps — the UI labels both as estimates, but a warm one is the weaker claim.
   */
  timers(now) {
    const out = [];
    for (const [k, entry] of this.entries) {
      if (entry.lastTs === null) continue;

      let est = this.inFightEstimate(entry);
      let warm = false;
      if (!est) {
        const prior = this.known.get(k);
        if (prior && prior.samples >= WARM_START_MIN_SAMPLES) {
          est = { intervalMs: prior.intervalMs, spreadMs: prior.spreadMs };
          warm = true;
        }
      }
      if (!est) continue;

      const dueTs = entry.lastTs + est.intervalMs;
      const overdue = now - dueTs;
      const tolerance = Math.max(est.spreadMs * RETRACT_SPREAD_FACTOR, RETRACT_FLOOR_MS);
      if (overdue > tolerance) continue;   // the pattern broke — retract, don't lie

      out.push({
        caster: entry.caster,
        ability: entry.ability,
        dueMs: Math.max(0, dueTs - now),
        intervalMs: est.intervalMs,
        spreadMs: est.spreadMs,
        warm,
      });
    }
    return out.sort((a, b) => a.dueMs - b.dueMs);
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
