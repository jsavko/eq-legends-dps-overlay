---
status: completed
---
# The hover breakdown shows every ability, in full, and takes the room to do it

**Date:** 2026-08-02

---

## Goal

DoT spells — Immolate, Stinging Swarm — appear to be missing from the player's damage.
They are not. The parser credits them correctly; the hover breakdown throws them away
before they reach the DOM.

`src/renderer/overlay/overlay.js:286` renders `row.abilities.slice(0, 6)`. The list is
sorted by damage descending, so on a caster with melee, a pet, procs and several DoTs the
DoT rows fall past the cut and vanish with nothing on screen to say they were dropped.
The same cut is at `:318` for heal abilities and `:316` for heal targets.

Measured against the live log (`eqlog_Rhale_oggok.txt`, 346 rows across every encounter in
it):

```
damage abilities per row    median 7    p90 13    max 19
rows with more than 6                  183 / 346  (53%)
```

The worst row is Rhale's own, 19 abilities, and it is exactly the reported complaint:

```
      2349  Crush                     shown
      1152  Smiting Strike            shown
       387  Kick                      shown
       340  Blast of Frost (pet)      shown
       328  Spirit of Inferno (pet)   shown
       314  Slash (pet)               shown
    ------------------------------------------ slice(0, 6)
       254  Smite                     dropped
       211  Immolate                  dropped   <- the DoT
       161  Combust                   dropped
       158  Spirit Strike             dropped
       138  Ignite                    dropped
        ... 8 more, down to Shoot 2
```

**The point of the hover is to read the information.** So the requirement is not just that
every ability reaches the DOM — it is that hovering a member shows their complete breakdown,
legibly: every ability, every name in full, no cap, no "+N more", no ellipsis.

That means the window has to take the room it needs *in both dimensions* while the panel is
open, and give it back when the cursor leaves. Today it only grows **taller**, and only to
80% of the work area:

- `src/main/main.js:581` — "Only the height moves — width and position are the player's to
  choose". True while the panel showed six abilities; false the moment the panel has to
  show nineteen with readable names.
- `MAX_HEIGHT_FRACTION = 0.8` (`src/main/layout.js:10`) caps auto-fit at 80% of the work
  area. Past that the window stops growing and `#rows` clips instead.
- `.a-name` is `min-width: 0; overflow: hidden; text-overflow: ellipsis`
  (`overlay.css:468`), so long names are already being cut at the default ~340px —
  "Spirit of Inferno Strike (pet)" does not fit today even in the six rows that do show.

And the reason none of this can be papered over with a scrollbar is the one the 2026-08-01
change already established: **this window cannot scroll.** It ignores mouse input so the game
keeps every click, so the wheel never reaches it and clipped content is simply gone.

Height, estimated from the CSS (`13px * --scale` body, ability rows at `0.8em` ≈ 15.6px at
1×) and cross-checked against the three real measurements in the 2026-08-01 changelog
(`detail` 202 / 288 / 368px at six rows):

| scale | 19 ability rows | whole panel | + six-member rows list | 80% of 1080p work area |
|---|---|---|---|---|
| 1.0× | ~296px | ~404px | **~594px** | 832px — fits |
| 1.4× | ~414px | ~565px | **~831px** | 832px — exactly at the line |
| 1.8× | ~532px | ~726px | **~1068px** | 832px — over by ~236px |

## Approaches Considered

### 1. Delete the cap and nothing else
- **Description:** `row.abilities` with no `slice`. One line.
- **Pros:** Every ability reaches the DOM. Height is fine at 1× and 1.4×.
- **Cons:** Names still ellipsize, so half the point is missed. And at 1.8× the window asks
  for ~1068px against an 832px ceiling, so `clampHeight` refuses and `#rows` clips instead —
  the breakdown takes its rows out of the member list. Trades a visible truncation for an
  invisible one.

### 2. Grow taller only, up to the full work area
- **Description:** As above, plus `clampHeight` allows 100% of the work area while the panel
  is open.
- **Pros:** Solves the vertical overflow. The 80% rule exists so a raid-sized roster cannot
  permanently eat the display; a panel that closes with the cursor is not that.
