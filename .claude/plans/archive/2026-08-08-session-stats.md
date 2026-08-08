---
status: completed
---
# Session stats: the non-combat half of a play session

**Date:** 2026-08-08

---

## Goal

Compare this overlay against [EQBuddy](https://github.com/DranakCorps-bot/EQBuddy) (MIT,
.NET/WPF, same game, same log format) and pull in what is worth having.

The comparison came out lopsided in a useful way. **We are not the same product.** EQBuddy
is a *solo session tracker*: what did this camp earn me — kills, loot, coin, XP, faction,
skill-ups, zones. We are a *group combat overlay*: who in this group did what, live, over
the game. Where the two overlap — DPS/HPS, per-ability breakdowns, pet attribution,
crit/accuracy, alerts, auto-update, per-fight history, log tailing with truncation and
rotation safety — we are at parity or ahead. We resolve group members and charmed pets,
credit ambiguous damage to an explicit "Unknown" row rather than guessing, and never
truncate a breakdown; none of that is in their scope because they only ever score one
character.

The gap is the other axis entirely. **We parse none of the non-combat session data.** Our
rule table emits sixteen event kinds and every one of them is combat, chat, or plumbing.
There is no line in this codebase that knows what a coin drop, a looted item, an XP tick,
a faction hit, or a skill-up looks like — and all five are sitting in the live log right
now, in shapes I have confirmed by hand.

So this plan closes that axis: **full session-stat parity**, built the way this codebase
builds things, and **every category behind its own toggle** so the raid HUD is unchanged
for anyone who does not want it.

Two things live outside the Session window itself. **Ability points are tracked as a
first-class category** — both the earn line and the spend line are confirmed below, so the
window can say what was gained *and* what it was spent on. And the meter itself grows **one
dim line under the DPS readout, above the group rows**, carrying the running session
totals — the number you want mid-pull without opening anything. That line is its own
toggle, independent of the categories feeding it.

Mockups for all of this are in `pencil-new.pen`: *Session Window*, *Session Window —
Progress*, *Overlay — with session line*, and *Settings — SESSION section*.

It also picks up one small thing from EQBuddy that has nothing to do with session stats
and is the highest value-per-line item in their whole repo: forcing `Log=1` in
`eqclient.ini` so the player stops having to type `/log on` every login.

Explicitly **not** in scope: their spawn-timer catalog (decided against — see Considered
and Declined).

## What the live log actually says

Grepped from `eqlog_Rhale_oggok.txt` (1,122,186 lines, 2026-07-31 → 2026-08-08). These are
real lines, not reconstructions, and each becomes a `(confirmed)` rule:

| Family | Confirmed line |
|---|---|
| Kill (self) | `You have slain a froglok shin knight!` |
| Kill (group) | `A froglok shin knight has been slain by Rhain!` |
| Coin | `You receive 3 gold, 6 silver and 7 copper from the corpse.` |
| Loot | `--You have looted a Mote of Lesser Potential from a shin ghoul knight's corpse.--` |
| XP (solo) | `You gain experience! (8.001%)` |
| XP (group) | `You gain party experience! (0.769%)` |
| Level | `You have gained a level! Welcome to level 28!` |
| AA earned | `You have gained an ability point!  You now have 1 ability point.` |
| AA spent | `You have gained the ability "Combat Fury" at a cost of 1 ability points.` |
| Faction | `Your faction standing with Frogloks of Guk has been adjusted by -5.` |
| Faction cap | `Your faction standing with Undead Frogloks of Guk could not possibly get any worse.` |
| Skill-up | `You have become better at Athletics! (135)` |
| Tradeskill | `You have fashioned the items together to create something new: Metal Bits.` |
| Purchase | `You purchased 1 Spell: Wrath from Zealot Zorshais for  6 platinum 3 gold 9 copper.` |
| Zone | `You have entered The Northern Desert of Ro.` (rule already exists) |
| Death | `You have been slain by an urd ghoul wizard!` (rule already exists) |

Two whitespace traps worth writing down before someone loses an hour to them: the AA line
has a **double space** after `point!`, and the purchase line has a **double space** before
the amount. Both are in the real log.

Coin has at least ten denomination shapes (`platinum`/`gold`/`silver`/`copper` in any
combination, Oxford-comma-free, `and` before the last). One alternation handles it; the
rule must not assume all four are present.

