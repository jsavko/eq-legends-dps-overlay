# Levels on the meter, tonight in the Session window, and no more stale-log warning

**2026-08-09**

Three changes to the session feature. Two of them put a number that was already being
tracked correctly onto a screen a player actually looks at. The third takes a claim off the
screen because nothing was checking it.

---

## Levels on the meter's session line

The line read `kills · coin · xp% · aa · loot`. Levels gained were nowhere on it, which was
odd next to a counter for ability points — the rarer event was the one being reported.

Nothing needed parsing. `src/session/rules.js` has had the `level-up` rule (confirmed
wording) since session tracking shipped, and `applyLevel` has maintained `levelsGained`,
`levelsLost` and the per-level segment ledger the whole time. The Session window already
printed the count in three places. The gap was one layer up: `SessionTracker.summary()`,
the deliberately small object pushed across IPC four times a second, carried `aa` and not
levels, so the overlay had no number to draw.

What the line *did* show was `xpLevel`, rendered as the unit `L28` — the level you are
**standing in**, not the count of levels you **gained**. Two different facts, and only the
one nobody asked for was on screen. Both are there now, and the whole of what keeps them
apart at that font size is a prefix/suffix split: the position is prefixed (`L28`), the
gain is suffixed (`4 lvl`).

The stat sits immediately before `aa`, and the position is not cosmetic. `dropOverflowingStats`
removes stats from the RIGHT when the window is too narrow to hold them all, so order *is*
priority; a level is the rarer and larger of the two events, so it survives longest on a
narrow overlay. Both now draw in the player's own accent, being the two things on the line
that almost never change and are therefore worth noticing when they do.

`levels` is `levelsGained` — gross, never a net of gained-minus-lost. The rail and the
Progress pane already print the gross count, and one number that means different things in
two windows is worse than a narrower one that means the same thing everywhere. `levelsLost`
rides along in the summary for a future caller; nothing renders it yet. A test pins that
decision so it cannot be quietly "tidied" into a subtraction later.

## The session in flight, in the Session window

Opening the big window mid-night and not finding tonight was the wrong way round: the
session you most want to read is the one you are still in. The rail listed only
`sessionStore.list(key)` — closed records on disk — so the night in progress was invisible
until it ended, an hour of silence later.

Most of this was already built and left unconnected. `CHANNELS.SESSION_CURRENT` was handled
in main and bridged in the session preload and called by nothing; `closeReasonLabel` already
mapped `open` → `"still running"`. The window was written expecting the live session and
then never wired to it.

**It is now an ordinary row in the rail**, not a pinned card above it. That is the whole
design decision, and it is what lets the live session inherit the entire window — the
filters, the day grouping, the headline, all eight category panes, the combat join — rather
than getting a poorer copy of them. A card above the rail was considered and rejected: a
block that appears when a session opens and disappears when it closes moves every row
beneath it, which is the exact reflow this window exists to refuse.

Three details carry it:

- **The id is the join.** A checkpoint and the record written when the session closes are
  both `String(startTs)`. That single fact is why the live-to-closed transition needs no
  code at all: `onSessionAppended` → `load({keepSelection: true})` finds the same id still
  in the list and the selection simply stays put while the row becomes its permanent self.
- **The refresh never rebuilds the rail.** A 2s timer runs only while the live row is the
  selected one. It repaints the two right-hand panes and the row's own text in place.
  Calling `renderRail()` on a timer would reset the rail's scroll position and re-run the
  day grouping under the player's cursor every two seconds — the no-reflow rule broken on a
  schedule. `railRow` was split into structure-building and a `paintRailRow` that writes
  values into an existing row, so both paths share one mapping. The timer stops when the
  selection moves, when the night ends, and while the window is hidden.
- **A live row must not read as a finished one.** A checkpoint's `endTs` is *this instant*,
  so the ordinary formatting would have printed "21:14 – 23:02" and stated as fact that the
  night finished at the moment you happened to look at it. Live rows end their span in
  "now", in both the rail and the summary pane, and carry a small dot on the time. The dot
  is inline and 5px so it costs the row no height, and it is deliberately not the left
  border, which selection already owns.

`SessionStore.list()`'s inline row mapping was extracted into an exported pure `listEntry()`
so the live row and the stored row cannot carry different fields — if that mapping existed
twice, the row would change shape under the player at the moment the night ended. A test
asserts a checkpoint and a closed record produce identical keys, and that an early
checkpoint with no coin block yet is still a drawable row.

