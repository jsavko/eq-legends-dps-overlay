# System tray

**Date:** 2026-07-31

There was no discoverable way to reach settings or quit. The overlay is frameless, sets
`skipTaskbar: true`, and hides its own buttons while locked — so unless you already knew
the hotkeys, the app had no exit.

## Added

A tray icon whose right-click menu carries the whole control surface:

- which character is being followed (a disabled header, so the menu doubles as status)
- show / hide and lock / unlock as checkboxes reflecting current state
- switch between damage and healing
- reset the current encounter
- **Settings…**
- **Quit**

Each item shows its hotkey, so the menu teaches the shortcuts rather than replacing them.
The menu is rebuilt whenever the state it displays changes, so the checkmarks and the
damage/healing label never go stale.

`window-all-closed` no longer quits the app: with a tray, closing the settings window
while the overlay is hidden should leave it running and reachable. First-run setup closed
without choosing a log still quits, since there would be nothing to run.

## Discoverability

Windows 11 files new tray icons into the hidden overflow, so a tray icon alone does not
solve "I can't tell how to quit" — you have to know to look behind the chevron. On first
run only, the overlay shows a longer-lived toast reading **"Settings and Quit are in the
tray icon"**, tracked by a `seenTrayHint` config flag. The README explains how to pin the
icon out of the overflow.

## Icons

`scripts/make-icons.js` generates the artwork rather than committing opaque binaries: PNGs
at 16/32/256 plus a multi-size `.ico` for the packaged executable, written with a small
hand-rolled PNG and ICO encoder so there is no image dependency. The glyph is three
descending bars in the overlay's own ember and gold — its "the row is the bar" identity,
and legible at 16px, which is the only size a tray really has.

The packaged exe now carries that icon instead of the default Electron one.

## Verified

Driven against the running app: the icon appears in the notification area, the menu opens
with correct labels, checkmarks and accelerators, and the first-run hint renders. Repeated
against the packaged portable binary, confirming the icon resolves from inside the asar.
