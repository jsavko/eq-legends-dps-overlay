# The breakdown stops hiding things, and opens upward at the bottom of the screen

**Date:** 2026-08-01

## A scrollbar in this window is a lie

The overlay ignores mouse input so the game keeps every click. That means the wheel never
reaches it — so any container that scrolls is a container whose content is simply gone. The
breakdown had two.

**`#detail` was capped at `max-height: 15em`** against about 15.5em of natural content, with
`overflow-y: auto` to absorb the difference. Measured at three text sizes, hovering a member:

```
1.0x   detail 194/202   8px hidden
1.4x   detail 272/288  16px hidden
1.8x   detail 350/368  18px hidden
```

So the last ability row had been losing its lower edge at every size since the panel was
written — a sliver at 1×, obvious once the text was made large, and the scrollbar that
appeared to explain it could never be used. The cap is gone. The panel's height is bounded by
construction anyway (six ability rows, at most five chips, six stats), and `fitHeight()` grows
the window to whatever that comes to.

**The stats grid was three fixed columns.** At large text or minimum width three columns did
not fit, and `crits` and `share` lost their values off the right edge — no scrollbar, no
ellipsis, nothing to say they had gone. It is now `repeat(auto-fit, minmax(9em, 1fr))`, so it
drops to two columns and then one rather than overflowing. The floor is deliberately 9em of
`#d-stats`'s own `0.78em` font: a floor reckoned in the body's em is three quarters the size
intended and lets a fourth column in, changing the familiar default layout.

## Opening upward

Against the bottom of the screen there is no room to grow downward. The old code slid the
whole window up by the overflow, which had two problems:

- **The rows moved out from under the cursor.** Hovering a row slid every row up by the height
  of the panel, so the cursor ended up on a different member, or on none.
- **The window climbed the screen.** The new y was derived from the window's *current* y, so
  each open moved it up and closing never brought it back — and because `moved` fires for
  programmatic moves too, the climb was persisted as the player's own chosen position.

Now the window is anchored by its **bottom** edge when it is against the work area edge, and
the renderer draws the panel **between the header and the rows** (`data-panel="above"`). Those
two together are what hold the rows still: the top edge rises by exactly the panel's height,
and the panel fills that new space, so every row stays on the pixel it was on when the cursor
landed. Only the header moves, and nothing hovers the header.

Placement is always derived from `restingY` — where the player put the window — never from its
current position, so opening and closing returns it exactly where it started. `restingY` is
updated only by moves that were not ours, and it is `restingY` that gets persisted.

## Files

- `src/main/layout.js` — **new**. `clampHeight()` and `placeWindow()`, the geometry, kept free
  of Electron so it can be unit-tested. This is the arithmetic that looks obviously right until
  the window is near an edge, on a second monitor, or taller than the screen.
- `src/main/main.js` — `FIT_HEIGHT` uses the above and reports which side the panel opens on;
  `restingY` / `lastFitY` distinguish the player's moves from auto-fit's.
- `src/main/ipc.js`, `src/renderer/overlay/preload.cjs` — the `PANEL_SIDE` channel.
- `src/renderer/overlay/overlay.js` — applies it to `body[data-panel]`.
- `src/renderer/overlay/overlay.css` — the `max-height` cap removed, stats grid made
  responsive, and the above-the-rows ordering.
- `tests/layout.test.js` — **new**, 10 tests.

## Verified

Rendered the real renderer in headless Chrome against a real parser snapshot, measuring
`scrollHeight` against `clientHeight` for both scrollable containers at 1×, 1.4× and 1.8×, in
both metrics: no container clips at any size (`detail 202/202`, `288/288`, `368/368`).

For the anchoring, the closed and open windows were rendered bottom-aligned side by side with a
shared reference line on the first row: the line lands on the same row in both, with only the
header displaced.

`tests/layout.test.js` covers the geometry directly, including the climb regression — open,
close, and compare against the starting placement.

`npm test` — 144 passing.

## Known limit

A window taller than 80% of the work area is still clamped, and then the rows list scrolls
where it cannot be scrolled. That needs roughly twelve combatants at 1.8× text on a 1080p
screen (931px requested against an 832px ceiling); a full group of six at 1.8× asks for 715px
and is fine. Truncating the list with a "+N more" marker would close it properly.
