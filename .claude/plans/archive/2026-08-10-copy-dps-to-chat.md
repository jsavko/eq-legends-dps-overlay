---
status: completed
---
# Copy the meter to the clipboard, pasteable into EQ chat

**Date:** 2026-08-10

---

## Goal

Put a **COPY** button in the overlay's unlocked controls row (beside METRIC / RESET /
SETTINGS / LOCK / QUIT) that writes the current fight's numbers to the Windows clipboard
as **one line**, shaped so it can be pasted straight into an EverQuest chat window and
read by people who are not running the overlay.

Decided with the user up front:

- **Format** — ranked, rate + share, with the fight and its duration as a header and the
  group rate as a tail:

  ```
  Vessel of Terror 2:14 — 1) Rhale 1234 (35%) 2) Emalina 980 (28%) 3) Khanvikt 870 (24%) 4) Aanya 510 (14%) | group 3594 dps
  ```

- **Metric** — whatever is on screen. The button copies what the player is looking at, so
  the healing view copies `hps` and the taken view copies `dtps`. One button, and its
  meaning is always the meter above it.
- **Overflow** — EQ's chat input caps around 255 characters. When the group does not fit,
  the line **shrinks rather than truncates**: percentages go first, then the group tail,
  then numbers abbreviate (`1234` → `1.2k`), then the header. Every member's name survives
  every stage. Dropping members is a last resort that a full raid roster can still reach,
  and when it happens the line says `+N more` and the toast says so out loud.

The button is only reachable while unlocked, which is what the user asked for and also
what is physically possible: the locked overlay is click-through and the game keeps every
click. The workflow is Ctrl+Shift+L → COPY → Ctrl+Shift+L → paste.

Copying works between pulls as well as during one: `snapshot()` returns
`this.current ?? this.last`, so after a fight closes the meter — and therefore the copy —
still describes the fight that just ended.

## Approaches Considered

### 1. Renderer builds the line from a shared pure module; main writes the clipboard
- **Description:** A new pure `src/renderer/overlay/report.js` (sibling of `breakdown.js`)
  owns two things: `rowsForMetric(snap, metric)` — the filter-and-sort that `render()`
  already does inline — and `chatReport(snap, metric)` → `{ text, dropped }`. `render()`
  is refactored to call `rowsForMetric` too, so the copied order is *by construction* the
  order on screen. The finished string goes to main over one channel, which calls
  Electron's `clipboard.writeText`.
- **Pros:** The one guarantee that matters — copy says exactly what the meter says —
  is structural, not a second implementation that has to be kept in step. Pure module, so
  it unit-tests in WSL like `breakdown.js` and `organize.js`. Removes an existing
  duplication (the metric filter currently lives only inside `render()`).
- **Cons:** Touches `render()`, the hottest path in the renderer. Introduces a channel
  that carries an arbitrary string to the clipboard.

### 2. Main builds the line from `parser.snapshot()` and `config.metric`
- **Description:** The renderer sends a bare "copy" intent; main owns the whole report,
  in a pure `src/main/report.js` beside `layout.js`.
- **Pros:** Narrowest possible door — the renderer names an intent, not a payload, which
  is the pattern `TRIGGERS_SET_BUILTIN` was given for exactly this reason. Nothing in the
  render path changes.
- **Cons:** Main would have to re-derive the on-screen row set: healing shows only rows
  with `heals > 0`, taken keeps rows at zero damage if someone died, and each re-sorts.
  That logic would then exist twice, and the failure mode is silent — the copied line
  disagrees with the meter and nobody finds out until it is pasted into guild chat.

### 3. `navigator.clipboard.writeText` in the renderer, no IPC at all
- **Description:** Skip main entirely.
- **Pros:** Smallest diff; no channel, no preload change, no test to update.
- **Cons:** The Async Clipboard API needs a focused document and a user-gesture context,
  and this is a transparent, always-on-top, `setIgnoreMouseEvents` window that spends its
  life unfocused — the case where it fails is the case we ship. Failures are also silent
  (a rejected promise), so the button would look like it worked. Electron's main-process
  `clipboard` has none of those conditions.

