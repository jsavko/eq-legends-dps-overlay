/**
 * mine-buffs — measuring how long the player's OWN effects last, from their own log.
 *
 * The sibling of `mine-rhythms.js`, pointed the other way. That one measures how often a
 * boss recasts something; this one measures how long a thing you cast on yourself stays
 * up, so a countdown for it can be written down with a number that came from your log
 * rather than from a table somebody else wrote.
 *
 * ------------------------------------------------------------ why there is no spell list
 *
 * The obvious implementation is a table: spell name → duration. It is also wrong here, and
 * not marginally. Buff length in EverQuest depends on the caster's level, on the rank of
 * the spell (`Spirit of the Puma V` and `VI` differ by thirteen seconds in the same
 * session of the live log), and on whatever AAs the player has bought — and the set of
 * effects a player even HAS is their class and their character. A shipped list would be
 * wrong for everybody in a slightly different way, and wrong in the direction that
 * matters: a countdown that ends before the buff does is worse than no countdown, because
 * you learn to trust it.
 *
 * So the pairs are discovered rather than known:
 *
 *   1. A **land line** is prose that shows up just after `You begin casting <Spell>.` —
 *      "You begin to snarl as your features become feline." That proximity is what makes
 *      it the player's own effect rather than something that happened near them, and the
 *      cast line is also where the effect's NAME comes from.
 *   2. A **wear-off line** is the body that keeps turning up a consistent interval after
 *      the most recent land — "The spirit of the puma departs."
 *   3. The **duration** is the median of last-land → wear-off.
 *
 * ------------------------------------------------------------------- last-land, not first
 *
 * That "last" is the measurement, not a detail. Recasting a buff REFRESHES it, and the
 * player recasts constantly — in the live log the puma buff was recast two or three times
 * per cycle. Measuring from the first land of a cycle gives a number between 119 and 174
 * seconds depending on how twitchy the player was; measuring from the last gives 146s in
 * seven of nine cycles. Only one of those is a duration.
 *
 * ---------------------------------------------------------------------------- the filters
 *
 * The one that does nearly all the work is `rules.js` itself: **buff prose is exactly the
 * text no combat rule matches.** That is not a coincidence and it is not a heuristic — it
 * is what `collect-unknown.js` has always reported, and this module wants the other half
 * of that same split. Melee misses, dodges, parries, targets, casts, heals and zone lines
 * are all matched and therefore all gone in one test, which matters because most of them
 * carry no digits either: `You try to crush Hoptor Thaggelum, but miss!` sailed through
 * a digit filter, repeated forty thousand times, and produced nine thousand "effects"
 * before the rule table was brought in.
 *
 * Two cheap tests run in front of it for speed — a body with a digit in it or longer than
 * a sentence is never buff prose. What is left is a few hundred bodies per log, small
 * enough for the pairing search to be a nested loop.
 *
 * Pure Node with no Electron import, like everything else under `src/triggers/`, so the
 * whole thing unit-tests in WSL. `scripts/mine-buffs.js` is the command line around it and
 * writes nothing without `--write`, the same discipline every other miner here follows.
 */

import { escapeRegex } from './tokens.js';
import { normalize, BOSS_PANEL } from './pack.js';
// The one import outside `src/triggers/`, and the same justification `engine.js` gives
// for `parseTimestamp`: it is a pure function, and the alternative — a second opinion
// here about which lines are combat — is a copy that would drift out of agreement with
// the real table and go quietly wrong.
import { matchRule } from '../parser/rules.js';
import { parseTimestamp } from '../parser/timestamp.js';
// The tail reader the dry-run already uses: latin1, chunked, and yielding between chunks
// so a 178 MB scan cannot stall the tailer and take the live meter down with it. Shared
// rather than rewritten, because "read the player's log without breaking the overlay" is
// a solved problem here and solving it twice is how the second copy gets it wrong.
import { readLogTail } from './dryrun.js';

/** How soon after a cast line its landing prose must appear to be considered its own. */
export const CAST_WINDOW_MS = 4000;

