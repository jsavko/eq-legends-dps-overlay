#!/usr/bin/env node
/**
 * Mine an EverQuest log for how long the player's own effects last, and print them as a
 * candidate trigger pack.
 *
 *   node scripts/mine-buffs.js <eqlog file> [--min 3] [--all] [--write <file>] [--json]
 *
 *   --min N       how many complete cycles before a pair is a candidate (default 3)
 *   --all         include the loose pairs in a written pack (default: tight ones only)
 *   --write FILE  write the pack JSON here. Without this, nothing is written at all
 *   --json        machine-readable candidates instead of the review table
 *
 * It prints and writes nothing on its own — the same discipline `mine-rhythms.js`,
 * `mine-gina.js` and `collect-unknown.js` follow, and for the same reason: what a player
 * ends up with should be a REVIEWED list, and a script that wrote one unattended would
 * quietly turn it into a scraped one. The loose pairs are printed too, marked, because
 * knowing that an effect's observed length wanders by forty seconds is exactly how you
 * decide it must not ship as a fixed number.
 *
 * Why measured at all, rather than read off a table: buff length depends on the caster's
 * level, on the RANK of the spell, and on AAs. `Spirit of the Puma V` and `VI` differ by
 * thirteen seconds in one session of the live log. A table would be wrong for every
 * player in a different way; a measurement is right for the player who ran it.
 */

import fs from 'node:fs';

import { parseTimestamp } from '../src/parser/timestamp.js';
import { BuffMiner, packFromBuffs } from '../src/triggers/mine-buffs.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const includeLoose = args.includes('--all');
const minIdx = args.indexOf('--min');
const minObs = minIdx !== -1 ? Number(args[minIdx + 1]) || 3 : 3;
const writeIdx = args.indexOf('--write');
const writeTo = writeIdx !== -1 ? args[writeIdx + 1] : null;
// Everything that is a flag's VALUE rather than the log path. Computed from the flag
// positions rather than by pattern, since a log path and a filename look alike.
const flagValues = new Set(
  [minIdx, writeIdx].filter((i) => i !== -1).map((i) => args[i + 1]),
);
const logPath = args.find((a) => !a.startsWith('--') && !flagValues.has(a));

if (!logPath) {
  console.error(
    'usage: node scripts/mine-buffs.js <eqlog file> [--min 3] [--all] ' +
    '[--write <file>] [--json]',
  );
  process.exit(1);
}

const miner = new BuffMiner();
let lines = 0;
let firstTs = null;
let lastTs = null;

// latin1, never utf8 — EQ writes single-byte text and utf8 mangles accented mob names.
for (const line of fs.readFileSync(logPath, 'latin1').split(/\r?\n/)) {
  if (!line) continue;
  const parsed = parseTimestamp(line);
  if (!parsed) continue;
  lines++;
  if (firstTs === null) firstTs = parsed.ts;
  lastTs = parsed.ts;
  miner.observe(parsed.body, parsed.ts);
}

const all = miner.candidates({ minObs });
const tight = all.filter((c) => !c.loose);

if (asJson) {
  console.log(JSON.stringify(all, null, 2));
} else {
  const days = firstTs && lastTs ? (lastTs - firstTs) / 86_400_000 : 0;
  console.log(
    `${lines.toLocaleString()} timestamped lines over ${days.toFixed(1)} days — ` +
    `${all.length} effect${all.length === 1 ? '' : 's'} measured, ${tight.length} tight\n`,
  );
  if (!all.length) {
    console.log('Nothing paired up. A pair needs a landing line that follows one of your');
    console.log('cast lines and a wear-off line that follows it at a consistent interval,');
    console.log(`at least ${minObs} times — try --min 2 on a shorter log.`);
  }
  for (const c of all) print(c);

  console.log('\nEvery number above is the median of last-land → wear-off in YOUR log.');
  console.log('A recast refreshes, so the clock starts at the last land, not the first.');
}

if (writeTo) {
  const chosen = includeLoose ? all : tight;
  const pack = packFromBuffs(chosen, {
    id: 'my-buffs',
    name: 'My buffs (measured from my log)',
    comments:
      `${chosen.length} countdowns measured by scripts/mine-buffs.js from ` +
      `${lines.toLocaleString()} lines of this character's own log. Every duration is the ` +
      'median of the cycles actually observed — nobody read these off a spell table, which ' +
      'is the point: buff length depends on your level, the rank you cast and your AAs. ' +
      'Exact about this character; every row is yours to correct.',
    modified: new Date(lastTs ?? Date.now()).toISOString().slice(0, 10),
  });
  fs.writeFileSync(writeTo, `${JSON.stringify(pack, null, 2)}\n`);
  console.log(`\nwrote ${chosen.length} triggers to ${writeTo}`);
}

function print(c) {
  const secs = (c.durationMs / 1000).toFixed(0);
  const spread = (c.spreadMs / 1000).toFixed(0);
  const ranks = c.ranks.length > 1 ? `  ranks: ${c.ranks.map((r) => r.name).join(', ')}` : '';
  console.log(
    `${c.loose ? '~' : ' '} ${c.name.padEnd(28)} ${String(secs).padStart(5)}s ` +
    `±${spread.padStart(3)}  n=${String(c.samples).padStart(3)}${ranks}`,
  );
  console.log(`     starts: ${c.land}`);
  console.log(`       ends: ${c.wearOff}`);
}
