import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bossNeeds, dropGroups, engagedNeeds, nextDropsState, dropsDisplay,
  parseSources, DROPS_LINGER_MS,
} from '../src/quests/needs.js';
import { QuestProgress } from '../src/quests/progress.js';
import { FAMILIES, POSKY } from '../src/quests/index.js';
import { stripArticle } from '../src/parser/entities.js';

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

// ---------------------------------------------------------------------------
// The learned drop index: the popup's other half.
// ---------------------------------------------------------------------------

/** The dataset half of every case below, plus a `drops` index to union with it. */
const LEARNED = (drops) => ({
  drops,
  classes: [
    cls('ranger', 'Ranger', [quest('ranger:0', "Earthshaker's Mantle", [
      // A family blob: prose, not a name the log will ever write.
      item('Spiroc Earth Totem', 'Island 5: spiroc mobs / Island 5: The Spiroc Lord'),
    ])]),
    cls('bard', 'Bard', [quest('bard:0', 'Singing Short Sword', [
      // The bee blob, plus the boss chip the log spells differently.
      item('Bee Stinger', 'Island 6: "bee" mobs / Island 6: Bazzt Zzzt "Bees"'),
      item('Wind Rune Azia', 'Random zone-wide drop', { rune: true }),
    ])]),
    cls('monk', 'Monk', [quest('monk:0', 'Knuckles', [
      item('Silken Strands', 'Island 3: Gorgalosk'),
    ])]),
  ],
});

test('a trash mob the dataset only describes as a family fires from what the log saw', () => {
  const snapshot = LEARNED({ 'spiroc vanquisher': { 'Spiroc Earth Totem': 3 } });
  const groups = dropGroups(snapshot);
  assert.deepEqual(engagedNeeds(groups, ['spiroc vanquisher']).map((g) => g.mob),
    ['spiroc vanquisher']);
  const row = engagedNeeds(groups, ['spiroc vanquisher'])[0].items[0];
  assert.equal(row.name, 'Spiroc Earth Totem');
  assert.deepEqual(row.classes.map((c) => c.className), ['Ranger'], 'and to whom it is owed');
  assert.equal('boss' in row, false,
    'two chips source it, so no single boss can be named without picking one');
  assert.deepEqual(row.alsoFrom, [
    { island: '5', mob: 'spiroc mobs' },
    { island: '5', mob: 'The Spiroc Lord' },
  ], 'the dataset genuinely never said this mob drops it — every chip is an alternative');
  assert.equal(engagedNeeds(groups, ['spiroc vanquisher'])[0].island, null,
    'the island is not inferred from the item — a label is not worth a guess');
});

test("Bazzt Zzzt fires though the dataset spells it 'Bazzt Zzzt \"Bees\"'", () => {
  const snapshot = LEARNED({ 'Bazzt Zzzt': { 'Bee Stinger': 18 } });
  const groups = dropGroups(snapshot);
  assert.deepEqual(engagedNeeds(groups, ['Bazzt Zzzt']).map((g) => g.mob), ['Bazzt Zzzt']);
  assert.equal(engagedNeeds(groups, ['Bazzt Zzzt'])[0].items[0].name, 'Bee Stinger');
  // And the odd-spelled bee that contains no "bee" anywhere in its name.
  const bzz = dropGroups(LEARNED({ Bzzazzt: { 'Bee Stinger': 6 } }));
  assert.deepEqual(engagedNeeds(bzz, ['Bzzazzt']).map((g) => g.mob), ['Bzzazzt']);
});

test('a learned row the dataset already places is not doubled and never claims to be learned', () => {
  const snapshot = LEARNED({ Gorgalosk: { 'Silken Strands': 4 } });
  const group = engagedNeeds(dropGroups(snapshot), ['Gorgalosk'])[0];
  assert.equal(group.island, '3', 'the dataset group is kept, not replaced by a learned one');
  assert.deepEqual(group.items.map((i) => i.name), ['Silken Strands']);
  assert.equal('boss' in group.items[0], false,
    'the dataset named this mob outright — the row must carry no weaker qualifier');
});

test('a dataset boss gains the rows the dataset never attributed to it', () => {
  const snapshot = LEARNED({ Gorgalosk: { 'Wind Rune Azia': 5 } });
  const group = engagedNeeds(dropGroups(snapshot), ['Gorgalosk'])[0];
  assert.deepEqual(group.items.map((i) => i.name), ['Silken Strands', 'Wind Rune Azia']);
  assert.equal(group.items[1].rune, true);
  assert.equal('boss' in group.items[1], false,
    'a rune falls zone-wide — "anywhere" is not a boss, so the row names none');
});

