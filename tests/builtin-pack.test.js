import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_ID, BUILTIN_ROWS, BUILTIN_KEYS,
  builtinPack, builtinPatch, builtinPresetPatch, builtinRowOn, builtinMatches, builtinRecipe,
} from '../src/main/builtin-pack.js';
import { DEFAULTS, ALERT_PRESETS, WARN_GROUPS, warnKeyFor } from '../src/main/config.js';
import { RULE_IDS, ruleSource } from '../src/parser/rules.js';
import { SPELL_PATTERNS } from '../src/parser/spellwatch.js';

test('every row names a real config key', () => {
  // The whole shim is this mapping. A row pointing at a key that does not exist would
  // render a switch that writes nothing and reads as "on" forever.
  for (const key of BUILTIN_KEYS) {
    assert.ok(key in DEFAULTS, `${key} is not a config key`);
  }
});

test('the six warning groups are all present, under the casts row', () => {
  for (const group of WARN_GROUPS) {
    const row = BUILTIN_ROWS.find((r) => r.key === warnKeyFor(group));
    assert.ok(row, `no row for ${group}`);
    assert.equal(row.parent, 'castAlerts');
    assert.equal(row.kind, 'rule');
  }
});

test('the defaults render as the Balanced preset', () => {
  // Pins the same invariant config.js pins from the other side: DEFAULTS *is* balanced,
  // so the window must light that button on a fresh install rather than "Custom".
  assert.equal(builtinPack(DEFAULTS).preset, 'balanced');
});

test('a row reads its config key, and a missing warn key falls back to its default', () => {
  assert.equal(builtinRowOn(DEFAULTS, 'castAlerts'), true);
  assert.equal(builtinRowOn({ ...DEFAULTS, castAlerts: false }, 'castAlerts'), false);

  // warnRoutine defaults OFF, and absence must read as that default rather than as on —
  // "absent means on" here would restore the 64-an-hour flood the groups exist to fix.
  assert.equal(builtinRowOn({}, 'warnRoutine'), false);
  assert.equal(builtinRowOn({}, 'warnHeals'), true);

  // Everything outside the six keeps the older rule: absent means on, so a config that
  // predates a surface does not silently lose it.
  assert.equal(builtinRowOn({}, 'summonAlerts'), true);
});

test('a child row is marked inert when its parent is off', () => {
  const pack = builtinPack({ ...DEFAULTS, castAlerts: false });
  const heals = pack.rows.find((r) => r.key === 'warnHeals');
  assert.equal(heals.inert, true);
  // Inert is not the same as off: the player's own choice underneath is untouched, so
  // switching the parent back on restores exactly what they had.
  assert.equal(heals.enabled, true);

  const summons = pack.rows.find((r) => r.key === 'summonAlerts');
  assert.equal(summons.inert, false, 'a top-level row has no parent to be inert under');
});

test('the pack switch is derived from its rows, and ignores the sound option', () => {
  assert.equal(builtinPack(DEFAULTS).enabled, true);

  const allOff = { ...DEFAULTS };
  for (const row of BUILTIN_ROWS) if (row.kind !== 'option') allOff[row.key] = false;
  assert.equal(builtinPack(allOff).enabled, false);

  // The sound is a modifier on a warning, not a warning — a pack that is silent except
  // for a cue switch must still read as off.
  assert.equal(builtinPack({ ...allOff, castAlertSound: true }).enabled, false);
});

test('stats count switchable rows only', () => {
  const pack = builtinPack(DEFAULTS);
  const switchable = BUILTIN_ROWS.filter((r) => r.kind !== 'option');
  assert.equal(pack.stats.rules, switchable.length);
  assert.ok(pack.stats.on > 0 && pack.stats.on <= pack.stats.rules);
});

test('the pack cannot be removed or exported', () => {
  const pack = builtinPack(DEFAULTS);
  assert.equal(pack.id, BUILTIN_ID);
  assert.equal(pack.removable, false);
  assert.equal(pack.exportable, false);
  assert.equal(pack.origin, 'builtin');
});

