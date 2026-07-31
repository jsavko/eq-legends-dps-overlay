import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, DEFAULTS, DEFAULT_LOG_DIR } from '../src/main/config.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eqcfg-'));
}

test('a fresh install loads defaults and is not configured', () => {
  const store = new ConfigStore(tmpdir());
  store.load();
  assert.equal(store.get('logPath'), null);
  assert.equal(store.get('logDir'), DEFAULT_LOG_DIR);
  assert.equal(store.isConfigured(), false, 'an unconfigured store must open the setup screen');
});

test('settings round-trip through disk', () => {
  const dir = tmpdir();
  const a = new ConfigStore(dir);
  a.load();
  a.set({ opacity: 0.5, groupOnly: true });

  const b = new ConfigStore(dir);
  b.load();
  assert.equal(b.get('opacity'), 0.5);
  assert.equal(b.get('groupOnly'), true);
  assert.equal(b.get('scale'), DEFAULTS.scale, 'untouched keys keep their defaults');
});

test('a partial hotkey patch keeps the other bindings', () => {
  const store = new ConfigStore(tmpdir());
  store.load();
  store.set({ hotkeys: { toggleLock: 'Control+Alt+D' } });

  assert.equal(store.get('hotkeys').toggleLock, 'Control+Alt+D');
  assert.equal(store.get('hotkeys').toggleVisible, DEFAULTS.hotkeys.toggleVisible);
});

test('a config written by a newer version keeps its unknown keys', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ opacity: 0.3, futureKey: 42 }));

  const store = new ConfigStore(dir);
  store.load();
  assert.equal(store.get('opacity'), 0.3);
  assert.equal(store.get('futureKey'), 42);
});

test('a corrupt config falls back to defaults instead of failing to start', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');

  const store = new ConfigStore(dir);
  store.load();
  assert.equal(store.get('opacity'), DEFAULTS.opacity);
});

test('isConfigured requires the log file to still exist', () => {
  const dir = tmpdir();
  const log = path.join(dir, 'eqlog_Rhale_oggok.txt');
  fs.writeFileSync(log, '');

  const store = new ConfigStore(dir);
  store.load();
  store.set({ logPath: log });
  assert.equal(store.isConfigured(), true);

  fs.unlinkSync(log);
  assert.equal(store.isConfigured(), false, 'a deleted log must send the user back to setup');
});

test('parserOptions converts seconds to the milliseconds the parser wants', () => {
  const store = new ConfigStore(tmpdir());
  store.load();
  store.set({ combatTimeoutSec: 20, postKillGraceSec: 4, rollingWindowSec: 6, groupOnly: true });

  assert.deepEqual(store.parserOptions(), {
    timeoutMs: 20_000,
    postKillGraceMs: 4_000,
    rollingWindowMs: 6_000,
    groupOnly: true,
    petOwners: {},
  });
});

test('the pet mapping is replaced wholesale, so an entry can be removed', () => {
  // A merge would make a deleted mapping immortal: the old key would survive every save.
  const store = new ConfigStore(tmpdir());
  store.load();
  store.set({ petOwners: { Gann: 'Rhain', Bixie: 'Emalina' } });
  store.set({ petOwners: { Gann: 'Rhain' } });

  assert.deepEqual(store.get('petOwners'), { Gann: 'Rhain' });
});