test('an item already owned or turned in never reaches the popup, however often it dropped', () => {
  const owned = LEARNED({ 'spiroc vanquisher': { 'Spiroc Earth Totem': 9 } });
  owned.classes[0].quests[0].items[0].owned = true;
  assert.deepEqual(engagedNeeds(dropGroups(owned), ['spiroc vanquisher']), [],
    'the still-needed filter is the whole popup');

  const done = LEARNED({ 'spiroc vanquisher': { 'Spiroc Earth Totem': 9 } });
  done.classes[0].quests[0].done = true;
  assert.deepEqual(engagedNeeds(dropGroups(done), ['spiroc vanquisher']), []);
});

test('a learned name the dataset no longer knows is dropped, not published nameless', () => {
  const snapshot = LEARNED({ 'a fatestealer drake': { 'Some Removed Item': 2 } });
  assert.deepEqual(engagedNeeds(dropGroups(snapshot), ['fatestealer drake']), []);
});

test('anyMob: false reproduces the shipped named-boss-only behaviour exactly', () => {
  const snapshot = LEARNED({
    'spiroc vanquisher': { 'Spiroc Earth Totem': 3 },
    Gorgalosk: { 'Wind Rune Azia': 5 },
  });
  const strict = dropGroups(snapshot, { anyMob: false });
  assert.deepEqual(strict, bossNeeds(snapshot), 'the dataset half alone');
  assert.deepEqual(engagedNeeds(strict, ['spiroc vanquisher']), []);
  assert.deepEqual(engagedNeeds(strict, ['Gorgalosk'])[0].items.map((i) => i.name),
    ['Silken Strands'], 'and no learned rune row on the boss either');
});

test('a snapshot with no drop index at all is the dataset half, switch or no switch', () => {
  const snapshot = LEARNED(undefined);
  assert.deepEqual(dropGroups(snapshot), bossNeeds(snapshot));
  assert.deepEqual(dropGroups(snapshot, { anyMob: true }), bossNeeds(snapshot));
});

test('the two dataset bosses the log only ever writes with an article now match', () => {
  // Measured, not assumed: the live log writes "the Hand of Veeshan" 5,405 times and
  // "a greater sphinx" 18,790 times, and never once without the article — which the
  // combat parser strips before it reaches engagedNames. Under bare lowercase equality
  // neither boss could ever have fired the popup.
  const groups = bossNeeds(snap([
    cls('monk', 'Monk', [quest('monk:0', 'Knuckles', [
      item('Sphinx Feather', 'Island 7: a greater sphinx'),
      item('Veeshan Scale', 'Island 8: the Hand of Veeshan'),
    ])]),
  ]));
  assert.deepEqual(engagedNeeds(groups, ['greater sphinx']).map((g) => g.mob), ['a greater sphinx']);
  assert.deepEqual(engagedNeeds(groups, ['Hand of Veeshan']).map((g) => g.mob), ['the Hand of Veeshan']);
  assert.deepEqual(engagedNeeds(groups, ['spiroc mobs']), [],
    'and a blob with no article to lose is exactly as unmatchable as it was');
});

test('the popup lifetime and painter carry a learned mob exactly as a named one', () => {
  const snapshot = LEARNED({ 'spiroc vanquisher': { 'Spiroc Earth Totem': 3 } });
  const groups = dropGroups(snapshot);
  const state = nextDropsState(null, {
    active: true, startTs: 100,
    matchedMobs: engagedNeeds(groups, ['spiroc vanquisher']).map((g) => g.mob),
    now: 1000,
  });
  assert.deepEqual(dropsDisplay(state, groups).map((g) => g.mob), ['spiroc vanquisher']);
  // Looted mid-linger: the row leaves because the inversion is re-read, not cached.
  const afterLoot = LEARNED({ 'spiroc vanquisher': { 'Spiroc Earth Totem': 4 } });
  afterLoot.classes[0].quests[0].items[0].owned = true;
  assert.deepEqual(dropsDisplay(state, dropGroups(afterLoot)), []);
});

// ---------------------------------------------------------------------------
// The family member lists: the popup's third half, and the only one that can
// answer for an item this character has never looted.
// ---------------------------------------------------------------------------

/**
 * The dataset half of every case below, plus the shipped family lists to resolve its
 * two blob source strings. Deliberately the SAME `LEARNED` dataset, so every case here
 * can be read against the learned-index case directly above it: the difference between
 * the two halves is which of them can speak about an item nothing has looted yet.
 */