`CHANNELS.SESSION_CURRENT` was **deleted**. With the live record served through
`SESSION_GET` on the same path and with the same combat join, a second way to fetch one
record is a second thing to keep in step — and the second is the one that goes stale. A
test now asserts the channel is absent, so it does not quietly come back.

## The stale-log warning is gone

The overlay footer read `Rhale: log is stale — type /log on` while the log was being tailed,
parsed and rendered live.

The cause was not a bad threshold. `pushStatus()` — the only sender of `stale` — is called
exactly three times in a session, and none of them is "new lines arrived": once when the
overlay window appears, once on a character switch, once after a settings save. The 4 Hz
snapshot is a different channel and never carried `stale` at all. So the verdict was reached
once, at startup, and then frozen. Launch the overlay before the game is writing and the
warning latched on and stayed on all night, sitting over rows of live numbers that disproved
it.

Underneath that was a second fault worth recording, because it is the one that would bite
anyone who tries to rebuild this. `pushStatus` derived staleness from
`fs.statSync(...).mtimeMs`, and the tailer had already rejected that signal for itself —
`tailer.js` on its own switch detection: *"The signal is GROWTH between two scans, not
mtime … 'which file is the game appending to right now' is the question actually being
asked, and file size answers it directly."* The tailer knows when it last read bytes. The
status line asked the filesystem instead.

**It was deleted rather than repaired, and that is the decision worth reading.** Repairing
it is possible — give the tailer a `lastGrowthMs`, seed it from mtime at open so the 64 KB
startup backfill does not read as growth, resend STATUS on the snapshot tick when the flag
flips. It was costed out and rejected, because even repaired the warning could only ever
restate what an empty meter already says. The overlay answers "is my log live" continuously
and unambiguously: the numbers move. A second claim in words, one that can disagree with the
numbers beside it, is worse than no claim.

The nudge survives where it is actually useful. The settings window still checks the file it
is about to adopt and says *"last written 20 minutes ago. Type /log on in game."* That is a
real check, made at the moment of choosing, against a file nothing is tailing — mtime is the
only evidence available there and it is the right question to ask. It is also on screen at
first run, which is exactly when a player who has never typed `/log on` is looking.

`STALE_LOG_MS` stays for that one caller and now carries a comment saying why, since its
other caller has gone and the next reader would otherwise take it for dead code.

---

## Verification

Replayed against the live session log — 1,160,062 lines, 27 sessions, 17 of them containing
a level-up. The session open at the time of writing reported `levels=4, aa=5, xpLevel=19,
xpPercent=31.34`, which is precisely the case the design is about: four levels gained
tonight while standing in level 19. Its rail entry built clean from the checkpoint —
`closeReason: "open"`, 168 kills, Befallen, `live: true`.

Full suite: 644 tests passing.

## Files

| File | Change |
|---|---|
| `src/session/session.js` | `summary()` carries `levels` (gross gained) and `levelsLost` |
| `src/renderer/overlay/overlay.js` | levels stat on the session line; `applyStatus` no longer reports staleness |
| `src/renderer/overlay/overlay.css` | levels shares the AA accent; the `data-stale` rule is gone |
| `src/main/session-store.js` | row mapping extracted as the exported pure `listEntry()` |
| `src/main/main.js` | `SESSION_LIST` merges the live row, `SESSION_GET` serves the live record, `SESSION_CURRENT` removed, `pushStatus` sends no verdict, `STALE_LOG_MS` documented |
| `src/main/ipc.js` | `SESSION_CURRENT` removed, with the reasoning left in its place |
| `src/renderer/session/preload.cjs` | `sessionCurrent` bridge removed |
| `src/renderer/session/organize.js` | `timeRange` takes `{live}`; `railSummary` returns `range` and `live` |
| `src/renderer/session/session.js` | `paintRailRow` split out; live-refresh timer; live-aware summary heading |
| `src/renderer/session/session.css` | the recording dot, sized so it costs no row height |
| `tests/session.test.js` | levels in the summary; the gross-not-net rule pinned |
| `tests/session-organize.test.js` | the "– now" span and the live flag |
| `tests/session-store.test.js` | `listEntry` shape parity and its defaults |
| `tests/session-window.test.js` | the live session has no channel of its own |
