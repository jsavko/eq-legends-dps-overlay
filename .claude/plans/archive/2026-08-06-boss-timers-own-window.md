---
status: completed
---
# Boss timers get their own window

**Date:** 2026-08-06

---

## Goal

The learned boss recast timers currently live at the bottom of the alert window's single
vertical flow, below the interrupt banners and the crowd-control chips. In practice they
are unreadable, and the live log says exactly why:

| Measured over the full `eqlog_Rhale_oggok.txt` session | |
|---|---|
| Times a visible timer row was physically moved by a warning appearing/expiring above it | **524** |
| Samples where a timer was hidden by its own cast warning (the "promotion"), then returned | **10,525** |
| Timer chip runs seen | 129 — **67 of them under 15 seconds**, median life 14s |
| Same timer vanishing and re-arming within a minute | **72** (Nagafen's Lava Breath alone: 20) |
| Share of fight time with any timer up | ~3% |

A countdown that jumps 64px down the screen when a banner lands, blinks out at the exact
moment its spell fires, and lives a median of fourteen seconds is not a countdown anyone
can use. The information is right — the surface is wrong.

Move the timers out of the alert stack and into their own window: a framed, draggable
panel shaped like EverQuest's buff window, where a boss ability claims a slot and **keeps
that slot for the whole fight** — through the cast, through a retraction, through every
banner that lands above it. Nothing reorders, nothing blinks, and a row you learned to
glance at stays where you learned it.

Mockups (1:1, shipping palette): `docs/design/2026-08-06-boss-timers-mockups.html`

## Approaches Considered

### 1. Reserve a fixed block for timers inside the alert window
- **Description:** Keep the current window; give `#timers` a fixed height and absolute
  position at the bottom of the box so the warning stack above can never push it.
- **Pros:** Smallest change by far — a CSS edit and a slot map in `alerts.js`. No new
  window, no new config key, no migration.
- **Cons:** Solves displacement and nothing else. The panel is still anchored to
  top-centre, which is where a *banner* belongs and not where a fixture belongs; still
  invisible when empty, so it cannot be placed independently; still one window's worth of
  bounds for two jobs with opposite placement needs. The player asked for its own area,
  and this gives it a corner of somebody else's.

### 2. New timers window, buff-window slots — **chosen**
- **Description:** A new `src/renderer/timers/` window with its own bounds, lock and
  toggle. A framed panel, top-anchored inside a transparent click-through box. Each
  (boss, ability) pair claims a slot on first arming and holds it until the encounter
  ends; the row *is* the drain bar, the same idea the meter is built on. States: armed,
  warm (from memory), due, **CAST** (the real line landed — the slot says so instead of
  vanishing), lapsed (pattern broke — dim, "—", never a number).
- **Pros:** Kills all three failure modes at once — no displacement (own window), no
  blinking (slots persist through cast and retraction), no reordering (first-armed order,
  not sorted by what's next). Placeable where EQ players already keep the buff window.
  Visible when empty while unlocked, so it can be found and dragged. The measured ceiling
  makes it cheap: **max 4 distinct timed abilities in any single fight** across the whole
  session (median 1), so a generous fixed box needs none of the overlay's fit/resize
  machinery.
- **Cons:** A fourth window to wire (create, sync, broadcast, lock, hide-with-HUD), a new
  config key, and the alert-window plumbing has to give `castTimers` up cleanly.

### 3. New timers window, caster sections
- **Description:** Same window, different layout: a header per engaged named mob with its
  abilities as bars beneath it.
- **Pros:** "Whose timer is this" is unmissable; reads well with two bosses up.
- **Cons:** Costs a header row per caster in a panel that is usually showing *one* timer
  (31 of 47 timer-fights had exactly one), and the panel's height changes as casters
  engage and die — reintroducing movement, which is the thing being fixed.

### 4. New timers window, minimal frameless ticker
- **Description:** No frame, no header — bars over the game, nearest-due enlarged.
- **Pros:** Cheapest to build, least screen taken.
- **Cons:** Invisible when empty (nothing to drag), drops the caster name, and being
  sorted by what's next it reorders exactly as often as today's version does. It is the
  current design in a different place.

### 5. Fold the timers into the overlay slab
- **Description:** A pinned timers section under the meter's rows.
- **Cons:** Breaks the overlay's own contract — that window auto-fits to its rows and
  bottom-anchors near the screen edge, so timers riding along would move with every roster
  change and every hover-panel open. It also forces the timers to live wherever the meter
  lives, which is the opposite of giving them their own area.

## Chosen Approach

**Approach 2 — a dedicated timers window with fixed, fight-long slots.**

It is the only option that fixes all three measured failures rather than one, and the
per-fight slot ceiling (4 observed, ever) makes it structurally simple: a transparent,
generously-sized box with a top-anchored framed panel inside, so a slot appearing or
leaving never moves the slots above it and no window-resize machinery is needed. The
`alertsBounds`-style remember is enough; no `FIT_WINDOW` round-trip, no `layout.js`.

Slot lifetime moves into the parser rather than the renderer: `RhythmTracker.timers()`
gains a `state` and a stable `since`, keeps lapsed entries instead of dropping them, and
returns them in first-armed order. That keeps the honesty rules ("a lapsed prediction
shows a dash, never a number") pure and unit-testable in WSL, and leaves the renderer to
do nothing but paint.

Fixed placement rules for the new window, mirroring what the mockups show:
- Content is **top-anchored** — new slots grow downward, existing rows never move.
- Slots are keyed by `caster|ability`, claimed in first-armed order, **held for the whole
  fight** (including for a caster that dies mid-fight — its row dims rather than
  collapsing the panel).
- A slot whose cast is live as a warning shows `CAST` for the warning's life and re-arms
  in place. The old behaviour of hiding it is deleted.
- **Idle means gone.** With no fight and no armed rhythm the panel paints *nothing* — not
  an empty frame, not placeholder rows. The window still exists (transparent and
  click-through) so it costs no gesture to get back; there is simply nothing on screen.
  The one exception is while unlocked, where the drag placeholder always shows, because a
  window with nothing in it cannot be positioned.

**Placement is fully independent of the meter.** The timers window is its own
`BrowserWindow` with its own `timersBounds` key, dragged and remembered on its own; the
meter keeps `bounds`, the alert window keeps `alertsBounds`, and none of the three reads
another's geometry. In particular the timers window must never derive its placement from
the overlay's *current* bounds — the meter moves itself constantly (auto-fit to its rows,
bottom-anchoring near the screen edge, widening while a hover breakdown is open), and
deriving one window's position from another's live bounds is the "window climbs the
screen" bug this codebase has already fixed twice. Defaulting *next to* the meter on first
run is only a starting position; after that the two are unrelated.

What stays shared, on purpose, is the *gesture* rather than the position: one unlock
(`applyLock`) makes the whole HUD draggable at once — unlocking to move the meter is
exactly when you want to move the timers too — and Ctrl+Shift+H hides all of it together.
Splitting those into per-window hotkeys would be three things to remember instead of one.

Note the two idle rules are about different clocks and do not fight each other: **during** a
fight a slot holds its row through a cast, a lapse or a dead caster, because a row that
blinks is the thing being fixed; **when the fight closes** the slot table is dropped
wholesale and the panel disappears with it.

## Tasks

**Parser — slot lifetime and states (pure, WSL-testable)**

- [x] Extend `RhythmTracker.timers(now)` in `src/parser/rhythm.js`: add `since` (ts the
      entry first armed) and `state` (`'armed' | 'lapsed'`), return lapsed entries with
      `dueMs: null` instead of `continue`-ing past them, and sort by `since` ascending
      rather than `dueMs`.
- [x] Add `state: 'ended'` for entries whose caster died (`lastTs === null`) instead of
      skipping them, so a dead boss's row dims in place rather than collapsing the panel.
- [x] Keep `learned()` unchanged — lapsed and ended entries must still export their
      qualified rhythms, and must still be dropped on a manual reset.
- [x] Tests in `tests/rhythm.test.js`: a lapsed entry stays in the list with a null
      `dueMs`; ordering is by `since` and is stable across a re-anchor; a dead caster's
      entry reports `'ended'`; `learned()` output is unaffected by the new states.

**Config and window plumbing**

- [x] `src/main/config.js`: add `timersBounds: null`; remove `castTimers` from
      `ALERT_CATEGORIES` (the alert window must not exist for a category it no longer
      draws) and add `timersEnabled(cfg)` — `castTimers !== false && !alertsMuted`, mute
      still winning over the preference.
- [x] Tests in `tests/config.test.js`: `alertsEnabled` ignores `castTimers`;
      `timersEnabled` respects the key and loses to `alertsMuted`; the existing
      `migrateAlerts` path still forces `castTimers: false` for pre-summon configs.
- [x] `src/main/main.js`: `createTimersWindow()` modelled on `createAlerts()` —
      transparent, frameless, `alwaysOnTop('screen-saver')`, `skipTaskbar`, bounds
      defaulting to the right of the work area at ~40% height (where the buff window
      lives), `moved` → debounced `timersBounds` save.
- [x] `src/main/main.js`: `syncTimersWindow()` called from every path that can change
      `castTimers` or `alertsMuted`; include the window in the snapshot push,
      `broadcastConfig`, `applyLock` (the one HUD-wide unlock), the Ctrl+Shift+H hide,
      and quit teardown.
- [x] Keep the geometry independent: `timersBounds` is written only by this window's own
      `moved` handler and read only at create time. No path may derive its position from
      `overlayWindow.getBounds()` — the meter moves itself, and deriving placement from a
      moving window is the "window climbs the screen" bug class.
- [x] Tray: keep the "Boss spell timers" checkbox but route it through the new sync so it
      creates/closes the timers window rather than the alert window.

**The window itself**

- [x] New `src/renderer/timers/preload.cjs` — listener-only, same shape as the alerts
      preload (`onSnapshot`, `onConfig`, `onLockChanged`, `getConfig`).
- [x] New `src/renderer/timers/index.html` — the framed panel, its slot list and the
      unlocked drag placeholder, with the same CSP as the alerts window.
- [x] New `src/renderer/timers/timers.css` — palette and slot states per mockup A:
      row-as-bar fill, amber armed / dim warm / hot due / alarm-edged CAST / dashed
      lapsed. `--scale` honoured, no scroll containers anywhere.
- [x] New `src/renderer/timers/timers.js` — hold a slot map keyed `caster|ability`,
      reuse elements across pushes (never rebuild — the drain transition depends on it),
      clear the map when the snapshot reports no live encounter, and flip a slot to
      `CAST` while a matching `hostileCasts` entry is live.
- [x] Idle means gone: hide the whole panel (not just its rows) whenever the slot map is
      empty, so nothing paints between fights — and clear the map on the config push too,
      the way `alerts.js` already does, since the push loop skips ticks when nothing
      changes and "next snapshot" can be minutes away.
- [x] Delete the timer half of the alert window: `#timers` from
      `src/renderer/alerts/index.html`, `renderTimers`/`buildTimerChip`/`timerChips` from
      `alerts.js`, `.tchip` rules from `alerts.css`, and the `castTimers` gate in
      `applyConfig`.

**Settings**

- [x] `src/renderer/setup/index.html`: move the "Show spell timers for named bosses"
      checkbox out of the Cast warnings block into its own "Boss timers" section, with
      copy that says it is a separate, separately-placed window.
- [x] Confirm `setup.js` still reads/writes `castTimers` unchanged (no rename — the key
      is what old configs carry).

**Verification and release**

- [x] `npm test` green, including the new rhythm and config cases.
- [x] Verify the idle case explicitly: after an encounter closes the window paints
      nothing at all while locked, and shows only the drag placeholder while unlocked.
- [x] Headless-Chrome render of the shipping `src/renderer/timers/` files against a real
      replayed snapshot from the Warlord Skarlon fight (the 4-slot worst case) plus the
      Nagafen fight, checking: no row moves when a slot is added, the CAST state holds its
      row, a lapsed row shows a dash.
- [x] Bump `package.json` to 0.7.0 in its own commit; `scripts/dev.sh dist`.
- [x] `docs/changelog/2026-08-06-boss-timers-own-window.md`; update the CLAUDE.md
      architecture section to name `src/renderer/timers/` and the four-window layout.

## Notes

**Execution notes (2026-08-06)**

- `since` is the moment a pair first *armed*, recorded inside `timers()`, not the first
  cast: two entries whose first casts are seconds apart can arm minutes apart (a warm
  prior arms on cast one, in-fight evidence on cast four), and ordering by first cast
  would have let a later-arming row insert itself ABOVE a row already on screen — the
  displacement this window exists to remove.
- A slot is claimed only while the prediction is actually live, never when the entry is
  already lapsed or its caster already dead. Without that guard an entry that qualified
  long ago could appear as a permanent dash row it had never earned.
- Encounter close already calls `flushRhythms()` → `rhythms.reset()`, so "slots are
  dropped when the fight ends" needed no new code: the tracker is empty between fights
  and `castTimers` is `[]`, which is what makes the renderer's "idle means gone" a
  one-line consequence rather than a lifecycle of its own.
- The headless pass caught one real defect: a row reading `CAST` beside "late · pattern
  broke". `detail()` now takes the casting flag, and a live cast outranks the retracted
  prediction in the sub-line.
- The panel right-aligns inside its box so growth from a larger `--scale` extends
  leftward and the edge the player aligned to the screen stays put. Measured: 296 × 145
  at 1×, 533 × 260 at 1.8×, inside a 560 × 560 box.


- **Why a fixed box and not the overlay's fit machinery:** across the entire live session,
  the most distinct timed abilities inside one fight was **4** (`Warlord Skarlon` +
  its pet: Frost Shard, Ice Spear, Drowsy, Sicken); 31 of 47 timer-fights had exactly one.
  A box with room for eight slots will never be the thing that hides a timer, and the
  "overlay can never scroll" invariant is satisfied by generosity rather than by geometry
  code.
- **Honesty is unchanged.** Every countdown keeps its `~`; a warm slot (running on a
  stored rhythm rather than this fight's own gaps) stays visually weaker; a lapsed slot
  shows `—`, never an invented number. The new states only stop the row from *vanishing*
  — they never let it claim more than the log supports.
- **Mute still covers it.** `alertsMuted` suppresses the timers window too: mute is "shut
  up for this pull", and a panel that survived it would be the one surface that ignored
  the hotkey.
- **Open question — an ability roster.** The panel could pre-populate slots for abilities
  the rhythm store already knows this boss has, showing `—` until the first cast anchors
  them. It would make the panel a true fixture from the pull rather than something that
  fills in. Left out of this plan deliberately: it is additive, and it is easier to judge
  once the window exists.
- **Mockups live in two places, deliberately.** The Pencil file
  (`~/.pencil/documents/…/pencil-new.pen`) carries them as five top-level frames below the
  History Window — "Today (why it fails)", "A · Buff Slots", "B · Caster Sections",
  "C · Minimal Ticker", "Placement" — plus a notes card with the measurements. The 1:1 HTML
  twin (`docs/design/2026-08-06-boss-timers-mockups.html`) is the pixel-exact reference to
  build the CSS against, and lives in the repo where the changelog can point at it.
