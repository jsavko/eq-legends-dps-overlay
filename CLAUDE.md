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
node scripts/mine-buffs.js <log> [--write <pack.json>]     # measure how long YOUR OWN effects last, pairing landing prose with wear-off prose; writes nothing without --write
node scripts/mine-drops.js <log> [--min 1] [--dir <quests dir> --write]  # learn mob -> quest item -> count from a log; the drops popup's backfill, print-only without --write
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

**Windows float over or beside the game**, each with its own bounds and none deriving
its placement from another's: the **meter** (`bounds`), the **alerts** banner stack
(`alertsBounds`, top-centre — a warning must cross your eyeline), **any number of timer
boxes** (positions in `timers.json`), the **History** browser (`historyBounds`), the
**Triggers** manager (`triggersBounds`) and the **Timers** manager (`timerSetupBounds`).
The meter and the alerts share the *gesture*, not the position: one `applyLock` unlock
makes them draggable, and Ctrl+Shift+H hides the HUD together. History, Triggers and
Timers are not part of the HUD — they take real mouse input, scroll their panes, and are
opened between pulls.

**Timer boxes are the player's, and the boss timers are one of them.** `src/timers/` is a
fourth sibling of the parser — pure Node, fed the same lines, knowing nothing about
encounters or packs. A timer is four things: a name, the log text that starts it, how long
it runs, and which box it draws in; plus a colour, which belongs to the **bar** and not to
the box, because boxes are told apart by where they are and what they are called while
what you need mid-pull is which bar is which. The player makes boxes, names them, colours
the bars and places them; `boss` is the one box that ships prebuilt and gets its rows from
the trigger packs instead of from anything they typed. `src/renderer/timerbox/` renders
them all, told which it is by `?category=<id>` on its file URL, and the Timers window
(`src/renderer/timersetup/`, tray → Timers… or Ctrl+Shift+T) is the single place they are
made, named, coloured, sized and placed.

**A box's SIZE is the player's too** — width, row height and text size, three independent
numbers per box stored beside its position in `timers.json`. Independent because "wide box,
tight rows" and "narrow box, big text" are both layouts somebody wants and one multiplier
can express neither. `boxLook()` in `src/timers/model.js` is the whole of the arithmetic:
stored value × the global `scale`, clamped, computed in main and pushed to the box with
its rows. The defaults (296 / 30 / 13) are what the old fixed em-based chrome computed
to, so an untouched box is the panel that shipped, pixel for pixel.

Two things a timer box does that no other click-through window does, both from one
requirement — it has to be draggable, and a draggable window is not click-through:

- **It is sized to its content.** Every other panel buys safety with a generously
  oversized invisible box, which is fine while click-through and disastrous the moment it
  is not: an invisible rectangle swallows every click landing in the empty part of it,
  including clicks meant for a window behind it. The renderer measures itself and
  `TIMERS_FIT` resizes the window, so an idle box is nothing at all.
- **Placement is a MODE.** `Arrange on screen` in the Timers window makes every box solid,
  named and grabbable at once. Unlocking the whole HUD and hoping is not a way to find a
  window that draws nothing between fights.

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
  A second marker with no ownership in it: any pet that is not your own is written
  `<base> pet` ("a ghoul pet"), hostile pets included, so the suffix is stripped only to
  normalize lookup keys and never decides whose side anything is on.
- `roster.js` — what the session has learned about who is who. It does **not** decide
  whose damage counts (the fight does); it SEEDS that decision on the first line of a
  pull and answers identity questions the fight cannot. Facts first (logging character,
  party list), then what the game stated (group/`/who`/`Targeted`), then channel chat,
  then the implicit set. Also holds named summoned pets (`Gann` → owner, learned from
  the pet-calls-you-"Master" line or user settings) and charmed mobs. Charm is inferred
  from cast + "has been charmed"; it ends on "Your <spell> spell has worn off of <mob>."
  for your own charm and by friendly-fire inference for everyone else's. Mob-named pets
  are charm-scoped by definition: every path that learns one (the Master line, the typed
  `pets` command) writes the transient charm store, never the durable `petOwners`, and a
  mapping write evicts that name from every other store — mappings override, they do not
  layer. See `docs/changelog/2026-08-13-charm-scoped-pet-mappings.md`.
- `encounter.js` — per-fight aggregation, and the home of `engagedNpcs`: the fight's
  enemy set, which is the axis all scoring turns on. Opens on the first damage line that
  can be placed; closes on idle timeout, zone, or all-engaged-NPCs-slain + grace. Heals
  never open or extend an encounter (a between-pull top-up would stretch fight duration
  and dilute DPS).
- `index.js` (`LogParser`) — orchestrates all of the above; `feed(line)` → typed event,
  `snapshot()` → what the overlay renders. **The scoring rule is one sentence: damage on
  the mob we are fighting counts, whoever landed it; damage from it is damage somebody
  took.** Unattributed non-melee damage is credited to
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

