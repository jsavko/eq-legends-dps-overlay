# History follow-ups: backfill, tray entry, and a clear-log button

**Date:** 2026-08-04

Three small things from first contact with the history feature, all user-reported
within the hour.

## Backfill (`scripts/backfill-history.js`)

History began recording at deploy, which made the History tab open with 3 fights while
the player's log held 439 — including the Nagafen attempts the feature was built to
review. The new script replays an existing eqlog through the same parser + store the
app uses, deduplicating by record id against whatever is already on disk, so it is safe
to run while the overlay is live and safe to run twice. Run once for Rhale (437 written,
2 deduped). One tail-started partial the live app had recorded (the overlay attached
mid-fight at relaunch) was removed in favor of the backfilled full version.

## "History…" in the tray

The tab lived only inside the settings window, and the user's first instinct was to
look for a menu item — a destination people look for by name. The tray now has
History… above Settings…; it opens the settings window with the History tab already
selected (`--overlay-tab` argv, read by the preload).

## Clear log file…

In the settings Log section: truncates the followed eqlog to zero bytes, behind a
confirm that states what is and is not lost. Safe by construction: EQ appends per
line, the tailer already detects truncation and resets the parser, and encounter
history is untouched — persisting fights is exactly what makes clearing the raw log
cost nothing.

## Files

- `scripts/backfill-history.js` — **new**.
- `src/main/main.js` — tray History… item; `createSetup(mode, tab)`; `LOGS_CLEAR` handler.
- `src/main/ipc.js`, `src/renderer/setup/preload.cjs` — `LOGS_CLEAR` channel, `initialTab`.
- `src/renderer/setup/index.html`, `setup.js` — Clear log file… button; initial-tab open.
