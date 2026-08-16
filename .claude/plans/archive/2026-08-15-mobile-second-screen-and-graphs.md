---
status: completed
---
# Mobile second screen and fight graphs

**Date:** 2026-08-15

---

## Goal

Bring the two EQBuddy features James likes into this overlay, in this project's idiom:

1. **Mobile second screen** — a phone or tablet on the same LAN shows live meter data in
   a browser: current fight rows, tap-for-breakdown, and fight history. EQBuddy does this
   with an embedded HTTP server in the exe and a QR code in the title bar for pairing; we
   can do the same from Electron main with Node's built-in `http`, no game window space
   spent, no cloud, nothing leaves the LAN.
2. **Graphs** — DPS/HPS/DTPS-over-time curves for a fight, in the History window's stats
   pane and on the phone. EQBuddy's marquee graph is a per-skill hit-lane timeline with a
   smoothed DPS curve over it; the curve is the achievable first step, the hit-lane view
   is a possible follow-up (see Notes — it needs per-hit retention we deliberately don't
   do today).

What EQBuddy actually does (verified from the repo): embedded LAN-only HTTP server,
QR pairing with the code in the URL fragment, eleven selectable phone screens, tablet
side-panel layouts; fight timeline canvas (lane per skill, bar height = hit size,
bright = crit, hollow = miss/resist) with a smoothed DPS-over-time overlay, plus session
history charts.

**The blocking fact discovered in exploration:** we retain no time-series today. Each
combatant's `window`/`healWindow`/`takenWindow` Maps in `src/parser/encounter.js` are
per-second buckets, but `rollingTotal()` (encounter.js:489) *deletes* buckets older than
the 10s rolling window on every snapshot. A graph has nothing to read from — durable
timeline buckets are new parser work, and they must also be persisted into the JSONL
record so historical fights get graphs.

## Approaches Considered

### 1. Embedded HTTP + Server-Sent Events, dedicated mobile page (built-in `http`, ~zero new deps)
- **Description:** A new `src/main/mobile.js` starts Node's built-in `http` server when
  enabled. It serves a purpose-built single-column mobile page from `src/renderer/mobile/`,
  streams the existing `buildSnapshot()` payload over SSE at the push-loop cadence, and
  answers REST calls for history (`/api/history`, `/api/history/:id`) backed by the same
  `EncounterStore` calls the History window uses. A pairing token rides in the URL; tray
  gets a "Second Screen…" entry showing a QR code + URL.
- **Pros:** Zero or near-zero new dependencies (SSE is plain HTTP; only a pure-JS QR
  encoder is added). One-way push is exactly our data flow — the 4 Hz pusher already
  exists and `buildSnapshot()` (main.js:1000) is already a windowless, JSON-serializable
  feed. SSE auto-reconnects natively in browsers. Server is pure Node → unit-testable in
  WSL with `fetch` against 127.0.0.1, like everything else we value.
- **Cons:** Phone→PC interaction (if we ever want EQBuddy's "tap to confirm spawn" style
  features) needs plain `fetch` POSTs rather than a socket — fine for our needs, slightly
  less elegant. Windows Firewall will prompt once on first listen.

### 2. WebSocket server via the `ws` package
- **Description:** Same architecture, but a `ws` WebSocket server instead of SSE.
- **Pros:** Bidirectional out of the box; marginally lower per-message overhead.
- **Cons:** A new runtime dependency for capability we don't need — the phone is a
  *display*. Our one existing dependency rule (`electron-updater` only) has served the
  two-worlds build well; SSE gets the same result with the standard library.

### 3. Serve the existing renderer pages to the phone with an IPC shim
- **Description:** Serve `src/renderer/overlay/` and `src/renderer/history/` as-is, with
  a shim that maps `window.api` calls onto fetch/SSE.
- **Pros:** No new views to build or maintain; History window features arrive for free.
- **Cons:** Those views are built for their windows: the overlay is a compact click-through
  floating meter (hover via cursor polling from main — meaningless on touch), History is a
  three-pane 1000px-class layout that would be unusable on a phone. The shim would be a
  second implementation of the preload surface to keep honest forever. A phone screen
  deserves a phone layout — EQBuddy explicitly reflows phones to single-column.
