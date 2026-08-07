/**
 * The tracker's contract is honesty: a timer appears only when observed gaps have
 * earned it, warm-starts only from a well-sampled prior, and retracts the moment the
 * prediction goes stale. The two synthetic bosses here mirror the live-log analysis:
 * a Quag-Maelstrom-like metronome that must qualify, and a Gonobn-like wanderer that
 * must never show a timer at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RhythmTracker, QUALIFY_MIN_GAPS, WARM_START_MIN_SAMPLES } from '../src/parser/rhythm.js';

const S = 1000;

/** Feed casts at the given second offsets. */
function feed(tracker, caster, ability, seconds) {
  for (const s of seconds) tracker.noteCast(caster, ability, s * S);
}

test('a metronomic boss earns a timer after three gaps, anchored to the last cast', () => {
  const t = new RhythmTracker();
  feed(t, 'Quag Maelstrom', 'Mana Drain', [0, 19, 39, 58]);   // gaps 19, 20, 19

  const [timer] = t.timers(60 * S);
  assert.ok(timer, 'three regular gaps must qualify');
  assert.equal(timer.caster, 'Quag Maelstrom');
  assert.equal(timer.intervalMs, 19 * S);
  assert.equal(timer.dueMs, (58 + 19 - 60) * S);
  assert.equal(timer.warm, false);
});

test('two gaps are not enough evidence', () => {
  const t = new RhythmTracker();
  feed(t, 'Quag Maelstrom', 'Mana Drain', [0, 19, 38]);
  assert.equal(t.timers(40 * S).length, 0);
  assert.ok(QUALIFY_MIN_GAPS > 2, 'the gate this test pins');
});

test('a loose caster never gets a timer, however many casts it makes', () => {
  const t = new RhythmTracker();
  // Gonobn-like: median ~28s but wandering wildly — cv far above the gate.
  feed(t, 'Gonobn', 'Stun', [0, 12, 52, 70, 130, 142, 190]);
  assert.equal(t.timers(191 * S).length, 0);
});

test('every real cast re-anchors the prediction', () => {
  const t = new RhythmTracker();
  feed(t, 'Quag Maelstrom', 'Mana Drain', [0, 19, 39, 58]);
  t.noteCast('Quag Maelstrom', 'Mana Drain', 77 * S);   // gaps now 19,20,19,19 — median 19
  const [timer] = t.timers(80 * S);
  assert.equal(timer.dueMs, (77 + 19 - 80) * S);
});

test('the gap after an interrupted cast is not learned', () => {
  const t = new RhythmTracker();
  // Cast, interrupted, early retry 4s later, then the clean 20s cycle resumes.
  t.noteCast('Foalya', 'Spike of Disease', 0);
  t.noteInterrupt('Foalya', 'Spike of Disease');
  feed(t, 'Foalya', 'Spike of Disease', [4, 24, 44, 64]);

  const [timer] = t.timers(65 * S);
  assert.ok(timer, 'the clean gaps alone must qualify');
  assert.equal(timer.intervalMs, 20 * S, 'the 4s post-interrupt retry must not drag the median');
});

test('an overdue prediction retracts instead of counting past zero', () => {
  const t = new RhythmTracker();
  feed(t, 'Quag Maelstrom', 'Mana Drain', [0, 19, 39, 58]);

  const due = (58 + 19) * S;
  assert.equal(t.timers(due + 1 * S)[0].state, 'armed', 'slightly late is within tolerance');

  // The slot HOLDS — the row is the thing the window exists to keep still — but the
  // number does not: a broken pattern has no honest countdown left to show.
  const [lapsed] = t.timers(due + 30 * S);
  assert.equal(lapsed.state, 'lapsed', 'far past due means the pattern broke');
  assert.equal(lapsed.dueMs, null, 'a retracted prediction must never claim a number');

  // The next real cast re-arms it in place, keeping the slot it already had.
  t.noteCast('Quag Maelstrom', 'Mana Drain', due + 31 * S);
  const [rearmed] = t.timers(due + 32 * S);
  assert.equal(rearmed.state, 'armed');
  assert.equal(rearmed.since, lapsed.since, 're-arming must not claim a new slot');
});

test('a stored rhythm warm-starts a timer from the FIRST cast of the fight', () => {
  const t = new RhythmTracker();
  t.setKnown([{ caster: 'Quag Maelstrom', ability: 'Mana Drain', intervalMs: 19 * S, spreadMs: 1500, samples: 10 }]);
  t.noteCast('Quag Maelstrom', 'Mana Drain', 100 * S);

  const [timer] = t.timers(105 * S);
  assert.ok(timer, 'one observed cast plus a prior arms the timer');
  assert.equal(timer.dueMs, (100 + 19 - 105) * S);
  assert.equal(timer.warm, true);
});

