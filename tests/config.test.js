import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConfigStore, DEFAULTS, DEFAULT_LOG_DIR, alertsEnabled, timersEnabled,
  ALERT_PRESETS, WARN_GROUPS, WARN_KEYS, warnKeyFor, warnGroupOn, presetOf,
} from '../src/main/config.js';
import { GROUPS, UNKNOWN_GROUP } from '../src/parser/spellwatch.js';

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
  for (const key of ['castAlerts', 'summonAlerts', 'ccAlerts']) {
    assert.equal(
      alertsEnabled({ ...NO_ALERTS, [key]: true }), true,
      `${key} alone must be enough to justify the window`
    );
  }
});

test('the timers are no longer an alert category — they have their own window', () => {
  // The alert window must not exist for a surface it no longer draws: an otherwise
  // silent player with only the timers on would get an empty renderer process.
  assert.equal(alertsEnabled({ ...NO_ALERTS, castTimers: true }), false);
  assert.equal(timersEnabled({ ...NO_ALERTS, castTimers: true }), true);
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
  assert.equal(alertsEnabled({ castAlerts: false, summonAlerts: false }), true, 'ccAlerts is missing, so on');
  assert.equal(timersEnabled({}), true, 'a missing castTimers reads as its default');
});

test('the timers window follows its own switch, and loses to mute', () => {
  assert.equal(timersEnabled(DEFAULTS), true, 'a fresh install shows timers');
  assert.equal(timersEnabled({ ...DEFAULTS, castTimers: false }), false);

  // Mute is "shut up for this pull", and a panel that survived it would be the one
  // surface ignoring the hotkey — while the preference underneath stays untouched.
  const muted = { ...DEFAULTS, alertsMuted: true };
  assert.equal(timersEnabled(muted), false);
  assert.equal(muted.castTimers, true);
  assert.equal(timersEnabled({ ...muted, alertsMuted: false }), true);
});

test('the timers window has bounds of its own, defaulting to unplaced', () => {
  // Its own key is what keeps its placement independent of the meter's, which moves
  // itself constantly — see the "window climbs the screen" history in layout.js.
  assert.equal(DEFAULTS.timersBounds, null);
  assert.ok('alertsBounds' in DEFAULTS && 'bounds' in DEFAULTS, 'three windows, three keys');
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
  assert.equal(timersEnabled(store.all), false, 'and no timer window springs up either');
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

// ------------------------------------------------- the six warning-group switches

test('every warning group a spell can carry has a switch, and vice versa', () => {
  // The check that stops a group being added to spellwatch with no way to turn it off —
  // it would be permanently on, gated by a config key nobody ever wrote. `buff` is the
  // one deliberate exception: it is suppressed at every setting and answers to nothing.
  const gated = GROUPS.filter((g) => g !== 'buff');
  assert.deepEqual([...WARN_GROUPS].sort(), [...gated, UNKNOWN_GROUP].sort());
});

test('the group-to-key convention resolves against DEFAULTS', () => {
  // The convention is duplicated in two renderers that cannot import this module, so a
  // group whose key does not exist here would fail silently over there.
  for (const group of WARN_GROUPS) {
    assert.ok(warnKeyFor(group) in DEFAULTS, `${group} has no ${warnKeyFor(group)} default`);
  }
  assert.equal(warnKeyFor('bigHits'), 'warnBigHits');
  assert.equal(warnKeyFor('heals'), 'warnHeals');
});

test('every preset states all six switches, never a partial patch', () => {
  // A partial preset would leave whatever was on before still on, so "Essential" after
  // "Everything" would silently do almost nothing.
  for (const [name, preset] of Object.entries(ALERT_PRESETS)) {
    assert.deepEqual(Object.keys(preset).sort(), [...WARN_KEYS].sort(), `${name} is partial`);
  }
});

test('the shipped defaults ARE the balanced preset', () => {
  // The test that stops the default and the preset drifting apart: if they ever
  // disagree, a fresh install opens on "Custom" with nothing lit.
  assert.equal(presetOf(DEFAULTS), 'balanced');
});

test('presetOf names each preset and returns null for a mixed state', () => {
  for (const [name, preset] of Object.entries(ALERT_PRESETS)) {
    assert.equal(presetOf(preset), name);
  }
  assert.equal(presetOf({ ...ALERT_PRESETS.balanced, warnHeals: false }), null);
  assert.equal(presetOf(null), null);
});

test('a missing group key reads as its default, not as on', () => {
  // The deliberate departure from the alertsEnabled rule. "Absent means on" exists to
  // protect a choice the player MADE; nobody chose these, and treating absent as on
  // would restore the 64-an-hour flood the groups exist to end.
  assert.equal(warnGroupOn({}, 'warnUnknown'), false);
  assert.equal(warnGroupOn({}, 'warnRoutine'), false);
  assert.equal(warnGroupOn({}, 'warnHeals'), true);
  assert.equal(warnGroupOn({ warnHeals: false }, 'warnHeals'), false);
});

test('a config predating the groups gains them from DEFAULTS and lands on balanced', () => {
  // Deliberately NOT migrated: an existing install gets the quieter default, because
  // the behaviour a migration would preserve is the bug.
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ castAlerts: true, opacity: 0.5 }));

  const store = new ConfigStore(dir);
  store.load();
  assert.equal(presetOf(store.all), 'balanced');
  assert.equal(store.get('warnUnknown'), false);
  assert.equal(store.get('opacity'), 0.5, 'unrelated settings must survive');
});

test('the groups do not decide whether the alert window exists', () => {
  // Turning every group off silences the warnings but leaves summons and CC drawing,
  // so the window must stay. `castAlerts` is still the switch that means "no warnings".
  const allOff = Object.fromEntries(WARN_KEYS.map((k) => [k, false]));
  assert.equal(alertsEnabled({ ...DEFAULTS, ...allOff }), true);
});
