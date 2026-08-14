/**
 * The per-character quest ledger: what the log has shown being looted, and the flags
 * the log can never set.
 *
 * The honesty rule this store lives by: LOOTED COUNTS ARE FACTS, OWNED AND DONE ARE
 * CLAIMS. The log states that an item was looted, so counts accumulate from it alone
 * and nothing else may touch them. The log cannot know inventory — items looted before
 * logging began, traded away, or already turned in — so "I own this piece" and "this
 * quest is done" are flags, set only by the player's own hand (a toggle in the Quests
 * window) or by importing an eqlposky.com progress export, and never guessed from the
 * counts sitting beside them. Both kinds of truth render side by side; neither
 * overwrites the other.
 *
 * Storage is one plain JSON file per character (`<dir>/<Char>_<server>.json`), whole-file
 * rewritten on each change — the state is a few KB and loot arrives at human speed, so
 * an append log would be structure with nothing to earn it. The directory is injected so
 * the store unit-tests against a temp dir, and every write failure is reported through a
 * callback rather than thrown: the history store's policy, for the history store's
 * reason — a full disk must not take the live overlay down.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseTimestamp } from '../parser/timestamp.js';
import { CHAT_RULE_IDS } from '../parser/rules.js';
import { matchSessionRule } from '../session/rules.js';
import {
  lookup, questItemKey, isRune, POSKY, itemRef, questRef, VALID_ITEM_REFS, VALID_QUEST_REFS,
} from './index.js';

/** The parser's chat verdicts — the same guard the session tracker keys on. */
const SPEECH = new Set(CHAT_RULE_IDS);

/** Only the loot family runs for this tracker, whatever the session categories say. */
const LOOT_ONLY = (category) => category === 'loot';

/** Bumped if the file shape ever changes incompatibly. */
export const QUEST_STORE_VERSION = 1;

/** "Rhale", "oggok" -> "Rhale_oggok" — the same key convention every store here uses. */
export function questStoreKey(character, server) {
  const clean = (s) => String(s ?? 'unknown').replace(/[^A-Za-z0-9-]/g, '_');
  return `${clean(character)}_${clean(server)}`;
}

/** The dispositions a loot event can arrive with; anything else counts as 'kept'. */
const DISPOSITIONS = ['kept', 'stored', 'created', 'sold'];

export class QuestProgress {
  /**
   * @param {Object} options
   * @param {string} options.dir              where the per-character files live
   * @param {string|null} [options.character]
   * @param {string|null} [options.server]
   * @param {(err: Error) => void} [options.onWriteError]
   *   Called (once per failure) instead of throwing — main.js toasts it.
   */
  constructor({ dir, character = null, server = null, onWriteError = null }) {
    this.dir = dir;
    this.onWriteError = onWriteError;
    this.character = null;
    this.server = null;
    this.state = null;
    /**
     * Events at or before this instant are already counted and are skipped — the same
     * inclusive floor the session tracker keeps, for the same reason: the tailer seeds
     * 64 KB back from the end of the log, so every launch re-reads lines the previous
     * one already counted, and a re-run of the backfill script replays all of them.
     * Set from the file's own high-water mark at load, never advanced by anything but
     * counted events.
     */
    this.minTs = null;
    /** Bumped whenever anything a viewer would see changes. */
    this.revision = 0;
    if (character) this.setCharacter(character, server);
  }

  fileFor(character, server) {
    return path.join(this.dir, `${questStoreKey(character, server)}.json`);
  }

  /**
   * Follow a (possibly different) character. Loads that character's file, or starts an
   * empty ledger for a name never seen. Safe to call repeatedly with the same name —
   * the tailer's lines handler does, on every batch.
   */
  setCharacter(character, server = null) {
    if (!character) return;
    if (this.character === character && this.server === server) return;
    this.character = character;
    this.server = server;
    this.state = this.load(character, server);
    this.minTs = this.state.lastTs ?? null;
    this.revision++;
  }

