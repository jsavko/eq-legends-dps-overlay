/**
 * The spellwatch table ranks enemy casts for the overlay's warnings. These tests pin
 * the three properties the table exists for: pattern matching that survives this
 * server's rank suffixes ("Mesmerization VIII"), honest nulls for anything the table
 * does not know — an unlisted spell is shown unclassified, never hidden and never
 * guessed into a category — and the group each entry hands the renderer, which decides
 * which of the player's six switches gets a say over it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, GROUPS } from '../src/parser/spellwatch.js';

test('ranked spell names classify by stem, not exact name', () => {
  assert.deepEqual(classify('Mesmerization VIII'), { category: 'mez', tier: 3, group: 'control' });
  assert.deepEqual(classify('Greater Healing V'), { category: 'heal', tier: 3, group: 'heals' });
});

test('spells confirmed cast by NPCs in the live log get the expected categories', () => {
  assert.deepEqual(classify('Instill'), { category: 'root', tier: 2, group: 'locks' });
  assert.deepEqual(classify("Tishan's Clash"), { category: 'stun', tier: 2, group: 'locks' });
  assert.deepEqual(classify('Ensnaring Roots'), { category: 'root', tier: 2, group: 'locks' });
  assert.deepEqual(classify('Bonds of Force'), { category: 'snare', tier: 2, group: 'locks' });
  assert.deepEqual(classify('Superior Healing'), { category: 'heal', tier: 3, group: 'heals' });
  assert.deepEqual(classify('Lifespike'), { category: 'lifetap', tier: 1, group: 'routine' });
  assert.deepEqual(classify('Lightning Bolt'), { category: 'nuke', tier: 1, group: 'routine' });
  assert.deepEqual(classify('Gate'), { category: 'gate', tier: 3, group: 'heals' });
});

test('Screaming Terror is the necromancer short mez, never fear', () => {
  assert.equal(classify('Screaming Terror').category, 'mez');
});

test('Harm Touch outranks the calm nuke tier', () => {
  assert.deepEqual(classify('Harm Touch'), { category: 'nuke', tier: 2, group: 'bigHits' });
});

test('the charm family matches across its many names', () => {
  assert.equal(classify('Beguile').category, 'charm');
  assert.equal(classify('Cajoling Whispers').category, 'charm');
  assert.equal(classify('Charm Animals').category, 'charm');
});

test('unlisted and anonymous casts classify as null — shown, not hidden', () => {
  // All three verified unlisted against the live log. Tashania in particular must NOT
  // be read as a self-buff despite never damaging anybody: it is a resist debuff cast
  // on the group ("Glorb is cured of Tashania"), and suppressing it would be the
  // classifier deciding something the log does not say.
  assert.equal(classify('Tashania'), null);
  assert.equal(classify('Dry Bone Fire Burst'), null);
  assert.equal(classify('Shadow Vortex'), null);
  assert.equal(classify(null), null);
});

// ----------------------------------------------------------------- groups

test('every classified spell carries a group the renderer can gate on', () => {
  const samples = [
    'Mesmerization', 'Charm', 'Fear', 'Greater Healing', 'Gate', 'Stun',
    'Instill', 'Ensnare', 'Harm Touch', 'Lifespike', 'Cancel Magic',
    'Lightning Bolt', 'Spirit of Wolf',
  ];
  for (const name of samples) {
    const cls = classify(name);
    assert.ok(cls, `${name} should classify`);
    assert.ok(GROUPS.includes(cls.group), `${name} has an unknown group ${cls.group}`);
  }
});

test('the two nuke entries land in different groups — the reason group is not derived from category', () => {
  // Harm Touch is something you brace for; a lightning bolt is something you read
  // afterwards. Same category, two switches — which a category→group map could not do.
  assert.equal(classify('Harm Touch').category, classify('Lightning Bolt').category);
  assert.notEqual(classify('Harm Touch').group, classify('Lightning Bolt').group);
});

// ------------------------------------------------------------ the buff line

test('the self-buff line is suppressed at tier -1, not merely unclassified', () => {
  // Tier -1 means "identified as not worth a chip", which the renderer drops at every
  // setting. Tier 0 means "not identified at all", which the player can still choose
  // to see. Collapsing the two would break the never-hide-an-unknown rule.
  for (const name of [
    'Spirit of Wolf', 'Inner Fire', 'Shield of Thistles', 'Quickness', 'Alacrity',
    'Skin like Rock', 'Center', 'Valor', 'Bravery', 'Symbol of Ryltan',
    'Barrier of Combustion', 'Courage', 'Resolution',
  ]) {
    const cls = classify(name);
    assert.ok(cls, `${name} should be classified as a buff, not left unlisted`);
    assert.equal(cls.tier, -1, `${name} should be suppressed`);
    assert.equal(cls.group, 'buff');
  }
});

test('a heal is never swallowed by the buff line', () => {
  // The regression that matters most. The buff entry is FIRST in the table, so a
  // pattern that reached too far would silence the single most valuable warning the
  // window draws — and "never observed harming anybody", the obvious test for a
  // self-buff, is true of every heal in the log.
  for (const name of [
    'Healing', 'Light Healing', 'Greater Healing', 'Superior Healing',
    'Complete Healing', 'Word of Healing', 'Chloroplast', 'Regrowth',
  ]) {
    assert.equal(classify(name).category, 'heal', `${name} must stay a heal`);
    assert.equal(classify(name).tier, 3);
  }
});

test('the Echo family is a heal — measured healing 161-330 a tick in the live log', () => {
  // It carries no "heal" in the name and was falling through to unlisted, which meant
  // a boss healing itself 336 times over one session drew nothing but a calm line.
  for (const name of ['Celestial Echo', 'Celestial Echo V', 'Sacred Echo', 'Renewing Echo']) {
    assert.deepEqual(classify(name), { category: 'heal', tier: 3, group: 'heals' });
  }
});

test('spells that look like buffs but harm the group stay out of the buff line', () => {
  // Chaotic Feedback deals real magic damage ("a greater skeleton hit you for 37 points
  // of magic damage by Chaotic Feedback"), so no `feedback` pattern exists at all.
  assert.notEqual(classify('Chaotic Feedback')?.group, 'buff');
  assert.notEqual(classify('Feedback')?.group, 'buff');
});