### 4. Copy the whole breakdown as a multi-line report
- **Description:** Every member with every ability, the way the hover panel shows it.
- **Pros:** Loses nothing; matches the project's no-truncation instinct.
- **Cons:** Not what was asked for and not pasteable — EQ takes one line of chat, so a
  30-line report arrives as one line or as nothing. This is a *chat* feature; the
  constraint is the chat box, and a format that ignores it is a format nobody can use.

## Chosen Approach

**Approach 1.** The feature's whole claim is "this is what my meter says", and only a
shared row-selection makes that true by construction rather than by vigilance. The pure
module keeps the interesting half — ranking, formatting, and the shrink ladder — testable
in WSL with no Electron, which is the same bargain `breakdown.js`, `layout.js` and
`organize.js` already make.

The clipboard channel is `invoke`, not fire-and-forget, so the renderer can toast
*after* the write actually happened rather than announcing an outcome it did not observe.
When there is nothing to copy the clipboard is left untouched — wiping whatever the player
had copied, to replace it with an empty meter, would be the worst possible outcome of
pressing a button labelled COPY.

## Tasks

- [x] Add `src/renderer/overlay/report.js` (pure, no DOM, no Electron) exporting
      `rowsForMetric(snap, metric)` — the filter + sort currently inline in `render()` —
      and `chatReport(snap, metric, { limit = 255 })` → `{ text, total, shown, stage }`.
- [x] Implement the shrink ladder in `chatReport`, each stage applied only if the previous
      one still overruns `limit`: (0) full line; (1) drop per-member shares; (2) drop the
      `| group N dps` tail; (3) ~~abbreviate rates via the existing `formatNumber` rule~~
      **drop the `1) ` rank prefixes** (see Notes — the abbreviation shrinks nothing);
      (4) drop the `<label> <m:ss> —` header; (5) last resort, drop trailing members and
      append `+N more`. Names never degrade before stage 5.
- [x] Metric-aware wording in `chatReport`: unit `dps` / `hps` / `dtps`, value from
      `dps|hps|dtps`, share from `share|healShare|takenShare`, group rate from
      `groupDps|groupHps|groupDtps` — reusing the `METRICS` field map rather than a second
      copy of it (move `METRICS`/`METRIC_CYCLE` into `report.js` and import them back into
      `overlay.js`).
- [x] *(One addition beyond the approved format, easy to drop in review)* In the **taken**
      metric only, append `| deaths: A, B` when anyone died, at the same stage the group
      tail lives on — a death is the fact that view exists to report, and a taken-damage
      line that omits it is the misleading half of the story.
- [x] Refactor `render()` in `overlay.js` to get its rows from `rowsForMetric`, deleting
      the inline `metric === 'healing'` / `'taken'` branches so there is one row-selection
      in the codebase.
- [x] Add `tests/report.test.js`: row selection matches per metric (healing keeps a
      zero-healing healer with casts, taken keeps a member who only died); ranking order;
      share and duration formatting; each shrink stage triggers in order on a widening
      roster; a 24-name roster still names everyone or says `+N more`; an empty/idle
      snapshot returns no text.
- [x] Add `CLIPBOARD_COPY: 'clipboard:copy'` to `CHANNELS` in `src/main/ipc.js`, with the
      usual comment on why the renderer sends the finished text rather than an intent.
- [x] Expose `copyText: (text) => ipcRenderer.invoke('clipboard:copy', text)` in
      `src/renderer/overlay/preload.cjs` (channel name repeated by hand, per that file's
      constraint — `tests/preload-channels.test.js` guards the typo).
