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
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { parseRewardStats, effectName } from '../src/renderer/quests/organize.js';

const SITE = 'https://www.eqlposky.com';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'quests', 'posky.json');
const ICONS_DIR = path.join(ROOT, 'src', 'quests', 'icons');
const EFFECTS_OUT = path.join(ROOT, 'src', 'quests', 'effects.json');
const WIKI = 'https://wiki.project1999.com';

const write = process.argv.includes('--write');

/**
 * Fetch one wiki URL — page HTML or icon bytes — following the odd redirect.
 *
 * `node:https` instead of global fetch for exactly one reason: wiki.project1999.com
 * serves an incomplete certificate chain (no intermediate), which strict TLS refuses.
 * Verification is relaxed FOR THIS HOST ONLY, eyes open: this is a developer-run
 * script fetching public wiki text and icons that get committed and reviewed in the
 * diff, not the app phoning anywhere at runtime — the runtime never touches the
 * network by design (the no-hotlinking invariant).
 */
function wikiGet(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(wikiGet(new URL(res.headers.location, url).href, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);   // a 404 is an answer (the wiki has no such page), not an error
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

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

/**
 * Attach icon FILENAMES to each quest — the basename of the wiki's `Item_N.png`, which
 * the app ships from `src/quests/icons/` and never hotlinks. Several rewards share one
 * graphic upstream (64 distinct files serve all 97 entries), so the basename doubles
 * as the dedup key. The one two-item reward gets a per-card map on top, because its
 * halves have their own entries and their own icons.
 */
for (const cls of transformed.classes) {
  for (const q of cls.quests) {
    const entry = details.items?.[q.reward];
    if (entry?.imageUrl) q.icon = entry.imageUrl.split('/').pop();
    if (q.reward.includes(' / ')) {
      const cardIcons = {};
      for (const part of q.reward.split(' / ').map((s) => s.trim())) {
        const sub = details.items?.[part];
        if (sub?.imageUrl) cardIcons[part] = sub.imageUrl.split('/').pop();
      }
      if (Object.keys(cardIcons).length) q.cardIcons = cardIcons;
    }
  }
}

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

// --------------------------------------------------------------------- icons + effects

/** Every icon the dataset now references, deduped by basename. */
const icons = new Map();
for (const entry of Object.values(details.items ?? {})) {
  if (entry?.imageUrl) icons.set(entry.imageUrl.split('/').pop(), entry.imageUrl);
}
const missingIcons = [...icons.keys()].filter((b) => !fs.existsSync(path.join(ICONS_DIR, b)));

/**
 * The unique effect names on the cards, via the same parser and the same name
 * extraction the window uses — one source of truth for what counts as an effect.
 */
const effectNames = new Set();
for (const cls of transformed.classes) {
  for (const q of cls.quests) {
    for (const item of parseRewardStats(q.rewardStats)) {
      for (const e of item.effects) {
        const name = effectName(e.text);
        if (name) effectNames.add(name);
      }
    }
  }
}

console.log(`${icons.size} icon(s) referenced, ${missingIcons.length} not yet in src/quests/icons; ${effectNames.size} effect name(s) on the cards`);

if (!write) {
  console.log('dry run — pass --write to update src/quests/posky.json, icons and effects.json');
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(transformed, null, 2) + '\n');
console.log(`wrote ${OUT}`);

// Icons download once and stay committed: the files are stable upstream (Lucy's item
// art has not changed in twenty years), so only absent basenames are fetched.
fs.mkdirSync(ICONS_DIR, { recursive: true });
for (const base of missingIcons) {
  const bytes = await wikiGet(icons.get(base));
  if (bytes) {
    fs.writeFileSync(path.join(ICONS_DIR, base), bytes);
    console.log(`icon ${base} (${bytes.length} bytes)`);
  } else {
    console.warn(`icon ${base}: not found upstream — the card renders without it`);
  }
  await new Promise((r) => setTimeout(r, 150));   // a polite crawl, not a hammering
}

/**
 * Effect descriptions, from each spell's own P99 wiki page: the "Details" table rows
 * ("Increase STR by 37", "Increase Attack Speed by 40%") are exactly what a tooltip
 * should say. A page the wiki does not have — the Luclin-era Legends effects 404
 * there — lands in `missing`, and an effect with no entry gets NO tooltip: absence
 * honest, nothing guessed.
 */
function spellLines(html) {
  const at = html.indexOf('id="Details"');
  if (at === -1) return null;
  const tableStart = html.indexOf('<table', at);
  if (tableStart === -1) return null;
  const table = html.slice(tableStart, html.indexOf('</table>', tableStart));
  const lines = [];
  for (const m of table.matchAll(/<td colspan="3">([\s\S]*?)<\/td>/g)) {
    const text = m[1].replace(/<[^>]*>/g, '')
      .replace(/&#160;|&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ').trim();
    if (text) lines.push(text);
  }
  return lines.length ? lines : null;
}

const effects = {};
const missingEffects = [];
for (const name of [...effectNames].sort()) {
  const url = `${WIKI}/${encodeURI(name.replace(/ /g, '_'))}`;
  const page = await wikiGet(url);
  const lines = page ? spellLines(page.toString('utf8')) : null;
  if (lines) {
    effects[name] = { url, lines };
    console.log(`effect ${name}: ${lines.length} line(s)`);
  } else {
    missingEffects.push(name);
    console.warn(`effect ${name}: no wiki page or no Details table — no tooltip`);
  }
  await new Promise((r) => setTimeout(r, 150));
}

fs.writeFileSync(EFFECTS_OUT, JSON.stringify({
  attribution: {
    source: `${WIKI}/ spell pages ("Details" effect tables)`,
    fetched: new Date().toISOString().slice(0, 10),
    note: 'Classic-era wiki data; Legends-only effects the wiki lacks are listed under '
      + 'missing and render without a tooltip rather than with a guessed one.',
  },
  effects,
  missing: missingEffects,
}, null, 2) + '\n');
console.log(`wrote ${EFFECTS_OUT}: ${Object.keys(effects).length} effect(s), ${missingEffects.length} missing`);
