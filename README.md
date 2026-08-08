# EQL DPS Overlay

A real-time combat overlay for **EverQuest Legends**. It tails your chat log and floats
click-through windows over the game: live group numbers with hover breakdowns, a warning
when a boss starts casting something you need to interrupt, countdowns for what it will
cast next, and a browsable history of every fight you have had.

![the overlay over the game](docs/overlay.png)

## What is on screen

Five windows. Three of them ignore the mouse entirely so the game keeps every click, and
they move together: `Ctrl+Shift+L` unlocks the whole HUD for dragging, `Ctrl+Shift+H`
hides it. Each remembers its own position — the meter, the warnings and the countdowns
belong in three different places on your screen, and none of them derives its placement
from another. The other two windows — History and Triggers — take real mouse input and
are opened between pulls.

### The meter

- **Encounter DPS** as the headline number — total damage ÷ fight duration, the same
  figure ACT and GamParse report — with a rolling 10-second reading beside it for burst
  feedback.
- **One row per member**, sorted highest first. The row *is* the bar: its fill is that
  member's share of group damage, and a pet's contribution is carved out of the end of
  its owner's fill in green.
- **Three metrics.** `Ctrl+Shift+M` cycles **damage** (ember) → **healing** (teal) →
  **damage taken** (dried-blood red). The colors are the point: no two views are
  confusable at a glance.
- **Hover any row** for the full breakdown: player vs. pet split, damage by source, every
  ability, hits, misses, crits, accuracy and biggest hit — or, in healing mode,
  overhealing, efficiency and who you healed.
- **Click-through by default**, so it never steals a click from the game.

The **damage taken** view answers "what is killing me": per-victim totals and DTPS over
the same encounter clock as DPS, who is hitting you and with what, the damage type each
ability deals and the resist that mitigates it (FR/CR/MR/PR/DR, "armor" for melee),
deaths with their killer, and dodges, parries, ripostes and blocks counted separately. A
pet's beating folds into your row and stays split out, exactly like its damage.

### Alerts

Top-center, across your eyeline, because a warning you have to go looking for is not a
warning. When a hostile NPC starts casting, a chip appears ranked by how urgently the
group should react: an alarm-red **INTERRUPT** banner for heals, charm, mez, fear and
gate; an amber line for stuns, roots, snares and Harm Touch; a calm compact line for
nukes, lifetaps, dispels and every spell not in the table. A warning clears the moment
the log confirms an interrupt, when the caster dies, on zoning, or after six seconds.

This works because EQ Legends prints real spell names for NPC casts — "A cyclops begins
casting Instill." — where classic EverQuest printed an anonymous "begins to cast a
spell." Nothing here is guessed; an unlisted spell is shown by name rather than hidden.

Three presets decide how much of that you see (Essential / Balanced / Everything), and
six switches underneath decide it exactly: heals & gates, mez/charm/fear, big hits,
roots/snares/stuns, routine nukes & lifetaps, and unrecognized casts. There are also
separate announcements for **summons** ("you have been summoned") and for **crowd
control landing on your group**. `Ctrl+Shift+A` mutes the lot for one pull without
losing any of those choices.

### Boss timers

A panel of countdown rows in fixed slots, shaped after EQ's own buff window, placed
wherever you keep that window — a countdown is a fixture you consult, not an event.

**A row never moves.** Slots are claimed in first-armed order and are never re-sorted by
what is due next; a second cast of the same spell restarts its slot in place rather than
opening a row beside it. That rule is the window's entire reason to exist: these
countdowns used to sit at the bottom of the alert stack, where a measured session
displaced them 524 times and hid them behind their own cast warning 10,525 times. The one
exception is death — a slain caster's rows leave at once, because a countdown for a corpse
is not information.

Every row comes from a trigger pack, including the sixteen the app ships with. Those were
measured by `scripts/mine-rhythms.js` over 983,057 lines of one character's own logs on
oggok and then reviewed by hand — no number here was read off a spell table, and none is
an estimate. They are exact about that server and possibly wrong about yours, which is
why the pack is an ordinary editable pack rather than something baked in. Between fights
the panel is *gone* rather than empty.

### History (tray → History…)

Every encounter that closes is appended to a per-character JSONL file under
`%APPDATA%\eq-legends-dps-overlay\history`, and the History window browses the lot: a
searchable fight list grouped by day with All / Bosses / Deaths / Today filters, a stat
strip per fight (dealt, healed, taken, deaths), and the complete breakdown for any member
in any of the three metrics.

