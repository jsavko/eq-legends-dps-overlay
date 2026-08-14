import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  POSKY, questItemKey, isRune, lookup, itemRef, questRef, allItemKeys,
} from '../src/quests/index.js';
import { QuestProgress, questStoreKey, QUEST_STORE_VERSION } from '../src/quests/progress.js';

/** The real eqlposky.com progress export this feature was built against. */
const EXPORT_FIXTURE = JSON.parse(
  fs.readFileSync(new URL('./fixtures/posky-progress.json', import.meta.url), 'utf8'),
);

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quests-'));

// ------------------------------------------------------------------------- the dataset

test('the dataset holds the full sixteen classes and ninety-five quests', () => {
  assert.equal(POSKY.classes.length, 16);
  const quests = POSKY.classes.reduce((n, c) => n + c.quests.length, 0);
  assert.equal(quests, 95);
  for (const cls of POSKY.classes) {
    assert.ok(cls.id && cls.name && cls.npc, cls.id);
    for (const quest of cls.quests) {
      assert.ok(quest.reward, `${cls.id}: quest with no reward`);
      assert.ok(quest.items.length >= 1, `${cls.id}: ${quest.reward} has no items`);
    }
  }
});

test('the dataset says where it came from', () => {
  assert.match(POSKY.attribution.source, /eqlposky\.com/);
  assert.match(POSKY.attribution.upstream, /eqprogression\.com/);
  assert.ok(POSKY.attribution.fetched);
});

test('every quest names exactly one rune, and every rune is a real Wind Rune', () => {
  // The site's model, confirmed against the live log: each class test wants one
  // specific rune alongside its island drops. A transform that dropped or doubled a
  // rune row would break the import's positional refs silently.
  for (const cls of POSKY.classes) {
    for (const [qi, quest] of cls.quests.entries()) {
      const runes = quest.items.filter((i) => isRune(i.name));
      assert.equal(runes.length, 1, `${cls.id} quest ${qi} has ${runes.length} runes`);
      assert.match(runes[0].source, /zone-wide/i);
    }
  }
});

// --------------------------------------------------------------------- normalization

test('questItemKey folds the three spellings the log can wrap around one item', () => {
  const base = questItemKey('Light Woolen Mantle');
  assert.equal(questItemKey('a Light Woolen Mantle'), base);      // looted with article
  assert.equal(questItemKey('Light Woolen Mantle +2'), base);     // Legends upgrade suffix
  assert.equal(questItemKey('LIGHT WOOLEN MANTLE'), base);        // export files lowercase
  // The suffix strip is anchored: a name that legitimately ends in a number keeps it.
  assert.notEqual(questItemKey('Torn Page of Magi`kot pg. 4'), questItemKey('Torn Page of Magi`kot'));
});

test('lookup answers through the same normalization the index was built with', () => {
  assert.deepEqual(lookup('a Crude Wooden Flute').map((r) => r.ref), ['bard:0:0']);
  assert.equal(lookup('Light Woolen Mantle +2').length, 1);
  assert.equal(lookup('Rusty Short Sword').length, 0);
});

test('one rune serves many classes and lookup names every one of them', () => {
  const refs = lookup('Wind Rune Izah').map((r) => r.ref);
  assert.equal(refs.length, 7);
  assert.ok(refs.includes('beastlord:4:3'));
  assert.ok(refs.includes('wizard:5:2'));
  for (const slot of lookup('Wind Rune Izah')) assert.equal(slot.rune, true);
});

test('all fifteen Wind Runes are in the index', () => {
  const runes = allItemKeys().filter((k) => /^wind rune /.test(k));
  assert.equal(runes.length, 15);
});

test('ref helpers follow the site export convention exactly', () => {
  assert.equal(itemRef('bard', 0, 1), 'bard:0:1');
  assert.equal(questRef('shadowknight', 6), 'shadowknight:6');
  assert.equal(questStoreKey('Rhale', 'oggok'), 'Rhale_oggok');
});

// ------------------------------------------------------------------------ accumulation

const loot = (item, extra = {}) => ({
  kind: 'loot', item, disposition: 'kept', qty: 1, ts: 1000, ...extra,
});

