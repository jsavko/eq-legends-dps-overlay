import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker, IDLE_MS, SESSION_VERSION } from '../src/session/session.js';

const T0 = new Date(2026, 6, 31, 18, 0, 0).getTime();

/** Stamp a body at `T0 + secs`, in EQ's own header format. */
function at(secs, body) {
  const d = new Date(T0 + secs * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  const dom = String(d.getDate()).padStart(2, ' ');
  return `[${days[d.getDay()]} ${months[d.getMonth()]} ${dom} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}] ${body}`;
}

/** A tracker that counts every group member's kills, so grouped play is not undercounted. */
function tracker(options = {}) {
  return new SessionTracker({
    character: 'Rhale',
    server: 'oggok',
    isOurs: (name) => ['Rhale', 'Rhain', 'Emalina'].includes(name),
    ...options,
  });
}

/** Feed bodies with no combat parser present — nothing here is speech. */
function feed(t, lines) {
  for (const [secs, body] of lines) t.feed(at(secs, body), null);
  return t;
}

// -------------------------------------------------------------------------- lifetime

test('a session opens on the first tracked event, not before', () => {
  const t = tracker();
  assert.equal(t.current, null);
  t.feed(at(0, 'Zaphod grins at you.'), null);
  assert.equal(t.current, null, 'an untracked line must not open a session');
  t.feed(at(5, 'You have slain a froglok shin knight!'), null);
  assert.ok(t.current);
  assert.equal(t.current.startTs, T0 + 5000);
});

test('60 minutes of silence closes the session, dated to the last real event', () => {
  const closed = [];
  const t = tracker({ onSessionEnd: (r) => closed.push(r) });
  feed(t, [
    [0, 'You have slain a froglok shin knight!'],
    [600, 'You have slain a shin ghoul knight!'],
  ]);

  // Just under the boundary: still the same sitting.
  t.tick(T0 + 600_000 + IDLE_MS - 1000);
  assert.equal(closed.length, 0);
  assert.ok(t.current);

  t.tick(T0 + 600_000 + IDLE_MS);
  assert.equal(closed.length, 1);
  assert.equal(t.current, null);

  const rec = closed[0];
  assert.equal(rec.closeReason, 'idle');
  // The night ended when the killing stopped, not an hour later when we noticed.
  assert.equal(rec.endTs, T0 + 600_000);
  assert.equal(rec.durationMs, 600_000);
});

test('a line arriving after the timeout starts a fresh session, not a resumed one', () => {
  const closed = [];
  const t = tracker({ onSessionEnd: (r) => closed.push(r) });
  feed(t, [[0, 'You have slain a froglok shin knight!']]);
  const later = IDLE_MS / 1000 + 3600;
  feed(t, [[later, 'You have slain a shin ghoul knight!']]);

  assert.equal(closed.length, 1);
  assert.equal(closed[0].kills.total, 1);
  assert.equal(t.current.startTs, T0 + later * 1000);
  assert.equal(t.current.killsOurs, 1);
});

test('zoning does not close a session; a character change does', () => {
  const closed = [];
  const t = tracker({ onSessionEnd: (r) => closed.push(r) });
  feed(t, [
    [0, 'You have slain a froglok shin knight!'],
    [60, 'You have entered The Northern Desert of Ro.'],
    [120, 'You have slain a sand giant!'],
  ]);
  assert.equal(closed.length, 0, 'walking to the next camp is the same night');
  assert.equal(t.current.killsOurs, 2);

  t.setCharacter('Rhain', 'oggok');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closeReason, 'character');
  assert.equal(t.current, null);
});

