# Percentages on the player/pet split line

**Date:** 2026-08-06

## What changed

The hover breakdown's split line now states the percentages it was only drawing. The
legend used to read `player 143,022` / `pet 61,552` under a two-tone bar; the actual
proportion required eyeballing the bar or doing the division. It now reads
`player 143,022 · 70%` / `pet 61,552 · 30%` — same `·` separator idiom the panel
already uses (`dmg · dps`, `17 · FR`) — in all three metric views: damage, healing,
damage taken.

The history window is untouched: it has no player/pet totals line (pets are tagged
inline in its ability lists), so there was nothing to change.

## How

All three call sites built identical label strings, so the wording moved into
`setSplit()` itself: it now takes the raw player and pet values and owns the labels,
the bar widths, and the percentages. The arithmetic is a pure helper,
`splitShares(playerValue, petValue)` in `breakdown.js`, unit-tested in WSL like the
rest of that file. Two decisions worth recording:

- **Complementary rounding.** Pet gets `Math.round`, player gets `100 − petPct`.
  Rounding each side independently can print a pair that sums to 99 or 101, and a
  split line that does not sum to 100 reads as damage gone missing — the exact
  impression the breakdown exists to prevent.
- **Zero total → no percentages.** A taken-view row can render with nothing taken,
  visible only because someone died. `splitShares` returns null there and the legend
  falls back to plain `player 0` / `pet 0` — never a made-up `player 0 · 100%`.
  Honest numbers over guessed ones.

## Verified

- `npm test`: 287 passing (was 282; five new `splitShares` cases — normal split,
  complementary-rounding pairs, zero total, petless and pet-only extremes).
- Headless check against the real log: replayed `eqlog_Rhale_oggok.txt`, kept the
  snapshot with the richest pet split ("imp protector" encounter), drove the real
  renderer in Windows headless Chrome with `window.api` stubbed, hovered Rhale's row.
  All three views rendered label and bar in agreement:
  damage `player 34,577 · 73%` / `pet 12,833 · 27%`, healing `player 7,601 · 92%` /
  `pet 700 · 8%`, taken `player 13,153 · 70%` / `pet 5,505 · 30%`. A synthetic
  death-only taken row (zero taken) rendered plain `player 0` / `pet 0` with no
  percentage.
- New dist cut at 0.5.4 and the win-unpacked exe relaunched.

## Files

- `src/renderer/overlay/breakdown.js` — new `splitShares()` pure helper.
- `src/renderer/overlay/overlay.js` — `setSplit(playerValue, petValue)` owns the
  legend wording; the three per-metric call sites collapsed to one line each.
- `tests/breakdown.test.js` — five new cases for `splitShares`.
