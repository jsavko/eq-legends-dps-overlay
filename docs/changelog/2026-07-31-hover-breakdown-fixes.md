# Hover breakdown: reachable, and no longer covering the names

**Date:** 2026-07-31

## Two bugs

**The breakdown never opened in locked mode** — that is, in normal play. It was wired to
`pointerenter`. Under click-through, `setIgnoreMouseEvents(true, { forward: true })` is
documented as forwarding mouse moves so that "mouse related events such as mouseleave and
mouseover" keep working; the Pointer Events API is not part of that guarantee. In practice
nothing arrived at all: a mousemove counter wired into the overlay never incremented while
the cursor was dragged across a row. Switching to `mousemove` did not help either, so
forwarding is simply not delivering here.

**The panel covered the rows.** It was absolutely positioned against the bottom of the
window, and since the window auto-fits its content, it landed exactly on top of the member
names — so you could not move from one member to another without leaving the overlay
entirely and coming back.

## Fixes

- **Hover is driven by cursor polling from the main process.** `screen.getCursorScreenPoint()`
  at 16 Hz, sent to the renderer as window-relative coordinates, which hit-tests rows with
  `elementFromPoint`. This is strictly better than the forwarding approach it replaces: the
  window never has to take mouse events back to display the panel, so **the game keeps
  every click even while the breakdown is open**. DOM mouse events still drive hover in the
  unlocked state, where the window is ordinary.
- **The panel sits below the rows in normal flow** and the window grows to fit it, so every
  name stays visible and hoverable.
- **Auto-fit now runs in both lock states.** While it was suspended when unlocked, opening
  the panel inside a fixed-size window had nowhere to go and squeezed the rows to zero
  height. Height is data — rows, plus the panel when open — so the player controls width
  and position and height follows. Only width and position are persisted.
- Opening the panel near the bottom of the screen slides the window up instead of letting
  it overflow off-screen.
- `focusable: false` while locked is gone; it was not what blocked the events, and
  click-through already prevents focus theft.

## Verified

Driven against the running game with the cursor moved onto the second row: the window grew
from 132px to 321px, the breakdown showed that member (not the first), and all three member
names remained visible above it.