  load(character, server) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.fileFor(character, server), 'utf8'));
      if (parsed?.v === QUEST_STORE_VERSION) return parsed;
    } catch {
      // No file yet, or an unreadable one: start clean rather than refuse to track.
      // The file is rewritten whole on the next counted loot, so a torn write from a
      // crash heals itself the same way.
    }
    return {
      v: QUEST_STORE_VERSION,
      character,
      server,
      lastTs: null,
      /** item key → per-disposition counts, e.g. { "wind rune azia": { kept: 1, stored: 4 } } */
      items: {},
      /** positional item ref ("bard:0:0") → true; the player's or an import's claim. */
      owned: {},
      /** positional quest ref ("bard:0") → true; same. */
      done: {},
      /** What the last eqlposky import said about itself, shown in the window. */
      import: null,
    };
  }

  persist() {
    if (!this.state) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(
        this.fileFor(this.character, this.server),
        JSON.stringify(this.state, null, 2) + '\n',
        'utf8',
      );
    } catch (err) {
      this.onWriteError?.(err);
    }
  }

  /**
   * Feed one raw log line, plus what the combat parser made of it.
   *
   * The same two-argument contract `SessionTracker.feed` keeps, for the same reason:
   * the second argument IS the chat guard, so a player quoting a loot line in /general
   * never counts. Evaluated here rather than borrowed from the session tracker because
   * the session's `loot` CATEGORY is a display switch for the Session window — a player
   * who turned that pane off has not asked the quest ledger to go blind, so this
   * tracker runs the loot rules for itself, whatever the categories say.
   *
   * @returns {Array|null} the quest slots the loot satisfies, exactly as feed() answers.
   */
  feedLine(line, parserEvent) {
    if (parserEvent && SPEECH.has(parserEvent.rule)) return null;
    const parsed = parseTimestamp(line);
    if (!parsed) return null;
    const event = matchSessionRule(parsed.body, LOOT_ONLY);
    if (!event || event.kind !== 'loot') return null;
    event.ts = parsed.ts;
    return this.feed(event);
  }

  /**
   * Feed one session loot event (`kind: 'loot'` from `src/session/rules.js`).
   *
   * Counts are kept PER DISPOSITION because a Wind Rune genuinely arrives two ways —
   * looted to bags or auto-stored to currency — and both count toward the total while
   * the split ("2 in bags · 5 in currency") is worth showing. Items no quest wants are
   * dropped without a trace: this is a quest ledger, not a second loot pane.
   *
   * @param {{kind: string, item: string, disposition?: string, qty?: number, ts: number}} event
   * @returns {Array|null} the quest slots the item satisfies (for the loot chip), or
   *   null when nothing was counted — not a quest item, no character yet, or a line
   *   already counted by a previous run.
   */
  feed(event) {
    if (!this.state || !event || event.kind !== 'loot') return null;
    if (this.minTs !== null && event.ts <= this.minTs) return null;

    const refs = lookup(event.item);
    if (!refs.length) return null;

    const key = questItemKey(event.item);
    const disposition = DISPOSITIONS.includes(event.disposition) ? event.disposition : 'kept';
    const counts = this.state.items[key] ?? (this.state.items[key] = {});
    counts[disposition] = (counts[disposition] ?? 0) + (event.qty ?? 1);
    this.state.lastTs = Math.max(this.state.lastTs ?? 0, event.ts);
    this.revision++;
    this.persist();
    return refs;
  }

  /**
   * Which of these quest slots the player still NEEDS: quest not turned in, item not
   * already claimed as owned. This is the loot chip's filter — James asked for a toast
   * on "an item you need", and a chip for the tenth Wind Rune Kala after every Kala
   * quest is checked off would teach him to stop reading the window, which is the one
   * failure an alert surface cannot survive.
   */
  needed(refs) {
    if (!this.state) return [];
    return (refs ?? []).filter((slot) =>
      this.state.done[questRef(slot.classId, slot.questIndex)] !== true &&
      this.state.owned[slot.ref] !== true);
  }

  /** Total looted count for an item, all dispositions summed. */
  lootedCount(itemName) {
    const counts = this.state?.items[questItemKey(itemName)];
    return counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  }

  /** The per-disposition split for an item, for the bags-vs-currency line. */
  lootedSplit(itemName) {
    return this.state?.items[questItemKey(itemName)] ?? {};
  }

  /**
   * The player's own claim about one item, toggled in the Quests window. Manual toggles
   * go BOTH ways — the player may correct an import — which is exactly what an import
   * itself is forbidden from doing.
   */
  setOwned(ref, owned) {
    // The ref arrives from a renderer; one that names no dataset slot writes nothing,
    // so a typo cannot grow the file with keys no quest will ever read.
    if (!this.state || !VALID_ITEM_REFS.has(ref)) return;
    if (owned) this.state.owned[ref] = true;
    else delete this.state.owned[ref];
    this.revision++;
    this.persist();
  }

  setDone(ref, done) {
    if (!this.state || !VALID_QUEST_REFS.has(ref)) return;
    if (done) this.state.done[ref] = true;
    else delete this.state.done[ref];
    this.revision++;
    this.persist();
  }

  /**
   * Apply an eqlposky.com progress export (schema v1).
   *
   * An export is a DATED SNAPSHOT, not a live link: it says what the site knew at
   * `exportedAt`, which may already lag the player's real bags. So the import only ever
   * SETS flags, never clears one — a `false` in the file means "the site had no
   * checkmark", not "the player un-owns this" — and re-importing the same file changes
   * nothing. Live log counts keep running past it and manual toggles stay editable.
   *
   * What maps where:
   *   - `turnedIn`  ("bard:0": true)            → quest `done`
   *   - `looted`    ("bard:0:0": true)          → item `owned` (positional, verbatim —
   *     the site's indices ARE our indices, which is why the fetch transform must never
   *     reorder anything)
   *   - `currencyOwned` ("wind rune azia": true) → item `owned` for every quest slot
   *     that wants the rune — currency is zone-wide, the site tracks it by name
   *   - `inventoryCounts` — deliberately skipped: it is derived from whatever
   *     /outputfile dump the site last saw, the stalest thing in the file.
   *
   * @returns {{ok: boolean, error?: string, applied?: {owned: number, done: number}}}
   */
  applyImport(data) {
    if (!this.state) return { ok: false, error: 'no character is being followed yet' };
    if (!data || typeof data !== 'object') return { ok: false, error: 'not a progress export' };
    if (data.version !== 1) return { ok: false, error: `unknown export version ${data.version}` };

    let owned = 0;
    let done = 0;

    for (const [ref, value] of Object.entries(data.looted ?? {})) {
      // Positional refs resolve against OUR copy of the dataset; one we don't know —
      // the site adding a quest ahead of our next refresh — is skipped rather than
      // stored as a key nothing will ever read.
      if (value !== true || !VALID_ITEM_REFS.has(ref) || this.state.owned[ref]) continue;
      this.state.owned[ref] = true;
      owned++;
    }
    for (const [ref, value] of Object.entries(data.turnedIn ?? {})) {
      if (value !== true || !VALID_QUEST_REFS.has(ref) || this.state.done[ref]) continue;
      this.state.done[ref] = true;
      done++;
    }
    for (const [name, value] of Object.entries(data.currencyOwned ?? {})) {
      if (value !== true) continue;
      for (const slot of lookup(name)) {
        if (this.state.owned[slot.ref]) continue;
        this.state.owned[slot.ref] = true;
        owned++;
      }
    }

    this.state.import = {
      exportedAt: data.exportedAt ?? null,
      importedAt: new Date().toISOString(),
    };
    this.revision++;
    this.persist();
    return { ok: true, applied: { owned, done } };
  }

  /**
   * Everything the Quests window renders, resolved against the dataset: per class, per
   * quest, per item — the data's own names and sources joined with this character's
   * counts and flags. Built fresh on every call; the window asks over IPC when it opens
   * or when told something changed, not four times a second.
   */
  snapshot() {
    if (!this.state) return null;
    return {
      character: this.character,
      server: this.server,
      import: this.state.import,
      classes: POSKY.classes.map((cls) => ({
        id: cls.id,
        name: cls.name,
        npc: cls.npc,
        quests: cls.quests.map((quest, qi) => {
          const qref = questRef(cls.id, qi);
          const items = quest.items.map((item, ii) => {
            const ref = itemRef(cls.id, qi, ii);
            return {
              ref,
              name: item.name,
              source: item.source,
              rune: isRune(item.name),
              looted: this.lootedCount(item.name),
              split: this.lootedSplit(item.name),
              owned: this.state.owned[ref] === true,
            };
          });
          return {
            ref: qref,
            reward: quest.reward,
            rewardStats: quest.rewardStats,
            items,
            done: this.state.done[qref] === true,
          };
        }),
      })),
    };
  }
}
