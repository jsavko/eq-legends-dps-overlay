---
status: completed
---
# A levels counter, the session you are in, and the end of the stale-log warning

**Date:** 2026-08-09

---

## Goal

Three changes. The first two are the same shape: a number that is already being tracked
correctly is not reaching the screen a player is looking at. The third is the opposite —
a claim on screen that is not being checked.

**A. Levels on the meter's session line.** The line currently reads
`kills · coin · xp% · aa · loot`. Levels gained are missing. Add a levels tally that
behaves exactly like the AA counter beside it — a running whole number for the night,
always rendered, in the same slot family. The tracking half already exists:
`src/session/session.js` counts `levelsGained` and `levelsLost` off the `level-up` /
`level-lost` rules, and the Session window already shows them in three places. The gap is
`SessionTracker.summary()` — the deliberately small object pushed across IPC four times a
second — which carries `aa` but no levels, so the overlay has no number to draw. What the
line *does* show is `xpLevel` as the unit `L28`, which is the level you are **standing
in**, not the count of levels you **gained**. Different facts; only the one nobody asked
for is on screen.

**B. The session in flight, in the Session window.** Opening the big window mid-night and
not finding tonight is the wrong way round: the session you most want to read is the one
you are still in. The rail lists only `sessionStore.list(key)` — closed records on disk —
so the night in progress is invisible until it ends, an hour of silence later.

The plumbing for B already exists and is **dead code**: `CHANNELS.SESSION_CURRENT` is
handled in `main.js:2091` (`session?.checkpoint()`), bridged in
`src/renderer/session/preload.cjs:22` as `sessionCurrent`, and never called by anything.
`closeReasonLabel` in `organize.js:591` already maps `open` → `'still running'`. The window
was built expecting the live session and then never wired to it. This finishes that.

**C. Delete the stale-log warning from the overlay.** The overlay footer reads
`Rhale: log is stale — type /log on` while the log is being tailed, parsed and rendered
live. The cause is not a bad threshold: `pushStatus()` — the only sender of `stale` — is
called exactly three times, and none of them is "new lines arrived". It fires once on the
overlay's `ready-to-show` (`main.js:723`), on a character switch (`main.js:239`), and after
a settings save (`main.js:1602`). The 4 Hz push is a different channel (`SNAPSHOT`) and
does not carry `stale` at all. So the verdict is computed once at window creation and then
frozen: start the overlay before EQ is writing, and the warning latches on and stays on all
night while the meter beside it fills with live numbers.

Underneath that sits a second fault. `pushStatus` derives staleness from
`fs.statSync(...).mtimeMs`, but the tailer already rejected that signal for itself —
`tailer.js:185` says of its own switch detection: *"The signal is GROWTH between two scans,
not mtime … 'which file is the game appending to right now' is the question actually being
asked, and file size answers it directly."* The tailer knows when it last read bytes; the
status line asks the filesystem instead.

The warning is being removed rather than repaired. See the approaches below for why.

## Approaches Considered — A, the levels counter

### 1. Add `levels` to the summary, render it as a stat beside `aa`
- **Description:** One field (`levels: s.levelsGained`) on the summary object, one entry in
  the `stats` array in `renderSessionLine`, one CSS rule to give it the accent the AA stat
  has. Placed immediately before `aa`, so the order becomes
  `kills · coin · xp% · levels · aa · loot`.
- **Pros:** Mirrors the AA counter exactly, which is what was asked for. The summary stays
  scalar-only (the existing test asserts nothing list-shaped crosses IPC). Sits ahead of
  `aa` in the drop-from-the-right overflow order, so the rarer, bigger event is the last
  thing to fall off a narrow overlay. No new state anywhere.
- **Cons:** Adds ~4 characters to a width-constrained line, so on a narrow overlay `loot`
  becomes marginally more likely to be dropped.

### 2. Fold the gain into the existing XP stat's unit
- **Description:** Render the xp stat as `8.4% L28 +1` — one stat carrying percentage,
  current level and levels gained.
- **Pros:** Costs the least width; keeps every experience fact in one place on the line.
- **Cons:** Not "like the AA counter" — a third value crammed into a unit slot that already
  holds two, unreadable mid-pull, and it cannot be dropped independently when the window is
  narrow. The line's whole idiom is one stat = one number + one unit.

### 3. Diff `xpLevel` in the renderer between pushes
- **Description:** The overlay already receives `xpLevel`; count level-ups by watching it
  change.
