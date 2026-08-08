import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mineSpellNames, normalizeSpellName, spellNamesIn } from '../src/triggers/mine.js';
import { parseGinaPackage } from '../src/triggers/gina.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'gina');

test('a rank suffix comes off, so two servers spell the same spell the same way', () => {
  // The single most important normalization: EQ Legends renamed "Mesmerization" to
  // "Mesmerization VIII", which is exactly why name-keyed triggers stop porting.
  assert.equal(normalizeSpellName('Mesmerization VIII'), 'Mesmerization');
  assert.equal(normalizeSpellName('Spirit of Wolf V'), 'Spirit of Wolf');
  assert.equal(normalizeSpellName('Complete Heal'), 'Complete Heal');
  assert.equal(normalizeSpellName('Chloroplast Rk. II'), 'Chloroplast');
  assert.equal(normalizeSpellName('Shock of Fire 3'), 'Shock of Fire');
});

test('GINA tokens are not spell names', () => {
  assert.equal(normalizeSpellName('{S}'), '');
  assert.equal(normalizeSpellName('${spell}'), '');
  assert.equal(normalizeSpellName('{C} Complete Heal'), 'Complete Heal');
});

test('a spell name is pulled out of the shapes that state one', () => {
  assert.deepEqual(spellNamesIn('^You begin casting Harmony\\.$'), ['Harmony']);
  assert.deepEqual(spellNamesIn('(?<mob>.*) begins to cast Complete Heal.'), ['Complete Heal']);
  assert.deepEqual(spellNamesIn('Your target resisted the Mesmerization spell.'), ['Mesmerization']);
});

test('a pattern that names no spell yields nothing', () => {
  // The emote-keyed majority. These are the patterns most likely to survive a port and
  // they are worthless to a name-keyed table — the mining has to say so by finding none.
  assert.deepEqual(spellNamesIn('^(?<mob>.*) yawns\\.$'), []);
  assert.deepEqual(spellNamesIn('(?<mob>.*) staggers in pain\\.'), []);
  assert.deepEqual(spellNamesIn('(You have slain (?<mob>.*)!)'), []);
  assert.deepEqual(spellNamesIn(''), []);
  assert.deepEqual(spellNamesIn(null), []);
});

test('a wildcard capture is not mistaken for a name', () => {
  // `resisted the (?<S>.+?) spell` is a placeholder FOR a name, not a name — mining it
  // would put the literal regex into the curated table.
  assert.deepEqual(spellNamesIn('Your target resisted the (?<S>.+?) spell.'), []);
});

test('one pack votes once for a spell, however many triggers repeat it', () => {
  // The real corpus contains a pack that is 34 copies of one pattern. Without this it
  // would outvote 34 independent authors by itself.
  const spammy = {
    name: 'spammy',
    triggers: Array.from({ length: 20 }, (_, i) => ({
      name: `t${i}`, pattern: 'You begin casting Harmony.',
    })),
  };
  const { candidates } = mineSpellNames([spammy], { minPacks: 1 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].spell, 'Harmony');
  assert.equal(candidates[0].packs, 1);
  assert.equal(candidates[0].triggers, 20);
});

test('agreement across independent packs is what promotes a candidate', () => {
  const packs = [
    { name: 'a', triggers: [{ name: 't', pattern: 'You begin casting Harmony.' }] },
    { name: 'b', triggers: [{ name: 't', pattern: 'You begin casting Harmony V.' }] },
    { name: 'c', triggers: [{ name: 't', pattern: 'You begin casting Levitate.' }] },
  ];
  const { candidates } = mineSpellNames(packs, { minPacks: 2 });
  assert.deepEqual(candidates.map((c) => c.spell), ['Harmony']);
  assert.equal(candidates[0].packs, 2, 'the rank suffix must not split the vote');
});

test('an already-classified spell is reported as confirmation, not as a candidate', () => {
  const packs = [
    { name: 'a', triggers: [{ name: 't', pattern: 'begins to cast Complete Heal.' }] },
    { name: 'b', triggers: [{ name: 't', pattern: 'begins to cast Complete Heal.' }] },
  ];
  const classify = (name) => (name === 'Complete Heal' ? { group: 'heals', category: 'heal', tier: 3 } : null);
  const { candidates } = mineSpellNames(packs, { minPacks: 2, classify });
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].known, { group: 'heals', category: 'heal', tier: 3 });
});

test('the committed corpus names no spells at all — the finding, not a bug', () => {
  // Every fixture pattern is emote-keyed or slain-keyed. That is the plan's central
  // measurement restated from the other end: the triggers that port are the ones that
  // never say a spell's name, so a name-keyed mine over them comes back empty. If this
  // ever starts finding names, the fixtures changed and the claim needs re-checking.
  const packs = fs.readdirSync(FIXTURES)
    .filter((f) => /\.(gtp|xml)$/i.test(f))
    .map((f) => parseGinaPackage(fs.readFileSync(path.join(FIXTURES, f)), { name: f }).pack);

  assert.ok(packs.length >= 4, 'expected the committed fixture corpus');
  const { candidates } = mineSpellNames(packs, { minPacks: 1 });
  assert.deepEqual(candidates, []);
});