test('a patch is refused for a key the pack does not own', () => {
  // The key arrives from a renderer. Without this, a typo — or a window that had been
  // tampered with — could set any config key that happened to share the name.
  assert.deepEqual(builtinPatch('castAlerts', false), { castAlerts: false });
  assert.equal(builtinPatch('logPath', '/etc/passwd'), null);
  assert.equal(builtinPatch('opacity', 0), null);
  assert.equal(builtinPatch('', true), null);
});

test('a patch always writes a boolean, whatever the renderer sent', () => {
  assert.deepEqual(builtinPatch('summonAlerts', 'yes'), { summonAlerts: true });
  assert.deepEqual(builtinPatch('summonAlerts', 0), { summonAlerts: false });
  assert.deepEqual(builtinPatch('summonAlerts', undefined), { summonAlerts: false });
});

test('a preset patch states all six switches, and an unknown name writes nothing', () => {
  for (const [name, preset] of Object.entries(ALERT_PRESETS)) {
    assert.deepEqual(builtinPresetPatch(name), preset);
    assert.equal(Object.keys(builtinPresetPatch(name)).length, WARN_GROUPS.length);
  }
  assert.equal(builtinPresetPatch('quiet'), null);
});

test('a preset patch is a copy, so a caller cannot mutate the shared table', () => {
  const patch = builtinPresetPatch('essential');
  patch.warnHeals = false;
  assert.equal(ALERT_PRESETS.essential.warnHeals, true);
});

test('rows carry the copy the window renders, and never a firing rate', () => {
  // Rates were removed on purpose: they were measured over a log that is mostly not
  // raid time, so "~7/hr" averaged over hours the player was not in the content the
  // number implied. An imported pack's hit count is a count against a stated number of
  // lines and is still shown; nothing here may reintroduce a rate.
  for (const row of BUILTIN_ROWS) {
    assert.ok(row.name && row.sub && row.why, `${row.key} is missing its copy`);
    const text = `${row.name} ${row.sub} ${row.why}`;
    assert.doesNotMatch(text, /\/hr|per hour/i, `${row.key} quotes a firing rate`);
  }
});

// ------------------------------------------------------- the patterns behind a row

test('every rule a row names is a real rule with a real pattern', () => {
  // The window shows these as the answer to "what does this actually match". A row
  // pointing at an id nothing answers to would show an empty section and say nothing.
  for (const row of BUILTIN_ROWS) {
    for (const id of row.lineRules ?? []) {
      assert.ok(RULE_IDS.includes(id), `${row.key} names "${id}", which is not a rule`);
      assert.ok(ruleSource(id), `${id} has no pattern`);
    }
  }
  assert.equal(ruleSource('no-such-rule'), null);
});

test('every derived pattern compiles', () => {
  for (const row of BUILTIN_ROWS) {
    const { lines, spells } = builtinMatches(row);
    for (const line of lines) new RegExp(line.source);
    for (const spell of spells) new RegExp(spell.source);
    const recipe = builtinRecipe(row);
    if (recipe) new RegExp(recipe.pattern);
  }
});

test('a row’s spells come from the live table, filtered to its own group', () => {
  const heals = BUILTIN_ROWS.find((r) => r.key === warnKeyFor('heals'));
  const expected = SPELL_PATTERNS.filter((p) => p.group === 'heals');
  assert.deepEqual(
    builtinMatches(heals).spells.map((s) => s.category),
    expected.map((s) => s.category),
  );
  assert.ok(expected.length > 0, 'the heals group must have patterns to show');

  // The unrecognized-casts row is the group a cast lands in when nothing claimed it, so
  // it genuinely has no patterns of its own — that is the answer, not a gap.
  const unknown = BUILTIN_ROWS.find((r) => r.key === warnKeyFor('unknown'));
  assert.deepEqual(builtinMatches(unknown).spells, []);
});

