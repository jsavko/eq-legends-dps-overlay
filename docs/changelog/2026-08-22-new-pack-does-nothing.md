# "+ New pack" did nothing, and then it did nothing again

**Date:** 2026-08-22

Pressing **+ New pack** in the Triggers window produced no dialog, no pack, no error —
nothing at all. The whole chain behind it was already built and correct: the button, its
click listener, the `createPack` bridge, the `TRIGGERS_CREATE_PACK` channel, and a main
handler that creates the pack through `triggerStore.add()`. Every link worked. The break
was the first line of the listener.

## What was wrong

```js
const name = window.prompt('Name the pack. …', 'My boss timers');
if (name === null || !name.trim()) return;
```

**Electron does not implement `window.prompt`.** Its `JavaScriptDialogManager` handles
`alert` and `confirm` natively and short-circuits `prompt` — the call returns without ever
drawing anything, so `name` is `null` and the guard on the next line returns before the
IPC is reached. That is why this one control was dead while `window.confirm` on **Remove**
and `window.alert` on **Export**, in the same file, were always fine: those are the two
Electron supports.

The failure has no symptom. Nothing throws, nothing logs, nothing reaches main. A button
that does nothing is indistinguishable from a button nobody wired.

`window.prompt` appeared exactly once in the codebase.

## What it was replaced with

A dialog of the window's own, on the `.dialog-form` / `.dialog-head` / `.dialog-body` /
`.dialog-foot` skeleton the Triggers window already has four of. Kicker, `Name the pack`,
the sentence the old prompt carried about what a pack *is*, one field, Create and Cancel.
Narrower than the shared 760px, which is a form's width and not a name's.

The flow after it is unchanged and was always right: `createPack` → select the new
`packId` → `refresh()` → `newTrigger()`, so the player lands on a blank trigger rather
than on an empty list.

## The second bug, which only the running app could show

The first version of the fix returned a promise settled by the dialog's own `close` event:

```js
const settled = new Promise((resolve) => {
  dlg.addEventListener('close', () => resolve(dlg.returnValue.trim() || null), { once: true });
});
```

Every static test passed. Driven over CDP against the packed build, **`+ New pack` still
did nothing.**

Measured on Electron 33 (Chromium 130), against this very window: when it is occluded —
`document.visibilityState === 'hidden'` — `dialog.close(value)` closes the dialog and sets
`returnValue`, and **the `close` event is never dispatched at all**. A hidden window
produces no rendering updates; `requestAnimationFrame` does not fire there either. The
dialog vanished from the screen, the name was sitting in `returnValue`, and the promise
stayed pending forever with the click handler awaiting it. The same silent no-op, one
layer down, in a new costume.

So the answer is delivered by the **buttons**, not by an event:

- `settlePackName(name)` is called *before* `$('newpack').close()` — whether this runtime
  dispatches `close` synchronously, asynchronously or not at all, the answer is already
  out by the time it decides.
- `cancel` and `close` still settle it, because Escape closes a `<dialog>` natively and
  reaches no button. They are the backup path, never the mechanism. If they never arrive
  the cost is one dangling promise that the next `askPackName` clears, not a dead button.
- Settling twice is a no-op, which is what lets three paths point at one resolver.

## Verified in the running app

Not by replay. The packed build was relaunched on `--remote-debugging-port=9223` and the
Triggers window driven over CDP — reached by chaining the overlay's `openSettings()` into
the settings window's `openTriggers()`, since this window opens from the tray and has no
hotkey.

| step | result |
|---|---|
| `+ New pack` clicked | dialog open, 440 × 294, focus in the name field, field empty |
| Create with nothing typed | stays open, hint reads *"A pack needs a name — it is what the file is called."*, focus returned to the field |
| Cancel | closes, creates nothing, handler settles |
| name typed, **Enter** | pack created and selected, rail shows it, editor open on a blank trigger with focus in NAME |

Then the same create path again with the window **minimized** (`visibilityState: hidden`),
the exact state that killed the first fix: pack created, selected, editor open.

Both test packs were removed afterwards; the triggers directory holds only
`eql-boss-timers.json`, as it did before.

937 tests pass.

## Why the suite missed the original

`tests/triggers-window.test.js` already guards this failure class and it does assert
`New pack is not wired to the channel` — but it asserts by reading the source for
`window.api.createPack`. The string was there the whole time the button was dead. What no
test said was that the code path could ever *reach* it.

## Files

| File | Change |
|---|---|
| `src/renderer/triggers/index.html` | `<dialog id="newpack" class="narrow">` — kicker, heading, the prose the prompt carried, one field, a hint line, Create/Cancel |
| `src/renderer/triggers/triggers.css` | `dialog.narrow` — 440px, because 760 is a form's width and not a name's |
| `src/renderer/triggers/triggers.js` | `askPackName()`, `settlePackName()`, `resolvePackName`; the dialog's wiring; `window.prompt` gone from the `new-pack` listener |
| `tests/triggers-window.test.js` | the script's code (comments stripped) contains no `window.prompt`; the dialog's ids exist; Create settles the ask itself rather than leaving it to the close event; Escape still settles |
| `tests/renderer-modules.test.js` | repo-wide: no file under `src/renderer/` calls `prompt()` |

## Left alone, deliberately

- **`alert` and `confirm` elsewhere in this file stay.** Electron implements both, and
  they work. Only `prompt` is the gap.
- **Renaming a pack is still missing.** A pack's name is set once, at creation; there is
  no `TRIGGERS_RENAME` channel. It is worth building and it is not this bug.
- **The dialog asks for a name and not a description.** `main.js` hard-codes
  `comments: 'Triggers written here.'` for every authored pack, so they all print the same
  sentence under their name in the detail pane. A second field is cheap — it just widens
  a fix that was about a button that did nothing.
