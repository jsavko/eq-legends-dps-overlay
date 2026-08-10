---
status: completed
---
# Overlay ability table: column headers, accuracy, and one cell per fact

**Date:** 2026-08-10

---

## Goal

The hover breakdown's ability list prints four cells per row and names none of them:

```
Slash     88   73%   2/3
Frenzy    25   21%     1
Kick       7    6%   1/2
Bash       1   <1%     1
```

The report is exactly right — the third value is unexplained. For the record, reading
`src/renderer/overlay/overlay.js:543-548`, they are name / damage / **share of this
member's own total** (pet included, so the list sums to 100% for them, not for the group)
/ **hits, over swings when any missed**. `Slash 2/3` is two hits from three swings; a bare
`1` is one hit and no misses. The screenshot is self-consistent: 2+1+1+1 matches `hits 5`
in the stats block, and the two denominators account for `misses 2`.

Three changes, agreed with the user:

1. **Column headers**, so the numbers explain themselves on screen. The History window's
   identical table already has them (`history.js:438`, rendered as a faint uppercase
   caption row by `.b-table li.cols`) — the overlay is the odd one out, and the two
   windows currently give a player different amounts of help with the same table.
2. **Accuracy as a percentage**, in place of the `2/3` fraction that reads as a mystery.
3. **The hit count keeps a column of its own**, because accuracy answers "what whiffs" and
   the count answers "how much did it actually swing" — and those are different questions.

Target layout, the user's screenshot re-rendered:

```
ABILITY   %DMG    DMG    ACC   HITS
Slash      73%     88    67%      2
Frenzy     21%     25   100%      1
Kick        6%      7    50%      1
Bash       <1%      1   100%      1
```

A per-ability *average* was considered and dropped in favour of accuracy.

## The change this really is

Today the fourth cell is a **compound "detail" cell** whose meaning shifts per view and
per row — `2/3` in the damage view, `3 · 120 over` in healing, `17 · FR` in taken. That is
precisely why the table cannot be headed: no single word captions "hits, sometimes over
swings, sometimes with an overheal, sometimes with a resist".

So the fix is not "add a header row to the existing table" — it is **one cell per fact**,
four value columns per view, each with a name:

| view | columns |
|---|---|
| damage | `ability` `%dmg` `dmg` `acc` `hits` |
| healing | `ability` `%heal` `healed` `overheal` `casts` |
| taken | `ability` `%taken` `taken` `hits` `resist` |

Healing and taken lose their riders and gain real columns — which is what History already
does for both (`['ability','healed','overheal','casts']` and
`['ability','damage','hits','max','resist']`). All three views end up with the same shape:
name plus four labelled numbers.

## Constraints this has to respect

- **The overlay cannot scroll.** A header row costs vertical space in *every* rendered
  column, and `abilityColumns` must be told about it or a long list silently runs off the
  bottom. A fifth track costs width, which the window borrows via
  `measureWidthShortfall` → `clampWidth` and gives back when the panel closes.
- **Every ability, always.** Nothing here may become a reason to cap the list.
- **Headers size the tracks.** `#d-abilities` is one grid whose rows are `subgrid`, so the
  header cells are grid items and *participate in track sizing*. At uppercase with
  letter-spacing, `SHARE` is wider than the current 2.6em floor on `.a-pct` and would
  widen that column for every row beneath it. Short labels and a smaller header font are a
  requirement, not a style preference.
- **Multi-column flow.** `layoutAbilityColumns` repeats the whole track group per column
  and places items explicitly. A header rendered once would caption the first column and
  leave the others bare — worse than no header, because it would look like it applied to
  all three.

## Approaches Considered

### 1. One cell per fact, with a caption row per rendered column (chosen)
- **Description:** Four labelled value columns per view; a header `li` per column inside
  `#d-abilities`, styled after History's `.b-table li.cols`; ability rows shift to grid-row 2+.
- **Pros:** Every column is nameable because every column means one thing. Identical
  pattern to the sibling window, so the two agree and nothing new has to be learned.
  Headers sit in the same subgrid, so they align with the numbers by construction rather
  than by hand-tuned padding. Overheal and resist stop being riders and become data.
- **Cons:** The most code: `layoutAbilityColumns` has to place headers as well as rows and
  subtract a header's height from the vertical budget, and the track count (4 → 5) is a
  magic number living in both the CSS `repeat()` rules and the JS placement.

### 2. Headers over the existing compound cell
- **Description:** Add the caption row, leave the fourth cell as `2/3` / `3 · 120 over` /
  `17 · FR`, and head it with whatever the leading number is (`hits` / `casts` / `hits`).
- **Pros:** Much smaller diff — no accessor changes in the three render functions.
- **Cons:** The header would be a half-truth on exactly the rows where the cell is
  confusing, which is the complaint. And `2/3` under a `HITS` header reads as a fraction —
  arguably worse than the unlabelled version.

