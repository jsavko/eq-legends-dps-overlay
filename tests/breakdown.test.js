import test from 'node:test';
import assert from 'node:assert/strict';

import { abilityColumns } from '../src/renderer/overlay/breakdown.js';

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
