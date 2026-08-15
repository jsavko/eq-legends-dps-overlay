import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classGroups, doneTotals, questByRef, firstQuestRef, splitLine, importStamp,
  shortDate, doneCaption, ownedTitle,
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

test('classGroups keeps dataset order and counts effective claims', () => {
  const groups = classGroups(realSnapshot());
  assert.equal(groups.length, 16);
  assert.equal(groups[0].id, 'bard', 'dataset order, never re-sorted');

  const bard = groups[0];
  assert.equal(bard.doneCount, 1);
  assert.equal(bard.total, 6);
  // Quest 0 stands 2/2: the flute is the player's own claim, and the rune's surviving
  // loot DERIVES owned now — the store decides, the rail just counts the answers.
  assert.equal(bard.quests[0].ownedCount, 2);
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

test('a hand-in renders in the split always — even as the only line there is', () => {
  assert.equal(splitLine({ kept: 2 }, false, 1), '2 in bags · 1 handed in');
  // A turn-in from before any loot was logged: the offer is the whole story.
  assert.equal(splitLine({}, false, 1), '1 handed in');
  assert.equal(splitLine({ stored: 3 }, true, 2), '3 in currency · 2 handed in');
});

test('doneCaption names the source that decided the checkmark, in every state', () => {
  const items = [{ lastOffered: Date.UTC(2026, 7, 6, 12) }, { lastOffered: Date.UTC(2026, 7, 12, 12) }];
  assert.match(doneCaption({ done: true, doneSource: 'log', items }), /handed in per the log · Aug 12/);
  assert.match(doneCaption({ done: true, doneSource: 'inventory', items: [] }), /inventory dump/);
  assert.match(doneCaption({ done: true, doneSource: 'import', items: [] }), /eqlposky import/);
  assert.equal(doneCaption({ done: true, doneSource: 'manual', items: [] }), 'your claim');
  // The unset state explains how the box will check itself; the manual false says
  // the player's answer stands whatever the evidence does.
  assert.match(doneCaption({ done: false, doneSource: null, items: [] }), /checks itself/);
  assert.match(doneCaption({ done: false, doneSource: 'manual', items: [] }), /your call/);
});

test('ownedTitle carries the source and the dump date', () => {
  assert.match(ownedTitle({ owned: true, ownedSource: 'log' }), /looted in the log/);
  assert.match(
    ownedTitle({ owned: true, ownedSource: 'inventory', inventoryAsOf: Date.UTC(2026, 7, 6, 12) }),
    /inventory dump of Aug 6/,
  );
  assert.match(ownedTitle({ owned: true, ownedSource: 'manual' }), /your claim/);
  assert.equal(ownedTitle({ owned: false, ownedSource: null }), 'Mark as owned');
  assert.match(ownedTitle({ owned: false, ownedSource: 'manual' }), /your call/);
});

test('shortDate survives garbage', () => {
  assert.equal(shortDate(null), null);
  assert.equal(shortDate(NaN), null);
  assert.match(shortDate(Date.UTC(2026, 7, 6, 12)), /Aug 6/);
});


test('importStamp is a dated claim or nothing at all', () => {
  assert.match(importStamp({ exportedAt: '2026-08-14T14:21:50.107Z' }), /eqlposky export of Aug 1[34]/);
  assert.equal(importStamp(null), null);
  assert.equal(importStamp({ exportedAt: 'not a date' }), null);
});

// --------------------------------------------------------------- the reward card parser

import { parseRewardStats, parseSources, railFilter, RAIL_FILTERS, effectName, effectMeta, ownedLabel } from '../src/renderer/quests/organize.js';

const POSKY = JSON.parse(fs.readFileSync(
  new URL('../src/quests/posky.json', import.meta.url), 'utf8',
));

test('property: every stat line of all 95 rewards lands in the model — the fallback set is empty', () => {
  // The parser's honesty contract is structural (fill an empty field, append to a
  // list, or drop verbatim to `other` — never overwrite, never eat), and this pins
  // the current corpus: all 825 lines parse into structure. A wiki refresh that
  // introduces a shape the parser has not met shows up here as `other` entries, which
  // is the correct failure — visible, verbatim, and rendered — not missing text.
  let cards = 0;
  const fallback = [];
  for (const cls of POSKY.classes) {
    for (const quest of cls.quests) {
      const items = parseRewardStats(quest.rewardStats);
      cards += items.length;
      for (const item of items) fallback.push(...item.other);
      // Whatever else happens, a card exists and something on it is renderable.
      assert.ok(items.length >= 1, quest.reward);
    }
  }
  assert.equal(cards, 96, '95 rewards, one of them a two-item pair');
  assert.deepEqual(fallback, []);
});

test('the bard flute parses into the full card shape', () => {
  const [card] = parseRewardStats(POSKY.classes[0].quests[0].rewardStats);
  assert.deepEqual(card.flags, ['MAGIC ITEM', 'LORE ITEM', 'NO DROP']);
  assert.equal(card.slot, 'PRIMARY');
  assert.deepEqual(card.instrument, { kind: 'Wind Instrument', value: 22 });
  assert.deepEqual(card.stats.map((s) => `${s.k}${s.v}`), ['STR+8', 'STA+10', 'CHA+10', 'INT+5']);
  assert.equal(card.wt, '0.1');
  assert.equal(card.size, 'TINY');
  assert.equal(card.classes, 'BRD');
  assert.equal(card.races, 'ALL');
});

test('the beastlord pair splits into two named cards on its heads', () => {
  const bst = POSKY.classes.find((c) => c.id === 'beastlord');
  const quest = bst.quests.find((q) => q.reward.includes('Windhowl'));
  const [windhowl, render] = parseRewardStats(quest.rewardStats);
  assert.equal(windhowl.name, 'Windhowl');
  assert.equal(windhowl.skill, 'Hand to Hand');
  assert.equal(windhowl.delay, 22);
  assert.equal(windhowl.dmg, 12);
  assert.match(windhowl.effects[0].text, /Herikol's Soothing/);
  assert.equal(render.name, 'Spirit Render');
  assert.equal(render.dmg, 10);
  assert.match(render.effects[0].text, /Sha's Lethargy/);
});

test('effect detail lines attach to the effect above them', () => {
  const [card] = parseRewardStats(
    'Click Effect: Vigor of Zehkes (Must Equip)\n\nCast Time: Instant\n\nRequired Level: 46\n\nCooldown: 120 seconds',
  );
  assert.equal(card.effects.length, 1);
  assert.deepEqual(card.effects[0].details,
    ['Cast Time: Instant', 'Required Level: 46', 'Cooldown: 120 seconds']);
  // The same shapes with no effect above them have nothing to attach to.
  const [orphan] = parseRewardStats('Cooldown: 120 seconds');
  assert.deepEqual(orphan.other, ['Cooldown: 120 seconds']);
  assert.equal(orphan.effects.length, 0);
});

test('unknown lines drop to the verbatim bucket; occupied fields are never overwritten', () => {
  const [card] = parseRewardStats('Slot: HEAD\n\nSlot: FACE\n\nSome shape nobody has met');
  assert.equal(card.slot, 'HEAD', 'first writer wins');
  assert.deepEqual(card.other, ['Slot: FACE', 'Some shape nobody has met'],
    'the loser and the stranger both survive verbatim');
});

test('odd corpus shapes parse: bare slot, mixed-case flags, Range, unlimited charges', () => {
  const [wrist] = parseRewardStats('No Trade\n\nWrist\n\nAC: 5 HP: +35 END: +10');
  assert.deepEqual(wrist.flags, ['NO TRADE']);
  assert.equal(wrist.slot, 'Wrist');
  assert.equal(wrist.ac, '5');
  assert.deepEqual(wrist.stats, [{ k: 'HP', v: '+35' }, { k: 'END', v: '+10' }]);

  const [bow] = parseRewardStats('WT: 4.0  Range: 200  Size: MEDIUM');
  assert.equal(bow.range, 200);
  assert.equal(bow.size, 'MEDIUM');

  const [charged] = parseRewardStats('Charges: Unlimited');
  assert.equal(charged.charges, 'Unlimited');
  const [nine] = parseRewardStats('Charges: 9');
  assert.equal(nine.charges, 9);

  const [saves] = parseRewardStats('SV FIRE: +7  SV DISEASE: +7  SV COLD: +7');
  assert.equal(saves.saves.length, 3);
  assert.deepEqual(saves.saves[0], { k: 'SV FIRE', v: '+7' });
});

// ----------------------------------------------------------------------- source chips

test('every dataset source yields at least one chip; the multi-mob strings split right', () => {
  for (const cls of POSKY.classes) {
    for (const quest of cls.quests) {
      for (const item of quest.items) {
        assert.ok(parseSources(item.source).length >= 1, item.source);
      }
    }
  }

  const chips = parseSources('Island 1.5: Noble Dojorn / Island 4: Overseer of Air / Island 8: the Hand of Veeshan');
  assert.deepEqual(chips.map((c) => c.island), ['1.5', '4', '8']);
  assert.equal(chips[0].mob, 'Noble Dojorn');
});

test('a segment without its own island continues the previous one', () => {
  const chips = parseSources('Island 5: spiroc mobs / The Spiroc Lord');
  assert.deepEqual(chips, [
    { island: '5', mob: 'spiroc mobs', zoneWide: false },
    { island: '5', mob: 'The Spiroc Lord', zoneWide: false },
  ]);
});

test('bare slashes are mob-name punctuation, not separators', () => {
  const chips = parseSources('Island 7: Sister of the Spire / drake/sphinx/spirit mobs');
  assert.equal(chips.length, 2);
  assert.equal(chips[1].mob, 'drake/sphinx/spirit mobs');
});

test('the rune form is one zone-wide chip and a stranger is one verbatim chip', () => {
  assert.deepEqual(parseSources('Random zone-wide drop'),
    [{ island: null, mob: 'Random zone-wide drop', zoneWide: true }]);
  assert.deepEqual(parseSources('Somewhere new'),
    [{ island: null, mob: 'Somewhere new', zoneWide: false }]);
  assert.deepEqual(parseSources(''), []);
});

// -------------------------------------------------------------------- the rail filter

test('railFilter narrows quests but never drops a class header', () => {
  const groups = classGroups(realSnapshot());
  assert.equal(RAIL_FILTERS[0], 'all');
  assert.equal(railFilter(groups, 'all'), groups, 'all is the identity');

  const progress = railFilter(groups, 'progress');
  assert.equal(progress.length, 16, 'every class header survives every filter');
  const bard = progress[0];
  assert.equal(bard.quests.some((q) => q.done), false);
  assert.equal(bard.doneCount, 1, 'counts stay the class totals, not the view');

  const done = railFilter(groups, 'done');
  assert.equal(done.length, 16);
  assert.deepEqual(done[0].quests.map((q) => q.ref), ['bard:1']);
});

test('effectName strips the wrapping the cards put around a spell name', () => {

  assert.equal(effectName('Fury (Must Equip, Casting Time: Instant) at Level 45'), 'Fury');
  assert.equal(effectName('Whirl Bolt (Must Equip) - Cast Time: 1.0 seconds'), 'Whirl Bolt');
  assert.equal(effectName('Haste'), 'Haste');
  assert.equal(effectName("Sha's Lethargy (Combat, Casting Time: Instant) at Level 46"), "Sha's Lethargy");
  assert.equal(effectName(''), null);
});

test('doneCaption reports partial hand-in progress on an undone quest', () => {
  const items = [{ offered: 1 }, { offered: 1 }, { offered: 0 }, {}];
  assert.equal(doneCaption({ done: false, doneSource: null, items }), '2 of 4 handed in per the log');
});

test('ownedLabel is the visible receipt, or nothing for an unowned item', () => {
  assert.equal(ownedLabel({ owned: true, ownedSource: 'log' }), 'owned — seen in the log');
  assert.equal(ownedLabel({ owned: true, ownedSource: 'inventory' }), 'owned — in your inventory dump');
  assert.equal(ownedLabel({ owned: true, ownedSource: 'import' }), 'owned — per the import');
  assert.equal(ownedLabel({ owned: true, ownedSource: 'manual' }), 'owned — your claim');
  assert.equal(ownedLabel({ owned: false, ownedSource: null }), null);
});

// ------------------------------------------------- ready flags and shared items

import { sharedIndex, sharedWith } from '../src/renderer/quests/organize.js';
import { lookup, allItemKeys } from '../src/quests/index.js';

test('classGroups flags a quest ready when every item is owned and it is not done', () => {
  const groups = classGroups(realSnapshot());
  const bard = groups[0];
  // bard:0 stands 2/2 owned (a claim and a derived rune) and unturned-in: ready.
  assert.equal(bard.quests[0].ready, true);
  // bard:1 is done — done and ready are mutually exclusive by construction.
  assert.equal(bard.quests[1].done, true);
  assert.equal(bard.quests[1].ready, false);
  assert.equal(bard.readyCount, 1);
  // Nothing owned anywhere else: no other class shows ready.
  assert.equal(groups.slice(1).every((c) => c.readyCount === 0), true);
});

test('an all-owned quest that is already done is not ready, and empty items never are', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quests-org-'));
  const store = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  store.setOwned('bard:0:0', true);
  store.setOwned('bard:0:1', true);
  store.setDone('bard:0', true);
  const bard = classGroups(store.snapshot())[0];
  assert.equal(bard.quests[0].ownedCount, 2);
  assert.equal(bard.quests[0].ready, false, 'turned in already — nothing left to hand in');

  // The dataset has no zero-item quest; the guard exists for the refresh that adds one.
  const synthetic = { classes: [{ id: 'x', name: 'X', quests: [{ ref: 'x:0', reward: 'R', done: false, items: [] }] }] };
  assert.equal(classGroups(synthetic)[0].quests[0].ready, false);
});

test('the ready rail filter shows only ready quests and every class header survives', () => {
  assert.equal(RAIL_FILTERS.includes('ready'), true);
  const ready = railFilter(classGroups(realSnapshot()), 'ready');
  assert.equal(ready.length, 16, 'every class header survives every filter');
  assert.deepEqual(ready[0].quests.map((q) => q.ref), ['bard:0']);
  assert.equal(ready[1].quests.length, 0);
  assert.equal(ready[0].doneCount, 1, 'counts stay the class totals, not the view');
});

test('doneCaption says ready when everything is owned, and hand-ins keep precedence', () => {
  assert.equal(doneCaption({ done: false, doneSource: null, items: [{ owned: true }, { owned: true }] }),
    'every item owned — ready to hand in');
  // One hand-in started: the partial-progress caption is the more useful sentence.
  assert.equal(doneCaption({ done: false, doneSource: null, items: [{ owned: true, offered: 1 }, { owned: true }] }),
    '1 of 2 handed in per the log');
  assert.match(doneCaption({ done: false, doneSource: null, items: [{ owned: true }, {}] }),
    /checks itself/);
});

test('sharedIndex maps a name to every class wanting it, from the snapshot itself', () => {
  const index = sharedIndex(realSnapshot());
  assert.deepEqual(index.get('Wind Rune Izah').map((s) => s.classId),
    ['beastlord', 'druid', 'enchanter', 'paladin', 'rogue', 'shadowknight', 'wizard']);
  const knuckles = index.get('Brass Knuckles');
  assert.deepEqual(knuckles.map((s) => s.classId), ['beastlord', 'monk']);
  assert.equal(knuckles[1].reward, "Wu's Fist of Mastery");
});

test('sharedWith answers with the OTHER classes, states riding along', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quests-org-'));
  const store = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  store.setDone('monk:5', true); // the monk test that wants Brass Knuckles
  const index = sharedIndex(store.snapshot());
  assert.deepEqual(sharedWith(index, 'Brass Knuckles', 'beastlord'),
    [{ classId: 'monk', className: 'Monk', reward: "Wu's Fist of Mastery", done: true }]);
  // A single-class item has no competition and answers with nothing at all.
  assert.deepEqual(sharedWith(index, 'Crude Wooden Flute', 'bard'), []);
  // An unknown name answers empty rather than throwing.
  assert.deepEqual(sharedWith(index, 'Rusty Sword', 'bard'), []);
});

test('property: every shared item group spells its name identically across classes', () => {
  // sharedIndex matches on raw string equality where the store matches on
  // questItemKey. That is safe exactly as long as the dataset spells a shared name
  // the same way in every class that wants it — true for all 29 shared groups today.
  // A posky.json refresh that breaks it fails here, in WSL, instead of silently
  // dropping chips from the items pane.
  let sharedGroups = 0;
  for (const key of allItemKeys()) {
    const slots = lookup(key);
    if (new Set(slots.map((s) => s.classId)).size < 2) continue;
    sharedGroups++;
    assert.equal(new Set(slots.map((s) => s.itemName)).size, 1,
      `"${key}" is spelled differently across classes`);
  }
  assert.ok(sharedGroups > 0, 'the dataset stopped sharing items — the chips feature is dead code');
});

test('effectMeta condenses the parenthetical without summarizing anything', () => {
  assert.equal(effectMeta('Fury (Must Equip, Casting Time: Instant) at Level 45'),
    'must equip · instant · at level 45');
  assert.equal(effectMeta("Sha's Lethargy (Combat, Casting Time: Instant) at Level 46"),
    'combat · instant · at level 46');
  assert.equal(
    effectMeta('Whirl Bolt (Must Equip) - Cast Time: 1.0 seconds, Required Level: 46, Cooldown: 240 seconds'),
    'must equip · cast time: 1.0 seconds · required level: 46 · cooldown: 240 seconds');
  assert.equal(effectMeta('Haste'), null, 'a bare name has no meta to condense');
});
