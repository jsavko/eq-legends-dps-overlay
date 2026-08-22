/**
 * The trigger runtime.
 *
 * Two things dominate here. The first is the never-move rule the timers panel imposes:
 * a slot is claimed in first-armed order and holds its row through every state it can
 * reach, so re-arming, lapsing and repeating must all leave `since` alone. The second is
 * that a bad pack must cost triggers and nothing else — an uncompilable pattern, a
 * pathological one, and a template that renders to nothing all have to degrade quietly
 * and be reportable by name.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TriggerEngine, STRIKES, SPENT_LINGER_MS, TRIGGER_WARN_TTL_MS } from '../src/triggers/engine.js';
import { normalize, myTriggersPack, createTrigger } from '../src/triggers/pack.js';
import { parseGinaPackage } from '../src/triggers/gina.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'gina');
const gina = (name) => parseGinaPackage(fs.readFileSync(path.join(FIXTURES, name)), { name }).pack;
/** Fixture packs ship EnableByDefault=False; a test about matching is not about that. */
const allOn = (pack) => ({ ...pack, groups: pack.groups.map((g) => ({ ...g, enabled: true })) });

const T0 = Date.UTC(2026, 7, 7, 12, 0, 0);
const at = (ms) => T0 + ms;
/** A real log line, so the engine's own timestamp stripping is exercised. */
const line = (body, when = T0) => {
  const d = new Date(when);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return `[${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}] ${body}`;
};

function engineWith(pack, character = 'Rhale') {
  const engine = new TriggerEngine({ character });
  engine.setPacks([normalize(pack)]);
  return engine;
}

const pack = (triggers, extra = {}) => normalize({
  id: 'test', name: 'Test pack', origin: 'native', enabled: true, groups: [], triggers, ...extra,
});

// ------------------------------------------------------------------- matching

test('a trigger fires on the line BODY, not on the timestamped line', () => {
  // GINA patterns anchor with ^ and $, which only ever match the text after the header.
  const engine = engineWith(pack([
    { id: 't1', name: 'Slain', pattern: '^You have slain (?<mob>.*)!$', warn: { text: 'Down: ${mob}' } },
  ]));

  assert.equal(engine.feed(line('You have slain a froglok shin knight!')), 1);
  const [chip] = engine.warnings(T0);
  assert.equal(chip.text, 'Down: a froglok shin knight');
  assert.equal(chip.category, 'trigger');
});

test('a line with no timestamp is ignored rather than matched against raw text', () => {
  const engine = engineWith(pack([
    { id: 't1', name: 'Any', pattern: 'anything', warn: { text: 'hit' } },
  ]));
  assert.equal(engine.feed('anything at all, but unstamped'), 0);
  assert.deepEqual(engine.warnings(T0), []);
});

test('the prefilter never costs a match', () => {
  const engine = engineWith(allOn(gina('zone-timers-gina.gtp')));
  // This pattern's prefilter is a SET, because neither half of its top-level
  // alternation is required on its own.
  const entry = engine.compiled.find((c) => c.trigger.name === 'zone timer');
  assert.equal(entry.prefilter.length, 2);
  assert.equal(engine.feed(line('You have slain a froglok shin knight!')) > 0, true);

  engine.reset();
  assert.equal(engine.feed(line('Gann has been slain by a froglok shin knight!')) > 0, true);
});

test('a warning whose template renders empty raises no chip', () => {
  // A chip with nothing written on it is not a warning, it is a blank banner.
  const engine = engineWith(pack([
    { id: 't1', name: 'Empty', pattern: '(?<a>x)|(?<b>y)', warn: { text: '${b}' } },
  ]));
  engine.feed(line('x'));
  assert.deepEqual(engine.warnings(T0), []);
  engine.feed(line('y'));
  assert.equal(engine.warnings(T0).length, 1);
});

