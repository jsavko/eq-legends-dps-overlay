import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConfigStore, DEFAULTS, DEFAULT_LOG_DIR, alertsEnabled, timersEnabled, dropsEnabled,
  ALERT_CATEGORIES, ALERT_PRESETS, TIMER_KEYS, WARN_GROUPS, WARN_KEYS,
  warnKeyFor, warnGroupOn, presetOf,
  SESSION_CATEGORIES, sessionEnabled, sessionLineEnabled, sessionCategories, partyListFor,
  DURATION_DEFAULTS, DURATION_KEYS, durationSec, alertTtls,
} from '../src/main/config.js';
import { GROUPS, UNKNOWN_GROUP } from '../src/parser/spellwatch.js';
import { SESSION_RULES } from '../src/session/rules.js';
import {
  HOSTILE_CAST_TTL_MS, SUMMON_TTL_MS, CHARM_BREAK_TTL_MS, NOTICE_TTL_MS,
} from '../src/parser/index.js';
import { TRIGGER_WARN_TTL_MS } from '../src/triggers/engine.js';

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
  a.set({ opacity: 0.5, partyMembers: { Rhale_oggok: ['Rhain', 'Emalina'] } });

  const b = new ConfigStore(dir);
  b.load();
  assert.equal(b.get('opacity'), 0.5);
  assert.deepEqual(b.get('partyMembers'), { Rhale_oggok: ['Rhain', 'Emalina'] });
  assert.equal(b.get('scale'), DEFAULTS.scale, 'untouched keys keep their defaults');
});

test('a partial hotkey patch keeps the other bindings', () => {
  const store = new ConfigStore(tmpdir());
  store.load();
  store.set({ hotkeys: { toggleLock: 'Control+Alt+D' } });

  assert.equal(store.get('hotkeys').toggleLock, 'Control+Alt+D');
  assert.equal(store.get('hotkeys').toggleVisible, DEFAULTS.hotkeys.toggleVisible);
});

test('a config written before a hotkey existed gains it rather than losing the binding', () => {
  const dir = tmpdir();
  // Every binding the previous version knew about, and none it did not — which is exactly
  // what an upgrading player's config.json looks like on the first launch after this ships.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    hotkeys: {
      toggleLock: 'Control+Alt+D',
      toggleVisible: 'Control+Shift+H',
      resetEncounter: 'Control+Shift+R',
      toggleMetric: 'Control+Shift+M',
      toggleAlerts: 'Control+Shift+A',
    },
  }));

  const store = new ConfigStore(dir);
  store.load();
  // One pair of lines per binding added since: the fixture above is frozen at the shape
  // that shipped, so every later gesture is exercised as a config that has never seen it.
  assert.ok(DEFAULTS.hotkeys.newSession, 'the new-session gesture ships with a binding');
  assert.equal(store.get('hotkeys').newSession, DEFAULTS.hotkeys.newSession);
  assert.ok(DEFAULTS.hotkeys.copyReport, 'the copy gesture ships with a binding');
  assert.equal(store.get('hotkeys').copyReport, DEFAULTS.hotkeys.copyReport);
  assert.ok(DEFAULTS.hotkeys.openQuests, 'the quest-window gesture ships with a binding');
  assert.equal(store.get('hotkeys').openQuests, DEFAULTS.hotkeys.openQuests);
  assert.equal(store.get('hotkeys').toggleLock, 'Control+Alt+D', 'their own choices survive');
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
  store.set({ combatTimeoutSec: 20, postKillGraceSec: 4, rollingWindowSec: 6 });

  // The party list is deliberately NOT here: it is per character, and the character is
  // not known until the log filename is parsed. main applies it separately.
  assert.deepEqual(store.parserOptions(), {
    timeoutMs: 20_000,
    postKillGraceMs: 4_000,
    rollingWindowMs: 6_000,
    petOwners: {},
    alertTtls: {
      hostileCastMs: 6000, summonMs: 5000, charmBreakMs: 6000, noticeMs: 6000,
    },
  });
});

// --------------------------------------------------------------- alert switches

/** A config with every alert category off, to switch one back on per case. */
const NO_ALERTS = {
  castAlerts: false, summonAlerts: false, ccAlerts: false, charmBreakAlerts: false,
  questLootAlerts: false, triggerAlerts: false, triggerTimers: false,
};

