---
status: completed
---
# "+ New pack" in the Triggers window does nothing

**Date:** 2026-08-22

---

## Goal

Pressing **+ New pack** in the Triggers window's rail footer produces no dialog, no pack,
no error — nothing. Make it do what its own comment says it does: name a pack, create it,
select it, and open the editor on a blank trigger.

The whole chain behind the button is already built and correct:

- `src/renderer/triggers/index.html:52` — the button exists and is never disabled
- `src/renderer/triggers/triggers.js:904` — a click listener is attached
- `src/renderer/triggers/preload.cjs:43` — `createPack` bridges to `TRIGGERS_CREATE_PACK`
- `src/main/ipc.js:167` — the channel is registered
- `src/main/main.js:2634` — the handler creates the pack through `triggerStore.add()`

The break is the very first line of the listener:

```js
const name = window.prompt('Name the pack. …', 'My boss timers');
if (name === null || !name.trim()) return;
```

**Electron does not implement `window.prompt`.** Its `JavaScriptDialogManager` handles
`alert` and `confirm` natively and short-circuits `prompt` — it returns without ever
showing anything, so `name` is `null` and the guard on the next line returns before the
IPC call is ever made. (Confirmed against the installed runtime: Electron 33's dist
carries Chromium's own `Ignored call to 'prompt()'` strings and no prompt dialog
implementation.) That is why `window.confirm` on **Remove** and `window.alert` on
**Export** both work while this one control is dead: they are the two Electron supports.

`window.prompt` appears exactly once in the whole codebase, so this is a single-site bug
with a single-site fix — plus a test so a platform gap that turns a control into a no-op
cannot reach the window again.

## Why the test suite missed it

`tests/triggers-window.test.js` already guards this exact failure class ("an id that
exists in one file and not the other … the only symptom is a control that does nothing")
and it does assert `New pack is not wired to the channel` — but it asserts by reading the
source for `window.api.createPack`. The string is there. What no test says is that the
code path can ever *reach* it.

## Approaches Considered

### 1. Replace the prompt with an in-window `<dialog>`
- **Description:** A small modal in the window's own markup — kicker, title, one text
  field, Create/Cancel — opened with `showModal()`, resolving a Promise with the name.
  This window already has four dialogs (`editor`, `info`, `durations`, `report`) built on
  a shared `.dialog-form` / `.dialog-head` / `.dialog-body` / `.dialog-foot` skeleton with
  input styling already in `triggers.css`, so it is markup and wiring, not new design.
- **Pros:** Uses what the window already has, in the palette it already wears; explains
  what a pack *is* in more than a prompt's one line of plain text; Enter-to-create and
  focus handling are ours; no new IPC, no new main-process code, no dependency; testable
  by the same static id-crosscheck the file's other dialogs get.
- **Cons:** ~30 lines of markup + ~25 of wiring for what one browser call used to do.

### 2. Create the pack immediately, rename it afterwards
- **Description:** Skip naming. `+ New pack` creates "New pack" at once and the name
  becomes editable in the detail pane's header.
- **Pros:** Fewest clicks; fixes a real adjacent gap — a pack's name is fixed at creation
  today and there is no way to change it.
- **Cons:** Needs a `TRIGGERS_RENAME` channel, a main handler, and a decision about
  whether the pack's *file* is renamed with it (`triggerStore.add` derives the filename
  from the name via `freeId`/`safeId`). That is a larger change than the bug warrants, and
  it leaves a junk "New pack" on disk the moment somebody clicks and wanders off.

### 3. Fold pack creation into the trigger editor's pack picker
- **Description:** Mirror the editor's existing `＋ New group…` pattern: a pack `<select>`
  with a `＋ New pack…` option that reveals a name field, exactly as `NEW_GROUP` does.
- **Pros:** One idiom, already built and understood in this file; a pack would never exist
  without a trigger in it.
- **Cons:** Changes what the rail-footer button means, and the button's own comment argues
  it belongs where it is ("it is the one control in this window that works before you own
  anything at all"). Also solves the problem only for people who reach the editor.

### 4. Ask in the main process
- **Description:** Do the naming with Electron's `dialog` module.
- **Pros:** No renderer markup.
- **Cons:** Electron has no native text-input dialog — `showMessageBox` takes buttons, not
  a field. Getting one means opening a `BrowserWindow`, which is approach 1 with a window
  manager bolted on and the parchment palette to re-establish. Dead end.

## Chosen Approach

**Approach 1** — an in-window naming dialog. It fixes the actual break, costs no new IPC
surface, and reuses a dialog skeleton this window has four of already. Approach 2's rename
channel is a genuinely good idea and is noted below as separate work; it is not this bug.

The flow after the dialog resolves is unchanged and already correct: `createPack` →
select the returned `packId` → `refresh()` → `newTrigger()`, so the player lands on a
blank trigger rather than an empty list.

## Tasks

- [x] Add `<dialog id="newpack">` to `src/renderer/triggers/index.html`, after the
      `durations` dialog, on the `.dialog-form` / `.dialog-head` / `.dialog-body` /
      `.dialog-foot` skeleton the other dialogs use: kicker + `<h3>Name the pack</h3>`,
      the "a set of triggers you can switch, export and hand to somebody else in one go —
      a boss, a zone, a night" prose the old prompt carried, a `.field` with
      `<input id="np-name" type="text">` (placeholder `My boss timers`), a hint line
      `id="np-hint"` for the "a name is required" case, and a footer with
      `<button id="np-create" class="primary">Create</button>` and
      `<button id="np-cancel" class="secondary">Cancel</button>`.
- [x] Add a narrow-dialog modifier to `src/renderer/triggers/triggers.css` — the base
      `dialog` rule is `width: min(760px, 92vw)`, which is a form's width, not a name's.
      `dialog.narrow { width: min(440px, 92vw); }` next to it, with a comment saying why.
- [x] Replace the `window.prompt` call in `triggers.js:904` with an `askPackName()` helper
      that returns `Promise<string|null>`: `showModal()`, resolve on Create with the
      trimmed value, resolve `null` on Cancel and on the dialog's `close` event (Escape
      closes a `<dialog>` natively — the promise must settle or the click handler hangs
      forever, which is the same silent no-op in a new costume).