test('every shipped example is matched by at least one of its row’s rules', () => {
  // The anti-drift guard, and it has already earned its keep: every cast example here
  // used to read "begins to cast X", wording that appears nowhere in 983,000 lines of
  // real log and that `rules.js` has never matched.
  for (const row of BUILTIN_ROWS) {
    const patterns = builtinMatches(row).lines.map((l) => new RegExp(l.source));
    for (const sample of row.catches) {
      assert.ok(patterns.some((re) => re.test(sample)),
        `${row.key}: nothing this row runs matches "${sample}"`);
    }
  }
});

test('a recipe matches every example its own rule matches', () => {
  // The recipe is composed from the row's FIRST rule, so a row backed by several — CC is
  // matched by four different lines — has examples only its other rules see. What must
  // hold is that the recipe never loses one belonging to the rule it was built from,
  // which is what checks the case-folding transform the group filter needs.
  for (const row of BUILTIN_ROWS) {
    const recipe = builtinRecipe(row);
    if (!recipe) continue;
    const own = new RegExp(builtinMatches(row).lines[0].source);
    const re = new RegExp(recipe.pattern);
    for (const sample of row.catches) {
      if (!own.test(sample)) continue;
      assert.ok(re.test(sample), `${row.key}: the recipe dropped "${sample}"`);
    }
  }
});

test('a group recipe rejects a cast belonging to a different group', () => {
  // Without this the filter could quietly become a no-op and every recipe would still
  // pass the test above by matching everything.
  const recipeFor = (group) => new RegExp(
    builtinRecipe(BUILTIN_ROWS.find((r) => r.key === warnKeyFor(group))).pattern,
  );
  assert.equal(recipeFor('heals').test('A deadly black widow begins casting Ensnare.'), false);
  assert.equal(recipeFor('locks').test('A ghoul savant begins casting Superior Healing.'), false);
  // "Unrecognized" is defined by everything else, so its pattern is the negative of the
  // whole table — a spell the table DOES name must fall out of it.
  assert.equal(recipeFor('unknown').test('A ghoul savant begins casting Superior Healing.'), false);
  assert.equal(recipeFor('unknown').test('Bazzt Zzzt begins casting Rotting Flesh.'), true);
});

test('a recipe names the captures its own SHOW text references', () => {
  // A rules.js edit that changed a group's shape would otherwise ship a trigger whose
  // chip renders blanks — `${mob}` against a group that is no longer called mob.
  for (const row of BUILTIN_ROWS) {
    const recipe = builtinRecipe(row);
    if (!recipe) continue;
    for (const [, name] of recipe.warnText.matchAll(/\$\{(\w+)\}/g)) {
      assert.ok(recipe.pattern.includes(`(?<${name}>`),
        `${row.key}: SHOW says \${${name}} and the pattern never captures one`);
    }
  }
});

test('a row that is a modifier rather than a rule has no recipe to copy', () => {
  // The sound switch is not a thing that matches, so there is nothing to hand the editor.
  const sound = BUILTIN_ROWS.find((r) => r.key === 'castAlertSound');
  assert.equal(builtinRecipe(sound), null);
  assert.equal(builtinRecipe(null), null);
});

test('a recipe arrives in the field names the editor draft already uses', () => {
  const recipe = builtinRecipe(BUILTIN_ROWS.find((r) => r.key === 'summonAlerts'));
  assert.deepEqual(Object.keys(recipe).sort(),
    ['durationSec', 'literal', 'name', 'pattern', 'timerKind', 'warnText']);
  assert.equal(recipe.literal, false);
  assert.equal(recipe.timerKind, 'none');
});

test('every row draws to the alerts window, and none of them to the timers', () => {
  // The boss timers used to be a row here. They left because they became a real trigger
  // pack — a pattern and a duration a player can read — which is the whole point of the
  // change this file's header describes. Nothing may quietly move back.
  assert.deepEqual([...new Set(BUILTIN_ROWS.map((r) => r.surface))], ['chips']);
});
