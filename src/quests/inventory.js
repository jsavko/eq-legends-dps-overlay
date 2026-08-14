/**
 * Parse an EverQuest `/outputfile inventory` dump.
 *
 * The dump is the game's own answer to the question the log structurally cannot reach:
 * what is in the bags RIGHT NOW, including everything looted before logging began. One
 * in-game command, alt-tab, and the quest ledger gets facts about the past that would
 * otherwise need a website export. Pure Node like the rest of `src/quests/`, tested in
 * WSL against a real dump committed as a fixture.
 *
 * The format (probed live, `Rhale_oggok-Inventory.txt`): tab-separated with a header
 * row `Location	Name	ID	Count	Slots`, one row per slot across worn gear,
 * bags, bank, key ring and augmentations. Empty slots are literal rows named "Empty" —
 * skipped by NAME, not by count, because their count column is 0 anyway and a real
 * item named by the dataset can never be called Empty. Names carry the same ` +N`
 * upgrade suffixes the log's loot lines do, so the same normalization
 * (`questItemKey`: article + suffix strip, lowercase) folds them onto dataset names —
 * which also means a base item and its upgraded twin sum into one count, exactly what
 * a "do I have this turn-in" question wants.
 *
 * What the dump does NOT contain, confirmed live: currency-stored Wind Runes. Their
 * owned state stays log-derived (stored-loot counts minus offers); nothing here may be
 * read as "the runes are gone".
 */

import { questItemKey } from './index.js';

/**
 * One dump in, item key → total count out, summed across every location that holds
 * the item. Rows that do not parse — short rows, the header, a stray blank — are
 * skipped rather than thrown on: a half-written dump (the game writes it live) should
 * yield the rows it has, and the caller stamps whatever it applies with the file's
 * own date either way.
 *
 * @param {string} text  the dump file's contents
 * @returns {Map<string, number>} normalized item key → count
 */
export function parseInventory(text) {
  const items = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cols = line.split('\t');
    if (cols.length < 4) continue;
    const [location, name, , count] = cols;
    if (location === 'Location' || !name || name === 'Empty') continue;
    const qty = Number(count);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const key = questItemKey(name);
    items.set(key, (items.get(key) ?? 0) + qty);
  }
  return items;
}