- **Middle ground worth keeping:** the *pure* renderer modules (`breakdown.js`,
  `organize.js`, the new timeline math) are plain ES modules and get reused by the mobile
  page directly. Shared logic, separate layout.

### 4. Cloud relay so the phone works off-LAN
- **Description:** Push snapshots to a hosted relay; phone subscribes from anywhere.
- **Pros:** Works away from home; no firewall prompt.
- **Cons:** Rejected outright. It ships combat data off the machine, needs hosted infra,
  and betrays the same "never phones home" principle EQBuddy advertises. LAN is the use
  case: the phone is propped next to the keyboard.

### 5. Graphs without parser changes — client-side accumulation only
- **Description:** Skip durable buckets; the phone/History window accumulates
  `groupDps`/per-row deltas from the 4 Hz pushes and draws curves from what it saw.
- **Pros:** No parser or record-shape changes at all.
- **Cons:** A client connecting mid-fight starts with a blank graph; closed fights have
  no curve; the History window (pull-on-demand, not on the push list) gets nothing. It
  makes the graph a property of *watching* rather than of the *fight* — wrong layer.

## Chosen Approach

**Approach 1** for transport, with durable timeline buckets in the parser as the data
foundation (rejecting approach 5), and pure-module reuse from approach 3's middle ground.

Two phases, graphs first, because the timeline data model underpins the mobile graphs too:

**Phase 1 — timeline data + History graphs.** `Encounter` grows a durable per-second
bucket store per combatant (damage / healing / taken), separate from the prune-on-read
rolling windows. Exposed from `enc.snapshot()` behind an option so the 4 Hz overlay push
stays lean, and written into the JSONL record by `persistEncounter()` as an additive
field (old records simply lack it and render a faint "no timeline recorded" — same
honesty pattern as the deaths line). The History window's fight-stats pane gets a
fixed-height timeline canvas: group curve plus the selected member's curve, one canvas
per metric coloring (ember/teal/dried-blood), smoothing done by a pure, unit-tested
module. Fixed height always rendered — the no-reflow rule holds.

**Phase 2 — mobile server + mobile page.** `src/main/mobile.js` (built-in `http`):
static files, SSE snapshot stream fed from the existing push loop, history REST, token
auth. Config keys `mobileEnabled` (default off), `mobilePort`, `mobileToken`; the
`CONFIG_SET` handler starts/stops the server like the existing `syncSessionTracker()`
pattern. Tray → "Second Screen…" shows QR + URL (pure-JS zero-dependency QR encoder —
`qrcode-generator` or vendored equivalent). The mobile page is single-column parchment:
live rows → tap for breakdown (reusing `breakdown.js`), live DPS graph (full timeline on
connect, bucket deltas in each push), and a history list → fight view (reusing
`organize.js` + the Phase 1 timeline module).

Per project convention, both new UIs (mobile page, History graph placement) get a Pencil
mockup approved before renderer work starts.

## Tasks

**Phase 0 — mockups**
- [x] Pencil mockup: History window stats pane with the timeline graph (1:1 scale, ≥15px body text) — approved by James 2026-08-15
- [x] Pencil mockup: mobile page, phone portrait — live meter screen and fight-history screen — approved by James 2026-08-15 (three frames: live meter, history list, fight view)

**Phase 1 — timeline data + History graphs**
- [x] `src/parser/encounter.js`: durable per-combatant timeline buckets (damage/healing/taken per epoch-second), populated alongside the existing rolling windows; coarsen bucket width for very long fights rather than dropping data
- [x] `enc.snapshot()`: emit `timeline` behind an opt-in flag (4 Hz overlay push stays lean); `persistEncounter()` (main.js:580) includes it in the record — additive field, no version bump
- [x] `tests/`: timeline unit tests — bucketing, mid-fight totals reconcile with aggregate damage, coarsening
- [x] `src/renderer/history/timeline.js`: pure graph math (bucket → polyline points, smoothing, axis scale) + unit tests, on the `breakdown.js`/`organize.js` model
- [x] History window: fixed-height timeline canvas in the fight-stats pane — group + selected-member curves, metric palette, "no timeline recorded" for pre-feature records, no pane reflow
- [x] `docs/changelog/` entry for the timeline work

