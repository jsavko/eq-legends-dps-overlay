import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RhythmStore, SAMPLE_CAP } from '../src/main/rhythms.js';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythms-'));
  return { store: new RhythmStore(dir), dir };
}

const QUAG = { caster: 'Quag Maelstrom', ability: 'Mana Drain', intervalMs: 19_000, spreadMs: 1500, samples: 4 };

test('a first fight writes the file; knownFor round-trips it', () => {
  const { store } = makeStore();
  store.merge('oggok', [QUAG], 1000);

  const known = store.knownFor('oggok');
  assert.equal(known.length, 1);
  assert.equal(known[0].intervalMs, 19_000);
  assert.equal(known[0].lastSeen, 1000);
});

test('a second fight pools by sample count', () => {
  const { store } = makeStore();
  store.merge('oggok', [QUAG], 1000);
  store.merge('oggok', [{ ...QUAG, intervalMs: 21_000, samples: 12 }], 2000);

  const [r] = store.knownFor('oggok');
  // (19000·4 + 21000·12) / 16 = 20500
  assert.equal(r.intervalMs, 20_500);
  assert.equal(r.samples, 16);
  assert.equal(r.lastSeen, 2000);
});

test('the pooled sample count caps, so a patched boss can re-learn', () => {
  const { store } = makeStore();
  for (let i = 0; i < 20; i++) store.merge('oggok', [{ ...QUAG, samples: 10 }], i);
  assert.equal(store.knownFor('oggok')[0].samples, SAMPLE_CAP);
});

test('servers are separate memories', () => {
  const { store } = makeStore();
  store.merge('oggok', [QUAG], 1000);
  assert.equal(store.knownFor('oggok').length, 1);
  assert.equal(store.knownFor('vallon').length, 0);
  assert.equal(store.knownFor(null).length, 0, 'null server maps to its own file');
});

test('a corrupt file yields the empty memory, not a crash', () => {
  const { store, dir } = makeStore();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'oggok.json'), 'not json {', 'utf8');
  assert.deepEqual(store.knownFor('oggok'), []);

  // And the next merge overwrites the corruption.
  store.merge('oggok', [QUAG], 1000);
  assert.equal(store.knownFor('oggok').length, 1);
});

test('an empty learned list writes nothing', () => {
  const { store, dir } = makeStore();
  store.merge('oggok', [], 1000);
  assert.equal(fs.existsSync(path.join(dir, 'oggok.json')), false);
});