- **Cons:** Does nothing about names, which is the legibility half of the complaint. And a
  1068px-tall, 340px-wide panel is a bad shape — a tall thin ribbon when the content is a
  table.

### 3. Grow wider *and* taller while the panel is open (chosen)
- **Description:** On hover the window takes the width the ability list actually needs — full
  names, no ellipsis — and the height the full list needs, up to the work area. Both revert
  the instant the cursor leaves.
- **Pros:** Every ability, every name, at any text size. Width is what makes multi-column a
  free fallback rather than a trade. The extra width also lets `#d-stats`
  (`repeat(auto-fit, minmax(9em, 1fr))`) go back to three columns at large text instead of
  stacking.
- **Cons:** The most machinery. Width and x now move on their own, which means the whole
  `restingY` / `lastFitY` apparatus that stopped the window climbing the screen needs a
  horizontal twin — and `remember` currently persists `x` and `width` unconditionally
  (`main.js:228`), so without that twin the overlay would creep sideways across the screen
  and save it as the player's own choice. That is a real bug waiting to be written.

### 4. A "+N more" remainder row
- **Pros:** Never overflows, never lies — the shares on screen sum to 100%.
- **Cons:** **Does not meet the requirement.** An accurate count of what you still cannot see
  is not seeing it.

### 5. Damage-share floor, or folding all pet abilities into one row
- **Pros:** Cuts 19 rows to ~11 without any layout work.
- **Cons:** Both hide things — the same objection as 4 — and folding pets undoes the
  2026-07-31 change that deliberately split "your Crush" from "your warder's Crush".

## Chosen Approach

**Approach 3.** While the breakdown is open the overlay stops being a fixed-width strip and
becomes a panel sized to its content, in both dimensions:

1. **Render the whole list, always.** `slice` is gone from all three call sites — damage
   abilities, heal abilities, heal targets. No count cap is introduced anywhere to replace
   it.
2. **Take the width.** The renderer measures how much the ability names are overflowing
   (`scrollWidth − clientWidth` on `.a-name`, which reports the full text width even while
   clipped) and asks for a window wide enough that the overflow is zero. Floor is the
   player's resting width — hovering never makes the overlay narrower — ceiling is the work
   area.
3. **Take the height.** The auto-fit ceiling rises from 80% of the work area to 100% while
   the panel is open.
4. **Only then, columns.** If the list still will not fit vertically, it flows into two then
   three columns. `ceil(n / cols)` guarantees some column count fits, and because step 2
   already took the width, the columns are readable rather than a wall of ellipses.
5. **Give it all back on close.** Width, x, y and height return to exactly the resting
   values — verified by test, because this is precisely where the last one broke.

The reversion in step 5 is the part that needs the most care. `restingY` / `lastFitY` exist
because deriving placement from the window's *current* position made it climb the screen a
panel-height per hover, and `remember` then persisted the climb. Width and x now have the
same exposure, so they get the same treatment: `restingWidth` / `restingX`, `lastFitWidth` /
`lastFitX`, and `remember` records the resting values, never the fitted ones.

Growing horizontally does not disturb the hover the way growing vertically did. Rows span the
full width, so a row that widens — in either direction — is still under the cursor that
opened it; only vertical movement can drop the cursor onto a different member, and the
existing bottom-anchor / `data-panel="above"` logic already handles that.

The trade being accepted deliberately: while the cursor rests on a row, the overlay covers
more of the game than it does now. That is the point — it is covering the game with the
numbers the player hovered to read, and it uncovers the moment they move away.

## Tasks

- [x] `src/renderer/overlay/overlay.js`: delete `slice(0, 6)` at `:286` (damage abilities),
      `slice(0, 6)` at `:318` (heal abilities) and `slice(0, 5)` at `:316` (heal targets).
- [x] `src/main/layout.js`: `clampHeight(height, area, { panelOpen = false } = {})` — 80% via
      `MAX_HEIGHT_FRACTION` when closed, 100% via a new `PANEL_HEIGHT_FRACTION` when open.
- [x] `src/main/layout.js`: add `clampWidth(width, area, { minWidth })` — never below the
      player's resting width or `MIN_WIDTH = 240`, never wider than the work area.