**Phase 2 — mobile second screen**
- [x] `src/main/mobile.js`: built-in `http` server — static mobile assets, `GET /events` SSE stream, `GET /api/history` + `GET /api/history/:id`, token check on every route; LAN address discovery via `os.networkInterfaces()`
- [x] Config: `mobileEnabled` (default `false`), `mobilePort`, `mobileToken` (generated once) in `DEFAULTS` (config.js:69); `CONFIG_SET` branch starts/stops the server on change
- [x] Push loop (main.js:983): broadcast the snapshot to SSE clients alongside the three windows, including timeline bucket deltas; full timeline sent once on connect
- [x] Tray "Second Screen…" entry → small dialog with QR code + URL; add pure-JS QR encoder (`qrcode-generator`, zero transitive deps — or vendored single-file equivalent)
- [x] `src/renderer/mobile/`: single-column parchment page — live rows with tap-for-breakdown (`breakdown.js`), live graph (timeline module), history list + fight view (`organize.js`)
- [x] Setup window: MOBILE section (enable toggle, port) — display-only concerns, so no Triggers-window conflict
- [x] `tests/`: mobile server tests, WSL-side — start on 127.0.0.1, assert SSE frames, history routes, and token rejection with `fetch`
- [x] `docs/changelog/` entry for the mobile server
- [x] `scripts/dev.sh pack` and live phone check against a real session — packed; the
      renderer surfaces were verified headlessly against a replay of the live log
      (curves, breakdowns, history, token/cookie auth), and the in-game phone check is
      handed to James: enable SECOND SCREEN in Settings, tray → Second screen…, scan

## Notes

- **Execution order (2026-08-15):** every non-renderer task landed first — parser
  timeline buckets (+coarsening, in-place merge so a mid-write reference survives),
  `timeline.js` math, the mobile server (`tests/mobile.test.js` exercises it over real
  HTTP on 127.0.0.1), the vendored QR encoder (`src/renderer/vendor/qrcode.js`,
  qrcode-generator@1.4.4 MIT, UMD tail swapped for `export default`), the Second
  Screen tray dialog, and the settings section. The Pencil editor had no document open
  when execution reached Phase 0, so the two mockups are blocked on James opening
  Pencil; the History canvas and the mobile page wait on that approval, per the gate
  this plan set.
- **Everything on the phone is live, mid-fight.** Timeline buckets fill per log line as
  the fight runs (exactly like the existing rolling windows — nothing is computed at
  encounter close; close only persists the series). The phone's meter rows come from the
  same 4 Hz `buildSnapshot()` push the overlay gets, and the live graph extends every
  push via bucket deltas, trailing real time by at most the current still-open second.
  The snapshot `timeline` flag exists only to keep the *overlay window's* push lean —
  the mobile stream always gets the data. The one post-fight graph is the History
  window's, because History renders closed records by design.
- **EQBuddy's hit-lane timeline is deferred, deliberately.** Its best graph draws every
  individual hit (lane per skill, crit brightness, hollow misses). We retain no per-hit
  events — every line updates counters and is discarded (encounter.js accumulation), and
  keeping them changes memory and JSONL record size materially (a long raid fight is
  thousands of events, forever, per record). Buckets first; if the curves land well,
  revisit per-hit retention as its own plan with a size budget.
- **Payload discipline for SSE:** never re-send the whole timeline at 4 Hz (a 10-minute
  fight × 20 combatants × 3 series ≈ hundreds of KB per frame). Full series once on
  connect, then only newly closed buckets per push.
- **Firewall:** first `listen` on a LAN interface triggers the Windows Firewall prompt
  once; the user allows it and never sees it again. Worth a line in the Second Screen
  dialog.
- **Security posture:** LAN-only, random token in the URL (QR carries it). Anyone who
  has the full URL on the LAN can view combat numbers — acceptable for a DPS meter, but
  the token means a port-scan alone shows nothing.
- **History window growth:** the timeline canvas must obey the no-reflow rule — fixed
  height, rendered always, including for records that predate the feature.
- **Live overlay untouched:** no graph on the click-through overlay. It stays lean; the
  graphs live where there is a mouse (History) or a finger (phone).
- **Encoding:** log names are latin1-decoded into JS strings already; JSON over HTTP is
  UTF-8 and handles accented mob names fine.
