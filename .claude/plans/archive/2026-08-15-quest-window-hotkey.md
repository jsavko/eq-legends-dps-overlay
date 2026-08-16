---
status: completed
---
# Quest window hotkey (Ctrl+Shift+Q)

**Date:** 2026-08-15

---

## Goal

Add a global hotkey — default `Control+Shift+Q` — that opens the quest window from
inside the game, without a trip to the tray. The second half of the request, "make all
the hotkeys configurable", turns out to already be true: every global binding lives in
`config.hotkeys` (`src/main/config.js` DEFAULTS), is editable on the Settings → Hotkeys
page, re-registers on save (`main.js:2132` calls `registerHotkeys()` whenever a patch
touches `hotkeys`), and the tray reads its accelerator labels from config so they can't
go stale. So the work is to add the new quest binding *through* that existing pipeline —
config default, registration, tray accelerator, settings row — which makes it
configurable for free and keeps the "one pipeline for every hotkey" property intact.

## Approaches Considered

### 1. Toggle binding through the existing hotkey pipeline
- **Description:** Add `openQuests: 'Control+Shift+Q'` to `DEFAULTS.hotkeys`; bind it in
  `registerHotkeys()` to a `toggleQuests()` that closes the window if it exists and
  calls `createQuests()` otherwise; put `accelerator: keys.openQuests` on the tray's
  "Quests…" row; add a row to the settings form's Hotkeys page.
- **Pros:** Symmetric with every other binding (Ctrl+Shift+H toggles, Ctrl+Shift+M
  cycles — a second press always does something). The player can dismiss the window
  without reaching for the mouse mid-pull. Config's one-level-deep merge means old
  configs gain the key with no migration, exactly like `newSession` and `copyReport`
  did. Zero new mechanisms.
- **Cons:** "Toggle" is slightly more than the literal ask ("open"). If the window is
  open but buried behind the game, the first press closes it rather than raising it —
  a minor surprise; the second press brings it back focused.

### 2. Open/focus-only binding
- **Description:** Same wiring, but the hotkey only ever calls `createQuests()` (which
  focuses an existing window).
- **Pros:** Matches the literal request; no buried-window surprise.
- **Cons:** A hotkey that can open but not close forces a mouse trip to dismiss —
  precisely the interaction the binding exists to avoid. No other binding here is
  one-way.

### 3. Hotkey-capture recorder UI while we're in there
- **Description:** Replace the free-text accelerator inputs on the Hotkeys page with
  "press the keys" recorders that capture a chord and render it as an accelerator.
- **Pros:** Friendlier than typing Electron accelerator syntax; catches typos at entry.
- **Cons:** Scope creep on a request that is already satisfied — the text inputs work,
  the hint documents the syntax, and `registerHotkeys()` already toasts when a binding
  is invalid or taken. A UI redesign here would also want a Pencil mockup first.
  Deliberately not now.

### 4. Fold the quest window into the Ctrl+Shift+H HUD toggle
- **Description:** Make show/hide HUD include the quest window.
- **Pros:** No new binding to remember.
- **Cons:** Wrong by the app's own architecture: the quest window takes real mouse
  input and is opened between pulls — it is History's sibling, not part of the HUD.
  Ctrl+Shift+H deliberately leaves those windows alone.

## Chosen Approach

**Approach 1.** It rides the pipeline that already makes every hotkey configurable,
costs no new mechanism, and gives the keyboard both directions of the gesture. The
buried-window edge case is acceptable: worst case is two presses, and the closing press
is itself information ("it was open").

## Tasks

- [x] `src/main/config.js` — add `openQuests: 'Control+Shift+Q'` to `DEFAULTS.hotkeys`,
      with the same no-migration comment `newSession` and `copyReport` carry (old
      configs gain the key on the one-level-deep merge in `load()`).
- [x] `src/main/main.js` — add `toggleQuests()`: if `questsWindow` exists and is not
      destroyed, `close()` it; otherwise `createQuests()`.
- [x] `src/main/main.js` `registerHotkeys()` — `bind(keys.openQuests, toggleQuests,
      'quests')`.
- [x] `src/main/main.js` tray menu — add `accelerator: keys.openQuests` to the
      "Quests…" row so the binding is discoverable, same as "Copy meter to chat".
- [x] `src/renderer/setup/index.html` — add a "Quest window" row (`hk-quests`) to the
      Hotkeys page, above the hint.
- [x] `src/renderer/setup/setup.js` — populate `$('hk-quests')` from
      `cfg.hotkeys.openQuests ?? ''` and include `openQuests` in the saved `hotkeys`
      patch.
- [x] `tests/config.test.js` — extend the "config written before a hotkey existed gains
      it" test to pin `openQuests`, alongside `newSession`/`copyReport`.
- [x] `npm test` in WSL.
- [x] Kill the overlay, `scripts/dev.sh pack`, relaunch the win-unpacked exe.
- [x] `docs/changelog/2026-08-15-quest-window-hotkey.md`.

## Notes

- `Control+Shift+Q` collides with nothing here: existing bindings use L, H, R, M, A, N,
  C. If another app owns it, `registerHotkeys()` already toasts that, and the new
  settings row is the remedy.
- No IPC change needed — `toggleQuests` lives in main, which owns the window; the
  existing `QUESTS_OPEN` handler is untouched.
- "Make all hotkeys configurable" required no work: all seven existing gestures are on
  the Settings → Hotkeys page, and the only `globalShortcut.register` call site is
  `registerHotkeys()`, which reads exclusively from config. Per-window keys (e.g. ESC
  inside a window) are window-local, not global hotkeys, and stay as they are.