- [x] `src/main/layout.js`: extend `placeWindow` to return `{ x, y, above }`. Horizontal rule
      mirrors the vertical one — keep the left edge at `restingX` when the window fits, else
      anchor the **right** edge at the work area's right edge and grow leftward. Growing left
      is the common case, not the exception: the default position is `x = area.width - 380`
      (`main.js:167`), hard against the right edge.
- [x] `tests/layout.test.js`: extend for all of the above — `clampHeight` at both ceilings,
      `clampWidth` floors and ceilings, horizontal anchoring at the right edge, a window
      wider than the work area, and **the round-trip regression**: open the panel, close it,
      and assert the bounds equal the starting bounds exactly. That test is the horizontal
      twin of the existing climb regression and is the one that matters most.
- [x] `src/main/ipc.js`, `src/renderer/overlay/preload.cjs`: rename `FIT_HEIGHT` to
      `FIT_WINDOW` carrying `{ height, extraWidth, panelOpen }`. The renderer never names a
      width — it does not know the resting width, main does. `extraWidth` is the measured
      shortfall (`max(scrollWidth - clientWidth)` over `.a-name`, times the column count,
      since each column has its own `1fr` name track); main grows from the CURRENT width
      while the panel is open and restores the RESTING width when it closes. Growing from
      current is what stops the 4 Hz repaint from shrinking the window mid-hover the moment
      the deficit reads zero.
- [x] `src/renderer/overlay/overlay.js`: rename `fitHeight()` to `fitWindow()`; measure
      height as now, plus `extraWidth` when the panel is open. Keep the 3px dead band, and
      force a send when `panelOpen` flips even if the height is unchanged — the close
      message is what gives the width back.
- [x] `src/main/main.js`: add `restingWidth` / `restingX` beside `restingY`, and
      `lastFitWidth` / `lastFitX` beside `lastFitY`. The `FIT_WINDOW` handler clamps and
      places both axes; `remember` (`:216-230`) persists the **resting** width and x, never
      the fitted ones, and updates them only when the change was not ours.
- [x] Add `src/renderer/overlay/breakdown.js` with a pure
      `abilityColumns({ count, rowHeight, available, maxColumns = 3 })` returning the column
      count needed to fit — no `document` access, so `node --test` can import it.
- [x] Add `tests/breakdown.test.js`: one column when it fits, two when it does not, three at
      the extreme, `maxColumns` respected when even three will not fit (the function never
      reports a row count — the list is always rendered whole), one ability, zero abilities.
- [x] `src/renderer/overlay/overlay.css`: `#d-abilities` gains a `[data-cols]` attribute
      driving repeated four-track subgrid columns. `.a-name` keeps `min-width: 0` and its
      ellipsis as the last-resort behaviour — with the widening in place it should never
      actually trigger.
- [x] `src/renderer/overlay/overlay.js`: apply the column layout with explicit per-item
      `grid-row`/`grid-column` styles, column-major so the ranking reads down each column.
      Explicit placement is required — the stylesheet's `li { grid-column: 1 / -1 }` would
      otherwise stack every item into one column regardless of the attribute. The vertical
      budget for the column decision is `screen.availHeight`, already in the DOM, no new
      IPC.