/** Shorter than this is not a buff worth a panel row — it is a proc or a message. */
export const MIN_DURATION_MS = 15_000;

/** Longer than this and the "pair" is two unrelated things that happened the same hour. */
export const MAX_DURATION_MS = 2 * 60 * 60 * 1000;

/** Fewer complete cycles than this and there is nothing to take a median of. */
export const MIN_OBSERVATIONS = 3;

/**
 * Relative spread at which a measured duration stops being one number.
 *
 * Looser than `mine-rhythms`'s 0.25, deliberately: a boss's recast interval is a server
 * constant and a wide spread means the model is wrong, but a buff's observed length is
 * shortened by every zone, death and click-off, so a real duration legitimately shows a
 * fatter tail. Loose candidates are marked and printed rather than dropped — the reviewer
 * is the point of this script.
 */
export const LOOSE_CV = 0.35;

/** A spread cannot honestly be tighter than this; the log's clock has one-second grain. */
const SPREAD_FLOOR_MS = 500;

/** Buff prose has no digits in it. Damage, xp, faction, coin and rank lines all do. */
const HAS_DIGIT = /\d/;

/** Long enough to be a sentence somebody said, not a line the game printed. */
const MAX_BODY_LENGTH = 120;

/**
 * How often the winning spell must have been in flight when this prose appeared.
 *
 * Measured against the number of times the LINE appeared, not against the number of
 * attributions — and the difference is the whole test. Several spells are in flight in
 * any four-second window, so even a perfect pairing only holds a third of the credits:
 * the puma's landing line was credited to thirty-eight different spells and its own rank
 * held 34 % of them, which reads as noise and is not. Against occurrences it is 80 %, and
 * that is the honest number: four times in five, when this line appeared, that spell had
 * just been cast.
 */
const NAME_SHARE = 0.5;

/** A wear-off cannot happen much more often than the buff lands. Slack for a log that
 *  opens mid-buff, and no more. */
const WEAR_OFF_RATIO = 1.5;

/**
 * How much of the alternation has to hold, from both directions.
 *
 * A real wear-off and its land STRICTLY ALTERNATE: every wear-off has at least one land
 * since the previous wear-off (the buff was re-applied), and every run of lands ends in
 * one (the buff eventually dropped). Both halves are needed and neither is sufficient.
 * Requiring only the first lets any common line through, because with a land that fires
 * four hundred times there is always some land behind you; requiring only the second lets
 * through a line that fires constantly for other reasons.
 *
 * The slack is for the honest edges — a log that opens mid-buff, or ends with the buff
 * still up, or a session where the player camped without letting it drop.
 */
const ALTERNATION = 0.6;

/** Past this, a pair is not one duration and no median will make it one. */
const MAX_CV = 0.4;

/**
 * A landing line for THIS panel has to be about the player.
 *
 * A deliberate scope limit, not an oversight. The log is full of prose about other
 * people's effects and other mobs' procs — "Bazzzazzt staggers.", "Rhale`s warder's body
 * pulses with energy." — and every one of them is somebody's timer, just not one this
 * panel is for. Requiring the second person is the cheapest honest way to say "mine",
 * and a player who wants their pet's buffs can write that trigger by hand with the same
 * two lines this script would have found.
 */
const ABOUT_ME = /\b(?:you|your)\b/i;

/** `You begin casting Spirit of the Puma VI.` — the name, rank included. Only used when
 *  the caller has not already handed over a matched rule event. */
const CAST_RE = /^You begin (?:casting|singing) (.+?)\.$/;

/** The rank suffix EQ appends. Split off for the display name and reported separately,
 *  because two ranks of one spell are two durations and the player has to see that. */
const RANK_RE = /\s+(?:[IVXL]+|\d+)$/;

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation, scaled by 1.4826 to estimate a standard deviation. Median
 *  rather than mean for the reason `mine-rhythms` uses it: one zone-out produces one
 *  short cycle, and an outlier through a mean wrecks what a median shrugs off. */
