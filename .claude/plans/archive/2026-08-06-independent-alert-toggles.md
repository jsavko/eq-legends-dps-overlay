---
status: completed
---
# Independent alert toggles: warnings, summons, CC and timers each on their own switch

**Date:** 2026-08-06

---

## Goal

The alerts window today is all-or-nothing. `castAlerts` is a single master switch that
creates or tears down the whole window (`main.js:786`), and everything it renders rides
on it: interrupt warnings, summon banners, crowd-control state chips, boss spell timers
and pet-mapping acknowledgements. `castTimers` looks like a second switch but is only a
render-time filter *inside* that window (`alerts.js:199`) — so "timers without warnings"
is impossible, and "summons without interrupt spam" was never expressible at all.

This plan splits the one switch into four independent ones (interrupt warnings, summon
announcements, crowd control, boss timers), derives the window's existence from whether
*any* of them is on, and puts the same switches on the tray plus a hotkey so they can be
flipped mid-raid without opening settings.

Three things this must not break:

- **The window is a real OS window.** Anything that changes which categories are on has
  to also decide whether the window should exist — created lazily when the first
  category comes on, torn down when the last goes off (torn down, not hidden: a hidden
  window still costs a renderer process for a feature the player said no to).
- **Existing configs.** A player who has `castAlerts: false` today means "no alerts at
  all". Under the new scheme that key only means "no interrupt warnings", so summons and
  CC chips would silently reappear on upgrade. That needs a one-shot migration.
- **The parser stays config-agnostic.** `hostileCasts` / `memberEffects` / `castTimers`
  keep riding every snapshot regardless of settings; gating is a display decision.

## Approaches Considered

### 1. Renderer-gated categories, window lifecycle derived from a pure predicate
- **Description:** Four flat config keys (`castAlerts`, `summonAlerts`, `ccAlerts`,
  `castTimers`). `alerts.js` early-returns per list when its key is off and clears that
  list's chips on the config push. A pure `alertsEnabled(cfg)` in `config.js` answers
  "should the window exist", called at startup and from the `CONFIG_SET` handler.
- **Pros:** Extends the pattern already in the code (`castTimers` is exactly this).
  The lifecycle decision lands in one pure, unit-testable function next to `DEFAULTS`,
  which `tests/config.test.js` already covers. No parser change, no IPC change, no new
  snapshot shape. Toggles apply live — the config push the window already receives is
  the whole delivery mechanism.
- **Cons:** The main process keeps sending snapshot fields the renderer throws away
  (a few hundred bytes at 4 Hz — free). Two places know about alerts: the renderer knows
  what to draw, main knows whether the window lives.

### 2. Main-process snapshot filtering
- **Description:** Main strips `hostileCasts` / `memberEffects` / `castTimers` from the
  snapshot before sending it to the alerts window; the renderer stays dumb.
- **Pros:** One place owns the policy. Nothing crosses IPC that won't be drawn.
- **Cons:** The overlay and alerts window share `CHANNELS.SNAPSHOT` and the same push
  (`main.js:289`) — per-window filtering means building two snapshots per tick, or a
  filter that has to know which window it's addressing. Buys nothing at this data volume
  and makes the push loop harder to read than the feature is worth.

### 3. Parser-level opt-out
- **Description:** Pass the toggles through `parserOptions()` and have the parser skip
  tracking disabled categories entirely.
- **Pros:** Zero wasted work.
- **Cons:** Wrong layer. The parser is pure, replayable and unit-tested precisely
  because it doesn't know about display preferences, and `scripts/replay.js` would start
  producing different events depending on a UI setting. Toggling mid-fight would also
  mean a tracker with a hole in its history — a rhythm learned from half the casts is
  worse than no rhythm.

### 4. Keep `castAlerts` as a master, add sub-toggles under it
- **Description:** `castAlerts` still owns the window; the four new keys only decide
  what's drawn inside it.
- **Pros:** No migration — the stored key keeps its exact meaning. The "all off" case
  is explicit rather than derived.
- **Cons:** Two ways to express the same state (master off ≡ every sub-toggle off), and
  the classic confusion that comes with it: a checkbox that does nothing because a
  parent is unchecked. Also makes the tray menu awkward — a mute item *and* a master
  checkbox *and* four categories.

