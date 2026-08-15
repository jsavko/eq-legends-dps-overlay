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
 * Effect descriptions for the reward cards' tooltips, fetched from the spells' own
 * P99 wiki pages by `fetch-posky.js --write`. `effects` maps spell name → { url,
 * lines }; `missing` names the Legends-only effects the wiki lacks — those render
 * with NO tooltip, because a hand-authored description would be a guess wearing a
 * tooltip's clothes. Absence of the whole file just means no tooltips anywhere.
 */
export const EFFECTS = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./effects.json', import.meta.url), 'utf8'));
  } catch {
    return { attribution: null, effects: {}, missing: [] };
  }
})();

/**
 * Collapse an item name to the key everything matches on.
 *
 * Four normalizations, each earned by a real mismatch: the article the log puts in
 * front of a looted item ("a Mote of Lesser Potential"); the ` +N` upgrade suffix
 * Legends appends to drops the data names bare; the backtick EQ's item database
 * spells some names with where the dataset writes an apostrophe; and case — the
 * eqlposky progress export lowercases its `currencyOwned` and `inventoryCounts`
 * keys, so the index lowercases everything rather than special-casing an import
 * format at lookup time.
 *
 * The backtick fold needs its evidence stated, because the glyph choice is PER-ITEM,
 * not a convention either side follows: the same live log loots "Griffon's Beak"
 * with a real apostrophe but "Spiritualist`s Ring" with a backtick, and the
 * inventory dump writes "Al`Kabor's Cap of Binding" with both glyphs in one name
 * (the dataset: "Al'Kabor's Cap of Binding"). The dataset contains no backticks at
 * all, so folding toward the apostrophe is lossless — and it is a fold, not a strip,
 * because apostrophes already live in persisted ledger keys ("griffon's beak") that
 * deleting the glyph would orphan. The ring cost a night's tracking: looted and
 * handed in on 2026-08-14, and neither line matched anything.
 */
export function questItemKey(raw) {
  return stripArticle(String(raw ?? '').trim())
    .replace(/\s\+\d+$/, '')
    .replace(/`/g, "'")
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
 * quest NPC name → the class whose tests that NPC runs.
 *
 * Sixteen names, one per class, spelled in the log exactly as the dataset spells them
 * (confirmed against 171 live `You offered` lines). This map is what turns the offer
 * rule's raw recipient into "a turn-in" or "not our business": an offer to a name not
 * in it — a vendor eating Metal Bits, a trade to another player — is the ledger's cue
 * to record nothing at all.
 */
const NPC_INDEX = new Map(POSKY.classes.map((cls) => [cls.npc, cls.id]));

/** Whether this raw recipient name is one of the sixteen quest NPCs. */
export function isQuestNpc(npc) {
  return NPC_INDEX.has(String(npc ?? '').trim());
}

/**
 * The quest slots an offered item can be filling: slots in the RECIPIENT'S class only.
 *
 * This is the offer's whole advantage over a loot line. A looted Wind Rune Izah could
 * be for any of seven classes and lookup() must answer with all of them — but the same
 * rune handed to Holwin can only be the monk test's, so the answer here is scoped to
 * the one class the NPC runs. Usually that is a single slot; if a future dataset ever
 * wants one item in two of a class's quests, the caller holds the offered counts and
 * gets the list to prefer the unsatisfied one.
 *
 * @returns {Array} the same slot shape lookup() answers with, possibly empty — an
 *   empty answer means the NPC is not a quest NPC or the item is not on their list.
 */
export function offerSlots(npc, itemName) {
  const classId = NPC_INDEX.get(String(npc ?? '').trim());
  if (!classId) return [];
  return (ITEM_INDEX.get(questItemKey(itemName)) ?? []).filter((slot) => slot.classId === classId);
}

/**
 * reward name key → the quest that pays it, with the one fact the inventory derivation
 * turns on: whether the reward can be traded. All 95 reward names are distinct, so the
 * map is one-to-one. `noDrop` reads the reward's own stats text — NO DROP or NO TRADE,
 * both live in the data — because possession only proves a turn-in for an item that
 * could not have arrived any other way; a tradeable reward in the bags proves nothing,
 * and its entry says so rather than being left out and looking like an oversight.
 */
const REWARD_INDEX = new Map();
for (const cls of POSKY.classes) {
  for (const [qi, quest] of cls.quests.entries()) {
    REWARD_INDEX.set(questItemKey(quest.reward), {
      classId: cls.id,
      questIndex: qi,
      ref: questRef(cls.id, qi),
      reward: quest.reward,
      noDrop: /NO DROP|NO ?TRADE/i.test(quest.rewardStats ?? ''),
    });
  }
}

/** The quest a reward name pays out from, or null for an item that rewards nothing. */
export function rewardLookup(itemName) {
  return REWARD_INDEX.get(questItemKey(itemName)) ?? null;
}

/** Every distinct reward key, for scoping an inventory dump to what the ledger reads. */
export function allRewardKeys() {
  return [...REWARD_INDEX.keys()];
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