- **Pros:** No change to the session module at all.
- **Cons:** Wrong, and quietly. It puts session state in a renderer that by design "holds
  no parser state, only the last snapshot", it starts from zero every time the overlay is
  relaunched mid-night while the session itself survives, and it counts a de-level as a
  level. The tracker already knows the true answer; re-deriving a worse one downstream is
  the failure mode the derive-in-`record()` rule exists to prevent.

### 4. Pull the number from the checkpoint record on demand
- **Description:** Have the overlay ask for the full session checkpoint (which already has
  `xp.levelsGained`) rather than extending the summary.
- **Pros:** No new field; the record is already the single source of truth.
- **Cons:** A second, slower channel feeding one number onto a line that repaints at 4 Hz,
  so the levels figure would lag every other stat beside it. The summary exists precisely
  so the meter never has to do this.

### 5. Show a net figure (gained − lost)
- **Description:** Display `levelsGained - levelsLost`.
- **Pros:** Arguably the most honest single number for "where did the night leave me".
- **Cons:** Disagrees with every other screen — the rail and the Progress footer both print
  `levelsGained` — and one number meaning different things in two windows is worse than a
  gross count. De-levels are rare, and the Session window states both.

## Approaches Considered — B, the live session in the window

### 1. Merge a live entry into `SESSION_LIST`; let `SESSION_GET` fall back to the checkpoint
- **Description:** Main's `SESSION_LIST` handler appends the tracker's checkpoint to
  `sessions` as one more rail entry — same mapping as `sessionStore.list()`, extracted into
  an exported pure `listEntry(record)` so there is exactly one — flagged `live: true`, and
  only when the selected key is the key being tracked. `SESSION_GET`, asked for an id the
  store does not hold, falls back to `session.checkpoint()` when the id matches.
- **Pros:** Everything downstream works unchanged: `applyFilters`, `groupByDay`,
  selection-by-id, the headline, all eight category panes, and the `'still running'` label
  that is already written. The combat join stays in the one handler that does it, so the
  live session gets its Combat row like any other. Ids are `String(startTs)` for the
  checkpoint and the closed record alike, so when the night ends the row *becomes* its own
  permanent self — same id, same rail position, selection survives the transition with no
  special case.
- **Cons:** Main assembles the list from two sources and needs a one-line de-dupe by id.

### 2. A pinned "in progress" card above the rail, fed by `sessionCurrent`
- **Description:** Use the existing unused bridge to render a separate live card above the
  day groups, with its own idiom.
- **Pros:** No main-process change at all; unmistakably live.
- **Cons:** A block that appears when a session opens and disappears when it closes moves
  every row beneath it — the exact reflow this window exists to refuse. And the summary and
  detail panes would need a second path to the record, so the live session would either get
  a poorer version of the category panes or a duplicate of all of them.

### 3. Write the checkpoint into the main JSONL continuously so `list()` sees it
- **Description:** Persist the in-flight record into the character's session file and let
  the existing read path find it.
- **Pros:** Nothing in main or the renderer changes.
- **Cons:** An append-only log with a mutating record is a contradiction. The store is one
  immutable line per finished night; this would need rewrite-in-place, and a crash mid-write
  would corrupt finished sessions to show an unfinished one. The checkpoint file exists
  beside the store for exactly this reason.

### 4. Show the live session once, on open, and never refresh it
- **Description:** Fetch the checkpoint when the window loads; leave it frozen.
- **Pros:** Trivial, no timers.
- **Cons:** The window is most useful during the night it describes. A live row that stopped
  updating is worse than no live row — it is a number that looks current and is not.

## Approaches Considered — C, the stale-log warning

### 1. Delete it from the overlay
- **Description:** Remove the `stale` computation from `pushStatus`, the field from the
  STATUS payload, the branch and the `data-stale` attribute from `applyStatus`, and the CSS
  rule that recolours the footer. The footer keeps showing the character name. The settings
  window's own staleness check is untouched.
- **Pros:** The overlay already answers "is my log live" continuously and unambiguously —
  the numbers move. A second, text claim that can *disagree* with the numbers next to it is
  worse than no claim, and that is precisely the state it is in today. Removes a
  synchronous `fs.statSync` from `pushStatus`. Smallest change, and nothing left to go
  wrong later.
- **Cons:** Gives up the "you forgot `/log on`" nudge for a player whose log genuinely is
  off. Mitigated below.

