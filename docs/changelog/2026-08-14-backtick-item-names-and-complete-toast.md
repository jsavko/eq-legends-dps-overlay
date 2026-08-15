# Backtick item names track again, and the final hand-in toasts the quest

**Date:** 2026-08-14

## What happened

The Spiritualist's Ring run produced nothing. Looted at 21:37, handed to Medicine Man
Veetra at 21:41, and the tracker never blinked: no loot chip, no count, no recorded
turn-in, no sign the Vermilion Sky Ring quest closed — while the Bixie Essence offered
two seconds later tracked normally.

```
[Fri Aug 14 21:37:24 2026] --You have looted a Spiritualist`s Ring from Sister of the Spire's corpse.--
[Fri Aug 14 21:41:24 2026] You offered 1 Spiritualist`s Ring to Medicine Man Veetra.
```

## Root cause one: the backtick

EQ's item database spells some names with a backtick where the dataset
(eqlposky → EQProgression) writes an apostrophe, and `questItemKey` — the single
normalization every match runs through — did not fold them. The glyph choice is
**per-item, not a convention**: the same log loots `Griffon's Beak` with a real
apostrophe but `` Spiritualist`s Ring `` with a backtick, and the inventory dump
writes `` Al`Kabor's Cap of Binding `` with both glyphs in one name. That mixed name
is what ruled out rewriting either side's data: only a fold at the key can make it
match. So `questItemKey` now folds `` ` `` → `'` — a fold rather than a strip,
because apostrophes already live in persisted ledger keys (`griffon's beak`) that
deleting the glyph would orphan. The loot rule and offer rule had matched the ring's
lines all along; the key comparison was the only thing that missed, so the fix lands
everywhere at once — lookup, offers, inventory, imports — with no state migration.

## Root cause two: the three-column rows (found while testing the first)

The dump's `Equipment` (81 rows), `Augmentation` (26) and `Activated` (2) sections
write only `Location	Name	ID` — no Count, no Slots — and `parseInventory`'s
four-column minimum skipped every one, silently, since the feature shipped. The
Equipment section is where finished quest rewards actually live: with those rows
parsed (numeric ID admits the shape, a torn write still fails it, implicit count 1
because the sections are unstacked), the real dump proves **52** turn-ins instead of
7 — agreeing at last with the player's own eqlposky import, which marked ~fifty
quests done. The two sources disagreeing was never the import exaggerating; it was
the dump reader blind to the shelf the proof sat on.

## The completion toast

Hand-ins were deliberately chipless — ledger movement worth a window refresh, never a
chip. That doctrine keeps one exception now: the hand-in that flips its quest to done.
`QuestProgress.feed` judges the quest's `doneState` before the offer lands (the same
judged-before-the-event rule the loot chip's `needed` follows) and reports `completed`
only on the not-done → done flip, so the chip appears exactly once per quest: reward
name up top, "Shaman quest complete" underneath. A quest an import or a dump already
proved done completes silently, and re-offers say nothing. The store words the chip
(`completionChip`), main.js only pushes it into the existing quest-chip stack —
tier 2, same TTL as loot chips.

## Recovering the swallowed session

The ledger's high-water mark postdates the ring's lines (the Bixie Essence offer
counted, advancing it), so the fixed code will not re-read them live. Two paths:

- **Zero-effort (recommended):** run `/outputfile inventory` in game once after
  updating. The Vermilion Sky Ring is NO DROP and in the dump, which proves the
  turn-in; the fresh dump also lands everything the three-column fix now sees.
  Only the ring's historical loot/offer *counts* stay absent, which is cosmetic.
- **Full rebuild:** quit the overlay, delete the quests ledger
  (`%APPDATA%\eq-legends-dps-overlay\quests\Rhale_oggok.json`), re-run
  `node scripts/backfill-quests.js <log> --dir <dir>`. Recounts everything, ring
  included, at the cost of manual toggles and import claims (the inventory dump
  reapplies itself via the poll; an eqlposky export can be re-imported).

## Files

- `src/quests/index.js` — the backtick fold in `questItemKey`, with the evidence
- `src/quests/inventory.js` — three-column rows parse with implicit count 1
- `src/quests/progress.js` — `feed` reports `completed` on the offer that flips a
  quest to done; `completionChip` words it
- `src/main/main.js` — pushes the completion chip; the hand-ins-never-chip comment
  now names its one exception
- `tests/quests.test.js`, `tests/quests-inventory.test.js` — the ring's real lines as
  regression tests; fixture counts re-measured (161→253 keys, 43→90 matched, 7→52
  proven turn-ins, 40→41 owned slots)

Verified end-to-end by replaying the failed session's exact lines through the fixed
pipeline: the pickup chips "Spiritualist's Ring — Shaman — Vermilion Sky Ring", the
third offer reports the completion, and the chip reads "Vermilion Sky Ring — Shaman
quest complete". Full suite: 816 tests pass.
