---
status: completed
---
# Timer boxes: width, row height and text size, per box

**Date:** 2026-08-22

---

## Goal

A timer box is currently one shape for everybody: 296px wide, a 30px row, 13px text —
the boss panel's chrome, inherited by every box the player makes. That was right when
there was one panel; it is wrong now that a player runs several boxes at once for
different jobs. A boss box wants to be wide and legible across the room; a buff box
tucked beside the health bar wants to be narrow with tight rows; someone playing at
1440p wants all of it bigger and someone streaming wants it out of the way.

So: **width, row height and text size become properties of a box**, set in the Timers
window beside the box's name and position, stored in `timers.json` with everything else
about that box, and applied live while the player drags the control.

Three things this must not break:

- **A box is sized to its content.** The renderer measures itself and `TIMERS_FIT`
  resizes the window; that stays true, and it is what makes this cheap — nothing about
  the window geometry has to be migrated when a row gets taller, because no size is
  stored on the window side at all.
- **Defaults are today, exactly.** 296 / 30 / 13 are the numbers the existing chrome
  computes (22.77em × 13px = 296.0, 2.31em × 13px = 30.03), so a player who never opens
  these controls sees the panel they already know, pixel for pixel.
- **The global text-size slider keeps working.** `scale` in settings multiplies every
  HUD window and the box's em-based chrome rides on it today. The per-box numbers are
  what that slider multiplies, rather than a second, rival scale.

Out of scope: bar colour (already per timer, deliberately), box opacity, and any
per-timer size. Colour belongs to the bar and size belongs to the box; that split is the
existing design and this does not touch it.

## Approaches Considered

### 1. Per-box fields in `timers.json`, edited in the Timers window
- **Description:** Three new fields on a category — `width`, `rowHeight`, `fontSize` —
  clamped in `normalize()`, pushed to each box alongside its name, applied by the
  renderer as CSS custom properties. An always-present strip of three sliders in the box
  detail pane sets them.
- **Pros:** Sits exactly where a box is already made, named, coloured and placed — one
  screen answers "what does this box look like", which is the rule that removed the
  ALERTS section from the settings form. Boxes can differ, which is the whole request.
  Storage is the file that already holds the box's position, so there is one document
  to hand-edit and one to back up.
- **Cons:** Most work of the three: model fields plus clamps, an IPC field, renderer
  variables, new UI, tests. Three knobs per box is more surface to get wrong than one.

### 2. Three global keys in `config.json`
- **Description:** `timerBoxWidth`, `timerRowHeight`, `timerFontSize` read by every box.
- **Pros:** Smallest diff. `config:changed` already reaches the box renderer, so the
  live-update path exists with no new plumbing.
- **Cons:** Forces every box to one shape, which is the thing being complained about —
  a boss box and a buff box want opposite proportions. And it would still have to be
  edited in the Timers window (the settings form deliberately writes no timer keys), so
  it saves no UI work, only flexibility.

### 3. Global defaults with per-box overrides
- **Description:** Config holds the baseline; a box may override any of the three.
- **Pros:** Set once, tune the odd box.
- **Cons:** Two screens answering one question about one box, with an override that is
  invisible until you find it. This project has already paid for that shape once — a
  pack enabled while its surface was off, with neither screen saying so. Not worth
  reopening for three numbers a player sets twice a year.

### 4. One "size" multiplier per box
- **Description:** A single per-box scale, everything derived from it.
- **Pros:** One control, impossible to make ugly, no clipping to guard against.
- **Cons:** Does not answer the request. "Wide box, short rows" and "narrow box, big
  text" are both real layouts and a single multiplier can express neither.

## Chosen Approach

**Approach 1** — per-box `width`, `rowHeight`, `fontSize`, edited by an inline strip in
the Timers window's box pane (both confirmed with the user before writing this plan).

Mechanics worth pinning down before the work starts:

- **Effective size = stored × `config.scale`.** Multiplication, not replacement, so the
  global text-size slider still moves the whole HUD together and the defaults reproduce
  today's geometry exactly at 1×.
- **The values reach the box the way its name does** — in the `TIMERS_PUSH` payload,
  not by rebuilding the window. Rebuilding on a size change would drop the box back to
  its default corner, which is the same reason a rename does not rebuild it.
- **`.row .body` must stop being 22.77em.** The masked duplicate text layer is given the
  row's full width explicitly so narrowing the mask *crops* rather than *reflows* it; if
  the box width becomes a variable and that stays a literal, the two text layers say
  different things at every width but the default. This is the one non-obvious edit in
  the CSS.
- **A box with nothing running draws nothing**, so sizing it blind is useless — dragging
  a slider raises the same preview row that "Show me this box" raises, and the box on
  screen changes under the cursor. That is the whole point of putting the controls
  inline rather than in a modal.
- **Row height and text size stay independent**, because "wide box, tight rows" is a
  layout somebody wants. A row shorter than its text clips (the row is
  `overflow: hidden`, and the boxes never scroll — that invariant is untouched), so the
  strip says so quietly when the numbers cross rather than silently overriding what was
  typed.

## Tasks

- [x] `src/timers/model.js`: add `LOOK` — the defaults (296 / 30 / 13) and the min/max
      for each of the three — and normalize `width`, `rowHeight`, `fontSize` onto every
      category, clamped, defaulted, degrading rather than refusing on a hand-edited file