test('quest loot accumulates per disposition and both count toward the total', () => {
  const store = new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });

  assert.equal(store.feed(loot('Wind Rune Azia', { ts: 1000 }))?.refs.length, 7);
  assert.ok(store.feed(loot('a Wind Rune Azia', { disposition: 'stored', container: 'currency', ts: 2000 })));
  assert.ok(store.feed(loot('Wind Rune Azia', { disposition: 'stored', qty: 2, ts: 3000 })));

  assert.equal(store.lootedCount('Wind Rune Azia'), 4);
  assert.deepEqual(store.lootedSplit('wind rune azia'), { kept: 1, stored: 3 });
});

test('loot no quest wants is dropped without touching the file', () => {
  const dir = tempDir();
  const store = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  assert.equal(store.feed(loot('Rusty Short Sword')), null);
  assert.equal(fs.existsSync(path.join(dir, 'Rhale_oggok.json')), false);
});

test('the ledger survives a restart and the floor stops re-reads double-counting', () => {
  const dir = tempDir();
  const first = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  first.feed(loot('Crude Wooden Flute', { ts: 5000 }));
  assert.equal(first.lootedCount('Crude Wooden Flute'), 1);

  // A fresh instance — the overlay relaunching, or the backfill script re-run — reads
  // the same file and refuses everything at or before the recorded high-water mark,
  // exactly as the session tracker does for the tailer's 64 KB seek-back.
  const second = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  assert.equal(second.lootedCount('Crude Wooden Flute'), 1);
  assert.equal(second.feed(loot('Crude Wooden Flute', { ts: 5000 })), null);
  assert.equal(second.feed(loot('Crude Wooden Flute', { ts: 4000 })), null);
  assert.equal(second.lootedCount('Crude Wooden Flute'), 1);

  // A genuinely new loot still counts.
  assert.ok(second.feed(loot('Crude Wooden Flute', { ts: 6000 })));
  assert.equal(second.lootedCount('Crude Wooden Flute'), 2);
});

test('characters keep separate ledgers and switching between them loses nothing', () => {
  const dir = tempDir();
  const store = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  store.feed(loot('Crude Wooden Flute'));
  store.setCharacter('Emalina', 'oggok');
  assert.equal(store.lootedCount('Crude Wooden Flute'), 0);
  store.setCharacter('Rhale', 'oggok');
  assert.equal(store.lootedCount('Crude Wooden Flute'), 1);
});

test('a write failure reports through the callback instead of throwing', () => {
  // A file where the store expects its directory makes every mkdir/write fail.
  const blocked = path.join(tempDir(), 'not-a-dir');
  fs.writeFileSync(blocked, 'x');
  const errors = [];
  const store = new QuestProgress({
    dir: blocked, character: 'Rhale', server: 'oggok',
    onWriteError: (e) => errors.push(e),
  });
  assert.ok(store.feed(loot('Crude Wooden Flute')), 'the count must still land in memory');
  assert.equal(store.lootedCount('Crude Wooden Flute'), 1);
  assert.equal(errors.length, 1);
});

// ------------------------------------------------------------------- owned / done flags

test('manual toggles go both ways and round-trip through the file', () => {
  const dir = tempDir();
  const store = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  store.setOwned('bard:0:0', true);
  store.setDone('bard:0', true);

  const reread = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  const bard = reread.snapshot().classes.find((c) => c.id === 'bard');
  assert.equal(bard.quests[0].items[0].owned, true);
  assert.equal(bard.quests[0].done, true);

  // The player may take a claim back — that right belongs to toggles alone.
  reread.setOwned('bard:0:0', false);
  reread.setDone('bard:0', false);
  const again = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' }).snapshot();
  const bard2 = again.classes.find((c) => c.id === 'bard');
  assert.equal(bard2.quests[0].items[0].owned, false);
  assert.equal(bard2.quests[0].done, false);
});

// -------------------------------------------------------------------------- the import

