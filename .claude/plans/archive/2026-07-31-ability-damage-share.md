---
status: completed
---
# Show each ability's share of the member's total in the hover breakdown

**Date:** 2026-07-31

---

## Goal

In the per-member hover breakdown (`#detail`), the ability list currently reads:

```
Crush                    18,420   84/91
Ancient: Chaos Strike     9,105   12
Crush (pet)               6,338   57/60
```

The raw damage number answers "how much", but not "how much of *this player's* damage" —
which is the question that actually drives play decisions (is my nuke rotation carrying me,
or is it 80% autoattack?). Add a percentage column so each ability row states its share of
that member's own total.

Scope:

- **Denominator is the member's own total**, not the group's — `row.damage`, which already
  includes their pet. So the full ability list sums to 100% for that member, and a pet row
  reads as its share of the owner's combined output. (Only the top 6 rows are displayed, so
  the *visible* rows will usually sum to less than 100%; that is expected.)
- **Healing mode gets the same treatment** — `#d-abilities` is rendered by one shared
  `setAbilities()` for both metrics, so the healing view should show each spell's share of
  the member's effective healing rather than being left inconsistent.
- Guard the degenerate denominators: a member with 0 damage, and — the real case — a healer
  whose every point was overheal, who has `healing === 0` but non-zero `casts`.
- Column must not push ability names out of the panel; names ellipsize already, but the new
  column costs width in a deliberately narrow overlay.

Out of scope: percentages on the `#d-sources` chips (melee/spell/dot/shield), and any change
to the main row list.

## Approaches Considered

### 1. Derive the percentage in the renderer, add a fourth column
- **Description:** `setAbilities()` already receives the whole `row`'s sibling data via its
  caller; pass a `share` accessor alongside the existing `value`/`detail` accessors, computed
  as `a.damage / row.damage` (or `a.healing / row.healing`). Render it into a new `.a-pct`
  span between `.a-dmg` and `.a-hits`.
- **Pros:** No IPC/snapshot change — both numbers are already in the payload, so this is pure
  view math and stays consistent with how `renderDamageDetail` already derives `petPct`
  locally. Damage and hit counts both survive. Symmetric across damage and healing by
  construction, since both go through the one helper.
- **Cons:** Adds a fourth flex column to a narrow panel, shortening the room ability names
  get before ellipsis.

### 2. Add a `share` field to each ability in `Encounter.snapshot()`
- **Description:** Compute `share` in `src/parser/encounter.js` when building the
  `abilities` / `healAbilities` arrays, and have the renderer just print it.
- **Pros:** Covered by the existing `tests/encounter.test.js` suite, so the arithmetic is
  unit-testable; any future consumer (an export, a summary line) gets it for free.
- **Cons:** Ships a field that is exactly `a.damage / row.damage` — data the renderer already
  holds — widening the snapshot for no information gain, and the snapshot is pushed at 4 Hz.
  The file's own convention is that `snapshot()` carries totals and the view derives ratios
  from them (`petPct`, `petFraction` are both computed renderer-side).

### 3. Replace the hits/casts column with the percentage
- **Description:** Swap `.a-hits` for the percentage instead of adding a column.
- **Pros:** Costs no width at all; the panel layout is untouched.
- **Cons:** Throws away the hits/misses detail (`84/91`) and the overheal detail
  (`12 casts · 340 over`), both of which are load-bearing — accuracy per ability and
  per-spell overhealing are why those columns exist. Trading one useful number for another
  is not what was asked for.

### 4. Put the percentage in the bar instead of as text
- **Description:** Leave the columns alone and re-scale the existing `::before` fill so its
  width *is* the share of the member's total, rather than being normalized to the top ability.
- **Pros:** Zero new markup; makes the fill mean what the CSS comment at `overlay.css:405`
  already (incorrectly) claims it means.
- **Cons:** Not a readable number — the user asked to *list* the percentage. It also flattens
  the chart: when the top ability is 30% of a member's damage, every bar sits in the left
  third of the row and the visual ranking that the current best-normalized fill gives is lost.

## Chosen Approach

**Approach 1** — derive in the renderer, add a `.a-pct` column.

It keeps the snapshot payload unchanged (it is pushed 4× a second), matches the file's
existing pattern of deriving ratios view-side, and preserves both the damage figure and the
hits/overheal detail. Approach 2's testability argument is weak for a single division whose
inputs are already asserted by the encounter tests; approaches 3 and 4 each drop information
the panel is there to provide.

Two supporting decisions:

- **Keep the bar normalized to the top ability.** Once a true percentage is printed beside it,
  the bar's job is purely relative ranking, which best-normalization does better. Fix the
  stale comment at `overlay.css:405` so it stops claiming otherwise.
- **Floor the display at `<1%`** rather than rounding sub-1% abilities to a bare `0%`, which
  reads as a bug next to a four-digit damage number.

## Tasks

- [x] Add a `formatShare(fraction)` helper to `src/renderer/overlay/overlay.js` in the
      formatting section: returns `'—'` for a non-finite/zero-denominator result, `'<1%'` for
      `0 < pct < 1`, and `` `${Math.round(pct)}%` `` otherwise.
