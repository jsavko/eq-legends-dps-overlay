# The breakdown shows every ability, and takes the room to do it

**Date:** 2026-08-02

## The report, and what it actually was

"My DoTs — Stinging Swarm, Immolate — aren't being attributed to me." They were. The
parser was cleared first: fed the live 4.5 MB `eqlog_Rhale_oggok.txt`, all 85 self-DoT
ticks match `dot-tick-self`, resolve to Rhale, and land in the totals; other people's
DoTs attribute through `dot-tick` (424 ticks to Emalina, 243 to the warder). The damage
was in every number on screen — except the list the player actually reads.

The hover breakdown rendered `row.abilities.slice(0, 6)`. Sorted by damage, so on a
character with melee, a pet, procs and DoTs, the DoT rows fell past the cut and vanished
without a trace. Measured across all 346 member-rows in the log: median 7 abilities,
p90 13, max 19 — **53% of rows had abilities hidden**. Stinging Swarm ranked 7th–16th in
every encounter it appeared in: always credited, never shown. The same silent cut sat on
heal abilities (top 6) and heal targets (top 5).

## Every ability, no cap, and the window takes the room

The requirement was explicit: see everything, legibly — no top-N, no "+N more", no
ellipsis. The constraint is that this window cannot scroll (it ignores mouse input so the
game keeps every click), so whatever renders must have real screen pixels. Three layers:

1. **The slices are gone.** All three — damage abilities, heal abilities, heal targets.
   The list always holds every ability.
2. **On hover the window grows in BOTH dimensions, and gives it back on close.** The
   renderer measures how short the name columns are (`scrollWidth − clientWidth`) and
   main widens the window by exactly that; the height ceiling rises from 80% of the work
   area to 100% while the panel is open. Names that ellipsized even in the old six-row
   list — "Spirit of Blizzard Strike (pet)" never fit at 360px — now render whole.
3. **Columns before clipping.** If one column of rows would outgrow the screen, the list
   flows into two, then three, column-major so the ranking still reads downward
   (`breakdown.js`, pure and unit-tested). With the width already borrowed, the columns
   are readable, not a wall of ellipses.

## The geometry that had to not break

Auto-fit previously moved only height; now it moves width and x too, and that is exactly
the shape of the climb bug fixed on 2026-08-01 — deriving placement from current bounds
made every hover move the window and `remember` persisted the drift. So the resting/fitted
distinction got its horizontal twin: `restingX`/`restingWidth` beside `restingY`,
`lastFitX`/`lastFitWidth` beside `lastFitY`, `remember` persists only resting values, and
`placeWindow` anchors the right edge at the work area edge when growing left (the default
position hugs the right edge, so growing left is the common case). The renderer sends
measurements (`height`, `extraWidth`, `panelOpen`) and never bounds; width grows from the
current width while the panel is open — growing from resting would snap the window back
mid-hover the moment the shortfall reads zero — and everything returns to the resting
bounds on close.

`FIT_HEIGHT` is renamed `FIT_WINDOW` accordingly.

## Verified

The real renderer, driven in Chrome against the real parser snapshot of the encounter
where Rhale has 19 abilities (Immolate and Stinging Swarm among them), with main's clamps
simulated for a 1920×1040 work area:

| scale | window granted | cols | clipped names | detail | rows | body |
|---|---|---|---|---|---|---|
| 1.0× | 360 × 489 | 1 | none | 398/398 | 24/24 | 489/489 |
| 1.4× | 371 × 743 | 1 | none | 592/592 | 57/57 | 743/743 |
| 1.8× | 476 × 1021 | 1 | none | 753/753 | 149/149 | 1021/1021 |
| 1.8× on a 700px work area | 916 × 667 | 2 | none | 478/478 | 69/69 | 667/667 |

All 19 ability rows in the DOM and on screen in every case; `scrollHeight ===
clientHeight` for every container; the width negotiation converged in one round each
time.

`npm test` — 160 passing (was 144), including the new `tests/breakdown.test.js` and the
both-axes round-trip regression in `tests/layout.test.js`. The breakdown test suite
caught one real bug during development: `abilityColumns` returned `maxColumns` for a
single-item list that could not fit, three empty tracks squeezing the one name — the
column count is now floored by the item count.

## Files

- `src/renderer/overlay/breakdown.js` — **new**. `abilityColumns()`, the pure column
  arithmetic.
- `src/renderer/overlay/overlay.js` — slices deleted; `fitHeight()` →
  `fitWindow()` reporting `{height, extraWidth, panelOpen}`; `measureWidthShortfall()`;
  `layoutAbilityColumns()` with explicit column-major grid placement.
- `src/main/layout.js` — `clampHeight` gains `panelOpen` (80% resting / 100% open);
  `clampWidth` (floor: resting width, ceiling: work area); `placeWindow` places x as
  well as y.
- `src/main/main.js` — resting/lastFit tracking for x and width; the `FIT_WINDOW`
  handler; `remember` persists resting bounds only.
- `src/main/ipc.js`, `src/renderer/overlay/preload.cjs` — the `FIT_WINDOW` channel.
- `src/renderer/overlay/overlay.css` — `[data-cols]` column templates; the
  "bounded by construction: six ability rows" comment replaced by the real invariant.
- `tests/layout.test.js` — extended for both axes; `tests/breakdown.test.js` — **new**.

## Known limits

- The resting rows list (no panel open) is still capped at 80% of the work area and
  still clips past roughly twelve combatants at 1.8× on 1080p — unchanged by this work,
  needs its own answer.
- `handleUnattributed` discards a parsed ability name when crediting the "Unknown" row,
  and its 2s cast window can never match a DoT ticking at 6s — separate defect, noted in
  the plan, does not affect attribution of named DoT ticks.
- The in-game hand check of the width round trip (hover, leave, confirm config.json
  keeps the resting width) awaits the next play session; the geometry is pinned by unit
  tests and the harness verified the open/close messaging.
