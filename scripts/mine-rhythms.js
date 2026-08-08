#!/usr/bin/env node
/**
 * Mine an EverQuest log for boss recast intervals, and print them as a candidate
 * trigger pack.
 *
 * This replaces `seed-rhythms.js`, which fed the same measurements into an invisible
 * per-server store that only the learned-timer code could read. The measurement was
 * never the problem — the placement was — so the arithmetic is unchanged and the OUTPUT
 * is now a thing a person reviews and a player can open, edit and give to their guild.
 *
 *   node scripts/mine-rhythms.js <eqlog file> [--min 3] [--all] [--write <file>] [--json]
 *
 *   --min N       how many agreeing gaps before a pair is a candidate (default 3)
 *   --all         include the loose pairs in a written pack (default: tight ones only)
 *   --write FILE  write the pack JSON here. Without this, nothing is written at all
 *   --json        machine-readable candidates instead of the review table
 *
 * It prints candidates and writes nothing on its own, the same discipline `mine-gina.js`
 * and `collect-unknown.js` follow: what ships is a REVIEWED list, and a script that wrote
 * one unattended would quietly turn it into a scraped one. The loose pairs are printed
 * too, marked, because knowing that Master Yael's Immobilize wanders by eighteen seconds
 * is exactly how you decide it must not ship as a fixed number.
 */

import fs from 'node:fs';
import path from 'node:path';

import { LogParser } from '../src/parser/index.js';
import { parseTimestamp } from '../src/parser/timestamp.js';
import { stripArticle } from '../src/parser/entities.js';
import { RhythmMiner, packFromCandidates, patternFor } from '../src/triggers/mine-rhythms.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const includeLoose = args.includes('--all');
const minIdx = args.indexOf('--min');
const minGaps = minIdx !== -1 ? Number(args[minIdx + 1]) || 3 : 3;
const writeIdx = args.indexOf('--write');
const writeTo = writeIdx !== -1 ? args[writeIdx + 1] : null;
// Everything that is a flag's VALUE rather than the log path. Computed from the flag
// positions rather than by pattern, since a log path and a filename look alike.
const flagValues = new Set([minIdx, writeIdx].filter((i) => i !== -1).map((i) => args[i + 1]));
const logPath = args.find((a) => !a.startsWith('--') && !flagValues.has(a));

if (!logPath) {
  console.error('usage: node scripts/mine-rhythms.js <eqlog file> [--min 3] [--all] [--write <file>] [--json]');
  process.exit(1);
}

const parser = new LogParser({ logFilename: path.basename(logPath) });
const miner = new RhythmMiner();

/** Named casters only — no leading article on the RAW name. */
const named = (raw) => Boolean(raw) && stripArticle(String(raw)) === String(raw).trim();

let lines = 0;
let firstTs = null;
let lastTs = null;

// latin1, never utf8 — EQ writes single-byte text and utf8 mangles accented mob names.
for (const line of fs.readFileSync(logPath, 'latin1').split(/\r?\n/)) {
  if (!line) continue;
  const parsed = parseTimestamp(line);
  const event = parser.feed(line);
  if (!parsed || !event) continue;
  lines++;
  if (firstTs === null) firstTs = parsed.ts;
  lastTs = parsed.ts;

  // Hostility comes from the parser, not from a rule of our own: it alone knows who is
  // in the group, what the fight has engaged and which pets belong to whom. A player
  // typing a cast line into /general is precisely what this guard is for.
  switch (event.kind) {
    case 'cast': {
      if (!event.ability || !named(event.attacker)) break;
      const caster = parser.resolve(event.attacker);
      if (!parser.isHostileCaster(caster.name)) break;
      miner.observe({
        caster: String(event.attacker).trim(),
        ability: event.ability,
        ts: event.ts,
        source: 'cast',
        body: parsed.body,
      });
      break;
    }
    case 'damage': {
      // Spells only. Melee is continuous and DoT ticks are periodic by mechanic rather
      // than by the boss's decision, so both would measure garbage.
      if (event.source !== 'spell' || !event.ability || !named(event.attacker)) break;
      const attacker = parser.resolve(event.attacker);
      const target = parser.resolve(event.target);
      if (!parser.isFriendly(target.name) || !parser.isHostileCaster(attacker.name)) break;
      miner.observe({
        caster: String(event.attacker).trim(),
        ability: event.ability,
        ts: event.ts,
        source: 'landed',
        body: parsed.body,
      });
      break;
    }
    case 'resist': {
      // A wholly-resisted breath AE leaves no damage line at all, so without this a clean
      // resist reads as a skipped beat and drags the measured median out by a full cycle.
      if (!event.ability || !named(event.attacker)) break;
      const attacker = parser.resolve(event.attacker);
      const target = parser.resolve(event.target);
      if (!parser.isFriendly(target.name) || !parser.isHostileCaster(attacker.name)) break;
      miner.observe({
        caster: String(event.attacker).trim(),
        ability: event.ability,
        ts: event.ts,
        source: 'landed',
        body: parsed.body,
      });
      break;
    }
    case 'interrupt':
      if (event.ability && named(event.attacker)) {
        miner.interrupt(String(event.attacker).trim(), event.ability);
      }
      break;
    default:
      break;
  }
}

const candidates = miner.candidates({ minGaps });
const tight = candidates.filter((c) => !c.loose);
const loose = candidates.filter((c) => c.loose);
const chosen = includeLoose ? candidates : tight;

const day = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : 'unknown');
const span = `${day(firstTs)} to ${day(lastTs)}`;
const server = parser.server ?? 'unknown server';

if (asJson) {
  console.log(JSON.stringify({
    character: parser.selfName, server, lines, span, minGaps, tight, loose,
  }, null, 2));
} else {
  console.log(
    `${parser.selfName} (${server}) — ${lines.toLocaleString()} timestamped lines, ${span}\n`
  );
  console.log(`=== ${tight.length} tight enough to ship as a fixed number ===\n`);
  for (const c of tight) print(c);
  console.log(`\n=== ${loose.length} too irregular — a countdown here would lie ===\n`);
  for (const c of loose) print(c);
  console.log(
    '\nNothing above ships on its own. Review every row by hand: a friendly player\'s pet\n' +
    'and a boss self-buff both measure perfectly well and neither belongs in a boss-timer\n' +
    'pack. Pass --write <file> once the list is the one you meant.'
  );
}

function print(c) {
  console.log(
    `  ${c.caster} | ${c.ability}\n` +
    `    ${(c.intervalMs / 1000).toFixed(1)}s ±${(c.spreadMs / 1000).toFixed(1)} ` +
    `(cv ${c.cv.toFixed(2)}, n=${c.samples}, ${c.runs} fight${c.runs === 1 ? '' : 's'}, ${c.source})\n` +
    `    ${patternFor(c)}\n` +
    `    e.g. ${c.sample}\n`
  );
}

if (writeTo) {
  const pack = packFromCandidates(chosen, {
    id: 'eql-boss-timers',
    name: `Boss timers (${server})`,
    comments:
      `Measured from ${lines.toLocaleString()} log lines on ${server}, ${span}, by ` +
      'scripts/mine-rhythms.js. Every duration is a median of observed gaps, not a number ' +
      'anyone read off a spell table — so it is exact about this server and may be wrong ' +
      'about yours. Edit any row you can prove better.',
    modified: day(lastTs),
  });
  fs.writeFileSync(writeTo, JSON.stringify(pack, null, 2), 'utf8');
  console.log(`\nWrote ${pack.triggers.length} triggers in ${pack.groups.length} groups to ${writeTo}`);
}