Three panes, fixed. Selecting a fight, a member, a metric or a filter swaps content
*inside* a pane — nothing resizes, expands or pushes anything else around, and a pane
sits on the same pixel for every fight. Its predecessor was an accordion inside settings
and reflowed the page on every click, which is why it is not one any more.

### Triggers (tray → Triggers…)

The one place that answers *what is allowed to put something on my screen.* The left rail
is **sources** — the built-in rules first, then every pack you have imported or written,
each with its own switch. The titlebar is **surfaces**: chips and timers, the two outputs
a pack can draw to, with mute beating both. The detail pane is the row you selected.

The rules this app ships with are folded in as the first pack, so the alert switches
described above and the boss timers live here alongside a stranger's pack, answering the
same question in one screen instead of two.

## Trigger packs (GINA)

The overlay reads **GINA trigger packages** (`.gtp`) — the file guilds pass around in
Discord — runs the triggers inside them against your log, and draws what fires as
warning chips and countdown rows. It writes them back out too, so a trigger authored here
still opens in GINA and EQ Nag.

- **Import…** in the Triggers window takes a `.gtp` and reports what it got.
- **+ New pack** and **+ New trigger** author your own; **Export…** hands one to somebody
  else.
- An imported pack shows **what actually fired against your own log** — a hit count
  against a stated number of lines, plus a sample line and the list of triggers that
  never matched anything. Checking it from the command line:

  ```bash
  node scripts/gina-dryrun.js /path/to/pack.gtp --log "/path/to/eqlog_You_server.txt"
  ```

  The dead list is reported rather than fixed on purpose: rewriting a stranger's regex at
  import to make it match is guessing about what they meant.

A pack is a stranger's arbitrary regex, so `src/triggers/` is a **sibling** of the parser
and not part of it. It gets fed the same lines and merged into the snapshot afterwards,
which means a catastrophically backtracking pattern costs you triggers and nothing else,
instead of stalling the tailer and taking the meter down with it. The engine compiles
once, prefilters with a plain substring test before running any regex, and disables a
pattern that repeatedly overruns its time budget. `.gtp` is a ZIP of XML, read and written
with built-in `zlib` — no new dependency.

To re-measure a boss's recast interval from your own logs and see it written out as a
candidate trigger:

```bash
node scripts/mine-rhythms.js "/path/to/eqlog_You_server.txt"
```

It prints and writes nothing without `--write`.

## Sending it to someone else

Every release ships two Windows builds of the same code, and which one you take decides
whether you ever have to think about updates again:

- **`EQL-DPS-Overlay-Setup-<version>.exe`** — the installer, and what to hand someone.
  It installs to `%LOCALAPPDATA%\Programs` without asking for admin, then **keeps itself
  up to date**: it checks GitHub on launch and every four hours, downloads a new version
  in the background, and installs it the next time you quit. Never mid-session — this
  thing is on screen during raids.
- **`EQL-DPS-Overlay-<version>.exe`** — the portable build (~78 MB). No installer, no
  Node, no dev toolchain: copy the file and run it. A single self-contained exe cannot
  replace itself, so this one only *tells* you when a new version is out and leaves the
  download to you.

