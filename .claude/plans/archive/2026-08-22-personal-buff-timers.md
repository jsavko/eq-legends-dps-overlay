---
status: completed
---
# Personal buff timers — a placeable panel of my own

**Date:** 2026-08-22

---

## Goal

Give the player a small, separately-placeable overlay panel of **their own** countdowns —
"Spirit of the Puma has 40 seconds left" — driven by the trigger system that already
exists, drawn as a bar that drains from full to empty so the answer is available at a
glance rather than by reading a number.

The honest starting point, because it changes what this plan is: **most of this already
works.** `src/triggers/` reads a log line, matches an authored pattern, arms a countdown
and hands the timers panel a row with a `fill` bar that drains right-to-left at 4 Hz
(`timers.js` `paint()`, `timers.css` `.slot .fill`). The Triggers window's editor dialog
already has NAME / PATTERN / SHOW / TIMER-kind / duration-in-seconds / ENDS EARLY ON, and
a "Test against my log" button. A player can today write:

| field | value |
|---|---|
| NAME | `Spirit of the Puma` |
| PATTERN | `^You begin to snarl as your features become feline\.$` |
| TIMER | Countdown, `146` seconds |
| ENDS EARLY ON | `^The spirit of the puma departs\.$` |

...and get a draining countdown. Every one of those strings is a real line from the live
log; the duration is measured, not guessed (see Notes). So the feature is not absent — it
is **mislabelled, mis-placed, and undiscoverable**, and it competes for slots with the
thing the panel was built for.

What this plan actually delivers:

1. **A second timer panel with its own position and its own switch** — "My timers" —
   so a personal buff countdown is not a row in a window titled *Boss timers*, does not
   have to live wherever you keep the boss panel, and cannot squat the top slots that a
   boss's Superior Healing needs.
2. **A `lane` on a trigger's timer** (`boss` | `self`), set from the editor, so which
   panel a countdown draws in is a property of the trigger a player can read and change —
   and every existing pack keeps drawing exactly where it draws today.
3. **A bar-forward renderer**, since "total duration draining away" is the whole request:
   the bar is the row's main event, the remaining time is large, and the row says what the
   full duration was so the bar's fraction means something.
4. **`scripts/mine-buffs.js`** — measure your own buff durations out of your own log,
   the way `mine-rhythms.js` measured the boss pack, so the number typed into the duration
   field is an observation rather than a guess. This is the difference between a feature
   that works and one the player abandons after typing "120" and watching it be wrong.

### Why a second panel and not just a row in the existing one

Not aesthetics — a measured failure this project has already written down once. The
archived plan `2026-08-07-boss-timers-self-buff-noise.md` reports a Plane of Fear pull
where two self-buffs claimed both slots at 15:21 and held them for fifteen minutes, and
the one countdown worth having — Maestro of Rancor's Superior Healing, the cast that
undoes the kill — armed **last** and drew **below** them. That was a mob buffing itself;
the mechanism is identical for the player buffing themselves, and worse, because a
146-second buff outlasts most pulls. Slots are claimed in first-armed order and are
**never** re-sorted (that rule is the reason the window exists — 524 measured
displacements). So a personal buff cast during the pull-in permanently outranks every
boss cast for the rest of the fight.

Two panels is the only arrangement where "never re-sort" and "the boss's cast is the
row I need" are both true.

## Approaches Considered

### 1. Ship a starter pack and some documentation — change no code
- **Description:** Write the buff triggers into a shipped pack (or just document the
  recipe above), let the rows draw in the existing boss-timer panel, which is already
  placeable and already draws a draining bar.
- **Pros:** Zero risk, zero new windows, available today. The panel genuinely does have
  a draining bar and genuinely is drag-placeable while unlocked.
- **Cons:** Rejected on the measured evidence above — a long personal buff claims a slot
  ahead of the boss cast and holds it, in a window whose header says *Boss timers*. It
  also forces one screen position for two things a player watches at different moments:
  the boss panel belongs where you watch the fight, buff countdowns belong beside EQ's own
  buff window. And it does not answer "set where I want it", which is the explicit ask.

