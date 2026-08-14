import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseInventory } from '../src/quests/inventory.js';
import { QuestProgress } from '../src/quests/progress.js';
import { questItemKey } from '../src/quests/index.js';

/** A real `/outputfile inventory` dump from the live character, 627 rows. */
const DUMP = fs.readFileSync(
  new URL('./fixtures/Rhale_oggok-Inventory.txt', import.meta.url), 'latin1',
);

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quests-inv-'));
const freshStore = () => new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });

const snapItem = (store, classId, qi, ii) =>
  store.snapshot().classes.find((c) => c.id === classId).quests[qi].items[ii];
const snapQuest = (store, classId, qi) =>
  store.snapshot().classes.find((c) => c.id === classId).quests[qi];

// ------------------------------------------------------------------------ the parser

test('the real dump parses: header and Empty rows skipped, names normalized, counts summed', () => {
  const items = parseInventory(DUMP);
  assert.equal(items.size, 161, 'the fixture holds 161 distinct item keys');
  assert.equal(items.has('empty'), false);
  assert.equal(items.has('location'), false);

  // Worn gear is in — the dump covers equipment, bags, bank, key ring, augments.
  assert.equal(items.get("tobrin's mystical eyepatch"), 1);
  // The ` +N` upgrade suffix folds onto the base name, same as the log's loot lines.
  assert.equal(items.get('ornament of the oracle'), 1);
  assert.equal(items.has('ornament of the oracle +2'), false);
  // The same name across several slots sums into one count.
  assert.equal(items.get('golem metal wand (exaltation)'), 3);
});

test('a half-written dump yields the rows it has instead of throwing', () => {
  const torn = 'Location\tName\tID\tCount\tSlots\nGeneral1\tCrude Wooden Flute\t123\t1\t0\nGeneral2\tWind';
  const items = parseInventory(torn);
  assert.equal(items.get('crude wooden flute'), 1);
  assert.equal(items.size, 1);
});

// -------------------------------------------------------------------- applying a dump

test('applyInventory keeps only the names the dataset knows, stamped with the dump date', () => {
  const store = freshStore();
  const result = store.applyInventory(parseInventory(DUMP), 1000);
  assert.equal(result.ok, true);
  // 36 turn-in items and 7 quest rewards, measured off the real dump — the rest of the
  // 161 keys are bank clutter the ledger has no question about.
  assert.equal(result.matched, 43);

  const flute = snapItem(store, 'monk', 0, 0);
  assert.equal(typeof flute.inventory, 'number');
});

test('re-applying the same dump is a no-op the watcher can lean on', () => {
  const store = freshStore();
  store.applyInventory(parseInventory(DUMP), 1000);
  const rev = store.revision;
  const again = store.applyInventory(parseInventory(DUMP), 1000);
  assert.equal(again.unchanged, true);
  assert.equal(store.revision, rev, 'an unchanged dump must not wake the window');
});

test('presence sets, absence never clears: a key missing from a newer dump keeps its entry', () => {
  const store = freshStore();
  store.applyInventory(new Map([['crude wooden flute', 1]]), 1000);
  assert.equal(snapItem(store, 'bard', 0, 0).inventory, 1);

  // The next dump does not contain the flute — traded? on the cursor? destroyed? — and
  // absence is too weak to un-say anything. The old entry stays, with its OLD date.
  store.applyInventory(new Map([['light woolen mantle', 1]]), 2000);
  const flute = snapItem(store, 'bard', 0, 0);
  assert.equal(flute.inventory, 1);
  assert.equal(flute.inventoryAsOf, 1000);
  assert.equal(snapItem(store, 'bard', 1, 0).inventoryAsOf, 2000);
});

// ------------------------------------------------------------------ what a dump proves

test('possessing a turn-in item derives owned, labelled as the inventory\'s answer', () => {
  const store = freshStore();
  store.applyInventory(new Map([['crude wooden flute', 1]]), 1000);
  const flute = snapItem(store, 'bard', 0, 0);
  assert.equal(flute.owned, true);
  assert.equal(flute.ownedSource, 'inventory');
});

test('possessing a NO DROP reward proves the turn-in — even one from before logging began', () => {
  const store = freshStore();
  // Ervaj's Flute of Flight is bard quest 0's reward, NO DROP in its own stats text:
  // it cannot be bought or traded, so holding one has exactly one explanation.
  store.applyInventory(new Map([[questItemKey("Ervaj's Flute of Flight"), 1]]), 1000);
  const quest = snapQuest(store, 'bard', 0);
  assert.equal(quest.done, true);
  assert.equal(quest.doneSource, 'inventory');
});

test('a tradeable reward in the bags proves nothing and derives nothing', () => {
  const store = freshStore();
  // The Sphinx Heart Amulet (necromancer quest 2) carries no NO DROP flag — it could
  // have been bought in the tunnel, so possession is not evidence of a turn-in.
  store.applyInventory(new Map([['sphinx heart amulet', 1]]), 1000);
  const quest = snapQuest(store, 'necromancer', 2);
  assert.equal(quest.done, false);
  assert.equal(quest.doneSource, null);
});

test('the real dump proves seven turn-ins and forty owned slots', () => {
  // The headline: one in-game /outputfile against a fresh ledger, before any log line.
  const store = freshStore();
  store.applyInventory(parseInventory(DUMP), 1000);
  const snap = store.snapshot();
  const doneByInventory = [];
  const ownedByInventory = [];
  for (const cls of snap.classes) {
    for (const quest of cls.quests) {
      if (quest.doneSource === 'inventory') doneByInventory.push(quest.reward);
      for (const item of quest.items) if (item.ownedSource === 'inventory') ownedByInventory.push(item.ref);
    }
  }
  assert.equal(doneByInventory.length, 7);
  assert.ok(doneByInventory.includes("Ton Po's Shoulder Wraps"));
  assert.equal(ownedByInventory.length, 40);
});

// -------------------------------------------------------------------- the precedence

test('the full owned precedence: manual beats inventory beats log beats import', () => {
  const store = freshStore();
  const loot = { kind: 'loot', item: 'Crude Wooden Flute', disposition: 'kept', qty: 1, ts: 1000 };

  store.applyImport({ version: 1, looted: { 'bard:0:0': true } });
  assert.equal(snapItem(store, 'bard', 0, 0).ownedSource, 'import');

  store.feed(loot);
  assert.equal(snapItem(store, 'bard', 0, 0).ownedSource, 'log');

  store.applyInventory(new Map([['crude wooden flute', 1]]), 2000);
  assert.equal(snapItem(store, 'bard', 0, 0).ownedSource, 'inventory');

  store.setOwned('bard:0:0', false);
  const item = snapItem(store, 'bard', 0, 0);
  assert.equal(item.owned, false, 'the player\'s no outranks every yes the evidence can offer');
  assert.equal(item.ownedSource, 'manual');
});

test('the done precedence: manual beats both derivations beats import', () => {
  const store = freshStore();
  store.applyImport({ version: 1, turnedIn: { 'bard:0': true } });
  assert.equal(snapQuest(store, 'bard', 0).doneSource, 'import');

  store.applyInventory(new Map([[questItemKey("Ervaj's Flute of Flight"), 1]]), 1000);
  assert.equal(snapQuest(store, 'bard', 0).doneSource, 'inventory');

  store.setDone('bard:0', false);
  assert.equal(snapQuest(store, 'bard', 0).done, false);
});