test('a thin prior does not warm-start', () => {
  const t = new RhythmTracker();
  t.setKnown([{ caster: 'Quag Maelstrom', ability: 'Mana Drain', intervalMs: 19 * S, spreadMs: 1500, samples: WARM_START_MIN_SAMPLES - 1 }]);
  t.noteCast('Quag Maelstrom', 'Mana Drain', 100 * S);
  assert.equal(t.timers(105 * S).length, 0);
});

test('in-fight evidence outranks the stored prior once it qualifies', () => {
  const t = new RhythmTracker();
  t.setKnown([{ caster: 'Quag Maelstrom', ability: 'Mana Drain', intervalMs: 30 * S, spreadMs: 1500, samples: 10 }]);
  feed(t, 'Quag Maelstrom', 'Mana Drain', [0, 19, 39, 58]);   // this pull says 19s

  const [timer] = t.timers(60 * S);
  assert.equal(timer.intervalMs, 19 * S, 'what this pull is doing beats last week');
  assert.equal(timer.warm, false);
});

test('a dead caster leaves the panel at once; its evidence still exports', () => {
  const t = new RhythmTracker();
  feed(t, 'Quag Maelstrom', 'Mana Drain', [0, 19, 39, 58]);
  assert.equal(t.timers(60 * S)[0].state, 'armed');

  t.dropCaster('Quag Maelstrom');
  assert.deepEqual(t.timers(61 * S), [], 'a countdown for a corpse is not information');
  assert.equal(t.learned().length, 1, 'the kill does not erase what the fight taught');
});

test('killing one caster leaves the others predicting', () => {
  // The price of dropping a dead caster's rows: on a multi-caster pull the survivors
  // move up. What must NOT happen is the survivors going quiet along with the corpse.
  const t = new RhythmTracker();
  feed(t, 'Quag Maelstrom', 'Mana Drain', [0, 19, 39, 58]);
  feed(t, 'Lord Nagafen', 'Lava Breath', [0, 19, 39, 58]);
  assert.equal(t.timers(60 * S).length, 2);

  t.dropCaster('Quag Maelstrom');
  const left = t.timers(61 * S);
  assert.deepEqual(left.map((s) => s.caster), ['Lord Nagafen']);
  assert.equal(left[0].state, 'armed');
});

test('a boss dying empties the panel even while the fight runs on', () => {
  // The single-boss case, which is most of them: the adds are still up and the
  // encounter is still open, but there is nothing left to count down.
  const t = new RhythmTracker();
  feed(t, 'Lord Nagafen', 'Lava Breath', [0, 19, 39, 58]);
  feed(t, 'Lord Nagafen', 'Shadow Vortex', [5, 24, 44, 63]);
  assert.equal(t.timers(64 * S).length, 2);

  t.dropCaster('Lord Nagafen');
  assert.deepEqual(t.timers(65 * S), [], 'every row belonged to the corpse');
});

test('a caster that dies before ever arming claims no slot', () => {
  // Two gaps is not evidence, so nothing was ever on screen for this pair — and a row
  // appearing for a mob that is already dead would be the panel inventing history.
  const t = new RhythmTracker();
  feed(t, 'Quag Maelstrom', 'Mana Drain', [0, 19, 38]);
  t.dropCaster('Quag Maelstrom');
  assert.equal(t.timers(40 * S).length, 0);
});

test('slots keep first-armed order however the countdowns overtake each other', () => {
  const t = new RhythmTracker();
  // Slow one qualifies first, at t=90; the fast one only at t=95 — so the slow spell
  // owns the top row even though it is always the further away of the two.
  feed(t, 'Lord Nagafen', 'Shadow Vortex', [0, 30, 60, 90]);
  const first = t.timers(91 * S);
  assert.deepEqual(first.map((s) => s.ability), ['Shadow Vortex']);

  feed(t, 'Lord Nagafen', 'Lava Breath', [80, 85, 90, 95]);
  const both = t.timers(96 * S);
  assert.deepEqual(both.map((s) => s.ability), ['Shadow Vortex', 'Lava Breath']);
  assert.ok(both[0].dueMs > both[1].dueMs, 'the top row is the LATER of the two');
  assert.equal(both[0].since, first[0].since, 'an existing slot is not re-claimed');

  // A re-anchoring cast must not reshuffle the panel either.
  t.noteCast('Lord Nagafen', 'Shadow Vortex', 120 * S);
  assert.deepEqual(t.timers(121 * S).map((s) => s.ability), ['Shadow Vortex', 'Lava Breath']);
});

