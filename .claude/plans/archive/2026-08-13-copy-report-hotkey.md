---
status: completed
---
# A hotkey for the chat report

**Date:** 2026-08-13

---

## Goal

The COPY button on the meter puts the current fight on the clipboard as one pasteable
chat line, and it works — but it is only reachable while the overlay is **unlocked**
(`body:not([data-locked="true"]) #controls { display: flex }`), which is the state the
overlay is deliberately *not* in during a pull. Getting the line into guild chat today
means Ctrl+Shift+L, mouse to the button, click, Ctrl+Shift+L again, all with the game
fullscreen behind it.

Add a global hotkey — default `Control+Shift+C` — that does exactly what the button does:
copies the metric currently on screen, in the rows and order currently on screen, and says
what it cost (shortened / members dropped) in the same toast. It joins the six bindings
already in `config.hotkeys`, is rebindable in the settings form's Hotkeys page, and appears
in the tray with its accelerator like every other every-pull control.

The load-bearing constraint is `src/main/ipc.js`, which spells out why `CLIPBOARD_COPY`
carries **text** rather than a "copy the meter" intent: the line has to be the rows the
overlay is showing, with the filters the current metric applies, and a second derivation of
that in main would drift from `render()` silently — discovered only once the wrong line is
in guild chat. Whatever this plan does, `report.js` stays the one place that decides what
the line says.

## Approaches Considered

### 1. Main sends a copy *request* to the overlay renderer; the renderer runs the existing `copyReport()`
- **Description:** New main→renderer channel (`COPY_REPORT`), exposed on the preload as
  `onCopyRequest`. `registerHotkeys` binds `keys.copyReport` to a main-side function that
  sends it; `overlay.js` wires it to the same `copyReport()` the button's click handler
  calls, which composes via `chatReport(snapshot, metric)` and invokes `CLIPBOARD_COPY`.
- **Pros:** Literally one code path — the hotkey and the button cannot disagree, by
  construction rather than by discipline. Honours the documented `ipc.js` design. The
  toast wording, the "Nothing to copy yet" guard and the leave-the-clipboard-alone
  behaviour all come for free. Nothing in `report.js`, `render()` or the shrink ladder is
  touched, so the existing `tests/report.test.js` still covers the interesting half.
- **Cons:** Needs a new channel, a preload entry and a renderer listener (three small
  edits in three files). Does nothing if the overlay window is gone — a guard, not a
  problem, since with no overlay window there is no meter to copy.

### 2. Main composes the line itself from `parser.snapshot()` and `config.metric`
- **Description:** Import `report.js` into `src/main/main.js`, build the snapshot the
  push loop already builds, read the stored metric, `clipboard.writeText`, `toast(...)`.
  No renderer involvement at all.
- **Pros:** Fewest moving parts at the wiring level; works even with the overlay window
  destroyed; the toast is already a main-side function.
- **Cons:** This is the exact thing `ipc.js` argues against in prose. Main would be
  re-deriving "what is on screen" from stored state, and the renderer's view is not purely
  a function of it — `overlay.js` holds its own `metric`, its own last snapshot, and its
  own idea of when a push is stale. The failure mode is a copied line that quietly
  disagrees with the meter above it. Rejected on the project's own recorded reasoning.

### 3. Renderer-side `keydown` listener in the overlay document
- **Description:** `document.addEventListener('keydown', ...)` in `overlay.js`, matching
  Ctrl+Shift+C.
- **Pros:** No config, no channel, no main changes.
- **Cons:** Does not work. The overlay is frameless, `skipTaskbar`, always-on-top,
  click-through and never focused — the game owns the keyboard. A DOM key handler fires
  only in the one state (unlocked and clicked into) where the button is already visible.
  Rejected outright.

### 4. Reuse `CLIPBOARD_COPY` by having main ask the renderer for text and write it
- **Description:** Main pulls the composed line out of the renderer (a reply channel, or
  `webContents.executeJavaScript('chatReport(...)')`), then writes and toasts from main.
- **Pros:** Keeps composition in the renderer, keeps the clipboard write in main — the
  same split as today.
- **Cons:** A request/reply pair over `send` needs its own correlation and timeout, and
  `executeJavaScript` reaches into module-private renderer state (`snapshot`, `metric`)
  that is not exported and would break on any refactor with no test to catch it. Strictly
  more machinery than approach 1 for the same outcome.

## Chosen Approach

