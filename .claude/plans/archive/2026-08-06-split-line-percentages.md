---
status: completed
---
# Percentages on the player/pet split line

**Date:** 2026-08-06

---

## Goal

The overlay's hover breakdown has a split line under the header: a two-tone bar plus a
legend reading `player 143,022` / `pet 61,552`. The bar shows the proportion visually,
but the actual percentages are nowhere — you have to eyeball the bar or do the division
yourself. Add the percentage to each legend label, e.g. `player 143,022 · 70%` and
`pet 61,552 · 30%`, in all three metric views (damage, healing, damage taken).

Scope is the overlay only: the history window has no player/pet totals line (it tags
pet abilities inline instead), so there is nothing to change there.

Where the code lives today (`src/renderer/overlay/overlay.js`):
- `renderDamageDetail` (line ~334), `renderHealDetail` (~372), `renderTakenDetail`
  (~405) each compute `petPct` and call `setSplit(petPct, selfLabel, petLabel)` with
  hand-built label strings — structurally identical at all three sites.
- `setSplit` (line ~465) sets the two bar widths and the two legend label texts.

## Approaches Considered

### 1. Append the % at each call site
- **Description:** Each renderer already computes `petPct`; extend its two template
  strings with the percentage.
- **Pros:** Smallest possible diff; no signature changes.
- **Cons:** The same formatting + rounding logic pasted three times; each site must
  independently handle the zero-total case and complementary rounding, and they'll
  drift.

### 2. Centralize in `setSplit` — pass raw values (chosen)
- **Description:** Change `setSplit` to take the raw player and pet values
  (`setSplit(row.playerDamage, row.petDamage)`), and have it compute the fraction, the
  bar widths, and both labels (the `player` / `pet` prefixes are identical across all
  three views). Percent math goes in a tiny pure helper in `breakdown.js` so it's
  unit-testable in WSL.
- **Pros:** One owner for the logic; the three call sites shrink to one line each;
  complementary rounding (player% = 100 − round(pet%)) guarantees the pair sums to
  100; the zero-total guard lives in exactly one place; the pure part gets a real test
  alongside the existing `breakdown.test.js` cases.
- **Cons:** Touches a working function's signature — slightly more churn than option 1.

### 3. Separate percent elements in the legend
- **Description:** Add `#d-self-pct` / `#d-pet-pct` spans to `index.html` and style
  them dimmer than the totals.
- **Pros:** Fine-grained styling control over the percent text.
- **Cons:** Markup + CSS churn for what is just text; more elements for the fit-window
  measurement to track; the existing legend idiom is a single text span per side.

## Chosen Approach

**Approach 2.** All three call sites are structurally identical, so the label building
belongs in `setSplit`, and the percent arithmetic (complementary rounding, zero-total)
is exactly the kind of pure logic this project keeps in `breakdown.js` under test.
Formatting uses the codebase's existing `·` separator idiom (`dmg · dps`, `17 · FR`):
`player 143,022 · 70%` / `pet 61,552 · 30%`.

Edge cases pinned by the helper's tests:
- **Zero total** (a taken-view row can render with 0 damage taken when it's shown for a
  death): no percentages — plain `player 0` / `pet 0`, never `player 0 · 100%`.
- **Rounding:** pet% = `Math.round`, player% = `100 − pet%`, so the pair always sums
  to 100 (no 66% + 33% lines).
- **Pet = 0:** `pet 0 · 0%` — shown, consistent, honest.

## Tasks

- [x] Add a pure `splitShares(playerValue, petValue)` helper to
      `src/renderer/overlay/breakdown.js` returning `{ playerPct, petPct }` or `null`
      when the total is 0, with complementary rounding
- [x] Add cases to `tests/breakdown.test.js`: normal split sums to 100, rounding pair
      (e.g. 2/3–1/3) sums to 100, zero total → null, pet 0 → 0%
- [x] Rework `setSplit` in `src/renderer/overlay/overlay.js` to take
      `(playerValue, petValue)`, build both labels (totals + `· N%` when shares exist),
      and set the bar widths from the same fraction
- [x] Collapse the three call sites in `renderDamageDetail`, `renderHealDetail`,
      `renderTakenDetail` to pass raw values
- [x] `npm test` in WSL
- [x] Headless renderer check: replay the live log into a snapshot, drive the overlay
      in headless Chrome, hover a pet-class row (Rhale) and confirm the legend reads
      `player N · X% / pet N · Y%` in all three metrics
- [x] Quit the overlay, `scripts/dev.sh dist`, relaunch win-unpacked (0.5.4)
- [x] Changelog: `docs/changelog/2026-08-06-split-line-percentages.md`

## Notes

- The legend labels stay single text spans — the percent inherits the existing label
  styling, no CSS change needed. If the user later wants the percent visually dimmer,
  that's approach 3's markup as a follow-up.
- `setSplit` currently receives pre-built strings; after this change it owns the
  wording. All three views use the same `player` / `pet` prefixes today, so nothing is
  lost.
- History window deliberately untouched: it has no equivalent totals line, and its
  member pane's share column already answers a different question.