test('the states never reach the export — learned() sees only the gaps', () => {
  const t = new RhythmTracker();
  feed(t, 'Quag Maelstrom', 'Mana Drain', [0, 19, 39, 58]);
  assert.equal(t.timers(60 * S)[0].state, 'armed');
  feed(t, 'Lord Nagafen', 'Shadow Vortex', [0, 30, 60, 90]);
  assert.equal(t.timers(91 * S).length, 2, 'both pairs have claimed a slot');
  const before = t.learned();

  // Retract one, kill the other's caster: one row lapses, the other leaves entirely.
  t.dropCaster('Lord Nagafen');
  assert.deepEqual(t.timers(200 * S).map((s) => s.state), ['lapsed']);

  assert.deepEqual(t.learned(), before, 'a lapsed row and a dead one both still export');
  assert.equal(before.length, 2);
});

test('a lull longer than a cycle boundary is not a gap', () => {
  const t = new RhythmTracker();
  // Two clean gaps, a 5-minute lull, then one more — the lull must not be learned.
  feed(t, 'Foalya', 'Spike of Disease', [0, 20, 40, 340, 360]);
  const learned = t.learned();
  assert.equal(learned.length, 1);
  assert.equal(learned[0].samples, 3, 'the 300s lull is a boundary, not evidence');
});

test('only qualified rhythms export to the store', () => {
  const t = new RhythmTracker();
  feed(t, 'Quag Maelstrom', 'Mana Drain', [0, 19, 39, 58]);
  feed(t, 'Gonobn', 'Stun', [0, 12, 52, 70, 130]);

  const learned = t.learned();
  assert.equal(learned.length, 1);
  assert.equal(learned[0].caster, 'Quag Maelstrom');
  assert.equal(learned[0].intervalMs, 19 * S);
  assert.ok(learned[0].samples >= 3);
});

test('landed volleys collapse to one beat and earn a timer', () => {
  const t = new RhythmTracker();
  // Lava-Breath-like: no cast line exists; each volley prints two damage lines a
  // second apart (you, then the warder). The echo must not become a 1s gap.
  for (const s of [0, 13, 26, 39]) {
    t.noteLanded('Lord Nagafen', 'Lava Breath', s * S);
    t.noteLanded('Lord Nagafen', 'Lava Breath', (s + 1) * S);
  }
  const [timer] = t.timers(40 * S);
  assert.ok(timer, 'landings alone must be able to earn a timer');
  assert.equal(timer.intervalMs, 13 * S);
  assert.equal(timer.dueMs, (39 + 13 - 40) * S);
});

test('cast-start evidence supersedes landings for the same spell', () => {
  const t = new RhythmTracker();
  t.noteLanded('Lord Nagafen', 'Shadow Vortex', 0);
  t.noteLanded('Lord Nagafen', 'Shadow Vortex', 60 * S);
  // The first cast line restarts the entry; its own landing 2s later is ignored —
  // otherwise every cycle contributes a 2s cast-to-landing gap beside the real 60s.
  t.noteCast('Lord Nagafen', 'Shadow Vortex', 62 * S);
  t.noteLanded('Lord Nagafen', 'Shadow Vortex', 64 * S);
  feed(t, 'Lord Nagafen', 'Shadow Vortex', [122, 182, 242]);

  const [timer] = t.timers(243 * S);
  assert.ok(timer);
  assert.equal(timer.intervalMs, 60 * S, 'the cast-to-landing gap must not pollute the median');
});

test('reset clears in-fight state but keeps known rhythms', () => {
  const t = new RhythmTracker();
  t.setKnown([{ caster: 'Quag Maelstrom', ability: 'Mana Drain', intervalMs: 19 * S, spreadMs: 1500, samples: 10 }]);
  feed(t, 'Quag Maelstrom', 'Mana Drain', [0, 19, 39, 58]);
  t.reset();

  assert.equal(t.timers(60 * S).length, 0, 'no anchor after reset');
  t.noteCast('Quag Maelstrom', 'Mana Drain', 100 * S);
  assert.equal(t.timers(101 * S)[0]?.warm, true, 'the prior survives the reset');
});