function spreadOf(values, mid) {
  const deviations = values.map((v) => Math.abs(v - mid));
  return Math.max(SPREAD_FLOOR_MS, median(deviations) * 1.4826);
}

/**
 * Accumulates every repeated, digit-free line body with its timestamps, plus which of
 * them followed a cast, and reports the land/wear-off pairs that alternate cleanly.
 *
 * Two passes by construction: `observe` can only bank evidence, because whether a body is
 * a wear-off line is a question about the WHOLE log and cannot be answered as the lines
 * go by. `candidates()` is where the pairing happens.
 */
export class BuffMiner {
  constructor({
    castWindowMs = CAST_WINDOW_MS,
    minDurationMs = MIN_DURATION_MS,
    maxDurationMs = MAX_DURATION_MS,
  } = {}) {
    this.castWindowMs = castWindowMs;
    this.minDurationMs = minDurationMs;
    this.maxDurationMs = maxDurationMs;

    /** @type {Map<string, number[]>} body → every timestamp it appeared at */
    this.bodies = new Map();
    /** @type {Map<string, Map<string, number>>} land body → spell name → times seen */
    this.named = new Map();
    /** The cast lines still inside their window, oldest first. */
    this.recentCasts = [];
  }

  /**
   * One log line, timestamp already stripped.
   *
   * Everything digit-free and short enough is banked, because which bodies matter is not
   * knowable yet. The memory that costs is bounded by how many DISTINCT such lines a log
   * holds, which in a 178 MB live log is a few thousand.
   */
  observe(body, ts) {
    if (typeof body !== 'string' || !Number.isFinite(ts)) return;
    if (HAS_DIGIT.test(body) || body.length > MAX_BODY_LENGTH) {
      // Still worth asking whether it was a cast: `You begin casting Spirit of the Puma
      // VI.` has a rank in it and would otherwise be dropped by the digit test.
      const early = CAST_RE.exec(body);
      if (early) this.recentCasts.push({ name: early[1], ts });
      return;
    }

    // The rule table decides. A line any combat rule claims is not buff prose — and a
    // cast line is where the effect's NAME comes from, so it is claimed here rather than
    // merely skipped.
    const event = matchRule(body);
    if (event) {
      if (event.kind === 'cast' && event.ability) {
        this.recentCasts.push({ name: event.ability, ts });
      } else {
        const cast = CAST_RE.exec(body);
        if (cast) this.recentCasts.push({ name: cast[1], ts });
      }
      return;
    }

    let times = this.bodies.get(body);
    if (!times) {
      times = [];
      this.bodies.set(body, times);
    }
    // A body repeated inside the same second is one event logged twice, not two.
    if (times.length && ts === times[times.length - 1]) return;
    times.push(ts);

    // Anything arriving just after a cast is a candidate for that spell's landing prose.
    // Counted rather than flagged, because a line that follows a cast once is a
    // coincidence and one that follows the same cast twenty times is the effect.
    while (this.recentCasts.length && ts - this.recentCasts[0].ts > this.castWindowMs) {
      this.recentCasts.shift();
    }
    for (const cast of this.recentCasts) {
      let names = this.named.get(body);
      if (!names) {
        names = new Map();
        this.named.set(body, names);
      }
      names.set(cast.name, (names.get(cast.name) ?? 0) + 1);
    }
  }

  /** Convenience for a caller holding a whole line: split it and bank the body. */
  feed(line, parseTimestamp) {
    const parsed = parseTimestamp(line);
    if (parsed) this.observe(parsed.body, parsed.ts);
  }

