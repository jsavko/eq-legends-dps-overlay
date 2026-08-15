---
status: completed
---
# Quest ready-to-turn-in flags and multi-class item chips

**Date:** 2026-08-15

---

## Goal

Two additions to the Quests window, both answering questions the ledger already knows
the answer to but the window doesn't surface:

1. **"Which tests can I go hand in right now?"** — a quest whose every item is owned
   but which hasn't been turned in is *ready*, and today finding one means opening each
   class and reading `4/4` off the rows. Ready should be visible at a glance: a flag on
   the class header in the rail (visible even when the class is folded — that's the
   glance), a flag on the quest row itself, and ideally a rail filter that shows only
   ready quests.

2. **"This item serves more than one class — who gets it?"** — 29 of the 128 distinct
   item names are wanted by more than one class (all fifteen Wind Runes serve 6–7
   classes each; fourteen gear items are shared by exactly two, e.g. Brass Knuckles →
   beastlord + monk). The eqlposky website marks these; our items pane doesn't. Each
   shared item should show which *other* classes want it, with each competitor's state
   in the wording ("✓ turned in" vs "still needs it") so James can decide which class
   gets the drop.

## Approaches Considered

### 1. Pure renderer derivation in `organize.js` (chosen)
- **Description:** Both judgements computed from the existing snapshot, in the window's
  pure half. *Ready* is arithmetic over decided flags already delivered per quest
  (`!done && ownedCount === itemCount`). *Sharing* is a scan over the snapshot's own
  classes/quests/items building name → slots — safe on plain string equality because
  every shared name is spelled identically across classes in the dataset (verified
  today: 0 of 29 shared groups differ in raw spelling), and a new property test pins
  that assumption against future dataset refreshes.
- **Pros:** No store change, no IPC change, no payload growth. Lands exactly where the
  window's other judgements live (`classGroups`, `doneCaption`), unit-testable in WSL.
  Sharing derived from the same snapshot the window renders cannot disagree with what's
  on screen.
- **Cons:** The renderer matches names by string equality instead of `questItemKey` —
  acceptable only because dataset spellings are identical, which the pinning test turns
  from an assumption into a checked invariant.

### 2. Store-computed in `progress.snapshot()`
- **Description:** `snapshot()` adds `ready` per quest and `sharedWith` per item, built
  from `ITEM_INDEX`/`lookup()` and `doneState()` in the store.
- **Pros:** Uses the real `questItemKey` normalization; one computation site.
- **Cons:** Grows the snapshot with data fully derivable from what it already carries;
  blurs the store's contract (it delivers *decided claims*, and display arithmetic over
  them has always been organize.js's job — `doneCount` is already computed there);
  every new field is IPC surface to keep compatible.

### 3. Bake sharing into the dataset via `fetch-posky.js`
- **Description:** The fetch script precomputes `sharedClasses` per item into
  `posky.json`.
- **Pros:** Zero runtime work.
- **Cons:** Mutates the fetched dataset's shape, so a site refresh must re-run our
  transform correctly or silently drop the field; smears derived data into a file that
  is otherwise verbatim-from-source; still doesn't help *ready*, which is per-character
  state, so a second mechanism would be needed anyway.

### 4. A "Ready" rail filter only, no flags
- **Description:** Add the filter mode and let the player switch to it.
- **Pros:** Smallest change.
- **Cons:** Fails the actual request — "at a glance" means seeing readiness without
  changing view state, on the class headers, folded or not. A filter is a nice
  complement, not the feature.

## Chosen Approach

**Approach 1**, with the filter from approach 4 folded in as a complement. All logic in
`organize.js` (pure, WSL-tested), all painting in `quests.js`, nothing touches
`progress.js` or IPC. Per the project convention and the fixed-pane feedback memory, the
visual additions get a Pencil mockup pass on the existing "Quests Window — cleanup" mock
before implementation.

**Ready definition:** `!quest.done && itemCount > 0 && ownedCount === itemCount` — every
slot claims owned (whatever source decided the claim), quest not yet turned in.