- [x] Handle it in `main.js` beside the other `ipcMain.handle` registrations: import
      `clipboard` from `electron`, refuse a non-string or empty payload, `writeText`,
      return `{ ok }`.
- [x] Add `<button id="btn-copy" title="Copy the group's numbers for chat">copy</button>`
      to `src/renderer/overlay/index.html`, first in `#controls` so it is not adjacent to
      RESET.
- [x] Wire it in `wireControls()`: build the report, and if there are no rows toast
      "Nothing to copy yet" without touching the clipboard; otherwise `await copyText`,
      then toast — "Copied — 4 in group", or "Copied — shortened to fit chat" when the
      ladder ran, or "Copied — 18 of 24 fit" when stage 5 dropped anyone.
- [x] Add `flex-wrap: wrap` to `#controls` in `overlay.css`: a sixth button can overrun a
      narrow overlay, and this window may never clip. The header's `offsetHeight` is
      already what `measureContentHeight()` reads, so a wrapped row is measured and the
      auto-fit grows for it with no geometry change.
- [x] `npm test` — full suite green (688 tests, including 15 new ones).
- [x] Verify the string against a real fight: replay the live log with
      `node scripts/replay.js <log> --print`, feed a real snapshot to `chatReport` in a
      scratch script, and check a genuine group line against the 255-character cap.
- [x] `docs/changelog/2026-08-10-copy-dps-to-chat.md`.
- [x] Kill the running overlay, `scripts/dev.sh pack`, **relaunch** `win-unpacked`.

## Notes

- **Stage 3 as planned was inert, and was replaced.** "Abbreviate rates via the existing
  `formatNumber` rule" costs exactly as many characters as it saves at every magnitude:
  `1234` → `1.2k` is 4 characters either way, `12345` → `12.3k` is 5, `123456` → `123.5k`
  is 6. A rung built on it would have shrunk nothing and handed the overrun straight to
  the rung that drops people. The rung now drops the `1) ` rank prefixes instead — three
  characters per member, and the left-to-right order already says what they said.
  Abbreviation survives only above ten thousand, where dropping the decimal (`12k`) does
  shorten and the rounding is a 3% claim rather than the 20% one `1k` for 1,234 would be.
  Four-figure rates stay exact at every rung. See `formatRate` in `report.js`.
- **Measured against the live log**: 1,652 encounters, 4,413 generated lines across the
  three metrics. **None exceeded 255 characters and none dropped a member** — only two
  lines needed even the first rung. The widest real case is a 13-member spite golem raid
  at 215 characters (stage 1, shares given up). The taken view's deaths tail earns its
  place there: `| deaths: Sparked, Rhale, Taneldar, Rhain`.
- **The em dash is the only non-ASCII character** in any line generated from the live log
  (U+2014, confirmed by scanning the worst case). It is the one thing to eyeball on the
  first real paste; `DASH` in `report.js` is the single edit that swaps it for `-`.
- **The 255-character cap is an assumption**, not something the log or the client tells
  us. It is classic EverQuest's chat input limit and the reason the ladder exists. It
  lives as one named constant in `report.js` so a measured value replaces it in one edit —
  and worth measuring in-game once, since a too-low guess costs percentages nobody needed
  to lose.
- **Em dash and `|` in the copied text.** EQ's chat is latin1 and prints `|` fine; an em
  dash is safe in the same range, but if the pasted line ever shows a mangled character
  the separator is the first thing to swap for a plain `-`. Worth eyeballing on the first
  real paste.
- **Not in scope:** a copy hotkey. Ctrl+Shift+C while locked would skip the two unlock
  presses entirely and is the obvious follow-up, but the user asked for a button on the
  unlocked screen and hotkeys are a config surface of their own. Same for a copy button in
  the History and Session windows, where the same `report.js` would drop straight in.
- **Why not a chat-line-per-member format:** EQ takes one line per paste and there is no
  keystroke automation here (nor should there be — sending keys into the game client is a
  different kind of program than this one).
