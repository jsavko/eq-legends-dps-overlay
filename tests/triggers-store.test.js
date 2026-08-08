/**
 * The trigger-pack store, against a temp dir — the same shape as the history and
 * rhythm store tests, and for the same reason: the directory is injected, so none of
 * this needs Electron and all of it runs in WSL.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TriggerStore } from '../src/main/triggers-store.js';
import { myTriggersPack, createTrigger, MY_TRIGGERS_ID } from '../src/triggers/pack.js';
import { parseGinaPackage } from '../src/triggers/gina.js';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triggers-'));
  return { store: new TriggerStore(dir), dir };
}

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'gina', 'sieve.gtp');
const sievePack = () => parseGinaPackage(fs.readFileSync(FIXTURE), { name: 'sieve' }).pack;

const simplePack = (id, name) => ({
  id, name, origin: 'native', enabled: true, groups: [],
  triggers: [{ id: 't1', name: 'A', pattern: 'aaa', warn: { text: 'A!' } }],
});

test('an empty directory is not an error — it is a player with no triggers yet', () => {
  const { store } = makeStore();
  assert.deepEqual(store.loadAll(), { packs: [], problems: [] });
  assert.deepEqual(store.enabledPacks(), []);
  assert.equal(store.get('nothing'), null);
});

test('a saved pack round-trips through the file', () => {
  const { store } = makeStore();
  const saved = store.save(sievePack());
  assert.equal(saved.ok, true);

  const back = store.get('sieve');
  assert.equal(back.name, 'sieve');
  assert.equal(back.triggers[0].pattern, '^(?<mob>.*) staggers in pain\\.$');
  assert.equal(back.triggers[0].timer.durationMs, 60_000);
});

test('a pack that would not load again is refused before it reaches disk', () => {
  const { store, dir } = makeStore();
  const result = store.save({ id: 'bad', name: 'bad', triggers: [{ id: 't1', name: 'X', pattern: '(unclosed', warn: { text: 'x' } }] });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((e) => /does not compile/.test(e)), true);
  // Discovering this at the next launch, as a pack that silently does nothing, is the
  // failure this whole feature exists to avoid.
  assert.equal(fs.existsSync(path.join(dir, 'bad.json')), false);
});

test('importing the same pack twice keeps both — two guilds may share a name', () => {
  const { store } = makeStore();
  assert.equal(store.add(sievePack()).pack.id, 'sieve');
  assert.equal(store.add(sievePack()).pack.id, 'sieve-2');
  assert.equal(store.add(sievePack()).pack.id, 'sieve-3');
  assert.equal(store.loadAll().packs.length, 3);
});

test('a pack id can never escape the triggers directory', () => {
  const { store, dir } = makeStore();
  // A pack NAME is chosen by a stranger and becomes the id, so it reaches the
  // filesystem untrusted.
  store.save({ ...simplePack('../../escaped', 'Escaped') });
  assert.deepEqual(fs.readdirSync(dir), ['escaped.json']);
  assert.equal(fs.existsSync(path.join(dir, '..', '..', 'escaped.json')), false);
});

/** What TRIGGERS_CREATE_PACK sends the store: a name, and nothing in it yet. */
const newPack = (name) => ({
  id: name, name, comments: 'Triggers written here.',
  origin: 'native', enabled: true, groups: [], triggers: [],
});

test('a pack can be created empty, and twice under one name gives two packs', () => {
  // An empty pack is a destination you plan — "save a trigger somewhere else to create
  // the thing you wanted to save it in" is not an order anyone would guess. Two of them
  // under one name is a player's own business; silently replacing the first is not.
  const { store } = makeStore();
  assert.equal(store.add(newPack('Vox night')).pack.id, 'Vox-night');
  assert.equal(store.add(newPack('Vox night')).pack.id, 'Vox-night-2');

  const packs = store.loadAll().packs;
  assert.equal(packs.length, 2);
  assert.deepEqual(packs.map((p) => p.name), ['Vox night', 'Vox night']);
  assert.deepEqual(packs[0].triggers, [], 'an empty pack is a valid pack');
  assert.equal(packs[0].origin, 'native');
});

