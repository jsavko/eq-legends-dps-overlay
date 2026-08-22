/**
 * Measuring how long the player's own effects last, from their own log.
 *
 * The three things that matter here, in the order they can go wrong:
 *
 *  - **Last-land, not first-land.** A recast REFRESHES, and the player recasts
 *    constantly. Measuring from the first land of a cycle turns one duration into a
 *    range; measuring from the last gives the number.
 *  - **Alternation, from both ends.** A wear-off has a land behind it since the previous
 *    wear-off, and a run of lands ends in one. Requiring only the first half lets any
 *    common line through, because behind a line that fires four hundred times there is
 *    always some land.
 *  - **The rule table is the filter.** Buff prose is exactly the text no combat rule
 *    matches, which is not a heuristic — it is the other half of what
 *    `collect-unknown.js` reports. Without it `You try to crush X, but miss!` sails
 *    through every content filter, repeats forty thousand times, and produces nine
 *    thousand "effects".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BuffMiner, buffTrigger, packFromBuffs, displayName, linePattern,
} from '../src/triggers/mine-buffs.js';
import { normalize } from '../src/triggers/pack.js';

const T0 = Date.UTC(2026, 7, 22, 6, 0, 0);
const at = (sec) => T0 + sec * 1000;

/** The real lines, from the live log on 22 Aug. */
const CAST = 'You begin casting Spirit of the Puma V.';
const LAND = 'You begin to snarl as your features become feline.';
const WEAR = 'The spirit of the puma departs.';

/** Feed a miner a list of [seconds, body] pairs. */
function mine(events, opts) {
  const miner = new BuffMiner(opts);
  for (const [sec, body] of events) miner.observe(body, at(sec));
  return miner;
}

/** One cycle: a cast, a land, a recast that refreshes, and finally the wear-off. The
 *  refresh is what makes first-land and last-land give different answers. */
function cycle(start, { refreshAt = 20, endAt = 150 } = {}) {
  return [
    [start, CAST], [start + 2, LAND],
    [start + refreshAt, CAST], [start + refreshAt + 2, LAND],
    [start + endAt, WEAR],
  ];
}

test('the duration is measured from the LAST land, not the first', () => {
  // 100s apart, refreshed at +30. First-land would read 100; last-land reads 68.
  const events = [];
  for (let i = 0; i < 5; i++) {
    events.push(...cycle(i * 600, { refreshAt: 30, endAt: 100 }));
  }
  const [found] = mine(events).candidates({ minObs: 3 });

  assert.ok(found, 'nothing paired up');
  assert.equal(found.land, LAND);
  assert.equal(found.wearOff, WEAR);
  assert.equal(found.durationMs, 68_000, 'measured from the refresh, not the first cast');
  assert.equal(found.samples, 5);
  assert.equal(found.name, 'Spirit of the Puma', 'the rank is not part of the name');
});

test('one observation is not a median, and is not reported as one', () => {
  const one = mine(cycle(0)).candidates({ minObs: 3 });
  assert.deepEqual(one, [], 'a single cycle is not a measurement');

  // ...and with the threshold lowered it is reported honestly, as one cycle.
  const events = [...cycle(0), ...cycle(600)];
  const [found] = mine(events).candidates({ minObs: 2 });
  assert.ok(found);
  assert.equal(found.samples, 2);
});

test('a land line with no wear-off is not reported at all', () => {
  // A heal lands and never "wears off". Guessing a duration for it would put a countdown
  // on screen for something that has no end to count to.
  const events = [];
  for (let i = 0; i < 6; i++) {
    events.push([i * 600, 'You begin casting Superior Healing VII.'], [i * 600 + 2, 'You feel much better.']);
  }
  assert.deepEqual(mine(events).candidates({ minObs: 3 }), []);
});

test('a line that fires without the effect being re-applied is not its wear-off', () => {
  // The alternation test. `A cloud passes overhead.` fires on its own schedule and
  // sometimes twice with no land between — which is precisely what says it is something
  // that happens NEAR the buff rather than the end of it.
  const events = [];
  for (let i = 0; i < 6; i++) {
    const base = i * 600;
    events.push([base, CAST], [base + 2, LAND], [base + 150, WEAR]);
    // Two impostor firings per cycle, so half of them are orphaned.
    events.push([base + 80, 'A cloud passes overhead.'], [base + 120, 'A cloud passes overhead.']);
  }
  const [found] = mine(events).candidates({ minObs: 3 });
  assert.ok(found);
  assert.equal(found.wearOff, WEAR, 'the impostor won');
});

