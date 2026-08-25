# Parked panels could not paint, and the bee pull said one thing four times

**Date:** 2026-08-25

Four defects reported against the build that shipped the engaged-drops popup. Three of
them turned out to be one bug wearing three faces, and it was not in any of the five
places the first day of looking went.

---

## The three that were one

Reported separately, over a morning:

- **The quest loot toast does nothing.** Not late, not garbled — absent.
- **The needed-drops popup arrives 15–20 seconds after the fight starts.**
- **Unlocking the HUD does not bring the alerts window or the drops popup up to be
  positioned.** James's own read: "might be part of the same bug." It was.

### Everything that was working

Ruled out by measurement before a line was changed, because the loot toast in particular
had a long list of plausible culprits and every one of them was innocent:

- **The quest ledger.** Replaying the last ~3 MB of `eqlog_Rhale_oggok.txt` through
  `QuestProgress#feedLine` → `lootChip`: 124 loot lines, 43 quest-counted, **25 of which
  produce a chip**. The 17 counted-but-silent ones are all fully-covered Wind Runes — the
  one documented deliberate silence.
- **The parser and the chat guard.** A real loot line through `LogParser#feed` and then
  `feedLine(line, event)` answers `kind: 'loot'` with a chip.
- **The store's timestamp floor.** `mine-drops.js --write` was the best suspect going in —
  a backfill that advanced `lastTs` past the live session would silence every later loot
  line. It does not: it mutates `state.drops` and nothing else.
- **The config.** `questLootAlerts: true`, `alertsMuted: false`, `questChipSec: 6`.
- **The renderer.** Driven headlessly with a stubbed `window.api`, a `category: 'quest'`
  warning renders as `Quest loot / Silken Wrap / 2 class tests want this` and reports
  `513×47`.
- **Main's cost per tick.** The popup's whole inversion is **0.54 ms** on the live 47 KB
  ledger (`quests.snapshot()` 0.45, `dropGroups` 0.12), so nothing was starved.

### What was actually wrong

Every panel that fits itself is **parked** off-screen at `-32000,-32000` while it has
nothing to draw — parked rather than hidden, because a hidden window's renderer stops
painting and could never ask to come back. Windows reaches the same conclusion by
itself. Measured side by side on the same packed build, on the parked alerts window:

| | default | `disable-features=CalculateNativeWinOcclusion` |
|---|---|---|
| `document.visibilityState` | **hidden** | visible |
| `requestAnimationFrame` fires | **no** | yes |
| `ResizeObserver` fires | **no** (not even on a real 10px → 200px change) | yes |
| `MutationObserver` fires | yes | yes |
| `setTimeout` fires | yes | yes |

Confirmed identically on the drops popup and on a timer box. **A parked panel keeps
running tasks and microtasks and stops running its rendering lifecycle.** It can still
think; it cannot paint, and it cannot notice a size change.

Which of the two a given path depends on is the whole of why one bug looked like three.

**The position half was never broken, and that is worth stating** because it is where a
day could have gone. With the drops window parked, a payload was forced in and the real
`reportFit` ran: main resized and moved the window to `x=1793 y=1283 401×86` — its exact
anchor — within 100 ms, read from Windows with `GetWindowRect` through `EnumWindows`
rather than from Electron's own view of itself. The popup was in the right place, at the
right size, not painting. The 15–20 seconds was never main being slow; it was the wait
for Chromium's occlusion tracker to notice the window had come back.

The renderer meanwhile still reported `window.screenX === -32000`, because that value is
refreshed by the rendering lifecycle too. Anything measured from inside a parked window
about where it is, is stale by construction.

**The loot toast, assembled.** The chip is drawn and its size reported within a
millisecond, main un-parks the alerts window immediately, the window then does not paint
for tens of seconds, and `questChipSec` is 6 — so `questWarnings` prunes the chip and
main parks the window again long before Windows lets it draw. Nothing is ever seen.

**The unlock is the one that failed outright rather than late**, and for a second reason
sitting on the same path. Both renderers watched:

