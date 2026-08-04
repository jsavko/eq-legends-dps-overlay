---
status: completed
---
# History Window Redesign — three fixed panes, dedicated window

**Date:** 2026-08-04

---

## Goal

Replace the History **tab** in the settings window with a dedicated **History window**
implementing the approved Pencil mockup (frame "History Window", node `YiYTt`, in
`C:/Users/james/.pencil/documents/46e2ba38-ac1f-49b9-aba9-6ca519714040/pencil-new.pen`,
annotated by the "History Redesign Notes" card). User verdict on the mock: *"This is
perfect."*

The tab's failure mode (user-reported): accordion rows and nested `<details>` reflow
the page on every click, the member drill-down needs a huge window, and 439 flat rows
make specific fights hard to find. The redesign inverts the interaction model: **every
click swaps content inside a fixed pane — nothing ever resizes, expands, or pushes
other content around.**

This plan is self-contained: everything needed is described here; the .pen file is
reference, not requirement.

### The approved design, in full

A dedicated window (~1200×780 default, resizable, bounds remembered), opened from the
tray's **History…** item. Warm overlay palette, NOT the settings window's cool slate:

- bg `#100d0a`, panel `#17130f`, panel2 `#221b14`, line `#2e2620`
- ink `#f0e3c4`, ink-dim `#a8977a`, ink-faint `#6d6350`
- ember `#b9702a`, gold `#e0a53f` (resist tags/accent), balm `#63c2b4` (healing),
  wound `#9e3b2e` / wound-lit `#d0685a` (taken), bad `#e5766b` (deaths)
- Font: Bahnschrift with the overlay's fallback stack (the mock's "Barlow" was a
  Google-font stand-in; use the app's real stack).

**Title bar:** "Encounter History" · character select (from `characters()`) ·
spacer · "Clear history…" (destructive, confirm).

**Left rail (300px): finding fights.**
- Search box ("boss or zone…").
- Filter chips: **All / Bosses / Deaths / Today** (single-select, All default).
- Fight list grouped by day ("SUN · AUG 3" headers), newest first. Each row: name +
  duration (right); second line: time · zone; skull icon + count when someone died
  (non-pet deaths). Trash fights render dimmed (ink-dim name). Selected row: ember
  tint + gold left edge. Footer: "439 encounters · filtered: N".
- The rail scrolls internally. (Scrolling is fine here — only the OVERLAY may never
  scroll; this is a normal window. "Fixed panes" means regions never move each other.)