test('the real export applies: turnedIn to done, looted and currency to owned', () => {
  const store = new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });
  const result = store.applyImport(EXPORT_FIXTURE);
  assert.equal(result.ok, true);
  assert.ok(result.applied.done >= 49, `expected the fixture's 49 turn-ins, got ${result.applied.done}`);
  assert.ok(result.applied.owned > 100);

  const snap = store.snapshot();
  const bard = snap.classes.find((c) => c.id === 'bard');
  assert.equal(bard.quests[0].done, true, 'bard:0 is turned in, in the fixture');
  assert.equal(bard.quests[0].items[0].owned, true, 'bard:0:0 is looted in the fixture');
  // The snapshot names the export's date — an import is a dated claim, and the window
  // says so rather than presenting it as current truth.
  assert.equal(snap.import.exportedAt, EXPORT_FIXTURE.exportedAt);
});

test('a false in the export is "no checkmark", never "clear mine"', () => {
  const store = new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });
  // The fixture genuinely carries "berserker:1:1": false.
  assert.equal(EXPORT_FIXTURE.looted['berserker:1:1'], false);
  store.setOwned('berserker:1:1', true);
  store.applyImport(EXPORT_FIXTURE);
  const bers = store.snapshot().classes.find((c) => c.id === 'berserker');
  assert.equal(bers.quests[1].items[1].owned, true, 'the import must not clear a manual claim');
});

test('re-importing the same export is idempotent', () => {
  const store = new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });
  store.applyImport(EXPORT_FIXTURE);
  const second = store.applyImport(EXPORT_FIXTURE);
  assert.deepEqual(second.applied, { owned: 0, done: 0 });
});

test('currencyOwned reaches every quest slot that wants the rune', () => {
  const store = new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });
  store.applyImport({ version: 1, currencyOwned: { 'wind rune izah': true } });
  for (const slot of lookup('Wind Rune Izah')) {
    const cls = store.snapshot().classes.find((c) => c.id === slot.classId);
    assert.equal(cls.quests[slot.questIndex].items[slot.itemIndex].owned, true, slot.ref);
  }
});

test('an unrecognizable file is refused with a reason, not half-applied', () => {
  const store = new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });
  assert.equal(store.applyImport(null).ok, false);
  assert.equal(store.applyImport({ version: 2, looted: {} }).ok, false);
  assert.equal(store.applyImport('[]').ok, false);
});

// ------------------------------------------------------------------ the needed filter

test('needed() drops slots whose quest is done or whose item is owned', () => {
  const store = new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });
  const refs = lookup('Wind Rune Izah');
  assert.equal(store.needed(refs).length, 7, 'a fresh ledger needs everything');

  // Turning a quest in silences its slot; owning the item silences another's.
  store.setDone('wizard:5', true);
  store.setOwned('beastlord:4:3', true);
  const still = store.needed(refs);
  assert.equal(still.length, 5);
  assert.ok(!still.some((s) => s.classId === 'wizard' && s.questIndex === 5));
  assert.ok(!still.some((s) => s.ref === 'beastlord:4:3'));

  // The loot chip's whole point: after everything is checked off, silence.
  for (const slot of refs) store.setOwned(slot.ref, true);
  assert.equal(store.needed(refs).length, 0);
});

// --------------------------------------------------------------------------- snapshot

test('the snapshot joins data names with counts, flags and the rune marker', () => {
  const store = new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });
  store.feed(loot('Wind Rune Azia', { disposition: 'stored' }));
  const bard = store.snapshot().classes.find((c) => c.id === 'bard');
  const rune = bard.quests[0].items[1];
  assert.equal(rune.name, 'Wind Rune Azia');
  assert.equal(rune.rune, true);
  assert.equal(rune.looted, 1);
  assert.deepEqual(rune.split, { stored: 1 });
  assert.equal(bard.quests[0].items[0].rune, false);
  assert.match(bard.quests[0].rewardStats ?? '', /\S/, 'reward stats text rides along');
});

// ---------------------------------------------------------------- offers (turn-ins)

const offer = (item, npc, extra = {}) => ({ kind: 'offer', item, npc, qty: 1, ts: 1000, ...extra });

const snapItem = (store, classId, qi, ii) =>
  store.snapshot().classes.find((c) => c.id === classId).quests[qi].items[ii];
const snapQuest = (store, classId, qi) =>
  store.snapshot().classes.find((c) => c.id === classId).quests[qi];

