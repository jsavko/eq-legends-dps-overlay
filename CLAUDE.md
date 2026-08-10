# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A real-time combat overlay for **EverQuest Legends**. It tails the game's chat log
(`eqlog_<Character>_<server>.txt`), parses combat lines into typed events, aggregates them
into encounters, and floats a click-through Electron window over the game showing live
group numbers with hover breakdowns. `Ctrl+Shift+M` cycles three metrics: **damage**
(ember), **healing** (teal), **damage taken** (dried-blood red). Every encounter that
closes is persisted to a per-character JSONL history, browsable in a dedicated History
window (tray → History…).

## The two-worlds setup — read this before running anything

**Source lives in WSL. The app runs as a native Windows process.** That is what it takes
to float above the game; nothing here runs under Linux Electron. `scripts/dev.sh` bridges
the two: it rsyncs the tree to `C:\eqoverlay-dev` (excluding `node_modules`, which must be
installed by *Windows* npm to get the win32 Electron binary) and drives `npm.cmd` there.

There are three ways the app gets launched, with different staleness:

| How | Freshness |
|---|---|
| `scripts/dev.sh start` | Always current — syncs, then runs from live source |
| `C:\eqoverlay-dev\dist\win-unpacked\EQL DPS Overlay.exe` | Snapshot from the last `dev.sh pack` (or `dist`). **Syncing does NOT update it** — the source is baked into `app.asar` at build time |
| `C:\eqoverlay-dev\dist\EQL-DPS-Overlay-<ver>.exe` (portable) | Snapshot from the last `dev.sh dist` only |
| `C:\eqoverlay-dev\dist\EQL-DPS-Overlay-Setup-<ver>.exe` (installer) | Same, and the artifact other people get — it installs to `%LOCALAPPDATA%\Programs` and self-updates from there |

The user habitually launches the `win-unpacked` exe. **After any code change, run
`scripts/dev.sh pack` or the user will see no difference.** The build fails while the
overlay is running (locked files) — quit it first (tray → Quit, or
`taskkill.exe /IM "EQL DPS Overlay.exe" /F`).

`pack` is the everyday one and rebuilds *only* `win-unpacked`. **`dist` is for cutting a
build, not for seeing a fix** — the portable exe and the Setup installer are release
artifacts, and regenerating NSIS output and blockmaps after a parser change is work
nothing reads. Reach for `dist` when the user is asking for a new build (usually right
after a version bump, usually on the way to `release`).

## Commands

```bash
npm test                        # full suite, WSL-side (node --test, no Electron needed)
node --test tests/rules.test.js # a single test file
scripts/dev.sh start            # sync + run the overlay on Windows from live source
scripts/dev.sh pack             # sync + rebuild ONLY win-unpacked (the everyday one)
scripts/dev.sh dist             # sync + rebuild the Setup installer, portable exe and win-unpacked
scripts/dev.sh release          # dist, then publish v<package.json version> to GitHub Releases
scripts/dev.sh sync             # sync only (does NOT update dist builds)
node scripts/replay.js <log> --print                       # parse a log, print encounters
node scripts/replay.js <log> --write <file> --speed 5      # re-emit a log in wall-clock order; point the overlay at it and it looks live
node scripts/collect-unknown.js <log>                      # report lines no rule matched (writes unknown-lines.txt)
node scripts/backfill-history.js <log> --dir <dir>         # replay a log into the encounter history store (dedup-safe, --dry-run supported)
node scripts/gina-dryrun.js <pack.gtp> --log <log>         # replay a GINA pack against a log: per-trigger hit counts, a sample line, and the dead list
node scripts/mine-rhythms.js <log> [--write <pack.json>]   # measure boss recast intervals offline and print them as candidate triggers; writes nothing without --write
node scripts/mine-gina.js <dir> [--min 2]                  # spell names recurring across independent GINA packs; prints candidates, never writes
```

A live session's log for empirical checks:
`/mnt/c/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Rhale_oggok.txt`

Logs are **latin1**, never utf8 — EQ writes single-byte text and utf8 mangles accented mob names.

## Architecture

Data flows one way: log file → tailer → parser → snapshot → IPC push (4 Hz) → renderer.
A second, slower flow branches off at encounter close: parser `onEncounterEnd` →
JSONL history store → History window. `docs/architecture.md` walks the whole pipeline
with the actual event kinds and record shapes.