### 2. A second window, with a `lane` on the trigger's timer
- **Description:** Add `timer.lane` (`'boss'` default, `'self'`) to the pack schema; the
  engine carries it onto each row; a new `src/renderer/buffs/` window renders the `self`
  rows and the existing panel filters to `boss`. Own bounds key (`selfTimersBounds`), own
  tray switch (`triggerSelfTimers`), same lock/hide/mute gestures as the rest of the HUD.
  The editor gets a DRAWS IN control beside the TIMER row.
- **Pros:** The engine, the pack format, the authoring dialog, the dry-run and the never-
  move rule are all reused unchanged — the new code is a renderer and a `BrowserWindow`
  factory, and this repo has built that exact shape three times (alerts, timers, drops),
  most recently for the engaged-drops popup, whose header explicitly describes itself as
  "the timers window's contract exactly". A mixed pack works: a guild pack can carry boss
  casts and a Call of the Hero reminder and each lands where it belongs. Existing packs
  are untouched by construction, since the absent field normalizes to `'boss'`.
- **Cons:** A second near-identical renderer, and nineteen `timersWindow` call sites in
  `main.js` that each need a sibling. `lane` is one more thing a `.gtp` export cannot
  carry, so `gina-export.js`'s loss report grows a line.

### 3. Put the lane on the **pack** rather than on the trigger
- **Description:** Each source declares which panel it draws in; the Triggers rail gets a
  "draws in" control per pack. One decision instead of one per trigger.
- **Pros:** Fewer choices to make, and it matches the window's own model — the rail is
  SOURCES, the titlebar is SURFACES, so "which surface does this source use" reads
  naturally. The seed boss pack is boss-only and a hand-made buff pack is self-only, so
  in practice the granularity is never missed.
- **Cons:** Rejected as the primary mechanism because it is the wrong granularity for the
  case that will actually arrive: a downloaded guild pack containing both a boss's enrage
  timer and a "refresh your damage shield" reminder cannot be split, and the player's only
  recourse is to duplicate the pack and delete half of each — an edit that marks both
  copies `edited` and orphans them from their upstream. Worth folding in as a *convenience*
  (a pack-level "move every timer in this pack to…" action) but not as the stored truth.

### 4. One window, two stacked sections
- **Description:** Keep the single timers window; draw boss rows in an upper group and
  personal rows in a lower one, with a divider.
- **Pros:** One window, one set of bounds, one switch. Solves the slot-competition problem
  — a self row can no longer sit above a boss row.
- **Cons:** Does not deliver the request. "A small timer overlay that I can set where I
  want it" means its own position, and this gives it the boss panel's position. It also
  reintroduces movement by the back door: a self row arriving grows the lower section,
  which is fine, but a self row *leaving* while boss rows are drawn shifts nothing only if
  the sections are fixed-height — and fixed-height sections mean either wasted space or a
  cap on rows, and a cap is forbidden here.

### 5. Player-created panels — N of them, each with a name and a position
- **Description:** Generalize: the player makes panels, assigns triggers to them.
- **Pros:** Maximum flexibility; would subsume approaches 2 and 3.
- **Cons:** Rejected as premature. Two panels is a known need with a measured cause; N is
  speculation, and it costs a panel-management UI, per-panel bounds persistence, and a
  window lifecycle that has to create and destroy `BrowserWindow`s on config change rather
  than at boot. Approach 2 does not block it — `lane` is a string, and if a third value
  ever earns its place the schema already holds it.

## Chosen Approach

**Approach 2 — a second window keyed off a `lane` on the trigger's timer**, with approach
3's pack-level bulk action deferred until someone actually wants it.

It is chosen for one reason above the others: it is almost entirely *reuse*. Nothing about
matching, compiling, budgeting, slot lifetime, early-enders, restart semantics, the dry-run
or the authoring dialog changes. The engine gains a passthrough field. The pack format
gains a normalized enum that defaults to today's behaviour, so every pack in the wild —
including the sixteen shipped boss timers — draws exactly where it draws now, and nothing
moves unless the player moves it.