```js
new MutationObserver(() => reportFit())
  .observe(document.body, { attributes: true, childList: true, subtree: true,
                            attributeFilter: ['hidden', 'class', 'style'] });
```

`data-locked` is not in that list, and unlocking reveals `#placeholder` through a CSS
selector alone — so it mutates no node and touches no watched attribute. The only
remaining route was the `ResizeObserver`, which is dead while parked. Measured with
`ResizeObserver` and `rAF` stubbed out to reproduce a parked window exactly:

| | before | after |
|---|---|---|
| unlock reports a fit | **no** — `#placeholder` computes to `display: block` and nothing is reported, ever | yes, `311×74` |
| a quest chip reports a fit | yes, `513×47` | yes, `513×47` |

That is the clean split between the two halves of the fix, and why both are needed. A
`childList` mutation is watched whatever the `attributeFilter` says, so **defect 1 was
never the filter — it was the paint**; the unlock reported nothing at all, so **defect 5
was never the paint — it was the filter**.

### The fix

- `app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')`.
  One line, and the only thing that can keep a parked panel painting — nothing on the
  renderer side can do it for itself.
- `backgroundThrottling: false` on the three click-through windows. Not the same
  question: the switch above is about being *outside* the desktop, this is about being
  *behind something on it* — a maximised game, another always-on-top window.
- **The `attributeFilter` is gone**, not extended. Adding `data-locked` to the list would
  fix today and leave the next state added to `body` to fall off it silently. The cost is
  a few extra `reportFit` calls, which the size-unchanged skip already absorbs.

The switch is deliberately not the whole fix. With the filter gone the unlock works
through the mutation route, so the gesture survives a future Chromium that ignores the
switch.

---

## The bee pull said one thing four times

Reported as "weird results on the 4 bees, repeating items needed for the same class each
time you engage the next bee, and the final bee has different items."

This one was predicted in writing when the mob grouping shipped, and left in:

> on a bee pull every engaged bee is its own group and every one of them owes the same
> earring […] If it reads as noise in play, the fix is to fold identical rows across
> groups in `dropsDisplay`.
> — `2026-08-24-drops-popup-silent-and-mob-led.md`

It reads as noise in play. So the mobs move into the **header**, where they say what the
pull is, and each item is listed once underneath. What folding loses — which of these
corpses actually has it — is exactly what the qualifier puts back, and only on the rows
where it differs from the header:

```
ISL 6  BZZAZZT · BAZZZAZZT +2                        engaged
  Bixie Essence          Bzzazzt +2          [Shaman]
  Adamantium Earring                         [Enchanter]      ← any of them
  Fine Wool Cloak        Bazzt Zzzt          [Rogue]          ← that one alone
```

A bare row means "any corpse in the header", which is the common case and now costs no
words. Approved 1:1 against the real CSS at `scale: 1.25` before any of it was written,
against two rejected alternatives (item-led with no header at all, and spelling every mob
name out).

**Grouped by island, not into one header for everything**, because the `ISL n` tag is a
claim: a pull that engaged two islands at once would otherwise have one of them labelled
with the other's number.

**Two spelled names in the header, one in a row**, and that asymmetry is measured rather
than taste. A row shares its line with the item name and the class flags, and the flags
may never be squeezed. At two names, `Pulsating Ruby` — owed to a Berserker and a
Necromancer, 176px of chips on a 400px panel — had **its own name ellipsised to make room
for the caption explaining it**. Caught by measuring every row of the real payload for
clipping, not by looking at the picture.

**The dataset's boss keeps the slot when nothing else claims it.** Engaging one bee alone
still reads `Adamantium Earring · Bazzt Zzzt`, which is the behaviour the family lists
shipped for; it is suppressed only when that boss is already standing in the header,
where it would repeat itself.

### The real pull, before and after

The island-6 pull of 06:48–07:00 this morning, fed line by line through `LogParser` and
main's exact tick sequence (`dropGroups` → `engagedNeeds` → `nextDropsState` →
`dropsDisplay`) against the live ledger, with the log's own clock driving the linger:

