# History gets its own window: three fixed panes, nothing ever reflows

**Date:** 2026-08-04

## What changed

The History **tab** in the settings window is gone. In its place: a dedicated
**History window** (tray → History…), 1200×780 by default, resizable, bounds
remembered. It implements the approved Pencil mock ("History Window", annotated by
the "History Redesign Notes" card) — the user's verdict on which was *"This is
perfect."*

The tab's failure mode was structural: accordion rows and nested `<details>` reflowed
the page on every click, the member drill-down needed a huge window, and 439 flat rows
made a specific fight hard to find. The new window inverts the interaction model:
**every click swaps content inside a fixed pane — nothing resizes, expands, or pushes
other content around.**

### The three panes

- **Left rail (300px):** search box, filter chips (All / Bosses / Deaths / Today),
  and the fight list grouped under day headers ("MON · AUG 3"), newest first. Rows
  show name + duration, time · zone, and a skull + count when someone died. Trash
  fights render dimmed; bosses bold. Footer counts the filter's effect
  ("442 encounters · filtered: 14").
- **Fight pane:** name, meta line (zone · date · duration · "ended by timeout"),
  deaths line, and a four-cell stat strip — DEALT / HEALED / TAKEN / DEATHS, each in
  its metric's color, with dps/hps/dtps units and "+N pet" on deaths.
- **Members + breakdown:** metric segments (Damage / Healing / Damage taken — the
  active one filled with ember / balm / wound), a members column with share bars, and
  the selected member's complete breakdown: abilities with damage/share/hits/crits/max
  for damage; heal abilities + healed-who for healing; HIT BY / WITH WHAT (resist
  tags in gold: FR/CR/MR…, "armor" for melee, "—" for untyped) / BY DAMAGE TYPE chips
  for taken. Every entry always — no top-N, the standing invariant.

The window wears the overlay's warm parchment palette, not the settings window's cool
slate: it is the overlay's record book, and it reads like it.

### Boss heuristic

Encounter labels are stored article-stripped, so "a froglok shin knight" is on disk
as "froglok shin knight" — an article test can never work. What survives stripping is
capitalization: named mobs keep their capitals. **Boss = label starts uppercase OR
durationMs ≥ 90s.** Pinned by tests.

### The reflow the harness caught

The deaths line under the fight header originally rendered only on fights where
someone died — so moving down the rail from a clean fight to a death fight pushed the
stat strip, members and breakdown down 23px. Exactly the class of bug this redesign
exists to kill, caught by the headless geometry assertion. The line now renders
always: faint "no deaths" on clean fights, and every pane sits on the same pixel for
every fight.

## Verified

The real renderer, driven headlessly in Windows Chrome against all 442 encounters
backfilled from the live `eqlog_Rhale_oggok.txt`, with `window.api` stubbed over the
real `EncounterStore` output. Fight selection (deaths ↔ no-deaths), member selection,
all three metrics, all four chips, search set/cleared, ↑/↓ keyboard — **zero
geometry deltas** across nine tracked pane rects for the whole battery. Screenshots
eyeballed against the mock for both the damage and taken views.

`npm test`: 211 passing, including the new `tests/history-organize.test.js`
(boss heuristic, each chip, search, day grouping, formatters).

## Files

- `src/renderer/history/organize.js` — **new**, pure: `isBoss`, `applyFilters`,
  `groupByDay`, shared formatters. Unit-tested in WSL like breakdown.js.
- `src/renderer/history/history.js` — **new**: all rendering + renderer-local
  selection state; strictly `replaceChildren` into fixed panes.
- `src/renderer/history/index.html`, `history.css` — **new**: the three-pane grid,
  warm palette, per-pane internal scrolling (fine here — only the OVERLAY may never
  scroll).
- `src/renderer/history/preload.cjs` — **new**: `historyList/historyGet/historyClear`.
- `src/main/main.js` — `createHistory()` (focus-if-open, debounced bounds persist);
  tray History… repointed; `createSetup` loses its tab parameter.
- `src/main/config.js` — `historyBounds: null` default.
- `src/main/ipc.js` — comment only; the history channels are unchanged.
- `src/renderer/setup/*` — the History tab removed wholesale: tabs nav, history
  section, ~400 lines of fight-list/detail code and styles, history API out of the
  preload. The settings window is just a form again.
- `tests/history-organize.test.js` — **new**.

## Notes

- IPC needed no changes: the existing three history channels carry everything; the
  API simply moved from the setup preload to the new window's preload.
- A very long deaths list (raid wipe) can wrap the deaths line to a second row and
  shift the panes for that fight — accepted: reserving one line covers the normal
  case, and hiding deaths behind an ellipsis would hide data.
