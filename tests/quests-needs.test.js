import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bossNeeds, engagedNeeds, nextDropsState, dropsDisplay, parseSources, DROPS_LINGER_MS,
} from '../src/quests/needs.js';
import { QuestProgress } from '../src/quests/progress.js';

/** The smallest snapshot shape bossNeeds reads — hand-built for the pointed cases. */
function snap(classes) {
  return { classes };
}
function cls(id, name, quests) {
  return { id, name, quests };
}
function quest(ref, reward, items, done = false) {
  return { ref, reward, done, items };
}
function item(name, source, { owned = false, rune = false } = {}) {
  return { name, source, owned, rune };
}

test('done quests and owned items contribute nothing', () => {
  const groups = bossNeeds(snap([
    cls('monk', 'Monk', [
      quest('monk:0', 'Cured Wristwraps', [item('Silken Strands', 'Island 3: Gorgalosk')], true),
      quest('monk:1', 'Cured Mask', [item('Worn Mask', 'Island 3: Gorgalosk', { owned: true })]),
    ]),
  ]));
  assert.deepEqual(groups, [], 'turned in is turned in, owned is owned — nothing owed');
});

test('one boss owed two items is one group; one item owed to two classes is one row', () => {
  const groups = bossNeeds(snap([
    cls('beastlord', 'Beastlord', [
      quest('beastlord:0', 'Wristwraps', [item('Leather Cord', 'Island 3: Gorgalosk')]),
    ]),
    cls('shaman', 'Shaman', [
      quest('shaman:0', 'Totem Wraps', [item('Leather Cord', 'Island 3: Gorgalosk')]),
      quest('shaman:1', 'Totem Mask', [item('Worn Mask', 'Island 3: Gorgalosk')]),
    ]),
  ]));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].mob, 'Gorgalosk');
  assert.equal(groups[0].island, '3');
  assert.equal(groups[0].items.length, 2);
  const cord = groups[0].items.find((i) => i.name === 'Leather Cord');
  assert.deepEqual(cord.classes.map((c) => c.classId), ['beastlord', 'shaman'],
    'dataset class order, one flag per class');
  assert.equal(cord.classes[0].ref, 'beastlord:0', 'the flag knows which quest to open');
});

test('a class flags an item once even when two of its undone quests want it', () => {
  const groups = bossNeeds(snap([
    cls('shaman', 'Shaman', [
      quest('shaman:0', 'First', [item('Leather Cord', 'Island 3: Gorgalosk')]),
      quest('shaman:1', 'Second', [item('Leather Cord', 'Island 3: Gorgalosk')]),
    ]),
  ]));
  const cord = groups[0].items[0];
  assert.equal(cord.classes.length, 1);
  assert.equal(cord.classes[0].ref, 'shaman:0', 'first undone quest wins the flag');
});

test('an alternative-source item lists under each boss, naming the others as alsoFrom', () => {
  const source = 'Island 1.5: Noble Dojorn / Island 4: Overseer of Air / Island 8: the Hand of Veeshan';
  const groups = bossNeeds(snap([
    cls('monk', 'Monk', [quest('monk:0', 'Knuckles', [item('Brass Knuckles', source)])]),
  ]));
  assert.deepEqual(groups.map((g) => g.mob),
    ['Noble Dojorn', 'Overseer of Air', 'the Hand of Veeshan']);
  const dojorn = groups[0];
  assert.deepEqual(dojorn.items[0].alsoFrom, [
    { island: '4', mob: 'Overseer of Air' },
    { island: '8', mob: 'the Hand of Veeshan' },
  ]);
  assert.equal(groups[2].items[0].alsoFrom.length, 2, 'each listing names the OTHER two');
});

test('zone-wide sources collapse to one gold group, ranked last', () => {
  const groups = bossNeeds(snap([
    cls('bard', 'Bard', [quest('bard:0', 'Mask', [
      item('Wind Rune Azia', 'Random zone-wide drop', { rune: true }),
      item('Light Woolen Mask', 'Island 3: Gorgalosk'),
    ])]),
    cls('monk', 'Monk', [quest('monk:0', 'Sash', [
      item('Wind Rune Geza', 'Random zone-wide drop', { rune: true }),
    ])]),
  ]));
  assert.equal(groups.length, 2);
  assert.equal(groups[0].mob, 'Gorgalosk');
  const zone = groups[1];
  assert.equal(zone.zoneWide, true);
  assert.deepEqual(zone.items.map((i) => i.name), ['Wind Rune Azia', 'Wind Rune Geza'],
    'one group holds every rune still owed');
  assert.ok(zone.items.every((i) => i.rune));
  assert.deepEqual(zone.items[0].alsoFrom, [], 'zone-wide never notes alternatives');
});

test('islands order ascending with 1.5 before 2, verbatim shapes after, zone last', () => {
  const groups = bossNeeds(snap([
    cls('a', 'A', [quest('a:0', 'R', [
      item('One', 'Island 4: Keeper of Souls'),
      item('Two', 'Island 1.5: Noble Dojorn'),
      item('Three', 'Somewhere strange'),
      item('Four', 'Random zone-wide drop', { rune: true }),
      item('Five', 'Island 2: Protector of Sky'),
    ])]),
  ]));
  assert.deepEqual(groups.map((g) => g.mob),
    ['Noble Dojorn', 'Protector of Sky', 'Keeper of Souls', 'Somewhere strange', 'Random zone-wide drop']);
  assert.equal(groups[3].island, null, 'the verbatim chip rides through, never dropped');
  assert.equal(groups[4].zoneWide, true);
});

// ---------------------------------------------------------------------------
// The property test: the real dataset through the real store.
// ---------------------------------------------------------------------------

