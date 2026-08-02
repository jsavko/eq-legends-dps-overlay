# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A real-time DPS/HPS overlay for **EverQuest Legends**. It tails the game's chat log
(`eqlog_<Character>_<server>.txt`), parses combat lines into typed events, aggregates them
into encounters, and floats a click-through Electron window over the game showing live
group damage with hover breakdowns.

## The two-worlds setup — read this before running anything

**Source lives in WSL. The app runs as a native Windows process.** That is what it takes
to float above the game; nothing here runs under Linux Electron. `scripts/dev.sh` bridges
the two: it rsyncs the tree to `C:\eqoverlay-dev` (excluding `node_modules`, which must be
installed by *Windows* npm to get the win32 Electron binary) and drives `npm.cmd` there.

There are three ways the app gets launched, with different staleness:

| How | Freshness |
|---|---|
| `scripts/dev.sh start` | Always current — syncs, then runs from live source |
| `C:\eqoverlay-dev\dist\win-unpacked\EQL DPS Overlay.exe` | Snapshot from the last `dev.sh dist`. **Syncing does NOT update it** — the source is baked into `app.asar` at build time |
| `C:\eqoverlay-dev\dist\EQL-DPS-Overlay-<ver>.exe` (portable) | Same: snapshot from the last `dev.sh dist` |

The user habitually launches the `win-unpacked` exe. **After any code change, run
`scripts/dev.sh dist` or the user will see no difference.** The build fails while the
overlay is running (locked files) — quit it first (tray → Quit, or
`taskkill.exe /IM "EQL DPS Overlay.exe" /F`).

## Commands

```bash
npm test                        # full suite, WSL-side (node --test, no Electron needed)
node --test tests/rules.test.js # a single test file
scripts/dev.sh start            # sync + run the overlay on Windows from live source
scripts/dev.sh dist             # sync + rebuild the portable exe and win-unpacked
scripts/dev.sh sync             # sync only (does NOT update dist builds)
node scripts/replay.js <log> --print                       # parse a log, print encounters
node scripts/replay.js <log> --write <file> --speed 5      # re-emit a log in wall-clock order; point the overlay at it and it looks live
node scripts/collect-unknown.js <log>                      # report lines no rule matched (writes unknown-lines.txt)
```

A live session's log for empirical checks:
`/mnt/c/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Rhale_oggok.txt`

Logs are **latin1**, never utf8 — EQ writes single-byte text and utf8 mangles accented mob names.

## Architecture

Data flows one way: log file → tailer → parser → snapshot → IPC push (4 Hz) → renderer.

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
  row — never guessed onto a player.

**`src/main/`** — Electron main: window management, tray, hotkeys, config
(`%APPDATA%\eq-legends-dps-overlay`), log tailer, 4 Hz snapshot pusher.
`layout.js` is pure (no Electron) so window geometry is unit-tested.
`ipc.js` is the single channel registry, imported by main and preloads alike.

**`src/renderer/overlay/`** — the overlay view. Holds no parser state, only the last
snapshot. Rows are reused, not rebuilt (bar transitions survive pushes). `breakdown.js`
is pure (column arithmetic, unit-tested).

## Invariants that are easy to break

- **The overlay cannot scroll — anywhere, ever.** It ignores mouse input
  (click-through) so the game keeps every click; the wheel never reaches it, and any
  scrollable container is content silently gone. Everything rendered must be given real
  on-screen room: the window grows (both dimensions while the hover breakdown is open,
  up to the work area), and the ability list flows into columns when one column would
  outgrow the screen. Never "fix" an overflow with `overflow-y: auto` or a max-height.
- **The breakdown shows EVERY ability.** No top-N slices, no "+N more". A cap is how
  DoT damage once "disappeared" (credited in totals, invisible in the list).
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
  never estimated.

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
  in `.claude/plans/` and are archived to `.claude/plans/archive/` on completion.
- Version bumps are their own commits ("Bump to 0.1.2") — bump `package.json` when
  cutting a new dist for the user.