**Five windows float over or beside the game**, each with its own bounds key and none
deriving its placement from another's: the **meter** (`bounds`), the **alerts** banner
stack (`alertsBounds`, top-centre — a warning must cross your eyeline), the **boss
timers** panel (`timersBounds`, wherever you keep the buff window — a countdown is a
fixture you consult), the **History** browser (`historyBounds`), and the **Triggers**
manager (`triggersBounds`). The same snapshot is pushed to the first three. What those
three share is the *gesture*, not the position: one `applyLock` unlock makes the whole
HUD draggable, and Ctrl+Shift+H hides it together. History and Triggers are not part of
the HUD — they take real mouse input, scroll their panes, and are opened between pulls.

**`src/parser/` is pure Node — no Electron imports anywhere.** That is why the whole
scoring pipeline is unit-testable in WSL and replayable offline. Keep it that way.

- `rules.js` — ordered regex table, first match wins: one log-line body in, one typed
  event out. Chat rules come FIRST so quoted combat text in /general never scores.
  Rules emit RAW names ("You", `` Rhale`s warder ``); resolving them is not their job.
  Wording marked `(confirmed)` was verified against a real session; the rest follows
  classic EverQuest and `collect-unknown.js` exposes mismatches empirically.
- `entities.js` — raw name → canonical combatant. The big trick: pets are written
  `` <Owner>`s <type> `` with a BACKTICK, so ownership is a string split. A pet's
  canonical `name` IS its owner — pet damage folds into the owner's row at resolve time.
- `roster.js` — who counts as "us". Explicit membership (group/`/who` messages) always
  beats the implicit heuristic (player-shaped names that damage NPCs). Also holds named
  summoned pets (`Gann` → owner, learned from the pet-calls-you-"Master" line or user
  settings) and charmed mobs (charm inferred from cast + "has been charmed", break
  inferred from friendly-hits-friendly — the log has no charm-break message).
- `encounter.js` — per-fight aggregation. Opens on first friendly damage; closes on idle
  timeout, zone, or all-engaged-NPCs-slain + grace. Heals never open or extend an
  encounter (a between-pull top-up would stretch fight duration and dilute DPS).
- `index.js` (`LogParser`) — orchestrates all of the above; `feed(line)` → typed event,
  `snapshot()` → what the overlay renders. Unattributed non-melee damage is credited to
  the sole friendly with a cast in flight (2s window) or shown as an explicit "Unknown"
  row — never guessed onto a player. Fires `onEncounterEnd(encounter)` on both close
  paths (timeout/zone and all-slain+grace) but **not** on a manual reset — resets are
  deliberately unrecorded in history.

**`src/main/`** — Electron main: window management, tray, hotkeys, config
(`%APPDATA%\eq-legends-dps-overlay`), log tailer, 4 Hz snapshot pusher.
`layout.js` is pure (no Electron) so window geometry is unit-tested.
`ipc.js` is the single channel registry, imported by main and preloads alike.
`history.js` is the `EncounterStore`: append-only JSONL, one file per character
(`<userData>/history/<Char>_<server>.jsonl`), directory injected so it unit-tests
against a temp dir. Deliberately NOT SQLite — a native module is exactly the wrong
dependency for the two-worlds build, and the volume never justifies it. History write
failures toast rather than propagate; a full disk must not take the live overlay down.
`updater.js` decides what self-update this copy gets from where its exe is sitting
(`updateMode` is pure and unit-tested); `electron-updater` is imported dynamically so
that logic stays testable in WSL, where importing it would reach for Electron and throw.

**`src/triggers/` is a SIBLING of the parser, not part of it** — pure Node, same
construction rules, fed the same lines by `main.js` and merged into the snapshot
afterwards. It reads GINA trigger packages (`.gtp` — a ZIP of `SharedData.xml`), runs
them against the log, and emits warning chips and countdown rows in the shapes the
alerts and timers renderers already consume. The separation is the whole design: a pack
downloaded from a guild Discord contains arbitrary regex, and letting it near `rules.js`
would mean a stranger's pattern could shadow a combat rule or stall the tailer and take
the meter down with it. Here a bad pack costs triggers and nothing else. `engine.js`
compiles once, prefilters with `String.includes` before running a regex, and disables a
pattern that repeatedly overruns its time budget. `dryrun.js` replays a pack against the
player's *own* log and reports what actually fires — because the alternative, rewriting a
stranger's regex at import to make it match, is guessing. No new dependency: `.gtp` is
read via built-in `zlib` behind a hand-rolled ZIP reader and written as stored entries.

This is also where **the app's own boss timers** live now. `seed-pack.js` is a shipped
native pack — sixteen countdowns measured off a real server by `mine-rhythms.js` and
reviewed by hand — installed into the store on first run and thereafter an ordinary pack:
switchable, editable, exportable, and never overwritten once the player has edited it
(`pack.shipped` marks what has an upstream; `pack.edited` marks what has diverged from
it). It replaced a live estimator, `src/parser/rhythm.js`, which computed the same
medians at 4 Hz and showed the intermediate guesses; see
`docs/changelog/2026-08-08-real-triggers-not-learned-rhythms.md` for why that went and why
nobody should rebuild it.

**`src/renderer/overlay/`** — the overlay view. Holds no parser state, only the last
snapshot. Rows are reused, not rebuilt (bar transitions survive pushes). `breakdown.js`
is pure (column arithmetic, unit-tested).

**`src/renderer/timers/`** — the boss-timer panel: countdown rows in fixed slots, shaped
after EQ's buff window. Every row comes from a trigger pack — there is exactly one source
now, and the shipped boss timers are just the first pack in it. Slot lifetime lives in
`engine.js` (`since`, `state`, the spent linger), not here, so the honesty rules stay
unit-testable; this renderer only paints. A slot is claimed on the first match and never
re-sorted by what is due next; a re-match restarts it *in place* rather than adding a
second row. Numbers carry no `~`: the tilde meant "estimate" and there are no estimates
left here — an authored duration is exact, and "exact" and "right for your server" are
different claims, which is what the pack's own description is for. Between fights the
panel is *gone* — not an empty frame — except while unlocked, where the drag placeholder
shows because an empty window cannot be positioned. It is not tied to an encounter at
all: pack timers are frequently out-of-combat by nature (respawns, spell durations), so
the panel exists whenever any row does.

**`src/renderer/history/`** — the History window: three fixed panes (fight list rail →
fight stats → members + full breakdown). Every click swaps content *inside* a pane;
nothing resizes, expands, or pushes other content around — that no-reflow rule is the
window's reason to exist (its predecessor, an accordion tab in settings, was removed
for reflowing on every click). `organize.js` is the pure half (boss heuristic, filters,
day grouping, formatters), unit-tested in WSL like `breakdown.js`.

