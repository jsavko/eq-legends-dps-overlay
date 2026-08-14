#!/usr/bin/env node
/**
 * Refresh `src/quests/posky.json` from eqlposky.com.
 *
 *   node scripts/fetch-posky.js            # fetch, transform, diff — writes nothing
 *   node scripts/fetch-posky.js --write    # fetch, transform, and commit the result
 *
 * The site serves its whole dataset as two static files — `data.js` exposing
 * `window.POSKY_DATA` (16 classes, 95 class-unlock quests, each quest a reward plus the
 * turn-in items with their drop sources) and `item-details.js` exposing
 * `window.POSKY_ITEM_DETAILS` (per-item stats text scraped from the P99 wiki). Both are
 * plain `window.X = {...}` assignments, so they are evaluated in a bare `node:vm`
 * sandbox rather than parsed by hand.
 *
 * Two things about the transform are load-bearing and must survive any future edit:
 *
 *   - CLASS IDS AND ARRAY ORDER ARE THE SITE'S, VERBATIM. The site's progress export
 *     keys are positional — `bard:0:0` means class : quest index : item index — and the
 *     Quests window resolves an imported export through those positions. Reordering a
 *     quest here would silently move every checkmark below it onto the wrong item.
 *
 *   - Only stats TEXT is carried over, never the wiki/icon URLs. The app ships no media
 *     and must not hotlink a fan site's image CDN from a window that opens every session.
 *
 * Without `--write` this prints what changed against the committed file and exits, so a
 * refresh shows what moved upstream before anything is overwritten.
 */

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://www.eqlposky.com';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'quests', 'posky.json');

const write = process.argv.includes('--write');

/** Evaluate one of the site's `window.X = {...}` files and hand back the X. */
async function fetchGlobal(file, name) {
  const res = await fetch(`${SITE}/${file}`);
  if (!res.ok) throw new Error(`${SITE}/${file}: HTTP ${res.status}`);
  const sandbox = { window: {} };
  vm.runInNewContext(await res.text(), sandbox, { filename: file, timeout: 5000 });
  const value = sandbox.window[name];
  if (!value) throw new Error(`${file} evaluated but window.${name} is missing`);
  return value;
}

const [data, details] = await Promise.all([
  fetchGlobal('data.js', 'POSKY_DATA'),
  fetchGlobal('item-details.js', 'POSKY_ITEM_DETAILS'),
]);

/** Stats text for one reward, or null — absence is honest, a guessed stat line is not. */
function statsFor(reward) {
  const entry = details.items?.[reward];
  return entry?.ok && entry.stats ? entry.stats : null;
}

const transformed = {
  attribution: {
    source: `${SITE}/ (data.js + item-details.js)`,
    upstream: data.source ?? null,
    stats: details.sourceNote ?? null,
    fetched: new Date().toISOString().slice(0, 10),
  },
  classes: (data.classes ?? []).map((cls) => ({
    id: cls.id,
    name: cls.name,
    npc: cls.npc,
    quests: (cls.quests ?? []).map((q) => ({
      reward: q.reward,
      rewardStats: statsFor(q.reward),
      items: (q.items ?? []).map((it) => ({ name: it.name, source: it.source })),
    })),
  })),
};

// The log is latin1 and the tracker matches on exact names, so a non-ASCII character in
// an item name is worth a human look before it ships — it may be a curly quote the log
// will never produce.
for (const cls of transformed.classes) {
  for (const [qi, q] of cls.quests.entries()) {
    for (const name of [q.reward, ...q.items.map((i) => i.name)]) {
      if (/[^\x20-\x7e]/.test(name)) {
        console.warn(`non-ASCII in ${cls.id} quest ${qi}: ${JSON.stringify(name)}`);
      }
    }
  }
}

// ---------------------------------------------------------------- diff against committed

/** Flatten to path → value, so the diff names WHERE a change sits, not just that one exists. */
function flatten(classes) {
  const out = new Map();
  for (const cls of classes ?? []) {
    out.set(`${cls.id}.npc`, cls.npc);
    for (const [qi, q] of (cls.quests ?? []).entries()) {
      out.set(`${cls.id}:${qi}.reward`, q.reward);
      // One line per entry, or a changed stat block would push the whole diff off screen.
      out.set(`${cls.id}:${qi}.rewardStats`, (q.rewardStats ?? '').replace(/\s*\n+\s*/g, ' · ') || null);
      for (const [ii, it] of (q.items ?? []).entries()) {
        out.set(`${cls.id}:${qi}:${ii}`, `${it.name}  [${it.source}]`);
      }
    }
  }
  return out;
}

let previous = null;
try {
  previous = JSON.parse(fs.readFileSync(OUT, 'utf8'));
} catch {
  // First run: nothing committed yet, everything below prints as added.
}

const before = flatten(previous?.classes);
const after = flatten(transformed.classes);
let changes = 0;
for (const [key, value] of after) {
  if (!before.has(key)) { console.log(`+ ${key} = ${value}`); changes++; }
  else if (before.get(key) !== value) { console.log(`~ ${key}: ${before.get(key)} -> ${value}`); changes++; }
}
for (const key of before.keys()) {
  if (!after.has(key)) { console.log(`- ${key}`); changes++; }
}

const quests = transformed.classes.reduce((n, c) => n + c.quests.length, 0);
console.log(`${transformed.classes.length} classes, ${quests} quests; ${changes} change(s) vs ${previous ? 'committed file' : 'nothing (first run)'}`);

if (!write) {
  console.log('dry run — pass --write to update src/quests/posky.json');
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(transformed, null, 2) + '\n');
console.log(`wrote ${OUT}`);