### 2. Recompute it on the snapshot cadence, sourced from the tailer's last read
- **Description:** Give the tailer a `lastGrowthMs`, seeded from mtime at open and updated
  only when a poll reads new bytes, and have the snapshot loop resend STATUS whenever the
  flag flips.
- **Pros:** The warning becomes true. Costs no extra I/O — the tailer is already statting
  the file five times a second.
- **Cons:** More moving parts than the thing is worth: a seeding flag so the 64 KB startup
  backfill does not read as growth, a dirty-check so STATUS is not pushed four times a
  second, and a threshold judgement (10 minutes is conservative because a player standing
  in a bank genuinely produces no lines — too short and the warning cries wolf during quiet
  play). All of that to restate what an empty meter already says.

### 3. Leave it, raise the threshold
- **Description:** Bump `STALE_LOG_MS` so the one-shot check is less likely to latch on.
- **Pros:** One constant.
- **Cons:** Does not fix anything — the check still runs once and then freezes, so it is
  the same bug with a longer fuse. A wrong indicator that is wrong less often is harder to
  notice and therefore worse.

## Chosen Approach

**A1, B1 and C1.**

A1 is the literal request ("like the AA counter"), it is four lines of real change, and it
keeps every derived number derived in one place. `levelsGained` is used rather than a net
figure so the meter, the rail and the Progress pane cannot disagree; `levelsLost` rides
along in the summary so a future line can say so without another round trip, but nothing
renders it yet.

B1 makes the live session an ordinary rail entry, which is what lets it inherit the whole
window rather than getting a lesser copy of it. Three details carry the design:

- **The id is the join.** `String(startTs)` for both the checkpoint and the record written
  when the session closes. That single fact is why the transition from live to closed needs
  no code: `load({keepSelection: true})` on `onSessionAppended` finds the same id still in
  the list and keeps the selection on it.
- **Refresh is scoped, and never rebuilds the rail.** A 2s timer runs *only* while the
  selected row is the live one, re-fetches through the same `SESSION_GET` path, and
  re-renders the summary and detail panes plus the live row's own text. It never calls
  `replaceChildren` on the rail list — that would reset the scroll position and re-run the
  day grouping, which is the no-reflow rule broken on a timer. It stops when the selection
  moves, when the session closes, and while the window is hidden.
- **A live row must not read as a finished one.** `timeRange(startTs, endTs)` on a
  checkpoint renders `21:14 – 23:02`, which looks like a night that ended at 23:02. The live
  row renders `21:14 – now` instead, and carries `data-live` for a quiet recording marker.

C1 is a deletion. The overlay's job is to be true at a glance, and a footer that says the
log is dead while the rows above it move is the one failure it cannot afford. Repairing it
(C2) is possible and was costed out above; it is simply not worth the machinery, because
the repaired warning would only ever restate what the meter already shows. The nudge it
gives up survives where it belongs: the settings window's file picker checks staleness at
the moment you choose a file and says *"last written 20 minutes ago. Type /log on in
game."* (`setup.js:378`), which is a real check against a file that is not being tailed, and
is on screen at first run — exactly when a player who has never typed `/log on` is looking.

## Tasks

### A — the levels counter on the meter line

- [x] Add `levels: s.levelsGained` and `levelsLost: s.levelsLost` to the object returned by
      `SessionTracker.summary()` in `src/session/session.js`, with a comment saying why it
      is the gross gained count (agreement with `railSummary` and `progressDetail`) rather
      than a net figure
- [x] Add `['levels', formatTally(session.levels), 'lvl']` to the `stats` array in
      `renderSessionLine` (`src/renderer/overlay/overlay.js`), positioned immediately before
      the `aa` entry
- [x] Update the `renderSessionLine` doc comment, which currently enumerates the priority
      order as "kills, coin, experience, ability points, loot" — it must name levels and say
      why it outranks `aa` in the drop order
- [x] Add a CSS rule for `#session-stats .s-stat[data-kind="levels"] .s-value` in
      `src/renderer/overlay/overlay.css` giving levels the same `--ember-lit` accent the AA
      stat has, and extend the comment above the AA rule to cover both
