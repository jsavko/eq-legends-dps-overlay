# Editing a timer that is running reaches the row on screen

**Date:** 2026-08-22

Rename a timer while its countdown is up and nothing happened. The document changed, the
Timers window showed the new name, and the bar on screen went on saying the old one until
it expired — which reads exactly like a save that did not stick.

## Why

A slot is a **snapshot taken when it armed**. `arm()` copies the timer's name, colour,
duration and box into the row, and `setModel()` recompiled the matchers and cleared the
strike counters but never touched rows that were already running. So every edit applied to
the *next* time the timer fired and to nothing currently on screen — the same for a
recolour, a duration correction and a move to another box.

## What it does now

`TimersRuntime.setModel()` calls a new `syncSlots()`, which walks the live rows and brings
them into line with the document:

- **Name and colour follow the edit**, written into the existing slot. The Map keeps its
  insertion order and `since` is untouched, so a rename cannot re-sort the panel — the row
  changes what it says without moving a pixel, which is the whole contract of that window.
- **A changed duration rebases from when the row armed**, rather than only applying next
  time. Somebody who corrects "146 seconds" to "180" while the buff is up has just told you
  what the remaining time is; a row that ignored them would be wrong for the rest of its
  life. Cutting the duration below what has already elapsed simply lands the row in
  `spent`, a state it renders honestly.
- **Deleting a timer, or switching it off, takes its row down.** That is not the panel
  re-sorting itself — it is the player's own act, and a countdown for something that no
  longer exists is the "nothing on screen you can explain" failure this project keeps
  running into.
- **Previews follow a rename and a recolour** — a box preview mocks the player's real
  timers, and what somebody looking at one is judging is exactly those two things. It keeps
  its staggered timing fiction, which is not a claim about anything.

The stand-in rows that mock *no* timer — the editor's draft row, the two samples the boss
box gets — must not be swept up as orphans by an unrelated edit, so a preview slot now
carries the id of the timer it stands in for, or null when there is none. Picking that out
of the slot's own id with a string split would have worked until somebody hand-edited a
category id with a colon in it.

## Verified in the running app

The packed build on `--remote-debugging-port=9223`, with a box's real timers on screen:
renaming the first of three to `RENAMED WHILE UP` with a new colour changed that row's text
and its `--accent` immediately, left the other two alone, and did not move it out of first
place. Renaming it back restored it. 935 tests pass, including the armed path (which a live
check cannot reach without writing to the player's own game log).

## Files

| File | Change |
|---|---|
| `src/timers/runtime.js` | `syncSlots()`, called from `setModel`; armed and preview slots both carry `timerId` |
| `src/main/main.js` | box previews name the timer they mock; the boss box's two samples pass null |
| `tests/timers.test.js` | a running row is renamed, recoloured and rebased in place without moving; delete and switch-off take it down; previews follow while the stand-ins are left alone |