**`src/renderer/timerbox/`** — one timer box, and the renderer for all of them. The bar
IS the row: one line, the name left, the time right, the bar draining right-to-left
underneath both, and **the text inside the bar painted in a contrasting colour** so the
row reports its progress twice — by the bar's edge and by where the letters flip. That is
two identical text layers, one inside a mask whose width is the same fraction as the bar,
both transitioning `width` so they cannot drift apart — which is also why `.row .body`
must track `--box-width` rather than name a number: a duplicate that re-wrapped at some
other width would show different words from the layer beneath it. Chrome is the old boss
panel's to the pixel by DEFAULT, because that panel is now one of these boxes and a new
box should arrive looking like the one the player already knows; width, row height and
text size then come in with every push (`--box-width`, `--row-height`, `--box-font`) and
everything else is `em` against them. Slot lifetime lives in
`src/timers/runtime.js`, not here; this renderer only paints, measures itself and reports
its size.

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
instead. It owns *how the overlay behaves* — log file, appearance, party list, pets, hotkeys — and
deliberately no longer writes any alert or timer key, since a Save here would otherwise
clobber whatever the Triggers window had just set.

The **party list** is the only thing that hides a row, and it hides rows *only*: empty (the
default) shows everyone the log produces, and a filled-in list shows exactly those names.
It replaced a `groupOnly` switch that filtered on membership the parser had INFERRED from
group join/leave lines — which fails closed and fails silently, since anyone already in the
group when logging began is never in `explicit`. `roster.inParty()` is read where rows are
chosen and by nothing in the scoring path, so hiding somebody changes no attribution:
clear the list and it is the same fight with more rows.

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
- **A timer row never moves — in any box.** That window exists because the timers used to sit
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
  an early ender, so the rule lives in a pack a player can read. All of it applies
  identically to the player's own boxes, and it is *why* they are separate boxes: a buff
  is cast during the pull-in, before the boss has cast anything, and at 146 seconds it
  outlasts most pulls — so in one shared list it would claim the top slot and hold it for
  the whole fight. Not hypothetical: two mob self-buffs once held both slots on a Plane of
  Fear pull for fifteen minutes while Maestro of Rancor's Superior Healing, the cast that
  undoes the kill, armed last and drew below them.
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
- **Every renderer script must parse as an ES MODULE.** `node --check some.js` parses a
  `.js` file as CommonJS, where a duplicate function declaration is legal; every renderer
  here is loaded with `<script type="module">`, where it is a SyntaxError. A file that
  fails this opens its window, attaches its preload, and never runs a line of its own —
  which looks exactly like a panel with nothing to show, and is undetectable from main.
  `tests/renderer-modules.test.js` copies each file to `.mjs` before checking it, because
  the extension is what selects the grammar.
- **A timer's duration comes from the player's own log, never from a table.** Buff length
  in EverQuest depends on the caster's level, on the RANK of the spell — `Spirit of the
  Puma V` and `VI` differ by thirteen seconds in one session of the live log — and on
  which AAs they have bought. A shipped spell table would be wrong for everybody in a
  slightly different way, and wrong in the direction that matters: a countdown that ends
  before the buff does is worse than none, because you learn to trust it first.
  `mine-buffs.js` measures instead, and discovers its pairs rather than knowing them —
  a landing line is prose that follows one of YOUR cast lines, a wear-off is what
  consistently follows it, and the duration is last-land → wear-off because a recast
  REFRESHES. Measuring from the first land of a cycle turns one number into a range.
- **Honest numbers over guessed ones.** Ambiguous attribution goes to "Unknown", not to
  the most plausible player. Overhealing is exact (EQ prints `effective (potential)`),
  never estimated. Damage with no stated type stays "untyped" — a spell-name→school
  lookup table would be guessing and was deliberately not built.
- **The fight decides who counts, not the roster.** Damage landing on the mob this
  encounter is against counts, whoever landed it; damage coming from that mob is damage
  somebody took. There is no friend test anywhere in the scoring path, because that
  question was never the one that mattered and answering it wrong deleted people — a
  water elemental lost 69,394 damage and its whole row for swinging once at a charmed
  group member. `Encounter#engagedNpcs` is the axis and it is per-pull; `standing()` in
  the parser exists ONLY to seed the first line of a fight, and a wrong answer there
  costs a column for one fight rather than a person for a session. Consequences worth
  knowing: a charmed mob helping kill the boss gets its own row (its charmer often
  cannot be identified, and discarding it cost 84,676 damage in the live log), and a
  charmed member's swings land in the victim's damage-taken rather than in anybody's
  DPS. See `docs/changelog/2026-08-10-the-fight-decides-who-counts.md`.
- **Name shape answers one way only.** `looksLikeMobName` says "certainly a mob"; nothing
  says "certainly a player". "Bzzazzt" is a Plane of Sky bee spelled exactly like a
  player name, and reading that shape as friendly is what made a whole raid zone score
  nothing. A bare capitalized token is left unanswered for the fight to place.
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