Both come from `scripts/dev.sh dist`, into `C:\eqoverlay-dev\dist`. `scripts/dev.sh
release` builds them and publishes the lot to
[GitHub Releases](https://github.com/jsavko/eq-legends-dps-overlay/releases), which is
where the updater looks.

Neither build is **code-signed**, so Windows SmartScreen shows "Windows protected your
PC" the first time: *More info* → *Run anyway*. Signing needs a paid certificate. That
click is once per person, not once per version — automatic updates arrive without the
mark-of-the-web that triggers the warning.

On first launch it opens the setup screen, finds the default Logs folder, and preselects
whichever `eqlog_*.txt` was written most recently — so on a machine with several
characters it lands on the one being played, and any of the others can be picked from the
list. Settings live in `%APPDATA%\eq-legends-dps-overlay`, separate from the app itself,
alongside your encounter history and your trigger packs.

## Running it

```bash
scripts/dev.sh install     # sync to C:\eqoverlay-dev and install (first time)
scripts/dev.sh start       # run the overlay
scripts/dev.sh dist        # build installer + portable .exe into C:\eqoverlay-dev\dist
scripts/dev.sh release     # dist, then publish this version to GitHub Releases
scripts/dev.sh test        # run the test suite in WSL
```

Source is edited in WSL; the app runs as a native Windows process, because that is what
it takes to float above the game. `dev.sh` mirrors the tree to `C:\eqoverlay-dev` and
drives the Windows `npm` there so `npm install` fetches the win32 Electron binary.

Reopen the settings screen any time from the tray to change log file, opacity, text size,
combat timeout, post-kill wait, group filtering, pet ownership and hotkeys. It no longer
holds any alert or timer switch — those all live in the Triggers window now, so that a
Save here cannot clobber what you just set over there.

### The tray icon

The overlay is frameless and stays out of the taskbar, so the **tray icon** is its home —
three amber bars in the notification area. Right-click it for:

- which character is being followed
- show / hide and lock / unlock, with checkmarks for the current state
- cycle to the next metric
- reset the current encounter
- **Alerts ▸** — mute, and a switch for every category: interrupt warnings (with the
  three presets and six groups under *Warn about*), summon announcements, crowd control
  on the group, trigger packs, the sound cue, and the boss timer panel
- **Triggers…**, **History…**, **Settings…**
- **Quit**

Windows 11 files new tray icons into the hidden overflow, so the first time you look it
will be behind the **^** chevron next to the clock. Drag it onto the taskbar to pin it
there, or go to Settings → Personalisation → Taskbar → Other system tray icons.

Everything in that menu is also on a hotkey, and the overlay grows its own row of buttons
when unlocked.

### Hotkeys

| | |
|---|---|
| `Ctrl+Shift+L` | Lock / unlock. Unlocked, the HUD can be dragged and resized and the overlay's buttons appear. |
| `Ctrl+Shift+H` | Show / hide the whole HUD. |
| `Ctrl+Shift+R` | Reset the current encounter. |
| `Ctrl+Shift+M` | Cycle damage → healing → damage taken. |
| `Ctrl+Shift+A` | Mute / unmute alerts, without changing which ones are switched on. |

All five are rebindable in settings.

## Things worth knowing

These are properties of EverQuest, not bugs in the overlay, but they will look like bugs
if you do not know about them.

**Logging must be on.** Type `/log on` in game. The setup screen warns you if the log
file looks stale.

**The log only records what your client sees.** A group member fighting in another room,
or damage beyond your client's range, never reaches the log and cannot be counted. Your
numbers can legitimately disagree with someone else's parse of the same fight.

**Exclusive fullscreen hides the overlay.** Run the game borderless/windowed. No
always-on-top window can draw over an exclusive-fullscreen application on Windows.

**Named pets need to be told apart from players.** A pet called `` Rhale`s warder `` is
folded into Rhale automatically — the name says who owns it. A *summoned* pet gets a
proper name like `Gann`, which is shaped exactly like a player name, and the log never
says whose it is. Your own pet is detected automatically the first time it reports to you
as "Master", other players' are usually worked out from the summon line, and the rest can
be mapped under **Named pets** in settings:

```
Gann = Rhain
```

You can also map one without leaving the game by typing `pet Gann = Rhain` into any chat
channel. Until a pet is mapped it keeps its own row — its damage is still counted, never
silently dropped.

**Charmed mobs are credited to the charmer.** A charmed mob keeps its mob name
(`a tal ghoul wizard`) but fights for you, and its damage counts as the charmer's pet
damage. EverQuest Legends announces `a tal ghoul wizard has been charmed.` but names no
caster, so the charmer is identified as the friendly whose in-flight spell was a charm
spell — matching on the spell name, since several people are usually casting at once.
With no charm spell in flight, nobody is credited rather than a guess being made.

There is **no charm-break message in the log at all**, so the end of a charm is inferred:
the ex-pet hitting the group, the group hitting it, its death, or zoning. Two limitations
follow. Mob names are generic, so if two `a tal ghoul wizard` are up and one is charmed,
the other's damage is credited too. And because a break is only noticed on the next
relevant line, a few swings after a silent break can land on the charmer.

**Overhealing is exact.** EverQuest writes `healed Rhain for 119 (139) hit points` —
what actually landed, then what the spell would have restored — and prints the
parenthetical *only* when the two differ. So a heal with a single number wasted nothing,
and overhealing is a real figure rather than an estimate. A healer whose every point
overhealed still gets a row, showing 0 healing and their overheal: that is the case most
worth seeing, so it is never filtered out.

**Healing never starts or extends a fight.** Only damage does. Otherwise topping the
group up between pulls would open an encounter with no damage in it, whose duration then
grows until the idle timeout and drags the next real fight's DPS down.

**Damage with no stated type stays untyped.** DoT ticks and verbs like "pierced" name no
element, so the taken view shows them as untyped rather than looking the spell up in a
table somebody wrote — that would be guessing, and it is deliberately not built.

**Timestamps have one-second resolution.** Very short fights therefore produce noisy DPS.
Encounter duration is floored at one second so a burst inside a single second reports as
"all of it in one second" rather than dividing by zero.

**An `Unknown` row means damage could not be attributed.** EverQuest Legends names the
caster on essentially all spell and proc damage, so this should be rare. Unattributed
non-melee damage goes to the sole friendly with a cast in flight, or to `Unknown` — never
onto the most plausible player. If it appears often, the rules need extending — see below.

**The shipped boss timers were measured on one server.** They are exact numbers, not
estimates, but "exact" and "right for your server" are different claims. Every one is
editable in the Triggers window, and `scripts/mine-rhythms.js` will re-measure them from
your own logs.

## When the numbers look wrong

`collect-unknown.js` reports every log line no rule matched, grouped by shape:

```bash
node scripts/collect-unknown.js "/path/to/eqlog_You_server.txt"
```

Anything in `unknown-lines.txt` containing `damage`, `hit` or `slain` is a gap in
`src/parser/rules.js`. On the reference session, 310 of 657 lines matched and **zero**
unmatched lines contained any combat wording — the rest is flavor text.

To work on the UI with the game closed, replay a saved log into a file and point the
overlay at it:

```bash
node scripts/replay.js tests/fixtures/combat-sample.log --print
node scripts/replay.js tests/fixtures/combat-sample.log --write /tmp/eqlog_Rhale_oggok.txt --speed 5
```

`--print` parses the whole log and prints every encounter it found, which is the quickest
way to check a parsing change against a real session. `--write` re-emits the log in
wall-clock order, so the overlay reading that file cannot tell it from a live session.

To pull fights out of a log you already have and into the history store:

```bash
node scripts/backfill-history.js "/path/to/eqlog_You_server.txt" --dir <history dir> --dry-run
```

Logs are **latin1**, never utf8 — EQ writes single-byte text, and utf8 mangles accented
mob names.

## How it is put together

```
src/parser/       pure ES modules, zero Electron imports — unit tested with node --test
  timestamp.js    [Ddd Mmm D HH:MM:SS YYYY] -> epoch ms
  rules.js        ordered regex table -> typed events (chat first, so quoted combat is safe)
  entities.js     "You" -> your name; <Owner>`s <pet> -> owner
  roster.js       who counts as "us"; pet ownership; charm tracking; player vs NPC
  encounter.js    fight state machine; damage, healing and damage-taken aggregation
  spellwatch.js   NPC spell name -> category and urgency, for the cast warnings
  index.js        LogParser: feed(line) in, snapshot() out
src/triggers/     a SIBLING of the parser, same rules: pure Node, injected store dir
  gina.js         .gtp / SharedData.xml -> normalized triggers
  engine.js       compile once, substring-prefilter, budget out a runaway pattern
  seed-pack.js    the sixteen boss timers this app ships with
  dryrun.js       replay a pack against your own log and report what fired
src/main/         Electron main: windows, tray, tailer, config, IPC, hotkeys
  layout.js       window geometry, pure so it unit-tests
  history.js      EncounterStore: append-only JSONL, one file per character
  builtin-pack.js the shipped rules described in pack shape, for the Triggers window
  updater.js      what self-update this copy gets, from where its exe is sitting
src/renderer/     overlay, alerts, timers, history, triggers, setup
```

The parser has no Electron dependency on purpose: it can be tested offline, replayed, and
put behind a different front end without a rewrite. History is JSONL and not SQLite, and
`.gtp` is read with built-in `zlib` and not a ZIP library, for the same reason — **no
native modules, ever.** One would need a win32 build under Windows npm *and* a linux build
for the WSL test suite. The only runtime dependency is `electron-updater`, which is pure
JS.

`docs/architecture.md` walks the whole pipeline with the actual event kinds and record
shapes. `docs/changelog/` is the project's institutional memory — every piece of work has
an entry explaining what changed and why, including the things that were removed.

## Not in this version

Tank-specific metrics, DPS graphs over time, encounter export to a file, raid-wide
aggregation beyond your group, and any network sharing between players.