### 3. A legend line under the list instead of headers
- **Description:** One faint line: `share · damage · accuracy · hits`.
- **Pros:** Cheapest vertically — one line total, not one row per column — and it sidesteps
  the multi-column repetition problem entirely.
- **Cons:** The reader maps four words to four positions by counting, which is the work a
  header removes. Diverges from History for no reason, and a legend below a long list ends
  up far from the numbers it describes.

### 4. Native `title` tooltips on the cells
- **Description:** `title="hits, over swings when any missed"` per cell.
- **Cons:** Dead on arrival. The overlay is click-through and its hover comes from main
  polling the cursor and sending coordinates (`startHoverPolling`) — Chromium never sees a
  real mouse, so it never renders a native tooltip. It would work only in the unlocked
  state nobody reads the meter in. Rejected on the mechanism, not on taste.

### 5. A second, nested hover panel for the ability under the cursor
- **Description:** Hover a row inside the panel, get a sub-panel with accuracy, max, crits.
- **Cons:** `hoverAt` deliberately returns early inside `#detail` so moving into the panel
  keeps the member selected; nesting means new geometry, a second growth path for a window
  that already borrows width and height, and a real risk of rows moving under the cursor —
  which the near-bottom `data-panel="above"` handling exists to prevent. An enormous
  mechanism for numbers that fit in columns.

## Chosen Approach

**Approach 1.**

**Accuracy.** `hits / (hits + misses)`. An ability that has swung and never missed is
**100%**, which is honest — including for spells and DoT ticks, which cannot miss and so
will all read 100%. That is a little uniform but it is true, and the alternative (blank
for anything that never missed) would leave most of a caster's list empty. **Zero swings
prints an em dash, never `0%`** — an ability row can exist with no hits and no misses, and
a fabricated `0%` there would read as "this always whiffs" rather than "nothing to
divide". A genuine 0% — swung, never landed — must print `0%`, so accuracy cannot reuse
`formatShare`, which turns anything ≤ 0 into a dash.

**Only the damage view has accuracy.** `takenAbilities` carries `{damage, hits, max, type}`
and `healAbilities` carries `{healing, overhealing, casts}` — misses are recorded per
member, not per incoming ability, and heals do not miss. Those two views spend the same
column on the fact they do have: `overheal` and `resist`, both of which are riders today
and become columns. No parser change anywhere; this is entirely a display-layer change,
which is where the project's standing rule says to look first when data seems missing.

**Where the arithmetic lives.** `breakdown.js` is the pure, unit-tested half of this
renderer, so `abilityAccuracy(hits, misses)` goes there returning `number | null`.
`abilityColumns` stays exactly as it is — the header is accounted for by what the caller
passes as `available`, which is the right seam: the pure function keeps knowing only "rows
of this height into this much space".

**Vertical budget.** `layoutAbilityColumns` derives `nonList` by subtracting the ability
rows from `measureContentHeight()`. With headers in the list it must subtract them too,
then hand `abilityColumns` an `available` already reduced by one header height — a header
occupies a row in *every* column, not once.

**History gets accuracy too.** Its damage table becomes
`ability damage share hits crits acc max`. The two windows describe the same fight; one
knowing the accuracy and the other not is the kind of quiet divergence that makes a player
distrust both. Cheap there — the pane scrolls, so width is the only cost.

## Tasks

- [x] `src/renderer/overlay/breakdown.js`: add `abilityAccuracy(hits, misses)` — returns
      `hits / (hits + misses)`, or `null` when there were no swings or either input is not
      finite. Comment why null rather than 0, and why 0 must stay printable.
- [x] `tests/breakdown.test.js`: `abilityAccuracy` over a partial miss (2/3), a clean
      ability (no misses → 1), an all-miss ability (0 hits, 2 misses → 0, NOT null), a row
      with no swings at all (→ null), and nonsense input.
- [x] `src/renderer/overlay/overlay.js`: rework `setAbilities()` to take a `columns` array
      of `{label, cell, className}` — four value columns — plus the existing `value` (for
      the bar) and `share`. Build the header `li` from the labels. Render no header when
      the list is empty: a caption over nothing is noise.
- [x] `src/renderer/overlay/overlay.js`: `renderDamageDetail` passes
      `%dmg / dmg / acc / hits`; `renderHealDetail` passes `%heal / healed / overheal /
      casts`; `renderTakenDetail` passes `%taken / taken / hits / resist`. The compound
      `detail` accessor and its `·` riders go away entirely.
- [x] `src/renderer/overlay/overlay.js`: add `formatAccuracy(fraction)` — `—` for null,
      `0%` for a real zero, whole percents otherwise. Deliberately NOT `formatShare`, which
      dashes out anything ≤ 0.
- [x] `src/renderer/overlay/overlay.js`: introduce `ABILITY_TRACKS = 5` and use it in the
      `grid-column: ${col * TRACKS + 1} / span ${TRACKS}` placement, with a comment tying
      it to the `repeat(n, …)` rules in the stylesheet so the two cannot drift.