**Approach 1.** The hotkey becomes a second *trigger* for the button's existing action
rather than a second implementation of it, which is the whole point: `report.js` decides
what the line says, `render()` and `copyReport()` share it, and main's only job stays
"write this text to the Windows clipboard". The added surface is one channel, one preload
method, one listener, one config key and one settings field.

Two behaviours worth stating up front, both deliberate:

- **While the HUD is hidden (Ctrl+Shift+H) the copy still happens and the toast is
  invisible.** The snapshot push loop keeps feeding a hidden overlay window, so the line is
  current; the toast simply draws into a hidden window. This matches `resetEncounter`,
  whose "Encounter reset" toast is invisible under the same conditions — the precedent is
  already set, and a tray balloon for one action would be a new notification surface for
  no real gain.
- **`Control+Shift+C` is taken globally while the overlay runs**, as every
  `globalShortcut` binding is — a browser's DevTools "inspect element" chord included.
  That is the ask, it sits beside the six chords already claimed, and the settings field
  makes it rebindable (an empty string binds nothing; `bind()` already returns early on a
  falsy accelerator).

## Tasks

- [x] `src/main/config.js` — add `copyReport: 'Control+Shift+C'` to `DEFAULTS.hotkeys`,
      with a comment noting no migration is needed (one-level-deep merge means an existing
      config simply gains the binding, the way `newSession` did)
- [x] `src/main/ipc.js` — add `COPY_REPORT: 'overlay:copy-report'` under the main→renderer
      channels, with a comment tying it to the `CLIPBOARD_COPY` rationale directly above:
      this channel carries an *intent* precisely because the renderer, not main, is where
      the rows and the metric live
- [x] `src/renderer/overlay/preload.cjs` — add `COPY_REPORT` to the `CH` map and expose
      `onCopyRequest: on(CH.COPY_REPORT)`
- [x] `src/renderer/overlay/overlay.js` — in `wireControls()`, wire
      `window.api.onCopyRequest(copyReport)` next to the `btn-copy` click handler, so the
      two triggers of the one action read as a pair
- [x] `src/main/main.js` — add a `copyReport()` function that sends `CHANNELS.COPY_REPORT`
      to the overlay window (guarding null/destroyed), and `bind(keys.copyReport,
      copyReport, 'copy')` in `registerHotkeys()`
- [x] `src/main/main.js` — add a tray item `Copy meter to chat` with
      `accelerator: keys.copyReport`, placed with the every-pull controls (after
      `Show <metric>`, above `Reset encounter`), so the gesture is discoverable without
      opening settings
- [x] `src/renderer/setup/index.html` — add a `hk-copy` row to the Hotkeys page, labelled
      "Copy meter to chat", in the same order the tray and `registerHotkeys` use
- [x] `src/renderer/setup/setup.js` — load it (`$('hk-copy').value = cfg.hotkeys.copyReport ?? ''`)
      and write it in the `hotkeys` block of the save patch
- [x] `tests/config.test.js` — extend the "config written before a hotkey existed" test (or
      add its sibling) to assert `DEFAULTS.hotkeys.copyReport` ships a binding and that an
      old config gains it while keeping the player's own choices
- [x] `npm test` — full suite green in WSL
- [x] `scripts/dev.sh pack`, then relaunch `C:\eqoverlay-dev\dist\win-unpacked\EQL DPS Overlay.exe`
      so the change is actually in front of James (kill the running overlay first — the
      build fails on locked files)
- [x] `docs/changelog/2026-08-13-copy-report-hotkey.md` — why the hotkey delegates to the
      renderer instead of composing in main, and the two accepted behaviours (invisible
      toast while hidden, chord claimed globally)

## Notes

- Nothing in `report.js` changes, so the shrink ladder, the drop-members last resort and
  their tests are untouched. This plan adds a trigger, not a feature.
- The button's `title` attribute is left alone: the binding is rebindable, and a tooltip
  naming `Ctrl+Shift+C` would be a hardcoded claim that goes stale the moment somebody
  changes it in settings. The tray row carries the accelerator, and the tray reads it from
  config on every rebuild, so that one cannot drift.
- Verified while exploring: the push loop sends snapshots to the overlay window whenever it
  exists, hidden or not (`startPushLoop` only checks `isDestroyed()`), which is what makes
  the hidden-HUD copy correct rather than stale.
- Executed as planned, with no surprises: the tray row was kept (see the open question
  below), 710 tests pass, and `pack` + relaunch is done, so the running overlay has it.
- Open question, low stakes: whether `copy` deserves its own tray row at all, given the
  menu is already long. Included above because it is an every-pull action and every other
  every-pull action is in that group — say so if it should be dropped.