test('a manual close writes the night and the next kill starts a clean one', () => {
  const closed = [];
  const t = tracker({ onSessionEnd: (r) => closed.push(r) });
  feed(t, [
    [0, 'You have slain a froglok shin knight!'],
    [60, 'You have slain a shin ghoul knight!'],
  ]);

  const rec = t.close('manual');
  assert.equal(rec.closeReason, 'manual', 'the grind that ended is kept, not discarded');
  assert.equal(rec.kills.total, 2);
  assert.equal(rec.endTs, T0 + 60_000, 'dated to the last event, not to the keypress');
  assert.equal(closed.length, 1);
  assert.equal(t.current, null);

  // The floor moved to the closed session's last event, so the new camp counts only what
  // happens after it — the same guard that stops the tailer's 64 KB backfill double-counting.
  feed(t, [[120, 'You have slain a sand giant!']]);
  assert.ok(t.current);
  assert.equal(t.current.startTs, T0 + 120_000);
  assert.equal(t.current.killsOurs, 1, 'the previous grind is not carried into this one');
});

test('a manual close with nothing in flight writes nothing and does not throw', () => {
  const closed = [];
  const t = tracker({ onSessionEnd: (r) => closed.push(r) });
  feed(t, [[0, 'You have slain a froglok shin knight!']]);

  assert.ok(t.close('manual'));
  // Pressing the hotkey twice is the ordinary case — the second press has nothing to save,
  // and must say so by returning null rather than writing an empty night.
  assert.equal(t.close('manual'), null);
  assert.equal(closed.length, 1);
});

test('a session of nothing but zone lines is never written', () => {
  const closed = [];
  const t = tracker({ onSessionEnd: (r) => closed.push(r) });
  feed(t, [
    [0, 'You have entered Befallen.'],
    [60, 'You have entered Commonlands.'],
  ]);
  assert.ok(t.current, 'it still opens — we just do not keep it');
  assert.equal(t.close('manual'), null);
  assert.equal(closed.length, 0);
});

// ----------------------------------------------------------------------- aggregation

test('kills fold pets into owners, credit the group, and quarantine strangers', () => {
  const t = tracker();
  feed(t, [
    [0, 'You have slain a froglok shin knight!'],
    [10, 'A froglok shin knight has been slain by Rhale`s warder!'],
    [20, 'A froglok shin knight has been slain by Rhain!'],
    [30, 'A shin ghoul knight has been slain by Randobob!'],
  ]);
  const rec = t.close('manual');

  assert.equal(rec.kills.total, 3, "a stranger's kill is not ours");
  assert.equal(rec.kills.mine, 2, 'you plus your warder');
  assert.equal(rec.kills.others, 1);
  assert.deepEqual(rec.kills.byCreature, [{ name: 'froglok shin knight', count: 3 }]);
  assert.deepEqual(rec.kills.byKiller, [
    { name: 'Rhale', count: 2 },
    { name: 'Rhain', count: 1 },
  ]);
});

test('without a roster the tracker credits only you — it does not guess', () => {
  const t = new SessionTracker({ character: 'Rhale' });
  feed(t, [
    [0, 'You have slain a froglok shin knight!'],
    [10, 'A froglok shin knight has been slain by Rhain!'],
  ]);
  const rec = t.close('manual');
  assert.equal(rec.kills.total, 1);
  assert.equal(rec.kills.others, 1);
});

test('coin accumulates by source, purchases are spend, and the net is honest', () => {
  const t = tracker();
  feed(t, [
    [0, 'You receive 3 gold, 6 silver and 7 copper from the corpse.'],
    [10, 'You receive 8 copper from the corpse.'],
    [20, 'You receive 7 gold 2 silver from Wanderer Rakshaazi for the Cyclops Toes(s).'],
    [30, 'You purchased 1 Spell: Wrath from Zealot Zorshais for  6 platinum 3 gold 9 copper.'],
  ]);
  const rec = t.close('manual');

  assert.equal(rec.coin.earned.copperTotal, 367 + 8 + 720);
  assert.equal(rec.coin.spent.copperTotal, 6309);
  assert.equal(rec.coin.netCopper, 367 + 8 + 720 - 6309);
  assert.deepEqual(
    rec.coin.bySource.map((s) => [s.source, s.copperTotal]),
    [['sale', 720], ['corpse', 375]],
  );
  assert.equal(rec.coin.purchases.length, 1);
  assert.equal(rec.coin.purchases[0].item, 'Spell: Wrath');
});