test('any single alert category keeps the alert window alive', () => {
  // Driven off ALERT_CATEGORIES rather than a list typed here, so a category added
  // without being wired into the predicate fails loudly instead of going untested.
  for (const key of ALERT_CATEGORIES) {
    assert.equal(
      alertsEnabled({ ...NO_ALERTS, [key]: true }), true,
      `${key} alone must be enough to justify the window`
    );
  }
});

test('every alert category has a default, and NO_ALERTS covers all of them', () => {
  for (const key of ALERT_CATEGORIES) assert.equal(typeof DEFAULTS[key], 'boolean', key);
  for (const key of ALERT_CATEGORIES) assert.equal(key in NO_ALERTS, true, key);
});

test('the timers are no longer an alert category — they have their own window', () => {
  // The alert window must not exist for a surface it no longer draws: an otherwise
  // silent player with only the timers on would get an empty renderer process.
  assert.equal(alertsEnabled({ ...NO_ALERTS, triggerTimers: true }), false);
  assert.equal(timersEnabled({ ...NO_ALERTS, triggerTimers: true }), true);
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
  assert.equal(timersEnabled({}), true, 'a missing triggerTimers reads as its default');
});

test('the timers window follows one switch, and loses to mute', () => {
  // One switch, not two. The second covered the countdowns this app learned by watching
  // a boss, and nothing learns any more — every row in that panel comes from a pack now,
  // including the one we ship. See TIMER_KEYS and migrateTimers.
  assert.deepEqual(TIMER_KEYS, ['triggerTimers', 'alertsMuted']);
  assert.equal('castTimers' in DEFAULTS, false, 'the learned-timer key is gone');
  assert.equal(timersEnabled(DEFAULTS), true, 'a fresh install shows timers');
  assert.equal(timersEnabled({ ...DEFAULTS, triggerTimers: false }), false);

  // Mute is "shut up for this pull", and a panel that survived it would be the one
  // surface ignoring the hotkey — while the preference underneath stays untouched.
  const muted = { ...DEFAULTS, alertsMuted: true };
  assert.equal(timersEnabled(muted), false);
  assert.equal(muted.triggerTimers, true);
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
  assert.equal('castTimers' in store.all, false, 'the retired key does not survive a load');
  // The trigger keys are absent from a config this old, so without the migration they
  // would arrive from DEFAULTS switched ON and hand a chip stack to a player who had
  // silence for months.
  assert.equal(store.get('triggerAlerts'), false);
  assert.equal(store.get('triggerTimers'), false);
  assert.equal(alertsEnabled(store.all), false);
  assert.equal(timersEnabled(store.all), false, 'and no timer window springs up either');
});

test('the retired group-only switch migrates to no filter at all', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ groupOnly: true, opacity: 0.7 }));

  const store = new ConfigStore(dir);
  store.load();
  assert.equal('groupOnly' in store.all, false, 'the retired key does not survive a load');
  // Empty, i.e. showing everyone. There is nothing honest to migrate it to: the names
  // it was hiding came from what the parser inferred about the group at the time, and
  // that set does not exist until a log is read. Showing more is also the safe direction
  // to be wrong in — an extra row is one line of settings away from gone, whereas the
  // missing row this whole change exists to fix said nothing at all.
  assert.deepEqual(store.get('partyMembers'), {});
  assert.equal(store.get('opacity'), 0.7, 'the rest of the config is untouched');
});

test('a party list written while it was global cannot be attributed, so it clears', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'),
    JSON.stringify({ partyMembers: ['Rhain', 'Emalina'] }));

  const store = new ConfigStore(dir);
  store.load();
  // The config never recorded WHICH character was logged in when those names were typed,
  // so there is nobody to hand them to. Showing everyone is the safe direction.
  assert.deepEqual(store.get('partyMembers'), {});
});

test('the party list is per character, and one character cannot filter another', () => {
  const store = new ConfigStore(tmpdir());
  store.load();
  store.set({ partyMembers: { Rhale_oggok: ['Rhain'], Fuaim_oggok: [] } });

  assert.deepEqual(partyListFor(store.all, 'Rhale', 'oggok'), ['Rhain']);
  assert.deepEqual(partyListFor(store.all, 'Fuaim', 'oggok'), [], 'empty means no filter');
  assert.deepEqual(partyListFor(store.all, 'Nobody', 'oggok'), [], 'and so does absent');
  // A stale global array must never be read as one character's list.
  assert.deepEqual(partyListFor({ partyMembers: ['Rhain'] }, 'Rhale', 'oggok'), []);
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
  assert.equal(store.get('triggerTimers'), true, 'a stored castTimers: true still means timers');
  assert.equal(alertsEnabled(store.all), true);
});

