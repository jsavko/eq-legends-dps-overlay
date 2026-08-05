# History window refreshes live when a fight ends

**Date:** 2026-08-05

User report from last night's raid: "the history isn't updating when the monster dies —
we had to wait until the end of the next combat to see info about that fight."

## The data was never late — the window was

First suspicion was the encounter-close machinery (does the all-slain path fire in a
raid?), so the store was checked before touching anything: `Rhale_oggok.jsonl` shows
`00:53:26 → 00:57:50, closeReason: "killed"` for Lord Nagafen. The post-kill grace path
worked, and the record was on disk about three seconds after the dragon died. No parser
change was needed, and none was made.

The History window, though, fetched its list exactly once — in `init()` — and nothing
ever told it about new fights: `HISTORY_LIST` is pull-only, and the only re-fetch
triggers were the character dropdown and the Clear button. A window left open across a
raid (the second-monitor case the window exists for) was frozen at whatever moment it
was opened; *reopening* it was what "refreshed" it, which made the delay look tied to
the next fight ending.

## Notify-then-pull

`persistEncounter` now sends `HISTORY_APPENDED` (`{ key }`) to the history window after
a successful append — after, so a failed write never announces a fight that is not in
the file. The renderer answers by re-invoking the existing `HISTORY_LIST` handle and
re-rendering the rail. The store's `list()` stays the single source of truth for the
index-entry shape; the push carries no data, only the news. Pushing the record itself
(duplicates the entry shape in a second place), polling (re-reads a multi-MB JSONL all
session to usually learn nothing), and refresh-on-focus (never fires for a
visible-but-unfocused second monitor) were all considered and rejected.

The refresh path (`refreshList`) is deliberately NOT `loadCharacter`, which resets
fight/member/metric selection by design. It re-fetches, re-renders the rail in place,
and preserves everything the user chose, with two behaviors on top:

- **Sticky top.** The window auto-selects the newest fight on open, so a user still
  sitting on the newest fight they can see is following along live — their selection
  advances to the fight that just ended, zero clicks after a boss kill. A user parked
  on an older fight navigated there deliberately; the new fight only joins the rail.
  "Newest" is judged through the active filters, because following the top only makes
  sense for the top the user can actually see.
- **No scroll-yanking.** `markSelectedRow`'s `scrollIntoView` now runs only on explicit
  actions (click, arrow keys, filter change), never on a background refresh — a fight
  closing must not move the rail under a user who scrolled away to read something.

An append for a *different* character leaves the rail alone but still refreshes the
character dropdown, since that append may have just created the character's first file.
A window opened before any history existed does one full `loadCharacter` on the first
append — the one moment there is nothing on screen to preserve.

## Verification

All 211 WSL-side tests pass (pure modules untouched). The renderer was verified
headlessly the way `2026-08-02-breakdown-shows-every-ability.md` established: the
history window loaded in Windows headless Chrome with a stubbed `window.api`, fed a
fixture built from the real store by the real `EncounterStore`. Confirmed in one
scripted pass: append while on the newest fight follows to the new one (sticky top);
append while parked on an older fight grows the rail by one and moves nothing else;
an append for another character changes nothing. One note: ES modules will not load
over `file://` (CORS) — serve the harness over HTTP from WSL and load
`http://localhost:<port>/` in the Windows Chrome instance.

## Files

- `src/main/ipc.js` — `HISTORY_APPENDED` push channel.
- `src/main/main.js` — `persistEncounter` sends it after a successful append.
- `src/renderer/history/preload.cjs` — `onAppended` subscription.
- `src/renderer/history/history.js` — `refreshList` (sticky top, foreign-key guard),
  `rebuildCharacterOptions` extracted from `loadCharacter`, reveal-only-on-explicit-
  action `markSelectedRow`.

The dist rebuild was deferred: the user was in-game at execution time, and the build
both fails on the running exe's locked files and would kill the overlay mid-session.
Run `scripts/dev.sh dist` after quitting the overlay — the `win-unpacked` exe does not
pick this up until then.
