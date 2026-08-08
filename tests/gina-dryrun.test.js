/**
 * The import dry-run.
 *
 * The claim under test is not "the regexes run" — it is that the report is HONEST: that
 * an emote-keyed pattern is shown firing, that a pattern hardcoding another server's
 * numbers is shown dead with its wording visible, that a near-miss is distinguishable
 * from a genuine absence, and that the one adaptation on offer is measured alongside the
 * original rather than silently replacing it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dryRun, dryRunLog, readLogTail, testPattern, rankTolerantPattern } from '../src/triggers/dryrun.js';
import { parseGinaPackage, readGinaXml } from '../src/triggers/gina.js';
import { normalize } from '../src/triggers/pack.js';

const SAMPLE = path.join(import.meta.dirname, 'fixtures', 'combat-sample.log');
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'gina');
const sampleLines = () => fs.readFileSync(SAMPLE, 'latin1').split(/\r?\n/);
const gina = (name) => parseGinaPackage(fs.readFileSync(path.join(FIXTURES, name)), { name }).pack;

/** A pack in the shape the corpus actually takes: emotes that port, and text that does not. */
const PROBE = normalize({
  id: 'probe', name: 'Probe', groups: [],
  triggers: [
    // Emote-keyed. EQ prints the same emote for every rank and variant of a spell
    // family, which is exactly why these are the triggers that survive a port.
    { id: 't1', name: 'Stagger', pattern: '(?<mob>.*) staggers\\.', warn: { text: 'Staggered: ${mob}' } },
    { id: 't2', name: 'Slain', pattern: '(?<mob>.*) has been slain by (?<who>.*)!', warn: { text: 'Down: ${mob}' } },
    // Hardcoded damage from another server's spell tables — dead by design, and the
    // single largest category of dead pattern in the corpus.
    { id: 't3', name: 'P99 nuke', pattern: 'was hit by non-melee for 75 points of damage', warn: { text: 'nuke' } },
    // A name from someone else's guild roster.
    { id: 't4', name: 'Innah', pattern: '^(?<player>Innah) begins to cast', warn: { text: 'Innah casts' } },
  ],
});

test('an emote-keyed trigger fires and reports a real sample line', () => {
  const report = dryRun(PROBE, sampleLines());
  const stagger = report.triggers.find((t) => t.name === 'Stagger');
  assert.ok(stagger.hits > 0, 'the stagger emote is in the sample log');
  assert.match(stagger.sample, /staggers\./);

  const slain = report.triggers.find((t) => t.name === 'Slain');
  assert.ok(slain.hits > 0);
  assert.match(slain.sample, /has been slain by/);
});

test('a trigger hardcoding another server\'s numbers is reported dead, with its pattern', () => {
  const report = dryRun(PROBE, sampleLines());
  for (const name of ['P99 nuke', 'Innah']) {
    const dead = report.triggers.find((t) => t.name === name);
    assert.equal(dead.hits, 0, name);
    assert.equal(dead.sample, null, name);
    // The PATTERN comes back, not just the name — a near-miss is only visible and
    // editable if the player can see the wording it expected.
    assert.ok(dead.pattern, name);
  }
});

test('the report counts LINES, not hits — one line matching three triggers is one line', () => {
  const report = dryRun(PROBE, sampleLines());
  const totalHits = report.triggers.reduce((sum, t) => sum + t.hits, 0);
  assert.ok(report.matched > 0);
  assert.ok(report.matched <= totalHits);
  assert.equal(report.lines, sampleLines().filter((l) => /^\[\w{3} \w{3}/.test(l)).length);
});

test('every trigger is measured, including the ones the pack ships switched off', () => {
  // Three of the five committed fixtures ship EnableByDefault=False. A report that
  // hid them would be answering a question nobody asked: the whole point of the
  // dry-run is deciding what to switch ON.
  const pack = gina('common-casting.gtp');
  assert.equal(pack.groups.every((g) => !g.enabled), true, 'the fixture must still ship off');
  assert.equal(dryRun(pack, sampleLines()).triggers.length, 5);
});

test('a pattern that will not compile is reported as broken, not as merely dead', () => {
  const { pack } = readGinaXml(`<SharedData><Triggers>
    <Trigger><Name>Broken</Name><TriggerText>(?#nope)x</TriggerText><EnableRegex>True</EnableRegex>
      <UseText>True</UseText><DisplayText>x</DisplayText></Trigger>
  </Triggers></SharedData>`);
  const [t] = dryRun(pack, sampleLines()).triggers;
  assert.equal(t.hits, 0);
  assert.ok(t.error, 'a pattern that never ran is not the same news as one that ran and missed');
});

test('the prefilter changes the speed and never the answer', () => {
  // Same pack, run with the prefilter as the engine uses it, versus every regex run
  // against every line. The counts must be identical.
  const lines = sampleLines();
  const withFilter = dryRun(PROBE, lines);
  const naive = new Map();
  for (const t of PROBE.triggers) naive.set(t.name, 0);
  for (const line of lines) {
    const body = /^\[[^\]]+\] ?(.*)$/.exec(line)?.[1];
    if (body === undefined) continue;
    for (const t of PROBE.triggers) {
      if (new RegExp(t.pattern).test(body)) naive.set(t.name, naive.get(t.name) + 1);
    }
  }
  for (const t of withFilter.triggers) assert.equal(t.hits, naive.get(t.name), t.name);
});

// ----------------------------------------------------------------- adaptations