test('a hostile pack name cannot write outside the triggers directory', () => {
  // The name comes from a text field in a renderer and becomes a filename. `safeId` is
  // the only thing standing between the two.
  const { store, dir } = makeStore();
  const saved = store.add(newPack('../../pwned'));
  assert.equal(saved.pack.id.includes('/'), false);
  assert.deepEqual(fs.readdirSync(dir), ['pwned.json']);
  assert.equal(fs.existsSync(path.join(dir, '..', '..', 'pwned.json')), false);

  // A name with nothing usable in it still has to land somewhere real.
  store.add(newPack('....'));
  assert.equal(fs.readdirSync(dir).length, 2);
});

test('one corrupt pack does not take the others down with it', () => {
  const { store, dir } = makeStore();
  store.save(simplePack('good-a', 'Good A'));
  store.save(simplePack('good-b', 'Good B'));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json at all', 'utf8');

  const { packs, problems } = store.loadAll();
  assert.deepEqual(packs.map((p) => p.id), ['good-a', 'good-b']);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].file, 'broken.json');
});

test('switches flip at pack, group and trigger level, and only the one asked for', () => {
  const { store } = makeStore();
  const pack = store.add(sievePack()).pack;
  const groupId = pack.groups.at(-1).id;

  assert.equal(store.setEnabled(pack.id, false).enabled, false);
  assert.equal(store.get(pack.id).enabled, false);
  assert.deepEqual(store.enabledPacks(), []);
  assert.equal(store.setEnabled(pack.id, true).enabled, true);

  const grouped = store.setGroupEnabled(pack.id, groupId, true);
  assert.equal(grouped.groups.find((g) => g.id === groupId).enabled, true);
  assert.equal(grouped.groups.filter((g) => g.id !== groupId).every((g) => g.enabled === false), true);

  const triggered = store.setTriggerEnabled(pack.id, 't1', false);
  assert.equal(triggered.triggers[0].enabled, false);
  assert.equal(store.setTriggerEnabled('no-such-pack', 't1', false), null);
});

test('removing a pack is an unlink that cannot half-succeed', () => {
  const { store } = makeStore();
  store.add(simplePack('gone', 'Gone'));
  assert.equal(store.remove('gone'), true);
  assert.equal(store.get('gone'), null);
  // Already gone is the state the caller wanted, so it is not an error.
  assert.equal(store.remove('gone'), false);
});

test('My Triggers exists before it is saved, and is a native pack', () => {
  const { store } = makeStore();
  const mine = store.myTriggers();
  assert.equal(mine.id, MY_TRIGGERS_ID);
  assert.equal(mine.origin, 'native');
  assert.deepEqual(mine.triggers, []);

  const added = createTrigger(mine, { name: 'Slow', pattern: '(?<mob>.*) yawns', warnText: 'Slowed: ${mob}' });
  store.save(added.pack);
  assert.equal(store.myTriggers().triggers.length, 1);
  // It must NOT be marked edited: a native pack has no upstream to have diverged from.
  assert.equal(store.myTriggers().edited, false);
});

test('the summary carries what the settings list needs to be legible', () => {
  const { store } = makeStore();
  store.add(sievePack());
  store.save(createTrigger(myTriggersPack(), { name: 'A', pattern: 'aaa', warnText: 'A!' }).pack);

  const { packs } = store.summary();
  const sieve = packs.find((p) => p.id === 'sieve');
  assert.equal(sieve.origin, 'gina');
  assert.equal(sieve.triggers, 1);
  // The sieve pack ships every group EnableByDefault=False, so nothing is live until
  // the player switches a group on — which is exactly what `live` is there to say.
  assert.equal(sieve.live, 0);
  assert.equal(sieve.timers, 1);

  const mine = packs.find((p) => p.id === MY_TRIGGERS_ID);
  assert.equal(mine.origin, 'native');
  assert.equal(mine.live, 1);
});
