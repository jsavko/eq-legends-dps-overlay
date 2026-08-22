/**
 * The native pack format, and the GINA round trip.
 *
 * The round trip is the claim that makes "a sharable format that is compatible" mean
 * something: a pack written here has to come back out as a `.gtp` that GINA can open,
 * and a `.gtp` read in has to survive a trip through our format and back with its
 * mappable half unchanged. Export is lossy by construction, so the other half of the
 * test is that everything unmappable is REPORTED rather than quietly gone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readZip } from '../src/triggers/unzip.js';
import { writeZip, crc32 } from '../src/triggers/zipwrite.js';
import { parseGinaPackage } from '../src/triggers/gina.js';
import { exportGinaPackage, exportGinaXml, EXPORT_LOSSES } from '../src/triggers/gina-export.js';
import {
  normalize, validate, validateTrigger, packStats, buildTrigger,
  createTrigger, updateTrigger, deleteTrigger, myTriggersPack, compilePack, PACK_VERSION,
  BOSS_PANEL,
} from '../src/triggers/pack.js';
import { seedPack } from '../src/triggers/seed-pack.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gina');
const load = (name) => parseGinaPackage(fs.readFileSync(path.join(FIXTURES, name)), { name });
const FIXED = new Date(Date.UTC(2026, 7, 7, 12, 0, 0));

// -------------------------------------------------------------------- zip writer

test('the writer emits stored entries our own reader reads back', () => {
  const data = Buffer.from('<SharedData></SharedData>', 'utf8');
  const zip = writeZip([{ name: 'ShareData.xml', data }], { mtime: FIXED });

  const entries = readZip(zip);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'ShareData.xml');
  assert.deepEqual(entries[0].data, data);
});

test('the same pack exports byte-for-byte identically with a fixed timestamp', () => {
  const { pack } = load('sieve.gtp');
  const a = exportGinaPackage(pack, { mtime: FIXED }).buffer;
  const b = exportGinaPackage(pack, { mtime: FIXED }).buffer;
  assert.deepEqual(a, b);
});

test('CRC-32 matches the known check value', () => {
  // The standard IEEE check value for "123456789".
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

// ------------------------------------------------------------------- round trip

test('a GINA pack survives export and re-import with its mappable half intact', () => {
  const original = load('respawn-slice.gtp').pack;
  const { buffer, lost } = exportGinaPackage(original, { mtime: FIXED });
  const returned = parseGinaPackage(buffer, { name: 'respawn-slice.gtp' }).pack;

  assert.equal(returned.triggers.length, original.triggers.length);
  assert.deepEqual(returned.groups.map((g) => g.path), original.groups.map((g) => g.path));
  assert.deepEqual(returned.groups.map((g) => g.enabled), original.groups.map((g) => g.enabled));

  for (const [i, before] of original.triggers.entries()) {
    const after = returned.triggers[i];
    assert.equal(after.name, before.name, before.name);
    // The pattern is the thing that must not drift by a character.
    assert.equal(after.pattern, before.pattern, before.name);
    assert.equal(after.usesCharacter, before.usesCharacter, before.name);
    assert.deepEqual(after.timer.earlyEnders, before.timer.earlyEnders, before.name);
    assert.equal(after.timer.durationMs, before.timer.durationMs, before.name);
    assert.equal(after.timer.name, before.timer.name, before.name);
    assert.equal(after.timer.endingMs, before.timer.endingMs, before.name);
    assert.equal(after.timer.endingText, before.timer.endingText, before.name);
    assert.equal(after.timer.restart, before.timer.restart, before.name);
  }
  // Nothing in this pack is ours to lose — it came from GINA in the first place.
  assert.deepEqual(lost, []);
});

test('a warning-only pack round-trips its chip text', () => {
  const original = load('common-casting.gtp').pack;
  const returned = parseGinaPackage(exportGinaPackage(original, { mtime: FIXED }).buffer).pack;
  assert.deepEqual(
    returned.triggers.map((t) => t.warn.text),
    original.triggers.map((t) => t.warn.text),
  );
  // A speech-fallback chip exports as DisplayText and comes back as one: the trigger
  // still shows what it showed, which is what the fallback was for.
  assert.equal(returned.triggers.every((t) => t.warn.from === 'display'), true);
});

test('a literal trigger exports as an equivalent regex rather than as guessed-back text', () => {
  const original = load('common-casting.gtp').pack;
  const before = original.triggers.find((t) => t.name === 'Spell interrupted');
  assert.equal(before.literal, true);

  const returned = parseGinaPackage(exportGinaPackage(original, { mtime: FIXED }).buffer).pack;
  const after = returned.triggers.find((t) => t.name === 'Spell interrupted');
  // It comes back marked as a regex — un-escaping to recover the author's original text
  // would be guessing which backslashes were ours — but it matches the same lines.
  assert.equal(after.literal, false);
  assert.equal(after.pattern, before.pattern);
  assert.equal(compilePack({ ...returned, groups: returned.groups.map((g) => ({ ...g, enabled: true })) }, 'Rhale')
    .compiled.find((c) => c.trigger.name === 'Spell interrupted')
    .regex.test('Your spell is interrupted.'), true);
});

test('what GINA cannot express is reported, not silently dropped', () => {
  const pack = createTrigger(myTriggersPack(), {
    name: 'Mez incoming',
    pattern: '(?<mob>.*) begins to cast a spell',
    warnText: 'Mez: ${mob}',
    warnGroup: 'control',
    tier: 3,
    durationSec: 30,
    timerName: 'Mez ${mob}',
  }).pack;

  const { lost } = exportGinaXml(pack);
  const features = lost.map((l) => l.feature).sort();
  assert.deepEqual(features, [
    EXPORT_LOSSES.PROVENANCE,
    EXPORT_LOSSES.TIER,
    EXPORT_LOSSES.GROUP,
  ].sort());
  assert.equal(lost.every((l) => l.trigger === 'Mez incoming'), true);
});

test('an edited imported pack says so on export rather than passing as the original', () => {
  const imported = load('sieve.gtp').pack;
  assert.equal(imported.edited, false);
  assert.deepEqual(exportGinaXml(imported).lost, []);

  const edited = updateTrigger(imported, 't1', {
    name: 'sieve', pattern: '^(?<mob>.*) staggers\\.$', warnText: 'Sieve on ${mob}', durationSec: 60,
  }).pack;
  assert.equal(edited.edited, true);
  assert.equal(exportGinaXml(edited).lost.some((l) => l.feature === EXPORT_LOSSES.MODIFIED), true);
});

test('a native pack with no groups exports its triggers at the top level', () => {
  const pack = createTrigger(myTriggersPack(), {
    name: 'Yawn', pattern: '(?<mob>.*) yawns', warnText: 'Slowed: ${mob}',
  }).pack;
  const { xml } = exportGinaXml(pack);
  assert.match(xml, /<SharedData>\n {2}<Triggers>/);

  const returned = parseGinaPackage(xml).pack;
  assert.equal(returned.triggers.length, 1);
  assert.equal(returned.triggers[0].groupId, null);
  assert.equal(returned.triggers[0].warn.text, 'Slowed: ${mob}');
});

// -------------------------------------------------------------------- validation

test('normalize fills in everything optional, so consumers never branch on absence', () => {
  const pack = normalize({ id: 'x', triggers: [{ name: 'T', pattern: 'a' }] });
  assert.equal(pack.v, PACK_VERSION);
  assert.equal(pack.origin, 'gina');
  assert.equal(pack.enabled, true);
  assert.equal(pack.triggers[0].id, 't1');
  assert.equal(pack.triggers[0].warn, null);
  assert.equal(pack.triggers[0].timer, null);
  assert.equal(pack.triggers[0].provenance, 'imported');
  assert.deepEqual(normalize(null).triggers, []);
});

test('a timer with a zero or missing duration normalizes away rather than to a zero row', () => {
  assert.equal(normalize({ triggers: [{ name: 'T', pattern: 'a', timer: { durationMs: 0 } }] }).triggers[0].timer, null);
  assert.equal(normalize({ triggers: [{ name: 'T', pattern: 'a', timer: {} }] }).triggers[0].timer, null);
});

test('validation catches every problem at once, not one per round trip', () => {
  const { ok, errors } = validate({
    name: 'no id',
    triggers: [{ id: 't1', name: '', pattern: '(unclosed' }],
  });
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /no id/.test(e)), true);
  assert.equal(errors.some((e) => /a name is required/.test(e)), true);
  assert.equal(errors.some((e) => /does not compile/.test(e)), true);
  assert.equal(errors.some((e) => /must show something/.test(e)), true);
});

test('a pattern that will not compile is never saved', () => {
  const errors = validateTrigger({ name: 'Bad', pattern: '(?<dup>a)(?<dup>b)', warn: { text: 'x' } });
  // Duplicate names in the SAME alternative are still illegal even in ES2025.
  assert.equal(errors.some((e) => /does not compile/.test(e)), true);
});

test('a duration must be positive and shorter than a day', () => {
  const at = (durationMs) => validateTrigger({ name: 'T', pattern: 'a', timer: { durationMs } });
  assert.equal(at(0).some((e) => /above zero/.test(e)), true);
  assert.equal(at(-5).some((e) => /above zero/.test(e)), true);
  assert.equal(at(60_000).length, 0);
  // The ceiling exists because the timers panel has no scroll and a row never leaves
  // early: a fat-fingered duration would hold a slot until the app restarts.
  assert.equal(at(25 * 60 * 60 * 1000).some((e) => /longer than a day/.test(e)), true);
});

test('duplicate trigger ids are refused — they would collide in every map keyed by id', () => {
  const { ok, errors } = validate({
    id: 'p', name: 'p',
    triggers: [
      { id: 't1', name: 'A', pattern: 'a', warn: { text: 'a' } },
      { id: 't1', name: 'B', pattern: 'b', warn: { text: 'b' } },
    ],
  });
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /duplicate trigger id/.test(e)), true);
});

// --------------------------------------------------------------------- authoring

test('buildTrigger runs an authored pattern through the same token model as an import', () => {
  const t = buildTrigger({
    name: 'Slow', pattern: '(?<mob>.*) yawns', warnText: 'Slowed: ${mob}',
    durationSec: 310, timerName: 'Slow on ${mob}',
    earlyEndText: '${mob} is no longer slowed', earlyEndLiteral: true,
  }, 't1');

  assert.equal(t.pattern, '(?<mob>.*) yawns');
  assert.equal(t.provenance, 'authored');
  assert.equal(t.warn.from, 'authored');
  assert.equal(t.timer.durationMs, 310_000);
  // The early ender keeps its reference for arm-time resolution rather than escaping it.
  assert.equal(t.timer.earlyEnders[0].needsMatch, true);
  assert.match(t.timer.earlyEnders[0].pattern, /^\$\{mob\}/);
});

test('a trigger with no warning and no timer is refused at creation', () => {
  const result = createTrigger(myTriggersPack(), { name: 'Nothing', pattern: 'a line' });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((e) => /must show something/.test(e)), true);
  assert.equal(result.pack.triggers.length, 0, 'a rejected trigger must not be half-added');
});

test('create, update and delete return new packs and never mutate the old one', () => {
  const empty = myTriggersPack();
  const added = createTrigger(empty, { name: 'A', pattern: 'aaa', warnText: 'A!' });
  assert.equal(added.ok, true);
  assert.equal(empty.triggers.length, 0, 'the original pack must be untouched');
  assert.equal(added.pack.triggers.length, 1);
  assert.equal(added.trigger.id, 't1');

  const second = createTrigger(added.pack, { name: 'B', pattern: 'bbb', warnText: 'B!' });
  assert.equal(second.trigger.id, 't2');

  const changed = updateTrigger(second.pack, 't1', { name: 'A2', pattern: 'aaa', warnText: 'A2!' });
  assert.equal(changed.pack.triggers[0].name, 'A2');
  assert.equal(second.pack.triggers[0].name, 'A');

  const gone = deleteTrigger(changed.pack, 't1');
  assert.equal(gone.pack.triggers.map((t) => t.id).join(), 't2');
  assert.equal(deleteTrigger(gone.pack, 'nope').ok, false);
});

test('the editor can make a group, and reuses one that already has the name', () => {
  // Until now a player could only ever inherit somebody else's groups — the form could
  // file a trigger into an existing one and there was no way at all to make one.
  const first = createTrigger(myTriggersPack(), {
    name: 'A', pattern: 'aaa', warnText: 'A!', newGroupName: 'Lady Vox',
  });
  assert.equal(first.pack.groups.length, 1);
  assert.equal(first.pack.groups[0].name, 'Lady Vox');
  assert.equal(first.trigger.groupId, first.pack.groups[0].id);

  // The same name again is the group they meant, not a second one wearing its label —
  // two identically-named rows would be a switch whose effect you could only find by
  // trying it. Case is not a distinction anybody intends here.
  const second = createTrigger(first.pack, {
    name: 'B', pattern: 'bbb', warnText: 'B!', newGroupName: 'lady vox',
  });
  assert.equal(second.pack.groups.length, 1);
  assert.equal(second.trigger.groupId, first.trigger.groupId);

  const third = createTrigger(second.pack, {
    name: 'C', pattern: 'ccc', warnText: 'C!', newGroupName: 'Lord Nagafen',
  });
  assert.deepEqual(third.pack.groups.map((g) => g.id), ['g1', 'g2']);
});

test('a rejected trigger leaves no empty group behind', () => {
  // A save that did not happen must not change the pack — an orphan group in the list
  // would be a change the player never asked for.
  const bad = createTrigger(myTriggersPack(), {
    name: 'A', pattern: '(unclosed', warnText: 'A!', newGroupName: 'Lady Vox',
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.pack.groups, []);
});

test('an edit can move a trigger between groups, and silence leaves it where it is', () => {
  const pack = createTrigger(myTriggersPack(), {
    name: 'A', pattern: 'aaa', warnText: 'A!', newGroupName: 'Lady Vox',
  }).pack;

  const moved = updateTrigger(pack, 't1', {
    name: 'A', pattern: 'aaa', warnText: 'A!', newGroupName: 'Lord Nagafen',
  });
  assert.equal(moved.pack.groups.length, 2);
  assert.equal(moved.pack.triggers[0].groupId, 'g2');

  // A form that never mentions a group is not an instruction to move anything.
  const untouched = updateTrigger(moved.pack, 't1', { name: 'A', pattern: 'aaa', warnText: 'A!' });
  assert.equal(untouched.pack.triggers[0].groupId, 'g2');

  // ...and one that names the top level explicitly is.
  const out = updateTrigger(moved.pack, 't1', {
    name: 'A', pattern: 'aaa', warnText: 'A!', groupId: null,
  });
  assert.equal(out.pack.triggers[0].groupId, null);
});

test('an invalid edit leaves the stored trigger exactly as it was', () => {
  const pack = createTrigger(myTriggersPack(), { name: 'A', pattern: 'aaa', warnText: 'A!' }).pack;
  const bad = updateTrigger(pack, 't1', { name: 'A', pattern: '(unclosed', warnText: 'A!' });
  assert.equal(bad.ok, false);
  assert.equal(bad.pack.triggers[0].pattern, 'aaa');
});

test('editing an imported trigger keeps its provenance and marks the pack', () => {
  const imported = load('sieve.gtp').pack;
  const edited = updateTrigger(imported, 't1', {
    name: 'sieve', pattern: '^(?<mob>.*) staggers\\.$', warnText: 'Sieve on ${mob}', durationSec: 60,
  });
  assert.equal(edited.trigger.provenance, 'imported');
  assert.equal(edited.pack.edited, true);
});

// ------------------------------------------------------------------- compilation

test('compilePack skips what is switched off, at trigger and at group level', () => {
  const { pack } = load('respawn-slice.gtp');
  assert.equal(compilePack(pack, 'Rhale').compiled.length, 4);

  const oneGroupOff = { ...pack, groups: pack.groups.map((g, i) => (i === 1 ? { ...g, enabled: false } : g)) };
  assert.equal(compilePack(oneGroupOff, 'Rhale').compiled.length, 2);

  const oneTriggerOff = { ...pack, triggers: pack.triggers.map((t, i) => (i === 0 ? { ...t, enabled: false } : t)) };
  assert.equal(compilePack(oneTriggerOff, 'Rhale').compiled.length, 3);
});

test('packStats separates "imported" from "actually running"', () => {
  // Three of the five committed fixtures ship EnableByDefault=False, so a report saying
  // "imported 5" while nothing fires is the exact mystery `live` exists to prevent.
  assert.deepEqual(packStats(load('common-casting.gtp').pack),
    { triggers: 5, live: 0, timers: 0, warnings: 5, groups: 2, byPanel: {} });
  assert.deepEqual(packStats(load('respawn-slice.gtp').pack),
    { triggers: 4, live: 4, timers: 4, warnings: 0, groups: 3, byPanel: { boss: 4 } });
});

// ------------------------------------------------------------------------- panels

test('a timer draws in the boss panel unless something says otherwise', () => {
  // The default is load-bearing and permanent. Every pack that exists predates the field
  // — the shipped boss timers, every .gtp a guild passes around, every trigger already
  // authored here — and an upgrade that read an absent panel as anything else would
  // silently relocate countdowns the player had placed and learned to glance at.
  const absent = normalize({ id: 'p', name: 'p', triggers: [
    { id: 't1', name: 'x', pattern: '^a$', timer: { name: 'x', durationMs: 1000 } },
  ] });
  assert.equal(absent.triggers[0].timer.panel, BOSS_PANEL);

  // A non-string is not a panel reference. Normalized rather than refused, on the same
  // "degrade to usable, never fail to load" rule the whole module follows.
  for (const junk of [null, 0, false, '', 42, {}]) {
    const odd = normalize({ id: 'p', name: 'p', triggers: [
      { id: 't1', name: 'x', pattern: '^a$', timer: { name: 'x', durationMs: 1000, panel: junk } },
    ] });
    assert.equal(odd.triggers[0].timer.panel, BOSS_PANEL, `${JSON.stringify(junk)} is not a panel`);
  }

  // An id naming a panel that no longer exists is NOT normalized away: the store knows
  // which panels exist and this module does not, so rewriting it here would destroy the
  // player's assignment on a mere read.
  const gone = normalize({ id: 'p', name: 'p', triggers: [
    { id: 't1', name: 'x', pattern: '^a$', timer: { name: 'x', durationMs: 1000, panel: 'p9' } },
  ] });
  assert.equal(gone.triggers[0].timer.panel, 'p9');
});

test('every shipped boss timer draws in the boss panel', () => {
  // The one that would be noticed last and hurt most: the sixteen countdowns this app
  // ships must keep landing where they have always landed.
  const seeded = normalize(seedPack());
  assert.ok(seeded.triggers.length >= 16);
  for (const t of seeded.triggers) {
    assert.equal(t.timer?.panel, BOSS_PANEL, `${t.name} moved panels`);
  }
});

test('an imported GINA pack lands in the boss panel — the format cannot say otherwise', () => {
  const { pack } = load('respawn-slice.gtp');
  const timed = normalize(pack).triggers.filter((t) => t.timer);
  assert.ok(timed.length);
  for (const t of timed) assert.equal(t.timer.panel, BOSS_PANEL);
});

test('the panel survives create → update → normalize', () => {
  const created = createTrigger(myTriggersPack(), {
    name: 'Spirit of the Puma',
    pattern: 'You begin to snarl as your features become feline.',
    literal: true,
    durationSec: 146,
    panel: 'p1',
  });
  assert.ok(created.ok, created.errors.join('; '));
  assert.equal(created.trigger.timer.panel, 'p1');

  // An edit that does not mention the panel leaves it where it was — silence is not a
  // request to move a row back to the boss window.
  const moved = updateTrigger(created.pack, created.trigger.id, {
    name: 'Spirit of the Puma',
    pattern: 'You begin to snarl as your features become feline.',
    literal: true,
    durationSec: 146,
    panel: 'p2',
  });
  assert.ok(moved.ok, moved.errors.join('; '));
  assert.equal(moved.trigger.timer.panel, 'p2');
  assert.equal(normalize(moved.pack).triggers[0].timer.panel, 'p2');
});

test('packStats counts timers per panel, so a dark panel can be named', () => {
  const mixed = normalize({ id: 'p', name: 'p', triggers: [
    { id: 't1', name: 'a', pattern: '^a$', timer: { name: 'a', durationMs: 1000 } },
    { id: 't2', name: 'b', pattern: '^b$', timer: { name: 'b', durationMs: 1000, panel: 'p1' } },
    { id: 't3', name: 'c', pattern: '^c$', timer: { name: 'c', durationMs: 1000, panel: 'p1' } },
    { id: 't4', name: 'd', pattern: '^d$', warn: { text: 'd' } },
  ] });
  assert.deepEqual(packStats(mixed).byPanel, { boss: 1, p1: 2 });
  assert.equal(packStats(mixed).timers, 3, 'a warning-only trigger is not a timer');
});