### 5. Nested `alerts: { warnings, summons, cc, timers, sound, muted }` object
- **Description:** Regroup all alert settings under one config object, like `hotkeys`.
- **Pros:** Tidier config.json; `merge()` already recurses one level so patches work.
- **Cons:** Renames three shipped keys, so *every* stored config needs migrating rather
  than just the ones with alerts disabled, and it churns `alerts.js`, `setup.js` and the
  tests for cosmetics. Flat keys already read fine.

## Chosen Approach

**Approach 1**, with the mute from the tray/hotkey work layered on top as a separate
`alertsMuted` key.

Renderer gating is what the codebase already does for timers, and lifting the "does the
window exist" question into a pure `alertsEnabled(cfg)` puts the one genuinely tricky
bit — four independent switches collapsing to one OS window — somewhere it can be tested
in WSL with no Electron, the same trick `layout.js` and `updater.js` already use.

Mute is deliberately *not* "uncheck everything": the hotkey is a session gesture ("shut
up for this pull"), the checkboxes are preferences, and folding one into the other would
lose the player's category choices the moment they hit the key. `alertsMuted` suppresses
the window wholesale while leaving preferences intact, and `alertsEnabled(cfg)` returns
false while it's set.

Two consequences worth stating plainly rather than discovering later:

- **Pet-mapping notices get no toggle of their own.** They're an acknowledgement of a
  command the player typed, not an alert, so they ride whatever window exists. With
  every category off there is no window and the in-game `pet X = Y` command goes back to
  silently doing nothing — an accepted trade-off, called out in a settings hint rather
  than papered over with a window that spawns for a two-second chip.
- **`castAlertSound` depends on interrupt warnings.** It's indented under that checkbox
  in settings and disabled when the parent is off, because a sound cue for a warning
  that isn't drawn is a beep with no explanation.

## Tasks

### Config — the source of truth
- [x] Add `summonAlerts: true` and `ccAlerts: true` to `DEFAULTS` in `src/main/config.js`;
      re-comment `castAlerts` to say it now means interrupt/cast warnings only, not the
      window
- [x] Add `alertsMuted: false` to `DEFAULTS`, with a comment on why it's separate from
      the per-category keys (mute must not destroy the player's choices)
- [x] Add `hotkeys.toggleAlerts: 'Control+Shift+A'` to `DEFAULTS` (no clash with the
      existing L / H / R / M bindings)
- [x] Export a pure `alertsEnabled(cfg)` from `config.js`: false when `alertsMuted`,
      otherwise true if any of `castAlerts` / `summonAlerts` / `ccAlerts` / `castTimers`
      is on
- [x] Migrate on `load()`: a stored config with `castAlerts === false` and no
      `summonAlerts` key predates the split and meant "no alerts at all" — set
      `summonAlerts`, `ccAlerts` and `castTimers` false to preserve that intent, and
      comment the rule as a one-shot upgrade
- [x] `tests/config.test.js`: `alertsEnabled` truth table (each category alone, all off,
      muted-but-enabled), the migration rule, and that a config already carrying the new
      keys is left alone

### Main — window lifecycle, tray, hotkey
- [x] `main.js:93` startup: create the alerts window from `alertsEnabled(config.all)`
      instead of `config.get('castAlerts')`
- [x] `CONFIG_SET` handler (`main.js:786`): when the patch touches any alert key or
      `alertsMuted`, recompute `alertsEnabled(after)` and create or `close()` the window
      accordingly — replacing the current `patch.castAlerts !== undefined` check
- [x] Call `refreshTrayMenu()` from `CONFIG_SET` so the tray checkmarks follow changes
      made in the settings window (they don't today)
- [x] Add an **Alerts** submenu to `refreshTrayMenu()` with checkbox items for interrupt
      warnings, summons, crowd control, boss timers and sound, plus a `Mute alerts`
      checkbox carrying the `toggleAlerts` accelerator — a submenu, because the top-level
      menu is already nine items and this would double it
- [x] Add a `toggleAlerts` action (flip `alertsMuted`, apply the same
      create/close + `refreshTrayMenu` path, `toast()` the new state) and bind it in
      `registerHotkeys()`
- [x] Confirm the mute path and `Ctrl+Shift+H` don't fight: H hides the whole HUD
      including the alerts window, mute hides only alerts and leaves the meter up

### Renderer — the alerts window
- [x] `alerts.js`: split `render(warnings)` into interrupt warnings and summon banners by
      `category === 'summon'`, gated on `castAlerts` and `summonAlerts` respectively —
      both still land in `#stack`, still sorted by tier then id, so the ordering rule
      ("highest severity on top, oldest first within a tier") is unchanged
- [x] Gate `renderEffects` on `ccAlerts` the way `renderTimers` is already gated on
      `castTimers`, and factor the three "off → clear my chips and return" blocks into
      one shared helper so a fourth category can't get it subtly wrong
- [x] Make `applyConfig` clear the chips of any category that just went off, so a live
      toggle takes effect on the next config push rather than on the next snapshot that
      happens to change that list
- [x] Verify chip reuse still holds after the split — the maps are keyed by warning id /
      `who|effect` / `caster|ability`, so a category toggled off and back on rebuilds
      cleanly without stale entries

### Settings UI
- [x] Rename the `Cast warnings` section in `src/renderer/setup/index.html` to `Alerts`
      and expand it to four checkboxes: interrupt warnings, summon announcements, crowd
      control on the group, boss spell timers — each with its existing `unit` gloss
- [x] Indent `cast-alert-sound` under interrupt warnings and disable it when the parent
      is unchecked
- [x] Add a hint line stating that with every alert off the window is closed, so the
      in-game `pet X = Y` command has nowhere to reply
- [x] Add a hotkey row for `Mute alerts` (`hk-alerts`) alongside the existing four
- [x] `setup.js`: read and write the new keys in the load and save paths (`setup.js:100`
      and `:269`), including the new hotkey
- [x] Check the settings window still doesn't reflow awkwardly with the taller section
      (it scrolls internally by design, unlike the overlay)

### Verify and ship
- [x] `npm test` — full suite green
- [x] Headless renderer check per the CLAUDE.md recipe: stub `window.api`, feed a real
      snapshot with warnings + summons + CC + timers, and confirm each toggle
      independently removes exactly its own list and nothing else
- [ ] Manual pass on Windows: toggle each category from settings *and* from the tray with
      a fight running, confirm the window appears/disappears at the right moments and the
      hotkey mutes without disturbing the meter
- [x] `docs/changelog/2026-08-06-independent-alert-toggles.md`
- [x] Bump `package.json` as its own commit, then `scripts/dev.sh dist` (kill the running
      overlay first — build fails on locked files)

## Notes

- `refreshTrayMenu()` is currently only called from `toggleLock` / `toggleVisible` /
  `toggleMetric`, never from `CONFIG_SET` — so today the tray already lies about state
  changed in settings. Fixing that is a prerequisite for tray checkboxes being trustworthy,
  not an extra.
- The parser is untouched by this plan. `snapshot()` keeps returning all four arrays
  (`src/parser/index.js:1386`) whatever the settings say, which is what keeps
  `scripts/replay.js` and the parser tests independent of UI preferences.
- `alertsBounds` is unaffected: the window is recreated at the remembered position, so
  toggling everything off and back on returns it to where the player dragged it.
- Open question for the manual pass: whether `alertsMuted` should persist across
  restarts. Persisting matches `locked` and `metric`, but a player who mutes and forgets
  will start the next session wondering why warnings are gone — the tray checkmark is
  the mitigation. Persisting unless the manual pass says otherwise.
- The headless check needed a synthesized-from-real snapshot: no single moment in the
  live log had warnings, a summon, a CC state and a timer up at once, so the verify
  snapshot merges real parser output from three moments. Nothing in it is hand-written.
- The harvested timer initially rendered as nothing at all, which looked like a bug and
  was not: its caster|ability was live as a warning in the same snapshot, so the
  promotion rule correctly hid the estimate behind the fact.
- The sound cue gained a `castAlerts` condition that the plan did not call for. Summons
  are tier 3, so with warnings off and sound on a summon banner would have beeped while
  the settings checkbox sat greyed out — the checkbox has to be telling the truth.
- Remaining: the manual Windows pass (task above) and the version bump + dist, which are
  the user's to run against a live fight.
