---
status: completed
---
# Start a new session on demand — hotkey and tray item

**Date:** 2026-08-08

---

## Goal

A play session currently begins on the first tracked event and ends only when the app
decides it has: an hour of silence (`IDLE_MS`), a character switch, tracking being turned
off, or a quit. There is no way for the player to say "that grind is over, start counting
again from here" — and that moment is real and frequent: you move from one camp to
another, or from a farming stretch to a raid, and everything after it belongs to a
different night than everything before it.

Add that gesture, in the two places the player reaches for it: a global hotkey (the moment
you want it, the game is fullscreen in front of you) and a tray menu item next to the
reset that already exists.

The gesture **closes and writes** the session in flight rather than discarding it. The
last three hours happened; a hotkey that silently threw them away would be the one part of
this app that loses data on purpose. `SessionTracker.close('manual')` already does exactly
this — writes through `onSessionEnd`, moves the `minTs` floor to the last tracked event so
the new session cannot re-count what the old one had, and returns null for a phantom open.
Nothing in `src/session/` needs to change; this is entirely about exposing what is there.

Out of scope: the encounter/meter reset, which has its own hotkey (`Ctrl+Shift+R`) and its
own lifetime — an encounter is seconds long and closes itself.

## Approaches Considered

### 1. A dedicated "start new session" action — hotkey + tray item
- **Description:** New `startNewSession()` in `main.js` beside `resetEncounter()`: calls
  `session.close('manual')` (which persists via `persistSession`), clears the checkpoint,
  toasts what happened. New `hotkeys.newSession` default, a tray item under "Reset
  encounter" shown only while tracking is on, and a field in the settings hotkey block.
- **Pros:** Matches the shape the codebase already has for every other gesture (config
  key → `registerHotkeys` bind → tray row → settings field). The two resets stay separate
  things with separate lifetimes, which is what they are. Costs no new IPC channel.
- **Cons:** A fifth... sixth hotkey to remember, and a second row in the tray that says
  "reset"-ish. Player has to know that "new session" preserves and "reset encounter"
  discards.

### 2. Fold it into the existing "Reset encounter" gesture
- **Description:** `Ctrl+Shift+R` closes the session as well as clearing the meter.
- **Pros:** One gesture, nothing new to learn or bind.
- **Cons:** Wrong by lifetime, and destructive by surprise. Reset-encounter is pressed
  mid-pull when the meter shows something stale — doing that would end the night's record
  every time, and the two actions have wildly different costs to get wrong. Also breaks
  the parser's contract in spirit: a manual encounter reset is deliberately *unrecorded*,
  while a manual session close deliberately *is* recorded.

### 3. A button in the Session window only
- **Description:** "Start new session" beside Import in the session window's header.
- **Pros:** Sits where the result is visible — the rail gains the closed session
  immediately.
- **Cons:** Fails the actual request. The moment you want this is with the game
  fullscreen; opening a window to press a button is the thing a hotkey exists to avoid.
  Worth having *as well*, later — see Notes.

### 4. Infer the boundary — start a new session on a long zone change or camp change
- **Description:** Heuristic: a zone change followed by N minutes of no kills ends the
  session.
- **Pros:** No hotkey, no menu, nothing to remember.
- **Cons:** Guessing, on a record the player cannot un-split. A corpse run, a bank trip
  and a port to the next camp are indistinguishable from "the grind ended" in the log,
  and this codebase's rule is that the number it cannot honestly compute is the number it
  does not print. The player knows; ask them.

## Chosen Approach

**Approach 1.** It is the shape every other gesture in this app already has, it keeps the
two resets honestly separate, and the hard part — closing a session correctly, writing it,
moving the floor so nothing double-counts — is already built and unit-tested.

Three decisions inside it:

- **Wording is "Start new session", not "Reset session".** "Reset" is what the encounter
  row above it does, and that one discards. This one saves. The tray item carries a
  tooltip that says so outright: *Saves the night so far and starts counting again.*
- **The tray item appears only while session tracking is on**, following the precedent of
  the `Session…` item directly below it — a menu row that can only ever do nothing is a
  promise the app cannot keep. The *hotkey* stays bound regardless and toasts honestly
  ("Session tracking is off"), because a global shortcut that silently does nothing is
  worse than one that explains itself.
- **The toast states which of three things happened**: tracking off, nothing in flight to
  close, or saved-and-restarted. The player may have the meter line switched off and the
  session window closed, in which case the toast is the *only* confirmation the press did
  anything.

## Tasks

