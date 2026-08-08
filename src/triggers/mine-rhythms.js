/**
 * mine-rhythms — measuring a boss's recast interval OFFLINE, so it can be written down.
 *
 * This is the surviving half of the deleted rhythm learner. The statistics were never
 * the problem: a median of observed gaps is a perfectly good way to arrive at "Mana
 * Drain every 19s". Doing it at 4 Hz in the middle of a raid was — the player could not
 * see the derivation, could not correct the answer when it was wrong, and could not give
 * it to anybody else. So the same computation moves here, where a person reviews the
 * output before any of it ships, and the answer becomes an ordinary trigger with a
 * pattern and a number.
 *
 * Two things this module is careful about, both of which the live learner never had to
 * be:
 *
 *  - **Raw names, never canonical ones.** The learner keyed on the parser's resolved
 *    display name, because everything downstream of it spoke that language. A trigger
 *    pattern runs against the raw log line and knows nothing of `entities.js`, so
 *    templating `Marrowbane pet` into a pattern would be fine and templating a resolved
 *    `` Rhale`s warder `` as `Rhale` would produce a trigger that never fires — dead in
 *    the dry-run with no obvious cause. Everything here carries the raw matched text.
 *  - **Which evidence a pair was measured from.** A normal boss announces itself
 *    ("Lord Nagafen begins casting Shadow Vortex."), but an innate breath weapon prints
 *    no cast line at all — Lava Breath's cycle is visible only as landed damage and the
 *    occasional resist. Those are two different patterns, and the learner, which only
 *    ever produced a number, had no reason to remember which one it had watched.
 *
 * Pure Node with no Electron import, like everything else under `src/triggers/`, so the
 * whole thing unit-tests in WSL. The command line around it is `scripts/mine-rhythms.js`,
 * which prints candidates and writes nothing without `--write` — the same discipline
 * `mine-gina.js` and `collect-unknown.js` follow, and for the same reason: a shipped
 * pack is a reviewed list, and a script that wrote one unattended would quietly turn it
 * into a scraped one.
 */

import { escapeRegex } from './tokens.js';
import { normalize } from './pack.js';

/** Gaps this long are a lull or a fight boundary, not a recast cycle. */
export const MAX_GAP_MS = 90_000;

/**
 * Landed-evidence lines closer together than this are ONE volley, not a new cycle: an AE
 * prints a damage line per group member in the same second or two, and counting those as
 * gaps would bury the real interval under zeros.
 */
export const VOLLEY_MS = 2500;

/** Fewer agreeing gaps than this and there is nothing to take a median of. */
export const MIN_GAPS = 3;

/**
 * Relative spread (spread / interval) at which a pair stops being predictable.
 *
 * The same 0.25 the live learner used, and it came from the same measurement: of 220
 * (caster, spell) pairs with five or more in-fight recasts, only 11 sat under it. Quag
 * Maelstrom's Mana Drain lands every 19s ± 1.5s and a countdown for that is a service;
 * Gonobn's Stun wanders ± 14s around a 28s median and a countdown for that would
 * routinely lie by half a cycle. The difference between then and now is only WHO acts on
 * the number — the learner hid the loose ones, and this prints them and marks them so a
 * person decides.
 */
export const LOOSE_CV = 0.25;

/** A spread cannot honestly be tighter than this; the log's clock has one-second grain. */
const SPREAD_FLOOR_MS = 500;

const key = (caster, ability) => `${caster}|${ability}`;

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation, scaled by 1.4826 to estimate a standard deviation. */
function spreadOf(values, mid) {
  const deviations = values.map((v) => Math.abs(v - mid));
  return Math.max(SPREAD_FLOOR_MS, median(deviations) * 1.4826);
}

function newEntry(caster, ability, ts, source, sample) {
  return { caster, ability, source, gaps: [], lastTs: ts, skipNextGap: false, runs: 1, sample };
}

/**
 * Accumulates evidence about (raw caster, ability) pairs and reports what is regular
 * enough to write down.
 *
 * Statistics are median + MAD rather than mean + sd for the reason the learner had:
 * a boss that skips one cycle — stunned, moved, out of mana — produces a single
 * double-length gap, and one outlier through a mean wrecks an estimate the median
 * shrugs off.
 */
export class RhythmMiner {
  constructor({ maxGapMs = MAX_GAP_MS, volleyMs = VOLLEY_MS } = {}) {
    /** @type {Map<string, object>} */
    this.entries = new Map();
    this.maxGapMs = maxGapMs;
    this.volleyMs = volleyMs;
  }

