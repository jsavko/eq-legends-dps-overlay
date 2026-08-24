# The drops popup answers "what does THIS corpse owe me"

**Date:** 2026-08-24

## Summary

The engaged-drops popup used to match the fight's enemy names against the quest
dataset's `source` strings by bare lowercase equality. That could only ever fire on a
mob whose name eqlposky spelled exactly the way the log spells it — and eight of the
eighteen source strings in the dataset fail that test, for two different reasons.

Six are prose rather than names: `Island 6: "bee" mobs`, `Island 7: drake/sphinx/spirit
mobs`, `Island 4: essence/soul mobs, Eternal Spirit`. They describe a family, and no log
line will ever contain one. Two more — plus one nobody had counted — are real names the
log only ever writes with an article: `the Hand of Veeshan`, `a greater sphinx`, and
`Island 5: The Spiroc Lord`. The combat parser strips the article from every
`engagedNpcs` key, so those three were exactly as unmatchable as the family blobs.

Both halves are fixed, and neither fix guesses.

- **The article half** is normalization: `mobKey` folds the leading article on both
  sides of the comparison, which is the same strip `resolveEntity` has already applied
  to every engaged name and `creatureKey` to every learned corpse name. It resurrects no
  family blob — "spiroc mobs" has no article to lose.
- **The family half** is measurement. `QuestProgress` now keeps the corpse name the loot
  rule was already parsing and the store was throwing away, as a fourth fact beside the
  loot, offer and inventory counts: `creature → item → count`, accumulated from this
  character's own log. The popup matches against the union of that index and the
  dataset's named bosses, so a fresh install still works and every pull after it knows
  more. The keys are the log's own creature names, which makes matching equality by
  construction with nothing clever in it.

And the reach got its own switch, because it is the louder behaviour.

## What this actually changed on the live ledger

Measured against Rhale's real quest file, not asserted:

- **The Spiroc Lord (4 items owed) and the Hand of Veeshan (1) could never fire the
  popup.** Both do now. That is the whole of what shipped onto his screen today, and it
  came from the article fold rather than the learned index.
- The learned index mined **37 mobs / 267 pairs** out of his 201 MB log and currently
  adds nothing on top: everything those trash mobs drop is either a rune he does not
  need or an item he already owns. That is the expected shape, not an idle feature —
  it is what makes `a spiroc vanquisher` fire the moment one of its drops goes
  outstanding. The log proves all three failure classes are real: `Bzzzt` and
  `Bazzzazzt` drop Bixie Essence (dataset: `"bee" mobs`), `undine spirit` drops Golden
  Hilt, Gem of Invigoration and Crown of Elemental Mastery (dataset:
  `drake/sphinx/spirit mobs`).

## Why measured, not tabled

The obvious alternative was a shipped blob → member table: `"bee" mobs` →
`[Bazzt Zzzt, Bazzzazzt, Bzzzt, Bzzazzt, Bizazzzt]`, and so on per island. It was
rejected for the reason `CLAUDE.md` gives about a shipped spell-duration table. Legends
is a custom server; a member list transcribed from a classic wiki is wrong for everybody
in a slightly different way, it needs hand maintenance forever, and it fails **silently**
— a mob missing from the list produces no popup and no complaint, which is precisely the
bug being fixed.

Substring matching on the blob text was rejected twice before (the 2026-08-20 changelog
says "no substring guessing was built") and does not even work: `Bzzazzt` is a bee and
contains no "bee"; `a blade storm` is a spirit and contains no "spirit". It would miss
real members and match wrong ones with no way to tell which.

So this follows `mine-rhythms.js` and `mine-buffs.js`: measure the player's own log.
Every row in the index is something this character watched drop.

## Changes

### Features

- **A drop index in the quest ledger.** `QuestProgress` records `state.drops[creature]
  [itemKey] = count` on every counted loot line, gated by the same `lookup()` test the
  item counts use so it stays a quest ledger and not a second loot pane. Every
  disposition counts, `sold` included — that says where the item went, not what dropped
  it. Additive key: a file written before it existed reads as empty, so there was no
  `QUEST_STORE_VERSION` bump and no migration.
- **`dropGroups(snapshot, { anyMob })`** — the popup's inversion, the dataset's named
  bosses unioned with the learned index. A learned row the dataset already places is not
  duplicated and does not gain a `seen` count; a learned mob the dataset never named gets
  a group with `island: null`, because inferring the island from the item's own chips
  would be a guess wearing a label's clothes.
- **`mobNeeds(snapshot, mobName, { anyMob })`** — the same question asked about one
  corpse rather than a pull.