Three structural decisions worth stating up front:

**The lane lives on `timer`, not on the trigger.** A trigger can raise a chip *and* arm a
countdown; the chip already has its own surface and its own switch. `lane` describes where
the *countdown* draws, so it belongs next to `durationMs` and `endingMs`, where the editor
already reads and writes as one group.

**Each renderer filters, main does not split.** `buildSnapshot` keeps sending one
`triggerTimers` array; `timers.js` filters to `lane !== 'self'` and `buffs.js` filters to
`lane === 'self'`, exactly as `timers.js` already filters on `cfg.triggerTimers`. The
reason is the comment already in `applyConfig`: the push loop skips unchanged ticks, so a
renderer that can only learn about a change from the *next snapshot* can sit wrong for
minutes during a lull. Filtering in the renderer keeps both panels correct on a config
push, and keeps main's snapshot contract single.

**The default is `'boss'`, always.** An absent field, a GINA import, an old pack file and
an existing authored trigger all normalize to `'boss'`. Nothing the player already has
relocates itself the first time they launch the new build. Moving a countdown to the new
panel is a thing they do, once, on purpose.

## Tasks

### Schema and engine — `src/triggers/`

- [x] `pack.js` `normalizeTimer()`: add `lane: raw.lane === 'self' ? 'self' : 'boss'`, with
      a comment recording *why* the default is `boss` (every pack in existence predates the
      field and must not relocate on upgrade)
- [x] `pack.js` `buildTrigger()`: read `form.lane` into the built timer, so the editor's
      choice round-trips through create **and** update
- [x] `pack.js`: no new `validateTrigger` rule — an unknown lane normalizes rather than
      failing, on the same "degrade to usable, never refuse to load" reasoning already in
      `normalize()`'s header
- [x] `engine.js` `armTimer()`: copy `timer.lane` onto the slot; `timers()`: emit `lane` on
      the row beside `source`/`state`
- [x] `gina-export.js`: add `lane` to the lossy-export report, so a pack exported to `.gtp`
      says plainly that the panel assignment will not survive the trip

### Config, windows and tray — `src/main/`

- [x] `config.js`: `DEFAULTS` gains `triggerSelfTimers: true` and `selfTimersBounds: null`;
      export `SELF_TIMER_KEYS = ['triggerSelfTimers', 'alertsMuted']` and a pure
      `selfTimersEnabled(cfg)` alongside `timersEnabled`
- [x] `main.js`: `createSelfTimersWindow()` modelled line-for-line on `createTimersWindow`
      — invisible generously-sized box, transparent, click-through on the shared lock,
      `alwaysOnTop('screen-saver')`, own `remember()` debounce writing `selfTimersBounds`
      and nothing else. Default placement: right edge, **above** the boss panel's 40 % —
      roughly where EQ's buff window sits, and clear of the boss panel's default patch
- [x] `main.js`: add the new window to every list `timersWindow` appears in — the snapshot
      push (~1104), the lock broadcast (~2103), the show/hide pair (~2162, ~2220), the
      HUD hide (~2228), and `syncTimersWindow`'s create/close at ~2083/2084 (a sibling
      `syncSelfTimersWindow`, driven by `SELF_TIMER_KEYS` at ~2469)
- [x] `main.js` tray: a `My timers` toggle immediately below `Boss spell timers`, same
      `alertToggle` shape, same "A panel of its own — unlock the overlay to place it"
      tooltip, still under the top-level mute
- [x] `ipc.js`: no new channel — the new window listens on the existing snapshot, config
      and lock channels, so its `preload.cjs` is the timers preload with a new path

### The panel — `src/renderer/timerpanel/`

- [x] **Mockup first**, at 1:1 and at 1.8×, approved before any renderer code — three row
      variants, every state, the drag placeholder, and both panels side by side.
      `docs/design/2026-08-22-my-timers-mockups.html`