  /**
   * Every land/wear-off pair the log supports, longest-observed first.
   *
   * `maxCv` exists for the in-app caller and not for the script. The script's whole job
   * is to put candidates in front of a person, so it shows the loose ones marked; the
   * button in the Triggers window SAVES what it finds, so handing it a hundred rows to
   * prune would be making the player do the reviewing at the worst possible moment. Same
   * measurement, different quantity of it.
   *
   * @returns {Array<{name, land, wearOff, durationMs, spreadMs, cv, samples, ranks,
   *                  loose}>}
   */
  candidates({ minObs = MIN_OBSERVATIONS, looseCv = LOOSE_CV, maxCv = Infinity } = {}) {
    // Land candidates: prose that followed a cast at least `minObs` times. That threshold
    // is what separates the effect's own line from whatever else happened to be printed
    // during one cast — a group member's heal landing, somebody zoning in.
    const lands = [];
    for (const [body, names] of this.named) {
      const times = this.bodies.get(body) ?? [];
      if (times.length < minObs) continue;
      if (!ABOUT_ME.test(body)) continue;

      // Ranks are folded together before the winner is chosen: `Spirit of the Puma V`
      // and `X` are one spell casting into one line, and counting them apart would let
      // a spell the player has upgraded lose to a coincidence.
      const byBase = new Map();
      for (const [name, count] of names) {
        const base = displayName(name);
        byBase.set(base, (byBase.get(base) ?? 0) + count);
      }
      const best = [...byBase.entries()].sort((a, b) => b[1] - a[1]);
      if (!best.length || best[0][1] < minObs) continue;
      if (best[0][1] / times.length < NAME_SHARE) continue;

      lands.push({ body, times, base: best[0][0], names });
    }

    const out = [];
    for (const land of lands) {
      const pair = this.bestWearOff(land, minObs);
      if (!pair) continue;

      const durationMs = median(pair.gaps);
      const spreadMs = spreadOf(pair.gaps, durationMs);
      // Every rank seen casting into this land line. More than one is the caveat that
      // matters most on this panel: the land prose is rank-agnostic while the duration
      // is not, so one trigger on it is honest only to within the ranks' difference.
      // Only the ranks of the spell this line was actually attributed to. The rest of
      // `land.names` is other spells that happened to be in flight, and listing them
      // would put somebody else's spell in this row's provenance.
      const base = land.base;
      const ranks = [...land.names.entries()]
        .filter(([name]) => displayName(name) === base)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }));

      out.push({
        name: base,
        land: land.body,
        wearOff: pair.body,
        durationMs: Math.round(durationMs),
        spreadMs: Math.round(spreadMs),
        cv: spreadMs / durationMs,
        samples: pair.gaps.length,
        ranks,
        loose: spreadMs / durationMs >= looseCv,
      });
    }
    return out
      .filter((c) => c.cv <= maxCv)
      .sort((a, b) => b.samples - a.samples || a.name.localeCompare(b.name));
  }

  /**
   * The body that best behaves like this land line's wear-off.
   *
   * "Behaves like" is three things at once, and all three are needed: it comes AFTER a
   * land (never orphaned), it comes a consistent interval after the LAST land before it
   * (because a recast refreshes), and it does so enough times to take a median of. The
   * winner is the tightest such body, not merely the commonest — "You have entered
   * Plane of Sky." follows a lot of things.
   */
  bestWearOff(land, minObs) {
    let best = null;
    // How many runs of lands there are: a run is one or more lands with nothing between
    // them, which is one buff being applied and refreshed. A real wear-off ends most of
    // them, and that ratio is half the alternation test below.
    for (const [body, times] of this.bodies) {
      if (body === land.body) continue;
      if (times.length < minObs) continue;
      // A buff cannot wear off more often than it lands. This one test removes every
      // ambient line in the log — a zone message, a group member's own prose — without
      // naming any of them.
      if (times.length > land.times.length * WEAR_OFF_RATIO) continue;
      // A wear-off never follows a cast — it arrives minutes later, which is the point.
      // So a body that IS strongly cast-attributed is another effect's landing line, and
      // pairing one landing line with another produces a tidy-looking number about
      // nothing. This is what keeps the spell-book chatter ("You forget Valor of Marr.")
      // from ending buffs it has nothing to do with.
      if (this.castAttributed(body)) continue;

      const gaps = [];
      let orphans = 0;
      let cursor = 0;
      let previous = -Infinity;
      for (const ts of times) {
        // The lands lying strictly BETWEEN the previous wear-off and this one. That
        // window is the whole test: a wear-off with no land behind it since the last
        // wear-off is not this effect ending, because the effect was never re-applied.
        let latest = null;
        while (cursor < land.times.length && land.times[cursor] <= ts) {
          if (land.times[cursor] > previous) latest = land.times[cursor];
          cursor++;
        }
        previous = ts;
        if (latest === null) { orphans++; continue; }
        // ...and from the LAST of them, because a recast refreshes. Measuring from the
        // first land of a run is what turns a 146-second buff into anything from 119 to
        // 174 depending on how twitchy the player was.
        const gap = ts - latest;
        if (gap < this.minDurationMs || gap > this.maxDurationMs) { orphans++; continue; }
        gaps.push(gap);
      }
      if (gaps.length < minObs) continue;

      // Alternation, from both ends. Most of this line's own firings are the end of a
      // buff (few orphans), AND most of this buff's applications end in this line.
      if (gaps.length / times.length < ALTERNATION) continue;
      if (orphans > gaps.length * (1 - ALTERNATION)) continue;
      const runs = countRuns(land.times, times);
      if (runs && gaps.length / runs < ALTERNATION) continue;

      const mid = median(gaps);
      const cv = spreadOf(gaps, mid) / mid;
      if (cv > MAX_CV) continue;
      // Coverage first, tightness second. The commonest mistake the other way round is
      // picking a rare line that happens to sit at a fixed offset three times over a
      // line that ends the effect four hundred times with a little more scatter.
      const better = !best
        || gaps.length > best.gaps.length * 1.2
        || (gaps.length >= best.gaps.length * 0.8 && cv < best.cv);
      if (better) best = { body, gaps, cv };
    }
    return best;
  }

  /** Does this body keep turning up right after a cast? Then it is a landing line, not
   *  an ending one — see the call site. */
  castAttributed(body) {
    const names = this.named.get(body);
    if (!names) return false;
    const times = this.bodies.get(body)?.length ?? 0;
    if (!times) return false;
    let top = 0;
    const byBase = new Map();
    for (const [name, count] of names) {
      const base = displayName(name);
      const total = (byBase.get(base) ?? 0) + count;
      byBase.set(base, total);
      if (total > top) top = total;
    }
    return top / times >= NAME_SHARE;
  }
}