test('loot counts every kind and truncates nothing', () => {
  const t = tracker();
  const items = Array.from({ length: 26 }, (_, i) => `Item Number ${i}`);
  feed(t, items.flatMap((item, i) => [
    [i, `--You have looted a ${item} from a shin ghoul knight's corpse.--`],
  ]));
  feed(t, [[100, "--You have looted a Item Number 0 from a shin ghoul knight's corpse.--"]]);
  const rec = t.close('manual');

  assert.equal(rec.loot.total, 27);
  assert.equal(rec.loot.items.length, 26, 'every kind, no top-N slice');
  assert.deepEqual(rec.loot.items[0], { name: 'Item Number 0', count: 2 });
});

test('faction sums deltas and records a cap as a flag, never as a zero', () => {
  const t = tracker();
  feed(t, [
    [0, 'Your faction standing with Frogloks of Guk has been adjusted by -5.'],
    [10, 'Your faction standing with Frogloks of Guk has been adjusted by -5.'],
    [20, 'Your faction standing with Undead Frogloks of Guk could not possibly get any worse.'],
    [30, 'Your faction standing with Emerald Warriors has been adjusted by 12.'],
  ]);
  const rec = t.close('manual');

  const guk = rec.faction.find((f) => f.name === 'Frogloks of Guk');
  assert.deepEqual({ delta: guk.delta, hits: guk.hits, cappedAt: guk.cappedAt },
    { delta: -10, hits: 2, cappedAt: null });

  const undead = rec.faction.find((f) => f.name === 'Undead Frogloks of Guk');
  assert.equal(undead.delta, 0);
  assert.equal(undead.cappedAt, 'worse', 'capped is not the same fact as unchanged');
});

test('a skill reports first-seen to last-seen, never a sum of the printed values', () => {
  const t = tracker();
  feed(t, [
    [0, 'You have become better at Athletics! (135)'],
    [10, 'You have become better at Athletics! (136)'],
    [20, 'You have become better at Athletics! (137)'],
    [30, 'You have fashioned the items together to create something new: Metal Bits.'],
    [40, 'You have fashioned the items together to create something new: Metal Bits.'],
  ]);
  const rec = t.close('manual');

  assert.deepEqual(rec.skills.ups, [{ skill: 'Athletics', from: 135, to: 137, ups: 3 }]);
  assert.deepEqual(rec.skills.tradeskills, [{ name: 'Metal Bits', count: 2 }]);
});

test('ability points track both halves of the ledger', () => {
  const t = tracker();
  feed(t, [
    [0, 'You have gained an ability point!  You now have 1 ability point.'],
    [10, 'You have gained an ability point!  You now have 2 ability points.'],
    [20, 'You have gained the ability "Combat Fury" at a cost of 1 ability points.'],
    [30, 'You have improved Unbound Nature 2 at a cost of 0 ability points.'],
  ]);
  const rec = t.close('manual');

  assert.equal(rec.aa.earned, 2);
  assert.equal(rec.aa.spent, 1);
  assert.equal(rec.aa.unspent, 2, "the game's own running total, not one we counted");
  assert.deepEqual(rec.aa.abilities, [
    { name: 'Combat Fury', cost: 1, improved: false },
    { name: 'Unbound Nature 2', cost: 0, improved: true },
  ]);
});

test('zones record visits in order with real durations, the last one open-ended', () => {
  const t = tracker();
  feed(t, [
    [0, 'You have slain a froglok shin knight!'],
    [60, 'You have entered Befallen.'],
    [660, 'You have entered Commonlands.'],
    [960, 'You have slain a sand giant!'],
  ]);
  const rec = t.close('manual');

  assert.deepEqual(rec.zones.map((z) => [z.zone, z.ms]), [
    ['Befallen', 600_000],
    ['Commonlands', 300_000],
  ]);
});

test('a repeated zone line for where we already are does not start a second visit', () => {
  const t = tracker();
  feed(t, [
    [0, 'You have slain a froglok shin knight!'],
    [60, 'You have entered Befallen.'],
    [120, 'You have entered Befallen.'],
  ]);
  assert.equal(t.close('manual').zones.length, 1);
});