test('chips expire on their own clock and report remainingMs', () => {
  const engine = engineWith(pack([
    { id: 't1', name: 'Ping', pattern: 'ping', warn: { text: 'Ping!' } },
  ]));
  engine.feed(line('ping', T0));
  assert.equal(engine.warnings(T0)[0].remainingMs, TRIGGER_WARN_TTL_MS);
  assert.equal(engine.warnings(at(TRIGGER_WARN_TTL_MS / 2))[0].remainingMs, TRIGGER_WARN_TTL_MS / 2);

  engine.feed(line('nothing', at(TRIGGER_WARN_TTL_MS + 1)));
  assert.deepEqual(engine.warnings(at(TRIGGER_WARN_TTL_MS + 1)), []);
});

// ------------------------------------------------------- {C} and character switch

test('{C} recompiles on a character switch instead of going quiet', () => {
  const engine = engineWith(pack([
    { id: 't1', name: 'Reset', pattern: '^{C} ##reset$', usesCharacter: true, warn: { text: 'reset' } },
  ]), 'Rhale');

  assert.equal(engine.feed(line('Rhale ##reset')), 1);
  assert.equal(engine.feed(line('Emalina ##reset')), 0);

  engine.setCharacter('Emalina');
  assert.equal(engine.feed(line('Emalina ##reset')), 1);
  assert.equal(engine.feed(line('Rhale ##reset')), 0);
});

test('{C} in the OUTPUT follows the character too', () => {
  const engine = engineWith(pack([
    { id: 't1', name: 'Mana', pattern: 'out of mana', warn: { text: '{C} is out of mana' } },
  ]), 'Rhale');
  engine.feed(line('out of mana'));
  assert.equal(engine.warnings(T0)[0].text, 'Rhale is out of mana');

  engine.setCharacter('Emalina');
  engine.reset();
  engine.feed(line('out of mana'));
  assert.equal(engine.warnings(T0)[0].text, 'Emalina is out of mana');
});

test('setting the same character does not churn the compiled table', () => {
  const engine = engineWith(pack([{ id: 't1', name: 'A', pattern: 'aaa', warn: { text: 'a' } }]), 'Rhale');
  const before = engine.revision;
  engine.setCharacter('Rhale');
  assert.equal(engine.revision, before);
});

// ------------------------------------------------------------------- timers

const TIMER_PACK = pack([{
  id: 't1', name: 'Respawn', pattern: '^You have slain (?<mob>.*)!$',
  timer: { kind: 'countdown', name: 'Respawn: ${mob}', durationMs: 300_000, restart: 'new' },
}]);

test('a timer arms with its authored duration and counts down', () => {
  const engine = engineWith(TIMER_PACK);
  engine.feed(line('You have slain Xicotl!', T0));

  const [row] = engine.timers(T0);
  assert.equal(row.source, 'trigger');
  assert.equal(row.ability, 'Respawn: Xicotl');
  assert.equal(row.caster, 'Test pack');
  assert.equal(row.state, 'armed');
  assert.equal(row.dueMs, 300_000);
  assert.equal(row.intervalMs, 300_000);
  // An authored duration is EXACT, not an estimate — there is no spread to state.
  assert.equal(row.spreadMs, null);
  assert.equal(row.warm, false);

  assert.equal(engine.timers(at(120_000))[0].dueMs, 180_000);
});

test('the rendered timer name keys the slot, so two mobs are two countdowns', () => {
  const engine = engineWith(TIMER_PACK);
  engine.feed(line('You have slain a Mistmoore guard!', T0));
  engine.feed(line('You have slain Xicotl!', at(1000)));

  const rows = engine.timers(at(2000));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.ability), ['Respawn: a Mistmoore guard', 'Respawn: Xicotl']);
});