/**
 * How many runs of `lands` are separated by an occurrence of `enders`.
 *
 * One run is one application of the buff, refreshes included. Comparing the number of
 * complete cycles against this is the second half of the alternation test: a line that
 * ends a tenth of the buff's applications is not what ends the buff.
 */
function countRuns(lands, enders) {
  let runs = 0;
  let i = 0;
  let j = 0;
  let open = false;
  while (i < lands.length || j < enders.length) {
    const nextLand = i < lands.length ? lands[i] : Infinity;
    const nextEnd = j < enders.length ? enders[j] : Infinity;
    if (nextLand <= nextEnd) { open = true; i++; continue; }
    if (open) runs++;
    open = false;
    j++;
  }
  if (open) runs++;
  return runs;
}

/** The spell without its rank suffix — what the row should be called. The ranks travel
 *  separately rather than being thrown away, because they are the caveat. */
export function displayName(spell) {
  return String(spell ?? '').replace(RANK_RE, '').trim() || String(spell ?? '');
}

// ------------------------------------------------------------------------ patterns

/**
 * An exact log line as a pattern.
 *
 * Anchored at both ends and fully escaped, against the line BODY — which is what the
 * engine matches, since the timestamp is stripped before any trigger sees a line. There
 * is no capture and no token: this prose names nobody and varies in nothing, which is
 * exactly why it is a reliable clock.
 */
export function linePattern(body) {
  return `^${escapeRegex(body)}$`;
}

// ---------------------------------------------------------------------------- pack