test('combat prose is filtered by the rule table, not by a content guess', () => {
  // `You try to crush X, but miss!` has no digits, is short, mentions you, repeats
  // endlessly and alternates beautifully with anything. Only the rule table stops it.
  const events = [];
  for (let i = 0; i < 8; i++) {
    const base = i * 600;
    events.push([base, CAST]);
    events.push([base + 2, 'You try to crush a froglok shin knight, but miss!']);
    events.push([base + 150, 'You try to crush a reanimated hand, but miss!']);
  }
  assert.deepEqual(mine(events).candidates({ minObs: 3 }), []);
});

test('prose about somebody else is not one of MY timers', () => {
  // A deliberate scope limit: the log is full of other people's effects and other mobs'
  // procs, and every one of them is somebody's timer, just not one this panel is for.
  const events = [];
  for (let i = 0; i < 6; i++) {
    const base = i * 600;
    events.push([base, CAST], [base + 2, 'Bootscabz growls with the spirit of the puma.']);
    events.push([base + 150, 'The spirit departs from Bootscabz.']);
  }
  assert.deepEqual(mine(events).candidates({ minObs: 3 }), []);
});

test('ranks are folded into one row, and named as the caveat they are', () => {
  // The land line is rank-agnostic while the duration is not — 146s at rank V and 159s
  // at VI in one session of the live log. One trigger on the land line is honest to
  // within that difference, and the player has to be able to see the difference exists.
  const events = [];
  for (let i = 0; i < 6; i++) {
    const base = i * 600;
    const cast = i % 2 ? 'You begin casting Spirit of the Puma VI.' : CAST;
    events.push([base, cast], [base + 2, LAND], [base + 150, WEAR]);
  }
  const [found] = mine(events).candidates({ minObs: 3 });
  assert.ok(found);
  assert.equal(found.name, 'Spirit of the Puma');
  assert.deepEqual(
    found.ranks.map((r) => r.name).sort(),
    ['Spirit of the Puma V', 'Spirit of the Puma VI'],
  );
});

test('displayName strips the rank and nothing else', () => {
  assert.equal(displayName('Spirit of the Puma V'), 'Spirit of the Puma');
  assert.equal(displayName('Spirit of the Puma VIII'), 'Spirit of the Puma');
  assert.equal(displayName('Levitate 2'), 'Levitate');
  assert.equal(displayName('Levitate'), 'Levitate');
  // A name that is nothing BUT a rank keeps itself — better a strange row than no row.
  assert.equal(displayName('IV'), 'IV');
  assert.equal(displayName(''), '');
});

// ---------------------------------------------------------------------------- pack

test('a mined trigger restarts in place and ends on the measured wear-off line', () => {
  const candidate = {
    name: 'Spirit of the Puma',
    land: LAND,
    wearOff: WEAR,
    durationMs: 146_000,
    spreadMs: 4000,
    cv: 0.03,
    samples: 9,
    ranks: [{ name: 'Spirit of the Puma V', count: 9 }],
    loose: false,
  };
  const trigger = buffTrigger(candidate, { id: 't1' });

  // A recast refreshes, so a second land has to reset THIS row rather than open another
  // beside it — which is also what the panel's never-move rule requires.
  assert.equal(trigger.timer.restart, 'restart');
  assert.equal(trigger.timer.kind, 'countdown', 'a repeating timer would re-arm forever');
  assert.equal(trigger.timer.durationMs, 146_000);
  assert.equal(trigger.warn, null, 'a countdown does not also need a banner');

  // The wear-off is an early-ender, so a buff dispelled or lost to a zone takes its row
  // with it instead of counting down to a number that stopped meaning anything.
  assert.equal(trigger.timer.earlyEnders.length, 1);
  assert.equal(trigger.timer.earlyEnders[0].pattern, linePattern(WEAR));

  // The pattern is the exact line, escaped and anchored — it names nobody and varies in
  // nothing, which is exactly why it is a reliable clock.
  assert.ok(new RegExp(trigger.pattern).test(LAND));
  assert.ok(!new RegExp(trigger.pattern).test(`X ${LAND}`), 'anchored at the front');

  // The derivation travels inside the pack, where a player can open and read it.
  assert.match(trigger.comments, /146s .*9 cycles of your own log/);
  assert.match(trigger.comments, /You begin to snarl/);
});

test('a mined pack is never marked shipped', () => {
  // It was made from the player's log, on their machine, and has no upstream in any
  // build. Marking it shipped would invite a later version to replace their measurements
  // with ours.
  const pack = normalize(packFromBuffs([], { id: 'my-timers', name: 'My timers' }));
  assert.equal(pack.shipped, false);
  assert.equal(pack.origin, 'native');
  assert.deepEqual(pack.groups, [], 'one caster — you — so a group per row is a switch beside a switch');
});

