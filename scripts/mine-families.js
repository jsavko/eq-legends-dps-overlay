#!/usr/bin/env node
/**
 * Measure which mobs belong to the quest data's FAMILY source strings — and, the part
 * that matters more, report every Sky mob the table does not account for.
 *
 *   node scripts/mine-families.js <eqlog file> [--min 1] [--write]
 *
 * Six of the dataset's eighteen source strings describe a family rather than a name —
 * `Island 6: "bee" mobs`, `Island 7: drake/sphinx/spirit mobs`, `Island 5: spiroc
 * mobs`, `Island 4: essence/soul mobs, Eternal Spirit`, and two more. The log never
 * writes those words, so the popup's equality match can never fire on them, and the
 * eight items they source were invisible. `src/quests/families.json` is the answer:
 * a hand-reviewed member list, and this is the script that seeds and audits it.
 *
 * WHY THIS IS A MINER AND NOT A LOOKUP. The obvious composition — "Bzzzt dropped Bixie
 * Essence, whose source is `"bee" mobs`, therefore Bzzzt is a bee" — was built and
 * measured before the table was written, and it fails twice. It misses the live case
 * (the Adamantium Earring is sourced to `Bazzt Zzzt "Bees"`, a second and differently
 * spelled bee blob, so proving Bzzzt is a `"bee" mobs` member says nothing about it),
 * and it over-generalises through multi-source items (`Efreeti Statuette` is sourced to
 * two island-4 griffon blobs, so every efreeti boss that ever dropped one gets tagged a
 * griffon). So the inference RANKS candidates for a human; it does not decide.
 *
 * The three sections it prints, in the order they are worth reading:
 *
 *   1. **Unaccounted for** — mobs your log killed in Sky that no shipped chip and no
 *      family claims. This is the whole point of the script. A member table's failure
 *      mode is silence, and this is the list that breaks it: if the popup ever seems
 *      quiet on something you farm, its name is here.
 *   2. **Candidates** — per family chip, mobs that dropped an item that chip sources.
 *      Evidence, not membership: read it, then write the entry by hand.
 *   3. **Confirmed / unseen** — what the shipped table already claims, split by whether
 *      this log has ever seen the mob at all. An entry nothing has ever seen is not
 *      wrong, but it is unverified and says so.
 *
 * PRINTS BY DEFAULT, writes only with `--write`, which is the house rule for every
 * miner here — a measurement is worth reading before it is worth storing. `--write`
 * folds candidates into `src/quests/families.json` as `how: "log"` members and never
 * removes or rewrites a `how: "hand"` one: the file is hand-reviewed data and this
 * script is its assistant, not its author.
 */

import fs from 'node:fs';
import path from 'node:path';
import { LogParser } from '../src/parser/index.js';
import { POSKY, lookup } from '../src/quests/index.js';
import { parseSources } from '../src/quests/needs.js';
import { parseTimestamp } from '../src/parser/timestamp.js';
import { CHAT_RULE_IDS } from '../src/parser/rules.js';
import { matchSessionRule } from '../src/session/rules.js';
import { stripArticle } from '../src/parser/entities.js';

const FAMILIES_FILE = new URL('../src/quests/families.json', import.meta.url);

const args = process.argv.slice(2);
const write = args.includes('--write');
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : fallback;
};
const min = Number(flagValue('--min', 1)) || 1;
const consumed = new Set([flagValue('--min', null)]);
const logPath = args.find((a) => !a.startsWith('--') && !consumed.has(a));

if (!logPath) {
  console.error('usage: node scripts/mine-families.js <eqlog file> [--min 1] [--write]');
  process.exit(1);
}

/** The same fold every matcher on both sides compares on — see needs.js `mobKey`. */
const mobKey = (name) => stripArticle(String(name ?? '').trim()).toLowerCase();
const groupKey = (island, mob) => `${island ?? ''}|${mob}`;

// --------------------------------------------------------------- the dataset's chips

/**
 * Every source chip in the dataset, and the items it sources. A chip is a FAMILY when
 * no log line will ever write its text as a creature name — which is not a judgement
 * about the words, it is what `families.json` declares, plus anything the file has not
 * got to yet. Detecting it structurally (lowercase, contains "mobs", …) would be the
 * substring guessing this project keeps refusing; the file is the list.
 */
const chips = new Map();
for (const cls of POSKY.classes) {
  for (const quest of cls.quests) {
    for (const item of quest.items) {
      for (const chip of parseSources(item.source)) {
        if (chip.zoneWide) continue;
        const key = groupKey(chip.island, chip.mob);
        const entry = chips.get(key) ?? { island: chip.island, mob: chip.mob, items: new Set() };
        entry.items.add(item.name);
        chips.set(key, entry);
      }
    }
  }
}