**Middle/right (main pane) for the selected fight:**
- Header: fight name (22px) + meta line (zone · date/time · duration · "ended by
  <closeReason>"); deaths line in red with skull ("Rhale — Lord Nagafen · Rhale`s
  warder (pet) — Lord Nagafen").
- Stat strip: DEALT (ink, "68 dps"), HEALED (balm), TAKEN (wound-lit, "92 dtps"),
  DEATHS (bad, "+1 pet" unit when petDeaths > 0).
- Metric segments: Damage / Healing / **Damage taken** — active segment filled with
  the metric's color (ember / balm / wound).
- **Members column (~290px):** header "MEMBER | TAKEN · SHARE" (per metric); one row
  per member: name (+ skull if they died), value, share %, and a 3px share bar in the
  metric color. Click selects; selected = wound/metric tint + colored left edge.
  Scrolls internally for raids.
- **Breakdown panel (fills the rest):** the selected member's complete detail,
  repainted in place on member/metric change:
  - taken → head line ("25,154 taken · 92 dtps · max hit 500 · avoided 174 · died
    once"), then HIT BY (attacker rows with background bars normalized to the
    largest, damage/hits/max columns), WITH WHAT (ability rows with bars +
    damage/hits/RESIST columns — FR/CR/MR/PR/DR in gold, "armor" for melee, "—" for
    untyped), BY DAMAGE TYPE chips ("fire 13,011 FR").
  - damage → abilities table (damage/share/hits/crits/max, pet rows tagged).
  - healing → heal abilities (healed/overheal/casts) + healed-who list.
  - Every entry always — no top-N (standing invariant).

## Approaches Considered

### 1. New dedicated renderer (`src/renderer/history/`), vanilla JS (chosen)
- **Description:** Fourth renderer directory: `index.html`, `history.css`,
  `history.js`, `preload.cjs`, plus a pure `organize.js` for list logic. New
  `createHistory()` window in main; tray History… repointed to it; the settings
  History tab removed.
- **Pros:** Matches every existing convention (vanilla ES modules, pure logic split
  out for WSL tests, preload-per-window). Right window size and identity. Settings
  window returns to being just a form.
- **Cons:** A third BrowserWindow to manage (bounds persistence, focus-if-open —
  both already have patterns in main.js).

### 2. Rebuild the master–detail layout inside the settings tab
- **Pros:** No new window plumbing.
- **Cons:** 860×660 form window cannot hold three panes; the user's instinct was a
  menu destination, not a settings tab ("I thought it would be a menu item"); rejected
  by the mock they approved.

### 3. Adopt a UI framework (React/Svelte) for the new window
- **Cons:** The project is deliberately framework-free vanilla ES modules; a
  framework for one window breaks the two-worlds build's zero-dependency simplicity.
  Rejected.

### 4. Export HTML from the Pencil mock as the starting markup
- **Cons:** Generated markup wouldn't match the codebase's hand-written idiom or
  reuse its patterns; the mock is a spec, not a source. Rejected.

## Chosen Approach

Approach 1. IPC is already sufficient — `HISTORY_LIST`, `HISTORY_GET`,
`HISTORY_CLEAR` carry everything the window needs and stay unchanged; the history API
moves from the setup preload to the new window's preload. All selection state
(fight, member, metric, chip, search) is renderer-local.

**Boss heuristic (discovered this session, important):** encounter labels are stored
ARTICLE-STRIPPED (`engage()` receives resolved names), so "a froglok shin knight" is
stored as "froglok shin knight" — an article test can never work. Named mobs keep
their capitals ("Lord Nagafen", "Hoptor Thaggelum") while generic mobs are lowercase
after stripping. So: **Bosses = label starts with an uppercase letter OR durationMs ≥
90_000.** Deaths chip = any non-pet death. Today chip = startTs same calendar day as
now. Trash (dimmed) = not a boss.

## Tasks

- [x] `src/renderer/history/organize.js` — pure, DOM-free: `isBoss(entry)`,
      `applyFilters(entries, {chip, search})` (chip ∈ all/bosses/deaths/today; search
      matches label+zone, case-insensitive), `groupByDay(entries)` → ordered
      `[{dayLabel, entries}]`, and the shared formatters (rate, duration, shortDate,
      pct — lift from setup.js).
- [x] `tests/history-organize.test.js` — boss heuristic (capitalized vs lowercase
      label, 90s threshold), each chip, search, day grouping order/labels.
- [x] `src/renderer/history/index.html` + `history.css` — three-pane layout and the
      palette above; pane-local `overflow-y: auto` on rail and members; CSP meta like
      the other renderers; row/bar/chips styling per the mock.
- [x] `src/renderer/history/history.js` — load via `historyList`; render rail
      (grouped, filtered), fight pane, members, breakdown; selection/metric/chip/
      search as module state; content swaps only (`replaceChildren`), zero layout
      mutation elsewhere; empty states ("No encounters recorded yet", "no matches").
- [x] `src/renderer/history/preload.cjs` — `historyList/historyGet/historyClear`
      (channels from ipc.js; keep the preload's own CH map in sync as the others do).
- [x] `src/main/main.js` — `createHistory()`: 1200×780 default, `minWidth` ~900,
      bounds persisted to config `historyBounds` (same debounced pattern as the
      overlay's `remember`), focus-if-open like `createSetup`; tray `History…` →
      `createHistory()`; window cleanup on close.
- [x] `src/main/config.js` — `historyBounds: null` default.
- [x] Remove the History tab from the settings renderer: tabs nav + `#history-section`
      from `index.html`, the tab/history code from `setup.js`, the tab/fight-list/
      detail styles from `setup.css`, history API from `setup/preload.cjs`. Settings
      window keeps Clear log file… and everything else.
- [x] Headless verification (CLAUDE.md recipe): serve the history renderer with a
      stubbed `window.api` fed by real backfilled records (replay the live log through
      `EncounterStore` as done for the tab); drive chips/search/selection/metric
      switches; assert the breakdown pane's geometry is IDENTICAL before/after
      selection changes (the no-reflow guarantee); screenshot for the eyeball check.
- [x] `docs/changelog/2026-08-04-history-window.md`, bump to 0.3.0 (own commit),
      `scripts/dev.sh dist`, restart the dev overlay.

## Notes

- The approved mock lives in Pencil (`pencil-new.pen`, frame `YiYTt` "History
  Window" + note `NSsCE`); this plan restates all of it, so executing needs no Pencil
  access.
- `HISTORY_LIST` already returns `{characters, selected, encounters}` with per-entry
  `deaths` (non-pet) and `self` sub-object; `HISTORY_GET` returns the full record with
  the unfiltered snapshot (attackers/takenAbilities/takenByType/deaths incl. pets).
  Real data on disk: ~439 encounters in
  `%APPDATA%\eq-legends-dps-overlay\history\Rhale_oggok.jsonl` (backfilled).
- Keyboard nice-to-have (optional, only if trivial): ↑/↓ moves fight selection within
  the filtered list.
- Do not touch the overlay renderer, parser, or store in this plan.
- Standing invariants: breakdown shows every entry (no top-N); untyped damage is never
  guessed into a type; the OVERLAY never scrolls (this window may, per-pane).
- User preferences on record: fixed-pane master–detail, no accordions; features get
  menu-level entry points; show all data ([[feedback-fixed-pane-ui]],
  [[feedback-complete-data-visible]]).
- Execution discovery: the deaths line under the fight header must render for EVERY
  fight ("no deaths" in faint ink when clean) — conditional presence shifted every
  pane below it by a line-height when moving between fights. Caught by the headless
  geometry assertion (nine pane rects, zero deltas across the full interaction
  battery: fight/member/metric/chip/search/keyboard, 442 real encounters).
- Accepted limit: a raid-wipe deaths list can wrap to a second line and shift panes
  for that one fight; reserving one line covers the normal case and an ellipsis would
  hide data.