test('a config from when the timers had two switches keeps its countdowns', () => {
  // They asked for countdowns, and there is now exactly one place countdowns come from —
  // one that covers the bosses the learned column used to. Either key being on keeps the
  // panel on; only a config that had switched both off gets silence.
  for (const [stored, expected] of [
    [{ castTimers: true, triggerTimers: false }, true],
    [{ castTimers: false, triggerTimers: true }, true],
    [{ castTimers: true, triggerTimers: true }, true],
    [{ castTimers: false, triggerTimers: false }, false],
  ]) {
    const dir = tmpdir();
    // summonAlerts present, so the older alerts migration cannot also fire and confuse
    // which rule produced the answer.
    fs.writeFileSync(path.join(dir, 'config.json'),
      JSON.stringify({ summonAlerts: true, ...stored }));
    const store = new ConfigStore(dir);
    store.load();
    assert.equal(store.get('triggerTimers'), expected, JSON.stringify(stored));
    assert.equal('castTimers' in store.all, false, 'and the retired key is not carried forward');
  }
});

test('a config with alerts on is untouched by the migration', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ castAlerts: true }));

  const store = new ConfigStore(dir);
  store.load();
  assert.equal(store.get('summonAlerts'), DEFAULTS.summonAlerts);
  assert.equal(store.get('ccAlerts'), DEFAULTS.ccAlerts);
  assert.equal(store.get('triggerTimers'), DEFAULTS.triggerTimers);
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

// -------------------------------------------------------------------- session stats

test('session tracking ships off, and its categories ship on', () => {
  // The master is what protects the raid HUD, and nothing the categories gate can reach
  // the screen while it is off — so categories default ON. A master switch that turns on
  // nothing is not a preference, it is a feature that looks broken the first time it is
  // used.
  assert.equal(DEFAULTS.session.enabled, false);
  assert.equal(DEFAULTS.session.meterLine, false);
  for (const c of SESSION_CATEGORIES) {
    assert.equal(DEFAULTS.session[c], true, `${c} should ship on`);
  }
});

test('every session category has rules behind it, and every rule a category', () => {
  const used = new Set(SESSION_RULES.map((r) => r.category));
  for (const c of SESSION_CATEGORIES) {
    assert.ok(used.has(c), `${c} is a switch with no rules behind it`);
  }
  for (const c of used) {
    assert.ok(SESSION_CATEGORIES.includes(c), `${c} is data the player cannot switch off`);
  }
});

test('sessionEnabled and sessionLineEnabled both require the master', () => {
  assert.equal(sessionEnabled(DEFAULTS), false);
  assert.equal(sessionEnabled({ session: { enabled: true } }), true);
  assert.equal(sessionEnabled({}), false, 'a config predating the block reads as off');
  assert.equal(sessionEnabled(null), false);

  assert.equal(sessionLineEnabled({ session: { enabled: true, meterLine: true } }), true);
  assert.equal(sessionLineEnabled({ session: { enabled: false, meterLine: true } }), false,
    'the line cannot draw from a tracker that was never constructed');
  assert.equal(sessionLineEnabled({ session: { enabled: true, meterLine: false } }), false);
});

test('sessionCategories hands the tracker seven booleans and nothing else', () => {
  const cats = sessionCategories({ session: { enabled: true, meterLine: true, coin: false } });
  assert.deepEqual(Object.keys(cats).sort(), [...SESSION_CATEGORIES].sort());
  assert.equal(cats.coin, false);
  assert.equal(cats.kills, true, 'an absent category reads as on');
  assert.equal('enabled' in cats, false, 'the master is not a category');
  assert.equal('meterLine' in cats, false);
});

test('a config predating the session block gains it whole, off, without losing anything', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ opacity: 0.5, scale: 1.2 }));

  const store = new ConfigStore(dir);
  store.load();
  assert.equal(store.get('session').enabled, false);
  assert.equal(store.get('session').kills, true);
  assert.equal(store.get('opacity'), 0.5, 'unrelated settings must survive');
});

test('setting one session key merges rather than replacing the block', () => {
  const store = new ConfigStore(tmpdir());
  store.load();
  store.set({ session: { enabled: true } });

  assert.equal(store.get('session').enabled, true);
  assert.equal(store.get('session').coin, true, 'the other seven must survive the patch');
  assert.equal(store.get('session').meterLine, false);
});