/**
 * item name → how many distinct chips source it. The screen that keeps `--write` from
 * repeating the exact over-generalisation the plan measured: `Efreeti Statuette` is
 * sourced to two island-4 griffon blobs and drops off three efreeti bosses, so folding
 * "dropped it → member of it" in unscreened tags Noble Dojorn a griffon. One chip means
 * the drop can only have come from that chip's family; two or more and the evidence is
 * silent about which, so it stays a line in the report and never becomes an entry.
 */
const chipsPerItem = new Map();
for (const chip of chips.values()) {
  for (const item of chip.items) chipsPerItem.set(item, (chipsPerItem.get(item) ?? 0) + 1);
}

/** The shipped supplement, or an empty one — a missing file is a seeding run, not an error. */
const shipped = (() => {
  try {
    return JSON.parse(fs.readFileSync(FAMILIES_FILE, 'utf8'));
  } catch {
    return { families: [] };
  }
})();
const shippedByKey = new Map(
  (shipped.families ?? []).map((f) => [groupKey(f.island, f.mob), f]),
);

/** Every chip text the popup can match by equality: a named chip, or a family member. */
const claimed = new Map();
for (const [key, chip] of chips) {
  if (shippedByKey.has(key)) continue;
  claimed.set(mobKey(chip.mob), `${chip.island ? `ISL ${chip.island} ` : ''}${chip.mob}`);
}
for (const family of shipped.families ?? []) {
  for (const member of family.members ?? []) {
    if (!claimed.has(mobKey(member.name))) claimed.set(mobKey(member.name), `${family.mob}`);
  }
}

// ------------------------------------------------------------------- read the log

/** The parser's chat verdicts — the same guard every miner keys on. */
const SPEECH = new Set(CHAT_RULE_IDS);
const LOOT_ONLY = (category) => category === 'loot';

/**
 * Which zone each kill happened in, so the unaccounted-for list is Sky's mobs and not
 * the whole server's. `You have entered <zone>.` is the only zone fact in the log and
 * it is exactly enough: everything killed between two of them was killed in the first.
 * The match is a substring rather than equality because Legends writes instanced Sky
 * several ways ("The Plane of Sky", "The Plane of Sky 1 (Awakened)") and, on the way
 * up, the levitation warning replaces the zone name entirely.
 */
const SKY_ZONE = /plane of sky/i;
const NO_LEVITATE = /levitation effects do not function/i;

/**
 * Every name the parser has ever placed in a fight's enemy set — its own answer to
 * "is this a mob", derived from the fight rather than from the shape of the name.
 * Slain lines alone are not enough: the log writes one for every group member who
 * dies too, and "Dvaril has been slain by a greater sphinx" would put a person on the
 * unaccounted-for list. `looksLikeMobName` cannot rescue that either — it only ever
 * says "certainly a mob", and a bare token like `Bzzzt` is exactly the shape it leaves
 * unanswered. The fight decides, here as everywhere else.
 */
const engaged = new Set();
const parser = new LogParser({
  logFilename: path.basename(logPath),
  onEncounterEnd: (encounter) => {
    for (const name of encounter.engagedNpcs.keys()) engaged.add(mobKey(name));
  },
});

/** creature key → { name, kills } for everything killed in Sky. */
const skyMobs = new Map();
/** chip key → creature key → { name, items: Map<itemName, count> } */
const candidates = new Map();
let zone = null;
let inSky = false;
let lootLines = 0;

// latin1, never utf8 — EQ writes single-byte text and utf8 mangles accented mob names.
for (const line of fs.readFileSync(logPath, 'latin1').split(/\r?\n/)) {
  if (!line) continue;
  const parsed = parseTimestamp(line);
  if (!parsed) continue;
  const event = parser.feed(line);
  if (event && SPEECH.has(event.rule)) continue;

  const entered = /^You have entered (.+?)\.$/.exec(parsed.body);
  if (entered) {
    zone = entered[1];
    // The levitation warning fires INSIDE Sky, on the climb, and carries no zone name.
    // Treating it as "not Sky" would drop most of the island-1 vocabulary.
    if (!NO_LEVITATE.test(zone)) inSky = SKY_ZONE.test(zone);
    continue;
  }

  if (inSky) {
    let slain = /^(.+?) (?:has been slain by|died)\b/.exec(parsed.body);
    if (!slain) slain = /^You have slain (.+?)!$/.exec(parsed.body);
    if (slain) {
      const name = stripArticle(slain[1].trim());
      const key = mobKey(name);
      const row = skyMobs.get(key) ?? { name, kills: 0 };
      row.kills++;
      if (key) skyMobs.set(key, row);
    }
  }

  const session = matchSessionRule(parsed.body, LOOT_ONLY);
  if (!session || session.kind !== 'loot' || !session.from) continue;
  lootLines++;
  const refs = lookup(session.item);
  if (!refs.length) continue;
  const itemName = refs[0].itemName;

  // The inference, stated plainly: this corpse dropped an item, and some chip sources
  // that item — so this corpse is a CANDIDATE member of that chip. Only offered for
  // chips the shipped file calls families; a named chip needs no members.
  for (const [key, chip] of chips) {
    if (!chip.items.has(itemName)) continue;
    if (!shippedByKey.has(key)) continue;
    const bucket = candidates.get(key) ?? new Map();
    const mob = bucket.get(mobKey(session.from)) ?? { name: session.from, items: new Map() };
    mob.items.set(itemName, (mob.items.get(itemName) ?? 0) + (session.qty ?? 1));
    bucket.set(mobKey(session.from), mob);
    candidates.set(key, bucket);
  }
}