- [x] `index.html` / `panel.css` / `panel.js` / `preload.cjs`, built to the boss panel's
      invariants — fixed row height in every state, slots in engine order, never
      re-sorted, no scroll container anywhere, `--scale` on the root, right-aligned inside
      the box so growth extends into the dead space
- [x] **Two-tone text on the draining bar** (James's call on the mock): the bar is the row,
      and the text INSIDE the filled region draws in a contrasting colour while the text
      the bar has already drained past draws in the normal ink. So the row reads its own
      progress even with the numbers ignored. A clipped duplicate text layer, width driven
      by the same fraction as the fill
- [x] The sub-line names the **full duration** so the drained fraction means something
      (`of 2:26`). Body text ≥15px at 1×
- [x] Jade/verdigris rather than the boss panel's ember or the alerts' red — identifiable
      at a glance from three feet by colour alone
- [x] Reuse the ending state the engine already emits (`ending`, `endingText`) for the
      "recast now" emphasis rather than inventing a second threshold
- [x] Between fights the panel is **gone**, not an empty frame — same rule, same unlocked
      drag placeholder exception, since a window with nothing in it cannot be positioned
- [x] One renderer, N windows: the panel id arrives as `?panel=<id>` on the file URL and
      the renderer filters the one snapshot list to its own rows and reads its own title
      from config
- [x] `timers/timers.js` `rows()`: filter to the boss panel, so a reassigned row leaves
      the boss panel instead of drawing in both

### Player-defined panels — `src/main/config.js`, `src/main/main.js`

- [x] `timer.lane` becomes `timer.panel`, a panel **id** rather than a two-value enum:
      `'boss'` for the fight's clock (the default, and what every existing pack gets) or
      the id of one of the player's own panels
- [x] `config.js`: `timerPanels` — an array of `{id, title, enabled, bounds}`, seeded with
      one panel titled "My timers" so the feature is discoverable on first run. Pure
      helpers `timerPanelsFor(cfg)` (enabled, mute-aware), `nextPanelId(cfg)` and
      `panelTitle(cfg, id)`, all unit-tested in WSL
- [x] `main.js`: `syncTimerPanels()` — one window per enabled panel, created when a panel
      appears, closed when it is removed or switched off, title re-pushed when it is
      renamed. Windows keyed by panel id in a Map beside the singleton handles
- [x] Each panel window persists its own bounds back into its own array entry, debounced,
      read-modify-write — never derived from another window's bounds
- [x] Every list `timersWindow` appears in takes the panel windows too: snapshot push,
      lock broadcast, config broadcast, show/hide, HUD hide, mute
- [x] Tray: the panel rows are generated from `timerPanels`, each with its own switch,
      below `Boss spell timers`

### Authoring — `src/renderer/triggers/`

- [x] Editor dialog: DRAWS IN becomes a **select** of every panel — `Boss timers` first,
      then the player's own, then `+ New panel…` which asks for a title inline. Disabled
      while the timer kind is `No timer`, defaulting to `Boss timers`
- [x] A PANELS section in the Triggers window where a panel is renamed, switched and
      deleted. Delete is offered only when the panel holds no triggers; otherwise it says
      how many draw there and points at the switch, so no trigger is ever silently
      orphaned or silently moved into the boss panel
- [x] `triggers.js`: read and write `panel` through the editor's form object; show the
      panel name on each timer-bearing row so the assignment is visible without opening
      the dialog
- [x] Titlebar surfaces stay two — `chips` and `timers` — with per-panel switches living
      with the panels themselves. A surface per panel in the titlebar would grow without
      bound
- [x] Pack summary line and `packStats`: count timers per panel, so a pack whose
      countdowns all draw in a panel the player has switched off can say so

### Measuring durations from the player's own log — `src/triggers/mine-buffs.js`

- [x] A pure module plus a thin `scripts/mine-buffs.js` wrapper, on `mine-rhythms.js`'s
      model: scan a log for the player's own buff-land lines, pair each with its wear-off
      line, and report **last-land → wear-off** per effect with a median, a spread and an
      observation count
- [x] The pairing rule is the measured one, not the obvious one: a recast **refreshes**,
      so the gap that matters is from the LAST land before the wear-off, not the first.
      In the live log the puma buff was recast two or three times per cycle and only the
      last-land gaps agree (see Notes)
- [x] Pair discovery is empirical, not a spell table: the same log yields both halves, and
      an effect is only reported once a land line and a wear-off line have been seen to
      alternate. James's reason, and it is the right one — AAs, ranks and class make the
      set of lines unique per player, so a shipped list would be wrong for everybody
- [x] `--write <pack.json>` emits a ready-to-import native pack aimed at the first custom
      panel, `restart: 'restart'`, the wear-off line as the early-ender, and provenance
      wording stating how many observations each duration rests on. Writes nothing without
      the flag, same as `mine-rhythms.js`
- [x] **In-app**: a "Measure from my log…" button in the Triggers window that runs the
      same pure module against the configured log and installs the result as an ordinary
      editable pack — because the whole point is that the numbers come from the player's
      own log rather than from a table somebody else wrote
- [x] Print the rank caveat where the player will read it: the land line is rank-agnostic
      (`You begin to snarl…` for every rank of Spirit of the Puma) while the duration is
      not — 146s at rank V, 159s at rank VI in the same session

### Tests — WSL, `node --test`

- [x] `tests/trigger-pack.test.js`: panel defaults to `boss` on an absent field and on a
      GINA import; survives `buildTrigger` → `updateTrigger` → `normalize` round-trip; the
      sixteen shipped seed triggers all normalize to `boss`
- [x] `tests/trigger-engine.test.js`: `panel` reaches the `timers()` row; rows for two
      panels armed in one session each stay in first-armed order within their own panel; a
      re-match restarts in place without changing panel
- [x] `tests/config.test.js`: `timerPanels` defaults to one seeded panel; `timerPanelsFor`
      is empty under mute and drops disabled panels; `nextPanelId` never collides with an
      existing id; `panelTitle` falls back rather than throwing on a missing id
- [x] `tests/triggers-window.test.js`: the editor's panel select round-trips through the
      form object in both directions
- [x] `tests/mine-buffs.test.js`: a fixture log with a recast-then-expire cycle yields the
      last-land gap and not the first-land gap; a spell with one observation is reported
      as one observation rather than as a median; a land line with no wear-off is not
      reported at all

### Verify, document, ship

- [x] Headless renderer check per `docs/changelog/2026-08-02-breakdown-shows-every-ability.md`:
      stub `window.api`, feed a snapshot carrying rows for two panels, screenshot both at
      1× and 1.8× and confirm no clipping and no row movement across a state change
- [x] End-to-end check against the real log: mine it, load the resulting pack into a real
      `TriggerEngine` beside the shipped boss pack, replay the 22 Aug window and confirm
      every armed row addresses `p1`, and that the puma slot ends early on
      `The spirit of the puma departs.` **In-game confirmation is James's to do** — this
      verifies everything up to the pixels, and the pixels were verified headlessly
- [x] `docs/changelog/2026-08-22-personal-buff-timers.md` — the measured self-buff-squats-
      the-boss-slot argument, why panels are player-defined, why the default panel is
      `boss`, why each renderer filters instead of main splitting, and the
      recast-refreshes measurement rule
- [x] Archive this plan to `.claude/plans/archive/`
- [x] `npm test` — 925 passing
- [x] `taskkill` the overlay, `scripts/dev.sh pack`, and **relaunch it** — done, all
      three. Version left at 0.8.8; a bump is James's call

## Notes

### Mid-execution redirect — the mock review, 22 Aug

The 1:1 mock went back with three questions. James answered all three with notes rather
than by picking an option, and one of them changed the shape of the work:

1. **Row shape** — variant A (the bar is the row), with **the text inside the draining
   bar in a contrasting colour**. So the row reports its own progress twice: by the bar's
   edge and by where the text changes colour. Neither variant offered that; it is better
   than all three.
2. **Panels are the player's, not ours.** *"it needs to be independent and should be
   configurable so user can set the titles and which timers appear in which headers. They
   should not be part of the boss timers."* This is approach 5 from the list above, which
   the plan rejected as premature — it is now the requirement. `lane` therefore becomes
   `panel`, a panel **id**, and the panel list lives in config where the player can add,
   title, switch and place each one. The boss panel keeps its own window, key and
   behaviour untouched: it predates this and is not one of the player's panels.
3. **Durations must come from the player's own log.** *"it should read their logs because
   their AAs and buffs are going to make their timers unique to them."* So the miner is
   not optional and not merely an offline script — it gets an in-app path too, and it
   discovers its land/wear-off pairs empirically rather than from any shipped list of
   spell names.

The rejection reasoning for approach 5 stands on its own terms and is left above rather
than rewritten: N panels *is* more machinery than two, and the cost estimate was right.
It was the wrong call because the requirement was wrong, not because the arithmetic was.

### The worked example, measured from the live log (22 Aug session)

Every line below is real, from
`eqlog_Rhale_oggok.txt`. Spirit of the Puma is a group buff, and the player's own copy
prints differently from everyone else's — which is what makes a clean self-trigger
possible at all:

| role | line |
|---|---|
| cast (carries the rank) | `You begin casting Spirit of the Puma VI.` |
| **lands on you** | `You begin to snarl as your features become feline.` |
| lands on others | `Bootscabz growls with the spirit of the puma.` |
| **wears off you** | `The spirit of the puma departs.` |
| wears off others | `Your Spirit of the Puma spell has worn off of Binnon.` |
| wears off pet | `Your pet's Spirit of the Puma spell has worn off.` |

Arming on the **land** line rather than on `You begin casting` is deliberate: a cast that
is interrupted or fizzles never lands, and a countdown for a buff you do not have is worse
than no countdown.

Last-land → departs, every complete cycle in the log:

```
Aug 20 08:17:42 → 08:19:59   137s
Aug 20 10:37:09 → 10:39:34   145s
Aug 20 10:51:51 → 10:54:17   146s
Aug 22 06:28:41 → 06:30:40   119s
Aug 22 06:32:51 → 06:35:16   145s
Aug 22 06:42:02 → 06:44:28   146s
Aug 22 06:50:14 → 06:52:40   146s
Aug 22 06:54:27 → 06:56:53   146s
Aug 22 06:57:09 → 06:59:48   159s   ← rank VI, cast at 06:57:07
```

Median **146s** for rank V; the 159s outlier is the one cycle where the log shows
`Spirit of the Puma VI` being cast. The 119s and 137s cycles are the ones to be suspicious
of — probably a zone or a click-off, and exactly the reason the miner should print an
observation count and a spread rather than a bare number.

### Things already true that this plan must not break

- The panel cannot scroll. Both timer windows ignore mouse input while locked, so a wheel
  event never arrives; the box is oversized instead of clever.
- A row never moves. Slots come from the engine in first-armed order; `armTimer` restarts a
  live slot **in place** rather than opening a second row, and that stays true per lane.
- The boss panel keeps its behaviour byte-for-byte. If this plan changes what a player sees
  in *Boss timers* for a pack they already have, something has gone wrong.

### Open questions

- **Name of the panel.** "My timers" throughout this plan. It also has to cover item
  cooldowns and "the ph repops in 22 minutes", which "Buffs" would not. Worth confirming
  before the Pencil mock, since the header text is in the mock.
- **Should the miner's output be installed automatically on first run?** Tempting — it
  would make the panel populate itself — but it means writing a pack derived from the
  player's log without being asked, and this repo's shipped pack is a reviewed artifact
  rather than a machine's output. Proposed: the script writes a file, the player imports
  it, and a later "Measure my buffs…" button in the Triggers window is a separate piece of
  work once the panel has proved itself.
- **A pack-level "move every timer in this pack to…" action** (approach 3's convenience).
  Deliberately out of scope; trivial to add later since the lane is already stored per
  trigger.