- [x] Wire the dialog: focus `np-name` on open, clear it and `np-hint` between opens,
      Enter in the field submits (keydown, not a `<form>` — the other dialogs here are not
      forms), and Create with an empty field shows the hint rather than closing.
- [x] Leave the rest of the listener as it is — `createPack`, `state.selectedPack`,
      `refresh()`, `newTrigger()` — and keep the existing `window.alert` on a failed
      create (alert *is* supported; only prompt is not).
- [x] Add to `tests/triggers-window.test.js`: assert `triggers.js` contains no
      `window.prompt` and that the dialog's ids (`newpack`, `np-name`, `np-create`,
      `np-cancel`, `np-hint`) are in the markup. The existing "every id the script reaches
      for exists in the markup" test covers the second half automatically once the code
      uses `$('np-…')`, so the explicit assertion is about the *first* half: the button
      reaching the channel through a path that runs.
- [x] Add to `tests/renderer-modules.test.js` a repo-wide check that no file under
      `src/renderer/` calls `window.prompt` — same register as that file's existing
      module-grammar check (a platform gap that leaves a control silently doing nothing),
      and it catches the next renderer that reaches for it.
- [x] `npm test`, then `scripts/dev.sh pack`, kill the running overlay first, and relaunch
      it with `powershell.exe Start-Process` so the window is actually back up.
- [x] `docs/changelog/2026-08-22-new-pack-does-nothing.md` — what the break was (Electron
      has no `prompt`), why it looked like nothing at all rather than an error, and why
      alert/confirm elsewhere in the same file are fine to leave alone.

## Notes

- **The first fix was the same bug in a different costume, and only the running app said
  so.** Task 3 as written settled the promise on the dialog's `close` event and nothing
  else. Every static test passed. Driven over CDP against the packed build, `+ New pack`
  still did nothing: measured on Electron 33, a `<dialog>` in an occluded window
  (`document.visibilityState === 'hidden'`) closes on `close()` — `open` clears,
  `returnValue` is set — and **the `close` event is never dispatched**. A hidden window
  produces no rendering updates, and `requestAnimationFrame` never fires there either.
  The promise stayed pending and the click handler awaited forever. Rewritten so the
  BUTTONS settle it (`settlePackName`, called before `close()`), with `cancel`/`close`
  demoted to the backup path that catches Escape. Verified in both states: visible, and
  minimized with `visibilityState: hidden`.
- **Verifying in the real runtime needed a chain, because the Triggers window has no
  hotkey.** It opens from the tray only. Over CDP: the overlay's `openSettings()`, then
  the settings window's `openTriggers()`. Worth knowing next time — `docs/changelog/`
  entries describe driving the packed build on `--remote-debugging-port=9223`, but not
  how to get this particular window open in the first place.
- **`Page.captureScreenshot` hangs on an occluded Electron window.** Same root cause as
  the `close` event — no frames. Measurements over `Runtime.evaluate` work fine.

- **Empty packs are already handled.** If the player cancels the trigger editor right
  after creating a pack, the pack sits there with zero triggers — `renderPackRows` has a
  proper `hint-block` empty state for exactly that ("Nothing here yet. Press '+ New
  trigger'…"), so nothing needs adding for the cancel path.
- **Duplicate names are safe.** `main.js`'s handler routes the name through
  `triggerStore.add()` for `freeId`/`safeId`, so a second "My boss timers" gets its own id
  rather than replacing the first, and `../../config` lands inside the triggers directory.
  The dialog does not need a uniqueness check.
- **Renaming a pack is missing and is separate work.** Today a pack's name is set once, at
  creation, and there is no `TRIGGERS_RENAME` channel. Worth doing; it is approach 2 above,
  and it should not ride along with a bug fix.
- **Text size.** `triggers.css` inputs are 13px and hints 12px. That is below the ≥15px
  body rule, but it is the scale every other dialog in this window already uses — the new
  one should match its neighbours, and re-scaling the window's type is its own change.
- **Open question:** should the dialog also offer a one-line description for the pack?
  `main.js` hard-codes `comments: 'Triggers written here.'`, and `pack.comments` is what
  the detail pane prints under the pack name — so every authored pack currently says the
  same sentence. A second field is cheap while the dialog is being built; left out of the
  tasks above because it widens the fix.
