/**
 * The effect-tooltip data contract: every effect on every reward card must resolve,
 * post-merge, to either a real entry or an explicit `missing` name. There is no
 * silent third state — that third state is how the tooltips shipped "verified" on a
 * bard item while rendering nothing at all for a beastlord, whose entire class the
 * classic-era P99 wiki predates. The renderer builds an honest "no description"
 * popup from `missing`; a name in neither bucket would hover like a covered one and
 * answer like a broken one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { POSKY, EFFECTS } from '../src/quests/index.js';
import { parseRewardStats, effectName } from '../src/renderer/quests/organize.js';

/** Every effect name on every card in the dataset, tagged with its class. */
function allCardEffects() {
  const out = [];
  for (const cls of POSKY.classes) {
    for (const quest of cls.quests) {
      for (const card of parseRewardStats(quest.rewardStats ?? '')) {
        for (const effect of card.effects) {
          out.push({ cls: cls.id, reward: quest.reward, text: effect.text });
        }
      }
    }
  }
  return out;
}

test('every card effect resolves to an entry or an explicit missing name', () => {
  const effects = allCardEffects();
  assert.ok(effects.length > 0, 'the dataset should have effect lines at all');
  for (const { cls, reward, text } of effects) {
    const name = effectName(text);
    assert.ok(name, `${cls} / ${reward}: effect text did not yield a name: "${text}"`);
    const covered = Boolean(EFFECTS.effects[name]) || EFFECTS.missing.includes(name);
    assert.ok(covered, `${cls} / ${reward}: "${name}" is neither an entry nor listed `
      + 'missing — the silent third state the tooltip surface must never have');
  }
});

test('beastlord specifically: the class that shipped 100% silent stays covered', () => {
  // Pinned by class id because this is the failure that reached the player: P99 has
  // no beastlord, so before the effects-legends.json supplement, not one beastlord
  // effect had an entry and the whole feature read as broken on his own pages.
  const bst = POSKY.classes.find((c) => c.id === 'beastlord');
  assert.ok(bst, 'dataset has a beastlord class');
  const names = allCardEffects()
    .filter((e) => e.cls === 'beastlord')
    .map((e) => effectName(e.text));
  assert.ok(names.length >= 4, 'beastlord quests carry the four known effects');
  // The four known spells are transcribed in the supplement, so they must resolve to
  // real ENTRIES — a merely honest absence here would mean the supplement regressed.
  // A future dataset addition with a genuinely unsourceable spell may land in
  // `missing` instead; that is a legal state, so only the known four are pinned hard.
  const transcribed = ['Whirl Bolt', 'Vigor of Zehkes', "Herikol's Soothing", "Sha's Lethargy"];
  for (const name of transcribed) {
    assert.ok(EFFECTS.effects[name], `beastlord "${name}" lost its transcribed entry`);
  }
  for (const name of names) {
    const covered = Boolean(EFFECTS.effects[name]) || EFFECTS.missing.includes(name);
    assert.ok(covered, `beastlord "${name}" fell out of both buckets`);
  }
});

test('missing never overlaps effects — one bucket per name after the merge', () => {
  for (const name of EFFECTS.missing) {
    assert.ok(!EFFECTS.effects[name],
      `"${name}" is listed missing but also has an entry — the merge must recompute missing`);
  }
});

test('the legends supplement, when present, is transcription-shaped and never shadows the wiki', () => {
  const url = new URL('../src/quests/effects-legends.json', import.meta.url);
  let legends;
  try {
    legends = JSON.parse(fs.readFileSync(url, 'utf8'));
  } catch {
    // No supplement is a legal state (the honest-absence popup covers everything);
    // this test guards the file's contract only once it exists.
    return;
  }
  const wiki = JSON.parse(
    fs.readFileSync(new URL('../src/quests/effects.json', import.meta.url), 'utf8'),
  );
  assert.ok(legends.attribution?.source, 'supplement names its source in attribution');
  for (const [name, entry] of Object.entries(legends.effects)) {
    // Transcribed, not authored: an entry with no URL to check it against is exactly
    // the hand-written guess the original design banned.
    assert.match(entry.url ?? '', /^https?:\/\//, `${name}: entry carries the URL it was copied from`);
    assert.ok(typeof entry.source === 'string' && entry.source.length,
      `${name}: entry names its source for the tooltip footer`);
    assert.ok(Array.isArray(entry.lines) && entry.lines.length
      && entry.lines.every((l) => typeof l === 'string' && l.trim().length),
    `${name}: entry has non-empty verbatim lines`);
    if (wiki.effects[name]) {
      // Gap-filler only: where both files know a spell, the fetched snapshot wins.
      assert.equal(EFFECTS.effects[name].url, wiki.effects[name].url,
        `${name}: wiki snapshot must win over the supplement`);
    }
  }
});
