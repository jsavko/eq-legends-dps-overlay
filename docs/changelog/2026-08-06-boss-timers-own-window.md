# Boss timers get their own window

**Date:** 2026-08-06

## What was wrong, measured

The learned boss recast countdowns lived at the bottom of the alert window's single
vertical flow, under the interrupt banners and the crowd-control chips. The information
was right; the surface made it unreadable. Across the full live `eqlog_Rhale_oggok.txt`
session:

| | |
|---|---|
| Times a visible timer row was physically moved by a warning appearing or expiring above it | **524** |
| Samples where a timer was hidden by its own cast warning (the "promotion"), then returned | **10,525** |
| Timer chip runs seen | 129 — **67 under 15 seconds**, median life 14s |
| Same timer vanishing and re-arming within a minute | **72** (Nagafen's Lava Breath alone: 20) |

Three failure modes, all structural: the panel was **displaced** by every banner that
landed above it, it **blinked out** at the exact moment its spell fired (the old design
hid a timer whose cast was live as a warning), and it **reordered** because the list was
sorted by what was due next.

## The window

A dedicated `src/renderer/timers/` window — a framed panel of fixed slots inside a
transparent, click-through box, shaped after EverQuest's buff window and built against
the approved mockup A in `docs/design/2026-08-06-boss-timers-mockups.html`.

A **(caster, ability) pair claims a slot the first time it arms and holds that row for
the whole fight**:

- when the real cast lands, the slot says `CAST` and re-arms in place — the vanishing
  act is deleted;
- when a rhythm retracts, the row stays and shows `—`, never an invented number;
- when the caster dies, the row dims to `slain` rather than collapsing the panel and
  shoving the rows below it upward;
- rows are ordered by **when they were claimed**, never by what is due next.

Between fights the panel is *gone* — no empty frame, no placeholder rows. The window
still exists, transparent and click-through, so getting it back costs no gesture. The
one exception is while unlocked, where the drag placeholder always shows, because a
window with nothing in it cannot be positioned.

Placement is entirely its own (`timersBounds`, written only by its own `moved` handler
and read only at create time). It defaults to the right of the work area at ~40% height,
where players keep the buff window. It never derives its position from the meter's
bounds — the meter moves itself constantly, and deriving one window's placement from
another's live bounds is the "window climbs the screen" bug this codebase has already
fixed twice. What *is* shared is the gesture: one unlock makes the whole HUD draggable,
and Ctrl+Shift+H hides all of it together.

## Slot lifetime moved into the parser

`RhythmTracker.timers()` no longer returns live countdowns; it returns **slots**. Each
carries a `state` (`armed` / `lapsed` / `ended`), a stable `since` (when the slot was
claimed, and the sort key), and a `dueMs` that is `null` for anything that is not a live
prediction. Nothing is dropped mid-fight — `reset()` at encounter close drops all of it
at once.

Putting lifetime here rather than in the renderer keeps the honesty rules pure and
unit-testable in WSL: a lapsed prediction has no number to show, and that is now a fact
about the tracker's output rather than a convention a renderer has to remember.
`learned()` is untouched — a lapsed or ended row still exports its qualified rhythm.

## Category to window

`castTimers` is no longer an alert category. `ALERT_CATEGORIES` is back down to three
(interrupt warnings, summons, crowd control) so the alert window can never exist for a
surface it no longer draws, and `timersEnabled(cfg)` owns the new window on the same
one key. Mute still wins over both: a panel that survived `Control+Shift+A` would be the
one surface ignoring the hotkey. The config key keeps its name — that is what old
configs carry, and the pre-summon migration still forces it off.

## Verified

The shipping `src/renderer/timers/` files driven in headless Windows Chrome against real
parser snapshots replayed from the live log — the **Warlord Skarlon** fight (the 4-slot
worst case: Frost Shard, Ice Spear, Drowsy, Sicken) over 103 frames, and a **Lord
Nagafen** fight over 34:

| | Skarlon | Nagafen |
|---|---|---|
| Max slots | 4 | 3 |
| Rows that moved | **0** | **0** |
| DOM reorders | **0** (order only ever grew) | **0** |
| States exercised | armed, cast, lapsed, ended | armed, cast, lapsed, ended |
| Containers that overflowed | none | none |

Every one of the four Skarlon rows passed through `CAST` at its own unchanged pixel row;
`lapsed` and `ended` rendered `—` in every frame that produced them; the panel measured
296 × 145 at 1× and 533 × 260 at the settings' largest 1.8×, inside the 560 × 560 box.
Idle: panel hidden and zero slots in the DOM while locked, drag placeholder only while
unlocked. No console errors.

One real defect surfaced during that pass and was fixed: a row reading `CAST` beside a
sub-line saying "late · pattern broke" — two claims at once, one of them stale news. A
live cast now outranks the retracted prediction in the sub-line.

`npm test` — 331 passing (was 320).

## Files

- `src/parser/rhythm.js` — `timers()` returns held slots with `state`/`since`/nullable
  `dueMs`, sorted by claim order; `estimate()` factored out; `armedTs` on each entry.
- `src/main/config.js` — `timersBounds`; `castTimers` out of `ALERT_CATEGORIES`; new
  `TIMER_KEYS` and `timersEnabled()`.
- `src/main/main.js` — `createTimersWindow()`, `syncTimersWindow()`; the window joins the
  snapshot push, `broadcastConfig`, `applyLock`, `toggleVisible`; tray toggle moved below
  the category line.
- `src/renderer/timers/` — **new**: `index.html`, `timers.css`, `timers.js`,
  `preload.cjs`.
- `src/renderer/alerts/` — the timer half deleted: `#timers`, `renderTimers`,
  `buildTimerChip`, `timerChips`, the `.tchip` rules and the `castTimers` gate.
- `src/renderer/setup/index.html` — "Boss timers" is its own settings section, saying it
  is a separate, separately-placed window. `setup.js` is unchanged (same key, same id).
- `tests/rhythm.test.js`, `tests/config.test.js` — new cases for slot states, claim
  order, and the timers window's own switch.
- `CLAUDE.md` — the four-window layout, `src/renderer/timers/`, and the "a boss-timer row
  never moves" invariant.

## Known limits

- **No ability roster.** The panel fills in as abilities arm; it does not pre-populate
  slots for abilities the rhythm store already knows this boss has. That would make it a
  true fixture from the pull rather than something that fills in — deliberately left out,
  since it is additive and easier to judge now that the window exists.
- The warm ("from memory") slot styling was verified from real rows with the flag
  flipped: the extraction ran without a rhythm store, so no captured live frame carried
  one. The state renders correctly; its frequency in play is unmeasured.
- In-game hand check of the default placement and the drag-to-place gesture awaits the
  next session.
