/**
 * The per-character quest ledger: what the log and the player's own dumps have shown,
 * and the claims derived from it.
 *
 * The honesty rule this store lives by: COUNTS ARE FACTS, OWNED AND DONE ARE CLAIMS —
 * and facts are never edited, only accumulated. Three kinds of fact land here:
 * loot counts (an item arrived), offer counts (an item was handed to one of the
 * sixteen quest NPCs — the log's own record of a turn-in), and inventory counts
 * (a `/outputfile inventory` dump said the item was in the bags as of its date).
 *
 * Claims are TRI-STATE: explicitly true, explicitly false, or unset. An explicit
 * value comes from the player's own toggle, an eqlposky import, and nothing else;
 * derivation fills only the unset, at READ time, from the facts — a quest whose every
 * slot has been offered to its NPC is done; an item with surviving loot arithmetic
 * (kept + stored + created, minus what was offered away) is owned; a NO DROP reward
 * sitting in the inventory dump proves its turn-in even from before logging began.
 * Precedence, both flags: the player's hand > the inventory dump > the log > the
 * import — a manual un-check STICKS against any amount of derivation, and every
 * effective value names its source so the window can say where a checkmark came from.
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
  lookup, questItemKey, isRune, POSKY, EFFECTS, itemRef, questRef,
  VALID_ITEM_REFS, VALID_QUEST_REFS,
  offerSlots, rewardLookup, allItemKeys, allRewardKeys,
} from './index.js';

/** The parser's chat verdicts — the same guard the session tracker keys on. */
const SPEECH = new Set(CHAT_RULE_IDS);

/**
 * Only the loot family runs for this tracker, whatever the session categories say.
 * The `offer` rule lives in that category on purpose — an item leaving the bags is the
 * same ledger read in reverse — so this one filter admits both kinds this store eats.
 */
const LOOT_ONLY = (category) => category === 'loot';

/**
 * Bumped if the file shape ever changes incompatibly. v2 made the claims tri-state
 * (`{ value, source }` objects instead of bare `true`) and added the `offers` and
 * `inventory` fact stores; `load` migrates a v1 file in place.
 */
export const QUEST_STORE_VERSION = 2;

/** "Rhale", "oggok" -> "Rhale_oggok" — the same key convention every store here uses. */
export function questStoreKey(character, server) {
  const clean = (s) => String(s ?? 'unknown').replace(/[^A-Za-z0-9-]/g, '_');
  return `${clean(character)}_${clean(server)}`;
}

/** The dispositions a loot event can arrive with; anything else counts as 'kept'. */
const DISPOSITIONS = ['kept', 'stored', 'created', 'sold'];

/** classId → the dataset class, for the derivations that walk a quest's slots. */
const CLASS_BY_ID = new Map(POSKY.classes.map((cls) => [cls.id, cls]));

/**
 * Lift a v1 file into the tri-state shape.
 *
 * v1 stored bare `true` for both a manual toggle and an import — the two were
 * interchangeable then, so the file cannot say which hand set a given flag. The best
 * available label: a file that records an import gets `import` (the one real import
 * set ~150 flags in a stroke; manual toggles were the correction of the odd one), a
 * file that never imported can only have been clicked. A flag mislabeled by this guess
 * costs a provenance caption, never a value — every source only ever asserts `true`,
 * so precedence between them cannot flip a checkmark.
 */
