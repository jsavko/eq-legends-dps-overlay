import test from 'node:test';
import assert from 'node:assert/strict';

import { abilityAccuracy, abilityColumns, splitShares } from '../src/renderer/overlay/breakdown.js';

// The real case that motivated this: Rhale's 19-ability row from the live log.
// One 24px row-height column is 456px tall.

test('one column when the list fits', () => {
  assert.equal(abilityColumns({ count: 19, rowHeight: 24, available: 456 }), 1);
  assert.equal(abilityColumns({ count: 6, rowHeight: 24, available: 200 }), 1);
});

test('two columns when one does not fit', () => {
  // 456 > 300, but ceil(19/2) = 10 rows -> 240 <= 300.
  assert.equal(abilityColumns({ count: 19, rowHeight: 24, available: 300 }), 2);
});

test('three columns at the extreme', () => {
  // Two columns is 240 > 170; ceil(19/3) = 7 rows -> 168 <= 170.
  assert.equal(abilityColumns({ count: 19, rowHeight: 24, available: 170 }), 3);
});

test('maxColumns is a ceiling even when nothing fits', () => {
  // Every ability still gets rendered — the layout just cannot get any shorter.
  assert.equal(abilityColumns({ count: 19, rowHeight: 24, available: 50 }), 3);
  assert.equal(abilityColumns({ count: 19, rowHeight: 24, available: 50, maxColumns: 2 }), 2);
});

test('the boundary row exactly fills the available space', () => {
  // 10 rows * 24 = 240 exactly: fits, no third column.
  assert.equal(abilityColumns({ count: 19, rowHeight: 24, available: 240 }), 2);
  // One pixel less and it spills over.
  assert.equal(abilityColumns({ count: 19, rowHeight: 24, available: 239 }), 3);
});

test('one ability is one column', () => {
  assert.equal(abilityColumns({ count: 1, rowHeight: 24, available: 10 }), 1);
});

test('zero or nonsense input degrades to one column', () => {
  assert.equal(abilityColumns({ count: 0, rowHeight: 24, available: 100 }), 1);
  assert.equal(abilityColumns({ count: 5, rowHeight: 0, available: 100 }), 1);
  assert.equal(abilityColumns({ count: NaN, rowHeight: 24, available: 100 }), 1);
});

test('splitShares divides a normal split and sums to 100', () => {
  assert.deepEqual(splitShares(143022, 61552), { playerPct: 70, petPct: 30 });
});

test('splitShares rounds as complements so the pair always sums to 100', () => {
  // 2/3 vs 1/3 rounds independently to 67 + 33 — fine — but 1/6 vs 5/6 style
  // splits are where independent rounding drifts. Pin a case per direction.
  assert.deepEqual(splitShares(2, 1), { playerPct: 67, petPct: 33 });
  assert.deepEqual(splitShares(1, 2), { playerPct: 33, petPct: 67 });
  assert.deepEqual(splitShares(1005, 995), { playerPct: 50, petPct: 50 });
  const { playerPct, petPct } = splitShares(999, 2);
  assert.equal(playerPct + petPct, 100);
});

test('splitShares is null when there is nothing to split', () => {
  // A taken-view row can render with zero taken, shown only for a death.
  assert.equal(splitShares(0, 0), null);
  assert.equal(splitShares(NaN, 5), null);
});

test('splitShares gives a petless player 100/0, and a pet-only total 0/100', () => {
  assert.deepEqual(splitShares(5000, 0), { playerPct: 100, petPct: 0 });
  assert.deepEqual(splitShares(0, 5000), { playerPct: 0, petPct: 100 });
});

test('abilityAccuracy divides hits by swings', () => {
  // The screenshot that started this: "Slash 2/3" is two of three swings.
  assert.equal(abilityAccuracy(2, 1), 2 / 3);
  assert.equal(abilityAccuracy(1, 1), 0.5);
});

test('abilityAccuracy is 1 for an ability that never missed', () => {
  // Every spell and DoT tick lands here — they cannot miss, so the column reads 100%
  // for a caster's whole list. Uniform, but true.
  assert.equal(abilityAccuracy(4, 0), 1);
});

test('abilityAccuracy is a real zero when everything missed, never null', () => {
  // The one row most worth reading in the list, and the reason this cannot reuse the
  // share formatters — they dash out anything <= 0.
  assert.equal(abilityAccuracy(0, 2), 0);
});

test('abilityAccuracy is null when there were no swings at all', () => {
  // Heals, DoT ticks and taken-view rows carry no swing count; a fabricated 0% there
  // would read as "this always whiffs".
  assert.equal(abilityAccuracy(0, 0), null);
});

test('abilityAccuracy is null on nonsense or missing input', () => {
  // Records written before per-ability misses existed arrive with `undefined`.
  assert.equal(abilityAccuracy(3, undefined), null);
  assert.equal(abilityAccuracy(undefined, 1), null);
  assert.equal(abilityAccuracy(NaN, 2), null);
  assert.equal(abilityAccuracy(2, -1), null);
});
