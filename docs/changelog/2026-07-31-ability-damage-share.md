# Abilities now say what share of the member they are

**Date:** 2026-07-31

## The gap

The hover breakdown listed each ability's damage and its hit count, but the reader had to do
the division themselves:

```
Smiting Strike        252   2
Crush                 238   8/12
Smite                 102   2/3
```

252 damage is a fact about one ability; what a player actually wants to know is whether their
nuke rotation is carrying them or whether four fifths of their output is autoattack. That is a
percentage of their *own* total, and it was the one number the panel did not carry.

## The change

A percentage column sits between the damage figure and the hit detail:

```
Smiting Strike        252  35%   2
Crush                 238  33%   8/12
Smite                 102  14%   2/3
Blast of Frost (pet)   71  10%   1
Slash (pet)            54   7%   2/5
Cleave (pet)            4  <1%   1/2
```

- **The denominator is the member's own total, pet included** — the same total the panel's
  headline shows. Pet abilities are in the same list, so the full list sums to 100% for that
  member. Only the top six rows are displayed, so the *visible* rows usually sum to less; that
  is the slice, not a rounding error.
- **Healing mode gets it too.** `#d-abilities` is rendered by one shared `setAbilities()`, so
  the healing view shows each spell's share of what actually landed — consistent with the HPS
  figure above it, with overhealing still reported separately in the detail column.
- **Sub-1% prints `<1%`, not `0%`.** An ability worth 0.6% of a member's damage rounding to a
  bare `0%` beside a four-digit number reads as a bug rather than as "negligible". The first
  real encounter in the test fixture has exactly such a row.
- **A zero denominator prints an em dash.** The case that matters is a healer whose every point
  was overheal: `heals` is non-zero, `healing` is 0, and the column would otherwise read
  `NaN%` on every row.

The bar behind each row is unchanged and still normalized to the member's *largest* ability,
not to their total. Once a true percentage is printed beside it the bar's only job is relative
ranking, which best-normalization does better — a share-of-total fill would squeeze every bar
into the left third of the row whenever the top ability is only a fifth of a member's output.
The CSS comment that claimed the fill was already a share of the total has been corrected.

## Files

- `src/renderer/overlay/overlay.js` — new `formatShare()` formatter; `setAbilities()` takes a
  third `share` accessor and emits `<span class="a-pct">`; both `renderDamageDetail()` and
  `renderHealDetail()` pass a guarded denominator.
- `src/renderer/overlay/overlay.css` — `.a-pct` column (tabular, right-aligned, `min-width`
  so it does not jitter as a share crosses 9% → 10% → 100%); `.a-name` is now the only
  flexible column (`flex: 1 1 auto; min-width: 0`) so long names ellipsize instead of pushing
  the numbers off the panel; corrected fill comment.

Nothing changed in the parser: both inputs were already in the snapshot the renderer receives
4× a second, so this is pure view math — the same way the player/pet split is already derived.

## Verified

The real `overlay.js` and `overlay.css` were rendered in headless Chrome against a real
snapshot produced by running `tests/fixtures/combat-sample.log` through `LogParser`, with a
synthetic `mousemove` opening the panel through the actual hover path. Rendered inside iframes
at both **360px** (the default window width) and **240px** (`minWidth` from `main.js`):

- Damage shares matched the values computed independently from the snapshot — 34.8 / 32.8 /
  14.1 / 9.8 / 7.4 / 0.6 rendering as 35% / 33% / 14% / 10% / 7% / `<1%`.
- The all-overheal healer rendered `—` on every ability row.
- At 240px, `Celestial Elixir of the Ancients` ellipsized to `Celestial Elixir of t…` while the
  percentage column stayed whole — the name column is the only one that gives.
- `fitHeight()` settled at `110, 112, 307, 307, 307, …` across repeated pushes of the same
  snapshot: one growth as the panel opens, then constant. No resize feedback loop.

`npm test` — 134 passing, unchanged.
