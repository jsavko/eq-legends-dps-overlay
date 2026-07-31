#!/usr/bin/env node
/**
 * Replay a saved log through the parser so the overlay can be developed and verified
 * with the game closed.
 *
 * Two modes:
 *
 *   --print                 parse the whole log at once and print every encounter
 *                           (fast; this is what the end-to-end check uses)
 *
 *   --write <file>          re-emit the log into <file> in wall-clock order, at
 *                           `--speed` times real time, appending as the game would.
 *                           Point the overlay at that file and the app cannot tell the
 *                           difference between it and a live session.
 *
 * Examples:
 *   node scripts/replay.js tests/fixtures/combat-sample.log --print
 *   node scripts/replay.js tests/fixtures/combat-sample.log --write /tmp/eqlog_Rhale_oggok.txt --speed 5
 *   node scripts/replay.js tests/fixtures/combat-sample.log --write ... --realtime
 */

import fs from 'node:fs';
import path from 'node:path';
import { LogParser } from '../src/parser/index.js';
import { parseTimestamp, formatDuration } from '../src/parser/timestamp.js';

const argv = process.argv.slice(2);

function flag(name) {
  return argv.includes(`--${name}`);
}
function value(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

const logFile = argv.find((a) => !a.startsWith('--') && !isFlagValue(a));
function isFlagValue(a) {
  const i = argv.indexOf(a);
  return i > 0 && argv[i - 1].startsWith('--') && ['write', 'speed'].includes(argv[i - 1].slice(2));
}

if (!logFile) {
  console.error('usage: node scripts/replay.js <logfile> [--print] [--write FILE] [--speed N] [--realtime]');
  process.exit(1);
}

const speed = flag('realtime') ? 1 : Number(value('speed', 10));
const writeTarget = value('write', null);
const text = fs.readFileSync(path.resolve(logFile), 'latin1');
const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
const logFilename = path.basename(logFile);

if (writeTarget) {
  await streamOut();
} else {
  printEncounters();
}

/**
 * Parse everything and print each encounter's table.
 *
 * The parser is driven by log time only (the clock returns the last line's timestamp),
 * so the output is deterministic and does not depend on when the script is run.
 */
function printEncounters() {
  let logNow = 0;
  const parser = new LogParser({
    logFilename: /^eqlog_/.test(logFilename) ? logFilename : 'eqlog_Rhale_oggok.txt',
    clock: () => logNow,
  });

  const encounters = [];
  let printedRevision = -1;

  for (const line of lines) {
    const stamped = parseTimestamp(line);
    if (stamped) logNow = stamped.ts;

    const before = parser.current;
    parser.feed(line);
    // An encounter object being swapped out means the previous one finished.
    if (before && parser.current !== before && before.closed) {
      encounters.push(before.snapshot(logNow));
    }
    printedRevision = parser.revision;
  }

  parser.tick(logNow + 3_600_000);   // flush anything still open
  if (parser.last && !encounters.includes(parser.last)) {
    const snap = parser.last.snapshot(logNow);
    if (!encounters.some((e) => e.startTs === snap.startTs)) encounters.push(snap);
  }

  const real = encounters.filter((e) => e.totalDamage > 0);
  console.log(`${lines.length} lines, ${real.length} encounters with damage\n`);

  for (const enc of real) {
    const when = new Date(enc.startTs).toLocaleTimeString();
    console.log(`── ${enc.label}  ·  ${when}  ·  ${formatDuration(enc.durationMs)}  ·  ${fmt(enc.groupDps)} group DPS`);
    for (const r of enc.rows) {
      const pet = r.petDamage > 0 ? `  (pet ${r.petDamage})` : '';
      console.log(
        `   ${r.name.padEnd(14)} ${String(r.damage).padStart(7)}  ` +
        `${fmt(r.dps).padStart(8)} dps  ${(r.share * 100).toFixed(1).padStart(5)}%  ` +
        `${r.hits}h/${r.misses}m  ${r.crits} crit  max ${r.maxHit}${pet}`
      );
    }

    const healers = enc.rows.filter((r) => r.heals > 0);
    if (healers.length > 0) {
      console.log(`   ${'─'.repeat(20)} healing  ${fmt(enc.groupHps)} group HPS`);
      for (const r of healers) {
        const petHeal = r.petHealing > 0 ? `  (pet ${r.petHealing})` : '';
        console.log(
          `   ${r.name.padEnd(14)} ${String(r.healing).padStart(7)}  ` +
          `${fmt(r.hps).padStart(8)} hps  ${(r.healShare * 100).toFixed(1).padStart(5)}%  ` +
          `${r.heals} casts  ${r.overhealing} over (${(r.healEfficiency * 100).toFixed(0)}% landed)${petHeal}`
        );
      }
    }
    console.log();
  }
  console.log(`unmatched lines: ${parser.unmatchedCount}`);
}

/**
 * Append the log to a target file in wall-clock order.
 *
 * Timestamps are rewritten to "now" so the parser's idle timeouts behave exactly as
 * they would live — replaying 2026-dated lines verbatim would make every encounter
 * look hours stale.
 */
async function streamOut() {
  const stamped = lines
    .map((line) => ({ line, ts: parseTimestamp(line)?.ts ?? null }))
    .filter((e) => e.ts !== null);

  if (stamped.length === 0) {
    console.error('no timestamped lines to replay');
    process.exit(1);
  }

  const logStart = stamped[0].ts;
  const realStart = Date.now();

  fs.writeFileSync(writeTarget, '', 'latin1');
  console.log(`replaying ${stamped.length} lines into ${writeTarget} at ${speed}x`);
  console.log('point the overlay at that file (Ctrl+C to stop)\n');

  for (const { line, ts } of stamped) {
    const targetOffset = (ts - logStart) / speed;
    const wait = targetOffset - (Date.now() - realStart);
    if (wait > 0) await sleep(wait);

    const shifted = line.replace(
      /^\[.*?\]/,
      `[${formatEqTimestamp(new Date(realStart + (ts - logStart) / speed))}]`
    );
    fs.appendFileSync(writeTarget, shifted + '\n', 'latin1');
  }
  console.log('replay complete');
}

/** Render a Date in EverQuest's own header format. */
function formatEqTimestamp(d) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`;
}

// Function declarations, not consts: these are called from printEncounters(), which
// runs at the top of the file, before a const at the bottom would be initialized.
function fmt(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(1);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
