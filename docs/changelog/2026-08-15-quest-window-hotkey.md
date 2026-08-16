# Quest window hotkey (Ctrl+Shift+Q)

**Date:** 2026-08-15

## Summary

The Quests window now has a global hotkey, default `Control+Shift+Q`, that toggles it
from inside the game — open if it is gone, closed if it is up — without a trip to the
tray. The binding rides the existing hotkey pipeline end to end (config default,
`registerHotkeys()`, tray accelerator label, Settings → Hotkeys row), which makes it
configurable for free and keeps the one-pipeline-for-every-hotkey property intact.

The second half of the request, "make all the hotkeys configurable", required no work:
every global binding already lives in `config.hotkeys`, is editable on the Settings →
Hotkeys page, re-registers on save, and feeds the tray's accelerator labels so they
cannot go stale. This change just adds the eighth binding through that pipeline.

## Changes

### Features

- **`Control+Shift+Q` toggles the Quests window.** A toggle, not open-only: every
  other binding works in both directions (H hides what it showed, M keeps cycling),
  and a hotkey that can summon a window but not dismiss it forces the mouse trip it
  exists to avoid. The known edge: a window open but buried behind the game closes on
  the first press instead of raising — worst case is a second press, and the closing
  press itself answers "was it open?".
- **The tray's "Quests…" row shows the binding.** Display-only in a tray menu, but the
  display is how a player finds out the gesture exists — same deal as "Copy meter to
  chat". The row's click stays open/focus: a menu row named "Quests…" that closed the
  window would be the menu lying about what it does.
- **A "Quest window" row on Settings → Hotkeys** (`hk-quests`), loaded and saved with
  the other seven bindings.

## Files modified

- `src/main/config.js` — `openQuests: 'Control+Shift+Q'` in `DEFAULTS.hotkeys`, with
  the same no-migration comment `newSession` and `copyReport` carry: an old config
  gains the key on the one-level-deep merge in `load()`, nothing already bound changes
  meaning.
- `src/main/main.js` — `toggleQuests()` (close if present, `createQuests()` otherwise);
  `bind(keys.openQuests, toggleQuests, 'quests')` in `registerHotkeys()`;
  `accelerator: keys.openQuests` on the tray's "Quests…" row.
- `src/renderer/setup/index.html` — the `hk-quests` row on the Hotkeys page, above the
  syntax hint.
- `src/renderer/setup/setup.js` — populates `hk-quests` from
  `cfg.hotkeys.openQuests ?? ''` and includes `openQuests` in the saved `hotkeys` patch.
- `tests/config.test.js` — the "config written before a hotkey existed gains it" test
  now pins `openQuests` alongside `newSession` and `copyReport`; the existing
  no-clashing-defaults test covers the new binding automatically.

## Rationale

`Control+Shift+Q` collides with nothing here (existing bindings use L, H, R, M, A, N,
C); if another app owns it, `registerHotkeys()` already toasts that and the settings
row is the remedy. No IPC change was needed — `toggleQuests` lives in main, which owns
the window, and the existing `QUESTS_OPEN` handler is untouched. Per-window keys (ESC
inside a window) are window-local, not global hotkeys, and stay as they are.