- **`dropsAnyMob`** (default on), the second switch in Settings → Overlay → Needed
  drops: *"Include any mob your log has proved drops what you need"*. Off is exactly the
  named-boss-only behaviour that shipped before the drop index, byte for byte. Both keys
  live in that one section, the only place either is written — the two-places failure
  that removed the ALERTS section cannot recur.
- **`scripts/mine-drops.js`** — replay a log, print `mob → item → count`, `--write` to
  fold it into a character's store. The backfill for everything looted before the live
  overlay started recording it, since the store's timestamp floor would otherwise skip
  the entire history.

### Bug Fixes

- **Three named dataset bosses could never fire the popup.** `The Spiroc Lord`,
  `the Hand of Veeshan` and `a greater sphinx` are written with an article in every one
  of the live log's 24,000-odd mentions, and the parser strips it before the name reaches
  the matcher. `engagedNeeds` and `dropsDisplay` now compare on `mobKey`.

### Refactoring

- `bossNeeds` and `dropGroups` share one `outstanding()` walk of the ledger. The rail and
  the popup can differ about grouping — the rail answers "where do I go next", where
  thirty-seven trash mobs are noise; the popup answers "is this corpse worth looting",
  where they are the point — and can never differ about what is owed. That was the
  original reason `needs.js` is in the pure layer.
- `needs.js` gained its first import, `stripArticle` from the parser's `entities.js`. It
  is pure and imports nothing itself, so the module stays loadable by the Quests window's
  renderer, which is why it still cannot touch `src/quests/index.js` and its `fs` read of
  `posky.json`. The learned index arrives on the snapshot already resolved from item keys
  to dataset item names for exactly that reason.

### Divergences from the plan

- The plan said "strict equality is kept, unchanged, in both halves". The article fold
  was found during execution and is not the loosening that line guarded against: it is
  the fold the other two vocabularies had already applied, and without it three real
  bosses stayed dead. Kept, with the evidence recorded in the plan's Notes.
- The plan named `tests/quests-progress.test.js`; the store's tests already live in
  `tests/quests.test.js` and the new section joined them rather than splitting one
  subject across two files.

## Files modified

| File | What changed |
|---|---|
| `src/quests/progress.js` | The drop index: default state, the record in `feed()`, and `snapshot().drops` resolved to dataset item names |
| `src/quests/needs.js` | `outstanding()` extracted, `mobKey`, `itemRow`, `dropGroups`, `mobNeeds`; `engagedNeeds` and `dropsDisplay` match on `mobKey` |
| `src/main/config.js` | `dropsAnyMob` default, `dropsAnyMob()` reader, added to `DROPS_KEYS` |
| `src/main/main.js` | `pushDrops` uses `dropGroups` with the switch |
| `src/renderer/setup/index.html`, `setup.js` | The second switch in the Needed drops section |
| `src/renderer/drops/drops.js`, `drops.css`, `index.html` | The faint `seen N×` caption on learned-only rows; wording no longer says "Sky boss" |
| `scripts/mine-drops.js` | New |
| `tests/quests.test.js` | 7 drop-index tests, including the no-`drops`-key load |
| `tests/quests-needs.test.js` | 11 tests for the union, the switch, and the article fold |
| `tests/config.test.js` | The new key's default and its place in `DROPS_KEYS` |
| `CLAUDE.md` | `mine-drops.js` in the commands block |

## Notes

- **Dedup on `--write` is a per-pair MAX, not a sum.** There is no record id to dedup on
  the way `backfill-history.js` has one, and the live store accumulates the same facts in
  parallel. Max makes a re-run and an overlap with the live count both no-ops — verified,
  the second run reported `0 raised, 267 already at least that high` with every other
  fact in the file byte-identical. The cost, stated rather than hidden: mining two
  *different* logs folds in what each alone proves rather than their sum, so a count can
  be short. It can never be invented, and no count decides anything — a mob is in the
  index or it is not.
- **Runes stay in.** `Random zone-wide drop` is still excluded from the dataset half, but
  "Protector of Sky dropped Wind Rune Kala 5×" is a measured fact and shows as one. Rhale
  needs no rune today, so this is untested in practice; if a rune ever goes outstanding,
  nearly every mob in the zone will fire the popup and the switch is the escape hatch.
- **If trash-mob volume reads as noise**, the next lever is a floor (only show a mob whose
  drop is confirmed more than once) rather than reintroducing a boss whitelist. The
  `seen` count is already on every learned row for exactly that.
- Rhale's ledger was seeded from his own log (37 mobs / 267 pairs) with the overlay
  quit first, so the running app could not clobber the write.