// ------------------------------------------------------------ the experience ledger

test('experience is a per-level ledger and never a session-wide total', () => {
  const t = tracker();
  feed(t, [
    [0, 'You gain experience! (10%)'],
    [100, 'You gain party experience! (5%)'],
    [200, 'You have gained a level! Welcome to level 28!'],
    [300, 'You gain experience! (12%)'],
  ]);
  const rec = t.close('manual');

  assert.equal(rec.xp.segments.length, 2);
  assert.equal(rec.xp.levelsGained, 1);

  const [first, second] = rec.xp.segments;
  assert.equal(first.percent, 15, 'each segment sums only within its own level');
  assert.equal(second.percent, 12);

  // The load-bearing assertion: `xp` has exactly these four keys and no fifth. A
  // session-wide percentage added here would be meaningless — 12% at level 28 and 12% at
  // level 51 are different amounts of experience — so this fails the day one appears.
  assert.deepEqual(
    Object.keys(rec.xp).sort(),
    ['levelUps', 'levelsGained', 'levelsLost', 'segments'],
  );
});

test('the level we were standing in is learned by subtraction when the boundary is crossed', () => {
  const t = tracker();
  feed(t, [
    [0, 'You gain experience! (10%)'],
    [200, 'You have gained a level! Welcome to level 28!'],
  ]);
  const rec = t.close('manual');
  assert.equal(rec.xp.segments[0].level, 27, 'gaining 28 says the last segment was 27');
  assert.equal(rec.xp.segments[1].level, 28);
});

test('time-to-level is offered only from an anchored segment', () => {
  const t = tracker();
  feed(t, [
    // Started mid-level: we know what was gained, not how far in we began.
    [0, 'You gain experience! (10%)'],
    [1800, 'You gain experience! (10%)'],
    [1800, 'You have gained a level! Welcome to level 28!'],
    [3600, 'You gain experience! (25%)'],
  ]);
  const rec = t.close('manual');
  const [before, after] = rec.xp.segments;

  assert.equal(before.anchored, false);
  assert.equal(before.timeToLevelMs, null, 'no honest answer exists for a mid-level start');
  // 20% in half an hour. The rate is real and useful even when the destination is not.
  assert.equal(before.percentPerHour, 40);

  assert.equal(after.anchored, true);
  // 25% in half an hour, 75% of the level left: an hour and a half.
  assert.equal(after.percentPerHour, 50);
  assert.equal(after.timeToLevelMs, 1.5 * 3_600_000);
});

test('a level already reached offers no countdown to itself', () => {
  // A segment that ended did so BY levelling. Against the live log the old code produced
  // "0:01 to 12" on a level the player had finished half an hour earlier — a rounding
  // artefact wearing the clothes of a prediction.
  const t = tracker();
  feed(t, [
    [0, 'You have gained a level! Welcome to level 11!'],
    [900, 'You gain experience! (99.7%)'],
    [1000, 'You have gained a level! Welcome to level 12!'],
    [1500, 'You gain experience! (10%)'],
  ]);
  const rec = t.close('manual');

  const closed = rec.xp.segments.find((s) => s.level === 11);
  assert.equal(closed.anchored, true, 'it was anchored — that is not what disqualifies it');
  assert.equal(closed.endTs !== null, true);
  assert.equal(closed.timeToLevelMs, null, 'level 11 is over; there is nothing to count down to');

  const open = rec.xp.segments[rec.xp.segments.length - 1];
  assert.equal(open.endTs, null);
  assert.ok(open.timeToLevelMs > 0, 'the level in progress still gets one');
});

test('a de-level opens an unanchored segment — the log does not say where it drops you', () => {
  const t = tracker();
  feed(t, [
    [0, 'You gain experience! (10%)'],
    [100, 'You have gained a level! Welcome to level 28!'],
    [200, 'You LOST a level! You are now level 27!'],
    [300, 'You gain experience! (4%)'],
  ]);
  const rec = t.close('manual');

  assert.equal(rec.xp.levelsGained, 1);
  assert.equal(rec.xp.levelsLost, 1);
  const last = rec.xp.segments[rec.xp.segments.length - 1];
  assert.equal(last.level, 27);
  assert.equal(last.anchored, false);
  assert.equal(last.timeToLevelMs, null);
});

