/**
 * The player's own timer boxes: the model, and the runtime that runs it.
 *
 * This is deliberately not built on `src/triggers/`. That subsystem runs GINA packs —
 * a stranger's regex, groups, early enders, provenance, export fidelity — and every bit
 * of it is in the way of "remind me to recast Spirit of the Puma". A timer here is four
 * things: a name, the log text that starts it, how long it runs, and which box it draws
 * in. These tests pin that simplicity as much as they pin the behaviour.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  normalize, defaultModel, addCategory, updateCategory, removeCategory,
  addTimer, updateTimer, removeTimer, validateTimer, compile, color, boxLook, timerPushDecision,
  BOSS_CATEGORY, PALETTE, MAX_DURATION_MS, LOOK,
} from '../src/timers/model.js';
import { TimersRuntime, SPENT_LINGER_MS } from '../src/timers/runtime.js';
import { TimersStore } from '../src/main/timers-store.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eql-timers-'));

const PUMA = {
  categoryId: 'c1',
  name: 'Spirit of the Puma',
  startsOn: 'You begin to snarl as your features become feline.',
  match: 'contains',
  durationSec: 146,
  color: '#2f8f7a',
  endsOn: 'The spirit of the puma departs.',
};

// ---------------------------------------------------------------------- model

test('a fresh install has the boss box and one of the player\'s own', () => {
  // The boss box, because it IS a box now rather than a separate panel with its own
  // separate everything; and one of theirs, because an empty manager is a screen that
  // says nothing about what it is for.
  const model = defaultModel();
  assert.deepEqual(model.categories.map((c) => c.id), [BOSS_CATEGORY, 'c1']);
  assert.equal(model.categories[0].builtin, true);
  assert.equal(model.categories[1].builtin, false);
  assert.deepEqual(model.timers, []);
});

test('a half-written document degrades instead of producing unusable boxes', () => {
  // A category with no id is a window that could never be closed, dragged or switched,
  // so it is dropped outright; everything else gets a fallback rather than a throw,
  // because this file is one a player can hand-edit.
  const model = normalize({
    categories: [{ id: 'c1' }, { name: 'no id' }, null, 'nope', { id: 'c2', name: 'Buffs', enabled: false }],
    timers: [{ id: 't1', categoryId: 'gone', name: 'x', startsOn: 'y' }, null, { name: 'no id' }],
  });
  assert.deepEqual(model.categories.map((c) => c.id), ['c1', 'c2']);
  assert.equal(model.categories[0].name, 'Timers 1');
  assert.equal(model.categories[1].enabled, false);
  assert.equal(model.timers.length, 1);
  // A timer pointing at a box that is gone lands in the first one rather than vanishing.
  assert.equal(model.timers[0].categoryId, 'c1');
  assert.equal(model.timers[0].durationMs, 60_000, 'a missing duration gets a usable one');
});

test('every bar gets a colour of its own, and junk never reaches the stylesheet', () => {
  // Colour belongs to the TIMER, not the box: the boxes are told apart by where they are
  // and what they are called, and what you need mid-pull is which BAR is which.
  const model = normalize({
    categories: [{ id: 'c1', name: 'Buffs' }],
    timers: [
      { id: 't1', categoryId: 'c1', name: 'a', startsOn: 'a' },
      { id: 't2', categoryId: 'c1', name: 'b', startsOn: 'b', color: '#ABCDEF' },
      { id: 't3', categoryId: 'c1', name: 'c', startsOn: 'c', color: 'red; background: url(x)' },
    ],
  });
  assert.equal(model.timers[0].color, PALETTE[0], 'defaulted, never left blank');
  assert.equal(model.timers[1].color, '#abcdef');
  assert.ok(PALETTE.includes(model.timers[2].color), 'an injection attempt falls back');

  // This value is interpolated into a CSS custom property, so the guard is a guard.
  for (const junk of ['red', '#fff', '#12345g', 'rgb(1,2,3)', 42, null, {}]) {
    assert.equal(color(junk), null, `${JSON.stringify(junk)} is not a colour`);
  }
});

test('a category cannot be deleted while it holds timers, and the boss box never can', () => {
  // A box with timers in it can always be switched OFF, which takes it off the screen and
  // moves nothing. Deleting it would have to send its timers somewhere, and silently
  // rehoming somebody's work is the failure this is guarding against.
  let model = defaultModel();
  model = addTimer(model, PUMA).model;

  const held = removeCategory(model, 'c1');
  assert.equal(held.ok, false);
  assert.match(held.errors[0], /1 timer draws here/);

  const builtin = removeCategory(model, BOSS_CATEGORY);
  assert.equal(builtin.ok, false);
  assert.match(builtin.errors[0], /built in/);

  // Emptied, it goes.
  const emptied = removeTimer(model, model.timers[0].id).model;
  assert.equal(removeCategory(emptied, 'c1').ok, true);
});

test('a box named the same as one that exists IS that box', () => {
  // Two identically-named boxes differ only by which one moves when you drag it, which
  // is not a difference anybody can see.
  const model = defaultModel();
  const first = addCategory(model, 'Cooldowns');
  const again = addCategory(first.model, '  cooldowns  ');
  assert.equal(again.id, first.id);
  assert.equal(again.model.categories.length, first.model.categories.length);

  assert.equal(addCategory(model, '   ').ok, false, 'and a nameless box is refused');
});

test('renaming a box leaves its position and its timers alone', () => {
  // Rebuilding on a rename would drop the window back to its default corner — the player
  // would have paid for a typo with a window they had placed.
  let model = defaultModel();
  model = updateCategory(model, 'c1', { x: 100, y: 200 }).model;
  model = addTimer(model, PUMA).model;
  const renamed = updateCategory(model, 'c1', { name: 'Buffs' }).model;

  const box = renamed.categories.find((c) => c.id === 'c1');
  assert.equal(box.name, 'Buffs');
  assert.equal(box.x, 100);
  assert.equal(box.y, 200);
  assert.equal(renamed.timers[0].categoryId, 'c1');
});

test('a box has a size of its own, and it starts as the chrome that shipped', () => {
  // 296 x 30 over 13px text is what the old fixed em-based chrome computed to, so a
  // player who never touches these controls sees the panel they already know rather
  // than something close to it.
  for (const box of defaultModel().categories) {
    assert.equal(box.width, 296);
    assert.equal(box.rowHeight, 30);
    assert.equal(box.fontSize, 13);
  }

  // Including the built-in one: its ROWS come from the trigger packs, but its shape is
  // the player's exactly as its name and its position already are.
  const boss = defaultModel().categories.find((c) => c.id === BOSS_CATEGORY);
  assert.equal(boss.builtin, true);
  assert.equal(boss.width, 296);
});

test('a hand-edited size is clamped rather than refused', () => {
  // `timers.json` is a file a player can open, and a typo in it should cost them the
  // value they typed, never the box.
  const model = normalize({
    categories: [
      { id: 'c1', width: 5000, rowHeight: 2, fontSize: 'huge' },
      { id: 'c2', width: 12, rowHeight: 44.6, fontSize: 18 },
    ],
    timers: [],
  });
  const [a, b] = model.categories;
  assert.equal(a.width, LOOK.width.max);
  assert.equal(a.rowHeight, LOOK.rowHeight.min);
  assert.equal(a.fontSize, LOOK.fontSize.def, 'junk falls back to the default');
  assert.equal(b.width, LOOK.width.min);
  assert.equal(b.rowHeight, 45, 'and a fraction is rounded, not dropped');
  assert.equal(b.fontSize, 18);
});

test('resizing a box leaves everything else about it alone, and is clamped', () => {
  // The size patch comes from a slider and travels the same channel as a rename, so it
  // must not be able to move a box the player placed — or ask for a width the model
  // would refuse and silently do nothing.
  let model = defaultModel();
  model = updateCategory(model, 'c1', { x: 100, y: 200, name: 'Buffs' }).model;
  model = addTimer(model, PUMA).model;
  const resized = updateCategory(model, 'c1', { width: 420, rowHeight: 22, fontSize: 16 }).model;

  const box = resized.categories.find((c) => c.id === 'c1');
  assert.equal(box.width, 420);
  assert.equal(box.rowHeight, 22);
  assert.equal(box.fontSize, 16);
  assert.equal(box.name, 'Buffs');
  assert.equal(box.x, 100);
  assert.equal(box.y, 200);
  assert.equal(resized.timers.length, 1);

  const silly = updateCategory(resized, 'c1', { width: 9000 }).model;
  assert.equal(silly.categories.find((c) => c.id === 'c1').width, LOOK.width.max);
});

test('what a box draws at is what it stores, times the global text scale', () => {
  // Multiplication rather than replacement: `scale` moves every HUD window together and
  // always has, so a per-box width rides on it rather than arguing with it.
  assert.deepEqual(boxLook({ width: 296, rowHeight: 30, fontSize: 13 }, 1),
    { width: 296, rowHeight: 30, fontSize: 13 });
  assert.deepEqual(boxLook({ width: 400, rowHeight: 22, fontSize: 15 }, 1.5),
    { width: 600, rowHeight: 33, fontSize: 22.5 });

  // A box with nothing stored, and a scale that is missing or nonsense, both have to
  // produce the shipped chrome rather than a collapsed window.
  assert.deepEqual(boxLook({}), { width: 296, rowHeight: 30, fontSize: 13 });
  assert.deepEqual(boxLook(null, 0), { width: 296, rowHeight: 30, fontSize: 13 });
  assert.deepEqual(boxLook(undefined, 'big'), { width: 296, rowHeight: 30, fontSize: 13 });
});

test('a timer says every way it is wrong at once', () => {
  // Reporting one problem, being fixed, then reporting the next is how a four-field form
  // becomes four round trips.
  const errors = validateTimer({ name: '', startsOn: '', durationMs: 0 });
  assert.equal(errors.length, 3);
  assert.match(errors.join(' '), /name/);
  assert.match(errors.join(' '), /log line/);
  assert.match(errors.join(' '), /zero/);

  assert.deepEqual(validateTimer({ name: 'x', startsOn: 'y', durationMs: 1000 }), []);
  assert.match(validateTimer({ name: 'x', startsOn: '(', match: 'regex', durationMs: 1000 })[0], /regex/);
  assert.match(validateTimer({ name: 'x', startsOn: 'y', durationMs: MAX_DURATION_MS + 1 })[0], /longer than a day/);
});

test('"contains" ignores the timestamp and anything either side', () => {
  // This is the default because it is what a player means when they paste a line out of
  // their log: they do not want to think about anchors.
  const timer = { startsOn: 'You begin to snarl', match: 'contains' };
  assert.equal(compile(timer).test('You begin to snarl as your features become feline.'), true);
  assert.equal(compile(timer).test('YOU BEGIN TO SNARL'), true, 'and case does not matter');
  assert.equal(compile(timer).test('Somebody else begins to snarl'), false);

  assert.equal(compile({ startsOn: 'a b', match: 'exact' }).test('a b'), true);
  assert.equal(compile({ startsOn: 'a b', match: 'exact' }).test('x a b'), false);
  assert.equal(compile({ startsOn: '^You (?:begin|start)', match: 'regex' }).test('You begin to snarl'), true);
  assert.equal(compile({ startsOn: '(', match: 'regex' }), null, 'a broken regex compiles to nothing');
});

// -------------------------------------------------------------------- runtime

const runtimeWith = (model) => {
  const rt = new TimersRuntime();
  rt.setModel(model);
  return rt;
};

test('a timer arms on its line and ends on its wear-off line', () => {
  const model = addTimer(defaultModel(), PUMA).model;
  const rt = runtimeWith(model);

  rt.feed('You begin to snarl as your features become feline.', 1000);
  const [row] = rt.rows(2000);
  assert.equal(row.name, 'Spirit of the Puma');
  assert.equal(row.color, '#2f8f7a');
  assert.equal(row.remainingMs, 145_000);
  assert.equal(row.spent, false);

  rt.feed('The spirit of the puma departs.', 60_000);
  assert.equal(rt.rows(60_100)[0].spent, true, 'ended early, not run down');
});

test('a recast restarts the row IN PLACE and never opens a second one', () => {
  // Recasting refreshes, and the player recasts constantly. A second row for the same
  // timer would push everything below it down — the never-move rule, which this window
  // inherits from the boss panel because it was learned the hard way there.
  const model = addTimer(defaultModel(), PUMA).model;
  const rt = runtimeWith(model);

  rt.feed('You begin to snarl as your features become feline.', 1000);
  const first = rt.rows(2000)[0];
  rt.feed('You begin to snarl as your features become feline.', 50_000);
  const rows = rt.rows(51_000);

  assert.equal(rows.length, 1, 'a refresh is not a second row');
  assert.equal(rows[0].since, first.since, 'and the row does not move');
  assert.equal(rows[0].remainingMs, 145_000, 'the countdown restarted');
});

test('rows are held in first-armed order, never re-sorted by what is due next', () => {
  // Sorting by remaining time means the row you learned to glance at is somewhere else
  // every second. This is the single rule the timer boxes exist to hold.
  let model = defaultModel();
  model = addTimer(model, { ...PUMA, name: 'Long', startsOn: 'long', durationSec: 600 }).model;
  model = addTimer(model, { ...PUMA, name: 'Short', startsOn: 'short', durationSec: 10 }).model;
  const rt = runtimeWith(model);

  rt.feed('long', 1000);
  rt.feed('short', 2000);
  assert.deepEqual(rt.rows(3000).map((r) => r.name), ['Long', 'Short'],
    'the short one is due first and still draws second');
});

test('a spent row lingers, then leaves', () => {
  // A row that vanishes the instant it reaches zero reads as a glitch rather than as a
  // timer finishing.
  const model = addTimer(defaultModel(), { ...PUMA, durationSec: 10 }).model;
  const rt = runtimeWith(model);
  rt.feed('You begin to snarl as your features become feline.', 1000);

  assert.equal(rt.rows(11_500)[0].spent, true);
  rt.tick(11_000 + SPENT_LINGER_MS + 1);
  assert.deepEqual(rt.rows(99_999), [], 'and then it is gone');
});

test('a preview is a row that says it came from nowhere', () => {
  // It is on screen and it did not come from the log. The same rule that makes an
  // ambiguous number say "Unknown" rather than guessing a name onto it.
  const rt = runtimeWith(defaultModel());
  rt.preview({ categoryId: 'c1', name: 'Preview', durationMs: 45_000, color: '#c0603f', ts: 1000 });

  const [row] = rt.rows(2000);
  assert.equal(row.preview, true);
  assert.equal(row.color, '#c0603f');
  assert.equal(row.categoryId, 'c1');

  // Pressing it twice restarts the same row rather than stacking a second.
  rt.preview({ categoryId: 'c1', name: 'Preview', durationMs: 45_000, ts: 5000 });
  assert.equal(rt.rows(6000).length, 1);

  assert.equal(rt.clearPreviews(), 1);
  assert.deepEqual(rt.rows(7000), []);
});

test('a switched-off timer does not run', () => {
  const model = normalize({
    categories: [{ id: 'c1', name: 'Buffs' }],
    timers: [{ id: 't1', categoryId: 'c1', name: 'x', startsOn: 'snarl', durationMs: 1000, enabled: false }],
  });
  const rt = runtimeWith(model);
  assert.equal(rt.feed('snarl', 1000), 0);
  assert.deepEqual(rt.rows(1000), []);
});

test('editing a timer that is RUNNING changes the row on screen, in place', () => {
  // A slot is a snapshot taken when it armed, so an edit used to reach nothing that was
  // already running: you renamed a timer mid-pull and the row went on showing the old
  // name until it expired, which reads exactly like a save that did not stick.
  let model = defaultModel();
  model = addTimer(model, { ...PUMA, name: 'Puma', durationSec: 100 }).model;
  model = addTimer(model, {
    ...PUMA, name: 'Wolf', startsOn: 'You feel wolflike.', endsOn: null,
  }).model;
  const [puma, wolf] = model.timers;

  const runtime = new TimersRuntime();
  runtime.setModel(model);
  runtime.feed(PUMA.startsOn, 1000);
  runtime.feed('You feel wolflike.', 2000);

  const renamed = updateTimer(model, puma.id, {
    ...puma, name: 'Spirit of the Puma VI', durationSec: 200, color: '#c04f7a',
  }).model;
  runtime.setModel(renamed);

  const rows = runtime.rows(3000);
  assert.equal(rows[0].name, 'Spirit of the Puma VI');
  assert.equal(rows[0].color, '#c04f7a');
  // And it did NOT move: it armed first, so it stays first. Re-sorting the panel on an
  // edit would reintroduce the bug the whole window was built to fix.
  assert.equal(rows[1].name, 'Wolf');
  assert.equal(rows[0].id, puma.id);
  assert.equal(rows[1].id, wolf.id);

  // The duration rebases from when it armed rather than only applying to the next one —
  // somebody correcting 100s to 200s while the buff is up has just said what the
  // remaining time is.
  assert.equal(rows[0].durationMs, 200_000);
  assert.equal(rows[0].remainingMs, 198_000);
});

test('a running timer that is deleted or switched off takes its row down', () => {
  // The player's own act, not the panel re-sorting itself. A countdown for something
  // that no longer exists is the "nothing on screen you can explain" failure.
  let model = defaultModel();
  model = addTimer(model, PUMA).model;
  const puma = model.timers[0];

  const runtime = new TimersRuntime();
  runtime.setModel(model);
  runtime.feed(PUMA.startsOn, 1000);
  assert.equal(runtime.rows(2000).length, 1);

  runtime.setModel(updateTimer(model, puma.id, { ...puma, durationSec: 146, enabled: false }).model);
  assert.equal(runtime.rows(2000).length, 0, 'switched off means off the screen');

  runtime.setModel(model);
  runtime.feed(PUMA.startsOn, 3000);
  runtime.setModel(removeTimer(model, puma.id).model);
  assert.equal(runtime.rows(4000).length, 0, 'and a deleted timer leaves nothing behind');
});

test('a preview follows a rename, and the stand-ins answer to nothing', () => {
  // A box preview mocks the player's real timers, so it has to follow them — that is what
  // somebody looking at one is judging. The editor's draft row and the boss box's samples
  // mock no timer at all and must not be swept up as orphans by an unrelated edit.
  let model = defaultModel();
  model = addTimer(model, PUMA).model;
  const puma = model.timers[0];

  const runtime = new TimersRuntime();
  runtime.setModel(model);
  runtime.preview({ categoryId: 'c1', key: puma.id, timerId: puma.id, name: puma.name, durationMs: 146_000 });
  runtime.preview({ categoryId: 'boss', key: 's1', name: 'A boss cast', durationMs: 62_000 });
  runtime.preview({ categoryId: 'c1', key: 'draft', name: 'Preview', durationMs: 45_000 });

  runtime.setModel(updateTimer(model, puma.id, { ...puma, name: 'Puma VI', durationSec: 146 }).model);

  const byName = runtime.rows(1000).map((r) => r.name);
  assert.ok(byName.includes('Puma VI'), 'the mock of a real timer follows its rename');
  assert.ok(byName.includes('A boss cast'), 'the boss box samples are left alone');
  assert.ok(byName.includes('Preview'), 'the editor draft row is left alone');

  // Deleting the timer takes its mock with it, but still leaves the stand-ins.
  runtime.setModel(removeTimer(model, puma.id).model);
  const after = runtime.rows(1000).map((r) => r.name);
  assert.deepEqual(after.sort(), ['A boss cast', 'Preview']);
});

// ---------------------------------------------------------------------- store

test('the store round-trips, and a corrupt file does not stop the app starting', () => {
  const dir = tmpdir();
  const store = new TimersStore(dir);

  assert.deepEqual(store.load().categories.map((c) => c.id), [BOSS_CATEGORY, 'c1'],
    'a missing file is a fresh install');

  const model = addTimer(defaultModel(), PUMA).model;
  assert.equal(store.save(model).ok, true);
  assert.equal(store.load().timers[0].name, 'Spirit of the Puma');

  // A file the player has never seen must not be a reason the overlay will not start.
  // What it must NOT do is overwrite the damaged file on the way past — that is their
  // data, and they may want it back.
  const file = path.join(dir, 'timers.json');
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(store.load().categories.map((c) => c.id), [BOSS_CATEGORY, 'c1']);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', 'the bad file is left alone');
});

test('a document with no boxes at all is not a state to leave somebody in', () => {
  // It cannot draw anything and cannot be added to from the manager's own rail.
  const dir = tmpdir();
  const store = new TimersStore(dir);
  fs.writeFileSync(path.join(dir, 'timers.json'), JSON.stringify({ categories: [], timers: [] }));
  assert.ok(store.load().categories.length > 0);
});

// ---------------------------------------------------------------------------
// The push gate
// ---------------------------------------------------------------------------
//
// A box's rows are merged from TWO engines at the moment of sending, so the gate that
// decides whether to send has to ask both. It used to ask only the player's own runtime,
// which made every boss timer invisible until something unrelated happened to push —
// the "switch the box off and on again to get anything" bug.

test('a boss timer running with an idle personal runtime still pushes', () => {
  // The exact live shape: no personal timer armed, so the runtime is neither live nor
  // changed, while a pack's countdown is running and its rows move every tick.
  const d = timerPushDecision({
    timersLive: false, timersRevision: 7, lastTimersRevision: 7,
    triggersLive: true, triggersRevision: 3, lastTriggersRevision: 3,
  });
  assert.equal(d.push, true, 'a live boss countdown is a reason to push');
});

test('a boss timer that merely armed since the last push is a reason to push', () => {
  const d = timerPushDecision({
    timersLive: false, timersRevision: 7, lastTimersRevision: 7,
    triggersLive: false, triggersRevision: 4, lastTriggersRevision: 3,
  });
  assert.equal(d.push, true);
  assert.equal(d.triggersRevision, 4, 'and the caller is told what to store back');
});

test('the player\'s own timers are unchanged by the second half of the gate', () => {
  assert.equal(timerPushDecision({
    timersLive: true, timersRevision: 7, lastTimersRevision: 7,
    triggersLive: false, triggersRevision: 3, lastTriggersRevision: 3,
  }).push, true, 'a live personal timer still pushes');
  assert.equal(timerPushDecision({
    timersLive: false, timersRevision: 8, lastTimersRevision: 7,
    triggersLive: false, triggersRevision: 3, lastTriggersRevision: 3,
  }).push, true, 'so does one that changed');
});

test('nothing running and nothing changed is silence', () => {
  // The reason the gate exists at all: an idle box must not take four pushes a second
  // between fights.
  const d = timerPushDecision({
    timersLive: false, timersRevision: 7, lastTimersRevision: 7,
    triggersLive: false, triggersRevision: 3, lastTriggersRevision: 3,
  });
  assert.equal(d.push, false);
});

test('no trigger engine at all is not a reason to push forever', () => {
  // main passes -1 for both when `triggers` is null; the two must agree or a build with
  // no packs loaded would push every tick.
  assert.equal(timerPushDecision({
    timersLive: false, timersRevision: 7, lastTimersRevision: 7,
    triggersLive: false, triggersRevision: -1, lastTriggersRevision: -1,
  }).push, false);
});

test('each engine reports its own revision back, so neither swallows the other', () => {
  // The reason main keeps `lastBossTimerRevision` separate from `lastTriggerRevision`:
  // one push must not mark the other's change as already sent.
  const d = timerPushDecision({
    timersLive: false, timersRevision: 9, lastTimersRevision: 7,
    triggersLive: false, triggersRevision: 4, lastTriggersRevision: 3,
  });
  assert.deepEqual({ t: d.timersRevision, g: d.triggersRevision }, { t: 9, g: 4 });
});
