/**
 * The offline rhythm miner.
 *
 * The arithmetic here is the deleted learner's, moved to authoring time — so these are
 * the tests `tests/rhythm.test.js` used to hold, minus everything about predicting live
 * and plus the two things a live tracker never had to get right: raw log names, and
 * remembering which kind of evidence a pair was measured from.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RhythmMiner, castPattern, landedPattern, deathPattern, patternFor, packFromCandidates,
} from '../src/triggers/mine-rhythms.js';

const T0 = Date.parse('2026-08-08T12:00:00Z');

/** Feed evenly-spaced casts, one every `gapMs`. */
function metronome(miner, caster, ability, gapMs, count, opts = {}) {
  for (let i = 0; i < count; i++) {
    miner.observe({
      caster, ability, ts: T0 + i * gapMs, source: opts.source ?? 'cast', body: opts.body ?? null,
    });
  }
}

test('a regular caster yields its interval; an irregular one is marked loose', () => {
  const miner = new RhythmMiner();
  metronome(miner, 'Quag Maelstrom', 'Mana Drain', 19_000, 6);
  for (const [i, ts] of [0, 8000, 40_000, 52_000, 90_000, 100_000].entries()) {
    miner.observe({ caster: 'Gonobn', ability: 'Stun', ts: T0 + ts, source: 'cast' });
    void i;
  }

  const [tight, loose] = ['Mana Drain', 'Stun']
    .map((a) => miner.candidates().find((c) => c.ability === a));

  assert.equal(tight.intervalMs, 19_000);
  assert.equal(tight.loose, false);
  assert.equal(tight.samples, 5);
  assert.equal(loose.loose, true, 'a wandering recast must not ship as a fixed number');
});

test('a pair with too little evidence is not a candidate at all', () => {
  const miner = new RhythmMiner();
  metronome(miner, 'Lord Nagafen', 'Shadow Vortex', 60_000, 3);   // two gaps
  assert.deepEqual(miner.candidates(), []);
});

test('a gap longer than a lull is a different fight, not a cycle', () => {
  const miner = new RhythmMiner();
  metronome(miner, 'King Tranix', 'Life Leech', 18_000, 4);
  // Hours later, the same boss again.
  for (let i = 0; i < 4; i++) {
    miner.observe({
      caster: 'King Tranix', ability: 'Life Leech', ts: T0 + 3_600_000 + i * 18_000, source: 'cast',
    });
  }
  const [c] = miner.candidates();
  assert.equal(c.intervalMs, 18_000);
  assert.equal(c.samples, 6, 'the hour of downtime must not become a gap');
  assert.equal(c.runs, 2, 'two fights is a stronger claim than one and is counted as such');
});

test('an interrupted cast does not teach the early retry that follows it', () => {
  const miner = new RhythmMiner();
  metronome(miner, 'Hoptor Thaggelum', 'Superior Healing', 8000, 4);
  miner.interrupt('Hoptor Thaggelum', 'Superior Healing');
  miner.observe({ caster: 'Hoptor Thaggelum', ability: 'Superior Healing', ts: T0 + 26_000, source: 'cast' });
  metronome(miner, 'Hoptor Thaggelum', 'Superior Healing', 8000, 0);

  const [c] = miner.candidates();
  assert.equal(c.intervalMs, 8000, 'the 2s retry gap was counted');
  assert.equal(c.samples, 3);
});

test('one AE volley is one cycle, however many people it hits', () => {
  const miner = new RhythmMiner();
  for (let cycle = 0; cycle < 5; cycle++) {
    // Six group members, all hit inside the same second.
    for (let who = 0; who < 6; who++) {
      miner.observe({
        caster: 'Lord Nagafen', ability: 'Lava Breath',
        ts: T0 + cycle * 14_000 + who * 100, source: 'landed',
      });
    }
  }
  const [c] = miner.candidates();
  assert.equal(c.intervalMs, 14_000);
  assert.equal(c.source, 'landed');
});