// ----------------------------------------------------------------------------- rates

test('per-hour rates divide by the real elapsed time', () => {
  const t = tracker();
  feed(t, [
    [0, 'You have slain a froglok shin knight!'],
    [1800, 'You have slain a froglok shin knight!'],
    [1800, 'You receive 1 platinum from the corpse.'],
    [3600, 'You have slain a froglok shin knight!'],
  ]);
  const rec = t.close('manual');

  assert.equal(rec.durationMs, 3_600_000);
  assert.equal(rec.kills.perHour, 3);
  assert.equal(rec.coin.copperPerHour, 1000);
});

test('a zero-length session reports no rate rather than infinity', () => {
  const t = tracker();
  feed(t, [[0, 'You have slain a froglok shin knight!']]);
  const rec = t.close('manual');
  assert.equal(rec.durationMs, 0);
  assert.equal(rec.kills.perHour, null);
});

// -------------------------------------------------------------------------- the gate

test('a disabled category never accumulates', () => {
  const t = tracker({ categories: { coin: false } });
  feed(t, [
    [0, 'You have slain a froglok shin knight!'],
    [10, 'You receive 3 gold, 6 silver and 7 copper from the corpse.'],
  ]);
  const rec = t.close('manual');
  assert.equal(rec.kills.total, 1);
  assert.equal(rec.coin.earned.copperTotal, 0);
  assert.deepEqual(rec.coin.bySource, []);
});

test('an absent category flag reads as on, so a partial config is not silence', () => {
  const t = tracker({ categories: { coin: true } });
  feed(t, [[0, 'You have slain a froglok shin knight!']]);
  assert.equal(t.close('manual').kills.total, 1);
});

// ------------------------------------------------------------ summary and checkpoint

test('the snapshot summary carries what the meter line needs and nothing heavy', () => {
  const t = tracker();
  feed(t, [
    [0, 'You have slain a froglok shin knight!'],
    [10, 'You receive 1 platinum from the corpse.'],
    [20, "--You have looted a Mote of Lesser Potential from a shin ghoul knight's corpse.--"],
    [30, 'You have gained an ability point!  You now have 1 ability point.'],
    [40, 'You gain experience! (8%)'],
  ]);
  const s = t.summary(T0 + 3_600_000);

  assert.equal(s.kills, 1);
  assert.equal(s.loot, 1);
  assert.equal(s.aa, 1);
  assert.equal(s.copperEarned, 1000);
  assert.equal(s.xpPercent, 8);
  assert.equal(s.elapsedMs, 3_600_000);
  assert.equal(s.killsPerHour, 1);
  // Nothing list-shaped crosses the IPC boundary four times a second.
  for (const v of Object.values(s)) assert.equal(Array.isArray(v), false);
});

test('summary is null with no session open', () => {
  assert.equal(tracker().summary(T0), null);
});

test('the checkpoint is a full record marked open', () => {
  const t = tracker();
  feed(t, [[0, 'You have slain a froglok shin knight!']]);
  const cp = t.checkpoint(T0 + 60_000);

  assert.equal(cp.v, SESSION_VERSION);
  assert.equal(cp.closeReason, 'open');
  assert.equal(cp.id, String(T0));
  assert.equal(cp.character, 'Rhale');
  assert.equal(cp.durationMs, 60_000);
  assert.equal(cp.kills.total, 1);
  assert.ok(t.current, 'checkpointing must not close the session it is saving');
});

test('a store that throws does not take the tracker down', () => {
  const t = tracker({ onSessionEnd: () => { throw new Error('disk full'); } });
  feed(t, [[0, 'You have slain a froglok shin knight!']]);
  assert.doesNotThrow(() => t.close('idle'));
  assert.equal(t.current, null);
});