**`src/renderer/triggers/`** — the Triggers window (tray → Triggers…): three fixed panes
on History's model, and the single place that answers *what may put something on my
screen*. The rail is **sources** — the built-in rules first, then imported and authored
packs, each with its own switch; the titlebar is **surfaces** (`triggerAlerts` /
`triggerTimers`, the two global outputs, with mute beating both); the detail pane is the
one row selected. The **built-in rules are folded in as the first pack** by
`src/main/builtin-pack.js`, a pure shim that describes `castAlerts`, the six `warn*` keys,
`summonAlerts` and `ccAlerts` in pack shape and translates a row's switch back to the key
that has always backed it — the stored config is unchanged. Every one of those rows draws
chips; the boss timers used to be a row here too, and left when they became a real pack.
That is why
the settings form no longer has ALERTS or BOSS TIMERS sections: answering the same
question in two places let a pack be enabled while its surface was off, with neither
screen saying so.

**`src/renderer/setup/`** — first-run setup and the settings form. Cool slate palette;
the overlay, alerts, timers, history and triggers windows share the warm parchment palette
instead. It owns *how the overlay behaves* — log file, appearance, pets, hotkeys — and
deliberately no longer writes any alert or timer key, since a Save here would otherwise
clobber whatever the Triggers window had just set.

## Invariants that are easy to break

- **The overlay cannot scroll — anywhere, ever.** It ignores mouse input
  (click-through) so the game keeps every click; the wheel never reaches it, and any
  scrollable container is content silently gone. Everything rendered must be given real
  on-screen room: the window grows (both dimensions while the hover breakdown is open,
  up to the work area), and the ability list flows into columns when one column would
  outgrow the screen. Never "fix" an overflow with `overflow-y: auto` or a max-height.
  This applies to every click-through window — the overlay, the alerts and the timers —
  and never to the history and settings windows, which take real mouse input and scroll
  their panes internally by design. The click-through windows that do not auto-fit
  (alerts, timers) buy the same guarantee with a generously oversized invisible box
  instead of geometry code: sized for the worst realistic content at the largest text
  size, so nothing is ever clipped.
