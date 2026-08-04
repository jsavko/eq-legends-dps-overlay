import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EncounterStore, RECORD_VERSION, storeKey } from '../src/main/history.js';
import { LogParser } from '../src/parser/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eql-history-'));

function record(overrides = {}) {
  return {
    v: RECORD_VERSION,
    id: `${overrides.startTs ?? 1000}-${(overrides.startTs ?? 1000) + 5000}`,
    character: 'Rhale',
    server: 'oggok',
    zone: "Nagafen's Lair",
    label: 'Lord Nagafen',
    startTs: 1000,
    endTs: 6000,
    durationMs: 5000,
    closeReason: 'killed',
    snapshot: {
      totalDamage: 1200,
      groupDps: 240,
      totalHealing: 300,
      totalDamageTaken: 800,
      deaths: [{ name: 'Rhale', killer: 'Lord Nagafen', ts: 3000, isPet: false }],
      rows: [
        { name: 'Rhale', damage: 1200, dps: 240, damageTaken: 800, deaths: 1 },
      ],
    },
    ...overrides,
  };
}

test('storeKey sanitizes and pairs character with server', () => {
  assert.equal(storeKey('Rhale', 'oggok'), 'Rhale_oggok');
  assert.equal(storeKey('Rhale', null), 'Rhale_unknown');
  assert.equal(storeKey('we/ird', 'na me'), 'we_ird_na_me');
});

test('append/list/get round-trip', () => {
  const store = new EncounterStore(tmp());
  const key = store.append(record());
  assert.equal(key, 'Rhale_oggok');

  const list = store.list(key);
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'Lord Nagafen');
  assert.equal(list[0].deaths, 1);
  assert.equal(list[0].self.dps, 240);
  assert.equal(list[0].self.damageTaken, 800);

  const full = store.get(key, list[0].id);
  assert.equal(full.snapshot.rows[0].damage, 1200);
  assert.equal(store.get(key, 'nope'), null);
});

test('list is newest first', () => {
  const store = new EncounterStore(tmp());
  store.append(record({ startTs: 1000, id: 'a' }));
  store.append(record({ startTs: 9000, id: 'b' }));
  store.append(record({ startTs: 5000, id: 'c' }));
  assert.deepEqual(store.list('Rhale_oggok').map((e) => e.id), ['b', 'c', 'a']);
});

test('a torn final line loses one record, not the file', () => {
  const store = new EncounterStore(tmp());
  const key = store.append(record({ id: 'kept' }));
  fs.appendFileSync(store.fileFor(key), '{"v":1,"id":"torn","snapsho');   // crash mid-append

  const list = store.list(key);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'kept');
});

test('characters() reads the directory; a missing directory is empty, not an error', () => {
  const dir = tmp();
  const store = new EncounterStore(path.join(dir, 'never-created'));
  assert.deepEqual(store.characters(), []);
  assert.deepEqual(store.list('Rhale_oggok'), []);

  const store2 = new EncounterStore(dir);
  store2.append(record());
  store2.append(record({ character: 'Fuaim', server: 'oggok' }));
  assert.deepEqual(
    store2.characters().map((c) => [c.character, c.server]).sort(),
    [['Fuaim', 'oggok'], ['Rhale', 'oggok']]
  );
});

test('clear deletes one character\'s file and reports whether anything was there', () => {
  const store = new EncounterStore(tmp());
  const key = store.append(record());
  assert.equal(store.clear(key), true);
  assert.deepEqual(store.list(key), []);
  assert.equal(store.clear(key), false);
});

// ------------------------------------------------------- the parser-side hook

const D = (h, m, s) => `[Fri Jul 31 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} 2026]`;

function hookedParser(closed, opts = {}) {
  let now = new Date(2026, 6, 31, 18, 48, 13).getTime();
  const p = new LogParser({
    selfName: 'Rhale',
    clock: () => now,
    onEncounterEnd: (enc) => closed.push(enc),
    ...opts,
  });
  p.setNow = (ts) => { now = ts; };
  return p;
}

test('onEncounterEnd fires on the idle timeout', () => {
  const closed = [];
  const p = hookedParser(closed, { timeoutMs: 15_000 });
  p.feed(`${D(18, 48, 15)} You crush a froglok shin knight for 40 points of damage.`);
  p.setNow(new Date(2026, 6, 31, 18, 50, 0).getTime());
  p.tick();

  assert.equal(closed.length, 1);
  assert.equal(closed[0].closeReason, 'timeout');
  assert.equal(closed[0].totalDamage, 40);
});

test('onEncounterEnd fires on zoning', () => {
  const closed = [];
  const p = hookedParser(closed);
  p.feed(`${D(18, 48, 15)} You crush a froglok shin knight for 40 points of damage.`);
  // 5s later — inside the idle timeout, so the ZONE is what ends the fight.
  p.feed(`${D(18, 48, 20)} LOADING, PLEASE WAIT...`);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closeReason, 'zone');
});

test('onEncounterEnd fires on all-slain, discovered by the next line', () => {
  const closed = [];
  const p = hookedParser(closed, { postKillGraceMs: 3000 });
  p.feed(`${D(18, 48, 15)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 48, 16)} A froglok shin knight has been slain by Rhale!`);
  // The grace period elapses inside the log's own clock; the next line's tick closes it.
  p.feed(`${D(18, 48, 30)} You begin casting Feral Spirit.`);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].closeReason, 'killed');
});

test('reset does NOT fire the hook — a reset fight does not count', () => {
  const closed = [];
  const p = hookedParser(closed);
  p.feed(`${D(18, 48, 15)} You crush a froglok shin knight for 40 points of damage.`);
  p.reset();
  assert.equal(closed.length, 0);
});

test('each pull closes exactly once across a whole replayed session', () => {
  const closed = [];
  const p = hookedParser(closed, { timeoutMs: 15_000 });
  p.feed(`${D(18, 48, 15)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 49, 30)} You crush a froglok wizard for 10 points of damage.`);
  p.feed(`${D(18, 51, 0)} You crush a mummy for 5 points of damage.`);
  p.setNow(new Date(2026, 6, 31, 19, 0, 0).getTime());
  p.tick();
  p.tick();   // a second tick must not re-fire for the already-closed fight

  assert.equal(closed.length, 3);
  assert.equal(new Set(closed).size, 3, 'each encounter object reported once');
});
