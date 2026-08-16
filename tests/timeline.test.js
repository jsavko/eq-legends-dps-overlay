import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ratePerSec, sumSeries, smooth, niceMax, axisTicks, timeTicks, polylinePoints,
} from '../src/renderer/history/timeline.js';

test('ratePerSec divides bucket totals by the bucket width in seconds', () => {
  assert.deepEqual(ratePerSec([100, 0, 50], 1000), [100, 0, 50]);
  // A coarsened fight's 2s buckets hold twice the damage; the RATE must not double.
  assert.deepEqual(ratePerSec([100, 0, 50], 2000), [50, 0, 25]);
});

test('sumSeries adds element-wise and treats a shorter series\' tail as zeros', () => {
  assert.deepEqual(sumSeries([[1, 2, 3], [10, 20]]), [11, 22, 3]);
  assert.deepEqual(sumSeries([]), []);
});

test('smooth is a centered mean that shrinks at the edges instead of zero-padding', () => {
  // A constant series must come back exactly constant — zero-padding at the edges
  // would bend the opening seconds toward the floor.
  assert.deepEqual(smooth([5, 5, 5, 5, 5], 2), [5, 5, 5, 5, 5]);
  // An impulse spreads symmetrically.
  assert.deepEqual(smooth([0, 0, 9, 0, 0], 1), [0, 3, 3, 3, 0]);
  // Radius 0 is the identity, as a fresh array.
  const raw = [1, 2, 3];
  const out = smooth(raw, 0);
  assert.deepEqual(out, raw);
  assert.notEqual(out, raw);
});

test('niceMax lands on 1/2/5 x 10^k at or above the value, and 1 for nothing', () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(NaN), 1);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(12), 20);
  assert.equal(niceMax(20), 20);
  assert.equal(niceMax(26), 50);
  assert.equal(niceMax(430), 500);
  assert.equal(niceMax(5001), 10000);
});

test('axisTicks spans 0..max evenly, inclusive of both ends', () => {
  assert.deepEqual(axisTicks(100, 4), [0, 25, 50, 75, 100]);
  assert.deepEqual(axisTicks(1, 1), [0, 1]);
});

test('timeTicks picks the smallest ladder step that fits and never overshoots the fight', () => {
  const short = timeTicks(42_000, 6);       // 42s -> 10s steps: 5 ticks
  assert.equal(short.stepMs, 10_000);
  assert.deepEqual(short.ticks, [0, 10_000, 20_000, 30_000, 40_000]);

  const long = timeTicks(9 * 60_000, 6);    // 9min -> 2min steps
  assert.equal(long.stepMs, 120_000);
  assert.equal(long.ticks.at(-1) <= 9 * 60_000, true);
  assert.equal(long.ticks[0], 0);
});

test('polylinePoints centers each bucket and flips y for screen coordinates', () => {
  const pts = polylinePoints([0, 50, 100], { width: 300, height: 100, max: 100 });
  assert.deepEqual(pts, [
    { x: 50, y: 100 },
    { x: 150, y: 50 },
    { x: 250, y: 0 },
  ]);
});

test('polylinePoints draws a single-bucket fight as a flat visible segment', () => {
  const pts = polylinePoints([80], { width: 200, height: 100, max: 100 });
  assert.deepEqual(pts, [{ x: 0, y: 20 }, { x: 200, y: 20 }]);
});

test('polylinePoints survives an all-zero series and a zero max', () => {
  const pts = polylinePoints([0, 0], { width: 100, height: 50, max: 0 });
  assert.equal(pts.length, 2);
  for (const p of pts) assert.equal(p.y, 50);   // flat on the baseline, no NaN
});