- [x] Extend the summary test in `tests/session.test.js` ("the snapshot summary carries what
      the meter line needs and nothing heavy") to feed a level-up line and assert
      `s.levels === 1`, keeping the existing scalar-only assertion passing
- [x] Add a test asserting a de-level does not decrement `levels` and does surface as
      `levelsLost`, so the gross-count decision is pinned rather than incidental

### B — the session in flight, in the Session window

- [x] Extract the rail-entry mapping out of `EncounterStore`-style inline code in
      `SessionStore.list()` (`src/main/session-store.js`) into an exported pure
      `listEntry(record)`, and have `list()` call it — one mapping, so a live entry and a
      stored entry can never carry different fields
- [x] In the `SESSION_LIST` handler (`src/main/main.js:2043`), when `selected === tracking`,
      build `listEntry(session.checkpoint())`, mark it `live: true`, and prepend it to
      `sessions` — skipping it if the store already holds that id, so a recovered checkpoint
      cannot produce two rows for one night
- [x] In the `SESSION_GET` handler (`src/main/main.js:2065`), fall back to
      `session.checkpoint()` when `sessionStore.get(key, id)` returns null and the
      checkpoint's id and key match the request, so the live session gets the same combat
      join and the same category panes as any stored one
- [x] Teach `railSummary` (`src/renderer/session/organize.js:53`) about `entry.live`:
      return the time range as `HH:MM – now` and a `live: true` flag, so the pure half owns
      the distinction and it is unit-tested
- [x] In `railRow` (`src/renderer/session/session.js:180`) set `li.dataset.live` from that
      flag, and add a CSS rule in `session.css` for a quiet recording marker on the row —
      it must not change the row's height, since the rail cannot reflow
- [x] Add a live-refresh timer to `src/renderer/session/session.js`: started by `select()`
      when the chosen entry is live, cleared on any other selection, on session close, and
      while `document.visibilityState !== 'visible'`. Every 2s it re-runs the
      `sessionGet` fetch and calls `renderSummary()` / `renderDetail()`, and updates the
      live rail row's `.row-top` / `.row-stats` text in place — never `renderRail()`
- [x] Confirm the close transition by hand: the live row and the record written on close
      share `id === String(startTs)`, so `onSessionAppended` → `load({keepSelection: true})`
      must leave the same row selected with the panes now showing the closed record
- [x] Add tests to `tests/session-window.test.js` for `railSummary` on a live entry (the
      `– now` range and the flag), and to `tests/session-store.test.js` for `listEntry`
      producing the same shape from a checkpoint record as from a stored one

### C — the stale-log warning

- [x] Remove the `stale` computation from `pushStatus()` (`src/main/main.js:1544`) — the
      `try/catch` around `fs.statSync(tailer.filePath).mtimeMs` and the `stale` field in the
      `CHANNELS.STATUS` payload. The remaining payload (`logPath`, `character`, `locked`,
      `opacity`, `scale`) is unchanged
- [x] Simplify `applyStatus()` (`src/renderer/overlay/overlay.js:112`) to set
      `els.status.textContent = status.character` and drop both the ternary and the
      `els.body.dataset.stale` assignment
- [x] Delete `body[data-stale="true"] #status { color: var(--live); }` from
      `src/renderer/overlay/overlay.css:626`
- [x] Leave `STALE_LOG_MS` (`main.js:50`) in place and leave the `LOG_VALIDATE` handler
      (`main.js:1893`) using it — that check runs at the moment the player picks a file, on
      a file nothing is tailing, so mtime is the only signal available and it is the right
      one there. Add a comment at the constant saying so, since its other caller is going
      away and the next reader will otherwise assume it is dead
- [x] Confirm no other consumer of `status.stale` exists (`grep -rn "stale" src/`) before
      removing the field

### Shared

- [x] Run `npm test`
- [x] Verify on real data: replay the live log
      (`node scripts/replay.js "/mnt/c/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Rhale_oggok.txt"`)
      to confirm a session with a level-up reports `levels > 0` in the summary
- [x] Write `docs/changelog/2026-08-09-session-line-levels-and-live-session.md` covering all
      three, including why the live session is an ordinary rail entry rather than a pinned
      card, and why the stale warning was deleted rather than repaired — the latter matters
      most, because a deleted feature with no record is the thing most likely to be
      rebuilt by someone who notices it is missing
- [x] `taskkill.exe /IM "EQL DPS Overlay.exe" /F` then `scripts/dev.sh dist`, and relaunch
      `C:\eqoverlay-dev\dist\win-unpacked\EQL DPS Overlay.exe`

## Notes

- **Already done, do not redo:** `src/session/rules.js` has both `level-up` (confirmed
  wording) and `level-lost` (unconfirmed, classic wording) rules, and `applyLevel` maintains
  `levelsGained`, `levelsLost`, `levelUps` and the per-level segment ledger. No parsing
  changes anywhere in this plan.
- **Dead code being finished, not written:** `CHANNELS.SESSION_CURRENT` (main handler +
  preload bridge) and `closeReasonLabel`'s `open: 'still running'` were both built for this
  and are unreferenced today. The chosen approach routes the live record through
  `SESSION_GET` instead, which means `SESSION_CURRENT` stays unused — decide during
  execution whether to delete it or leave it as the direct-access path. Leaving a second way
  to fetch the same thing is the smaller sin; deleting it is cleaner. Lean delete.
  **RESOLVED: deleted**, from `ipc.js`, the main handler and the preload alike, with a test
  in `session-window.test.js` asserting it stays gone. An existing test had asserted the
  channel EXISTED ("no channel for the session in flight"); it was inverted rather than
  removed, so the reasoning survives at the point where someone would otherwise re-add it.

### Discovered during execution

- **`railRow` had to be split.** The live row's numbers change while it is on screen, and
  the only honest way to update it without `renderRail()` was to separate structure from
  values: `railRow` builds empty elements, `paintRailRow(li, entry)` writes an entry into
  them, and both creation and refresh go through the second. The `.row-stats` raw text node
  became a `.row-tally` span so it can be addressed; rendering is unchanged.
- **A first night had no rail at all.** `SESSION_LIST` picked `selected` from
  `sessionStore.characters()`, which reads filenames — so on a machine with no session file
  yet, nothing was selected and the live session was hidden behind the very emptiness it
  disproved. The tracked character is now offered whether or not it has been written.
- **The summary pane needed the same "– now" treatment as the rail**, and it gets it from
  `record.closeReason === 'open'` rather than from a second flag — the record's own word for
  its state, which was already in `closeReasonLabel`.
- **Real-log verification, 2026-08-09:** 1,160,062 lines, 27 sessions, 17 with a level-up.
  The session open at the time reported `levels=4, aa=5, xpLevel=19, xpPercent=31.34` —
  four levels gained tonight while standing in level 19, which is exactly the
  gain-versus-position distinction the line is designed around. Its live rail entry built
  clean: `closeReason: "open"`, 168 kills, Befallen, `live: true`.
- **The XP honesty rule is untouched.** Levels gained is a *count of events*, not a summed
  percentage, so putting it on the line does not create the session-wide experience total
  that `session.js` and `progressDetail` both go out of their way to refuse. The live
  session's Progress pane already handles the open segment correctly — `timeToLevelMs` is
  offered only on an anchored, still-open segment, which is precisely the live case.
- **Zero rendering on the meter line:** the counter shows `0 lvl` on a night with no
  level-up, exactly as the AA counter shows `0 aa` today. An earlier framing wanted each
  stat hidden until it first moved; that is a change to all five stats and the overflow
  rule, so it is out of scope here and should be its own plan.
- **`renderTracked` will count the live session** in its "N sessions · Xh tracked" line once
  it is in `state.sessions`. That is correct — the sentence describes what the rail is
  showing — and the existing `· recording now` clause already says one of them is open.
- **Open question, low stakes:** whether `lvl` or `levels` reads better as the unit at the
  overlay's font size. `lvl` is assumed, being narrower on a line that drops content when it
  runs out of room, and is trivial to change after seeing it in game.
- **The stale warning's evidence, for the changelog.** `pushStatus` has three call sites
  (`main.js:239`, `:723`, `:1602`) and no timer; `stale` is absent from the SNAPSHOT
  payload. That is the whole diagnosis — the check is a one-shot verdict presented as a
  live state. A measurement of the live log from WSL while the game was writing showed the
  file growing 1802 bytes in 6 seconds with mtime current, so mtime lag is *not* what is
  being observed here and should not be claimed as the cause; the frozen call site explains
  it on its own.
- **Open question:** whether 2s is the right live-refresh cadence. It is cheap (a
  `checkpoint()` call plus a pane re-render, against the overlay's 4 Hz push) and this
  window is opened between pulls, so it should be comfortable. Worth a look at CPU with the
  window open during a raid.
- Version is not bumped by this plan; that is a separate commit on request.
