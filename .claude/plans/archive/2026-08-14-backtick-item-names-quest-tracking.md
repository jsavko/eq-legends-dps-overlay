---
status: completed
---
# Backtick item names break quest tracking; no quest-complete toast

**Date:** 2026-08-14

---

## Goal

The Spiritualist's Ring run on Aug 14 produced nothing: no loot chip on pickup, no
count in the ledger, no recorded turn-in, and no sign the Vermilion Sky Ring quest
completed. Fix the detection so backtick-spelled item names track like every other
item, add the quest-complete toast the final hand-in should have produced, and give
James a recovery path for the events the bug already swallowed.

### Root cause (confirmed live, reproduced in isolation)

EQ's item database spells some item names with a **backtick** where the dataset
(eqlposky → EQProgression) writes an **apostrophe**, and `questItemKey` — the single
normalization everything matches through — does not fold them. The live log:

```
[Fri Aug 14 21:37:24 2026] --You have looted a Spiritualist`s Ring from Sister of the Spire's corpse.--
[Fri Aug 14 21:41:24 2026] You offered 1 Spiritualist`s Ring to Medicine Man Veetra.
[Fri Aug 14 21:41:26 2026] You offered 1 Bixie Essence to Medicine Man Veetra.
```

The loot rule matched fine (the corpse *possessive* is grammar the game appends with a
real apostrophe); the item name it captured is `` Spiritualist`s Ring ``, and
`lookup()`/`offerSlots()` both answer empty for it while the apostrophe spelling finds
`shaman:4:1`. The Bixie Essence two seconds later counted, which is why only this item
went missing. Because the offer was never recorded, `doneState`'s "every slot offered"
derivation never fired — the quest never showed done, and nothing could have toasted.

The spelling is **per-item, not a convention**: the same log loots `Griffon's Beak` and
`Jester's Mask` with real apostrophes but `` Spiritualist`s Ring ``, `` Hierophant`s
Crook ``, `` Kavruul`s Mystic Pouch `` with backticks — and the live inventory dump has
`` Al`Kabor's Cap of Binding `` with BOTH GLYPHS IN ONE NAME (dataset: `Al'Kabor's Cap
of Binding`). So the inventory path (`parseInventory` → reward-in-bags proves turn-in)
is broken for the same names, silently. The dataset itself contains zero backticks;
4 turn-in items and 13 rewards contain apostrophes.

### Second gap: there is no quest-complete toast at all

Hand-ins are deliberately chipless today ("a hand-in is ledger movement worth a window
refresh, never a chip" — `main.js`). Even with the backtick fixed, the final offer
completing a quest announces nothing. James expected a toast; completing a class test
is exactly the "identify, don't mute" moment — state worth announcing once, not noise.

## Approaches Considered

### 1. Fold backtick → apostrophe inside `questItemKey`
- **Description:** One added step in the one function every path shares — index build,
  `lookup`, `offerSlots`, `rewardLookup`, the progress store's item keys,
  `parseInventory`, and import-key normalization all call `questItemKey`, so the fold
  lands everywhere at once and the index and its lookups cannot drift by construction.
- **Pros:** Fixes loot, offer, AND inventory paths in one line. No persisted-state
  migration: backtick keys never reached the ledger (lookup failed before the store
  wrote), and existing apostrophe keys (`griffon's beak`) are unchanged. Quest-scoped —
  cannot touch the parser's backtick-is-pet-ownership semantics in `entities.js`.
- **Cons:** None found. A hypothetical item whose name *meaningfully* differs only by
  glyph doesn't exist in this dataset.

### 2. Rewrite the dataset to the log's spellings
- **Description:** Change `posky.json` names (or make `fetch-posky.js` transform them)
  to match what the log writes.
- **Pros:** No normalization change.
- **Cons:** Wrong three ways: the dataset is refreshed from eqlposky and would regress
  on every re-fetch; the site's progress-export keys use apostrophe spellings, so
  imports would stop matching; and the log uses BOTH glyphs (`Griffon's Beak` loots
  with a real apostrophe), so there is no single "log spelling" to rewrite to.

### 3. Normalize at each capture site
- **Description:** Fold the glyph where names enter — the loot rule, the offer rule,
  the inventory row parser.
- **Pros:** Keeps `questItemKey` untouched.
- **Cons:** Three places to keep in sync, and the entire guarantee of `questItemKey`
  is that build-side and lookup-side share one function. Scattering the fold
  reintroduces exactly the drift the design exists to prevent.

### 4. Strip apostrophe-like glyphs from keys entirely
- **Description:** Delete both `` ` `` and `'` from keys instead of folding.
- **Pros:** Also survives a hypothetical third glyph (’, ´).
- **Cons:** Changes every already-persisted key that contains an apostrophe
  (`griffon's beak` → `griffons beak`), orphaning live ledger counts unless a
  migration rewrites the state file. Folding `` ` `` → `'` keeps every existing key
  valid and the ledger JSON human-readable. No third glyph has ever appeared in the
  log; earn that normalization with a real mismatch, per the file's own doctrine.

