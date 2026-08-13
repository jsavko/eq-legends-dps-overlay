# A hotkey for the chat report

**Date:** 2026-08-13 — follows `2026-08-10-copy-dps-to-chat.md`, which shipped the COPY
button and described its workflow as "Ctrl+Shift+L → COPY → Ctrl+Shift+L → paste".

That sentence was the feature request. `Control+Shift+C` now does the whole of it:

> "The copy paste when unlocking the parser works well but a hotkey to copy would be
> nice. Maybe control+shift+c?"

The button was only ever reachable while the overlay is **unlocked**
(`body:not([data-locked="true"]) #controls { display: flex }`) — which is precisely the
state the overlay is not in during a pull, because locked is what makes it click-through
and hands the game every click. So taking a line meant unlocking, finding the button with
the mouse over a fullscreen game, clicking, and locking again. One global chord replaces
the four steps, and it is the same action, not a second one.

## The hotkey is a second *trigger*, not a second implementation

This is the whole of the design, and it was decided by a comment that was already in
`ipc.js`. `CLIPBOARD_COPY` deliberately carries **text** rather than a "copy the meter"
intent, because what has to reach the clipboard is *the rows the overlay is showing, in
its order, with the filters the current metric applies* — `report.js`, shared with
`render()` — and main re-deriving that from `parser.snapshot()` and `config.metric` would
be a second derivation that drifts silently. The failure mode is not a crash; it is a
copied line that disagrees with the meter above it, discovered once it is in guild chat.

So the hotkey does not compose anything. `COPY_REPORT` is a main→renderer channel with
**no payload** — an intent, the exact inverse of `CLIPBOARD_COPY` beneath it — and the
renderer answers it by calling the same `copyReport()` the button's click handler calls,
which comes back through `CLIPBOARD_COPY` with finished text for main to write. The two
triggers cannot disagree about what the meter says, by construction rather than by
discipline, and everything the button had comes along unchanged: the shrink ladder, the
`Copied — 6 of 8 fit` toast when members are dropped, the "Nothing to copy yet" guard, and
the rule that an empty meter leaves whatever the player had copied alone.

Nothing in `report.js` changed. `tests/report.test.js` still covers the interesting half —
the ranking, the wording, the ladder — because this added a caller, not a feature.

## Two behaviours that are deliberate

**With the HUD hidden (Ctrl+Shift+H) the copy still lands, and the toast is invisible.**
The push loop feeds a hidden overlay window as long as it exists (`startPushLoop` checks
only `isDestroyed()`), so the line is *current* rather than frozen at whatever was on
screen when the HUD went away — the copy is right, and only its confirmation is missing.
That is the deal `resetEncounter` has always had, whose "Encounter reset" toast is
invisible under exactly the same conditions. A tray balloon for this one action would be a
new notification surface bolted on for a case the app already has a precedent for.

**`Control+Shift+C` is claimed globally while the overlay runs**, as every `globalShortcut`
binding is — a browser's DevTools inspect chord included. It sits beside the six chords
already taken, it is what was asked for, and it is rebindable in Settings → Hotkeys; an
empty field binds nothing, since `bind()` returns early on a falsy accelerator.

## Where it is reachable from

- **The chord**, bound in `registerHotkeys` beside the other six.
- **The tray**, as `Copy meter to chat`, placed with the every-pull controls (below
  `Show <metric>`, above `Reset encounter`). This row is how a player finds out the
  gesture exists at all, and it reads the accelerator out of config on every menu rebuild,
  so it cannot go stale. The overlay button's `title` was deliberately left alone for the
  opposite reason: a tooltip naming `Ctrl+Shift+C` would be a hardcoded claim that lies
  the moment somebody rebinds it.
- **Settings → Hotkeys**, as a `hk-copy` field in the same order the tray and
  `registerHotkeys` use.

## Files

| File | Change |
|---|---|
| `src/main/config.js` | `hotkeys.copyReport: 'Control+Shift+C'`. No migration: `load()` merges DEFAULTS one level deep, so an existing config simply gains the binding, the way `newSession` did |
| `src/main/ipc.js` | `COPY_REPORT: 'overlay:copy-report'` under the main→renderer pushes, with the note on why this one is an intent while `CLIPBOARD_COPY` is text |
| `src/main/main.js` | `copyReport()` — sends the intent, guarding a null or destroyed window; bound in `registerHotkeys`; the `Copy meter to chat` tray row |
| `src/renderer/overlay/preload.cjs` | `onCopyRequest` |
| `src/renderer/overlay/overlay.js` | `window.api.onCopyRequest(copyReport)` wired in `wireControls()`, next to the button it shares an action with |
| `src/renderer/setup/index.html`, `setup.js` | The `hk-copy` row, loaded and written with the rest of the block |
| `tests/config.test.js` | The pre-existing-config test now asserts the copy binding is gained too — its fixture is frozen at the shape that shipped, so every later gesture is exercised as a config that has never seen it |

710 tests pass.