/**
 * One reviewed candidate as a stored trigger.
 *
 * `restart: 'restart'` and a `countdown`, and both are the measurement talking: a recast
 * refreshes the effect, so a second land has to reset THIS row rather than open another
 * beside it — which is also what the panel's never-move rule requires. A `repeating`
 * timer would be wrong for a different reason: it would go on re-arming itself long after
 * the buff had been allowed to drop.
 *
 * No chip. A countdown that is about to run out already says so on the panel, and a
 * banner across the eyeline for "your buff has thirty seconds left" is the kind of
 * interruption the alerts window exists to ration.
 */
export function buffTrigger(candidate, { id, groupId = null, panel = BOSS_PANEL }) {
  return {
    id,
    name: candidate.name,
    groupId,
    enabled: true,
    comments: provenanceLine(candidate),
    pattern: linePattern(candidate.land),
    literal: false,
    usesCharacter: false,
    fastCheck: true,
    warn: null,
    timer: {
      kind: 'countdown',
      name: candidate.name,
      durationMs: candidate.durationMs,
      restart: 'restart',
      restartByName: true,
      endingMs: null,
      endingText: null,
      panel,
      // The measured wear-off line, so a buff that is dispelled, clicked off or lost to a
      // zone takes its row with it instead of counting down to a number that stopped
      // meaning anything. This is the same mechanism the boss pack uses for a death line.
      earlyEnders: [{
        pattern: linePattern(candidate.wearOff),
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
 * The derivation travels inside the pack rather than in a changelog, for the reason the
 * boss pack states: a countdown on screen should have a derivation the player can open
 * and read. Here it also carries the rank caveat, which is the one thing about these
 * numbers a player can act on — if two ranks are listed, the duration is a compromise
 * between them and splitting the trigger in two is the fix.
 */
function provenanceLine(c) {
  const ranks = c.ranks.map((r) => r.name);
  const caveat = ranks.length > 1
    ? ` Seen cast as ${ranks.join(', ')} — ranks differ in length, so this is the middle ` +
      'of them; split it into one trigger per rank to be exact.'
    : '';
  return `${(c.durationMs / 1000).toFixed(0)}s ±${(c.spreadMs / 1000).toFixed(0)} over ` +
    `${c.samples} cycle${c.samples === 1 ? '' : 's'} of your own log, ` +
    `measured from "${c.land}" to "${c.wearOff}".${caveat}`;
}

/**
 * A whole pack from a reviewed candidate list.
 *
 * No groups. The boss pack groups by caster because switching off everything one mob does
 * is a real gesture; these are all the same caster — you — and a group per spell would be
 * a group per row, which is a switch beside a switch.
 */
export function packFromBuffs(candidates, {
  id, name, comments = '', modified = '', panel = BOSS_PANEL,
} = {}) {
  return normalize({
    id,
    name,
    comments,
    modified,
    origin: 'native',
    // NOT shipped: this pack was made from the player's log, on their machine, and has no
    // upstream in any build. Marking it shipped would invite a later version to replace
    // their measurements with ours.
    shipped: false,
    enabled: true,
    groups: [],
    triggers: candidates.map((c, i) => buffTrigger(c, { id: `t${i + 1}`, panel })),
  });
}

// ------------------------------------------------------------------------ in-app

/**
 * Measure a whole log file, without stalling the app that is reading it.
 *
 * The offline script reads the file in one synchronous gulp, which is right for a script
 * and wrong inside the overlay: the same read mid-raid would freeze the tailer for the
 * seconds it takes and lose lines. So this goes through `readLogTail`, which chunks and
 * yields, and is the reason the Triggers window can offer this as a button at all.
 *
 * @param {string} logPath
 * @param {{maxBytes?: number, minObs?: number, onProgress?: Function}} [opts]
 */
export async function mineBuffsLog(logPath, opts = {}) {
  const tail = await readLogTail(logPath, opts);
  const miner = new BuffMiner(opts);
  let lines = 0;
  for (const line of tail.lines) {
    const parsed = parseTimestamp(line);
    if (!parsed) continue;
    lines++;
    miner.observe(parsed.body, parsed.ts);
  }
  return {
    candidates: miner.candidates(opts),
    lines,
    bytes: tail.bytes,
    total: tail.total,
    truncated: tail.truncated,
  };
}
