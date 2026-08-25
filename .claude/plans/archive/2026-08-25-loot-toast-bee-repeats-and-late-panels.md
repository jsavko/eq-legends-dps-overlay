---
status: completed
---
# The loot toast is silent, the bee pull repeats itself, and the panels arrive late

**Date:** 2026-08-25

---

## Goal

Four defects reported against the build that shipped the engaged-drops popup
(`d10f2fc` → `2fbc80e` → `2108b98` → `f6290c4`), three of them root-caused before
this plan was written and one measured to a strong hypothesis:

1. **The quest loot toast shows nothing at all.** Looting a Sky quest item used to
   raise a chip in the alerts stack naming the item and what it builds. Nothing
   appears now. Confirmed by James: not late, not garbled — absent.
2. **The bee pull repeats itself.** Engaging island-6 bees puts four groups on the
   popup, three of which are the identical row `Adamantium Earring · Bazzt Zzzt ·
   Enchanter`, and the fourth (Bazzt Zzzt himself) shows a different set. Reproduced
   against James's real ledger, below.
3. **The timer boxes need a toggle before they show anything.** After launching the
   app, boss countdowns never draw until a box is switched off and back on.
4. **The needed-drops popup arrives 15–20 seconds after the fight starts.** James
   confirmed this is the drops popup specifically — not the timer boxes, not the
   alert chips, and not the meter, which are all prompt.
5. **Unlocking the HUD does not bring the alerts window or the drops popup up to be
   positioned.** Reported mid-planning, with James's own read that it is probably the
   same bug. It is: the three surfaces that fail — the silent toast, the late popup,
   the unpositionable panels — are the same two windows failing the same way.

The goal is all five fixed. Defects 1, 4 and 5 share one mechanism and are diagnosed
by measurement before anything is changed, because the mechanism decides which of
three quite different fixes is right.

## What is already established

Measured during planning, so execution does not re-derive it:

**Defect 2 is confirmed and its shape is known.** `dropGroups(quests.snapshot(),
{anyMob:true})` over James's live ledger yields 13 groups; `engagedNeeds` on
`['Bzzzt','Bzzazzt','Bazzzazzt','Bazzt Zzzt']` returns four groups — three carrying
only `Adamantium Earring` (boss qualifier `Bazzt Zzzt`, class `Enchanter`) and one
carrying `Fine Wool Cloak` (Rogue) **plus** the earring. This is exactly the
consequence the 2026-08-24 changelog wrote down and declined to fix:

> on a bee pull every engaged bee is its own group and every one of them owes the
> same earring, so at 13:17:50 the panel is four groups and five rows, four of which
> read `Adamantium Earring`. […] If it reads as noise in play, the fix is to fold
> identical rows across groups in `dropsDisplay`.

It reads as noise in play. That is the report.

**Defect 3 is root-caused.** `src/main/main.js:1132`:

```js
if (timersRuntime && (timersRuntime.live || timersRuntime.revision !== lastTimersRevision)) {
```

`TimersRuntime#live` is `this.slots.size > 0` (`src/timers/runtime.js:303`) — the
**player's own** timers and nothing else. The boss rows are merged inside
`pushTimerRows` from `triggers.timers(now)`, and the trigger engine's own `live`
and `revision` (both of which exist, `src/triggers/engine.js:423` and `:107`) are
not in the gate. So while no personal timer is armed, `pushTimerRows` never runs
and the boss box is never told anything. Toggling a box calls `syncTimerBoxes()`,
which ends in a direct `pushTimerRows()` — which is why the toggle "fixes" it, and
why it appears to fix itself later in a session (the first Spirit of the Puma or
Talisman of Alacrity to arm flips `live` true and the pushes resume). The gate was
introduced in `4e12a04`, the same commit that folded the boss panel into the boxes,
so this has been true since the boxes shipped.

**Defect 1 is NOT in the ledger, the parser, or the config.** Ruled out by
measurement, all against the real ledger and the real log:

- The store still produces chips. Replaying the last ~3 MB of
  `eqlog_Rhale_oggok.txt` through `QuestProgress#feedLine` → `lootChip`: 124 loot
  lines, 43 quest-counted, **25 of which would chip** (`Efreeti Belt | Warrior —
  Belt of the Four Winds · already turned in`, `Silken Wrap | 2 class tests want
  this — all covered`, …). The 17 silent ones are all fully-covered Wind Runes, the
  one documented deliberate silence.
