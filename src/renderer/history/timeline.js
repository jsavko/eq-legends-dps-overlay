/**
 * Pure graph math for the fight timeline: bucket series in, drawable geometry out.
 *
 * No DOM, no canvas handle, no Electron — this is the half of the graph that runs
 * under `node --test` in WSL, on the same split breakdown.js and organize.js use. The
 * canvas code in the history window (and the mobile page, which imports this module
 * unchanged) only ever strokes what these functions hand it.
 *
 * The input shape is what `Encounter#snapshot({ timeline: true })` emits: a dense
 * array of per-bucket totals plus `{ bucketMs, originTs, buckets }` geometry. Records
 * written before the feature simply lack it; deciding what to say then is the
 * renderer's job, not this module's.
 */

/**
 * Per-bucket totals -> a per-SECOND rate series. A graph labelled "DPS" must not
 * change value just because a long fight coarsened to 2s buckets — the bucket total
 * doubles there, the rate does not.
 */
export function ratePerSec(series, bucketMs) {
  const sec = Math.max(1, bucketMs) / 1000;
  return series.map((v) => (Number.isFinite(v) ? v / sec : 0));
}

/**
 * Element-wise sum of several series — the group curve. Lengths may differ (a record
 * hand-edited or a stream mid-extension); the result is as long as the longest and
 * treats the missing tail of a shorter one as the zeros it means.
 */
export function sumSeries(seriesList) {
  const length = seriesList.reduce((m, s) => Math.max(m, s.length), 0);
  const out = new Array(length).fill(0);
  for (const s of seriesList) {
    for (let i = 0; i < s.length; i++) out[i] += s[i] ?? 0;
  }
  return out;
}

/**
 * Centered box smoothing: each point becomes the mean of itself and up to `radius`
 * neighbors each side. At the edges the window SHRINKS to what exists rather than
 * padding with imaginary zeros — zero-padding would bend the opening seconds of every
 * curve toward the floor, claiming a slow start that never happened.
 *
 * Smoothing is presentation, not data: the raw buckets stay in the record, and this
 * runs at draw time only. A radius of 0 returns the series untouched.
 */
export function smooth(series, radius = 2) {
  if (radius <= 0 || series.length <= 1) return [...series];
  return series.map((_, i) => {
    const from = Math.max(0, i - radius);
    const to = Math.min(series.length - 1, i + radius);
    let sum = 0;
    for (let j = from; j <= to; j++) sum += series[j];
    return sum / (to - from + 1);
  });
}

/**
 * The smallest "nice" axis ceiling at or above `value`: 1, 2 or 5 times a power of
 * ten. Zero or garbage gets 1, so an all-zero series still draws against a real axis
 * instead of dividing by nothing.
 */
export function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 2, 5, 10]) {
    if (step * power >= value) return step * power;
  }
  return 10 * power;   // unreachable, but a wrong axis beats a thrown draw
}

/** Evenly spaced tick values from 0 to `max` inclusive. */
export function axisTicks(max, divisions = 4) {
  const n = Math.max(1, Math.floor(divisions));
  return Array.from({ length: n + 1 }, (_, i) => (max * i) / n);
}

/** The x-axis tick ladder, in seconds — the intervals a fight clock reads well in. */
const TIME_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/**
 * Tick positions for the time axis: offsets in ms from the fight's start, at the
 * smallest ladder interval that keeps the count at or under `maxTicks`. Always
 * includes 0; never includes a tick past the duration.
 */
export function timeTicks(durationMs, maxTicks = 6) {
  const durationSec = Math.max(1, durationMs / 1000);
  let step = TIME_STEPS[TIME_STEPS.length - 1];
  for (const s of TIME_STEPS) {
    if (durationSec / s <= maxTicks) { step = s; break; }
  }
  const out = [];
  for (let t = 0; t <= durationMs; t += step * 1000) out.push(t);
  return { stepMs: step * 1000, ticks: out };
}

/**
 * A series as drawable points inside a width x height box, y growing downward the
 * way canvas and SVG both count. Bucket i sits at the horizontal CENTER of its
 * bucket's span, so a curve and the time axis under it agree about when a spike
 * happened. A single-bucket fight comes back as a flat two-point segment — one point
 * strokes nothing, and "all of it in one second" deserves a visible line.
 *
 * @param {number[]} series  per-bucket values (already rated/smoothed as the caller wants)
 * @param {{width: number, height: number, max: number}} box
 * @returns {Array<{x: number, y: number}>}
 */
export function polylinePoints(series, { width, height, max }) {
  const top = Math.max(1e-9, max);
  const y = (v) => height - (Math.min(v, top) / top) * height;
  if (series.length === 0) return [];
  if (series.length === 1) {
    return [{ x: 0, y: y(series[0]) }, { x: width, y: y(series[0]) }];
  }
  const span = width / series.length;
  return series.map((v, i) => ({ x: span * (i + 0.5), y: y(v) }));
}