- **A boss-timer row never moves.** That window exists because the timers used to sit
  at the bottom of the alert stack, where a measured session displaced them 524 times
  and hid them behind their own cast warning 10,525 times. So: slots come from the
  engine in first-armed order and are *never* re-sorted by what is due next; a slot is
  held through every state it can reach — armed, due now, ending, lapsed — and every
  one of them renders at the same fixed row height. A second match on a trigger already
  running restarts its slot in place rather than opening a row beside it. Sorting the
  panel by `dueMs` would reintroduce the exact bug it replaced. The **one** exception is
  death: a slain caster's rows leave immediately, because a countdown for a corpse is not
  information and on the common single-boss pull the panel simply empties rather than
  shifting — arranged now by each shipped trigger naming its own caster's death line as
  an early ender, so the rule lives in a pack a player can read.
- **The history window never reflows.** Selecting a fight, member, metric or filter
  swaps content inside a fixed pane; panes must sit on the same pixel for every fight.
  (Example of the failure class: a deaths line that rendered only on death-fights pushed
  everything below it 23px — it now renders always, faint "no deaths" on clean fights.)
- **Breakdowns show EVERY ability.** No top-N slices, no "+N more" — in the overlay
  hover panel and the history window alike. A cap is how DoT damage once "disappeared"
  (credited in totals, invisible in the list).
- **Resting vs fitted bounds.** The renderer reports *measurements* (`height`,
  `extraWidth`, `panelOpen`) over `FIT_WINDOW`; main owns the resting bounds and the
  clamps. `remember` persists only resting values, and `lastFit*` distinguishes our
  moves from the player's. Deriving placement from *current* bounds is the historical
  "window climbs the screen" bug — it has now been fixed twice (vertically, then the
  horizontal twin). Round-trip tests in `tests/layout.test.js` pin this.
- **Hover works while click-through** because main polls the cursor
  (`startHoverPolling`) and sends window-relative coordinates; the documented
  `setIgnoreMouseEvents(true, {forward: true})` approach delivers nothing here. Rows
  must not move under the cursor: near the screen bottom the window bottom-anchors and
  the panel opens *above* the rows (`data-panel="above"`).
- **Honest numbers over guessed ones.** Ambiguous attribution goes to "Unknown", not to
  the most plausible player. Overhealing is exact (EQ prints `effective (potential)`),
  never estimated. Damage with no stated type stays "untyped" — a spell-name→school
  lookup table would be guessing and was deliberately not built.
- **No native modules, ever.** A native dependency would need a win32 build under
  Windows npm AND a linux build for the WSL test suite — this is why history is JSONL
  and not SQLite. Pure-JS runtime dependencies are allowed but stay rare; the only one
  is `electron-updater`.
- **Updates install on quit, never mid-session.** The overlay runs for hours during
  raids, so there is no restart prompt anywhere: an NSIS-installed copy downloads in the
  background and swaps itself when the app exits. Update notices are meter toasts, not
  cast alerts — the alerts window is for combat warnings the player must act on now.
  Only `%LOCALAPPDATA%\Programs` copies update themselves; `win-unpacked` (what James
  launches) is deliberately excluded, since "updating" it would install a second copy
  and leave the running one stale. See `src/main/updater.js`.

## Verifying renderer changes without the game

The renderer can be driven headlessly: stub `window.api` before loading `overlay.js`,
feed it a real parser snapshot (built by replaying the live log), and drive Windows
Chrome via its debug port (`chrome.exe --remote-debugging-port=9222 --headless=new`,
reachable from WSL; the chrome-devtools MCP attaches to it). Emulate the viewport for
sub-500px window sizes — headless Chrome won't resize its window below ~500px wide.
See `docs/changelog/2026-08-02-breakdown-shows-every-ability.md` for a worked example.

## Conventions

- ES modules everywhere except preloads, which must be `.cjs` (sandboxed preload +
  `"type": "module"`).
- Comments explain *why*, at length, in full sentences — match that register; a bare
  "what" comment is out of place here.
- Every completed piece of work gets a `docs/changelog/YYYY-MM-DD-<slug>.md`; plans live
  in `.claude/plans/` and are archived to `.claude/plans/archive/` on completion. The
  changelogs are the project's institutional memory — check them before re-deriving why
  something is the way it is.
- UI redesigns get a Pencil mockup approved by the user before implementation (the
  history window shipped against an approved mock; that is the expected flow).
- Version bumps are their own commits ("Bump to 0.1.2") — bump `package.json` when
  cutting a new dist for the user.