- [x] `src/timers/model.js`: export a pure `boxLook(category, scale)` returning the three
      effective pixel values, so the arithmetic that the renderer depends on is unit-
      testable in WSL like `layout.js` and `breakdown.js` are
- [x] `src/main/main.js` (`TIMERS_SAVE_CATEGORY` handler): accept a `look` patch beside
      `name` and `enabled` and pass it through `updateCategory` — the handler currently
      whitelists two fields and would silently drop a third
- [x] `src/main/main.js` (`pushTimerRows`): send each box its own `look` in the payload
      beside `name`, so a size change applies without rebuilding the window
- [x] `src/renderer/timerbox/box.js`: apply the pushed look as `--box-width`,
      `--row-height` and `--box-font` custom properties (multiplied by `config.scale`),
      and re-`fit()` afterwards so the window follows the new content size
- [x] `src/renderer/timerbox/box.css`: replace the hard-coded `22.77em` box width,
      `2.31em` row height and `13px` body size with those variables, keeping fallback
      values identical to today's; **including `.row .body`'s width**, which must track
      the box width or the masked text layer will crop against the wrong measure
- [x] `src/renderer/timersetup/index.html` + `timersetup.css`: the appearance strip —
      three labelled sliders with a live pixel readout and a "Reset to default", drawn
      under the box title for **every** box including the built-in one, so the pane never
      shifts between selections (the no-reflow rule)
- [x] `src/renderer/timersetup/timersetup.js`: wire the strip — read from the selected
      category, write through `saveCategory` debounced (a slider drag fires continuously,
      the same problem the box's own `moved` handler already solves at 400ms)
- [x] `src/renderer/timersetup/timersetup.js`: raise a preview row in that box while a
      slider is being dragged, so the player is looking at the box they are sizing;
      reuse the existing `TIMERS_PREVIEW` path and `state.showing` rather than a second
      mechanism
- [x] `src/renderer/timersetup/timersetup.js`: the quiet note when `rowHeight` is too
      short for `fontSize` — say the text will clip, do not override the number
- [x] `tests/timers.test.js`: normalize fills and clamps the three fields; a garbage
      hand-edit degrades to the defaults; `updateCategory` persists a look patch and
      leaves position and name alone; `boxLook` reproduces 296/30/13 at scale 1 and
      multiplies at 1.5
- [x] `npm test` green, `node --test tests/timers.test.js` specifically
- [x] `docs/changelog/2026-08-22-timer-box-look.md`
- [x] `CLAUDE.md`: the timerbox paragraph names 296px and the 30px row as fixed chrome —
      they are now this box's defaults, and the sentence should say where they live
- [x] `scripts/dev.sh pack`, then relaunch `win-unpacked` so James sees it

## Notes

- The ASCII sketch of the strip was approved in the planning question, which stands in
  for a Pencil mock at this size. If the strip grows past three sliders and a reset
  during implementation, mock it at 1:1 first — labels ≥12px, readouts ≥15px.
- Ranges to start from, adjustable on sight: width 180–800px, row height 14–80px, text
  9–32px. The floors matter more than the ceilings: a 100px box cannot show a spell
  name, and a box the player cannot find is a box they will not use.
- The built-in boss box gets these controls like any other box. Its rows come from the
  trigger packs, but its *shape* is the player's, and that is already true of its name,
  its position and its switch.
- Nothing here touches the fit protocol: the renderer still reports measurements and
  main still owns the bounds. A wider box grows to the right from its top-left anchor,
  which is what `trackPanelFit(win, 'top-left')` already does.

## Notes from execution

- **`Copy size from…` was added mid-flight**, at James's request while the build was
  running in front of him. Once one box is tuned, matching another to it by eye means
  dragging three sliders to numbers you cannot read off the first — so the strip offers
  every box but the one being sized, takes its three values wholesale, and snaps back to
  its prompt afterwards rather than sitting there looking like a link between two boxes.
- **The box renderer got simpler, not more complicated.** It no longer reads the global
  `scale` at all: main multiplies and pushes pixels, so `timerbox/preload.cjs` lost its
  two config channels. One number arriving one way beats two halves of a size arriving on
  two channels and having to agree.
- **`updateCategory` now re-normalizes.** It did not need to while a patch could only
  carry a name and a switch; a size patch comes off a slider and the caller keeps the
  result in memory as well as writing it, so the clamps have to run there rather than only
  inside the store's save.
- **`tests/preload-channels.test.js` was checking a directory that does not exist** — its
  list said `timers`, while the preloads live in `timerbox/` and `timersetup/`. Both had
  been unguarded since the boxes were built. Fixed on the way past, which is what caught
  the removed config channels being fine to remove.
- **A new `tests/timers-window.test.js`**, on the Triggers window's model. The size
  sliders' ids are built from the model's own field names (`look-${field}`), so a rename
  in `model.js` breaks three controls at once and a literal-id check would not see it —
  that test walks `LOOK` instead.
- **Verified in the running app over CDP** rather than assumed: per-box pixels arriving in
  two different boxes at a global scale of 1.25, both text layers measuring the full box
  width at 370px, the strip sitting on the same pixel for all three boxes, copy-from, and
  the clipping note. The one box the verification poked was put back exactly as found.

