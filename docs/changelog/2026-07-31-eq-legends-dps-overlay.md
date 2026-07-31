# EverQuest Legends Real-Time Group DPS Overlay

**Date:** 2026-07-31
**Plan:** `.claude/plans/archive/2026-07-31-eq-legends-dps-overlay.md`

Initial build of a Windows overlay that tails the EverQuest Legends chat log and shows
live per-member DPS — and healing — over the running game, with pet damage folded into
each owner's row.

## Features

### Parser core (`src/parser/`, no Electron dependency)
- **Rule table** (`rules.js`) covering melee hits and every avoidance form, attributed
  spell/skill damage, DoT ticks, damage shields, deaths, casts, heals, zoning, group
  membership and `/who`. Chat is matched **first**, so a player quoting combat text in
  `/general` can never be scored as damage.
- **Entity resolution** (`entities.js`): `You`/`YOU`/`Yourself` collapse to the logging
  character, `` <Owner>`s warder `` folds into its owner, and the same mob spelled
  `A froglok…` and `a froglok…` collapses to one key.
- **Roster** (`roster.js`): group membership from explicit log events where available,
  falling back to implicit learning from combat — which is what makes the overlay
  populate at all, since the reference session contained no group messages.
- **Encounter aggregation** (`encounter.js`): per-combatant damage, healing, hits,
  misses, crits, max hit, per-ability and per-source buckets, a separate pet sub-bucket,
  and rolling 10-second windows. Encounters close on idle timeout, zone change, or a
  short grace period after the last engaged NPC dies.
- **Duration floored at one second**, because log timestamps have one-second resolution
  and a fight resolved inside a single second would otherwise divide by zero.

### Overlay (`src/renderer/overlay/`)
- Frameless, transparent, always-on-top window, click-through by default with
  `setIgnoreMouseEvents(true, { forward: true })` so hover still works.
- **The row is the bar**: each member's damage share fills the row behind the text rather
  than occupying a separate bar column, which at 360px is the difference between fitting
  the data and not.
- Pet contribution is carved out of the end of its owner's fill in green.
- A **pace tick** marks the 1/N share an even group would each have, turning a list of
  numbers into a comparison for one pixel of cost.
- Hover breakdown with player/pet split, source types, top abilities, and accuracy.
- The window **auto-fits its height** to the rows on screen while locked.

### Setup and settings (`src/renderer/setup/`)
Auto-detects the default Logs folder, lists discovered `eqlog_*.txt` with character,
server and last-write time, preselects the most recent, and validates that a file really
parses before letting the user commit to it.

### Healing
- Per-combatant HPS, heal targets, heal abilities, and **exact overhealing** — EQ writes
  `healed X for A (B)` and prints the parenthetical only when the two differ, so the
  waste figure is real rather than estimated.
- `Ctrl+Shift+M` switches the same rows between damage and healing; both figures ride in
  every snapshot so the switch needs no parser round trip. The healing view recolors to
  teal so the modes are never confusable.

### Named summoned pets
`` Rhale`s warder `` says who owns it; a summoned pet called `Gann` does not, and is
shaped exactly like a player name. Resolved with `Targeted (NPC)` classification,
automatic detection of your own pet from its "Master" line, and a configurable
`petOwners` mapping for everyone else's. An unmapped pet keeps its own row rather than
having its damage discarded.

## Bug fixes

Found and fixed during the build, each caught by a test or by the live log:

- **Outgoing damage shields were silently dropped.** `A wan ghoul knight is pierced by
  Emalina's thorns` never resolved to Emalina, discarding 33 hits in a single fight.
- **Critical heals and critical DoT ticks parsed as nothing** — the rules lacked the
  trailing `(Critical)` modifier group. One dropped heal was 457 points.
- **Zoning wiped roster members from the finished fight still on screen**, blanking rows
  retroactively. The roster only ever *filters* rows that already exist, so the reset was
  pure downside and was removed; membership is now cleared only on a character switch.
- **A new pull was appended to the previous encounter**, because time only advanced after
  an event was handled rather than before.
- **The encounter label was lost the moment its mob died**, since the label read from the
  same set that death removed from.
- **Character-switch detection tied on identical mtimes** and never fired. Now driven by
  which log is actually *growing*, which is the question being asked, and which also
  requires our own log to have stopped growing.
- **Auto-fit measured the window back to itself**: `scrollHeight` on a flex-grown
  scroller never reports less than its stretched client height.
- **A healer whose every point overhealed was filtered out entirely** — precisely the
  case worth showing.

## Files

| File | What it is |
|---|---|
| `src/parser/timestamp.js` | `[Ddd Mmm D HH:MM:SS YYYY]` → epoch ms |
| `src/parser/rules.js` | ordered rule table → typed events |
| `src/parser/entities.js` | self-normalization, backtick pet → owner, player-name heuristic |
| `src/parser/roster.js` | group membership, pet ownership, player/NPC knowledge |
| `src/parser/encounter.js` | encounter state machine and aggregation |
| `src/parser/index.js` | `LogParser`: `feed(line)` in, `snapshot()` out |
| `src/main/main.js` | app lifecycle, windows, hotkeys, tailer wiring |
| `src/main/tailer.js` | polling tail: growth, partial lines, truncation, rotation, character switch |
| `src/main/config.js` | `userData/config.json` with defaults |
| `src/main/ipc.js` | the channel contract, shared by main and both preloads |
| `src/renderer/overlay/` | the transparent HUD |
| `src/renderer/setup/` | first-run and settings window |
| `scripts/dev.sh` | WSL → Windows sync and build driver |
| `scripts/replay.js` | replay a log offline or into a file at N× speed |
| `scripts/collect-unknown.js` | report every log line no rule matched |
| `tests/` | 124 tests, `node --test` |

## Verification

- **124 tests pass.** The end-to-end test asserts the captured froglok fight against a
  **hand-computed** table — Rhale 592 + 133 pet, Rhain 588, 1313 over 16s — so the
  pipeline is checked against an independent reading of the log rather than its own
  output.
- **Rule coverage measured, not assumed.** On a 14,059-line live session, 11,935 lines
  matched and only 2 unmatched shapes contain any combat wording; both are rune-absorb
  flavor carrying no number. The same exercise confirmed the two rules Phase 0 could not
  verify (damage shields, DoT ticks) and exposed the four gaps fixed above.
- **Verified live over the running game**, in both damage and healing views, against real
  fights.
- **Portable `.exe` builds** (70.8 MB) via `scripts/dev.sh dist`.

### Not verified

Click-through and the hover breakdown were not exercised against the live game, because
testing them means moving the player's cursor mid-fight. Both work by construction and are
covered by the IPC wiring, but they want a hands-on confirmation.

## Rationale

Electron was chosen over a native Rust or Qt overlay because every hard requirement —
transparent, topmost, click-through *with* hover interaction over a borderless-windowed
game — is a supported platform feature there rather than something to hand-build, and the
hover breakdown is a `<div>` instead of a manual hit-testing problem. The parser is kept
free of Electron imports so it can be unit-tested, replayed offline, and reused behind a
different front end.