- [x] Rewrite two comment blocks that this change makes false: the `#detail` block at
      `overlay.css:322-333` ("bounded by construction: six ability rows") and the
      `FIT_HEIGHT` block at `main.js:578-583` ("Only the height moves — width and position
      are the player's to choose").
- [x] Verify against the real log: feed `eqlog_Rhale_oggok.txt` through the parser and hover
      Rhale's 19-ability row at 1×, 1.4× and 1.8×. Confirm **all 19 rows are on screen with
      their names complete** at every size — no `.a-name` with `scrollWidth > clientWidth` —
      that Immolate and Stinging Swarm are among them, and that
      `scrollHeight === clientHeight` for both `#detail` and `#rows`.
- [x] Verify the round trip by hand as well as by test: note the bounds, hover several
      members in turn, move the cursor away, and confirm the window is back exactly where and
      what size it was — then check `config.json` was not rewritten with a fitted width.
- [x] `npm test` green.
- [x] `docs/changelog/2026-08-02-breakdown-shows-every-ability.md`.

## Notes

**The parser was cleared before any of this was planned.** Feeding the live 4.5 MB log
through `LogParser` and instrumenting `handleDamage`:

```
self dot ticks reaching handleDamage:      85
self dot ticks that credited nothing:       0
```

All 85 match the `dot-tick-self` rule (`rules.js:203`), resolve `You` to `Rhale`, and land in
`bySource.dot` and `byAbility`. Other people's DoTs attribute too — 424 ticks to Emalina, 243
to `Rhale`s warder`, 115 to Foalya, via `dot-tick`. The wording in the live log is exactly
what `rules.js` expects:

```
A ghoul scribe has taken 98 damage from your Immolate. (Critical)
A shin ghoul knight has taken 33 damage from Blood Siphon Strike by Emalina.
```

The one genuinely unattributed shape is `Gann has taken 10 damage by Poison.` (22 occurrences,
`dot-tick-unattributed`), which is a mob's DoT on a pet and not group damage. No rule changes
are needed.

**The height numbers in the Goal are estimates from the CSS**, anchored to the three real
measurements in the 2026-08-01 changelog. The verification task measures the real thing; if
1.4× is over the line rather than exactly on it, nothing about the approach changes — the
column fallback simply engages one size sooner.

**The danger in this change is the sideways twin of the climb bug.** `remember` at
`main.js:228` writes `x` and `width` straight from `getBounds()`. Auto-widening without the
resting/fitted distinction would move the window left on every hover, persist that as the
player's chosen position, and do it again on the next hover — the exact failure the vertical
work fixed on 2026-08-01, in the other axis. The round-trip test is not optional.

**Adjacent defect, deliberately out of scope.** `handleUnattributed` (`index.js:298`)
overwrites the parsed `source` and `ability` with `'spell'`/`'nonmelee'` and `'Unknown'`, so
a DoT tick that reaches that path loses its spell name even when the caster is identified —
and since `attributeNonMelee` only looks 2s back (`CAST_WINDOW_MS`) while DoTs tick 6s after
the cast, it never is. Worth its own plan; it does not affect the reported bug.

**Interaction with the known limit.** The 2026-08-01 changelog records that a window taller
than the ceiling makes `#rows` scroll where it cannot be scrolled, at roughly twelve
combatants at 1.8×. Raising the ceiling while the panel is open pushes that further away but
does not remove it — the rows list needs its own answer, which is separate work.

---

## Execution Notes (2026-08-02)

**Measured, not estimated.** The real renderer was driven in Chrome (devtools protocol)
against a real parser snapshot — the encounter from the live log where Rhale has 19
abilities including both Immolate and Stinging Swarm — simulating main's clamp responses
for a 1920x1040 work area:

| scale | window granted | cols | clipped names | detail | rows | body |
|---|---|---|---|---|---|---|
| 1.0x | 360 x 489 | 1 | none | 398/398 | 24/24 | 489/489 |
| 1.4x | 371 x 743 | 1 | none | 592/592 | 57/57 | 743/743 |
| 1.8x | 476 x 1021 | 1 | none | 753/753 | 149/149 | 1021/1021 |
| 1.8x, 700px work area | 916 x 667 | 2 | none | 478/478 | 69/69 | 667/667 |

All 19 abilities in the DOM and on screen in every case; no container clips anywhere.
The width negotiation converged in one round each time (11px extra at 1.4x, 116px at
1.8x; 440px for two columns on the small screen).

**Why Stinging Swarm specifically was invisible:** across the five encounters where
Rhale cast it, it ranked 7th–16th by damage — never inside the old top six.

**`abilityColumns` caps at the item count.** The unit test caught the function returning
3 columns for a 1-item list that could not fit: extra empty columns cannot shorten the
list, they only squeeze the name tracks, so `maxColumns` is floored by `count`.

**One estimate corrected:** the Goal's table put 1.4x "exactly at the line" (~831px);
measured, the whole window at 1.4x is 743px for this encounter. The estimates were
conservative; nothing about the approach changed.

**Left for a live session:** the by-hand round trip in the running game (hover several
members, confirm config.json keeps the resting width). The protocol underneath it is
covered — the harness verified open/close messaging and `tests/layout.test.js` pins the
resting-bounds round trip in both axes.
