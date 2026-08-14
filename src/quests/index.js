/**
 * The Plane of Sky quest dataset, and the index that turns a looted item name into
 * "which class test wants this".
 *
 * A THIRD sibling of the parser, on the same terms as `src/session/` and
 * `src/triggers/`: pure Node, no Electron, fed by main.js and unit-testable in WSL.
 * The same reasoning applies unchanged — quest bookkeeping fails in different ways than
 * damage attribution does, and neither should be able to break the other.
 *
 * The dataset is `posky.json`, committed to the repo and refreshed by
 * `scripts/fetch-posky.js` from eqlposky.com (itself sourced from EQProgression's
 * Legends guide — see the file's own attribution block). Two facts about it are
 * load-bearing everywhere below:
 *
 *   - CLASS IDS AND ARRAY ORDER ARE THE SITE'S. Its progress-export keys are positional
 *     (`bard:0:0` = class : quest index : item index), and imports resolve through those
 *     positions — so a quest's place in the array is part of the data's meaning, not a
 *     display choice.
 *
 *   - 94 of the 134 distinct item names the live log has looted in Sky match this data
 *     exactly, including all fifteen Wind Runes. The names are trustworthy; what needs
 *     normalizing is what the LOG wraps around them — articles ("a Crude Wooden Flute")
 *     and the Legends upgrade suffix ("Bracelet of Exertion +1" loots where the data
 *     says "Bracelet of Exertion").
 */

import fs from 'node:fs';
import { stripArticle } from '../parser/entities.js';

/** The dataset, verbatim from disk. `attribution` says where it came from and when. */
export const POSKY = JSON.parse(
  fs.readFileSync(new URL('./posky.json', import.meta.url), 'utf8'),
);

/**
 * Collapse an item name to the key everything matches on.
 *
 * Three normalizations, each earned by a real mismatch: the article the log puts in
 * front of a looted item ("a Mote of Lesser Potential"), the ` +N` upgrade suffix
 * Legends appends to drops the data names bare, and case — the eqlposky progress
 * export lowercases its `currencyOwned` and `inventoryCounts` keys, so the index
 * lowercases everything rather than special-casing an import format at lookup time.
 */
export function questItemKey(raw) {
  return stripArticle(String(raw ?? '').trim())
    .replace(/\s\+\d+$/, '')
    .toLowerCase();
}

/**
 * Runes render differently — "random zone-wide drop", not a mob's name — and the data
 * marks them only by name. The prefix is the site's own convention, all fifteen follow
 * it, and the live log agrees.
 */
export function isRune(name) {
  return /^wind rune /i.test(String(name ?? ''));
}

/** `bard`, 0, 1 → "bard:0:1" — the positional ref the site's export keys use. */
export function itemRef(classId, questIndex, itemIndex) {
  return `${classId}:${questIndex}:${itemIndex}`;
}

/** `bard`, 0 → "bard:0" — the quest half of the same convention. */
export function questRef(classId, questIndex) {
  return `${classId}:${questIndex}`;
}

/**
 * item key → every quest slot that wants the item.
 *
 * Built once at module load — the dataset is committed, so there is nothing to
 * invalidate on. One name can serve several quests (Wind Rune Izah is wanted by a
 * beastlord test and a wizard test both), which is why lookup answers with a list and
 * why the progress store counts items GLOBALLY rather than per quest: the log knows an
 * item was looted, never which class it was looted for.
 *
 * @type {Map<string, Array<{classId: string, className: string, questIndex: number,
 *   itemIndex: number, ref: string, itemName: string, source: string, reward: string,
 *   rune: boolean}>>}
 */
const ITEM_INDEX = new Map();
for (const cls of POSKY.classes) {
  for (const [qi, quest] of cls.quests.entries()) {
    for (const [ii, item] of quest.items.entries()) {
      const key = questItemKey(item.name);
      const refs = ITEM_INDEX.get(key) ?? [];
      refs.push({
        classId: cls.id,
        className: cls.name,
        questIndex: qi,
        itemIndex: ii,
        ref: itemRef(cls.id, qi, ii),
        itemName: item.name,
        source: item.source,
        reward: quest.reward,
        rune: isRune(item.name),
      });
      ITEM_INDEX.set(key, refs);
    }
  }
}

/**
 * Every quest slot a looted name satisfies, or an empty list for the night's ordinary
 * loot. The caller hands over whatever the loot rule captured; the normalization here
 * and the one the index was built with are the same function, which is the entire
 * guarantee that they cannot drift.
 */
export function lookup(itemName) {
  return ITEM_INDEX.get(questItemKey(itemName)) ?? [];
}

/** Every distinct item key the dataset wants, for offline cross-checks. */
export function allItemKeys() {
  return [...ITEM_INDEX.keys()];
}

/**
 * Every positional ref the dataset defines, so a flag write can be refused for a ref
 * that names nothing. The refs arrive from a renderer; without this a typo — or a
 * tampered window — could grow the ledger file with keys no quest will ever read.
 */
export const VALID_ITEM_REFS = new Set(
  [...ITEM_INDEX.values()].flat().map((slot) => slot.ref),
);
export const VALID_QUEST_REFS = new Set(
  POSKY.classes.flatMap((cls) => cls.quests.map((_, qi) => questRef(cls.id, qi))),
);