- The full main-loop chain works. Feeding a real loot line through
  `LogParser#feed` and then `QuestProgress#feedLine(line, event)` returns
  `kind: 'loot'` with a chip — so the SPEECH chat guard is not eating it and the
  `minTs` floor is not eating it.
- `questLootAlerts` is `true` in the live `config.json`, `alertsMuted` is `false`,
  and `questChipSec` is 6 (`durationSec` clamps to [1,30], so the TTL is not zero).
- `shows()` in `src/renderer/alerts/alerts.js:151` passes `category === 'quest'`
  straight to that key, and `buildChip` has a real `quest` branch.
- The per-tick cost the drops popup added is **0.54 ms** (`quests.snapshot()` 0.45 ms
  + `dropGroups` 0.12 ms on the live 47 KB ledger), so main is not CPU-starved and
  that is not why anything is late.

**Which leaves one shape that fits defects 1 and 4 together.** Both surfaces are
click-through windows that `applyPanelFit` **parks off-screen at `-32000,-32000`
(64×64) whenever they have nothing to draw** — and CLAUDE.md is now out of date on
this point, because the alerts window is fit-tracked too
(`trackPanelFit(alertsWindow, 'top-center')`, `src/main/main.js:1972`), not merely
oversized. Between fights both windows sit parked and empty. Quest loot happens
between fights. So:

- The alerts window has to un-park, render and be resized within the chip's **6-second**
  TTL, or the chip is pruned by `questWarnings` and the player sees nothing at all.
- The drops popup has to do the same on engage, and takes 15–20 seconds over it.

Two facts make this more than a story. `backgroundThrottling` is set **nowhere** in
the tree, so every one of these windows runs with Chromium's default background
throttling, and a window parked entirely outside the desktop is occluded on Windows.
And the discriminator is already in the code: the **timer boxes are not late**, and
they are the one parked panel that calls `fit()` directly from its IPC handler
(`src/renderer/timerbox/box.js:134`) rather than waiting on a `ResizeObserver`
notification, which is delivered only during a rendering lifecycle that an occluded
renderer does not run. Alerts and drops both report through observers
(`alerts.js:488`, `drops.js:146`). The two late surfaces are exactly the two
observer-driven ones.

**Defect 5 is the discriminating experiment, and James ran it without meaning to.**
Unlocking is the one gesture that asks a parked panel to come back with no payload
involved at all: `LOCK_CHANGED` arrives, the renderer sets
`document.body.dataset.locked = 'false'`, CSS reveals `#placeholder`
(`drops.css:238`, and the same rule in the alerts window), the fit report goes up and
main un-parks the window at its anchor so it can be dragged. It does not come back.
So the renderer either never processed the message or never reported afterwards —
which is the same suspension the other two defects need.

And there is a second, independently provable defect sitting on the same path, which
is why that gesture has no fallback. Both renderers register:

```js
new MutationObserver(() => reportFit())
  .observe(document.body, { attributes: true, childList: true, subtree: true,
                            attributeFilter: ['hidden', 'class', 'style'] });
```

`data-locked` is **not in that filter**, and the placeholder is revealed by a CSS
selector rather than by touching the DOM — so unlocking fires no MutationObserver
callback and mutates no node. The *only* thing that can notice an unlock is the
`ResizeObserver`, and a ResizeObserver notification is delivered during the rendering
lifecycle an occluded renderer does not run. The payload path has two independent
ways to report (the `childList` mutation of `rows.replaceChildren` and the `hidden`
flip on `#panel`, both in the filter); the unlock path has one. That is why unlock
fails outright while the popup merely arrives late.

This is a hypothesis about the suspension with a clean experiment, and a certainty
about the attribute filter. The suspension is measured first; the filter is a bug
either way.

## Approaches Considered