test('an offer to a quest NPC records the hand-in; vendors and players record nothing', () => {
  const store = new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });
  const counted = store.feed(offer('Crude Wooden Flute', 'Cilin Spellsinger'));
  assert.equal(counted?.refs[0].ref, 'bard:0:0');
  assert.deepEqual(counted.needed, [], 'handing an item IN is never loot-chip news');

  const item = snapItem(store, 'bard', 0, 0);
  assert.equal(item.offered, 1);
  assert.equal(item.lastOffered, 1000);

  // The vendor quantity dump, the trade to another player, and an item off the class's
  // list — the three shapes the NPC scoping exists to silence.
  assert.equal(store.feed(offer('Metal Bits', 'Crusader Iktra', { qty: 262, ts: 2000 })), null);
  assert.equal(store.feed(offer('Wind Rune Azia', 'Emalina', { ts: 3000 })), null);
  assert.equal(store.feed(offer('Rusty Short Sword', 'Cilin Spellsinger', { ts: 4000 })), null);
});

test('offers resolve through the same normalization loot does — upgrade suffix included', () => {
  const store = new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });
  const counted = store.feed(offer('Light Woolen Mantle +1', 'Cilin Spellsinger'));
  assert.equal(counted?.refs[0].ref, 'bard:1:0', 'the +1 is the upgrade system talking, not a different item');
});

test('a rune handed to one NPC credits that class alone', () => {
  const store = new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });
  const counted = store.feed(offer('Wind Rune Azia', 'Torgon Blademaster'));
  assert.equal(counted?.refs.length, 1, 'a looted Azia could be for seven classes; an offered one names its class');
  assert.equal(counted.refs[0].classId, 'warrior');
  assert.equal(snapItem(store, 'bard', 0, 1).offered, 0, "the bard's Azia slot heard nothing");
});

test('the floor stops offer re-reads exactly as it stops loot re-reads', () => {
  const dir = tempDir();
  const first = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  first.feed(offer('Crude Wooden Flute', 'Cilin Spellsinger', { ts: 5000 }));

  const second = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  assert.equal(second.feed(offer('Crude Wooden Flute', 'Cilin Spellsinger', { ts: 5000 })), null);
  assert.equal(snapItem(second, 'bard', 0, 0).offered, 1);
});

// ---------------------------------------------------------------- derived claims

test('a quest with every slot offered derives done, and the caption credits the log', () => {
  const store = new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });
  store.feed(offer('Crude Wooden Flute', 'Cilin Spellsinger', { ts: 1000 }));
  assert.equal(snapQuest(store, 'bard', 0).done, false, 'half the hand-ins is not a turn-in');

  store.feed(offer('Wind Rune Azia', 'Cilin Spellsinger', { ts: 2000 }));
  const quest = snapQuest(store, 'bard', 0);
  assert.equal(quest.done, true);
  assert.equal(quest.doneSource, 'log');
});

test('rune-in-currency arithmetic: stored loot derives owned, an offer takes it back', () => {
  const store = new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });
  store.feed(loot('Wind Rune Azia', { disposition: 'stored', ts: 1000 }));
  let azia = snapItem(store, 'bard', 0, 1);
  assert.equal(azia.owned, true, 'a rune sitting in currency is owned');
  assert.equal(azia.ownedSource, 'log');

  // The rune went to the warrior's NPC. Every class's slot loses the claim — there is
  // no longer a rune anywhere to be owned — and the warrior's slot records the hand-in.
  store.feed(offer('Wind Rune Azia', 'Torgon Blademaster', { ts: 2000 }));
  azia = snapItem(store, 'bard', 0, 1);
  assert.equal(azia.owned, false);
  assert.equal(azia.ownedSource, null);
  assert.equal(snapItem(store, 'warrior', 2, 1).offered, 1);
});

test('the loot chip is judged before the loot lands: the first pickup is news, the second is not', () => {
  const store = new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });
  const first = store.feed(loot('Crude Wooden Flute', { ts: 1000 }));
  assert.equal(first.needed.length, 1, 'the flute was needed at the moment it dropped');
  const second = store.feed(loot('Crude Wooden Flute', { ts: 2000 }));
  assert.equal(second.needed.length, 0, 'a second flute while one survives is not news');
});

