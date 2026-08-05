---
status: completed
---
# History window live refresh on encounter close

**Date:** 2026-08-05

---

## Goal

When a fight ends, an open History window should show it within seconds — not on the
next reopen. The user reported that after a raid boss died they "had to wait until the
end of the next combat" to see the fight in history.

Investigation shows the pipeline up to the window is already correct, and the delay the
user saw was the window, not the data:

- The live session's JSONL (`history/Rhale_oggok.jsonl`) records **Lord Nagafen closed
  with `closeReason: "killed"`** — the all-slain + 3s-grace path fired, so the record
  hit disk ~3 seconds after the dragon died. Timeout-closed fights land 15s after the
  last damage; both are fine.
- The History window, however, fetches its fight list **exactly once**, in `init()` →
  `loadCharacter()` (`src/renderer/history/history.js:32`). The only things that ever
  re-fetch are the character dropdown and the Clear button. Main never pushes anything
  to the history window — `HISTORY_LIST` is pull-only (`src/main/main.js:718`). A window
  left open across a raid (the second-monitor use case this window exists for) is stale
  forever; reopening it is what "refreshed" it, which is why the delay looked tied to
  the next fight.

So the fix is a live-refresh path from `persistEncounter` to an open History window,
one that respects the window's no-reflow contract: a new fight slides into the rail;
whatever the user is reading in panes 2 and 3 stays put.

## Approaches Considered

### 1. Notify-then-pull: main pushes "appended" event, renderer re-fetches
- **Description:** After `history.append()` succeeds in `persistEncounter`, main sends a
  new `HISTORY_APPENDED` push (carrying the store key) to the history window if one is
  open. The renderer responds by re-invoking the existing `HISTORY_LIST` handle and
  re-rendering the rail, preserving selection and filters.
- **Pros:** Event-exact timing (fight appears ~3s after the kill); the store's `list()`
  stays the single source of truth for index-entry shape; tiny payload; zero work while
  the window is closed or nothing is being appended; matches the codebase's existing
  push-channel pattern (`CHANNELS` pushes + preload `ipcRenderer.on`).