| moment | before | after |
|---|---|---|
| 06:50:33 first bee | 1 group / 2 rows | 1 group / 2 rows |
| 06:51:55 second bee | 2 groups / 4 rows | **1 group / 2 rows** |
| 06:53:05 third bee | 3 groups / 6 rows | **1 group / 2 rows** |
| 06:54:33 Bazzt Zzzt joins | 4 groups / **21 rows** | 1 group / **16 rows** |
| 06:56:42 linger | 4 groups / 21 rows | 1 group / 16 rows |
| 06:59:07 Sister of the Spire | 1 group / 16 rows | 1 group / 16 rows |

The last row is the one that matters as much as the rest: **the single-boss pull is
untouched.** One mob owes everything, no row is ever qualified, and the panel draws
exactly what it always drew.

---

## The timer boxes needed switching off and on

`src/main/main.js`, the push gate:

```js
if (timersRuntime && (timersRuntime.live || timersRuntime.revision !== lastTimersRevision)) {
```

`TimersRuntime#live` is `this.slots.size > 0` — the **player's own** countdowns and
nothing else. The boss rows are merged inside `pushTimerRows` from `triggers.timers(now)`,
and the trigger engine's own `live` and `revision` were not in the gate. So with no
personal timer armed, the push never happened and the boss box sat empty through a pull
that was firing countdowns the whole time.

Switching a box off and on called `syncTimerBoxes()`, which ends in a direct
`pushTimerRows()` — the only thing that did. It also explains why it seemed to fix itself
mid-session: the first Spirit of the Puma or Talisman of Alacrity to arm flips `live` and
the pushes resume. Introduced in `4e12a04`, the commit that folded the boss panel into
the boxes, so it has been true since the boxes shipped.

The gate is now `timerPushDecision` in `src/timers/model.js` — pure, asking both engines
the same two questions (is anything running, has anything changed) and answering with
both revisions so the caller can store them back. Main keeps `lastBossTimerRevision`
separate from `lastTriggerRevision`, which the snapshot push owns: sharing one would let
whichever pushed first mark the other's change as already sent.

---

## Changes

### Bug fixes
- **A parked click-through panel keeps painting.** `disable-features=
  CalculateNativeWinOcclusion`, plus `backgroundThrottling: false` on the alerts, drops
  and timer-box windows.
- **Unlocking brings the alerts window and the drops popup up to be positioned.** The
  `attributeFilter` that hid `data-locked` from the mutation observer is gone.
- **The quest loot toast draws again.** Same cause as the above; nothing in the chip
  path was ever wrong.
- **The drops popup names each item once.** `dropsDisplay` folds by island and by item.
- **The boss timer box gets its rows without being switched off and on.**

### Features
- **`timerPushDecision`** in `src/timers/model.js` — the push gate as a pure function,
  so the decision is unit-tested rather than the Electron loop around it.

### Refactoring
- `dropsDisplay` returns `{island, mobs, label, items[{name, rune, classes, from}]}`
  instead of the raw per-mob groups. `mobLabel(mobs, spelled)` owns the "first few
  spelled, the rest counted" wording so it is tested with the fold that produces it.

## Files modified

| File | What |
|---|---|
| `src/main/main.js` | the occlusion switch; `backgroundThrottling` on three windows; `lastBossTimerRevision` and the two-engine push gate |
| `src/timers/model.js` | `timerPushDecision` |
| `src/quests/needs.js` | `dropsDisplay` folds by island and item; `mobLabel` |
| `src/renderer/alerts/alerts.js` | the `attributeFilter` removed, with why |
| `src/renderer/drops/drops.js` | renders the folded shape |
| `src/renderer/drops/drops.css` | the `.from` comment, now that the slot answers a different question |
| `tests/timers.test.js` | 6 cases for the push gate |
| `tests/quests-needs.test.js` | 8 cases for the fold; 2 existing assertions updated to the new shape |
| `CLAUDE.md` | the parked-panel invariant; the stale "oversized invisible box" claim corrected |

