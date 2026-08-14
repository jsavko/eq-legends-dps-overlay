import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classGroups, doneTotals, questByRef, firstQuestRef, splitLine, statsText, importStamp,
} from '../src/renderer/quests/organize.js';
import { QuestProgress } from '../src/quests/progress.js';

/**
 * Organize is fed the REAL store's snapshot rather than a hand-built literal, so the
 * two halves cannot drift: a field the store renames fails here, not on screen.
 */
function realSnapshot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quests-org-'));
  const store = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  store.feed({ kind: 'loot', item: 'Wind Rune Azia', disposition: 'stored', qty: 2, ts: 1000 });
  store.feed({ kind: 'loot', item: 'Wind Rune Azia', disposition: 'kept', qty: 1, ts: 2000 });
  store.feed({ kind: 'loot', item: 'Crude Wooden Flute', disposition: 'kept', qty: 1, ts: 3000 });
  store.setOwned('bard:0:0', true);
  store.setDone('bard:1', true);
  return store.snapshot();
}

test('classGroups keeps dataset order and counts claims, not loot', () => {
  const groups = classGroups(realSnapshot());
  assert.equal(groups.length, 16);
  assert.equal(groups[0].id, 'bard', 'dataset order, never re-sorted');

  const bard = groups[0];
  assert.equal(bard.doneCount, 1);
  assert.equal(bard.total, 6);
  // Quest 0 has the flute OWNED (a claim); the rune is looted but unclaimed, so 1/2 —
  // looted counts never leak into the fraction.
  assert.equal(bard.quests[0].ownedCount, 1);
  assert.equal(bard.quests[0].itemCount, 2);
  assert.equal(bard.quests[1].done, true);
});

test('doneTotals spans all ninety-five', () => {
  assert.deepEqual(doneTotals(realSnapshot()), { done: 1, total: 95 });
});

test('questByRef finds a quest with its class, and misses honestly', () => {
  const snap = realSnapshot();
  const found = questByRef(snap, 'bard:1');
  assert.equal(found.cls.id, 'bard');
  assert.equal(found.quest.done, true);
  assert.equal(questByRef(snap, 'bard:99'), null);
  assert.equal(firstQuestRef(snap), 'bard:0');
});

test('splitLine explains a rune always and a plain item only when split', () => {
  assert.equal(splitLine({ stored: 8, kept: 1 }, true), '1 in bags · 8 in currency');
  assert.equal(splitLine({ stored: 8 }, true), '8 in currency');
  // A single-disposition non-rune count needs no footnote.
  assert.equal(splitLine({ kept: 3 }, false), null);
  assert.equal(splitLine({ kept: 2, created: 1 }, false), '2 in bags · 1 upgraded');
  assert.equal(splitLine({}, false), null);
  assert.equal(splitLine(undefined, true), null);
});

test('statsText condenses the wiki blank lines and survives absence', () => {
  assert.equal(statsText('A\n\nB\n\n\nC'), 'A\nB\nC');
  assert.equal(statsText(null), '');
});

test('importStamp is a dated claim or nothing at all', () => {
  assert.match(importStamp({ exportedAt: '2026-08-14T14:21:50.107Z' }), /eqlposky export of Aug 1[34]/);
  assert.equal(importStamp(null), null);
  assert.equal(importStamp({ exportedAt: 'not a date' }), null);
});