test('A ROW NEVER MOVES: re-arming keeps its place, however the list would re-sort', () => {
  const engine = engineWith(pack([
    { id: 't1', name: 'Long', pattern: 'long', timer: { kind: 'countdown', name: 'Long', durationMs: 600_000, restart: 'restart' } },
    { id: 't2', name: 'Short', pattern: 'short', timer: { kind: 'countdown', name: 'Short', durationMs: 10_000, restart: 'restart' } },
  ]));

  engine.feed(line('long', T0));
  engine.feed(line('short', at(1000)));
  assert.deepEqual(engine.timers(at(2000)).map((r) => r.ability), ['Long', 'Short']);

  // Re-arming the SHORT one makes it due much sooner than the long one — sorting by
  // dueMs would put it on top, which is the exact bug the timers window replaced.
  engine.feed(line('short', at(5000)));
  assert.deepEqual(engine.timers(at(6000)).map((r) => r.ability), ['Long', 'Short']);
  assert.equal(engine.timers(at(6000))[1].dueMs, 9000);
  // `since` is what main merges on, so it must not move either.
  assert.equal(engine.timers(at(6000))[1].since, at(1000));
});

test('TimerStartBehavior: restart resets in place, ignore leaves a running timer alone', () => {
  const make = (restart) => engineWith(pack([{
    id: 't1', name: 'T', pattern: 'go',
    timer: { kind: 'countdown', name: 'T', durationMs: 60_000, restart },
  }]));

  for (const restart of ['new', 'restart']) {
    const engine = make(restart);
    engine.feed(line('go', T0));
    engine.feed(line('go', at(30_000)));
    // One row, restarted — a SECOND row for the same label would push everything below
    // it down the screen, which the never-move rule forbids.
    assert.equal(engine.timers(at(30_000)).length, 1, restart);
    assert.equal(engine.timers(at(30_000))[0].dueMs, 60_000, restart);
    assert.equal(engine.timers(at(30_000))[0].since, T0, restart);
  }

  const ignore = make('ignore');
  ignore.feed(line('go', T0));
  ignore.feed(line('go', at(30_000)));
  assert.equal(ignore.timers(at(30_000))[0].dueMs, 30_000, 'the running countdown was left alone');
});

test('an early ender stops a countdown, resolving ${…} against the arming match', () => {
  const engine = engineWith(pack([{
    id: 't1', name: 'Slow', pattern: '(?<mob>.*) yawns\\.',
    timer: {
      kind: 'countdown', name: 'Slow on ${mob}', durationMs: 300_000, restart: 'restart',
      earlyEnders: [{ pattern: '${mob} is no longer slowed\\.', needsMatch: true }],
    },
  }]));

  engine.feed(line('a froglok shin knight yawns.', T0));
  assert.equal(engine.timers(at(1000))[0].state, 'armed');

  // A DIFFERENT mob's end line must not end this one's timer.
  engine.feed(line('a giant scarab is no longer slowed.', at(2000)));
  assert.equal(engine.timers(at(2000))[0].state, 'armed');

  engine.feed(line('a froglok shin knight is no longer slowed.', at(3000)));
  assert.equal(engine.timers(at(3000))[0].state, 'lapsed');
  assert.equal(engine.timers(at(3000))[0].dueMs, null);
});

test('an early ender with {C} compiles once and follows the character', () => {
  const original = gina('respawn-slice.gtp');
  const engine = engineWith(original, 'Rhale');
  engine.feed(line('You have slain a froglok shin knight!', T0));
  assert.equal(engine.timers(at(1000)).some((r) => r.state === 'armed'), true);

  engine.feed(line('Rhale ##reset.', at(2000)));
  assert.equal(engine.timers(at(2000)).every((r) => r.state === 'lapsed'), true);
});

test('a spent slot lingers, then leaves; a repeating one re-arms in the same row', () => {
  const engine = engineWith(pack([
    { id: 't1', name: 'Once', pattern: 'once', timer: { kind: 'countdown', name: 'Once', durationMs: 10_000 } },
    { id: 't2', name: 'Loop', pattern: 'loop', timer: { kind: 'repeating', name: 'Loop', durationMs: 10_000 } },
  ]));
  engine.feed(line('once', T0));
  engine.feed(line('loop', T0));

  assert.equal(engine.timers(at(9000)).length, 2);
  // At zero both are spent but still on screen — a row that blinks out reads as a glitch.
  engine.feed(line('idle', at(10_500)));
  assert.deepEqual(engine.timers(at(10_500)).map((r) => r.state), ['lapsed', 'lapsed']);

  engine.feed(line('idle', at(10_000 + SPENT_LINGER_MS + 100)));
  const after = engine.timers(at(10_000 + SPENT_LINGER_MS + 100));
  assert.deepEqual(after.map((r) => r.ability), ['Loop']);
  // The repeating row kept its slot AND its place, so nothing below it moved.
  assert.equal(after[0].since, T0);
  assert.equal(after[0].state, 'armed');
});

