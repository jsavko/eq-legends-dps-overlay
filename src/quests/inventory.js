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
 * (`questItemKey`: article + suffix strip, backtick fold, lowercase) folds them onto
 * dataset names — which also means a base item and its upgraded twin sum into one
 * count, exactly what a "do I have this turn-in" question wants.
 *
 * Not every row fills the header's columns. The `Equipment`, `Augmentation` and
 * `Activated` sections — 109 of the live dump's 637 rows — write only
 * `Location	Name	ID`, and those sections are inherently unstacked, so a row IS one
 * item and parses with an implicit count of 1. The check that admits them (a numeric
 * ID) is also what keeps a torn write out: the game writes this file live, and a line
 * cut off mid-name has no ID column to show. This mattered in practice: 45 of the live
 * character's 52 provable turn-ins — NO DROP rewards sitting in Equipment rows — were
 * invisible to the old four-column minimum, and the count the ledger could derive
 * agreed with the player's eqlposky import only after these rows joined in.
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
    if (cols.length < 3) continue;
    const [location, name, id, count] = cols;
    if (location === 'Location' || !name || name === 'Empty') continue;
    // Three columns is the unstacked sections' whole row; the numeric ID separates
    // that real shape from a line the game had not finished writing.
    const qty = cols.length >= 4 ? Number(count) : (/^\d+$/.test(id) ? 1 : NaN);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const key = questItemKey(name);
    items.set(key, (items.get(key) ?? 0) + qty);
  }
  return items;
}
