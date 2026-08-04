#!/usr/bin/env node
/**
 * Backfill the encounter history from an existing EverQuest log.
 *
 * History normally begins the day the feature ships — this replays a whole log through
 * the same parser + store the app uses, so past raid nights become browsable too.
 *
 *   node scripts/backfill-history.js <eqlog file> --dir <userData>/history [--dry-run]
 *
 * Records are deduplicated by id (startTs-endTs) against whatever is already in the
 * store, so running this while the overlay is live, or running it twice, never doubles
 * a fight: replay and live tailing close the same encounter with the same timestamps.
 */

import fs from 'node:fs';
import path from 'node:path';
import { LogParser } from '../src/parser/index.js';
import { EncounterStore, RECORD_VERSION, storeKey } from '../src/main/history.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dirIdx = args.indexOf('--dir');
const dir = dirIdx !== -1 ? args[dirIdx + 1] : null;
const logPath = args.find((a) => !a.startsWith('--') && a !== dir);

if (!logPath || !dir) {
  console.error('usage: node scripts/backfill-history.js <eqlog file> --dir <history dir> [--dry-run]');
  process.exit(1);
}

const store = new EncounterStore(dir);
const filename = path.basename(logPath);

// Everything the store already has, so a re-run (or a live overlay) never duplicates.
const probe = new LogParser({ logFilename: filename });
const key = storeKey(probe.selfName, probe.server);
const existing = new Set(store.records(key).map((r) => r.id));

let written = 0;
let skipped = 0;

const parser = new LogParser({
  logFilename: filename,
  onEncounterEnd: (enc) => {
    // Identical to main.js's persistEncounter, minus Electron.
    const snap = enc.snapshot(enc.endTs);
    if (snap.totalDamage === 0 && snap.totalDamageTaken === 0) return;
    const id = `${enc.startTs}-${enc.endTs}`;
    if (existing.has(id)) {
      skipped++;
      return;
    }
    written++;
    if (dryRun) return;
    store.append({
      v: RECORD_VERSION,
      id,
      character: parser.selfName,
      server: parser.server,
      zone: parser.zone,
      label: snap.label,
      startTs: enc.startTs,
      endTs: enc.endTs,
      durationMs: snap.durationMs,
      closeReason: snap.closeReason,
      snapshot: { ...snap, self: parser.selfName, zone: parser.zone },
    });
  },
});

// latin1, never utf8 — EQ writes single-byte text and utf8 mangles accented mob names.
parser.feedChunk(fs.readFileSync(logPath, 'latin1'));
// Flush the final fight, whose idle timeout never elapses inside the log itself.
parser.tick(Number.MAX_SAFE_INTEGER);

console.log(`${parser.selfName} (${parser.server}): ${written} encounter(s) ${dryRun ? 'would be ' : ''}written, ${skipped} already present`);