test('the ending window is flagged, with the author\'s own wording', () => {
  const engine = engineWith(gina('respawn-slice.gtp'));
  engine.feed(line('You have slain Xicotl!', T0));
  const row = () => engine.timers(at(300_000 - 60_000));

  assert.equal(row()[0].ending, false);
  const soon = engine.timers(at(300_000 - 20_000))[0];
  assert.equal(soon.ending, true);
  assert.equal(soon.endingText, 'spawn soon');
});

test('reset clears live state but keeps the packs compiled', () => {
  const engine = engineWith(TIMER_PACK);
  engine.feed(line('You have slain Xicotl!', T0));
  assert.equal(engine.hasTimers, true);

  engine.reset();
  assert.deepEqual(engine.timers(T0), []);
  assert.deepEqual(engine.warnings(T0), []);
  assert.equal(engine.hasTimers, false);
  assert.equal(engine.compiled.length, 1, 'recompiling on every reset would be pure waste');
  assert.equal(engine.feed(line('You have slain Xicotl!', at(1000))), 1);
});

// --------------------------------------------------------------------- safety

test('a pattern that will not compile is reported and costs nothing else', () => {
  const engine = engineWith(pack([
    { id: 't1', name: 'Bad', pattern: '(?#dotnet comment)x', warn: { text: 'bad' } },
    { id: 't2', name: 'Good', pattern: 'good line', warn: { text: 'good' } },
  ]));

  assert.equal(engine.compiled.length, 1);
  assert.equal(engine.feed(line('good line')), 1);

  const problems = engine.problems();
  assert.equal(problems.length, 1);
  assert.equal(problems[0].name, 'Bad');
  assert.equal(problems[0].reason, 'pattern');
  assert.equal(problems[0].packName, 'Test pack');
});

test('a pattern that repeatedly overruns is disabled and named', () => {
  // Catastrophic backtracking: exponential in the length of the non-matching tail.
  const engine = engineWith(pack([
    { id: 't1', name: 'Runaway', pattern: '^(a+)+$', warn: { text: 'boom' } },
    { id: 't2', name: 'Fine', pattern: 'fine line', warn: { text: 'fine' } },
  ]));

  const evil = 'a'.repeat(30) + 'b';
  for (let i = 0; i < STRIKES + 2; i++) engine.feed(line(evil, at(i * 100)));

  const problems = engine.problems();
  assert.equal(problems.length, 1);
  assert.equal(problems[0].name, 'Runaway');
  assert.equal(problems[0].reason, 'slow');

  // The rest of the pack is untouched — this is the failure that isolation alone would
  // not have solved, since a stalled engine still stops the shared line stream.
  assert.equal(engine.feed(line('fine line', at(9999))), 1);
});

test('a disabled pattern gets a clean slate when the packs are recompiled', () => {
  const engine = engineWith(pack([{ id: 't1', name: 'Runaway', pattern: '^(a+)+$', warn: { text: 'boom' } }]));
  const evil = 'a'.repeat(30) + 'b';
  for (let i = 0; i < STRIKES + 2; i++) engine.feed(line(evil, at(i * 100)));
  assert.equal(engine.problems().length, 1);

  // The player may have just fixed it in the editor; holding a strike against a regex
  // that no longer exists would be unexplainable.
  engine.setCharacter('Someone Else');
  assert.deepEqual(engine.problems(), []);
});

// ----------------------------------------------------------------- pack switches