**Not found in this log, so not confirmed:** the merchant *sale* line (income — we only
saw `You purchased`, which is spend), the group coin-split line, and the positive form of
the faction cap (`could not possibly get any better`). These get written from classic-EQ
wording, marked **unconfirmed**, and verified empirically with `collect-unknown.js`
afterwards — the same discipline `rules.js` already uses.

## An honesty problem, up front

EQ prints XP as **a percentage of the current level only**. There is no absolute number
anywhere in the log. That means:

- `%/hr` is real and useful *within a level*.
- Summing percentages **across a level boundary** is meaningless — 12% at level 28 and 12%
  at level 51 are wildly different amounts of experience, and adding them produces a
  number that describes nothing.
- "Time to level" is honest; "total XP this session" is not.

So the session model stores XP as a **per-level ledger** (`{level, percent, ms}` segments),
and the UI reports rate-within-level and time-to-level. It will never print a single
session-wide XP total. This is the same rule as "damage with no stated type stays untyped"
and "ambiguous attribution goes to Unknown" — the number we cannot honestly compute is the
number we do not print.

## Approaches Considered

### 1. Extend `src/parser/` — new rules in `rules.js`, new state in `index.js`
- **Description:** Add the twelve rule families to the existing ordered table and
  accumulate session totals inside `LogParser` alongside encounters.
- **Pros:** No new module. Free chat-first protection (chat rules already come first, so a
  player typing "You have slain a froglok" in /general cannot score). One `feed()` path.
- **Cons:** `rules.js` is already 37 KB and `index.js` 61 KB, and every byte of both is
  currently about *combat scoring*. Folding loot and faction in makes the file that must
  stay auditable for attribution bugs twice as large and half as focused. Session state
  also has a completely different lifetime from an encounter (hours, survives zoning,
  survives combat idle) — jamming it into the class whose whole job is "when did this
  fight start and stop" invites exactly the kind of lifetime bug that `encounter.js`'s
  heal-doesn't-extend rule exists to prevent.

### 2. A sibling module, `src/session/` — pure Node, fed the same lines
- **Description:** Mirror the `src/triggers/` precedent exactly: a peer of the parser, not
  part of it. Pure Node, no Electron, its own rule table, its own aggregation, its own
  store. `main.js` feeds it the same lines and merges its output into the snapshot.
- **Pros:** This is the construction the codebase already chose once, for the same reason —
  `src/triggers/` is a sibling precisely so a different domain cannot shadow a combat rule.
  Keeps the combat parser exactly as auditable as it is today. Independently
  unit-testable and replayable in WSL. A disabled session tracker costs literally nothing:
  main just does not feed it.
- **Cons:** Needs its own chat guard — the "someone quoted a kill line in /general" problem
  does not solve itself outside `rules.js`. Solvable cheaply (below), but it must be
  solved deliberately rather than inherited.

### 3. Fold sessions into the History window as a fourth pane
- **Description:** No new window; the History window grows a "Sessions" mode beside its
  fight list.
- **Pros:** One fewer window to place, persist bounds for, and put in the tray.
- **Cons:** The History window's entire reason to exist is three fixed panes that never
  reflow. A mode switch that swaps what all three panes mean is the accordion it replaced,
  wearing a different hat. Sessions are also a different unit of time — you read history
  after a pull, you read a session after a night. Different question, different window.

### 4. Author it as trigger packs
- **Description:** Express kills/loot/coin as counting triggers in the existing pack engine.
- **Pros:** Zero new architecture; users could edit the patterns.
- **Cons:** The engine emits chips and countdowns. It has no concept of a running total, a
  per-hour rate, a currency, or a per-level ledger — every one of those would be a new
  primitive in an engine that deliberately stays small because it runs strangers' regex.
  Wrong tool.

### 5. Full parity in one landing
- **Description:** All twelve rule families, the store, and the Session window in a single
  pass before anything ships.
- **Pros:** No half-built feature sitting in `main`.
- **Cons:** The window needs a Pencil mockup approved before implementation (project
  convention), and that approval is a synchronous dependency on James. Everything *behind*
  the window — rules, aggregation, store, toggles — can be built, tested and replayed
  against the real log without it. Blocking the parser work on a mockup wastes the part of
  this that is verifiable offline.

## Chosen Approach

**Approach 2 (sibling module) for the architecture, delivered in the phases of Approach 5's
critique** — build and land the pure, testable half first; the window follows an approved
mockup.

