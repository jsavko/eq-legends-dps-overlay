/**
 * The shipped boss-timer pack.
 *
 * These are the tests the deleted learner could never have: a live estimator had no
 * pattern to compile, no sample line to check itself against, and no file to be replaced
 * or left alone. Everything the pack claims is now a thing that can be asserted in WSL.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { seedPack, installSeedPack, SEED_PACK_ID, SEED_SAMPLES } from '../src/triggers/seed-pack.js';
import { validate, compilePack, MAX_DURATION_MS } from '../src/triggers/pack.js';
import { TriggerStore } from '../src/main/triggers-store.js';
import { TriggerEngine } from '../src/triggers/engine.js';

function makeStore() {
  return new TriggerStore(fs.mkdtempSync(path.join(os.tmpdir(), 'seed-')));
}

test('the shipped pack is fit to enter the store', () => {
  const check = validate(seedPack());
  assert.deepEqual(check.errors, []);
  assert.equal(check.ok, true);
});

test('every trigger compiles', () => {
  // A pattern that will not compile sits in the list looking live and matches nothing
  // forever — the exact failure the dry-run exists to expose in a stranger's pack, and
  // one we must never ship ourselves.
  const { compiled, failed } = compilePack(seedPack(), 'Rhale');
  assert.deepEqual(failed, []);
  assert.equal(compiled.length, seedPack().triggers.length);
});

test('every duration is a real countdown and inside the ceiling', () => {
  for (const t of seedPack().triggers) {
    assert.ok(t.timer, `${t.name} has no timer`);
    assert.ok(t.timer.durationMs > 0, `${t.name} counts down from nothing`);
    assert.ok(t.timer.durationMs <= MAX_DURATION_MS, `${t.name} runs longer than a day`);
    // Shorter than this and the row expires before it can be read. The hand review
    // dropped several perfectly regular four-second chain-casts on exactly this ground.
    assert.ok(t.timer.durationMs >= 6000, `${t.name} is too short to be worth a row`);
  }
});

test('every pattern matches the real log line it was measured against', () => {
  // The anti-drift guard. Tightening an anchor or correcting a mob name is a one-character
  // edit that can silently take a trigger off the air, and the dry-run only catches it if
  // somebody thinks to run one.
  const pack = seedPack();
  for (const t of pack.triggers) {
    const sample = SEED_SAMPLES[t.id];
    assert.ok(sample, `${t.name} has no recorded sample line`);
    assert.match(sample, new RegExp(t.pattern), `${t.name} no longer matches its own sample`);
  }
  assert.equal(Object.keys(SEED_SAMPLES).length, pack.triggers.length);
});

test('every trigger ends early on its own caster dying', () => {
  // The CLAUDE.md invariant, now expressed in the pack rather than in a tracker: a
  // countdown for a corpse is not information. The caster is recoverable from the timer
  // label, which is `<caster> — <ability>`.
  for (const t of seedPack().triggers) {
    const [caster] = t.name.split(' — ');
    const enders = t.timer.earlyEnders;
    assert.equal(enders.length, 1, `${t.name} has no death ender`);
    const re = new RegExp(enders[0].pattern);
    assert.ok(re.test(`${caster} has been slain by Rhale!`), `${t.name}: third-person death`);
    assert.ok(re.test(`You have slain ${caster}!`), `${t.name}: our own kill line`);
    assert.ok(re.test(`${caster} died.`), `${t.name}: the plain form`);
    assert.equal(re.test('Rhale has been slain by a froglok shin knight!'), false,
      `${t.name}: somebody else's death must not end it`);
    // Compilable without a match, so it is live from pack load rather than from arm time.
    assert.equal(enders[0].needsMatch, false);
  }
});

test('a cast arms a row on the first sighting, and the death line takes it away', () => {
  // What the learner could not do: this arms on cast #1, where three agreeing gaps were
  // needed before anything appeared at all.
  const engine = new TriggerEngine();
  engine.setPacks([seedPack()]);

  const t0 = Date.parse('2026-08-08T12:00:00Z');
  engine.feedBody('Quag Maelstrom begins casting Mana Drain.', t0);
  const armed = engine.timers(t0).find((r) => r.ability.startsWith('Quag Maelstrom'));
  assert.ok(armed, 'the first cast did not arm a row');
  assert.equal(armed.state, 'armed');
  assert.equal(armed.dueMs, 19_000);

  // A second cast restarts the same slot rather than adding a row beside it — a second
  // row for one label is what the never-move rule forbids.
  engine.feedBody('Quag Maelstrom begins casting Mana Drain.', t0 + 5000);
  const again = engine.timers(t0 + 5000).filter((r) => r.ability.startsWith('Quag Maelstrom'));
  assert.equal(again.length, 1);
  assert.equal(again[0].dueMs, 19_000);
  assert.equal(again[0].since, armed.since, 'the row moved');

  engine.feedBody('You have slain Quag Maelstrom!', t0 + 6000);
  assert.equal(engine.timers(t0 + 6000)[0].state, 'lapsed');
});

test('a boss with no cast line arms from its damage and from a clean resist', () => {
  for (const line of [
    'Lord Nagafen hit Rhale for 500 points of fire damage by Lava Breath.',
    "You resist Lord Nagafen's Lava Breath!",
  ]) {
    const engine = new TriggerEngine();
    engine.setPacks([seedPack()]);
    const t0 = Date.parse('2026-08-08T12:00:00Z');
    engine.feedBody(line, t0);
    const row = engine.timers(t0).find((r) => r.ability === 'Lord Nagafen — Lava Breath');
    assert.ok(row, `${line} armed nothing`);
    assert.equal(row.dueMs, 14_000);
  }
});

test('installing twice does not make a second pack', () => {
  const store = makeStore();
  assert.deepEqual(installSeedPack(store), { installed: true, reason: 'new' });
  assert.deepEqual(installSeedPack(store), { installed: false, reason: 'current' });
  assert.equal(store.loadAll().packs.length, 1);
});

test('a pack the player has edited is left exactly alone', () => {
  const store = makeStore();
  installSeedPack(store);

  // What an edit looks like from the store's side: `touch()` sets the mark on any pack
  // with an upstream, which is now the shipped one as well as an imported GINA pack.
  const mine = store.get(SEED_PACK_ID);
  mine.triggers[0].timer.durationMs = 11_000;
  mine.edited = true;
  mine.modified = 'ancient';
  store.save(mine);

  assert.deepEqual(installSeedPack(store), { installed: false, reason: 'edited' });
  assert.equal(store.get(SEED_PACK_ID).triggers[0].timer.durationMs, 11_000);
});

test('an untouched older copy is upgraded, but keeps the player’s own switch', () => {
  const store = makeStore();
  installSeedPack(store);

  const stale = { ...store.get(SEED_PACK_ID), modified: 'ancient', enabled: false };
  stale.triggers = stale.triggers.slice(0, 1);
  store.save(stale);

  assert.deepEqual(installSeedPack(store), { installed: true, reason: 'upgraded' });
  const after = store.get(SEED_PACK_ID);
  assert.equal(after.triggers.length, seedPack().triggers.length);
  // Switching the pack off is a choice, not an edit — an upgrade must not turn it back on.
  assert.equal(after.enabled, false);
});

test('saving the shipped pack marks it edited, the way an imported one is', () => {
  // Without this the "leave an edited copy alone" branch above could never fire: `touch`
  // used to mark only GINA packs, on the reasoning that a native pack has no upstream.
  // This one does — it is sitting in the build.
  const store = makeStore();
  installSeedPack(store);
  const pack = store.get(SEED_PACK_ID);
  assert.equal(pack.edited, false);
  assert.equal(pack.shipped, true);
});
