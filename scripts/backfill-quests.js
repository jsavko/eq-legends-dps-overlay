#!/usr/bin/env node
/**
 * Backfill the Plane of Sky quest ledger from an existing EverQuest log.
 *
 * The tracker normally begins counting the day the feature ships — this replays a whole
 * log through the same rules + store the app uses, so the window's first opening shows
 * everything the log already knows (~30 Sky runs in the live one).
 *
 *   node scripts/backfill-quests.js <eqlog file> --dir <userData>/quests [--dry-run]
 *
 * Dedup-safe by the store's own floor: every counted event advances a persisted
 * high-water mark, and events at or before it are skipped. Running this twice, or
 * running it while the overlay is live, never doubles a rune.
 */

import fs from 'node:fs';
import path from 'node:path';
import { LogParser } from '../src/parser/index.js';
import { CHAT_RULE_IDS } from '../src/parser/rules.js';
import { parseTimestamp } from '../src/parser/timestamp.js';
import { matchSessionRule } from '../src/session/rules.js';
import { QuestProgress } from '../src/quests/progress.js';
import { lookup, offerSlots } from '../src/quests/index.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dirIdx = args.indexOf('--dir');
const dir = dirIdx !== -1 ? args[dirIdx + 1] : null;
const logPath = args.find((a) => !a.startsWith('--') && a !== dir);

if (!logPath || !dir) {
  console.error('usage: node scripts/backfill-quests.js <eqlog file> --dir <quests dir> [--dry-run]');
  process.exit(1);
}

// The parser rides along for one job: classifying chat FIRST, so a quoted loot line in
// /general never scores. Exactly the guard main.js and the session tracker use.
const parser = new LogParser({ logFilename: path.basename(logPath) });
const speech = new Set(CHAT_RULE_IDS);

const store = new QuestProgress({
  dir,
  character: parser.selfName,
  server: parser.server,
  onWriteError: (err) => { console.error(`write failed: ${err.message}`); process.exit(1); },
});
if (dryRun) store.persist = () => {};   // count in memory, touch nothing

let counted = 0;
let offers = 0;
let skipped = 0;

// latin1, never utf8 — EQ writes single-byte text and utf8 mangles accented mob names.
for (const line of fs.readFileSync(logPath, 'latin1').split(/\r?\n/)) {
  if (!line) continue;
  const parserEvent = parser.feed(line);
  if (parserEvent && speech.has(parserEvent.rule)) continue;
  const parsed = parseTimestamp(line);
  if (!parsed) continue;
  const event = matchSessionRule(parsed.body, (c) => c === 'loot');
  if (!event || (event.kind !== 'loot' && event.kind !== 'offer')) continue;
  event.ts = parsed.ts;
  // The night's ordinary loot, vendor feeding and player trades — not ours. The same
  // scoping the store applies, applied here first only so `skipped` keeps meaning
  // "a quest event at or below the recorded high-water mark" and nothing else.
  if (event.kind === 'loot' && !lookup(event.item).length) continue;
  if (event.kind === 'offer' && !offerSlots(event.npc, event.item).length) continue;
  if (store.feed(event)) { counted++; if (event.kind === 'offer') offers++; }
  else skipped++;
}

const totals = store.state?.items ?? {};
const lines = Object.entries(totals)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([item, split]) => {
    const total = Object.values(split).reduce((n, v) => n + v, 0);
    const parts = Object.entries(split).map(([d, n]) => `${n} ${d}`).join(', ');
    return `  ${item}: ${total} (${parts})`;
  });

console.log(`${parser.selfName} (${parser.server}): ${counted} quest event(s) ${dryRun ? 'would be ' : ''}counted (${offers} hand-ins), ${skipped} already recorded`);
if (lines.length) console.log(lines.join('\n'));

// The turn-ins the replayed offers now prove, with the source of each claim — the
// list to eyeball against an eqlposky export: agreement is confidence, disagreement
// is either pre-log history (expected) or a bug (interesting either way).
const snap = store.snapshot();
const derived = [];
for (const cls of snap?.classes ?? []) {
  for (const quest of cls.quests) {
    if (quest.done) derived.push(`  ${cls.name}: ${quest.reward} (${quest.doneSource})`);
  }
}
if (derived.length) console.log(`\n${derived.length} quest(s) stand done:\n${derived.join('\n')}`);

// The floor is one timestamp, so it cannot tell "this log was backfilled" from "a live
// overlay tailed the last 64 KB of it once". If the overlay ran before this script, its
// mark postdates the whole log and everything skips — say so, instead of printing a
// zero that reads like an empty log.
if (counted === 0 && skipped > 0) {
  console.log(
    '\nnothing counted: the store\'s high-water mark postdates this log — a running\n' +
    'overlay has already counted past it. To backfill the history from before the\n' +
    `mark: quit the overlay, delete ${store.fileFor(store.character, store.server)},\n` +
    'and re-run — the replay rebuilds the mark at the log\'s true end.',
  );
}