`src/session/` becomes a peer of `src/parser/` and `src/triggers/`, with the same
construction rules: pure Node, no Electron imports, fed lines by `main.js`, merged into the
snapshot afterwards. This is not a new idea being invented here — it is the shape the
codebase already settled on when trigger packs needed to live near the parser without
being part of it, and the reasoning transfers intact: session accounting and combat
scoring fail in different ways and should not be able to break each other.

**The chat guard** resolves without duplicating anything. `main.js` already feeds each line
to the parser and gets a typed event back, and `rules.js` classifies chat *first* by
design. So session gets fed `(line, parserEvent)` and skips any line the parser already
called `chat`. One condition, no second copy of the chat table, and the "chat first" rule
keeps living in exactly one place.

**Toggles** (James's requirement) are a `session` block in config: a master `session.enabled`
plus one flag per category — `kills`, `loot`, `coin`, `xp`, `faction`, `skills`, `zones`.
The gating is at **rule evaluation**, not display: a disabled category never runs its
regex, never accumulates, and never reaches the store, so "off" genuinely costs nothing
rather than costing everything and hiding the result. Master off means `main.js` never
constructs the tracker at all, and the tray entry is absent.

These toggles go in the **settings form**, and that does not reopen the wound that removed
the ALERTS and BOSS TIMERS sections from it. That removal happened because two screens were
answering the same question — a pack could be enabled while its surface was off, with
neither screen saying so. Session categories have exactly one screen. There is no second
place to disagree with.

## Tasks

### Phase 1 — the pure half (no Electron, all verifiable in WSL)

- [x] Create `src/session/rules.js`: ordered table, first match wins, same shape and comment
      register as `src/parser/rules.js`. Twelve families from the table above, each marked
      `(confirmed)` or `(unconfirmed)` per the evidence section.
- [x] Coin: one rule handling all denomination shapes, normalising to a copper total plus
      the original p/g/s/c breakdown. Must not assume all four denominations are present.
- [x] Kills: separate `kill-self` (`You have slain X!`) from `kill-group`
      (`X has been slain by Y!`), and resolve the killer through `roster.js` so a group
      member's kill is attributed and a stranger's is not counted as ours.
- [x] XP: emit `{level, percent, solo|party}`. Do **not** emit a running total.
- [x] Create `src/session/session.js`: the aggregator. Holds kill counts per creature, loot
      item counts, coin by source, the per-level XP ledger, faction deltas with cap flags,
      skill-up list, zone visits with durations, and death list. Per-hour rates computed
      over elapsed session time.
- [x] Session lifetime in `session.js`: opens on first tracked event, closes after 60 min of
      no tracked activity (EQBuddy's boundary, and it matches how a play night actually
      breaks), and closes on character change. Zoning does **not** close a session.
- [x] `tests/session-rules.test.js`: every rule matches its own confirmed sample line, and
      no rule matches a `/general` line quoting it.
- [x] `tests/session.test.js`: aggregation, the 60-min boundary, per-hour rates, and the
      per-level XP ledger refusing to sum across a level boundary.
- [x] `scripts/session-replay.js`: replay a log and print the session breakdown, mirroring
      `scripts/replay.js`. This is how the whole phase gets checked against the real
      1.1M-line log without launching Electron.

### Phase 2 — persistence and wiring

- [x] `src/main/session-store.js`: append-only JSONL, one file per character
      (`<userData>/sessions/<Char>_<server>.jsonl`), directory injected so it unit-tests
      against a temp dir — construction copied from `history.js`, including the rule that a
      write failure toasts rather than propagating.
- [x] Checkpoint the in-flight session to `<Char>_<server>.current.json` every 5 minutes and
      recover it on launch. A session is hours long; a crash at hour four must not cost all
      four. (EQBuddy does this and is right to.)
- [x] `tests/session-store.test.js`: append, reload, dedup, checkpoint recovery, and a
      write failure that does not take the tracker down.
- [x] Config: add the `session` block with master + seven category flags + `meterLine`, all
      defaulting **off**, and add them to whatever validates config shape today.
- [x] `main.js`: construct the tracker only when `session.enabled`; feed it
      `(line, parserEvent)` and skip lines the parser classified as `chat`; merge its
      summary into the snapshot.
- [x] Settings form: a SESSION section with the master toggle, seven category checkboxes
      (each disabled while the master is off), and the separate `meterLine` switch.
      Mocked in `Settings — SESSION section`.

### Phase 2b — the session line on the meter

- [x] `src/renderer/overlay/`: one line between `.head-line.readout` and `ol#rows`, carrying
      `SESSION · kills · coin · xp · AA · loot` with the session elapsed right-aligned.
      Hairline above and below; values at `--ink-dim`, units at `--ink-faint`, AA at
      `--ember-lit` since it is the rarest thing on the line. Mocked in
      `Overlay — with session line`.
- [x] Gate it on `session.enabled && session.meterLine`, and render **nothing** (not an
      empty row) when off or when no session is open — the overlay pays for every pixel.
- [x] The line must go through the same `FIT_WINDOW` measurement path as everything else:
      it changes the resting height, so `layout.js` owns the new bounds and the round-trip
      test in `tests/layout.test.js` covers it. This is the "window climbs the screen" bug
      class — do not let the renderer derive placement from current bounds.
- [x] Confirm the line never introduces a scroll or an ellipsis at the smallest supported
      width; if the content cannot fit, drop trailing stats rather than truncating text.

### Phase 3 — the window (gated on an approved mockup)

- [x] Pencil mockup of the Session window: three fixed panes on the History model — session
      list rail → session summary → category detail. Drawn as *Session Window* (Loot
      selected) and *Session Window — Progress*. Still needs James's sign-off before any of
      it is written (project convention; the History window shipped this way).
- [x] `src/renderer/session/`: window, warm parchment palette, real mouse input, panes scroll
      internally. Never reflows — selecting a session, category or metric swaps content
      inside a fixed pane. Not part of the click-through HUD.
- [x] `organize.js` equivalent: the pure half (rate formatters, day grouping, currency
      formatting, per-level XP segmentation), unit-tested in WSL like `organize.js` and
      `breakdown.js` already are.
- [x] `layout.js` + bounds key `sessionBounds`; tray entry "Session…" present only when
      `session.enabled`; round-trip test in `tests/layout.test.js`.
- [x] Move `scripts/backfill-history.js`'s capability into the UI as an "Import a log file"
      button — EQBuddy has this and we have the logic already, just CLI-only.

### Phase 4 — the one unrelated pull: stop making the player type `/log on`

- [x] `src/main/eqconfig.js` (pure, unit-tested): given `eqclient.ini` text, return it with
      `Log=1` set in the **`[Defaults]` section only**, every other byte preserved. Their
      approach and it is the correct one — this file is the player's, and we are editing one
      key in it, not rewriting it.
- [x] Locate `eqclient.ini` from the followed log path (`…/EverQuest Legends/Logs/eqlog_*.txt`
      → game root is the Logs folder's parent). Never guess a path we were not given.
- [x] Write it **only while the game is not running** (check for `eqgame.exe`), behind its own
      settings toggle, and back the original up once before the first write.
- [x] Apply the same guard to our existing "empty the log" button: skip truncation while the
      game, GINA, or GamParse is running. Those tools hold byte offsets into the file and
      emptying it under them corrupts their state — EQBuddy hit this and fixed it in August
      2026, and we can have the fix without the bug.
- [x] `tests/eqconfig.test.js`: `[Defaults]` untouched elsewhere, missing key added, existing
      `Log=0` flipped, no `[Defaults]` section handled, CRLF preserved.

## Considered and Declined

Recording these so nobody re-derives them later — the changelogs are this project's
institutional memory and this is the same kind of fact.

- **Their spawn-timer catalog** (843 named across 118 zones, MIT, harvested from eqlwiki).
  Architecturally it was the *easiest* thing on the list — our trigger packs would host it
  almost verbatim, `seed-pack.js` is the template, and a `You have slain <named>` →
  countdown is exactly the shape the engine already runs. Declined on product grounds:
  James's call, and it is the right one. Spawn timers run 20 minutes to 8 hours, which
  turns the timers panel from a combat-scoped thing that is *gone* between fights into a
  permanent fixture — inverting the one invariant that window was built around. It is a
  camping feature and this is a raid overlay.
- **Their "timers tighten themselves from play" learning.** Even had we taken the catalog:
  we deleted a live estimator (`src/parser/rhythm.js`) five days ago for computing medians
  at 4 Hz and showing the player its intermediate guesses. See
  `docs/changelog/2026-08-08-real-triggers-not-learned-rhythms.md`. Do not rebuild it in a
  different costume.
- **SQLite for the session store.** They use it; we cannot. A native module needs a win32
  build under Windows npm *and* a linux build for the WSL test suite, which is the whole
  reason history is JSONL. Unchanged here.
- **Wiki-backed drop pools and item tooltips.** Network scraping, a one-week cache, and
  LIVE/CACHED/STALE labels to explain when the answer is old. That is a lot of surface area
  for data we would be re-stating rather than measuring, and "possibly stale wiki claim"
  sits badly next to a meter whose selling point is that every number came out of your own
  log.
- **Their mini/pill dashboard mode.** Our meter already *is* the small always-on thing;
  a minimised pill for an overlay this size is a mode with no job.
- **Their per-rule custom sound files (`.wav`/`.mp3`).** We drop GINA media deliberately —
  `gina.js` explains why (packs name audio files they do not bundle, so the path is
  unreachable even to GINA). Synthesised beeps stay.

## Notes

### Execution notes (2026-08-08)

- **The chat guard was wrong in its first draft.** The parser's chat rule emits TWO kinds —
  `chat`, and `player-proof` when the channel proves the speaker is a player — so guarding on
  `kind === 'chat'` let every guild/group/raid/auction line through and a quoted kill line
  scored. Guarding on the rule id via a new `CHAT_RULE_IDS` export fixed it.
- **Three "unconfirmed" families turned out to be in the log**: the merchant sale line, the
  positive faction cap, and an item payout line the plan did not list. Two more rules were
  found that the plan did not anticipate (`You have improved <ability> at a cost of N ability
  points.` and the tradeskill combine). Only the group coin-split remains unconfirmed.
- **A combat parser bug was found and fixed**: `You have entered an area where levitation
  effects do not function.` matched `zone-entered`, and zoning closes the encounter — 8 times
  in the live log. Both rule tables now require a capitalized zone name.
- **The 64 KB tailer backfill would have double-counted** on every restart. The tracker takes
  a `minTs` floor from the last event already on disk.
- **A `minTs`-style honesty refinement on time-to-level**: it is offered only from a segment
  that is anchored AND still open. A closed segment ended *by* levelling, so a countdown to it
  is a rounding artefact — the live log produced "0:01 to 12" on a level long finished.
- **Config deviates from the plan on one point.** The plan said master + seven categories +
  `meterLine` all default off; the categories default ON. A master switch that turns on nothing
  is a feature that appears broken the first time it is used, and the raid HUD is protected by
  the master alone.
- **Combat in the Session window is joined from the encounter store on time** (James's call),
  not counted by the tracker — the sibling-module separation holds.
- Headless verification caught two things review would not have: `display: flex` overriding
  `[hidden] { display: none }` on the meter line (so "off" still cost 20px), and two wrapping
  cases in the Session window that broke the no-reflow rule. The window is now measured stable
  across 25 real sessions × 8 categories.

- **Where we are already ahead**, for the record: group and raid attribution at all, pet
  ownership via the backtick split, charm inference, "Unknown" rows instead of guessed
  attribution, exact overhealing from EQ's `effective (potential)` print, uncapped
  breakdowns, GINA `.gtp` import with a dry-run, and a click-through HUD that auto-fits
  rather than scrolling. None of that is in EQBuddy's scope — it only ever scores one
  character, and most of these problems only exist once you score six.
- Attribution: EQBuddy is MIT. Nothing in this plan copies their code — the rules here were
  read off James's own log, and `eqconfig.js` reimplements a described behaviour, not a
  file. If anything of theirs is ever vendored, `NOTICE` gets an entry the same day.
- The merchant *sale* line is the one real unknown. `collect-unknown.js` against a session
  that includes vendoring will settle it in one pass; until then that rule ships unconfirmed
  and coin income is corpse-only, which is honest and clearly labelled.
- Phase 4 is independent of Phases 1–3 and much smaller. If session stats stall on the
  mockup, ship Phase 4 on its own — it fixes a setup-friction bug that affects every user
  today.
- The mockups deliberately show two things the implementation must not lose. The rail's
  fight rows carry a deaths line **always**, faint "no deaths" on clean sessions, because a
  line that appears only sometimes shifts every row below it — the same failure the History
  window already fixed. And the loot pane's footer reads "26 of 26 kinds shown — nothing
  truncated", which is the breakdown rule restated for a new list.
- The Progress pane is where the XP honesty rule becomes visible: a per-level ledger, a
  dash where a session-wide XP total would go, and one line of prose saying why. If that
  pane ever grows a single summed XP number, this plan was implemented wrong.
