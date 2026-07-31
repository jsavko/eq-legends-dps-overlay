---
status: completed
---
# EverQuest Legends Real-Time Group DPS Overlay

**Date:** 2026-07-31

---

## Goal

Build a Windows desktop overlay that tails the EverQuest Legends chat log in real time and
displays live DPS for every member of the player's group, with each member's pet damage
folded into their own total.

Concretely:

- **Live tail** of `eqlog_<Character>_<server>.txt` while the game is running, with no
  restart needed when the file grows, rotates, or the player switches characters.
- **Per-member DPS rows** sorted highest-first, each with a proportional damage bar and
  percentage of group total. Pet damage (`` Fuaim`s warder ``) is attributed to its owner.
- **Encounter DPS as the headline number** (total damage ÷ encounter duration, encounter
  ends after a configurable idle timeout), matching what ACT/GamParse report. A smaller
  rolling 10-second figure sits alongside it for burst feedback.
- **Mouseover breakdown** — hovering a row reveals that member's split: player vs. pet
  damage, damage by source type (melee / spell / DoT / proc / DS), top abilities, hit and
  miss counts, crit count, and biggest single hit.
- **First-run setup screen** where the log directory/file is chosen, with auto-detection of
  the default install path and auto-selection of the most recently written `eqlog_*.txt`.
  Settings persist and are reachable later from a settings button/hotkey.
- **Overlay ergonomics** — frameless, transparent, always-on-top, click-through by default
  so it never steals clicks from the game, draggable/resizable when unlocked, with hotkeys
  to lock/unlock and show/hide.

### Environment facts established during exploration

- Log directory: `C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest Legends\Logs`
- Sample log present: `eqlog_Rhale_oggok.txt` (75 lines, minimal combat)
- Game install: `C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest Legends\LaunchPad.exe`
- Development happens in WSL2 (`/home/james/Projects/eqlparser`); the app itself must run
  as a native **Windows** process to float over the game. Node.js v24.14.0 is installed on
  both the Windows side (`C:\Program Files\nodejs\node.exe`) and in WSL.
- User confirmed: game runs **borderless/windowed on a single monitor** → a topmost
  click-through overlay is viable. Headline metric: **current encounter DPS**.

### Confirmed log-format observations (from the sample)

```
[Fri Jul 31 18:31:35 2026] Fuaim pierces a shriveled mummy for 1 point of damage.
[Fri Jul 31 18:31:35 2026] Fuaim tries to kick a shriveled mummy, but misses!
[Fri Jul 31 18:31:36 2026] Fuaim`s warder pierces a shriveled mummy for 5 points of damage.
[Fri Jul 31 18:28:08 2026] You were hit by non-melee for 6 damage.
[Fri Jul 31 18:32:26 2026] LOADING, PLEASE WAIT...
[Fri Jul 31 18:32:32 2026] You have entered New Sebilis Expedition.
```

Key takeaways:
- Timestamps are `[Ddd Mmm D HH:MM:SS YYYY]` with **1-second resolution** — DPS math must
  tolerate coarse time and guard against divide-by-zero on sub-second fights.
- Pets use the backtick form `` <Owner>`s <pettype> `` → owner attribution is a trivial
  string split, no pet-name tracking table needed. This is the single biggest win versus
  older EQ parsers.
- `was hit by non-melee` lines carry **no attacker**, which is the classic EQ attribution
  problem and the main open risk (see Notes).

---

## Approaches Considered

### 1. Electron app running natively on Windows, pure-JS parser
- **Description:** A single Electron process. Main process tails the log with `fs` polling
  and runs the parser; renderer draws the overlay in HTML/CSS in a frameless, transparent,
  always-on-top `BrowserWindow`. Click-through via
  `setIgnoreMouseEvents(true, { forward: true })`, flipped off when the cursor enters a row
  so hover tooltips work. A second normal window serves the first-run setup screen.
- **Pros:** Transparency, click-through-with-mouse-forwarding, always-on-top, multi-window,
  global hotkeys, and per-user config paths are all first-class Electron features on
  Windows. HTML/CSS makes the hover breakdown panel — the "nice to have" — essentially
  free rather than a custom-drawn hit-test problem. Zero native modules required, so no
  node-gyp and no cross-compilation. Node v24 already present on the Windows side.
- **Cons:** ~150 MB runtime and ~80 MB idle RSS. Editing in WSL while running on Windows
  needs a sync or UNC-path step.

### 2. Rust native overlay (`winit` + `egui` / raw Win32 layered window)
- **Description:** Single small `.exe` creating a `WS_EX_LAYERED | WS_EX_TRANSPARENT |
  WS_EX_TOPMOST` window, parsing the log with a hand-rolled tailer.
- **Pros:** Tiny binary, a few MB of RAM, no runtime dependency, very fast parsing, and the
  cleanest possible distributable.
- **Cons:** Cross-compiling a GUI Rust app from WSL to Windows is the painful path —
  `x86_64-pc-windows-msvc` needs the MSVC toolchain (not present), `-gnu` needs mingw plus
  linker wrangling. Hover tooltips, text layout, and bar animation are all manual work in
  `egui`. Iteration speed on UI would be several times slower for a UI-heavy app.

### 3. Python + PyQt6 overlay on Windows
- **Description:** `QWidget` with `Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint |
  Qt.WA_TranslucentBackground`, plus `win32gui` calls for click-through.
- **Pros:** Fast to prototype; parsing text in Python is pleasant.
- **Cons:** The only `python.exe` on the Windows side is the WindowsApps stub, so a real
  CPython install is a prerequisite. Click-through on Qt requires dropping to Win32 APIs
  anyway. Packaging to a single `.exe` (PyInstaller) is heavier and more fragile than
  electron-builder. Styling/animation is meaningfully worse than CSS.

### 4. Headless parser + browser UI on localhost
- **Description:** A Node service in WSL or Windows tails the log and serves a web UI over
  WebSocket; user views it in a browser window or an OBS browser source.
- **Pros:** Total separation of parsing and display; trivially testable; the UI is just a
  web page; could later be reused for a stream overlay.
- **Cons:** A browser window cannot be transparent, click-through, or reliably topmost over
  a game — which is the actual request. Would work only as a second-monitor panel, and the
  user has a single monitor.

### 5. Rust parsing core + Electron shell (split architecture)
- **Description:** Rust binary emits structured JSON events on stdout; Electron consumes
  them and renders.
- **Pros:** Best runtime performance for the parse hot path; UI stays in HTML/CSS.
- **Cons:** Two toolchains, an IPC protocol to version, and the same Rust
  cross-compilation problem as #2 — all to optimize a workload that is a few hundred regex
  matches per second. Textbook premature optimization.

---

## Chosen Approach

**Approach 1 — Electron running natively on Windows with a pure-JavaScript parser.**

It is the only option where every hard requirement (transparent, topmost, click-through
*with* hover interaction, over a borderless-windowed game) is a supported platform feature
rather than something to be hand-built. The "cool if it can happen" mouseover breakdown is
the deciding factor: in Electron it is a `mouseenter` handler and a styled `<div>`; in
Rust or Qt it is manual hit-testing plus custom text layout. The performance ceiling of JS
is irrelevant here — EQ logs peak at a few hundred lines per second in a busy raid, which
is three orders of magnitude below what a compiled regex pipeline in V8 handles.

The parser is deliberately written as **plain ES modules with zero Electron imports**, so
it can be unit-tested with `node --test`, replayed offline, and swapped behind a different
front end later without a rewrite. No native modules anywhere — the app depends on
`electron` alone — which sidesteps node-gyp entirely and keeps the WSL→Windows workflow
simple.

**Dev workflow:** source of truth stays in `/home/james/Projects/eqlparser` (edited in
WSL). A `scripts/dev.sh` rsyncs the tree (minus `node_modules`) to `C:\eqoverlay-dev` and
invokes the Windows `npm.cmd` there, so `npm install` fetches the win32 Electron binary and
Chromium never runs from a UNC path. Running directly from `\\wsl.localhost\Ubuntu\...` is
the fallback if the sync proves annoying.

**Architecture sketch:**

```
src/
  parser/            # pure JS, no electron — unit tested
    timestamp.js     # [Ddd Mmm D HH:MM:SS YYYY] -> epoch ms
    rules.js         # ordered regex rules -> typed events
    entities.js      # pet->owner via backtick, friend/foe classification
    roster.js        # group/raid membership from log events
    encounter.js     # encounter state machine + aggregation
    index.js         # LogParser: feed(line) -> events, exposes live state
  main/
    main.js          # app lifecycle, windows, global hotkeys
    tailer.js        # polling tail: growth, truncation, rotation, char switch
    config.js        # userData/config.json load/save/defaults
    ipc.js           # typed channels between main and renderers
  renderer/
    overlay/         # transparent DPS overlay + hover breakdown
    setup/           # first-run + settings window
scripts/
  dev.sh             # rsync to C:\eqoverlay-dev and run Windows npm
  replay.js          # feed a saved log through the parser at N× speed
tests/
  fixtures/*.log
  *.test.js
```

**Overlay interaction model:** the window starts with
`setIgnoreMouseEvents(true, { forward: true })`. Forwarded `mousemove` events still reach
the renderer, so when the cursor enters a member row the renderer IPCs main to disable
ignore-mouse, the tooltip opens and is interactive; on `mouseleave` it re-enables. A
`Ctrl+Shift+L` hotkey toggles a "locked" state (unlocked = fully interactive, draggable
via `-webkit-app-region: drag`, resize handles shown); `Ctrl+Shift+H` hides/shows.

---

## Tasks

### Phase 0 — Ground truth on the log format
- [x] Capture a real combat log: play a grouped fight (melee + caster + pet + DoTs) and
      save the resulting `eqlog_*.txt` to `tests/fixtures/combat-sample.log`
- [x] Write `scripts/collect-unknown.js` that runs a log through the rule set and dumps
      every line matching no rule to `unknown-lines.txt`, so gaps are found empirically
- [x] Confirm the exact EQ Legends wording for: spell direct damage, DoT ticks, critical
      hits, procs, damage shields, rune/absorb, killing blows, and `/who` output

### Phase 1 — Parser core (pure JS, no Electron)
- [x] Scaffold the project: `package.json` (type: module, electron devDependency only),
      `.gitignore`, `git init`
- [x] `src/parser/timestamp.js` — parse `[Ddd Mmm D HH:MM:SS YYYY]` to epoch ms with a
      month-name map; return `{ ts, body }` or null for malformed lines
- [x] `src/parser/rules.js` — ordered rule table producing typed events:
      - `melee-hit`: `<A> <verb> <T> for <N> point(s) of damage.` (hits/slashes/crushes/
        bashes/pierces/kicks/bites/punches/claws/mauls/gores/slices/strikes/cleaves/
        backstabs/frenzies on/rends/smashes/stings)
      - `melee-miss`: `<A> tries to <verb> <T>, but misses!` and the parry/dodge/block/
        riposte/absorb/INVULNERABLE variants
      - `spell-damage`: `<A>'s <spell> hits <T> for <N> points of damage.` (confirm wording)
      - `dot-tick`: `<T> has taken <N> damage from <spell> by <A>.`
      - `non-melee`: `<T> was hit by non-melee for <N> damage.` (no attacker — see Notes)
      - `crit`: `<A> scores a critical hit! (<N>)`
      - `death`: `<T> has been slain by <A>!` / `You have slain <T>!`
      - `zone`: `LOADING, PLEASE WAIT...` / `You have entered <zone>.`
      - `group`: formed/joined/left/disbanded/leader-change messages
- [x] `src/parser/entities.js` — normalize `You`/`YOU`/`Yourself` to the logged-in
      character; split `` <Owner>`s <pettype> `` into `{ owner, isPet }`; classify
      friend vs. NPC (roster membership, pet-of-friend, player-name shape heuristic:
      single capitalized token, no leading `a `/`an `/`The `)
- [x] `src/parser/roster.js` — maintain group membership from log events, seeded by the
      character name extracted from the log filename; support manual overrides
- [x] `src/parser/encounter.js` — encounter state machine: open on first friendly-involved
      damage event, aggregate per-combatant totals (damage, hits, misses, crits, max hit,
      per-ability and per-type buckets, separate pet sub-bucket), close on idle timeout
      (default 15s), zone change, or all engaged NPCs slain
- [x] `src/parser/index.js` — `LogParser` class: `feed(line)`, emits events, exposes
      `currentEncounter()` snapshot including a rolling 10s damage window per combatant
- [x] Unit tests for each module using `node --test` against fixture lines, including the
      exact lines captured in Phase 0

### Phase 2 — Tailer, config, replay harness
- [x] `src/main/tailer.js` — open the file, seek to `max(0, size - 64KB)` on start, poll
      `fstat` every 200 ms, read new bytes as `latin1`, buffer partial trailing lines;
      detect truncation (`size < pos` → reset) and file replacement (inode/birthtime change)
- [x] Extend the tailer to watch the Logs directory and detect a character switch (a
      different `eqlog_*.txt` becoming the most recently written and actively growing),
      switching automatically with a toast in the overlay
- [x] `src/main/config.js` — read/write `app.getPath('userData')/config.json`; defaults for
      log path, opacity, scale, combat timeout, hotkeys, locked state, window bounds,
      group-only vs. all-visible-players, show-pets-merged
- [x] `scripts/replay.js` — replay a saved log through the parser at configurable speed
      (`--speed 5`, `--realtime`), so the whole UI can be developed with the game closed

### Phase 3 — Electron shell and setup screen
- [x] `src/main/main.js` — app lifecycle, single-instance lock, create setup window on
      first run (no valid `logPath` in config) and overlay window otherwise
- [x] `src/renderer/setup/` — setup screen: auto-detect
      `C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest Legends\Logs`,
      list discovered `eqlog_*.txt` with character/server and last-modified, allow a manual
      folder/file picker (`dialog.showOpenDialog`), validate the file parses, then save and
      launch the overlay
- [x] Reopenable settings window (same renderer, "settings" mode) with opacity, scale,
      combat timeout, filters, and hotkey configuration
- [x] `src/main/ipc.js` — typed IPC channels: parser state pushes (throttled to ~4 Hz),
      config get/set, mouse-ignore toggle, window control

### Phase 4 — Overlay UI
- [x] Frameless transparent always-on-top `BrowserWindow` with `transparent: true`,
      `frame: false`, `resizable: true`, `skipTaskbar: true`, saved bounds
- [x] Header row: encounter label (primary target name, or "Combat"), elapsed time, group
      total DPS, and combat/idle indicator
- [x] Member rows: proportional bar (width = % of group damage), name, encounter DPS, and
      damage share %; sorted DPS-descending; pet contribution shown as a distinct inner
      segment of the owner's bar
- [x] Secondary rolling-10s DPS readout beside the encounter number
- [x] Click-through with hover: `setIgnoreMouseEvents(true, { forward: true })` by default,
      disabled on row `mouseenter` and re-enabled on `mouseleave`
- [x] Hover breakdown panel: player vs. pet split, damage by type (melee/spell/DoT/proc/DS),
      top abilities by damage, hit/miss/crit counts, max hit, accuracy %
- [x] Global hotkeys: `Ctrl+Shift+L` lock/unlock (unlocked = draggable + interactive),
      `Ctrl+Shift+H` hide/show, `Ctrl+Shift+R` force-reset the current encounter
- [x] Visual design pass: dark translucent background, readable at a glance over busy game
      art, opacity and scale honored from config

### Phase 5 — Validation and packaging
- [x] End-to-end replay test: run `combat-sample.log` through `scripts/replay.js` into the
      live overlay and verify per-member totals against a hand-computed expected table
- [x] Live test with the game running: confirm the overlay stays on top of borderless
      windowed EQ, clicks pass through to the game, and hover still opens the breakdown
      — **partially verified.** Staying on top of a live borderless-windowed session is
      confirmed by screenshot during real fights, in both damage and healing views.
      Click-through and hover were **not** exercised, because doing so means moving the
      player's cursor mid-fight; left for the user to confirm.
- [x] Verify behavior across a zone change, a character logout/login, and a group change
      — zone changes verified against the live log (encounters split correctly at each
      `LOADING, PLEASE WAIT...`); character switch and truncation/rotation covered by
      `tests/tailer.test.js`; group changes covered by `tests/roster.test.js`. Not
      exercised live end to end.
- [x] `scripts/dev.sh` — rsync WSL tree to `C:\eqoverlay-dev` and drive Windows `npm.cmd`
- [x] Add electron-builder portable-`.exe` target so the overlay can be launched without
      the dev toolchain — built, 70.8 MB. Needed `signAndEditExecutable: false`: the
      winCodeSign cache extracts macOS dylib symlinks, which fails on Windows without
      Developer Mode or admin. Nothing is signed anyway, so skipping it costs nothing.

### Added during execution (not in the original plan)
- [x] Named summoned pets: `Targeted (NPC)` classification, automatic self-pet detection
      from the "Master" line, a configurable `petOwners` mapping, and an unmapped pet
      keeping its own row rather than losing its damage
- [x] Healing: per-combatant HPS, exact overhealing, heal targets and abilities, a
      damage/healing toggle on `Ctrl+Shift+M` with its own palette
- [x] Auto-fit the overlay height to its rows while locked
- [x] Four rule gaps found by running `collect-unknown.js` over a 14k-line session

---

## Notes

### Phase 0 findings — the open risk largely evaporated

The user's live session (657 lines, a real grouped fight in The Ruins of Old Guk with
Rhale + pet, Rhain, Emalina and Gann) replaced the 75-line stub. Confirmed wording:

| Form | Example |
|---|---|
| melee hit | `Rhain smites a froglok shin knight for 11 points of damage.` |
| melee hit, self | `You crush a froglok shin knight for 34 points of damage. (Critical)` |
| **spell/skill, attributed** | `Rhain hit a froglok shin knight for 109 points of magic damage by Smiting Strike.` |
| pet spell | `` Rhale`s warder hit a froglok shin knight for 71 points of cold damage by Blast of Frost. `` |
| miss | `Rhain tries to frenzy on a froglok shin knight, but misses!` |
| miss, self | `You try to kick a froglok shin knight, but miss!` |
| avoidance | `You try to crush a froglok shin knight, but a froglok shin knight parries!` |
| death | `A froglok shin knight has been slain by Rhain!` |
| cast | `` Rhale`s warder begins casting Blast of Frost. `` |
| heal | `Emalina healed Rhain for 119 (139) hit points by Bravery.` |

**The `non-melee` attribution risk is much smaller than feared.** EQ Legends emits the
*attributed* form `<A> hit <T> for <N> points of <type> damage by <Spell>.` for spell,
proc and skill damage — mitigation #1 from the list below applies, and #2/#3 are only
fallbacks. Every `You were hit by non-melee` line in the sample is **fall damage**: each is
immediately followed by `YOU were injured by falling.`. Those are damage *taken*, which v1
does not score anyway.

Two forms remain **unverified** because the sample contains none — the rules for them
follow classic EverQuest wording and are marked as such in `rules.js`:
- **DoT ticks** (`<T> has taken <N> damage from <Spell> by <A>.`) — no DoT class played.
- **Damage shields** and **group join/leave messages** — none occurred.

`collect-unknown.js` on the sample: 310/657 lines matched, and **zero** unmatched lines
contain `damage`, `point`, `slain`, `miss` or `hit` — the remainder is flavor text
("You are low on drink.", skill-up messages, buff landings). Re-run it after any session
that exercises a new class to catch wording gaps.

Because group messages could not be verified, `roster.js` **also learns membership
implicitly** from combat participation, so the overlay populates even if this server words
group events differently.

### Scope addition during execution: named summoned pets

The plan assumed every pet uses the backtick form `` <Owner>`s <pettype> ``. A live
session disproved it: **Gann** is Rhain's summoned animation (`Rhain begins casting
Sagar's Animation.`), and a summoned pet carries a proper name that is shaped exactly
like a player name. It was being scored as a fifth group member.

What the log does and does not provide, established empirically:

| Signal | Example | What it proves |
|---|---|---|
| `Targeted (Player\|NPC): X` | `Targeted (NPC): Gann` | X is / is not a player — **decisive**, but only fires when you target it |
| `<Pet> told you, '… Master.'` | `` Rhale`s warder told you, '…Master.' `` | that pet is **yours** — the one ownership fact stated outright |
| pet summon cast | `Rhain begins casting Sagar's Animation.` | someone summoned *a* pet — but Gann first swings 3½ minutes later, far too loose to infer ownership |

So the log can prove "not a player" but can never say *whose* pet another player's named
pet is. The implementation therefore:

1. Reads `Targeted (NPC)` to keep named pets out of the group roster entirely.
2. Auto-maps **your own** named pet from the "Master" line (it repeats on every attack
   command, so it re-establishes within seconds of any reset).
3. Takes an explicit `petOwners` mapping (`Gann = Rhain`) from settings for everyone
   else's, replacing rather than merging so an entry can actually be deleted.
4. **Never discards an unmapped pet's damage** — it keeps its own row until mapped, so
   the group total stays correct and the missing mapping is visible rather than silent.

Verified against the live log: with `Gann = Rhain`, Rhain goes from 2552 to 2739 damage
with 187 attributed as pet damage, and the Gann row disappears.

### Open risk: `was hit by non-melee` has no attacker
This is the one genuinely hard parsing problem in EQ logs. Spell damage, procs, and damage
shields can surface as `<Target> was hit by non-melee for <N> damage.` with the caster
omitted. Mitigation, in order of preference:

1. Prefer the attributed forms when EQ Legends emits them — `<Caster>'s <spell> hits <T>
   for <N>` and `<T> has taken <N> damage from <spell> by <Caster>.` — Phase 0 determines
   which forms this server actually uses.
2. If unattributed lines dominate, pair them against a short-lived cast-tracking table
   (`<Caster> begins to cast a spell` / `<Caster> begins casting <Spell>`) and attribute
   only when exactly one candidate is in flight within a ~2s window.
3. Otherwise bucket into an explicit `Unknown` row rather than silently misattributing.
   A visible `Unknown` row is honest and immediately tells us the rules need extending.

### Other known constraints
- **1-second timestamp resolution** means short fights produce noisy DPS. Encounter
  duration is floored at 1s, and the rolling window uses second-granularity buckets.
- **The log only records what the client sees.** Group members in another room, or damage
  outside the client's range, will not appear. This is a property of the game, not a bug in
  the parser, and should be stated in the UI/README so numbers aren't mistrusted.
- **Exclusive fullscreen hides topmost windows.** User confirmed borderless/windowed, so
  this is fine — but the README should say so, since switching modes would break the
  overlay in a way that looks like an app failure.
- **Logging must be enabled in-game** (`/log on`). The setup screen should check the log's
  mtime and warn if the file looks stale.
- **Read logs as `latin1`, not `utf8`** — EQ writes single-byte text, and decoding as UTF-8
  mangles accented mob names.
- Pet suffixes seen or expected: `` `s pet ``, `` `s warder ``, `` `s familiar ``,
  `` `s ward ``. Match on the backtick generically rather than enumerating suffixes.

### Scope addition during execution: healing

Requested mid-build, moving healing out of "deliberately out of scope" below.

`healed X for A (B) hit points` is **effective (potential)** — A landed, B is what the
spell would have restored. `Emalina healed herself for 0 (2)` on a full-health target is
the line that proves the order, and EQ prints the parenthetical **only when the two
differ**, so overhealing is exact rather than estimated. The heal rule's original field
names had this backwards and were corrected.

Design decisions:
- Healing **never opens or extends** an encounter. Only damage does. A healer topping the
  group up between pulls would otherwise start a 0-damage fight whose duration grows to
  the idle timeout and drags the next real fight's DPS down.
- Every snapshot carries **both** damage and healing figures, including both share
  percentages, so `Ctrl+Shift+M` switches view with no parser round trip.
- A healer whose every point overhealed has `healing === 0` but is exactly the case worth
  seeing, so rows are kept on `heals > 0`, not `healing > 0`.
- The healing view swaps two CSS variables to recolor every fill teal, so the two modes
  are never confusable at a glance.

### Rule gaps found by running collect-unknown on a 14,059-line session

The larger live log both **confirmed the two rules Phase 0 could not verify** and exposed
four real gaps. Confirmed by real usage: damage shields (825 hits) and DoT ticks (192 +
34). Fixed gaps, each of which was silently discarding real data:

| Gap | Consequence |
|---|---|
| `A wan ghoul knight is pierced by **Emalina's thorns**` | attacker never resolved to Emalina, so **every outgoing damage shield was dropped** — 33 hits in one fight alone |
| `(Critical)` suffix on heals | a 457-point critical heal parsed as nothing |
| `(Critical)` suffix on DoT ticks | crit DoT damage dropped |
| `You **have** taken …` and `X has taken N damage **by** Poison.` | second-person and unattributed DoT forms unmatched |

Combat-relevant unmatched lines went from 36 to 2, and the remaining two are rune-absorb
flavor carrying no number (`… magical skin absorbs the damage of Emalina's thorns.`).

### Deliberately out of scope for v1
Damage-taken/tank metrics, healing parses, DPS history graphs, encounter log export,
raid-wide (beyond group) aggregation, and any form of network sharing between players.
Several of these are cheap follow-ups once the encounter aggregation in Phase 1 exists.