test('the session window has its own bounds key, derived from nobody', () => {
  assert.equal(DEFAULTS.sessionBounds, null);
  // Every window keeps its own; deriving one from another's live bounds is the historical
  // "window climbs the screen" bug.
  const keys = ['bounds', 'alertsBounds', 'timersBounds', 'historyBounds', 'triggersBounds', 'sessionBounds'];
  assert.equal(new Set(keys).size, keys.length);
  for (const k of keys) assert.equal(k in DEFAULTS, true);
});

// ------------------------------------------------------- notification durations

test('the seven duration keys are in DEFAULTS, at exactly the values they replaced', () => {
  // Behavior-preserving is the whole promise: each default IS the constant it
  // replaced, so a config that never opens the Durations dialog changes nothing.
  assert.deepEqual(DURATION_DEFAULTS, {
    castChipSec: 6,
    summonChipSec: 5,
    charmBreakChipSec: 6,
    questChipSec: 6,
    noticeChipSec: 6,
    triggerChipSec: 8,
    toastSec: 2.6,
  });
  assert.deepEqual(DURATION_KEYS, Object.keys(DURATION_DEFAULTS));
  for (const key of DURATION_KEYS) assert.equal(DEFAULTS[key], DURATION_DEFAULTS[key]);
});

test('the duration defaults match the constants they replaced, by import', () => {
  assert.equal(DURATION_DEFAULTS.castChipSec * 1000, HOSTILE_CAST_TTL_MS);
  assert.equal(DURATION_DEFAULTS.summonChipSec * 1000, SUMMON_TTL_MS);
  assert.equal(DURATION_DEFAULTS.charmBreakChipSec * 1000, CHARM_BREAK_TTL_MS);
  assert.equal(DURATION_DEFAULTS.noticeChipSec * 1000, NOTICE_TTL_MS);
  assert.equal(DURATION_DEFAULTS.triggerChipSec * 1000, TRIGGER_WARN_TTL_MS);
});

test('durationSec clamps at read time, so a hand-edited config cannot smuggle a zero', () => {
  assert.equal(durationSec({ castChipSec: 12 }, 'castChipSec'), 12);
  assert.equal(durationSec({ castChipSec: 0 }, 'castChipSec'), 1, 'a 0s chip reads as broken alerts');
  assert.equal(durationSec({ castChipSec: 600 }, 'castChipSec'), 30);
  assert.equal(durationSec({ castChipSec: 'fast' }, 'castChipSec'), 6, 'garbage reads as the default');
  assert.equal(durationSec({}, 'toastSec'), 2.6);
  assert.equal(durationSec(null, 'summonChipSec'), 5);
});

test('alertTtls hands the parser its four lifetimes in ms, clamped', () => {
  assert.deepEqual(alertTtls({}), {
    hostileCastMs: 6000, summonMs: 5000, charmBreakMs: 6000, noticeMs: 6000,
  });
  const tuned = alertTtls({ castChipSec: 10, noticeChipSec: 0 });
  assert.equal(tuned.hostileCastMs, 10_000);
  assert.equal(tuned.noticeMs, 1000, 'the clamp rides along');
});

test('parserOptions carries alertTtls, so a new parser is born with the tuned values', () => {
  const store = new ConfigStore(tmpdir());
  store.load();
  store.set({ castChipSec: 9 });
  assert.equal(store.parserOptions().alertTtls.hostileCastMs, 9000);
  assert.equal(store.parserOptions().alertTtls.summonMs, 5000);
});

test('duration values round-trip through disk like any other setting', () => {
  const dir = tmpdir();
  const a = new ConfigStore(dir);
  a.load();
  a.set({ questChipSec: 15, toastSec: 4 });

  const b = new ConfigStore(dir);
  b.load();
  assert.equal(b.get('questChipSec'), 15);
  assert.equal(b.get('toastSec'), 4);
  assert.equal(b.get('summonChipSec'), 5, 'untouched categories keep their defaults');
});

test('the drops popup has one switch, and mute wins over it like the timers', () => {
  assert.equal(dropsEnabled(DEFAULTS), true, 'a fresh install shows needed drops on engage');
  assert.equal(dropsEnabled({ ...DEFAULTS, dropsOverlay: false }), false);
  assert.equal(dropsEnabled({ ...DEFAULTS, alertsMuted: true }), false, 'mute silences every consult surface');
  // A config predating the key must not silently swallow the feature.
  const legacy = { ...DEFAULTS };
  delete legacy.dropsOverlay;
  assert.equal(dropsEnabled(legacy), true);
});