// ------------------------------------------------------------------------- report

const character = parser.selfName;
const server = parser.server;
const skyMobCount = [...skyMobs.keys()].filter((k) => engaged.has(k)).length;
console.log(`${character} (${server}): ${lootLines} corpse-loot line(s), ${skyMobCount} distinct mob(s) killed in Sky`);
console.log(`${chips.size} named/family chip(s) in the dataset, ${shippedByKey.size} of them declared families\n`);

// 1 — the list that stops the table failing silently.
const unaccounted = [...skyMobs.values()]
  .filter((row) => engaged.has(mobKey(row.name)))
  .filter((row) => !claimed.has(mobKey(row.name)) && row.kills >= min)
  .sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name));
console.log('UNACCOUNTED FOR — killed in Sky, claimed by no chip and no family');
if (!unaccounted.length) console.log('  (none — every Sky mob this log killed is named or in a family)');
for (const row of unaccounted) console.log(`  ${String(row.kills).padStart(4)}×  ${row.name}`);

// 2 — evidence, per family, for the hand review.
console.log('\nCANDIDATES — dropped something the family sources (evidence, not membership)');
for (const [key, family] of shippedByKey) {
  const bucket = candidates.get(key);
  const chip = chips.get(key);
  console.log(`\n  ${family.mob}${family.island ? ` (island ${family.island})` : ''}`);
  console.log(`    sources: ${[...(chip?.items ?? [])].join(', ') || '(nothing this dataset knows)'}`);
  if (!bucket?.size) { console.log('    (nothing in this log has dropped one)'); continue; }
  for (const mob of [...bucket.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const how = (family.members ?? []).find((m) => mobKey(m.name) === mobKey(mob.name));
    const sole = [...mob.items.keys()].some((name) => chipsPerItem.get(name) === 1);
    const mark = how ? `already listed (${how.how})`
      : sole ? 'NOT LISTED — sole-source evidence'
        : 'NOT LISTED — shared-source evidence only, decide by hand';
    console.log(`    ${mob.name} — ${[...mob.items].map(([n, c]) => `${n} ×${c}`).join(', ')}  [${mark}]`);
  }
}

// 3 — what the table claims, against what this log has ever seen.
console.log('\nSHIPPED TABLE — what families.json claims, checked against this log');
for (const family of shipped.families ?? []) {
  const seen = [];
  const unseen = [];
  for (const member of family.members ?? []) {
    (engaged.has(mobKey(member.name)) ? seen : unseen).push(`${member.name} (${member.how})`);
  }
  console.log(`\n  ${family.mob}${family.island ? ` (island ${family.island})` : ''}`);
  console.log(`    seen in this log:  ${seen.join(', ') || '(none)'}`);
  console.log(`    never seen here:   ${unseen.join(', ') || '(none)'}`);
}

if (!write) {
  console.log('\nNothing written. Pass --write to fold the sole-source candidates in as `how: "log"` members.');
  process.exit(0);
}

// `--write` only ever ADDS, only ever as `log`, and only on SOLE-source evidence. A
// hand entry is a human's reading of the zone and this script has no standing to
// overrule it; a shared-source drop proves nothing about which family it came from and
// stays in the report where a human can act on it.
let added = 0;
let held = 0;
for (const family of shipped.families ?? []) {
  const bucket = candidates.get(groupKey(family.island, family.mob));
  if (!bucket) continue;
  family.members ??= [];
  for (const mob of [...bucket.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (family.members.some((m) => mobKey(m.name) === mobKey(mob.name))) continue;
    if (![...mob.items.keys()].some((name) => chipsPerItem.get(name) === 1)) { held++; continue; }
    family.members.push({ name: mob.name, how: 'log' });
    added++;
  }
}
fs.writeFileSync(FAMILIES_FILE, `${JSON.stringify(shipped, null, 2)}\n`);
console.log(`\n${added} member(s) added to ${path.relative(process.cwd(), FAMILIES_FILE.pathname)}`);
if (held) console.log(`${held} held back on shared-source evidence — promote by hand if the zone agrees.`);
console.log('Review them by hand — a candidate is evidence, not a decision.');