- **Cons:** Touches four files (ipc.js, main.js, preload.cjs, history.js); re-reads the
  JSONL once per fight close (milliseconds at this volume, per history.js's own header).

### 2. Push the new record itself; renderer merges locally
- **Description:** Send the appended record (or a pre-built index entry) in the push;
  the renderer inserts it into `state.encounters` without re-fetching.
- **Pros:** No file re-read; single IPC round trip.
- **Cons:** Duplicates `EncounterStore.list()`'s index-entry derivation in a second
  place (or exports it to the renderer), creating two sources of truth for the entry
  shape; character-switch and clear-while-open edge cases have to be re-solved by hand.
  Saves milliseconds per *fight close* — not worth a drift risk.

### 3. Renderer polls `HISTORY_LIST` every few seconds
- **Description:** `setInterval` in the history renderer re-invoking the list call.
- **Pros:** No main-process changes at all.
- **Cons:** Re-reads and re-parses a multi-MB JSONL continuously for the life of the
  window, almost always to learn nothing; up-to-interval lag; nothing else in this app
  polls for data main already knows the moment it changes.

### 4. Refresh on window focus
- **Description:** Reload the list whenever the history window regains focus.
- **Pros:** Trivial.
- **Cons:** Fails the primary use case — the window sitting visible-but-unfocused on a
  second monitor during a raid never regains focus. Also refreshes (and would today
  reset selection) at exactly the moment the user comes back to read.

## Chosen Approach

**Approach 1, notify-then-pull.** It is the only option that is both event-exact and
keeps `EncounterStore.list()` as the sole authority on what a rail entry looks like.
The refresh handler in the renderer must be a *lighter* path than `loadCharacter()`
(which deliberately resets fight/member/metric state): re-fetch, re-render the rail,
keep everything the user selected.

Rail behavior on refresh ("sticky top"): if the selected fight was the newest entry
before the append — the default state, since the window auto-selects the newest fight
on open — selection follows to the new fight, so the raid flow (boss dies → glance at
the window) shows the new fight with zero clicks. If the user had navigated to an older
fight, selection stays where it is and the new fight just appears at the top of the
rail. `renderRail()` already preserves a surviving selection (history.js:141), so only
the follow-to-newest case needs code.

## Tasks

- [x] `src/main/ipc.js`: add `HISTORY_APPENDED: 'history:appended'` to the
      main → renderer pushes section of `CHANNELS`.
- [x] `src/main/main.js` `persistEncounter()`: capture the key returned by
      `history.append(record)` and, if `historyWindow` is open and not destroyed, send
      `CHANNELS.HISTORY_APPENDED` with `{ key }` after a successful append (inside the
      try, after `append` — a failed write must not announce a fight that isn't there).
- [x] `src/renderer/history/preload.cjs`: mirror the channel name and expose
      `onAppended(cb)` via `ipcRenderer.on`, following the other preloads' pattern.
- [x] `src/renderer/history/history.js`: add `refreshList(key)` —
      - if `key !== state.key`, re-invoke `historyList(state.key)` only to rebuild the
        character dropdown (a new character's first fight creates a new file) and leave
        the rail alone;
      - otherwise re-fetch, note whether `state.fightId` was the previous newest entry,
        update `state.encounters` + dropdown options in place (no state reset), call
        `renderRail()`, and if the user was on the newest fight, `selectFight()` the new
        newest ("sticky top").
- [x] `src/renderer/history/history.js`: make `markSelectedRow()`'s `scrollIntoView`
      apply only to explicit selection (click / arrow keys), not background refreshes —
      a live append must never yank the rail while the user is scrolled elsewhere.
- [x] Wire `window.api.onAppended(refreshList)` in `wireEvents()`.
- [x] `npm test` (pure modules are untouched, suite must stay green — 211/211 pass).
- [x] Verify the renderer's refresh behavior. Done headlessly instead of via
      `dev.sh start` (the user was in-game, so the app could not be relaunched): the
      history window loaded in Windows headless Chrome with a stubbed `window.api` and
      a fixture built from the real store by the real `EncounterStore`. Confirmed:
      sticky-top follow when on the newest fight; rail-only growth when parked on an
      older fight; no change at all on a foreign-character append.
- [x] `docs/changelog/2026-08-05-history-window-live-refresh.md` per conventions.
- [x] Bump `package.json` version (own commit) and `scripts/dev.sh dist` — the user
      launches the `win-unpacked` exe, which does not update on sync.
      *Bump done (0.3.1). Dist was briefly deferred because the user was in-game, then
      shipped the same morning on their standing instruction to kill and rebuild even
      mid-session: overlay killed, dist built, overlay relaunched on 0.3.1.*

## Notes

- Empirical basis: last night's raid in `Rhale_oggok.jsonl` shows
  `00:53:26 → 00:57:50 killed Lord Nagafen` — the encounter-close machinery (including
  the raid-relevant all-slain path) worked, and the record was on disk seconds after
  the kill. No parser or encounter-lifecycle changes are needed.
- The no-reflow invariant is safe: the rail is a scrolling pane by design; a new row at
  its top moves nothing outside it, and panes 2/3 only change on the sticky-top follow,
  which replaces content inside fixed panes exactly like a click would.
- Timeout-closed fights will still appear ~15s after the last damage — inherent to not
  knowing a fight is over until the idle window elapses, and fine in practice; the
  raid case the user hit closes via the 3s post-kill grace.
- Rejected as redundant: `fs.watch` on the history dir (main is the only writer, so it
  already knows the moment anything changes).
- Execution notes: all 211 tests pass. Headless-harness gotcha for next time: ES
  modules refuse to load over `file://` (CORS) — serve the harness dir over HTTP from
  WSL (`python3 -m http.server`) and point the Windows Chrome instance at
  `http://localhost:<port>/`. The store gained new fights (Guk, ~07:50–08:43 AM) while
  this plan ran — the user was playing during execution, which is what deferred the
  dist step.