test('a manual un-check survives a replay of the very lines that derived the claim', () => {
  const dir = tempDir();
  const store = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  store.feed(offer('Crude Wooden Flute', 'Cilin Spellsinger', { ts: 1000 }));
  store.feed(offer('Wind Rune Azia', 'Cilin Spellsinger', { ts: 2000 }));
  assert.equal(snapQuest(store, 'bard', 0).done, true);

  // The player says no — maybe the NPC refused and returned the items. That answer is
  // explicit, it outranks the facts, and neither a floor-eaten replay nor a genuinely
  // new hand-in line may flip it back.
  store.setDone('bard:0', false);
  let quest = snapQuest(store, 'bard', 0);
  assert.equal(quest.done, false);
  assert.equal(quest.doneSource, 'manual');

  // A restart replays the tail of the log — the floor eats the old lines, the false is
  // in the file rather than in memory, and even a genuinely NEW hand-in line cannot
  // flip the player's answer back.
  const reread = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  assert.equal(reread.feed(offer('Crude Wooden Flute', 'Cilin Spellsinger', { ts: 1000 })), null);
  reread.feed(offer('Crude Wooden Flute', 'Cilin Spellsinger', { ts: 3000 }));
  quest = snapQuest(reread, 'bard', 0);
  assert.equal(quest.done, false, 'derivation fills the unset; it never argues with the player');
  assert.equal(quest.doneSource, 'manual');
});

test('log evidence outranks an import claim, and the caption says which one answered', () => {
  const store = new QuestProgress({ dir: tempDir(), character: 'Rhale', server: 'oggok' });
  store.applyImport({ version: 1, looted: { 'bard:0:0': true } });
  assert.equal(snapItem(store, 'bard', 0, 0).ownedSource, 'import');

  store.feed(loot('Crude Wooden Flute', { ts: 1000 }));
  const item = snapItem(store, 'bard', 0, 0);
  assert.equal(item.owned, true);
  assert.equal(item.ownedSource, 'log', 'the live source answers ahead of the dated snapshot');
});

// ---------------------------------------------------------------- v1 migration

test('a v1 file loads: flags lift to tri-state, counts survive, the next write stamps v2', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'Rhale_oggok.json'), JSON.stringify({
    v: 1,
    character: 'Rhale',
    server: 'oggok',
    lastTs: 5000,
    items: { 'crude wooden flute': { kept: 1 } },
    owned: { 'bard:0:0': true },
    done: { 'bard:0': true },
    import: null,
  }));

  const store = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  assert.equal(store.lootedCount('Crude Wooden Flute'), 1);
  assert.equal(snapItem(store, 'bard', 0, 0).owned, true);
  assert.equal(snapQuest(store, 'bard', 0).done, true);
  // No import stamp in the file, so the only hand that could have set them is the player's.
  assert.equal(snapItem(store, 'bard', 0, 0).ownedSource, 'manual');

  // Migrated claims un-check like any other explicit claim, and the floor carried over.
  store.setDone('bard:0', false);
  assert.equal(snapQuest(store, 'bard', 0).done, false);
  assert.equal(store.feed(loot('Crude Wooden Flute', { ts: 4000 })), null, 'the v1 high-water mark still holds');

  store.feed(loot('Crude Wooden Flute', { ts: 6000 }));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'Rhale_oggok.json'), 'utf8'));
  assert.equal(raw.v, QUEST_STORE_VERSION);
  assert.deepEqual(raw.done['bard:0'], { value: false, source: 'manual' });
});

test('a v1 file that recorded an import lifts its flags as the import\'s', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'Rhale_oggok.json'), JSON.stringify({
    v: 1, character: 'Rhale', server: 'oggok', lastTs: null, items: {},
    owned: { 'bard:0:0': true }, done: {},
    import: { exportedAt: '2026-08-06T00:00:00Z', importedAt: '2026-08-14T00:00:00Z' },
  }));
  const store = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  assert.equal(snapItem(store, 'bard', 0, 0).ownedSource, 'import');
});

test('the store version is stamped on disk', () => {
  const dir = tempDir();
  const store = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  store.feed(loot('Crude Wooden Flute'));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'Rhale_oggok.json'), 'utf8'));
  assert.equal(raw.v, QUEST_STORE_VERSION);
});