- [x] `src/main/config.js`: add `newSession: 'Control+Shift+N'` to `DEFAULTS.hotkeys`.
      No migration needed — `load()` merges `DEFAULTS` one level deep into the stored
      object, so existing configs gain the binding on next launch.
- [x] `src/main/main.js`: add `startNewSession()` immediately after `resetEncounter()`,
      with a comment covering why it writes rather than discards and why it is NOT part of
      the encounter reset. Behaviour: if `!sessionEnabled(config.all)` or `!session` →
      toast "Session tracking is off"; else `const record = session.close('manual')`;
      clear the checkpoint for `sessionKey(parser?.selfName, parser?.server)`
      unconditionally (see Notes — a discarded zero-event session must not be left
      recoverable); toast "No session in progress" when `record` is null, otherwise
      "Session saved — starting a new one".
- [x] `src/main/main.js` `registerHotkeys()`: `bind(keys.newSession, startNewSession, 'new session')`.
- [x] `src/main/main.js` `refreshTrayMenu()`: add a row directly under "Reset encounter",
      spread in only when `sessionEnabled(config.all)`, with `accelerator: keys.newSession`
      and the tooltip above.
- [x] `src/renderer/setup/index.html`: new hotkey row `hk-session` labelled
      "Start new session", after the "Reset encounter" row.
- [x] `src/renderer/setup/setup.js`: read it in the form fill (~line 127, alongside
      `hk-reset`) and write it in the save patch (~line 418), using the same
      `?? ''` / `.trim()` handling as `hk-alerts`.
- [x] `tests/config.test.js`: pin that `DEFAULTS.hotkeys.newSession` exists and that a
      config stored without it gains it through `load()`.
- [x] `tests/session.test.js`: a test that feeds events, calls `close('manual')`, then
      feeds a *later* event and asserts a second session opens with the earlier events not
      re-counted (the `minTs` floor), plus that an immediate second `close('manual')`
      returns null rather than writing an empty record.
- [x] `tests/session-store.test.js`: pin that a checkpoint cleared for a key stops
      `recover()` resurrecting that session.
- [x] Verified headlessly against the live log, composing `SessionTracker` + `SessionStore`
      exactly as `startNewSession` does: mid-log the manual close wrote a 183-kill session
      with `closeReason: 'manual'`, the checkpoint went from present to gone, the next line
      opened a fresh session starting after the closed one's end, and `recover()` found
      nothing to resurrect. The in-game keypress and its toast are James's to confirm on
      the relaunched build — a global hotkey over a fullscreen game is not something WSL
      can press.
- [x] `docs/changelog/2026-08-08-new-session-hotkey.md`.
- [x] `npm test` (638 pass), then `taskkill.exe /IM "EQL DPS Overlay.exe" /F` and
      `scripts/dev.sh dist`; win-unpacked relaunched.

## Notes

- **No new IPC channel.** Hotkey and tray both live in main; nothing in a renderer needs
  to ask for this. If the Session window later grows its own button (see below), that is
  when a channel earns its place.
- **The checkpoint hole this closes.** `persistSession` clears the checkpoint file only
  when a record is actually handed to it. `close()` returns null — and never calls
  `onSessionEnd` — for a session whose `events` count is 0, which a zone-only session
  genuinely is. Today that is nearly unreachable; a manual close makes it reachable, and
  the consequence would be `recover()` writing, at next launch, a session the player had
  explicitly ended (recovery `append`s directly and does not re-check `events`). Clearing
  the checkpoint unconditionally in `startNewSession()` costs one line and shuts it.
- **Why `Control+Shift+N`.** Free alongside L/H/R/M/A, mnemonic for "new", and not
  something EverQuest binds. Editable in settings like every other binding.
- **Deferred, deliberately:** a "Start new session" button in the Session window header
  and an equivalent on the unlocked overlay's button row. Both are reasonable; neither is
  what was asked for, and each would need its own IPC channel. The hotkey and the tray
  cover the moment this is actually wanted.
- **Landed as planned, with one refinement.** The "nothing happened" toast is two branches
  rather than one: `!sessionEnabled(config.all)` → "Session tracking is off", and a
  tracker that does not exist yet (tracking on, no log being followed) → "No session in
  progress". Collapsing them would have told a player with no log configured that a switch
  they had turned on was off.
- **Open question for review:** the label. "Start new session" over "Reset session"
  because this one *saves*. If you would rather the two rows read as a matched pair
  ("Reset encounter" / "Reset session"), say so and the tooltip carries the honesty
  instead.
- Version stays at 0.8.0 — no bump unless you ask for one.
