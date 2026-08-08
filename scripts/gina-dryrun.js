#!/usr/bin/env node
/**
 * Replay a GINA pack against a real log and report which of its triggers actually fire.
 *
 * A shared trigger package was written by a stranger, usually for a different EverQuest
 * server, sometimes a decade ago. Whether it is worth importing is an empirical question
 * with an empirical answer, and this is how to get it before shipping anything: point it
 * at a pack and a log, and read the hit counts.
 *
 *   node scripts/gina-dryrun.js <pack.gtp|dir> [--log <path>] [--rank] [--all] [--json]
 *
 *   --log    which log to replay (defaults to the live session log)
 *   --rank   also measure what rank tolerance would buy — the one adaptation mechanical
 *            enough to offer, since EQL numbers spell ranks where classic EQ did not
 *   --all    list every trigger, not only the dead ones
 *   --json   machine-readable, for feeding into the mining script
 *
 * The same code path drives the in-app import report and the authoring Test button —
 * see src/triggers/dryrun.js — so what this prints is what the player will be shown.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseGinaPackage } from '../src/triggers/gina.js';
import { dryRunLog } from '../src/triggers/dryrun.js';
import { packStats } from '../src/triggers/pack.js';

const LIVE_LOG =
  '/mnt/c/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Rhale_oggok.txt';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const logIndex = args.indexOf('--log');
const logPath = logIndex !== -1 ? args[logIndex + 1] : LIVE_LOG;
const target = positional.filter((a) => a !== logPath)[0];

if (!target) {
  console.error('usage: node scripts/gina-dryrun.js <pack.gtp|dir> [--log <path>] [--rank] [--all] [--json]');
  process.exit(1);
}

const files = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).filter((n) => /\.(gtp|xml)$/i.test(n)).map((n) => path.join(target, n))
  : [target];

const packs = [];
let droppedTotal = 0;
for (const file of files) {
  try {
    const { pack, dropped } = parseGinaPackage(fs.readFileSync(file), {
      name: path.basename(file).replace(/\.\w+$/, ''),
    });
    packs.push(pack);
    droppedTotal += dropped.filter((d) => d.fatal).length;
  } catch (err) {
    console.error(`! ${path.basename(file)}: ${err.message}`);
  }
}

if (!packs.length) {
  console.error('nothing to replay');
  process.exit(1);
}

const character = /eqlog_([^_]+)_/.exec(path.basename(logPath))?.[1] ?? null;
const report = await dryRunLog(packs, logPath, { character, rankTolerant: flags.has('--rank') });

if (flags.has('--json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const live = report.triggers.filter((t) => t.hits > 0).sort((a, b) => b.hits - a.hits);
const dead = report.triggers.filter((t) => t.hits === 0);
const broken = report.triggers.filter((t) => t.error);

const n = (value) => value.toLocaleString('en-US');

console.log(`\n${packs.length} pack${packs.length === 1 ? '' : 's'}, ` +
  `${report.triggers.length} triggers, ` +
  `${n(packs.reduce((sum, p) => sum + packStats(p).timers, 0))} of them timers`);
if (droppedTotal) console.log(`${droppedTotal} more were dropped at import (run the import report for why)`);
console.log(`replayed against ${n(report.lines)} lines` +
  `${report.truncated ? ` (the last ${n(report.bytes)} bytes of ${n(report.total)})` : ''}\n`);

console.log(`${live.length} of ${report.triggers.length} fired, for ${n(report.matched)} matching lines`);

if (live.length) {
  console.log('\n  hits  trigger');
  for (const t of live) {
    console.log(`${String(n(t.hits)).padStart(6)}  ${t.name}  [${t.packName}]`);
    if (flags.has('--all')) console.log(`        e.g. ${JSON.stringify(t.sample)}`);
  }
}

if (dead.length) {
  console.log(`\n${dead.length} never matched:`);
  for (const t of dead) {
    // The PATTERN is printed, not just the name, because a near-miss is only visible
    // and editable if you can see the wording it expected.
    console.log(`   ${t.name}  [${t.packName}]`);
    console.log(`      ${t.error ? `does not compile: ${t.error}` : t.pattern}`);
    if (t.adapted?.gain > 0) {
      console.log(`      with rank tolerance: ${n(t.adapted.gain)} hits — ${t.adapted.pattern}`);
      console.log(`      e.g. ${JSON.stringify(t.adapted.sample)}`);
    }
  }
}

const gains = report.triggers.filter((t) => t.adapted?.gain > 0);
if (flags.has('--rank') && gains.length) {
  console.log(`\nrank tolerance would add ${n(gains.reduce((s, t) => s + t.adapted.gain, 0))} matches ` +
    `across ${gains.length} triggers`);
} else if (flags.has('--rank')) {
  console.log('\nrank tolerance would add nothing to this pack');
}

if (broken.length) console.log(`\n${broken.length} patterns do not compile at all`);
console.log('');