test('rank tolerance inserts the allowance before the anchor, not after it', () => {
  assert.equal(rankTolerantPattern('^You begin casting Harmony\\.$'),
    '^You begin casting Harmony(?: [IVXLCDM]+)?\\.$');
  assert.equal(rankTolerantPattern('^You begin casting Harmony$'),
    '^You begin casting Harmony(?: [IVXLCDM]+)?$');
  assert.equal(rankTolerantPattern('casting Harmony\\.'),
    'casting Harmony(?: [IVXLCDM]+)?\\.');

  // An unanchored pattern already matches a ranked line, so there is nothing to add,
  // and offering a no-op adaptation would be noise in the report.
  assert.equal(rankTolerantPattern('casting Harmony'), null);
  assert.equal(rankTolerantPattern('x(?: [IVXLCDM]+)?$'), null);
  assert.equal(rankTolerantPattern(''), null);
});

test('an adaptation is measured ALONGSIDE the original, never instead of it', () => {
  const log = [
    '[Fri Jul 31 18:31:35 2026] You begin casting Spirit of Wolf.',
    '[Fri Jul 31 18:31:36 2026] You begin casting Spirit of Wolf V.',
    '[Fri Jul 31 18:31:37 2026] You begin casting Spirit of Wolf VII.',
  ];
  const pack = normalize({
    id: 'p', name: 'p', groups: [],
    triggers: [{ id: 't1', name: 'SoW', pattern: '^You begin casting Spirit of Wolf\\.$', warn: { text: 'sow' } }],
  });

  const plain = dryRun(pack, log).triggers[0];
  assert.equal(plain.hits, 1);
  assert.equal(plain.adapted, null, 'not asked for, so not offered');

  const adapted = dryRun(pack, log, { rankTolerant: true }).triggers[0];
  // The original count is untouched. The player is being shown what one specific,
  // named change would buy — not handed a rewritten pattern and told it works now.
  assert.equal(adapted.hits, 1);
  assert.equal(adapted.adapted.hits, 3);
  assert.equal(adapted.adapted.gain, 2);
  assert.match(adapted.adapted.sample, /Spirit of Wolf V/);
});

// ------------------------------------------------------------- the Test button

test('testPattern reports hits, samples and the line count it saw', () => {
  const result = testPattern('(?<mob>.*) staggers\\.', sampleLines());
  assert.equal(result.ok, true);
  assert.ok(result.hits > 0);
  assert.ok(result.samples.length > 0 && result.samples.length <= 3);
  assert.match(result.samples[0], /staggers\./);
  assert.ok(result.lines > 600);
});

test('testPattern shows the JavaScript error inline rather than saving a dead pattern', () => {
  const result = testPattern('(unclosed', sampleLines());
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(result.hits, 0);
});

test('testPattern resolves {C} against the character being followed', () => {
  const log = ['[Fri Jul 31 18:31:35 2026] Rhale ##reset.'];
  assert.equal(testPattern('^{C} ##reset\\.$', log, { character: 'Rhale' }).hits, 1);
  assert.equal(testPattern('^{C} ##reset\\.$', log, { character: 'Emalina' }).hits, 0);
});

// ------------------------------------------------------------------ log reading

test('the log tail is read as latin1, never utf8', async () => {
  // EQ writes single-byte text; utf8 mangles accented mob names. This is the opposite
  // of a .gtp, which states its own encoding.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-'));
  const file = path.join(dir, 'eqlog_Test_server.txt');
  const body = 'Fippy Darkpaw\xe9 hits YOU for 10 points of damage.';
  fs.writeFileSync(file, Buffer.from(`[Fri Jul 31 18:31:35 2026] ${body}\n`, 'latin1'));
  try {
    const tail = await readLogTail(file);
    assert.equal(tail.lines[0].includes('Darkpaw\xe9'), true);
    assert.equal(tail.truncated, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a truncated tail says so, and drops the half-line it starts on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-'));
  const file = path.join(dir, 'eqlog_Test_server.txt');
  const line = (n) => `[Fri Jul 31 18:31:${String(n % 60).padStart(2, '0')} 2026] line ${n} staggers.\n`;
  fs.writeFileSync(file, Array.from({ length: 200 }, (_, i) => line(i)).join(''));

  try {
    const full = await readLogTail(file);
    assert.equal(full.truncated, false);

    // A tail starting mid-file begins on half a line, which either fails to parse or —
    // worse — parses into something that was never in the log.
    const partial = await readLogTail(file, { maxBytes: 500 });
    assert.equal(partial.truncated, true);
    assert.ok(partial.bytes <= 500);
    assert.equal(partial.lines.every((l) => l === '' || /^\[\w{3} \w{3}/.test(l)), true);

    const report = await dryRunLog(PROBE, file, { maxBytes: 500 });
    assert.equal(report.truncated, true);
    assert.ok(report.total > report.bytes, 'the report must be able to say "the last N of M"');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dryRunLog yields between chunks so a raid-time scan cannot stall the tailer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-'));
  const file = path.join(dir, 'eqlog_Test_server.txt');
  fs.copyFileSync(SAMPLE, file);

  try {
    // Something that must actually run while the scan is in flight. If the read were one
    // synchronous burst it would be starved, which is the 2.6-seconds-of-blocked-event-
    // loop failure this exists to prevent.
    //
    // setImmediate rather than a short setInterval: a 1ms timer needs a full millisecond
    // of WALL TIME to become eligible, and a small scan can finish inside that, so the
    // timer version failed about half the time on a quiet machine and was measuring
    // duration rather than yielding. setImmediate fires once per event-loop turn, which
    // is exactly the thing being asserted — the loop turned at all.
    let turns = 0;
    let stop = false;
    const pump = () => { if (!stop) { turns++; setImmediate(pump); } };
    setImmediate(pump);

    const report = await dryRunLog(PROBE, file, { maxBytes: 4096 });
    stop = true;

    assert.ok(report.lines > 0);
    assert.ok(turns > 0, 'the event loop kept running during the scan');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