const WITH_FAMILIES = (drops = undefined) => ({
  ...LEARNED(drops),
  families: [
    {
      island: '5',
      mob: 'spiroc mobs',
      boss: 'The Spiroc Lord',
      members: [{ name: 'spiroc vanquisher', how: 'hand' }, { name: 'spiroc walker', how: 'log' }],
    },
    {
      island: '6',
      mob: 'Bazzt Zzzt "Bees"',
      boss: 'Bazzt Zzzt',
      // The named mob AND its bees, because that is what the string says.
      members: [{ name: 'Bazzt Zzzt', how: 'hand' }, { name: 'Bzzazzt', how: 'hand' }],
    },
  ],
});

test('a family member fires for an item nothing has ever looted', () => {
  // The live defect, in one case: farming bees for an earring the app knows is owed
  // and knows comes from bees, and saying nothing — because a learned index can only
  // ever describe what has already been looted.
  const groups = dropGroups(WITH_FAMILIES());
  const matched = engagedNeeds(groups, ['Bzzazzt']);
  assert.deepEqual(matched.map((g) => g.mob), ['Bzzazzt']);
  assert.equal(matched[0].island, '6', "the family's own island, which the dataset stated");
  const row = matched[0].items[0];
  assert.equal(row.name, 'Bee Stinger');
  assert.equal(row.boss, 'Bazzt Zzzt',
    'the row names the boss, never the blob prose that placed it — "bee mobs" is not '
    + 'something a player can go and kill');
  assert.deepEqual(row.classes.map((c) => c.className), ['Bard']);
});

test('a named mob shows its dataset rows and its family rows as one group', () => {
  // Bazzt Zzzt is a chip of his own AND a member of the bee family. Two groups for one
  // corpse would be the mob-led reading of a question that is about the corpse.
  const groups = dropGroups(WITH_FAMILIES());
  const matched = engagedNeeds(groups, ['Bazzt Zzzt']);
  assert.equal(matched.length, 1, 'one corpse, one group');
  assert.deepEqual(matched[0].items.map((i) => i.name), ['Bee Stinger']);
  assert.equal(matched[0].items[0].boss, 'Bazzt Zzzt');
});

test('a family never duplicates a row the dataset already placed under that mob', () => {
  const snapshot = WITH_FAMILIES();
  // Give the boss chip and the family chip an item in common, spelled identically.
  snapshot.classes[1].quests[0].items[0].source = 'Island 6: Bazzt Zzzt / Island 6: Bazzt Zzzt "Bees"';
  const matched = engagedNeeds(dropGroups(snapshot), ['Bazzt Zzzt']);
  assert.equal(matched.length, 1);
  assert.deepEqual(matched[0].items.map((i) => i.name), ['Bee Stinger']);
  assert.equal('boss' in matched[0].items[0], false,
    'the dataset named the mob outright — the row must not claim a weaker source');
});

test('a mob in no family fires nothing, and an owned item never reaches one that is', () => {
  const groups = dropGroups(WITH_FAMILIES());
  assert.deepEqual(engagedNeeds(groups, ['spiroc arbiter']), [],
    'membership is a list, not a guess about the word "spiroc"');
  assert.deepEqual(engagedNeeds(groups, ['Bzzzt']), [],
    'and a bee the table has not got to yet is honestly silent, not silently wrong');

  const owned = WITH_FAMILIES();
  owned.classes[0].quests[0].items[0].owned = true;
  assert.deepEqual(engagedNeeds(dropGroups(owned), ['spiroc vanquisher']), [],
    'the still-needed filter runs ahead of every half');
});

test('a family and the learned index agree about a mob rather than opening two groups', () => {
  const snapshot = WITH_FAMILIES({ 'spiroc vanquisher': { 'Spiroc Earth Totem': 3 } });
  const matched = engagedNeeds(dropGroups(snapshot), ['spiroc vanquisher']);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].island, '5', 'the family knows the island; the learned half would not');
  assert.deepEqual(matched[0].items.map((i) => i.name), ['Spiroc Earth Totem']);
  assert.equal(matched[0].items[0].boss, 'The Spiroc Lord',
    'the family got there first, and it names the island boss the blob never did');
});

test('anyMob: false still reproduces named-boss-only exactly, families and all', () => {
  const snapshot = WITH_FAMILIES({ 'spiroc vanquisher': { 'Spiroc Earth Totem': 3 } });
  const strict = dropGroups(snapshot, { anyMob: false });
  assert.deepEqual(strict, bossNeeds(snapshot));
  assert.deepEqual(engagedNeeds(strict, ['Bzzazzt']), []);
  assert.deepEqual(engagedNeeds(strict, ['spiroc vanquisher']), []);
});