- [x] Extend `setAbilities(list, { value, detail })` to accept a third accessor `share(a)`
      returning a 0–1 fraction, and render it into a new `<span class="a-pct">` inserted
      between `.a-dmg` and `.a-hits`.
- [x] In `renderDamageDetail()`, pass `share: (a) => (row.damage > 0 ? a.damage / row.damage : 0)`.
- [x] In `renderHealDetail()`, pass `share: (a) => (row.healing > 0 ? a.healing / row.healing : 0)`
      so an all-overheal healer renders `—` instead of `NaN%`.
- [x] Add `#d-abilities .a-pct` to `src/renderer/overlay/overlay.css` mirroring `.a-dmg`
      (`position: relative` so it sits above the `::before` fill, tabular numerals,
      `color: var(--ink-dim)`, right-aligned with a `min-width` of about `2.6em` so the
      column does not jitter between `9%` and `100%`).
- [x] Move `margin-left: auto` off `.a-dmg` if the three right-hand columns need it, and give
      `.a-name` `flex: 1 1 auto; min-width: 0` so it is the only column that shrinks and the
      numbers stay in a fixed stack.
- [x] Correct the misleading comment above `#d-abilities li::before` in `overlay.css:405` —
      the fill is normalized to the member's largest ability, not to their total.
- [x] Verify the panel still fits: hover a member with long ability names (e.g.
      `Ancient: Chaos Strike (pet)`) and confirm the name ellipsizes rather than the
      percentage wrapping or being clipped, and that `fitHeight()` still settles (no resize
      oscillation) with the taller/wider content.
- [x] Run `scripts/dev.sh test` (or `npm test`) to confirm the parser suite is untouched, then
      drive the UI with `npm run replay -- --write <file> --speed 4` against
      `tests/fixtures/combat-sample.log` and check both damage and healing (`Ctrl+Shift+M`)
      breakdowns.
- [x] Add `docs/changelog/2026-07-31-ability-damage-share.md` following the existing changelog
      entries in that folder.

## Notes

- `row.damage` includes pet damage, and pet abilities appear in the same list keyed
  `"<ability> (pet)"`, so shares across the *whole* list sum to 100%. The visible top-6 slice
  will not — that is correct, not a rounding bug.
- The healing denominator is **effective** healing (`row.healing`), consistent with `healShare`
  and the HPS figure. Overhealing stays reported separately in the `.a-hits` detail, so a spell
  can read `18%` of what landed while its detail shows most of it was overheal.
- `abilities` is already sorted by damage descending in `Encounter.snapshot()`, so the
  percentage column is monotonically decreasing down the list — no re-sort needed.
- Open question, deferred: whether `#d-sources` chips should get the same treatment. They are a
  smaller, fixed set (5 kinds) and are already easy to eyeball against the total, so leaving
  them as raw numbers keeps the panel from turning into a wall of percentages.

### How it was verified (execution notes)

The overlay has no automated renderer tests and the app is an Electron window on Windows, so
verification was done by rendering the **real** `overlay.js` / `overlay.css` in headless
Windows Chrome against a **real** parser snapshot:

1. A throwaway script fed `tests/fixtures/combat-sample.log` through `LogParser` and dumped the
   richest encounter's snapshot to JSON — real damage numbers, not hand-written ones.
2. A harness page (scratchpad only, nothing added to the repo) reproduced `index.html`'s DOM,
   stubbed the `window.api` preload bridge, pushed that snapshot, and dispatched a real
   `mousemove` over a row so the actual hover path opened the panel.
3. Because Chrome clamps a headless window to ~500px wide, the overlay was rendered inside
   iframes sized to the two widths that matter: **360px** (the default from `main.js`) and
   **240px** (`minWidth`, the narrowest a player can drag it).

Results:

- Damage view, `Rhale`: `Smiting Strike 252 35%`, `Crush 238 33%`, `Smite 102 14%`,
  `Blast of Frost (pet) 71 10%`, `Slash (pet) 54 7%`, `Cleave (pet) 4 <1%` — matching the
  shares computed independently from the snapshot (34.8 / 32.8 / 14.1 / 9.8 / 7.4 / 0.6).
  The `<1%` floor earned its place on the first real fixture encounter tried.
- Healing view: shares of effective healing, and the all-overheal healer renders `—` in every
  ability row rather than `NaN%`.
- At 240px the long name `Celestial Elixir of the Ancients` ellipsizes to
  `Celestial Elixir of t…` while the percentage column stays intact — the name is the only
  column that gives, as intended.
- `fitHeight()` settles: re-pushing the same snapshot five times (what the live 4 Hz feed does
  during a lull) produced `110, 112, 307, 307, 307, …` — one growth when the panel opens, then
  constant. No resize feedback loop.
- The live `replay --write` drive named in the task was replaced by the above. It would have
  required watching the real Electron window on the Windows desktop, which cannot be observed
  from here; rendering the real renderer against real parser output covers the same ground and
  is reproducible.
