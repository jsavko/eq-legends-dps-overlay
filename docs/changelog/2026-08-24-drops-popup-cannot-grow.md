# The drops popup could not grow past the size it was parked at

**Date:** 2026-08-24

Reported: the popup does not resize to make room for its items, and unlocking and
relocking the window is what forces it to show what you were after.

---

## What was happening

The popup's window is **parked** off-screen at 64×64 whenever nothing is owed — parked
rather than hidden, deliberately, because Electron throttles a hidden window's renderer
and the `ResizeObserver` that notices there is something to draw again would never fire.
That part works and is not the bug.

The bug is what the renderer measures while it is parked.

`body` is a full-height flex **column** — that is how the panel bottom-anchors into the
screen corner. So `#panel` is a flex item, and a flex item's automatic minimum size, the
thing that normally stops it being squashed below its own content, **resolves to zero the
moment the item has `overflow` other than `visible`**. `#panel` has `overflow: hidden`,
for its rounded corners.

So inside the 64×64 parked box the panel was compressed to 64px, `getBoundingClientRect()`
reported 64px, and `reportFit` asked main for the size the window already had. Main
obliged by changing nothing. The popup could never grow past its parked height for the
rest of the session.

Measured at the parked size, before the fix:

```
panel scrollHeight / clientHeight:  219 / 62      ← content clipped to the cage
reportFit → main:                   401 × 64      ← the size it already was
```

**This is not a regression from today's earlier work — it shipped with the popup in
`2fbc80e` this morning.** `height: 100%`, the column flex and the missing `flex: none`
are all in that commit. It was invisible because a one-item panel is about 68px tall and
the parked window is 64, near enough that the clipping never showed. Today's taller
panels — larger item type, and four bee groups on an island-6 pull instead of one boss
row — made it obvious.

**Why unlock/relock worked around it.** Unlocking makes `#placeholder` visible, which
grows the measured extent past the cage and gets one honest report through; main resizes
to that, and from a larger window the panel is no longer squashed.

## The fix

`flex: none` on `#panel` and `#placeholder`, with the reasoning written down beside it.
One line each, no geometry code, nothing in main.

The content then overflows the **top** edge for one frame before main resizes — which is
exactly why `reportFit` measures the min/max *extent* of the body's children rather than
`rect.bottom`. A negative `top` still yields the right height, and that comment was
already in the file for an unrelated reason. It earns its keep twice now.

## Changes

### Bug fixes
- **`src/renderer/drops/drops.css`** — `#panel` and `#placeholder` are no longer
  shrinkable flex items, so the renderer measures its content instead of its cage and
  the window can grow to fit.

### Files modified
| File | What |
|---|---|
| `src/renderer/drops/drops.css` | `flex: none` on `#panel` and `#placeholder`, and the paragraph explaining why |

## Verification

- `npm test` — 966 pass, 0 fail (CSS only; the suite is a regression check, not a proof).
- **A probe at the real parked size.** The real `drops.js` and `drops.css` loaded in
  headless Chrome with the viewport emulated to 64×64 (headless will not size a *window*
  that small), fed a payload built from the live ledger, with main's own feedback loop
  closed — every `fit` report resizes the viewport the way `applyPanelFit` would:

  | step | before the fix | after |
  |---|---|---|
  | 4 groups delivered | `401×64`, clipped 219→62 | `401×222`, `scrollH === clientH` |
  | shrink to 1 group | — | `401×86` |
  | nothing owed | — | `0×0` → parked 64×64 |
  | 4 groups again | — | `401×222` |

  The regrow step is the one that matters: the old code was a one-way door, and the
  window that had been parked once stayed one line tall.

- **The packed build, on the real window.** `scripts/dev.sh pack`, then over
  `--remote-debugging-port=9223`: the drops window cleared to nothing parked at
  `-32000,-32000 64×64`, and on being given a real payload's DOM came back at
  `1793,1147 401×222` with `scrollHeight === clientHeight` and nothing clipped. Read
  with `GetWindowRect` through `EnumWindows`, not from Electron's own view of itself.

## Not done

The same shape does not exist elsewhere. The timer boxes measure and report themselves
the same way but their `body` is not a constrained flex column — it is `width:
max-content` with no height constraint at all — so their content is never squashed. The
alerts window does not fit at all; it buys the same guarantee with a generously
oversized invisible box. Checked rather than assumed.