  /**
   * One piece of evidence that a pair fired.
   *
   * @param {{caster: string, ability: string, ts: number,
   *          source: 'cast'|'landed', body?: string}} obs
   *   `caster` is RAW log text. `body` is the log line with its timestamp stripped, kept
   *   for the first observation of each pair so the generated pack can carry the sample
   *   line its pattern was written against — which is what `tests/seed-pack.test.js`
   *   checks the pattern still matches.
   */
  observe({ caster, ability, ts, source, body = null }) {
    if (!caster || !ability || !Number.isFinite(ts)) return;
    const k = key(caster, ability);
    const entry = this.entries.get(k);
    if (!entry) {
      this.entries.set(k, newEntry(caster, ability, ts, source, body));
      return;
    }

    // A spell with BOTH cast lines and landing lines must never mix the two: each cycle
    // would contribute a full gap AND a tiny cast-to-landing gap, wrecking the median.
    // Cast evidence wins — it anchors earlier, which is when a warning is worth
    // anything — so landings are ignored once casts exist, and the first cast seen
    // restarts a landings-built entry from scratch rather than pooling the two.
    if (source === 'landed' && entry.source === 'cast') return;
    if (source === 'cast' && entry.source === 'landed') {
      this.entries.set(k, newEntry(caster, ability, ts, source, body));
      return;
    }

    if (source === 'landed' && entry.lastTs !== null) {
      const sinceVolley = ts - entry.lastTs;
      if (sinceVolley >= 0 && sinceVolley < this.volleyMs) return;
    }

    const gap = ts - entry.lastTs;
    entry.lastTs = ts;

    if (gap > this.maxGapMs) {
      // A different pull, hours later. Not a gap, and worth counting: a number measured
      // across several fights is a stronger claim than the same number from one.
      entry.runs++;
      return;
    }
    if (!(gap > 0)) return;
    if (entry.skipNextGap) {
      // The previous cast was interrupted, and EQ mobs retry early — a real effect that
      // would drag the measured median down if this gap were counted.
      entry.skipNextGap = false;
      return;
    }
    entry.gaps.push(gap);
  }

  /** The cast that just got interrupted will be retried early; skip the gap it makes. */
  interrupt(caster, ability) {
    const entry = this.entries.get(key(caster, ability));
    if (entry) entry.skipNextGap = true;
  }

  /**
   * Everything measured, tightest first, with the loose ones marked rather than dropped.
   *
   * Marked rather than dropped because the reviewer is the point of this script. A pair
   * too irregular to predict is still worth SEEING — it is how you learn that Master
   * Yael's Immobilize wanders by eighteen seconds and therefore must not ship as a fixed
   * number — and a script that silently withheld it would be making that call itself.
   *
   * @returns {Array<{caster, ability, source, intervalMs, spreadMs, cv, samples, runs,
   *                  loose, sample}>}
   */
  candidates({ minGaps = MIN_GAPS, looseCv = LOOSE_CV } = {}) {
    const out = [];
    for (const entry of this.entries.values()) {
      if (entry.gaps.length < minGaps) continue;
      const intervalMs = median(entry.gaps);
      const spreadMs = spreadOf(entry.gaps, intervalMs);
      out.push({
        caster: entry.caster,
        ability: entry.ability,
        source: entry.source,
        intervalMs: Math.round(intervalMs),
        spreadMs: Math.round(spreadMs),
        cv: spreadMs / intervalMs,
        samples: entry.gaps.length,
        runs: entry.runs,
        loose: spreadMs / intervalMs >= looseCv,
        sample: entry.sample,
      });
    }
    return out.sort((a, b) => a.cv - b.cv || a.caster.localeCompare(b.caster));
  }
}

// ------------------------------------------------------------------------ patterns

/**
 * The pattern for a boss that announces its cast.
 *
 * Anchored at both ends against the line BODY, which is what the engine matches: the
 * timestamp is stripped before any trigger sees a line. `beg(?:ins|in)` mirrors
 * `rules.js`'s `cast-start` rather than hard-coding the third person, so the one pattern
 * shape covers every caster the log can name.
 */
export function castPattern(caster, ability) {
  return `^${escapeRegex(caster)} beg(?:ins|in) casting ${escapeRegex(ability)}\\.$`;
}

/**
 * The pattern for a boss whose spell has no cast line at all.
 *
 * Lord Nagafen's Lava Breath is the case this exists for: an innate breath weapon prints
 * only the damage it did, so the damage line IS the clock. Both halves are needed —
 * a volley the whole group resists leaves no damage line anywhere, and without the resist
 * form the countdown would silently skip that cycle.
 *
 * Deliberately NOT restricted to the logging character as the victim. Matching any target
 * means a volley re-arms the slot once per group member within the same second or two,
 * which `restart: 'new'` absorbs by resetting the countdown in place; restricting it to
 * "you" would make the timer stop dead whenever the player was out of range or already
 * down, which is precisely when a countdown is worth having.
 *
 * The trailing `(Critical)`-style modifiers EQ appends are why the damage half is not
 * anchored at the end.
 */