test('every unowned item of every undone quest appears under each of its bosses (real snapshot)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quests-needs-'));
  const store = new QuestProgress({ dir, character: 'Rhale', server: 'oggok' });
  const snapshot = store.snapshot();
  const groups = bossNeeds(snapshot);
  const find = (chip, name) => groups.some((g) =>
    (chip.zoneWide ? g.zoneWide : (g.island === chip.island && g.mob === chip.mob))
    && g.items.some((i) => i.name === name));

  let placed = 0;
  for (const c of snapshot.classes) {
    for (const q of c.quests) {
      if (q.done) continue;
      for (const i of q.items) {
        if (i.owned) continue;
        for (const chip of parseSources(i.source)) {
          assert.ok(find(chip, i.name), `${i.name} missing under ${chip.island ?? 'zone'}|${chip.mob}`);
          placed += 1;
        }
      }
    }
  }
  assert.ok(placed > 200, `the dataset places plenty (${placed})`);

  // And the inverse claim: a fully turned-in ledger owes nothing anywhere.
  for (const c of snapshot.classes) for (const q of c.quests) store.setDone(q.ref, true);
  assert.deepEqual(bossNeeds(store.snapshot()), [], 'a finished character gets an empty hunt list');
});

// ---------------------------------------------------------------------------
// The popup's matcher and lifetime.
// ---------------------------------------------------------------------------

const GROUPS = bossNeeds(snap([
  cls('monk', 'Monk', [quest('monk:0', 'Knuckles', [
    item('Brass Knuckles', 'Island 1.5: Noble Dojorn / Island 4: Overseer of Air'),
    item('Silken Strands', 'Island 3: Gorgalosk'),
    item('Wind Rune Geza', 'Random zone-wide drop', { rune: true }),
  ])]),
]));

test('engagedNeeds matches named bosses by case-insensitive equality and nothing looser', () => {
  assert.deepEqual(engagedNeeds(GROUPS, ['Gorgalosk']).map((g) => g.mob), ['Gorgalosk']);
  assert.deepEqual(engagedNeeds(GROUPS, ['gorgalosk']).map((g) => g.mob), ['Gorgalosk'],
    'log capitalization is not a different boss');
  assert.deepEqual(engagedNeeds(GROUPS, ['a spiroc guardian']), [],
    'a family member never matches a blob description');
  assert.deepEqual(engagedNeeds(GROUPS, ['Gorgalosk the Larger']), [], 'no substring matching');
  assert.deepEqual(engagedNeeds(GROUPS, []), []);
});

test('zone-wide never triggers the popup', () => {
  const zoneMob = GROUPS.find((g) => g.zoneWide).mob;
  assert.deepEqual(engagedNeeds(GROUPS, [zoneMob]), []);
});

test('the popup state engages, accumulates, holds through a death, lingers, and expires', () => {
  let s = nextDropsState(null, { active: true, startTs: 100, matchedMobs: ['Gorgalosk'], now: 1000 });
  assert.deepEqual(s, { phase: 'engaged', mobs: ['Gorgalosk'], startTs: 100, until: null });

  // An add joins the pull; the set accumulates.
  s = nextDropsState(s, { active: true, startTs: 100, matchedMobs: ['Gorgalosk', 'Noble Dojorn'], now: 2000 });
  assert.deepEqual(s.mobs, ['Gorgalosk', 'Noble Dojorn']);

  // The parser dropping a slain boss from the engaged set does NOT drop the row —
  // a corpse is exactly what the list is about to be needed for.
  s = nextDropsState(s, { active: true, startTs: 100, matchedMobs: ['Noble Dojorn'], now: 3000 });
  assert.deepEqual(s.mobs, ['Gorgalosk', 'Noble Dojorn']);

  // Close → linger, stamped with its expiry.
  s = nextDropsState(s, { active: false, startTs: null, matchedMobs: [], now: 5000 });
  assert.equal(s.phase, 'linger');
  assert.equal(s.until, 5000 + DROPS_LINGER_MS);
  const lingering = s;

  // Still lingering short of the deadline; gone at it.
  assert.equal(nextDropsState(lingering, { active: false, startTs: null, matchedMobs: [], now: 5000 + DROPS_LINGER_MS - 1 }), lingering);
  assert.equal(nextDropsState(lingering, { active: false, startTs: null, matchedMobs: [], now: 5000 + DROPS_LINGER_MS }), null);

  // A new pull that matches nothing does NOT clear the linger before its deadline:
  // the common case is a stray trash aggro while the boss corpse is being looted,
  // and wiping the loot list for that would defeat the linger's whole purpose.
  assert.equal(nextDropsState(lingering, { active: true, startTs: 6000, matchedMobs: [], now: 7000 }), lingering);
  assert.equal(nextDropsState(lingering, { active: true, startTs: 6000, matchedMobs: [], now: 5000 + DROPS_LINGER_MS }), null);

  // A new pull that matches starts fresh, not a union with the last fight.
  const next = nextDropsState(lingering, { active: true, startTs: 6000, matchedMobs: ['Keeper of Souls'], now: 7000 });
  assert.deepEqual(next.mobs, ['Keeper of Souls']);
});

test('dropsDisplay re-reads the live inversion so looted rows leave mid-linger', () => {
  const state = { phase: 'linger', mobs: ['gorgalosk'], startTs: 100, until: 9000 };
  assert.deepEqual(dropsDisplay(state, GROUPS).map((g) => g.mob), ['Gorgalosk'],
    'state mob names are matched case-insensitively against the current groups');
  const afterLoot = GROUPS.filter((g) => g.mob !== 'Gorgalosk');
  assert.deepEqual(dropsDisplay(state, afterLoot), [], 'everything looted → nothing to paint');
  assert.deepEqual(dropsDisplay(null, GROUPS), []);
});