**Display language:** balm stays reserved for *done*; ready dresses in gold (proposal: a
filled gold READY pill on quest rows replacing the `4/4` count, and a gold `N ready`
badge on the class header beside `x / y done`). The mockup settles the exact shapes.

## Tasks

- [x] Pencil mockup: ready pill on a quest row, `N ready` badge on a class header
      (folded and unfolded), Ready filter chip, shared-class chips on an item row —
      on the existing quests mock, 1:1, approved before code
- [x] `organize.js` — `classGroups`: add `ready` per quest and `readyCount` per class
- [x] `organize.js` — new `sharedIndex(snapshot)`: item name → every class wanting it
      (`{classId, className, reward, done}`, deduped by class), plus a per-item helper
      returning the *other* classes for one item; string-equality match
- [x] `organize.js` — `doneCaption`: ready case for the quest pane's donebox hint
      ("every item owned — ready to hand in"; the existing "N of M handed in per the
      log" caption keeps precedence when hand-ins have started)
- [x] `organize.js` — `RAIL_FILTERS` gains `'ready'`; `railFilter` handles it (class
      headers still never drop; counts stay full totals)
- [x] `index.html` — Ready button in the filter row
- [x] `quests.js` — `renderRail`: READY pill on ready quest rows; `N ready` badge on
      class headers, rendered on folded headers too
- [x] `quests.js` — `renderItems`: shared-class chips row on each multi-class item,
      state in the wording ("also wanted by: MONK ✓ turned in · WIZARD still needs
      it"); absent entirely on single-class items
- [x] `quests.css` — pill, badge and shared-chip styles; nothing under 12px
- [x] Tests in `tests/quests-organize.test.js`: ready arithmetic (including the
      all-owned-but-done case and the empty-items guard), `readyCount`, ready filter,
      `sharedIndex` against the real dataset (rune → 6–7 classes, Brass Knuckles → 2),
      ready caption precedence
- [x] Property test pinning the string-equality assumption: every ITEM_INDEX group
      spanning classes spells its name identically across the dataset — a posky.json
      refresh that breaks this fails in WSL instead of silently dropping chips
- [x] Headless renderer verify against a snapshot replayed from the live log (badge
      counts, pill presence, chips on a rune row)
- [x] `npm test`, then kill overlay → `scripts/dev.sh pack` → relaunch
- [x] Changelog `docs/changelog/2026-08-15-quest-ready-flags-shared-items.md`; archive
      this plan

## Notes

- **Empirical facts (checked 2026-08-15):** 128 distinct item names, 29 shared across
  classes, 0 shared groups with differing raw spellings. The 14 non-rune shared items
  are all exactly-two-class pairs; every rune serves 6–7 classes.
- **The shared-rune honesty caveat:** owned is derived *globally* by item key (one
  surviving Wind Rune Izah makes the slot look owned in all seven classes), so two
  quests can both show READY on the strength of the same single rune — only one can
  actually be turned in. The shared-class chips are the decision aid for exactly this.
  If the mockup pass wants more, the READY pill's hover title can name shared items
  also claimed by other unfinished tests; start without it and let use decide.
- The loot chip already speaks multi-class at drop time ("7 class tests want this");
  this work gives the window the same knowledge at reading time. Wording should rhyme
  with the chip's.
- Titlebar could also carry a ready total ("· 2 ready"); left out of scope unless the
  mockup wants it.
- **Execution notes (2026-08-15):** mock approved as "Quests Window — ready & shared"
  in `pencil-new.pen`, beside the cleanup mock, with an annotation note underneath.
  Headless verify replayed the live log through the real store (`feedLine` per line —
  split on `\r?\n`, the log is CRLF and anchored rules miss otherwise) plus `setOwned`
  claims to stand up one ready quest unfolded (beastlord) and one folded (monk). All
  four verify targets held; the ready filter kept all sixteen headers. Full suite 839
  passing; packed and relaunched.
