# Timer boxes: width, row height and text size, per box

**Date:** 2026-08-22

A timer box was one shape for everybody — 296px wide, a 30px row, 13px text, the boss
panel's chrome inherited by every box the player made. That was right when there was one
panel. It stopped being right the moment a player could run several boxes at once for
different jobs: a boss box wants to be wide and legible across the room, a buff box
tucked beside the health bar wants to be narrow with tight rows, and neither of them
wants to be the other.

Width, row height and text size are now **properties of a box**, set in the Timers window
beside its name and its position, stored in `timers.json` with everything else about it,
and applied while the slider is still moving.

## What it looks like

Three sliders under the box title, with a live pixel readout down the right and a
`Reset to default` beside them. Drawn for every box, the built-in boss box included: its
ROWS come from the trigger packs, but its shape is the player's exactly as its name, its
position and its switch already are.

Two decisions the strip is built around:

- **It is never hidden and never changes height.** The pane has to sit on the same pixel
  whichever box is selected — the Timers window's no-reflow rule, the same one the History
  window exists to keep — so the strip renders for the built-in box too, and the note line
  under it keeps its line box when it has nothing to say. Verified in the running app: the
  strip's top and height are identical (133px, 129px) for all three boxes.
- **Dragging a slider puts the box on screen.** A box with nothing running draws nothing
  at all — the window shrinks to nothing and parks itself off-screen — so sizing one
  between pulls would otherwise be done blind. The first slider movement raises the same
  preview row `Show me this box` raises, and the box changes under the cursor as the
  slider moves. That is the entire reason these controls are inline rather than behind a
  modal: the question being answered is "does this cover my health bar", and only the box
  itself can answer it.

`Copy size from…` takes another box's three numbers wholesale. Matching two boxes by eye
means dragging three sliders to numbers you cannot read off the other one, which is a
thing people try and quietly fail at. It lists every box but the one being sized, and
snaps back to the prompt after it fires — it is an action, not a link between two boxes.

## Why three numbers rather than one

A single per-box multiplier was considered and rejected: "wide box, tight rows" and
"narrow box, big text" are both real layouts and one scale can express neither. Row height
and text size therefore stay independent, and when the rows go shorter than the text the
strip *says so* — `The rows are shorter than the text — names will be clipped.` — rather
than overriding a number somebody has just dragged to. The row clips; it does not scroll,
because a click-through box never scrolls anywhere.

## Why per box rather than in settings

Three global keys would have been a smaller diff and would have forced every box to one
shape, which is the thing being complained about. A global default with per-box overrides
would have put two screens in charge of one box's size — the shape of failure that removed
the ALERTS and BOSS TIMERS sections from the settings form, where a pack could be enabled
while its surface was off with neither screen saying so. Size lives in one place, next to
the box's name, its colour-bearing timers and its position.

## The arithmetic, and where it lives

`boxLook(category, scale)` in `src/timers/model.js` is the whole of it: the stored value
times the global text `scale`, clamped, rounded. **Multiplication rather than
replacement** — `scale` moves every HUD window together and always has, so a per-box width
rides on it rather than arguing with it. The defaults, 296 / 30 / 13, are exactly what the
old em-based chrome computed to (22.77em × 13px = 296.0, 2.31em × 13px = 30.03), so a
player who never opens these controls sees the panel they already know rather than
something close to it.

It is computed in main and pushed to the box **with its rows**, the way a box's name
already travelled, so a resize never rebuilds the window — a rebuild would drop the box
back to its default corner, which is the same reason a rename does not rebuild it either.
The box renderer went one step *dumber* as a result: it no longer reads the global scale
itself, so its preload lost its config channels, and one number now arrives one way
instead of two halves of a size arriving on two channels and having to agree.

## The one non-obvious edit

`.row .body` was `22.77em` — a literal, deliberately, because the masked duplicate text
layer must be given the row's full width so that narrowing the mask *crops* it rather than
re-wrapping it. Left as a literal while the box width became a variable, the two text
layers would have said different things at every width but the default. It now tracks
`--box-width`. Verified in the running app at 370px: both layers measure 370px, the mask
311px, and the text in the two is identical.

## Verified in the running app

Not by replay. The packed build was relaunched with `--remote-debugging-port=9223` and
driven over CDP:

- a box saved at 296 / 23 / 11 with the global scale at 1.25 arrives in its window as
  `--box-width: 365px`, `--row-height: 29px`, `--box-font: 13.75px`, and a second box at
  different numbers arrives at its own;
- a preview row at 370 / 38 / 16.25 renders with both text layers at 370px and the mask at
  the drained fraction;
- the strip sits at the same top and the same height for the built-in box and the player's
  own;
- `Copy size from…` moved one box to another's 296 / 21 / 11 and returned to its prompt;
- the clipping note fires when the rows go under the text.

932 tests pass.

## Files

| File | Change |
|---|---|
| `src/timers/model.js` | `LOOK` (the three ranges and defaults), `clampLook`, the pure `boxLook`, the three fields on every category, and `updateCategory` re-normalizing so a slider cannot write past the clamps |
| `src/main/main.js` | `lookPatch` (a whitelist, so a patch from a renderer cannot move a box or unmake the built-in one), the look in the `TIMERS_PUSH` payload, `LOOK` sent with `TIMERS_GET` so the sliders and the model share one set of limits, and a re-push when the global scale changes |
| `src/renderer/timerbox/box.js` | `applyLook` writes `--box-width` / `--row-height` / `--box-font`; the config wiring is gone |
| `src/renderer/timerbox/box.css` | those three as variables with the shipped chrome as fallbacks, `.row .body` tracking the box width |
| `src/renderer/timerbox/preload.cjs` | no config channels — a box is told its size |
| `src/renderer/timersetup/index.html` | the size strip: three sliders, readouts, the copy-from control, the reset |
| `src/renderer/timersetup/timersetup.css` | the strip's fixed three-column grid, an explicitly styled range control (the platform default reads as disabled on this palette) |
| `src/renderer/timersetup/timersetup.js` | render, wire, throttle-with-trailing save, auto-preview, copy-from, the clipping note |
| `tests/timers.test.js` | defaults are the shipped chrome, hand-edits are clamped, a resize leaves position and timers alone, `boxLook` multiplies |
| `tests/timers-window.test.js` | new: the Timers window's markup and script checked against each other, and against `LOOK` — the slider ids are built from the model's field names, so a rename there breaks three controls at once |
| `tests/preload-channels.test.js` | the list said `timers`, a directory that does not exist, so both timer preloads went unchecked; now `timerbox` and `timersetup` |
| `CLAUDE.md` | a box's size is the player's; `.row .body` must track the box width |
