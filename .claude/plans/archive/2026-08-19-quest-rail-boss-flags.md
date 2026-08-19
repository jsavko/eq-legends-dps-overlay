---
status: completed
---
# Quest rail boss flags — where the missing drops come from

**Date:** 2026-08-19

---

## Goal

In the Quests window's left rail, each quest row should say *where to go* as well as
*how far along you are*: small flags under the quest name naming the bosses (and the
island each stands on) that drop the items still needed to complete that quest. Today
that answer requires clicking every quest and reading its items pane; during a Sky
raid the actual question is the reverse — "we're about to pull Gorgalosk, which of my
quests care?" — and the rail is the only surface you can scan for it.

The dataset already carries everything needed: every item has a `source` string
(`Island 5: The Spiroc Lord`, `Island 7: drake/sphinx/spirit mobs`, `Random
zone-wide drop` — 18 distinct strings across the whole dataset), and
`parseSources()` in `src/renderer/quests/organize.js` already turns them into
typed chips for the items pane. This is a display change plus one pure function;
no store, IPC, or dataset changes.

## Approaches Considered

### 1. Source chips under each unfinished quest row (rail goes two-line)
- **Description:** `classGroups()` gains a per-quest `sources` list: the deduped
  chips from `parseSources()` across the quest's **unowned** items only. The rail
  row grows a second line of small flags — island number bold, mob name beside it,
  zone-wide styled as the rune it is. Done and READY quests show no flags (nothing
  left to hunt), so finished rows stay exactly as they are.
- **Pros:** Answers the question where it is asked, scannable across all quests at
  once; reuses `parseSources` so the rail and items pane can never disagree about
  what a source means; flags vanish as items are looted, so the rail converges to
  clean rows as progress happens; pure-function change is unit-testable in WSL.
- **Cons:** Rail rows get taller (two lines while a quest is unfinished), so less
  fits per screen; a quest whose item drops from three alternative bosses shows
  three chips that could misread as "need all three".

### 2. Inline island-number badges to the right of the quest name
- **Description:** Keep rows single-line; append compact badges like `③ ⑤ Z` after
  the name, with the boss name only on hover.
- **Pros:** No row growth; very compact.
- **Cons:** An island number alone doesn't name the boss — the data is hidden
  behind a hover, which violates the show-all-data rule this project keeps
  relearning; single-line rows already ellipsize long reward names, and badges
  would eat that space; unreadable at small size.

### 3. Boss-first: a "by boss" mode or hover popup
- **Description:** Either a fourth rail arrangement grouping quests under the boss
  that drops their missing pieces, or extend the existing rail hover preview with a
  boss list.
- **Pros:** Directly answers "we're pulling X, who cares?"; no row growth.
- **Cons:** A whole new rail mode is a much bigger surface than asked for; the
  hover variant hides the answer behind a per-row hover, so there is no scanning —
  and the rail hover already shows the reward card, which would crowd it. Not
  what was asked ("under the quest on the left side").

### 4. Flags in the quest pane (middle) instead of the rail
- **Description:** A "still to hunt" line above the reward cards for the selected
  quest.
- **Pros:** Room to spare; zero rail impact.
- **Cons:** Per-selected-quest only — the items pane below already shows exactly
  this per item, so it adds nothing; the ask is explicitly the rail.

## Chosen Approach

**Approach 1.** It is literally what was asked for, it reuses the existing source
parser, and the "rows get taller" cost self-heals: flags exist only while something
is missing, so the steady state of a finishing character is the current one-line
rail. The alternative-bosses ambiguity is handled by joining alternative chips for
the *same item* with a faint "or" separator, which `parseSources` chip order already
preserves per item. Height growth in the rail is fine — the rail is its own
scrolling pane, and the no-reflow rule is about panes, not rows inside one.

Semantics, pinned:
- Flags come from **unowned items only**. Owned, done, and ready contribute nothing.
- Chips dedupe by mob **across items** (two missing items off the same boss = one
  flag), but alternatives within one item stay grouped with "or".
- Zone-wide rune sources render as one distinct `ZONE-WIDE` flag in the rune's gold.
- Island number renders bold in the flag, mob name in full — no truncation, no
  hover-only data.
- An unrecognized source shape becomes a verbatim flag, never a dropped one (same
  contract `parseSources` already keeps).

## Tasks

- [x] Pencil mockup of the two-line rail row (normal, multi-flag, zone-wide, done,
      ready cases at 1:1) — **user approval before any code**
- [x] `organize.js`: add `questSourceFlags(quest)` — unowned items →
      `parseSources`, dedupe by mob across items, preserve per-item alternative
      grouping, zone-wide flag; wire it into `classGroups()` as `q.sources`
- [x] `tests/quests-organize.test.js`: cases for dedupe across items, alternatives
      ("Dojorn / Overseer / Hand of Veeshan" stays one group), zone-wide, owned
      items contributing nothing, done/ready quests yielding `[]`, verbatim
      fallback for an unknown shape
- [x] `quests.js` `renderRail()`: render the flag line under the name when
      `q.sources` is non-empty
- [x] `quests.css`: `.qrow` two-line layout and `.mobflag` styling (≥12px, island
      bold, rune gold for zone-wide, dimmed vs the name so the reward stays the
      anchor); selected/hover states unchanged
- [x] `npm test`, then `scripts/dev.sh pack` + relaunch so James sees it
- [x] `docs/changelog/2026-08-19-quest-rail-boss-flags.md`

## Notes

- **Executed 2026-08-19.** The mock had been built and was awaiting approval;
  James invoking /execute-plan on this plan was read as that approval. Dedupe
  keys on island+mob (not mob alone) so a mob-blob name recurring on two islands
  could never fold into one flag. All 873 tests pass; packed and relaunched.
- **Mock built, awaiting approval** (2026-08-19): `pencil-new.pen`, frame
  "Quests Window — rail boss flags" (below "Quests Window — ready & shared"),
  plus a "Rail flags — worst realistic row" strip showing the 0/4 Windhowl row
  with the three-boss "or" group, and a note stating the semantics. Rail shows
  all four states at 1:1: two-line with flags (Azarack 0/2), flags shrinking as
  items are owned (Diaphonous 1/2, rune flag gone), done and READY unchanged
  one-liners.
- All 18 distinct source strings (verified against `posky.json` today) parse
  cleanly through `parseSources` already; the property test in quests-organize
  pins that, so the new function inherits the guarantee.
- Rows must not grow for done/ready quests — the second line exists only when
  flags do, so the "one line per finished quest" density is preserved exactly.
- Open question for the mock: whether the READY pill row should also show flags
  when the player has marked an item owned manually but the quest isn't ready —
  it does (owned is owned, regardless of source; only *unowned* items flag).
