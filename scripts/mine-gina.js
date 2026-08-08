#!/usr/bin/env node
/**
 * Mine a directory of GINA packages for spell knowledge.
 *
 * A public trigger package is a stranger's hard-won notes on what a boss does. One pack
 * is one author's opinion; the same spell named across many INDEPENDENT packs is a fact
 * about the game, and facts about spells belong in `src/parser/spellwatch.js`.
 *
 * This prints candidates and never writes anything — the same discipline
 * `collect-unknown.js` follows, and for the same reason: the curated table is curated,
 * and a script that edited it would quietly turn a reviewed list into a scraped one.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It does not touch the shipped boss-timer pack. Every duration in `seed-pack.js` was
 *    measured off a real log by `mine-rhythms.js` and reviewed by hand, and merging
 *    authored GINA durations into it would turn a file of measurements into a file of
 *    claims while its own description went on saying the former. A pack of durations mined
 *    from a corpus would be a fine thing to ship — as its OWN pack, saying where it came
 *    from.
 *  - It does not propose shipping anyone's pack. The spell names are not authorship;
 *    the packs are.
 *
 * The mining itself lives in `src/triggers/mine.js` so it can be unit-tested; this is
 * the command line around it.
 *
 * Usage:
 *   node scripts/mine-gina.js <dir> [--min 2] [--json]
 *
 *   <dir>    a directory of .gtp and/or .xml files
 *   --min N  how many independent packs must agree before a name is a candidate (default 2)
 *   --json   machine-readable output instead of the review table
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseGinaPackage } from '../src/triggers/gina.js';
import { classify } from '../src/parser/spellwatch.js';
import { mineSpellNames } from '../src/triggers/mine.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const minPacks = Number(args[args.indexOf('--min') + 1]) || 2;
const asJson = args.includes('--json');

if (!dir) {
  console.error('usage: node scripts/mine-gina.js <dir> [--min 2] [--json]');
  process.exit(1);
}

const files = fs.readdirSync(dir).filter((f) => /\.(gtp|xml)$/i.test(f));
if (!files.length) {
  console.error(`no .gtp or .xml files in ${dir}`);
  process.exit(1);
}

const packs = [];
const failed = [];

for (const file of files) {
  try {
    const { pack } = parseGinaPackage(fs.readFileSync(path.join(dir, file)), {
      name: file.replace(/\.\w+$/i, ''),
    });
    packs.push(pack);
  } catch (err) {
    // One unreadable package must not stop the sweep — the whole point is breadth.
    failed.push(`${file}: ${err.message}`);
  }
}

const { candidates } = mineSpellNames(packs, { minPacks, classify });
const fresh = candidates.filter((c) => !c.known);
const confirmed = candidates.filter((c) => c.known);

if (asJson) {
  console.log(JSON.stringify({ packsRead: packs.length, minPacks, fresh, confirmed, failed }, null, 2));
} else {
  console.log(`Read ${packs.length}/${files.length} packages from ${dir}`);
  if (failed.length) {
    console.log(`\n${failed.length} would not parse:`);
    for (const f of failed) console.log(`  ${f}`);
  }

  console.log(`\n=== ${fresh.length} candidates for spellwatch.js (named by >= ${minPacks} packs) ===\n`);
  if (!fresh.length) {
    console.log('  none.\n');
    console.log('  Worth knowing rather than disappointing: the patterns that survive a');
    console.log('  port between servers are the ones that never say a spell\'s name —');
    console.log('  emotes like "(?<mob>.*) yawns" are identical everywhere, while a named');
    console.log('  spell picks up a rank suffix and stops matching. A corpus can be');
    console.log('  valuable to a player and still hold nothing for a name-keyed table.');
  }
  for (const c of fresh) {
    console.log(`  ${c.spell}`);
    console.log(`    ${c.packs} packs: ${c.packNames.join(', ')}`);
    for (const s of c.samples) console.log(`    e.g. ${s}`);
    console.log('');
  }

  console.log(`\n=== ${confirmed.length} already classified — the table agreeing with the corpus ===\n`);
  for (const c of confirmed) {
    console.log(`  ${c.spell.padEnd(34)} ${c.known.group}/${c.known.category} (${c.packs} packs)`);
  }

  console.log(
    '\nNothing was written. Review these by hand, then add the ones that are real to\n' +
    "src/parser/spellwatch.js marked as corpus-derived rather than (confirmed) — the\n" +
    'existing provenance convention: (confirmed) means seen in a live session, and a\n' +
    'name that only ever appeared in someone else\'s pack has not been.',
  );
}
