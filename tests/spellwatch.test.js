/**
 * The spellwatch table ranks enemy casts for the overlay's warnings. These tests pin
 * the two properties the table exists for: pattern matching that survives this
 * server's rank suffixes ("Mesmerization VIII"), and honest nulls for anything the
 * table does not know — an unlisted spell is shown unclassified, never hidden and
 * never guessed into a category.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/parser/spellwatch.js';

test('ranked spell names classify by stem, not exact name', () => {
  assert.deepEqual(classify('Mesmerization VIII'), { category: 'mez', tier: 3 });
  assert.deepEqual(classify('Greater Healing V'), { category: 'heal', tier: 3 });
});

test('spells confirmed cast by NPCs in the live log get the expected categories', () => {
  assert.deepEqual(classify('Instill'), { category: 'root', tier: 2 });
  assert.deepEqual(classify("Tishan's Clash"), { category: 'stun', tier: 2 });
  assert.deepEqual(classify('Ensnaring Roots'), { category: 'root', tier: 2 });
  assert.deepEqual(classify('Bonds of Force'), { category: 'snare', tier: 2 });
  assert.deepEqual(classify('Superior Healing'), { category: 'heal', tier: 3 });
  assert.deepEqual(classify('Lifespike'), { category: 'lifetap', tier: 1 });
  assert.deepEqual(classify('Lightning Bolt'), { category: 'nuke', tier: 1 });
  assert.deepEqual(classify('Gate'), { category: 'gate', tier: 3 });
});

test('Screaming Terror is the necromancer short mez, never fear', () => {
  assert.equal(classify('Screaming Terror').category, 'mez');
});

test('Harm Touch outranks the calm nuke tier', () => {
  assert.deepEqual(classify('Harm Touch'), { category: 'nuke', tier: 2 });
});

test('the charm family matches across its many names', () => {
  assert.equal(classify('Beguile').category, 'charm');
  assert.equal(classify('Cajoling Whispers').category, 'charm');
  assert.equal(classify('Charm Animals').category, 'charm');
});

test('unlisted and anonymous casts classify as null — shown, not hidden', () => {
  assert.equal(classify('Inner Fire'), null);
  assert.equal(classify('Skin like Rock'), null);
  assert.equal(classify(null), null);
});