function migrateV1(old) {
  const source = old.import ? 'import' : 'manual';
  const lift = (flags) => Object.fromEntries(
    Object.entries(flags ?? {})
      .filter(([, value]) => value === true)
      .map(([ref]) => [ref, { value: true, source }]),
  );
  return {
    ...old,
    v: QUEST_STORE_VERSION,
    offers: {},
    inventory: { asOf: null, items: {} },
    owned: lift(old.owned),
    done: lift(old.done),
  };
}

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
      if (parsed?.v === 1) return migrateV1(parsed);
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
      /** positional item ref ("bard:0:0") → { count, lastTs }: hand-ins the log saw. */
      offers: {},
      /**
       * What the last `/outputfile inventory` dumps have shown, scoped to the item and
       * reward names the dataset knows. `items` maps item key → { count, asOf }; each
       * entry keeps the date of the dump that SAW it, because a dump only ever speaks
       * for what it contains — a key absent from a newer dump keeps its older entry and
       * its older date (traded? on the cursor? destroyed? absence is weak evidence),
       * exactly the only-ever-SETS rule the import lives by.
       */
      inventory: { asOf: null, items: {} },
      /**
       * positional item ref ("bard:0:0") → { value: boolean, source: 'manual'|'import' }.
       * EXPLICIT claims only — absence is the unset third state that derivation fills
       * at read time. A stored `false` is a real statement (the player un-checked it)
       * and outweighs every derivation.
       */
      owned: {},
      /** positional quest ref ("bard:0") → same tri-state shape. */
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
   * @returns {{refs: Array, needed: Array}|null} exactly as feed() answers.
   */
  feedLine(line, parserEvent) {
    if (parserEvent && SPEECH.has(parserEvent.rule)) return null;
    const parsed = parseTimestamp(line);
    if (!parsed) return null;
    const event = matchSessionRule(parsed.body, LOOT_ONLY);
    if (!event || (event.kind !== 'loot' && event.kind !== 'offer')) return null;
    event.ts = parsed.ts;
    return this.feed(event);
  }

  /**
   * Feed one session event — `loot` or `offer`, both from `src/session/rules.js`.
   *
   * Loot counts are kept PER DISPOSITION because a Wind Rune genuinely arrives two
   * ways — looted to bags or auto-stored to currency — and both count toward the total
   * while the split ("2 in bags · 5 in currency") is worth showing. Items no quest
   * wants are dropped without a trace: this is a quest ledger, not a second loot pane.
   *
   * An offer counts only when the recipient is one of the sixteen quest NPCs AND the
   * item is on that class's list — which silences the vendor quantity dumps and trades
   * to other players without this store having to know anything about either. Where
   * the item could fill two of the class's slots the unsatisfied one is credited, so a
   * second hand-in of the same name never buries the quest still waiting for it.
   *
   * `needed` in the answer is the loot chip's input, and it is computed BEFORE the
   * event lands: "did the player need this when it dropped?" is the chip's question,
   * and counting first would make every first pickup answer "no, you own one now".
   * Offers answer with an empty `needed` always — handing an item IN is the opposite
   * of news that an item is wanted.
   *
   * @param {{kind: string, item: string, npc?: string, disposition?: string,
   *   qty?: number, ts: number}} event
   * @returns {{kind: 'loot'|'offer', refs: Array, needed: Array,
   *   completed?: Object|null}|null} what was counted, the slots the event touched,
   *   and the slots that still wanted the item; null when nothing was counted — not
   *   a quest item, not a quest NPC, no character yet, or a line already counted by
   *   a previous run. `kind` is what lets the caller chip loot and not ordinary
   *   hand-ins; `completed` (offers only) names the quest this hand-in finished, the
   *   one hand-in that DOES chip.
   */
  feed(event) {
    if (!this.state || !event) return null;
    if (this.minTs !== null && event.ts <= this.minTs) return null;

    if (event.kind === 'offer') {
      const slots = offerSlots(event.npc, event.item);
      if (!slots.length) return null;
      const chosen = slots.find((s) => (this.state.offers[s.ref]?.count ?? 0) === 0) ?? slots[0];
      // Judged before the offer lands, like `needed` is for loot and for the same
      // reason: "did this hand-in finish the quest?" compares the quest's state
      // across the event, and counting first erases the before.
      const wasDone = this.doneState(chosen.classId, chosen.questIndex).value;
      const rec = this.state.offers[chosen.ref] ?? (this.state.offers[chosen.ref] = { count: 0, lastTs: 0 });
      rec.count += event.qty ?? 1;
      rec.lastTs = Math.max(rec.lastTs, event.ts);
      this.state.lastTs = Math.max(this.state.lastTs ?? 0, event.ts);
      this.revision++;
      this.persist();
      // Only a flip is a completion: a quest an import or a dump already proved done
      // stays quiet, and so does every hand-in before the last one.
      const completed = !wasDone && this.doneState(chosen.classId, chosen.questIndex).value
        ? { classId: chosen.classId, className: chosen.className, questIndex: chosen.questIndex, reward: chosen.reward }
        : null;
      return { kind: 'offer', refs: [chosen], needed: [], completed };
    }

    if (event.kind !== 'loot') return null;
    const refs = lookup(event.item);
    if (!refs.length) return null;
    const needed = this.needed(refs);

    const key = questItemKey(event.item);
    const disposition = DISPOSITIONS.includes(event.disposition) ? event.disposition : 'kept';
    const counts = this.state.items[key] ?? (this.state.items[key] = {});
    counts[disposition] = (counts[disposition] ?? 0) + (event.qty ?? 1);
    this.state.lastTs = Math.max(this.state.lastTs ?? 0, event.ts);
    this.revision++;
    this.persist();
    return { kind: 'loot', refs, needed };
  }

  /**
   * The loot chip for a counted drop, or null for the one case that stays silent.
   *
   * The chip IDENTIFIES every counted quest drop — "what can be made from this" is
   * the question the player is actually asking mid-farm — and carries the ledger's
   * coverage in its wording instead of being silenced by it. The original need-only
   * filter had a failure mode James hit the day it shipped: one eqlposky import
   * marked fifty quests done and the surface went mute entirely, which reads as the
   * feature being gone, not as fifty questions answered.
   *
   * The one exception is a fully-covered RUNE. Runes fall zone-wide all night and
   * serve up to seven classes each; re-announcing "all covered" on every one of them
   * is the noise that teaches a player to stop reading alerts — the failure an alert
   * surface cannot survive. A rune chips only while some class still needs it.
   *
   * @param {Array} refs    every slot the item satisfies, as lookup() answers
   * @param {Array} needed  the slots still needed, judged BEFORE the drop landed
   * @returns {{text: string, sub: string}|null}
   */
  lootChip(refs, needed) {
    if (!refs?.length) return null;
    const first = refs[0];
    if (first.rune && !needed.length) return null;
    let sub;
    if (needed.length === 1) {
      sub = `${needed[0].className} — ${needed[0].reward}${refs.length > 1 ? ' · rest covered' : ''}`;
    } else if (needed.length > 1) {
      sub = needed.length === refs.length
        ? `${refs.length} class tests want this`
        : `${needed.length} of ${refs.length} class tests still need this`;
    } else if (refs.length === 1) {
      // Covered, and the wording says HOW: a turned-in quest and an already-owned
      // item are different reasons to relax about the drop.
      const done = this.doneState(first.classId, first.questIndex).value;
      sub = `${first.className} — ${first.reward} · already ${done ? 'turned in' : 'owned'}`;
    } else {
      sub = `${refs.length} class tests want this — all covered`;
    }
    return { text: first.itemName, sub };
  }

  /**
   * The chip for the hand-in that finished a quest — the one exception to hand-ins
   * being chipless. An ordinary offer is ledger movement the window refresh covers;
   * the offer that flips a quest to done is the moment the whole grind existed for,
   * and the ring that exposed the backtick bug went un-toasted at exactly this moment.
   * The reward leads because it is what the player just earned; the class underneath
   * says which of the sixteen tests closed. Announced once by construction: feed()
   * reports `completed` only on the not-done → done flip, so the tenth re-offer of a
   * finished quest's rune says nothing.
   *
   * @param {{className: string, reward: string}|null} completed  feed()'s answer
   * @returns {{text: string, sub: string}|null}
   */
  completionChip(completed) {
    if (!completed) return null;
    return { text: completed.reward, sub: `${completed.className} quest complete` };
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
      !this.doneState(slot.classId, slot.questIndex).value &&
      !this.ownedState(slot.ref, questItemKey(slot.itemName)).value);
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

  // ------------------------------------------------------------------ derived claims

  /**
   * How many hand-ins the log has seen of this item, across every slot that wants it.
   * Global on purpose: offering a rune to the wizard's NPC removed it from the bags
   * whatever class the player looted it hoping for.
   */
  offeredTotal(key) {
    let total = 0;
    for (const slot of lookup(key)) total += this.state?.offers[slot.ref]?.count ?? 0;
    return total;
  }

  /**
   * The loot arithmetic behind the derived "owned": what arrived and stayed (kept,
   * auto-stored, consumed on the spot into its own upgrade) minus what was handed to a
   * quest NPC. Auto-sold loot never joins the sum — it left at the corpse. What this
   * cannot see: a trade to another player, a destroy, a merchant sale from the bags —
   * which is why the answer only ever FILLS an unset claim and a manual un-check
   * outranks it.
   */
  survivingCount(key) {
    const counts = this.state?.items[key] ?? {};
    const arrived = (counts.kept ?? 0) + (counts.stored ?? 0) + (counts.created ?? 0);
    return arrived - this.offeredTotal(key);
  }

  /**
   * The effective owned flag for one slot, with the source that decided it.
   *
   * Precedence is the file's doctrine in four lines: the player's own toggle beats
   * everything (both ways — an explicit false STICKS); then the inventory dump (the
   * item is sitting in the bags, dated); then the log's surviving-loot arithmetic;
   * then an import's claim, last because it is the stalest thing here — a dated
   * website snapshot the two live sources exist to replace.
   *
   * @returns {{value: boolean, source: 'manual'|'inventory'|'log'|'import'|null}}
   */
  ownedState(ref, key) {
    const explicit = this.state?.owned[ref];
    if (explicit?.source === 'manual') return { value: explicit.value === true, source: 'manual' };
    if ((this.state?.inventory.items[key]?.count ?? 0) > 0) return { value: true, source: 'inventory' };
    if (this.survivingCount(key) > 0) return { value: true, source: 'log' };
    if (explicit?.value === true) return { value: true, source: 'import' };
    return { value: false, source: null };
  }

  /**
   * The effective done flag for one quest, same contract as `ownedState`.
   *
   * Two derivations can prove a turn-in. The log's: every slot of the quest has been
   * offered to the class's NPC at least once since logging began. The inventory's: the
   * quest's reward is IN the dump and the reward is NO DROP — an item that could not
   * have been bought or traded got into the bags exactly one way, so holding it proves
   * the turn-in even one from before the first log line. A tradeable reward proves
   * nothing and derives nothing (two of the 95 are, both necromancer's).
   */
  doneState(classId, questIndex) {
    const qref = questRef(classId, questIndex);
    const explicit = this.state?.done[qref];
    if (explicit?.source === 'manual') return { value: explicit.value === true, source: 'manual' };
    const quest = CLASS_BY_ID.get(classId)?.quests[questIndex];
    if (quest) {
      const allOffered = quest.items.every(
        (_, ii) => (this.state?.offers[itemRef(classId, questIndex, ii)]?.count ?? 0) > 0,
      );
      if (allOffered) return { value: true, source: 'log' };
      const reward = rewardLookup(quest.reward);
      if (reward?.noDrop &&
          (this.state?.inventory.items[questItemKey(quest.reward)]?.count ?? 0) > 0) {
        return { value: true, source: 'inventory' };
      }
    }
    if (explicit?.value === true) return { value: true, source: 'import' };
    return { value: false, source: null };
  }

  /**
   * The player's own claim about one item, toggled in the Quests window. Manual toggles
   * go BOTH ways — the player may correct an import or a derivation — which is exactly
   * what those two are forbidden from doing back. Both directions are stored EXPLICITLY:
   * a false written here is what makes an un-check stick when the log still shows a
   * surviving rune, rather than the checkbox snapping back on the next repaint.
   */
  setOwned(ref, owned) {
    // The ref arrives from a renderer; one that names no dataset slot writes nothing,
    // so a typo cannot grow the file with keys no quest will ever read.
    if (!this.state || !VALID_ITEM_REFS.has(ref)) return;
    this.state.owned[ref] = { value: owned === true, source: 'manual' };
    this.revision++;
    this.persist();
  }

  setDone(ref, done) {
    if (!this.state || !VALID_QUEST_REFS.has(ref)) return;
    this.state.done[ref] = { value: done === true, source: 'manual' };
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
      // stored as a key nothing will ever read. Any EXISTING explicit entry is left
      // alone whichever way it points: an import fills blanks, it never argues.
      if (value !== true || !VALID_ITEM_REFS.has(ref) || this.state.owned[ref]) continue;
      this.state.owned[ref] = { value: true, source: 'import' };
      owned++;
    }
    for (const [ref, value] of Object.entries(data.turnedIn ?? {})) {
      if (value !== true || !VALID_QUEST_REFS.has(ref) || this.state.done[ref]) continue;
      this.state.done[ref] = { value: true, source: 'import' };
      done++;
    }
    for (const [name, value] of Object.entries(data.currencyOwned ?? {})) {
      if (value !== true) continue;
      for (const slot of lookup(name)) {
        if (this.state.owned[slot.ref]) continue;
        this.state.owned[slot.ref] = { value: true, source: 'import' };
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
   * Record what a `/outputfile inventory` dump showed, scoped to the names the dataset
   * knows — the other ~500 rows of a real dump are bank clutter this ledger has no
   * question about. Keys present in the dump are SET (count and the dump's own date);
   * keys absent are left exactly as an older dump recorded them, because a dump only
   * ever speaks for what it contains. Re-applying the same dump (matched by its stamp)
   * is a no-op, which is what lets the watcher poll dumbly.
   *
   * @param {Map<string, number>|Object} items  normalized item key → count, as
   *   `parseInventory` answers
   * @param {number|null} asOf  the dump file's mtime, the date every fact it sets carries
   * @returns {{ok: boolean, matched: number, unchanged?: boolean}}
   */
  applyInventory(items, asOf = null) {
    if (!this.state || !items) return { ok: false, matched: 0 };
    if (asOf !== null && this.state.inventory.asOf === asOf) {
      return { ok: true, matched: 0, unchanged: true };
    }
    const relevant = new Set([...allItemKeys(), ...allRewardKeys()]);
    const entries = items instanceof Map ? items.entries() : Object.entries(items);
    let matched = 0;
    for (const [rawKey, count] of entries) {
      const key = questItemKey(rawKey);
      if (!relevant.has(key) || !(Number(count) > 0)) continue;
      this.state.inventory.items[key] = { count: Number(count), asOf };
      matched++;
    }
    this.state.inventory.asOf = asOf;
    this.revision++;
    this.persist();
    return { ok: true, matched };
  }

  /**
   * Everything the Quests window renders, resolved against the dataset: per class, per
   * quest, per item — the data's own names and sources joined with this character's
   * counts, facts and effective flags. `owned`/`done` arrive DECIDED, with the source
   * that decided each riding along, so the window renders a checkbox and a caption and
   * never re-implements the precedence. Built fresh on every call; the window asks over
   * IPC when it opens or when told something changed, not four times a second.
   */
  snapshot() {
    if (!this.state) return null;
    return {
      character: this.character,
      server: this.server,
      import: this.state.import,
      inventoryAsOf: this.state.inventory.asOf,
      /** Static spell data for the effect tooltips — a few KB, cheaper than a channel. */
      effects: EFFECTS,
      classes: POSKY.classes.map((cls) => ({
        id: cls.id,
        name: cls.name,
        npc: cls.npc,
        quests: cls.quests.map((quest, qi) => {
          const qref = questRef(cls.id, qi);
          const items = quest.items.map((item, ii) => {
            const ref = itemRef(cls.id, qi, ii);
            const key = questItemKey(item.name);
            const offer = this.state.offers[ref];
            const inv = this.state.inventory.items[key];
            const owned = this.ownedState(ref, key);
            return {
              ref,
              name: item.name,
              source: item.source,
              rune: isRune(item.name),
              looted: this.lootedCount(item.name),
              split: this.lootedSplit(item.name),
              offered: offer?.count ?? 0,
              lastOffered: offer?.lastTs ?? null,
              inventory: inv?.count ?? 0,
              inventoryAsOf: inv?.asOf ?? null,
              owned: owned.value,
              ownedSource: owned.source,
            };
          });
          const done = this.doneState(cls.id, qi);
          return {
            ref: qref,
            reward: quest.reward,
            rewardStats: quest.rewardStats,
            icon: quest.icon ?? null,
            cardIcons: quest.cardIcons ?? null,
            items,
            done: done.value,
            doneSource: done.source,
          };
        }),
      })),
    };
  }
}