export function landedPattern(caster, ability) {
  const c = escapeRegex(caster);
  const a = escapeRegex(ability);
  return `^(?:${c} hit .+? for \\d+ points? of \\w+ damage by ${a}\\.` +
    `|You resist ${c}'s ${a}!)`;
}

/** The pattern for a pair, chosen by which evidence it was actually measured from. */
export function patternFor(candidate) {
  return candidate.source === 'landed'
    ? landedPattern(candidate.caster, candidate.ability)
    : castPattern(candidate.caster, candidate.ability);
}

/**
 * The line that says this caster is dead, in all three wordings `rules.js` knows.
 *
 * This is what keeps the CLAUDE.md invariant — a slain caster's rows leave the panel at
 * once — true now that the countdown comes from a pack rather than from the parser. It
 * is the engine's ordinary `earlyEnders` mechanism doing it, so the behaviour is visible
 * in the pack a player can open and read instead of buried in a tracker's `dropCaster`.
 */
export function deathPattern(caster) {
  const c = escapeRegex(caster);
  return `^(?:${c} has been slain by .+!|You have slain ${c}!|${c} died\\.)$`;
}

// ---------------------------------------------------------------------------- pack

/**
 * One reviewed candidate as a stored trigger.
 *
 * `restart: 'new'` and a `countdown` rather than a `repeating` timer, and the difference
 * matters: each observed cast restarts this slot in place, so the row arms on cast #1
 * where the learner needed three agreeing gaps before it would show anything. A repeating
 * timer would keep re-arming itself after the boss was dead, which is the failure the
 * never-move rule cares about.
 */
export function seedTrigger(candidate, { id, groupId = null }) {
  const label = `${candidate.caster} — ${candidate.ability}`;
  return {
    id,
    name: label,
    groupId,
    enabled: true,
    comments: provenanceLine(candidate),
    pattern: patternFor(candidate),
    literal: false,
    usesCharacter: false,
    fastCheck: true,
    // No chip. The cast alerts already say "Lord Nagafen begins casting Shadow Vortex"
    // when that spell is in a group the player warns on, and a second surface repeating
    // it would be one event drawn twice.
    warn: null,
    timer: {
      kind: 'countdown',
      // Carries the boss, because the panel's own sub-line names the PACK a row came
      // from rather than the caster — which is the honest answer to "why is this on my
      // screen" and useless for "who is about to do this to me".
      name: label,
      durationMs: candidate.intervalMs,
      restart: 'new',
      restartByName: true,
      endingMs: null,
      endingText: null,
      earlyEnders: [{
        pattern: deathPattern(candidate.caster),
        literal: false,
        usesCharacter: false,
        needsMatch: false,
      }],
    },
    provenance: 'authored',
  };
}

/**
 * How this row's number was arrived at, in the trigger's own comment field.
 *
 * The whole point of the change is that a countdown on screen has a derivation the player
 * can read, so the derivation travels inside the pack rather than in a changelog.
 */
function provenanceLine(c) {
  const evidence = c.source === 'landed'
    ? 'measured from its landing lines — this one prints no cast'
    : 'measured from its cast lines';
  return `${(c.intervalMs / 1000).toFixed(1)}s ±${(c.spreadMs / 1000).toFixed(1)} ` +
    `over ${c.samples} gaps in ${c.runs} fight${c.runs === 1 ? '' : 's'}, ${evidence}.`;
}

/**
 * A whole pack from a reviewed candidate list, grouped by caster.
 *
 * One group per boss so a player can switch off everything a mob does with one click —
 * the same shape a GINA pack uses for the same reason, and the reason the Triggers window
 * renders groups at all.
 */
export function packFromCandidates(candidates, { id, name, comments = '', modified = '' } = {}) {
  const groups = [];
  const byCaster = new Map();
  for (const c of candidates) {
    if (byCaster.has(c.caster)) continue;
    const groupId = `g${groups.length + 1}`;
    byCaster.set(c.caster, groupId);
    groups.push({ id: groupId, name: c.caster, comments: '', path: [c.caster], enabled: true });
  }

  return normalize({
    id,
    name,
    comments,
    modified,
    origin: 'native',
    shipped: true,
    enabled: true,
    groups,
    triggers: candidates.map((c, i) => seedTrigger(c, {
      id: `t${i + 1}`,
      groupId: byCaster.get(c.caster),
    })),
  });
}
