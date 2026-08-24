#!/usr/bin/env node
/**
 * Measure which mob drops which quest item, from the player's own log.
 *
 *   node scripts/mine-drops.js <eqlog file> [--min 1] [--dir <userData>/quests --write]
 *
 * The drops popup answers "does this corpse owe me anything", and it can only answer
 * it for mobs it knows. The quest dataset cannot supply that list: six of its eighteen
 * `source` strings describe a FAMILY rather than a name ("Island 7: drake/sphinx/spirit
 * mobs", `Island 6: "bee" mobs`), and the ones that do name a mob name only the island
 * boss — so a spiroc trash mob standing on your own Spiroc Earth Totem is invisible to
 * it. The alternative to a list is a shipped member TABLE, and that is the failure mode
 * CLAUDE.md names for a shipped spell-duration table: Legends is a custom server, a
 * list transcribed from a classic wiki is wrong for everybody in a slightly different
 * way, and it fails silently.
 *
 * So this measures, exactly as `mine-rhythms.js` and `mine-buffs.js` do. EQ prints the
 * corpse on every loot line — "--You have looted a Spiroc Elder's Totem from The Spiroc
 * Lord's corpse.--" — the session loot rules already capture it, and the live overlay
 * now records it as it arrives. This script is the backfill for everything looted
 * BEFORE it did: one pass over an existing log, and a character's index starts at what
 * their log already proves rather than at empty.
 *
 * PRINTS BY DEFAULT, writes only with `--write`, which is the house rule for every
 * miner here — a measurement is worth reading before it is worth storing.
 *
 * Dedup on write is a per-pair MAX, not a sum: re-running this over the same log, or
 * running it against a log the live overlay has already counted, leaves every count
 * exactly where it was. Both numbers are lower bounds on "times this character watched
 * it drop", and the larger is the better one. The cost of that choice, stated plainly:
 * mining two DIFFERENT logs folds in only what each alone proves rather than their sum,
 * so a count can be short. It can never be invented, and no count decides anything —
 * a mob is in the index or it is not.
 */

import fs from 'node:fs';
import path from 'node:path';
import { LogParser } from '../src/parser/index.js';
import { QuestProgress, questStoreKey } from '../src/quests/progress.js';
import { questItemKey, lookup } from '../src/quests/index.js';
import { parseTimestamp } from '../src/parser/timestamp.js';
import { CHAT_RULE_IDS } from '../src/parser/rules.js';
import { matchSessionRule } from '../src/session/rules.js';

const args = process.argv.slice(2);
const write = args.includes('--write');
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : fallback;
};
const dir = flagValue('--dir', null);
const min = Number(flagValue('--min', 1)) || 1;
const consumed = new Set([dir, flagValue('--min', null)]);
const logPath = args.find((a) => !a.startsWith('--') && !consumed.has(a));

if (!logPath || (write && !dir)) {
  console.error('usage: node scripts/mine-drops.js <eqlog file> [--min 1] [--dir <quests dir> --write]');
  console.error('  --dir is <userData>/quests — on Windows, %APPDATA%\\eq-legends-dps-overlay\\quests');
  process.exit(1);
}

/** The parser's chat verdicts — the same guard `QuestProgress#feedLine` keys on. */
const SPEECH = new Set(CHAT_RULE_IDS);
const LOOT_ONLY = (category) => category === 'loot';

// The parser runs for one reason: it is what classifies a line as SPEECH, so a player
// quoting a loot line in /general never reaches the count. Same two-argument contract
// main.js feeds the live store with, so this pass and that one agree by construction.
const parser = new LogParser({ logFilename: path.basename(logPath) });

/** creature key → item key → count, and the same keyed by dataset name for printing. */
const drops = new Map();
let lootLines = 0;
let questLines = 0;

// latin1, never utf8 — EQ writes single-byte text and utf8 mangles accented mob names.
for (const line of fs.readFileSync(logPath, 'latin1').split(/\r?\n/)) {
  if (!line) continue;
  const event = parser.feed(line);
  if (event && SPEECH.has(event.rule)) continue;
  const parsed = parseTimestamp(line);
  if (!parsed) continue;
  const session = matchSessionRule(parsed.body, LOOT_ONLY);
  if (!session || session.kind !== 'loot' || !session.from) continue;
  lootLines++;
  // The same `lookup()` gate the store applies: this is a quest ledger, not a second
  // loot pane, and the night's ordinary drops are not its business.
  const refs = lookup(session.item);
  if (!refs.length) continue;
  questLines++;
  const key = questItemKey(session.item);
  const mob = drops.get(session.from) ?? new Map();
  mob.set(key, (mob.get(key) ?? 0) + (session.qty ?? 1));
  drops.set(session.from, mob);
}

const character = parser.selfName;
const server = parser.server;
const nameOf = (key) => lookup(key)[0]?.itemName ?? key;

// Widest first: the mobs that owe the most are the ones worth eyeballing.
const ranked = [...drops.entries()]
  .map(([mob, items]) => ({
    mob,
    items: [...items.entries()]
      .filter(([, n]) => n >= min)
      .sort((a, b) => b[1] - a[1] || nameOf(a[0]).localeCompare(nameOf(b[0]))),
  }))
  .filter((row) => row.items.length)
  .sort((a, b) => {
    const total = (r) => r.items.reduce((n, [, c]) => n + c, 0);
    return total(b) - total(a) || a.mob.localeCompare(b.mob);
  });

console.log(`${character} (${server}): ${lootLines} corpse-loot line(s), ${questLines} of them quest items`);
console.log(`${ranked.length} mob(s) drop something the quest data wants${min > 1 ? ` at least ${min}×` : ''}\n`);
for (const row of ranked) {
  console.log(row.mob);
  for (const [key, count] of row.items) console.log(`  ${String(count).padStart(4)}  ${nameOf(key)}`);
}
if (min > 1) {
  const hidden = drops.size - ranked.length;
  if (hidden > 0) console.log(`\n(${hidden} mob(s) hidden by --min ${min})`);
}

if (!write) {
  console.log('\nNothing written. Pass --dir <quests dir> --write to fold this into the ledger.');
  process.exit(0);
}

// `--min` is a READING filter and deliberately not a writing one: a drop seen once is
// a fact, and the popup's job is to report it. Fold everything.
const store = new QuestProgress({ dir, character, server });
store.state.drops ??= {};
let raised = 0;
let unchanged = 0;
for (const [mob, items] of drops) {
  const existing = store.state.drops[mob] ?? (store.state.drops[mob] = {});
  for (const [key, count] of items) {
    if ((existing[key] ?? 0) >= count) { unchanged++; continue; }
    existing[key] = count;
    raised++;
  }
}
store.revision++;
store.persist();
console.log(`\n${raised} pair(s) raised, ${unchanged} already at least that high`);
console.log(`written to ${path.join(dir, `${questStoreKey(character, server)}.json`)}`);