## Chosen Approach

**Approach 1** for detection, plus a **completion chip** built the way the loot chip
was: the store decides wording and the flip, main.js only pushes into the existing
`questChips` stack.

- `questItemKey` gains a `` ` `` → `'` fold, with a why-comment citing the live
  evidence (per-item spelling; the mixed-glyph `` Al`Kabor's Cap of Binding ``).
- `QuestProgress.feed`'s offer path computes the quest's `doneState` **before** the
  offer lands and again after; when the offer flips it to done (log source), the
  return gains `completed: {classId, className, reward}`. A `completionChip()` sibling
  of `lootChip()` words it (reward name up top, "<Class> quest complete" underneath)
  so the wording is unit-testable in WSL.
- `main.js` pushes the completion chip on `kind === 'offer' && completed` — same
  tier-2 chip stack, same TTL. Ordinary hand-ins stay chipless; only the flip
  announces. The inventory-derived done flip does NOT toast: the dump poll runs in
  the background at startup and a stale dump toasting "complete" out of nowhere reads
  as random, not as news.

### Recovering the swallowed events (James's choice, note in changelog)

- **Zero-effort:** after the fix, `/outputfile inventory` in game. The Vermilion Sky
  Ring is NO DROP and in the bags — the inventory derivation proves the turn-in and
  the quest shows done. The ring's loot/offer *counts* stay absent (cosmetic).
- **Full rebuild:** quit the overlay, delete the quests ledger file
  (`<userData>/quests/…` — the path `store.fileFor()` names), re-run
  `node scripts/backfill-quests.js <log> --dir <dir>`. Replays the whole log with the
  fix and recounts everything, ring included. Loses manual toggles and import claims
  (the inventory dump reapplies itself via the poll).

## Tasks

- [x] Add the backtick→apostrophe fold to `questItemKey` (`src/quests/index.js`), with
      a why-comment naming the live evidence and the per-item nature of the spelling
- [x] Tests in `tests/quests.test.js`: `` lookup('Spiritualist`s Ring') `` finds
      `shaman:4:1`; `` offerSlots('Medicine Man Veetra', 'Spiritualist`s Ring') ``
      answers; `` rewardLookup("Al`Kabor's Cap of Binding") `` (mixed glyphs) resolves;
      apostrophe spellings still match; article + `+N` + backtick compose
- [x] Test in `tests/quests-inventory.test.js`: a dump row with a backtick name folds
      onto the dataset key
- [x] `parseInventory`: accept the dump's three-column rows (`Location\tName\tID` —
      equipment sets, augments, activated items; 109 of 637 live rows) with an
      implicit count of 1, keeping torn-write rejection via the numeric-ID check
- [x] `QuestProgress.feed` offer path: before/after `doneState` comparison, `completed`
      in the return only on a false→true flip with source `log`
- [x] `QuestProgress.completionChip(completed)` — wording lives in the store like
      `lootChip`, unit-tested (including: second offer of the same item does NOT
      re-announce, because the quest is already done before it lands)
- [x] `main.js`: push the completion chip from the `feedLine` result; update the
      hand-ins-never-chip comment to name the one exception
- [x] `npm test` in WSL
- [x] Changelog `docs/changelog/2026-08-14-backtick-item-names-and-complete-toast.md`,
      including both recovery paths
- [x] Quit overlay → `scripts/dev.sh pack` → relaunch (three steps, not two)

## Notes

- **Discovered during execution:** the dump has a second row shape the parser never
  accepted — `Equipment` (81 rows), `Augmentation` (26) and `Activated` (2) rows carry
  only `Location\tName\tID`, no Count/Slots, and `cols.length < 4` skipped every one.
  `` Al`Kabor's Cap of Binding `` lives in an Equipment row, so the backtick fold alone
  could not make the inventory path see it. Fixed by treating a three-column row with a
  numeric ID as count 1 (the sections are inherently unstacked); a torn write still
  fails the numeric-ID check. Name overlap between the shapes is 7 keys, none of them
  dataset names, and `applyInventory` scopes to dataset keys regardless.
- The parser's backtick handling (`entities.js` pet ownership) is untouched — the fold
  lives only in quest-key space, where a backtick is a glyph, not a marker.
- Verified there is no second failure hiding behind this one: the shaman NPC is spelled
  `Medicine Man Veetra` in dataset and log alike, and the loot/offer rules themselves
  matched the ring lines — only the key comparison missed.
- `minTs` means the fixed code will not retro-count the ring lines on next launch (the
  Bixie Essence offer at 21:41:26 advanced the high-water mark past them) — hence the
  explicit recovery section.
- Other currently-farmable names this silently affects beyond the ring:
  `` Spiroc Elder's Totem `` if the game spells it with a backtick (dataset has it with
  an apostrophe; not yet looted in the live log, so unconfirmed either way — the fold
  makes both spellings work regardless).