test('cast evidence supersedes landings rather than pooling with them', () => {
  // Mixing the two would give every cycle a full gap AND a tiny cast-to-landing gap.
  const miner = new RhythmMiner();
  metronome(miner, 'Lady Vox', 'Frost Breath', 14_000, 4, { source: 'landed' });
  metronome(miner, 'Lady Vox', 'Frost Breath', 9000, 4, { source: 'cast' });
  // A landing arriving after the casts have taken over is ignored, not counted.
  miner.observe({ caster: 'Lady Vox', ability: 'Frost Breath', ts: T0 + 30_000, source: 'landed' });

  const [c] = miner.candidates();
  assert.equal(c.source, 'cast');
  assert.equal(c.intervalMs, 9000);
  assert.equal(c.samples, 3);
});

test('the first sample line is kept, because it is what the pattern is checked against', () => {
  const miner = new RhythmMiner();
  metronome(miner, 'Bazzt Zzzt', 'Rotting Flesh', 36_000, 4, {
    body: 'Bazzt Zzzt begins casting Rotting Flesh.',
  });
  assert.equal(miner.candidates()[0].sample, 'Bazzt Zzzt begins casting Rotting Flesh.');
});

test('patterns are built from the RAW log name, backticks and all', () => {
  // The trap the whole module exists to avoid: the learner keyed on the parser's resolved
  // name, and a pattern templated from one of those would match nothing at all.
  const cast = castPattern('Baron Telyx V`Zher', 'Furor');
  assert.match('Baron Telyx V`Zher begins casting Furor.', new RegExp(cast));
  assert.doesNotMatch('Baron Telyx V`Zher begins casting Furor of Frost.', new RegExp(cast));

  const landed = landedPattern('Lord Nagafen', 'Lava Breath');
  assert.match('Lord Nagafen hit you for 500 points of fire damage by Lava Breath.', new RegExp(landed));
  assert.match("You resist Lord Nagafen's Lava Breath!", new RegExp(landed));
  // EQ's trailing "(Critical)" blob must not stop the damage half matching.
  assert.match('Lord Nagafen hit Rhale for 1 point of fire damage by Lava Breath. (Critical)',
    new RegExp(landed));
});

test('a regex metacharacter in a mob name cannot break the pattern', () => {
  // Not hypothetical for a format a player edits: a name with a bracket in it would open
  // a group that never closes and take the trigger down with it.
  const p = castPattern('a (weird) mob', 'Bolt of *Fire*');
  assert.match('a (weird) mob begins casting Bolt of *Fire*.', new RegExp(p));
});

test('a death pattern covers every wording rules.js knows and nobody else’s death', () => {
  const re = new RegExp(deathPattern('Lady Vox'));
  assert.ok(re.test('Lady Vox has been slain by Rhale!'));
  assert.ok(re.test('You have slain Lady Vox!'));
  assert.ok(re.test('Lady Vox died.'));
  assert.equal(re.test('Rhale has been slain by Lady Vox!'), false);
});

test('a pack groups its triggers by caster and carries the evidence in each comment', () => {
  const miner = new RhythmMiner();
  metronome(miner, 'Lord Nagafen', 'Shadow Vortex', 62_000, 5);
  metronome(miner, 'Lord Nagafen', 'Lava Breath', 14_000, 5, { source: 'landed' });
  metronome(miner, 'Lady Vox', 'Frost Breath', 14_000, 5, { source: 'landed' });

  const pack = packFromCandidates(miner.candidates(), { id: 'x', name: 'X' });
  assert.equal(pack.origin, 'native');
  assert.equal(pack.shipped, true);
  assert.equal(pack.groups.length, 2, 'one group per caster');
  assert.equal(pack.triggers.length, 3);

  const vortex = pack.triggers.find((t) => t.name === 'Lord Nagafen — Shadow Vortex');
  assert.equal(vortex.timer.durationMs, 62_000);
  assert.equal(vortex.timer.restart, 'new');
  assert.equal(vortex.timer.kind, 'countdown');
  assert.match(vortex.comments, /62\.0s ±0\.5 over 4 gaps in 1 fight, measured from its cast lines\./);
  assert.equal(vortex.pattern, patternFor({ source: 'cast', caster: 'Lord Nagafen', ability: 'Shadow Vortex' }));

  const breath = pack.triggers.find((t) => t.name === 'Lord Nagafen — Lava Breath');
  assert.match(breath.comments, /landing lines/);
  assert.equal(breath.groupId, vortex.groupId, 'one boss, one group');
});