test('a missing, empty or malformed family list is silence, never a crash', () => {
  const base = dropGroups(LEARNED());
  assert.deepEqual(dropGroups({ ...LEARNED(), families: [] }), base);
  assert.deepEqual(dropGroups({ ...LEARNED(), families: null }), base);
  const junk = dropGroups({
    ...LEARNED(),
    families: [{ island: '5', mob: 'spiroc mobs', boss: 'The Spiroc Lord' },
      { island: '6', mob: 'nothing sources this', boss: 'Bazzt Zzzt', members: [{ name: 'x', how: 'hand' }] }],
  });
  assert.deepEqual(junk, base, 'a family with no members, and one nothing owes, both contribute nothing');
});

test('the shipped families.json resolves every blob the dataset actually writes', () => {
  // The whole point of the file being finite: six family source strings in the dataset,
  // six entries here, each naming members. A seventh blob appearing in a refreshed
  // posky.json should fail this test rather than go quietly unmatchable.
  const BLOBS = new Set([
    '6|"bee" mobs',
    '6|Bazzt Zzzt "Bees"',
    '5|spiroc mobs',
    '7|drake/sphinx/spirit mobs',
    '4|essence/soul mobs, Eternal Spirit',
    '4|soul/essence griffons (maybe also Eternal Spirit)',
  ]);
  const covered = new Set(FAMILIES.families.map((f) => `${f.island ?? ''}|${f.mob}`));
  assert.deepEqual([...covered].sort(), [...BLOBS].sort());
  for (const family of FAMILIES.families) {
    assert.ok(family.members.length, `${family.mob} has members`);
    for (const m of family.members) {
      assert.ok(m.name.trim(), 'every member is named');
      assert.ok(m.how === 'log' || m.how === 'hand', `${m.name} says how it was established`);
    }
    // A family with no boss would put blob prose on a popup row, which is the reported
    // defect: the string the dataset wrote is not a thing the player can go and kill.
    assert.ok(family.boss, `${family.mob} names the island boss its rows will be qualified with`);
  }

  // And every blob in the dataset is one of the six — the file is complete, not partial.
  const inData = new Set();
  for (const cls of POSKY.classes) {
    for (const q of cls.quests) {
      for (const it of q.items) {
        for (const chip of parseSources(it.source)) {
          if (!chip.zoneWide) inData.add(`${chip.island ?? ''}|${chip.mob}`);
        }
      }
    }
  }
  for (const blob of BLOBS) assert.ok(inData.has(blob), `${blob} is still a source the dataset writes`);
});

test('no family names a mob the SAME source string already names on its own', () => {
  // The failure this guards is duplication on one corpse: `Island 5: spiroc mobs /
  // The Spiroc Lord` is one string holding two statements about one item, and a family
  // that listed the Lord would place that item under him twice over. Being named in a
  // DIFFERENT string is fine and expected — `a greater sphinx` has a chip of its own for
  // one item and is a genuine member of the island-7 family for two others, so the
  // merged group carries all three rows and none of them twice.
  const byMob = new Map(FAMILIES.families.map((f) => [f.mob, f]));
  for (const cls of POSKY.classes) {
    for (const q of cls.quests) {
      for (const it of q.items) {
        const chips = parseSources(it.source).filter((c) => !c.zoneWide);
        const families = chips.filter((c) => byMob.has(c.mob));
        const named = new Set(chips.filter((c) => !byMob.has(c.mob))
          .map((c) => stripArticle(c.mob).toLowerCase()));
        for (const family of families) {
          for (const m of byMob.get(family.mob).members) {
            assert.ok(!named.has(stripArticle(m.name).toLowerCase()),
              `${it.name}: "${family.mob}" lists ${m.name}, which the same source names outright`);
          }
        }
      }
    }
  }
});

test('every shipped family row survives a real snapshot without doubling anything', () => {
  // The data invariant above, proved through the actual matcher: build a snapshot that
  // owes every family-sourced item in the dataset and check no mob ever gets one twice.
  const snapshot = {
    families: FAMILIES.families,
    classes: POSKY.classes.map((c) => ({
      id: c.id,
      name: c.name,
      quests: c.quests.map((q, qi) => ({
        ref: `${c.id}:${qi}`,
        reward: q.reward,
        done: false,
        items: q.items.map((it) => ({ name: it.name, source: it.source, owned: false, rune: false })),
      })),
    })),
  };
  for (const group of dropGroups(snapshot)) {
    const names = group.items.map((i) => i.name);
    assert.equal(new Set(names).size, names.length, `${group.mob} lists every item once`);
  }
  // And the live case end to end, off the shipped table rather than a fixture.
  const bees = engagedNeeds(dropGroups(snapshot), ['Bzzzt']);
  assert.deepEqual(bees.map((g) => g.mob), ['Bzzzt']);
  assert.ok(bees[0].items.some((i) => i.name === 'Adamantium Earring' && i.boss === 'Bazzt Zzzt'));
});
