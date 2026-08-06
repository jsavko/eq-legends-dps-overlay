import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, DEFAULTS, DEFAULT_LOG_DIR, alertsEnabled } from '../src/main/config.js';

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

// --------------------------------------------------------------- alert switches

/** A config with every alert category off, to switch one back on per case. */
const NO_ALERTS = { castAlerts: false, summonAlerts: false, ccAlerts: false, castTimers: false };

test('any single alert category keeps the alert window alive', () => {
  for (const key of ['castAlerts', 'summonAlerts', 'ccAlerts', 'castTimers']) {
    assert.equal(
      alertsEnabled({ ...NO_ALERTS, [key]: true }), true,
      `${key} alone must be enough to justify the window`
    );
  }
});

test('the alert window is gone once the last category is off', () => {
  assert.equal(alertsEnabled(NO_ALERTS), false);
  assert.equal(alertsEnabled(DEFAULTS), true, 'a fresh install shows alerts');
});

test('mute beats the categories without erasing them', () => {
  const cfg = { ...DEFAULTS, alertsMuted: true };
  assert.equal(alertsEnabled(cfg), false);
  // The whole point of a separate key: the preferences survive the mute.
  assert.equal(cfg.castAlerts, true);
  assert.equal(alertsEnabled({ ...cfg, alertsMuted: false }), true, 'unmuting restores them');
});

test('a config predating a category treats it as on rather than dropping its alerts', () => {
  assert.equal(alertsEnabled({ castAlerts: false, summonAlerts: false, ccAlerts: false }), true);
});

test('an old "alerts off" config keeps meaning no alerts at all', () => {
  // castAlerts used to own the window; it now only owns interrupt warnings, so without
  // this the other three categories would appear unbidden on upgrade.
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ castAlerts: false, castAlertSound: false, castTimers: true })
  );

  const store = new ConfigStore(dir);
  store.load();
  assert.equal(store.get('summonAlerts'), false);
  assert.equal(store.get('ccAlerts'), false);
  assert.equal(store.get('castTimers'), false, 'an inert stored timer flag must not spring to life');
  assert.equal(alertsEnabled(store.all), false);
});

test('a config already carrying the new keys is left exactly as written', () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ castAlerts: false, summonAlerts: true, ccAlerts: false, castTimers: true })
  );

  const store = new ConfigStore(dir);
  store.load();
  assert.equal(store.get('summonAlerts'), true, 'the migration must not fire a second time');
  assert.equal(store.get('castTimers'), true);
  assert.equal(alertsEnabled(store.all), true);
});

test('a config with alerts on is untouched by the migration', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ castAlerts: true }));

  const store = new ConfigStore(dir);
  store.load();
  assert.equal(store.get('summonAlerts'), DEFAULTS.summonAlerts);
  assert.equal(store.get('ccAlerts'), DEFAULTS.ccAlerts);
  assert.equal(store.get('castTimers'), DEFAULTS.castTimers);
});

test('the mute hotkey has a default binding that clashes with nothing else', () => {
  const bindings = Object.values(DEFAULTS.hotkeys);
  assert.equal(bindings.length, new Set(bindings).size, 'two actions on one accelerator');
  assert.equal(DEFAULTS.hotkeys.toggleAlerts, 'Control+Shift+A');
});

test('the pet mapping is replaced wholesale, so an entry can be removed', () => {
  // A merge would make a deleted mapping immortal: the old key would survive every save.
  const store = new ConfigStore(tmpdir());
  store.load();
  store.set({ petOwners: { Gann: 'Rhain', Bixie: 'Emalina' } });
  store.set({ petOwners: { Gann: 'Rhain' } });

  assert.deepEqual(store.get('petOwners'), { Gann: 'Rhain' });
});
