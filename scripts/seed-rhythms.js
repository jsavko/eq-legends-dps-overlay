#!/usr/bin/env node
/**
 * Seed the boss-rhythm store from an existing EverQuest log.
 *
 * Spell timers normally begin learning the day the feature ships — this replays a
 * whole log through the same parser + store the app uses, so every named boss the
 * character has already fought starts with its rhythms known, and the next pull
 * arms timers from the first cast.
 *
 *   node scripts/seed-rhythms.js <eqlog file> --dir <userData>/rhythms [--dry-run] [--fresh]
 *
 * Unlike backfill-history there is no per-fight id to deduplicate on: merging pools
 * statistics, so running this twice pools the same fights twice. The interval and
 * spread are unchanged by that (pooling a value with itself moves nothing), but the
 * sample count inflates toward its cap — pass --fresh to wipe this server's file
 * first and rebuild from the log alone when re-seeding.
 *
 * `lastSeen` is stamped with each fight's own end time, not the seeding time: the
 * store records when the boss was actually seen, and any future stale-rhythm cleanup
 * should judge historical fights as historical.
 */

import fs from 'node:fs';
import path from 'node:path';
import { LogParser } from '../src/parser/index.js';
import { RhythmStore } from '../src/main/rhythms.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fresh = args.includes('--fresh');
const dirIdx = args.indexOf('--dir');
const dir = dirIdx !== -1 ? args[dirIdx + 1] : null;
const logPath = args.find((a) => !a.startsWith('--') && a !== dir);

if (!logPath || !dir) {
  console.error('usage: node scripts/seed-rhythms.js <eqlog file> --dir <rhythms dir> [--dry-run] [--fresh]');
  process.exit(1);
}

const store = new RhythmStore(dir);
let fights = 0;

const parser = new LogParser({
  logFilename: path.basename(logPath),
  onRhythmsLearned: (learned) => {
    fights++;
    if (dryRun) return;
    // The closed encounter is parser.last by the time this fires — its end time is
    // the honest lastSeen for everything it taught.
    store.merge(parser.server, learned, parser.last?.endTs ?? Date.now());
  },
});

if (fresh && !dryRun) {
  fs.rmSync(store.file(parser.server), { force: true });
}

// latin1, never utf8 — EQ writes single-byte text and utf8 mangles accented mob names.
parser.feedChunk(fs.readFileSync(logPath, 'latin1'));
// Flush the final fight, whose idle timeout never elapses inside the log itself.
parser.tick(Number.MAX_SAFE_INTEGER);

const label = `${parser.selfName} (${parser.server ?? 'unknown server'})`;
if (dryRun) {
  console.log(`${label}: ${fights} fight(s) taught rhythms — dry run, nothing written`);
} else {
  const known = store.knownFor(parser.server)
    .sort((a, b) => a.caster.localeCompare(b.caster) || a.ability.localeCompare(b.ability));
  console.log(`${label}: ${fights} fight(s) merged; the store now knows ${known.length} rhythm(s):`);
  for (const r of known) {
    console.log(
      `  ${r.caster} | ${r.ability} | ~${(r.intervalMs / 1000).toFixed(1)}s ` +
      `±${(r.spreadMs / 1000).toFixed(1)} (n=${r.samples})`
    );
  }
}
