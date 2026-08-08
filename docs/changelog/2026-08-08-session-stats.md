# Session stats: the non-combat half of a play session

**Date:** 2026-08-08
**Plan:** `.claude/plans/archive/2026-08-08-session-stats.md`

## Summary

The overlay could tell you everything about a fight and nothing about a night. It now
parses the other axis — kills, loot, coin, experience, ability points, faction, skill-ups
and zones — aggregates it into play sessions, persists them per character, and browses
them in a window of their own. The whole thing is off by default and every category has
its own switch.

The work came out of a comparison with [EQBuddy](https://github.com/DranakCorps-bot/EQBuddy)
(MIT, .NET/WPF, same game, same log format). Where the two overlap — DPS/HPS, per-ability
breakdowns, pet attribution, alerts, auto-update, per-fight history — we were at parity or
ahead. The gap was entirely non-combat: not one line in this codebase knew what a coin
drop or an XP tick looked like, and all of them were sitting in the live log. That gap is
now closed.

Nothing here copies their code. Every rule below was read off James's own log; `eqconfig.js`
reimplements a described behaviour, not a file.

## The architecture: a second sibling of the parser

`src/session/` is a peer of `src/parser/` and `src/triggers/`, on exactly the terms
`src/triggers/` already established: pure Node, no Electron imports, fed the same lines by
`main.js`, merged into the snapshot afterwards. Session accounting and combat scoring fail
in different ways and must not be able to break each other — and the combat parser, the
file that has to stay auditable for attribution bugs, is untouched by any of it.

**The chat guard needed no second chat table.** `rules.js` classifies speech FIRST by
design, so the tracker is fed `(line, parserEvent)` and skips anything the parser already
called speech. One condition, and "chat first" goes on living in exactly one place.

That guard was wrong in its first draft, in a way worth recording: the parser's chat rule
emits **two** kinds — `chat`, and `player-proof` when the channel itself proves the speaker
is a real player — so a check on `kind === 'chat'` let every guild, group, raid and auction
line straight through, and a quoted kill line in guild chat scored. The guard is now on the
rule id, via a new `CHAT_RULE_IDS` export, and a test quotes all 21 sample lines on all 10
channels a person can talk on.

## The experience honesty rule

EverQuest prints experience as a percentage **of the current level** and nothing else.
There is no absolute number in the log, anywhere. So:

- `%/hr` is real and useful *within* a level.
- Summing across a level boundary is meaningless: 12% at 27 and 12% at 28 are different
  amounts of experience, and adding them produces a number that describes nothing.
- **Time-to-level is honest only from an anchored segment** — one that began with a
  level-up, and therefore at a known 0%. A session that started mid-level knows what was
  gained and not how far in it began.

Experience is therefore stored as a ledger of per-level segments with an `anchored` flag,
and there is no session-wide XP total anywhere in the record, the store, or the UI. The
Progress pane makes the rule visible: one row per level, an explicit dash where a total
would go, and one line of prose saying why. `tests/session.test.js` asserts the `xp` object
has exactly four keys and no fifth, so the day someone adds a total, it fails.

Two refinements the plan did not anticipate, both found against the live log:

- A segment that has already **ended** offers no time-to-level. It ended *by* levelling, so
  a countdown to a level already reached is a rounding artefact wearing the clothes of a
  prediction — it produced "0:01 to 12" on a level finished half an hour earlier.
- The level a session **started** in is learned by subtraction when the first boundary is
  crossed: gaining level 28 says the segment that just closed was 27. Read off the log, not
  guessed.

## What the live log actually says

Every rule below is `(confirmed)` against `eqlog_Rhale_oggok.txt` (1,128,942 lines,
2026-07-31 → 2026-08-08) unless marked otherwise. Twenty-one rules across seven categories.

Three things the plan expected to be unconfirmed turned out to be **in the log**:

| Family | Line | Note |
|---|---|---|
| Merchant sale (income) | `You receive 7 gold 2 silver from Wanderer Rakshaazi for the Cyclops Toes(s).` | Plain spaces between denominations, unlike the corpse line's commas |
| Faction cap, positive | `Your faction standing with Emerald Warriors could not possibly get any better.` | Both directions occur |
| Item payout | `You received 3 platinum, 2 gold, 1 silver and 4 copper from that item.` | Past tense; its own coin source |

Two more rules were found that the plan did not list at all: `You have improved Unbound
Nature 2 at a cost of 0 ability points.` (ranking up an ability already owned, often free —
folding it into the spend rule would print a list whose costs sum to less than the list
implies), and the tradeskill combine line.

Only the **group coin-split** line remains unconfirmed. It ships marked as such.

The whitespace traps the plan warned about are both real and both handled: the ability-point
line has a double space after `point!`, and the purchase line has a double space before the
amount.

### Verified against the whole log

`scripts/session-replay.js` replays a log through the tracker with a real `LogParser`
alongside it (for the chat classification and the roster). Against the live 1.1M-line log
it produces 25 sessions and 17,607 tracked events, and every count reconciles exactly with
a raw grep:

| | tracker | `grep -c` |
|---|---|---|
| kill lines | 3038 ours + 171 by others = 3209 | 1558 + 1651 = 3209 |
| loot | 389 | 389 |
| deaths | 27 | 27 |
| ability points | 63 | 63 |

## A bug found in the combat parser

`You have entered an area where levitation effects do not function.` is worded exactly like
a zone line, and the parser's `zone-entered` rule matched it — **8 times in this log**.
Zoning closes the encounter, so stepping into a no-levitate room ended whatever fight was in
progress. Both rule tables now require the zone name to start with a capital: zone names are
proper nouns, the game's flavour messages are sentences.

This is outside the plan's scope and is fixed anyway — it was found by the session window
listing "an area where levitation effects do not function" as a place the player had been,
and leaving a known encounter-closing bug in a rule table being edited would have been worse
than the small scope creep.

## Session lifetime

- Opens on the first tracked event.
- Closes after **60 minutes** with nothing tracked, dated to the last real event rather than
  to the moment of discovery — a session that stopped at 23:10 and was noticed at 00:10
  lasted until 23:10, and stamping the discovery time would inflate every duration and
  deflate every rate that divides by it.
- Closes on character change. **Zoning does not close it** — walking to the next camp is the
  same night.
- A session of nothing but zone transitions is never written: that is somebody running to
  the bank.

### The floor that stops double-counting

The tailer seeds itself 64 KB back from the end of the log so a fight already underway is
not missed. Harmless for the combat parser, which rebuilds an encounter that has since
closed — and double-counting for a session store, so restarting the overlay mid-camp would
quietly add the last few minutes of kills, coin and faction to the night a second time.

The tracker takes a `minTs` floor, set from the last event already on disk for that
character. It is inclusive: EQ timestamps have one-second resolution, so an inclusive test
can drop a handful of events landing in the same second as the previous session's last, and
an exclusive one would re-count that second. Losing a little beats inflating.

## Persistence

`src/main/session-store.js` — append-only JSONL, one file per character
(`<userData>/sessions/<Char>_<server>.jsonl`), directory injected, torn lines skipped,
directly on `history.js`'s model and emphatically not SQLite.

Two things it has that the encounter store does not:

- **Deduplication by id.** A session's id is its start time, and the recovery path can
  legitimately try to write a session that was already written normally.
- **A checkpoint**, written every five minutes to `<Char>_<server>.current.json` via
  temp-then-rename. An encounter is seconds long, so losing the one in flight to a crash
  costs a pull; a session is hours long, and a crash at hour four with no checkpoint costs
  the whole night. On launch any orphaned checkpoint is folded in as a finished session
  marked `recovered` — and the window says so in words, because the minutes between the last
  checkpoint and the crash are genuinely missing and calling it "closed" would assert data
  we do not have.

A clean quit closes and writes the session directly. Recovery is for crashes; using it for
the ordinary case would mislabel every clean shutdown.

## Configuration

A `session` block: a master `enabled`, seven category flags, and `meterLine`.

**`enabled` and `meterLine` ship off; the seven categories ship on.** The plan said "all
defaulting off", and that is a deliberate departure: nothing the categories gate can reach
the screen while the master is off, so the raid HUD is protected by the master alone — and a
master switch that turns on nothing is not a preference, it is a feature that appears broken
the first time it is used.

Gating is at **rule evaluation**, not display: a disabled category never runs its regex and
never accumulates, so "off" genuinely costs nothing. Master off means `main.js` never
constructs the tracker at all and the tray entry is absent.

These switches live in the settings form, and that does not reopen the wound that removed the
ALERTS and BOSS TIMERS sections from it. That removal happened because two screens were
answering one question. Session categories have exactly one screen.

## The session line on the meter

One dim line between the DPS readout and the group rows: `SESSION · kills · coin · xp · AA ·
loot`, elapsed right-aligned, hairlined above and below, ability points in the player's own
ember accent because they are the rarest thing on the line.

It goes through the same `FIT_WINDOW` measurement path as everything else — verified
headlessly at exactly 20px of window height, and `tests/layout.test.js` pins the round trip
so toggling it cannot walk the window up the screen.

**Overflow drops whole stats from the right** rather than clipping or ellipsizing. This
window cannot scroll, and an ellipsis turns "1038p" into "10…", which reads as a smaller
number rather than an absent one. Measured headlessly: at 320px all five stats, at 170px
only kills, never clipped at any width.

Two bugs the headless check caught that review would not have:

- `#session-line { display: flex }` overrides the user agent's `[hidden] { display: none }`,
  so the "off" state still painted its borders and still cost the window 20px — the switch's
  entire promise, broken silently. Fixed with an explicit `[hidden]` rule.
- Counts rendered through `formatNumber`, which exists for DPS and turns 88 into "88.0". A
  tally now has its own formatter.

## The Session window

`src/renderer/session/` — three fixed panes on History's model (sessions → summary → detail),
warm parchment palette, real mouse input, panes scroll internally, its own `sessionBounds`
key, tray entry present only while tracking is on. Built against the approved Pencil mockups
(*Session Window*, *Session Window — Progress*).

Not a fourth mode of the History window: that window's reason to exist is three panes that
never reflow, and a mode switch changing what all three mean is the accordion it replaced
wearing a hat. They also answer different questions on different clocks — you read history
after a pull and a session after a night.

**No-reflow, measured.** Selecting any of 25 real sessions × 8 categories — 200 combinations —
produces exactly one layout: the headline and the category list sit on the same pixel every
time, and the body never scrolls horizontally. Getting there needed two fixed heights that
review would not have found: the summary sub-line wraps to two lines on sessions that
wandered between zones, and a big-coin night wraps the headline's unit onto a second line.

**Nothing is truncated.** Every creature, item, faction, skill and zone is listed, and each
pane's footer states the count ("26 of 26 kinds shown — nothing truncated"). The detail
sub-line wraps rather than ellipsizing, because some of those lines are prose and "the log
never said wh…" is exactly the truncation this project refuses everywhere else.

The deaths line renders **always** — faint "no deaths" on a clean night — in both the rail
and the summary, because a line that appears only sometimes shifts every line below it.

### Combat comes from the encounter store

The Combat category is **joined from `history.js` on time** — the fights whose `startTs`
falls inside the session — not counted by the tracker. `src/session/` is a sibling of the
combat parser precisely so it never scores damage; a second damage pipeline there would be a
second answer to one question, and the one on screen would be the wrong one. Rates divide by
time in combat, not by session length: a four-hour night with forty minutes of fighting has a
real DPS and a meaningless one.

Fights are attributed by their START, not their overlap — a pull that began before the
session's first tracked event belongs to whatever came before it, and a fight cannot be half
in two sessions.

### Import a log file

`scripts/backfill-history.js` has been able to replay a log into the encounter store since the
history window shipped, which is a capability nobody without a terminal has. The Session
window now has the button. It uses a private parser and a private tracker (the imported log is
often a different character, and importing must not disturb the session in flight), yields to
the event loop every 8192 lines so a million-line log does not freeze the overlay, and reports
both numbers — imported *and* already-present — so re-importing the same file reads as the
no-op it is rather than leaving the player wondering where the rest went.

## Phase 4: stop making the player type `/log on`

Independent of everything above, and the highest value-per-line idea in EQBuddy's repository.
The overlay can only see what the client logs, so a player who forgets `/log on` gets an app
that appears broken through no fault of anything in it — and the game has a setting for it
that nobody knows about.

`src/main/eqconfig.js` is pure and unit-tested: given `eqclient.ini` text, return it with
`Log=1` set **in `[Defaults]` only**, every other byte preserved — comments, blank lines, key
order, indentation, the spacing around the `=`, and the file's own line endings, including a
file with mixed endings. A no-op returns the input unchanged so the caller can skip the write.

Three guards on the write, each load-bearing:

1. The ini path is **derived** from the log we were told to follow (`…/Logs/eqlog_*.txt` →
   the Logs folder's parent). A function that writes to a path must not invent one; a log path
   that is not shaped like an EverQuest log path returns null and the feature does not offer
   itself.
2. **The game must not be running.** EverQuest rewrites this file when it exits, so an edit
   under a live client is undone.
3. The original is **backed up once**, with `wx`, so the backup is always the file as it was
   before this app first touched it rather than as it was one edit ago.

### And the truncation guard

"Clear log file…" now refuses while **GINA or GamParse** is running. Both tail the same file
by byte position, and emptying it under them leaves them reading past the end: silently dead
until restarted, with nothing on screen saying so. EQBuddy shipped that bug and then fixed it;
we get the fix without the bug. Refused rather than warned-and-proceeded — the player can close
the other tool and try again in five seconds, and there is no undo for the alternative.

Process detection shells out to `tasklist` (no native module, ever). A listing that cannot be
obtained reads as "nothing is running": assuming the opposite would make both features
permanently refuse themselves on any machine where the command is missing.

## Files

**New**
- `src/session/rules.js` — 21 rules, seven categories, gated at evaluation
- `src/session/session.js` — the aggregator, the lifetime, the per-level ledger
- `src/main/session-store.js` — JSONL per character, dedup, checkpoint, recovery
- `src/main/eqconfig.js` — the `eqclient.ini` transform and the running-reader check
- `src/renderer/session/` — the window: `index.html`, `session.css`, `session.js`,
  `organize.js` (the pure half), `preload.cjs`
- `scripts/session-replay.js` — offline replay, the whole-log check
- `tests/session-rules.test.js`, `tests/session.test.js`, `tests/session-store.test.js`,
  `tests/session-organize.test.js`, `tests/session-window.test.js`, `tests/eqconfig.test.js`

**Changed**
- `src/parser/rules.js` — `CHAT_RULE_IDS` export; the zone false-positive fix
- `src/main/config.js` — the `session` block, `sessionEnabled`, `sessionLineEnabled`,
  `sessionCategories`, `sessionBounds`
- `src/main/history.js` — `combatBetween`, the time join
- `src/main/main.js` — tracker lifecycle, checkpoint timer, recovery, snapshot merge,
  the Session window, six IPC handlers, the ini handlers, the log-clear guard
- `src/main/ipc.js` — the session and eqconfig channels
- `src/renderer/overlay/` — the session line, its styles, the drop-on-overflow rule
- `src/renderer/setup/` — the SESSION section, the "Always log…" button
- `tests/config.test.js`, `tests/layout.test.js`, `tests/preload-channels.test.js`

634 tests pass.

## Declined, so nobody re-derives them

- **EQBuddy's spawn-timer catalog** (843 named across 118 zones). Architecturally the easiest
  thing on the list — our trigger packs would host it almost verbatim. Declined on product
  grounds: spawn timers run 20 minutes to 8 hours, which turns the timers panel from a
  combat-scoped thing that is *gone* between fights into a permanent fixture, inverting the one
  invariant that window was built around. It is a camping feature and this is a raid overlay.
- **Timers that tighten themselves from play.** We deleted a live estimator five days ago for
  computing medians at 4 Hz and showing the player its intermediate guesses. See
  `docs/changelog/2026-08-08-real-triggers-not-learned-rhythms.md`. Do not rebuild it in a
  different costume.
- **SQLite for the session store.** They use it; we cannot. A native module needs a win32 build
  under Windows npm *and* a linux build for the WSL suite.
- **Wiki-backed drop pools and item tooltips.** A lot of surface area for data we would be
  re-stating rather than measuring, and "possibly stale wiki claim" sits badly next to a meter
  whose selling point is that every number came out of your own log.
- **A mini/pill dashboard mode.** Our meter already *is* the small always-on thing.
- **Per-rule custom sound files.** We drop GINA media deliberately; `gina.js` explains why.