Two of the four defects have one obvious fix each and are not litigated here — the
timer gate (add the trigger engine's liveness) and the bee fold (below). The
approaches that matter are how the repeats are folded, and what to do about parked
panels once the measurement comes back.

### 1. The bee repeats: suppress a row a previous group already showed
- **Description:** Keep the mob groups exactly as they are; in `dropsDisplay`, drop
  an item row that an earlier group in the same push already listed.
- **Pros:** Smallest possible change, entirely inside the pure module, no mockup
  needed, the panel gets short immediately.
- **Cons:** Makes the panel *lie* about the question it answers. The first bee would
  show the earring and the other three would show nothing, so "what does THIS corpse
  owe me" gets a different answer per corpse for corpses that owe the same thing —
  and James's own words for the current bug ("the final bee has different items")
  are a complaint about exactly that inconsistency. It would survive the fold.

### 2. The bee repeats: merge mobs that owe an identical item set into one group
- **Description:** In `dropsDisplay`, collapse groups whose item lists are equal into
  a single group whose header names all of them (`ISL 6  Bzzzt · Bzzazzt · Bazzzazzt`).
  Bazzt Zzzt stays his own group because his set differs.
- **Pros:** Honest — every named corpse still owes what the row says. No item is
  hidden from any mob. Grouping stays the organising idea James approved.
- **Cons:** The earring still appears twice (once on the merged bee group, once on
  Bazzt Zzzt's), which is the smaller half of the complaint but still repetition. The
  header grows with the pull and can outrun the box width on a five-bee pull.

### 3. The bee repeats: one row per outstanding item, mobs as its caption
- **Description:** Invert the panel. Group by ITEM across the whole engaged set; each
  row names the item once and captions it with which of the engaged mobs owe it,
  falling back to the family's boss when they all do.
- **Pros:** Zero repetition by construction — this is the only option where the same
  item cannot appear twice. It continues the direction the 2026-08-24 redesign
  already took (the drop is the headline, the mob is the caption), and the panel gets
  shortest: the bee pull becomes two rows, not five.
- **Cons:** The biggest change of the three, and it changes the question the panel
  answers from "is this corpse worth looting" to "what is this pull worth". Needs a
  Pencil mockup approved before implementation, per the house rule. Needs a decision
  about what the caption says when four of five engaged mobs owe an item.

### 4. Parked panels: turn off background throttling and native occlusion
- **Description:** `backgroundThrottling: false` in the `webPreferences` of the
  fit-reporting click-through windows, plus
  `app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')`
  if the measurement shows occlusion rather than throttling is what suspends them.
- **Pros:** Two lines. Addresses the mechanism directly, and keeps the parking design
  (which exists for a good reason: a *hidden* window's renderer stops painting and
  can never ask to come back, a bug that already cost an afternoon).
- **Cons:** It is a flag, and flags are a promise about Chromium's behaviour that a
  future Electron can quietly stop keeping — with no test that would notice, because
  the failure is a latency, not a wrong value. Costs a little battery on a laptop for
  windows that draw nothing most of the time.

### 5. Parked panels: main un-parks, and the renderer only refines
- **Description:** `applyPanelFit` already owns the bounds, so make un-parking main's
  decision rather than the renderer's. Main restores a panel to its last known good
  size the moment it *sends* a non-empty payload, and the moment it *unlocks* — both
  of which it knows about first-hand. The renderer's fit report then only refines a
  window that is already on screen and already rendering.
- **Pros:** Removes the dependency entirely rather than working around it — appearance
  latency stops being a property of the renderer's scheduling. It is main-side, pure
  arithmetic, and therefore unit-testable in WSL, which a Chromium flag is not. It
  keeps working whatever a future Electron does about occlusion. It is the only one of
  the three that fixes defect 5 *by construction*: unlock is a gesture main handles,
  and asking the suspended party to answer it was the mistake.
- **Cons:** Main has to remember a last-good size per panel, and the first appearance
  after a fresh launch has no remembered size to use (it would need one push at a
  provisional size, then the real fit). One frame at a slightly wrong size, on a
  panel whose whole job is to be read at a glance.

### 6. Parked panels: stop parking, keep them 1×1 on screen
- **Description:** Replace `PARKED` off-screen coordinates with a 1×1 window at the
  panel's own anchor. Still invisible, still click-through, but never occluded, so
  the renderer is never suspended.
- **Pros:** One constant changes. Nothing about the fit protocol, the anchors or the
  renderers moves. Keeps every reason parking exists (the renderer keeps painting and
  can ask to come back) while removing the thing that suspends it.
- **Cons:** A 1×1 always-on-top window is still a window sitting on the desktop —
  it can catch a click in the one pixel it occupies if the panel is ever unlocked,
  and it will show up in screen recordings and window enumerations. Whether Chromium
  treats a 1×1 window as occluded anyway is an empirical question, not a given.

## Chosen Approach

**Measure first, then fix — and fix the two that are already understood immediately.**

- **Defect 3 (timers)** — extend the push gate to the trigger engine's own liveness
  and revision, tracked in its own variable rather than borrowing
  `lastTriggerRevision` (which the snapshot push below it already owns and updates,
  so sharing it would make one push swallow the other's change). This is a
  determined fix with a determined shape and it lands first.

- **Defect 2 (bee repeats)** — **approach 3**, one row per outstanding item with the
  mobs as its caption. Approach 1 preserves the inconsistency James actually
  complained about, and approach 2 only halves the repetition. Approach 3 is the only
  one where the same item cannot appear twice, and it is a continuation of the
  hierarchy inversion already approved on 2026-08-24 rather than a reversal of it.
  Because it is a UI redesign it gets a Pencil mockup at 1:1 approved before any CSS
  moves, per the house rule and the way the history window shipped.

- **Defects 1, 4 and 5 (silent toast, late popup, unpositionable panels)** — the
  shared-mechanism hypothesis is strong but still a hypothesis, and the three
  candidate fixes (4, 5, 6) are different enough that guessing wrong means shipping a
  flag that does nothing. So the first task is an instrumented measurement in the
  **packed** build over CDP, and the fix is chosen from what it says. The standing
  preference, if the measurement confirms occlusion/throttling: **approach 5**,
  because it is the only one that is unit-testable in WSL, the only one that does not
  rest on a Chromium behaviour this project cannot pin, and the only one that fixes
  defect 5 by construction rather than by making the suspended renderer fast enough to
  answer. Approach 4 rides along as cheap insurance rather than as the fix. Approach 6
  is the fallback if the measurement shows the renderer never processes the IPC at
  all — in which case approach 5 still works (main un-parking it is what wakes it),
  but 6 would be simpler.

- **The `attributeFilter` bug is fixed regardless of the measurement**, because it is
  the reason the unlock path has no second way to report. Add `data-locked` to the
  filter in both renderers — or better, watch the attribute the CSS actually keys on
  rather than enumerating attributes at all, since the next state added to `body` will
  make the same mistake. It is not sufficient on its own (a suspended renderer will
  not run the callback either), which is exactly why it is not the fix.

If the measurement instead shows the alerts window is NOT parked between fights, or
that the chip never reaches the renderer at all, these defects separate and get their
own diagnosis; the plan is written so the fixes are independent.

## Tasks

### Diagnose the silent toast and the late popup

- [x] Reproduce defect 1 offline first: drive the real `alerts.js` headlessly with a
      stubbed `window.api`, push a snapshot whose `hostileCasts` carries one
      `category: 'quest'` chip, and confirm the chip renders and `reportFit` reports a
      non-zero size. If it does not, the bug is in the renderer and the parking
      hypothesis is wrong.
- [x] `scripts/dev.sh pack`, launch, and attach over `--remote-debugging-port`
      (see `project-drive-packed-electron-cdp` — tray-only windows need the
      openSettings→openTriggers chain, and occluded windows fire no rAF and hang
      `captureScreenshot`). For both the alerts and drops renderers, while parked,
      record: `document.visibilityState`, whether `requestAnimationFrame` fires,
      whether a `ResizeObserver` callback fires on a forced DOM mutation, and whether
      a `MutationObserver` callback fires.
- [x] Timestamp the round trip end to end: log in main the instant `CHANNELS.DROPS` is
      sent with a non-empty payload, log in the renderer the instant `render()` runs
      and the instant `window.api.fit` is called, and log in main the instant
      `applyPanelFit` sets the bounds. The gap that holds the 15–20 seconds names the
      culprit outright.
- [x] Confirm the alerts window is genuinely parked between fights by reading its real
      bounds with `GetWindowRect` through `EnumWindows` rather than from Electron's own
      view of itself, the way `f6290c4` verified the drops window.
- [x] Run defect 5 as the discriminator: with both panels parked, send `LOCK_CHANGED`
      and record whether the renderer's handler runs at all, whether `data-locked`
      lands on `body`, whether the `ResizeObserver` fires for `#placeholder` going
      `display: none` → `block`, and whether any `fit` reaches main. Which of those
      four stops is the answer — handler not running means the renderer is suspended
      outright; handler running with no observer callback means the rendering
      lifecycle alone is suspended; observer firing with no un-park means the bug is
      in `applyPanelFit` and the whole hypothesis is wrong.
- [x] Write the measurement into the plan's Notes before changing a line, so the fix
      that ships can be argued from numbers.

### Fix the timer boxes (defect 3)

- [x] Add `lastBossTimerRevision` beside `lastTimersRevision` in `src/main/main.js`,
      its own variable rather than a second reader of `lastTriggerRevision`.
- [x] Extend the `pushTimerRows` gate at `src/main/main.js:1132` to
      `timersRuntime.live || timersRuntime.revision !== lastTimersRevision ||
      triggers?.live || (triggers?.revision ?? -1) !== lastBossTimerRevision`, and
      update both revision trackers when it pushes.
- [x] Comment it with why the second half exists — the boss rows come from a different
      engine merged in at push time, and a gate that only knows about one of the two
      sources is how the box shipped silent.
- [x] Add a test in `tests/` that a boss timer arming with an idle `TimersRuntime`
      results in a push. This needs the gate expressed as a pure predicate to be
      testable at all; extract it (`shouldPushTimerRows({runtimeLive, runtimeRevision,
      lastRuntimeRevision, triggersLive, triggersRevision, lastTriggersRevision})`) so
      the assertion is on the decision rather than on Electron.

### Fix the bee repeats (defect 2)

- [x] Build a Pencil mockup at 1:1 of the item-led panel for the real island-6 pull
      (four bees engaged, then Bazzt Zzzt joining), against the 1.25 scale James reads
      it at, and get it approved before touching CSS. Check the ≥15px body / ≥12px
      label floor at that scale rather than assuming it.
- [x] Decide and write down what the mob caption says in each case: all engaged mobs
      owe it, some do, one does, and the learned-index row that already carries a
      `boss` qualifier. Silence beats a guess in a slot read as a fact — the same rule
      that made `Efreeti Standard` carry no boss.
- [x] Rework `dropsDisplay` in `src/quests/needs.js` to return item-led rows. It is the
      pure module and it stays pure; `engagedNeeds`, `dropGroups` and `nextDropsState`
      do not move, because what is *owed* is not what is in question.
- [x] Update `src/renderer/drops/drops.js` and `drops.css` to the approved mock. Keep
      `.iname`'s `flex: 0 1 auto; min-width: 0` — the squeeze has to be absorbed by the
      item name's own ellipsis, or the class chips get crushed instead.
- [x] Update the existing `dropsDisplay` tests in `tests/quests-needs.test.js`
      (`:215`, `:352`) and add cases for: four mobs owing one item collapse to one row;
      a mob owing something the others do not keeps its own row; the caption when every
      engaged mob owes it; a row whose item was looted mid-linger leaves.
- [x] Re-run the real 13:16–13:18 island-6 pull through main's own tick sequence
      (`dropGroups` → `engagedNeeds` → `nextDropsState` → `dropsDisplay`) against the
      live ledger and record the before/after row counts, the way the 2026-08-24 work
      did. Five rows down to two is the claim; measure it rather than assert it.

### Fix the silent toast, the late popup and the unpositionable panels (defects 1, 4, 5)

- [x] Fix the attribute filter in `src/renderer/alerts/alerts.js` and
      `src/renderer/drops/drops.js` so an unlock has a reporting path that does not
      depend solely on the `ResizeObserver`. Prefer watching `body`'s attributes
      without an `attributeFilter` over adding `data-locked` to the list: the cost is
      a handful of extra `reportFit` calls that the size-unchanged skip already
      absorbs, and the enumeration is what silently excluded the one attribute the
      unlock actually changes.
- [x] Implement whichever of approaches 4/5/6 the measurement selects. If it is
      approach 5, put the last-good-size memory and the un-park decision in a pure
      function beside `layout.js` so it is unit-tested in WSL, and give it a
      round-trip test like the ones in `tests/layout.test.js` that pin the resting-vs-
      fitted rule. Un-parking must fire on **both** triggers — a non-empty payload and
      an unlock — since defect 5 is the one with no payload behind it.
- [x] Whatever the fix, add a test that a panel which has gone empty and comes back at
      exactly its previous size is still delivered — the "works once and never again"
      failure both renderers already guard against on their own side, which must not
      be reintroduced from main's side.
- [x] Verify defect 1 against the real thing: loot a quest item (or replay one through
      the tailer with `scripts/replay.js --write`) and confirm the chip appears within
      its 6-second window on the real alerts window.
- [x] Verify defect 4 the same way: engage a bee and record the wall-clock gap between
      the first placed damage line and the popup being on screen. Under a second is
      the target; anything over three is not fixed.
- [x] Verify defect 5 by hand in the packed build: with nothing owed and no fight
      running — the state both panels spend most of a session in — press
      Ctrl+Shift+L and confirm both the alerts window and the drops popup appear at
      their anchors and can be dragged.

### Close out

- [x] `npm test` green (966 at last count, plus the new cases).
- [x] Correct CLAUDE.md on two points this work proved stale: the alerts window **is**
      fit-tracked and parks, it does not merely buy safety with an oversized box; and
      whatever the parking rule becomes.
- [x] `docs/changelog/2026-08-25-<slug>.md` with the measurements, not the reasoning
      alone — particularly the round-trip timings, since a latency bug with no numbers
      in its changelog is one nobody can tell has regressed.
- [x] Kill the running overlay, `scripts/dev.sh pack`, **relaunch it** (three steps,
      not two).
- [x] Archive this plan to `.claude/plans/archive/`.

## Measurement (recorded before any fix, as the plan required)

**The mechanism, side by side on the same packed build, on the parked alerts window
(64x64 at -32000,-32000):**

| | default | `--disable-features=CalculateNativeWinOcclusion` |
|---|---|---|
| `document.visibilityState` | **hidden** | **visible** |
| `requestAnimationFrame` fires | **no** (0) | yes (1) |
| `ResizeObserver` fires | **no** (0, even on a real 10px -> 200px change) | yes (1) |
| `MutationObserver` fires | yes (1) | yes |
| `setTimeout` fires | yes (1) | yes |

Confirmed identically on the drops popup and on a timer box. So a parked panel keeps
running TASKS and MICROTASKS and stops running its RENDERING LIFECYCLE. Everything that
went wrong follows from which of the two a given path depends on.

**The position half was never broken.** With the drops window parked, a payload was
forced into it and the real `reportFit` ran: main resized and moved it to
`x=1793 y=1283 401x86` — its exact anchor — within 100ms, read from Windows with
`GetWindowRect` through `EnumWindows` rather than from Electron's own view. The renderer
meanwhile still reported `window.screenX === -32000`, which is stale because that value
is refreshed by the rendering lifecycle. So the popup was in the right place, the right
size, and not painting. That is the 15-20 seconds: the wait is for Chromium's occlusion
tracker to notice the window is back, not for main to move it.

**The unlock, before and after, with `ResizeObserver` and `rAF` stubbed out to
reproduce the parked window exactly:**

| | pre-fix | post-fix |
|---|---|---|
| unlock reports a fit | **no** — `#placeholder` computes to `display: block` and nothing is reported, ever | yes, `311x74` |
| a quest chip reports a fit | yes, `513x47` | yes, `513x47` |

That is the clean split between the two halves of the fix, and it is why both are
needed. The chip path always reported (a `childList` mutation is watched whatever the
`attributeFilter` says) — so defect 1 was never the filter, it was the paint. The unlock
path reported nothing — so defect 5 was never the paint, it was the filter.

**Defect 1's silence, fully assembled.** The chip is drawn and its size reported within
a millisecond; main un-parks the alerts window immediately; the window then does not
paint for tens of seconds; `questChipSec` is 6, so `questWarnings` prunes the chip and
main parks the window again long before Windows lets it draw. Nothing is ever seen. The
store, the parser, the config and the renderer were all working the whole time, which is
exactly why none of the five things ruled out during planning found anything.

## Divergences from the plan

- **The chosen approach for defects 1/4/5 changed on the measurement, which is what the
  measurement was for.** The plan's standing preference was approach 5 (main un-parks the
  panel itself rather than waiting to be asked). The measurement showed main's un-parking
  was already correct and already inside 100ms — the panel simply was not painted
  afterwards. Approach 5 would have fixed nothing here. Shipped approach 4 instead
  (`disable-features=CalculateNativeWinOcclusion` + `backgroundThrottling: false`),
  together with the `attributeFilter` fix the plan already required regardless.
- **The mockup is a rendered one, not Pencil.** The convention this panel actually
  follows — set on 2026-08-24 — is a 1:1 render of the real CSS at `scale: 1.25`, which
  is truer than a drawing because it is the shipping stylesheet. Three candidates were
  rendered and James picked B.
- **The row caption spells ONE mob name, the header two.** Not in the plan; found by
  measuring every row of the real payload for clipping. At two names in a row,
  `Pulsating Ruby` had its own name ellipsised to fit the caption explaining it.
- **The `" only"` suffix was dropped** from the row caption for the same 24px.
- **The "empty and comes back at the same size" case is verified, not unit-tested.** That
  guard lives in `reportFit`, which needs a DOM; there is no main-side memory to test
  because approach 5 was not taken. Verified in the harness instead: `0×0` then
  `401×114` again.
- **The timer fix is unit-tested at the decision, not on a live boss pull** — nothing
  here could arm a pack trigger without the game running.

## Notes

- **Defect 2 was predicted in writing and declined.** The 2026-08-24 changelog names
  both the consequence and the fix. That is the changelogs working as intended, and
  the reason this plan did not have to rediscover anything about it.
- **The 0.54 ms measurement matters beyond defect 4.** `pushDrops` recomputes the
  whole inversion every tick, and the changelog defended that as cheaper than the
  snapshot already being built. Measured on the real 47 KB ledger with 37 learned
  mobs and 267 pairs, it is. If the drop index grows by an order of magnitude this
  is the number to re-measure.
- **`mine-drops.js --write` was cleared of suspicion.** It was a good candidate for
  defect 1 — a backfill that advanced the store's `lastTs` high-water mark past the
  live session would silence every subsequent loot line through the `minTs` floor.
  It does not: it mutates only `state.drops` and persists, leaving `lastTs` alone.
  The live ledger's `lastTs` (1787655407000) corresponds to the `Silken Wrap` loot at
  06:56:47 on 2026-08-25, exactly where the log says it should be.
- **Two later loot lines did not advance `lastTs`** (07:00:11 and 07:00:25 —
  Treant Tear, Bracelet of Quiescence +1, Veeshan's Key, Glowing Diamond). That is
  correct behaviour and not a fifth defect: `lookup()` places none of those in the
  dataset, so the quest ledger declines them, which is the same reason they raise no
  chip. Worth knowing before somebody reads it as a symptom.
- **The timer gate bug also explains a symptom James did not report as one.** Boss
  countdowns appearing partway into a pull rather than at its start looks like the
  trigger engine being slow to fire, and it is not — it is the box not being told.
  Anything previously blamed on trigger latency should be re-examined after this
  lands.
- **The timer boxes are the control group, and that is what makes the diagnosis
  credible.** They park exactly like the other two, and they are the one panel that is
  neither late nor unpositionable — because they call `fit()` directly from the IPC
  handler (`src/renderer/timerbox/box.js:134`) instead of waiting on an observer, and
  because their placement is a MODE (`Arrange on screen`) rather than the unlock
  gesture. Two independent surfaces failing, one structurally-different surface not
  failing, and the difference being precisely the observer dependency, is stronger
  evidence than either failure alone.
- **This also predicts a defect nobody has reported yet:** any future click-through
  panel that parks and reports through a `ResizeObserver` will inherit all three
  symptoms. Whatever fix lands should be written down as the rule for the next one,
  in CLAUDE.md's click-through invariants rather than only in the changelog.
- **Open question for the drops mockup:** whether a folded row should name the mobs at
  all on a pull where every engaged mob owes the item. `ISL 6 · all four bees` is
  wording, and wording is where this panel has gone wrong twice (the blob prose, then
  `seen N×`). Worth James's eye on the mock rather than a decision made here.