test('only enabled packs, groups and triggers run', () => {
  const engine = new TriggerEngine({ character: 'Rhale' });
  const p = pack([{ id: 't1', name: 'A', pattern: 'aaa', warn: { text: 'a' } }]);

  engine.setPacks([{ ...p, enabled: false }]);
  // The store filters disabled packs, but the engine must not depend on that having
  // happened — a pack handed over is a pack it will match with.
  assert.equal(engine.compiled.length, 1);

  engine.setPacks([{ ...p, triggers: p.triggers.map((t) => ({ ...t, enabled: false })) }]);
  assert.equal(engine.compiled.length, 0);
  assert.equal(engine.feed(line('aaa')), 0);
});

test('several packs match side by side, each row naming its own pack', () => {
  const engine = new TriggerEngine({ character: 'Rhale' });
  engine.setPacks([
    normalize({ id: 'a', name: 'Pack A', groups: [], triggers: [{ id: 't1', name: 'A', pattern: 'shared line', warn: { text: 'from A' } }] }),
    normalize({ id: 'b', name: 'Pack B', groups: [], triggers: [{ id: 't1', name: 'B', pattern: 'shared line', warn: { text: 'from B' } }] }),
  ]);

  assert.equal(engine.feed(line('shared line')), 2);
  assert.deepEqual(engine.warnings(T0).map((w) => w.pack), ['Pack A', 'Pack B']);
});

test('an authored trigger runs exactly like an imported one', () => {
  const authored = createTrigger(myTriggersPack(), {
    name: 'Slow', pattern: '(?<mob>.*) yawns', warnText: 'Slowed: ${mob}',
    durationSec: 310, timerName: 'Slow on ${mob}',
  }).pack;

  const engine = engineWith(authored);
  engine.feed(line('a froglok shin knight yawns.', T0));
  assert.equal(engine.warnings(T0)[0].text, 'Slowed: a froglok shin knight');
  assert.equal(engine.timers(T0)[0].ability, 'Slow on a froglok shin knight');
  assert.equal(engine.timers(T0)[0].dueMs, 310_000);
});

// ------------------------------------------------- configurable chip duration

test('warnTtlMs option stretches a chip past the shipped default', () => {
  const engine = new TriggerEngine({ character: 'Rhale', warnTtlMs: 15_000 });
  engine.setPacks([pack([
    { id: 't1', name: 'Slain', pattern: '^You have slain', warn: { text: 'down' } },
  ])]);

  engine.feed(line('You have slain a froglok shin knight!'));
  engine.expire(at(10_000));
  const [chip] = engine.warnings(at(10_000));
  assert.ok(chip, 'still up past the 8s default');
  assert.equal(chip.remainingMs, 5000);
});

test('a default-constructed engine stamps TRIGGER_WARN_TTL_MS, as ever', () => {
  const engine = engineWith(pack([
    { id: 't1', name: 'Slain', pattern: '^You have slain', warn: { text: 'down' } },
  ]));
  engine.feed(line('You have slain a froglok shin knight!'));
  assert.equal(engine.warnings(T0)[0].remainingMs, TRIGGER_WARN_TTL_MS);
});

test('setWarnTtl governs the next chip and leaves a stamped one alone', () => {
  const engine = engineWith(pack([
    { id: 't1', name: 'Slain', pattern: '^You have slain', warn: { text: 'down' } },
  ]));

  engine.feed(line('You have slain a froglok shin knight!'));
  engine.setWarnTtl(20_000);

  // The chip already up keeps the 8s it was stamped with…
  engine.expire(at(9000));
  assert.equal(engine.warnings(at(9000)).length, 0);

  // …and the next one is born with the new window.
  engine.feed(line('You have slain a froglok shin knight!', at(10_000)));
  engine.expire(at(10_000));
  assert.equal(engine.warnings(at(10_000))[0].remainingMs, 20_000);
});

test('setWarnTtl ignores values a chip could not survive', () => {
  const engine = engineWith(pack([
    { id: 't1', name: 'Slain', pattern: '^You have slain', warn: { text: 'down' } },
  ]));
  engine.setWarnTtl(0);
  engine.setWarnTtl(NaN);
  assert.equal(engine.warnTtlMs, TRIGGER_WARN_TTL_MS);
});