## Verification

- `npm test` — **980 pass, 0 fail.**
- **The packed build, on the real windows**, read with `GetWindowRect` through
  `EnumWindows`:
  - Parked alerts window with the fix compiled in: `visibilityState: visible`,
    `rAF: 1`, `ResizeObserver: 1` — where the same window before the fix was
    `hidden / 0 / 0`.
  - **Unlock, before and after:** both panels at `-32000,-32000 64×64` on a fresh
    locked launch; after the gesture, `EQL Cast Warnings` at `1099,1 311×74` and
    `EQL Needed Drops` at `1793,1292 401×77`, at their own anchors.
  - **The loot toast, end to end.** A real `--You have looted a Silken Wrap from Bazzt
    Zzzt's corpse.--` line appended to a live-tailed log: the alerts window went from
    parked to `1046,1 416×64` **within 2 seconds**, carrying
    `Quest loot / Silken Wrap / 2 class tests want this`, with `visibilityState:
    visible` and `rAF` firing — on screen *and* painting, well inside the chip's
    6-second life.
- **Done against a scratch character** (`eqlog_Testrhale_oggok.txt`, `autoSwitchCharacter`
  off, config backed up and restored) so the loot line could not touch James's real
  ledger through the store's timestamp floor. Verified afterwards: 37 drop mobs, 119
  items, 176 owned, `logPath` back on `eqlog_Rhale_oggok.txt`.
- **The fold on the real pull**, replayed through main's own tick sequence against the
  live ledger — the table above. Every row of every payload measured for clipping: none.
- **The timer gate, end to end, against a replayed pull** — not just the unit test. A real
  Sister of the Spire fight (Aug 24 13:19–13:23, 1,186 lines, four `begins casting Entomb
  in Ice` casts 19s apart) re-emitted with `scripts/replay.js --write --speed 4` into a
  log the app was tailing, so the lines arrived one at a time exactly as the game writes
  them. The one personal-timer line in the window (a Spirit of the Puma cast) was stripped
  first, because a 146-second personal countdown holds the old gate open and would have
  hidden the bug. The boss box, sampled every 3 seconds:

  | | pre-fix gate | fixed gate |
  |---|---|---|
  | t+0…t+15s (before her first cast) | — | — |
  | **t+18s, first Entomb cast** | **—** | `Entomb in Ice 19s` |
  | t+21…t+30s | **—** | 16s → 17s → 19s → 16s, restarting in place per cast |
  | t+34s, Sister slain | — | — (early ender) |

  Both runs had all four cast lines in the tailed log, confirmed by grep, so the empty
  column is the gate and nothing else. The pre-fix box never left its parked 64×64.

## Notes

- **The plan's standing preference was wrong, and the measurement is why it was taken
  first.** It named "main un-parks the panel itself, without waiting to be asked" as the
  likely fix. The measurement showed main's un-parking was already correct and already
  fast; the panel simply was not being painted afterwards. That approach would have
  changed nothing about defects 1 and 4. This is the case for measuring before fixing,
  written down for the next time it is tempting to skip.
- **"Nothing here could arm a pack trigger without the game running" was wrong**, and it
  was wrong about a tool this repo already ships and CLAUDE.md already documents.
  `scripts/replay.js --write` re-emits a saved log into a file line by line, in
  wall-clock order, with the timestamps rewritten to now — the app cannot tell it from a
  live session. There was never a reason to wait for a real pull, and the before/after
  above is what running it produced.
- **`window.screenX` from inside a parked window is stale.** It cost an hour here,
  reading `-32000` for a window Windows itself put at `1793,1283`. Anything a parked
  renderer says about where it is should be checked against the OS.
- **If the drops panel ever reads as too tall**, note that the 16-row payload above is
  honest: Bazzt Zzzt genuinely owes 14 outstanding items on this ledger, and he owed
  them before the fold too. The fold removed repetition, not content. The next lever
  would be collapsing the classes column, not truncating rows — breakdowns show every
  ability, and this panel obeys the same rule.