- [x] `src/renderer/overlay/overlay.js` `layoutAbilityColumns()`: exclude header elements
      from `items`; subtract the header height from `nonList` **and** from the `available`
      passed to `abilityColumns`; place ability rows from grid-row 2; in multi-column mode
      emit one header per column at grid-row 1, reset on every re-layout exactly as the
      rows are.
- [x] `src/renderer/overlay/overlay.css`: fifth track in `#d-abilities` and in the
      `[data-cols="2"]` / `[data-cols="3"]` rules; the share column moves to first-numeric
      position and keeps its dim ink; `.a-acc` right-aligned tabular with a min-width floor
      like its neighbours; header row styled after History's `.b-table li.cols` (≈0.72em,
      uppercase, letter-spaced, `--ink-faint`) with its `::before` fill suppressed.
- [x] `src/renderer/history/history.js`: add `acc` to the damage breakdown table
      (`['ability','damage','share','hits','crits','acc','max']`) using the same
      `abilityAccuracy` semantics, dimmed like the other derived columns.
- [x] Verify headlessly per the worked example in
      `docs/changelog/2026-08-02-breakdown-shows-every-ability.md`: drive Windows Chrome on
      the debug port with a real replayed snapshot, screenshot the panel in all three
      metric views, and confirm (a) headers line up with their columns, (b) at 2 and 3
      columns every column is captioned, (c) a 19-ability member still fits the work area
      with the header present, (d) nothing clips at the largest text scale.
- [x] Show the user the screenshots for approval before considering the visual settled.
- [x] `npm test` green.
- [x] `docs/changelog/2026-08-10-overlay-ability-table-headers.md`.
- [x] `taskkill.exe /IM "EQL DPS Overlay.exe" /F` then `scripts/dev.sh pack` (pack, not
      dist — win-unpacked is the copy that gets launched).

## Notes

- **Why accuracy beat an average.** The user's call, and it holds up: the member-level
  stats block already prints `hits / misses / accuracy` for the whole row, so per-ability
  accuracy tells you *which* attack is dragging that number down — actionable. An average
  is largely a restatement of the damage column divided by a count already on the row.
- **Where the width goes.** Body text is `13px * var(--scale)`; the ability list is
  `0.8em` of that, so the new track plus its 0.5em gap is ≈36px **per rendered column** —
  up to ≈108px at three columns. The window borrows it through the existing
  `measureWidthShortfall` → `clampWidth` path and returns it on close, so no new mechanism
  is needed, but the open panel will be visibly wider on members with long lists. Worth
  judging from the screenshots before accepting.
- **Spells will all read 100%.** They cannot miss, so the column is uniform for casters and
  interesting only for melee. Accepted as the honest reading; if it turns out to be noise,
  the fix is a per-ability source flag from the parser, not a guess in the renderer.
- **No Pencil mockup for this one.** The convention is that UI redesigns get one, and this
  is an increment to an existing panel using a pattern already shipping in History — so the
  approval step is a screenshot of the real thing, driven headlessly, which shows the
  actual track widths a mock would only guess at. Say so if you would rather see a mock.
- **Not doing:** `max hit` per ability in the overlay. History has it and it is arguably as
  useful, but the overlay is the width-constrained surface and four value columns is what
  was asked for. Easy to add later if the width turns out to be free.

## Execution notes (2026-08-10)

- **`share` folded into `columns`.** The task said "plus the existing `value` and `share`",
  but share IS one of the four value columns in every view (`%dmg` / `%heal` / `%taken`),
  so keeping it as a separate accessor would have meant one fact described two ways.
  `setAbilities(list, {value, columns})`: `value` still stands apart because it is not a
  column — it feeds the bar, normalized to the member's largest ability.
- **The header-height arithmetic nets to what was already there.** Subtracting the caption
  from `nonList` and again from `available` (as the task described) is the same number as
  leaving both alone, because the caption sits on grid row 1 of *every* column and so costs
  its height exactly once. Written out explicitly anyway — the two subtractions say why.
- **A pre-existing bug found while verifying:** `#d-types` is `display: flex` and was being
  hidden with the `hidden` attribute, which `display: flex` overrides — so the taken view's
  resist chips stayed on screen under the damage and healing breakdowns. Same trap the
  stylesheet already documents for `#session-line`. Fixed here with one rule; it was
  corrupting the approval screenshots.
- **History's measured width cost:** the acc column takes 29px + 12px gap out of the
  ability-name track. At the default 1200px window nothing ellipsizes, but the track lands
  at 240px against a 240px longest name — on the edge. Below ~1000px the name column was
  already being crushed with or without it; at the 900px minimum it collapses entirely,
  which is pre-existing.
- **`resist` wording matches History** — `armor` for melee, the resist tag otherwise, an em
  dash for an unstated type — rather than the terser overlay-only alternative, on the same
  reasoning that put accuracy in both windows.
- The verification harness (stub preload + real renderer over `file://`) lives in
  `C:\eqoverlay-verify`; screenshots in `.verify/` (untracked).
