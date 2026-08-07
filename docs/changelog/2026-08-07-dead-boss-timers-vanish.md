# A slain boss takes its timers with it

**Date:** 2026-08-07

## What changed

Killing a named boss now removes its countdown rows from the timers panel immediately.
Previously they survived as dimmed `ended` rows reading `slain` until the whole
encounter closed — so on a pull with adds still up, the panel kept showing recast
clocks for a corpse.

## Why the old behaviour existed, and why it was wrong

The timers window was built around one rule: **a row never moves.** It exists because
the timers used to live at the bottom of the alert stack, where a measured session
displaced them 524 times and hid them behind their own cast warning 10,525 times.
Holding a dead caster's slot followed from that rule — dropping a row shoves every row
below it up, which is the exact failure the window was built to prevent.

The reasoning was backwards in practice:

- A countdown for something that is already dead is a row you have to actively ignore
  for the rest of the pull. That is the same cost the no-move rule was protecting
  against, just paid differently.
- On the common single-boss fight, the "surviving rows" being protected are the same
  dead boss's *other* abilities. They go too, so nothing moves — the panel just empties.

On a genuine multi-caster pull the shift is real, and that is the accepted price. A dead
mob's recast clock is not information.

## Implementation

- **`src/parser/rhythm.js`** — `dropCaster()` marks its entries `dead` as well as
  nulling `lastTs`; `timers()` skips them outright. The entry stays in the map, because
  what the fight learned from that boss must still export when the encounter closes —
  the kill must not erase the rhythm it taught.
- The `'ended'` state is gone entirely, since nothing can reach it any more. Removed
  from the `timers()` state expression, from `detail()` in the renderer (the `slain`
  wording), and from the `[data-state="ended"]` rules in `timers.css`.
- **`CLAUDE.md`** — the no-move invariant now records death as its one exception, so
  the next person to read it does not "fix" this back.

## Files

- `src/parser/rhythm.js` — `dead` flag, the corpse check in `timers()`, state expression
- `src/parser/index.js` — comment in `handleDeath` corrected to match
- `src/renderer/timers/timers.js` — `detail()` loses the `slain` branch
- `src/renderer/timers/timers.css` — `ended` styling removed
- `tests/{rhythm,parser}.test.js` — 4 tests changed or added (354 total, was 351)

## Verified

- 354 tests passing. The dead-caster test now asserts an empty panel rather than a
  dimmed row, plus three new ones: killing one caster leaves the others armed (the
  survivors must not go quiet with the corpse), a single boss dying empties the panel
  while the encounter is still open, and the end-to-end path from a real
  `has been slain by` log line clears the timer while the fight continues.
- `learned()` still exports a dead caster's rhythm, pinned by the existing export test.
