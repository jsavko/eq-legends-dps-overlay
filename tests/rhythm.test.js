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
  assert.equal(t.timers(due + 1 * S).length, 1, 'slightly late is within tolerance');
  assert.equal(t.timers(due + 30 * S).length, 0, 'far past due means the pattern broke');

  // The next real cast brings the timer back.
  t.noteCast('Quag Maelstrom', 'Mana Drain', due + 31 * S);
  assert.equal(t.timers(due + 32 * S).length, 1);
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

test('a dead caster stops predicting; its evidence still exports', () => {
  const t = new RhythmTracker();
  feed(t, 'Quag Maelstrom', 'Mana Drain', [0, 19, 39, 58]);
  t.dropCaster('Quag Maelstrom');
  assert.equal(t.timers(60 * S).length, 0);
  assert.equal(t.learned().length, 1, 'the kill does not erase what the fight taught');
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

test('reset clears in-fight state but keeps known rhythms', () => {
  const t = new RhythmTracker();
  t.setKnown([{ caster: 'Quag Maelstrom', ability: 'Mana Drain', intervalMs: 19 * S, spreadMs: 1500, samples: 10 }]);
  feed(t, 'Quag Maelstrom', 'Mana Drain', [0, 19, 39, 58]);
  t.reset();

  assert.equal(t.timers(60 * S).length, 0, 'no anchor after reset');
  t.noteCast('Quag Maelstrom', 'Mana Drain', 100 * S);
  assert.equal(t.timers(101 * S)[0]?.warm, true, 'the prior survives the reset');
});
