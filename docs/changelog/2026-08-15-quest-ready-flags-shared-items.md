# Quest ready-to-turn-in flags and multi-class item chips

**Date:** 2026-08-15

## Summary

Two additions to the Quests window, both surfacing answers the ledger already knew but
the window didn't say:

1. **Ready at a glance.** A quest whose every item is owned but which hasn't been
   turned in is *ready* — and finding one used to mean opening each class and reading
   `4/4` off the rows. Now readiness is stated everywhere it matters: a gold `N ready`
   badge on the class header (rendered on folded headers too — that's the glance), a
   filled gold READY pill replacing the owned count on the quest row itself, a
   "every item owned — ready to hand in" hint in the donebox, and a Ready mode in the
   rail filter. Gold on purpose: balm stays reserved for *done*.

2. **The competition footer.** 29 of the 128 distinct item names are wanted by more
   than one class (every Wind Rune serves 6–7; fourteen gear items are two-class
   pairs). Each multi-class item row now carries an "also wanted by" footer — one chip
   per competing class with its state in the wording ("✓ turned in" in balm vs "still
   needs it") — so the drop can be given to the class that actually needs it. Absent
   entirely on single-class items. The wording rhymes with the loot chip's, which has
   spoken multi-class at drop time since it shipped; this gives the window the same
   knowledge at reading time.

The shared-rune honesty caveat the footer exists for: owned is derived *globally* by
item key, so one surviving Wind Rune can make several classes' quests read READY at
once when only one can actually be turned in. The chips are the decision aid for
exactly that case.

## Changes

### Features

- `src/renderer/quests/organize.js` — `classGroups` computes `ready` per quest
  (`!done && itemCount > 0 && ownedCount === itemCount`) and `readyCount` per class;
  new `sharedIndex(snapshot)` builds item name → every class wanting it
  (`{classId, className, reward, done}`, deduped by class, the undone quest winning a
  hypothetical duplicate slot) and `sharedWith()` answers with the *other* classes for
  one item; `doneCaption` gains the ready hint (the "N of M handed in per the log"
  caption keeps precedence once hand-ins start); `RAIL_FILTERS` gains `'ready'` and
  `railFilter` handles it — class headers still never drop, counts stay full totals.
- `src/renderer/quests/index.html` — Ready button in the filter row.
- `src/renderer/quests/quests.js` — `renderRail` paints the badge (folded headers
  included) and swaps a ready row's count for the READY pill; `renderItems` builds the
  shared index per render from the same snapshot it paints and appends the
  "also wanted by" footer to multi-class items.
- `src/renderer/quests/quests.css` — badge, pill and footer styles; the item grid
  gains a `shared` row spanning under the count column so the rune's six chips have
  the width; nothing under 12px.

### Tests

- `tests/quests-organize.test.js` — ready arithmetic (including all-owned-but-done and
  the empty-items guard), `readyCount`, the ready rail filter, ready-caption
  precedence, `sharedIndex`/`sharedWith` against the real dataset (Wind Rune Izah →
  7 classes, Brass Knuckles → beastlord + monk), and a property test pinning the
  string-equality assumption: every ITEM_INDEX group spanning classes spells its name
  identically across the dataset (all 29 shared groups today), so a posky.json refresh
  that breaks it fails in WSL instead of silently dropping chips.

## Rationale

Sharing is derived in the window's pure half from the snapshot it renders, not in
`progress.snapshot()` and not baked into the dataset by the fetch script — no store
change, no IPC change, no payload growth, and a judgement derived from what's on
screen cannot disagree with it. The renderer matches names by plain string equality
instead of `questItemKey`; that is safe exactly as long as the dataset spells shared
names identically across classes, which the property test turns from an assumption
into a checked invariant.

Verified headlessly against the live log replayed through the real store: badge
counts on folded and unfolded headers, pill presence, the ready caption, and the
competitor chips on a rune row (states straight from the log's own done flags), plus
the Ready filter keeping all sixteen class headers. Mockup approved in Pencil
("Quests Window — ready & shared", beside the original cleanup mock) before
implementation. Full suite: 839 passing.
