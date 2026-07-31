#!/usr/bin/env node
/**
 * Run a log through the rule table and report every line no rule matched.
 *
 * The point is to find gaps in rules.js empirically rather than by guessing at
 * EverQuest Legends' wording. Lines are grouped by a shape signature (numbers and
 * names blanked out) so 400 near-identical misses collapse into one row.
 *
 *   node scripts/collect-unknown.js <logfile> [--out unknown-lines.txt] [--all]
 *
 * --all also lists lines that matched a non-combat rule (chat, zone, heal), which is
 * useful when checking whether something interesting is being swallowed as chat.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseTimestamp } from '../src/parser/timestamp.js';
import { matchRule } from '../src/parser/rules.js';

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const outIdx = args.indexOf('--out');
const outFile = outIdx !== -1 ? args[outIdx + 1] : 'unknown-lines.txt';
const logFile = args.find((a) => !a.startsWith('--') && a !== outFile);

if (!logFile) {
  console.error('usage: node scripts/collect-unknown.js <logfile> [--out FILE] [--all]');
  process.exit(1);
}

// latin1, never utf8 — EQ writes single-byte text and utf8 mangles accented mob names.
const text = fs.readFileSync(path.resolve(logFile), 'latin1');
const lines = text.split(/\r?\n/).filter((l) => l.length > 0);

/** Blank out the variable parts so identical line shapes group together. */
function signature(body) {
  return body
    .replace(/\d+/g, '#')
    .replace(/'[^']*'/g, "'…'")
    .slice(0, 160);
}

const unknown = new Map();   // signature -> { count, example }
const byRule = new Map();    // rule id -> count
let malformed = 0;
let matched = 0;

for (const line of lines) {
  const parsed = parseTimestamp(line);
  if (!parsed) {
    malformed++;
    continue;
  }
  const event = matchRule(parsed.body);
  if (event) {
    matched++;
    byRule.set(event.rule, (byRule.get(event.rule) ?? 0) + 1);
    continue;
  }
  const sig = signature(parsed.body);
  const entry = unknown.get(sig) ?? { count: 0, example: parsed.body };
  entry.count++;
  unknown.set(sig, entry);
}

const ranked = [...unknown.values()].sort((a, b) => b.count - a.count);

const report = [];
report.push(`# Unknown lines in ${path.basename(logFile)}`);
report.push(`# ${lines.length} lines, ${matched} matched, ${unknown.size} distinct unmatched shapes`);
report.push('');
for (const { count, example } of ranked) {
  report.push(`${String(count).padStart(5)}  ${example}`);
}

fs.writeFileSync(outFile, report.join('\n') + '\n', 'latin1');

console.log(`lines:        ${lines.length}`);
console.log(`matched:      ${matched}`);
console.log(`unmatched:    ${lines.length - matched - malformed} (${unknown.size} distinct shapes)`);
console.log(`no timestamp: ${malformed}`);
console.log(`\nrule hits:`);
for (const [id, n] of [...byRule].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${id}`);
}
console.log(`\nwrote ${outFile}`);

if (showAll) {
  console.log('\ntop unmatched shapes:');
  for (const { count, example } of ranked.slice(0, 40)) {
    console.log(`  ${String(count).padStart(4)}  ${example}`);
  }
}
