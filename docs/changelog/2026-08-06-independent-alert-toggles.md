# Independent alert toggles: warnings, summons, CC and timers each on their own switch

**Date:** 2026-08-06

## What shipped

The alerts window was all-or-nothing. `castAlerts` was a master switch that created and
tore down the whole window, and everything rode on it — interrupt warnings, summon
banners, CC state chips, boss timers, pet-mapping replies. `castTimers` looked like a
second switch but was only a render-time filter *inside* that window, so "timers without
interrupt spam" was impossible and "summons only" was never expressible at all.

There are now four independent switches. The window's existence is *derived* from them
rather than owned by any one of them, and the same switches sit on the tray, so a raid
leader can turn the interrupt spam off between pulls without opening settings.

1. **Four categories.** `castAlerts` (interrupt warnings), `summonAlerts` (summon
   banners), `ccAlerts` (stunned/mezzed/charmed chips) and `castTimers` (learned boss
   countdowns), each gated in the renderer the way timers already were.
2. **A derived window.** `alertsEnabled(cfg)` — pure, in `config.js`, unit-tested in WSL
   — answers "should the window exist". Main calls it at startup and from every path that
   can change an alert key. The window is closed, not hidden, when the last category goes
   off: a hidden window still costs a renderer process for a feature the player declined.
3. **Mute (`Ctrl+Shift+A`).** A session gesture, deliberately NOT "uncheck everything":
   the categories are preferences and folding one into the other would throw them away at
   the moment the player wanted quiet. `alertsMuted` suppresses the window wholesale and
   leaves the choices underneath intact. Narrower than `Ctrl+Shift+H`, which hides the
   whole HUD — mute leaves the meter up.
4. **An Alerts submenu on the tray** with all four categories, the sound cue and mute.
   A submenu because the top-level menu was already nine items.

## Config (`src/main/config.js`)

- `summonAlerts`, `ccAlerts`, `alertsMuted` added to `DEFAULTS`; `castAlerts` re-commented
  to say it now means interrupt warnings only, not the window.
- `hotkeys.toggleAlerts: 'Control+Shift+A'` — no clash with L / H / R / M.
- `alertsEnabled(cfg)`, plus `ALERT_CATEGORIES` / `ALERT_KEYS` so main never re-types the
  list. A missing key reads as ON: a config predating a category must not silently
  swallow the alerts that category draws.
- **One-shot migration.** A stored `castAlerts: false` used to mean "no alerts at all";
  under the new scheme it would only mean "no interrupt warnings", so summons and CC chips
  would reappear unbidden on upgrade. `migrateAlerts()` fires when `castAlerts === false`
  and `summonAlerts` is absent — the absence is the tell, so the rule can never run twice
  or fight a deliberate later choice. A stored `castTimers: true` is *overridden* rather
  than respected: with no window it was inert, and honouring it now would spring a
  countdown on a player who has had silence for months.

## Main (`src/main/main.js`)

- `syncAlertsWindow()` — the single place that creates or closes the window, called from
  startup, `CONFIG_SET` and the tray, so no caller has to remember half a toggle.
- `broadcastConfig()` — one push of the config to overlay, alerts and settings windows
  (previously open-coded twice); the alerts window gates at render time, so this push
  *is* the delivery mechanism for a live toggle.
- `CONFIG_SET` now resyncs the window when any of the five alert keys is in the patch, and
  calls `refreshTrayMenu()`. That last part fixes an existing lie: the tray was only
  refreshed from lock/visible/metric, so anything changed in settings left its checkmarks
  stale — a prerequisite for tray checkboxes being trustworthy, not an extra.
- `toggleAlerts()` bound to `hotkeys.toggleAlerts`, toasting the new state. With the HUD
  hidden by `Ctrl+Shift+H`, unmuting recreates the window already hidden — `H` stays the
  master switch.

## Renderer (`src/renderer/alerts/alerts.js`)

- `on(key)` and `clearChips(map, list)` — categories are gated twice, on the config push
  and at render time, so the teardown lives in one helper instead of being retyped per
  list. `renderTimers`'s hand-rolled version was folded into it.
- Warnings and summons are *filtered* out of one stack, not partitioned into two lists:
  they share the ordering rule, and separate lists would let a tier-2 summon sit above a
  tier-3 interrupt call. Chips carry `data-category` so a live toggle can pick its own
  back out of the shared map.
- `applyConfig` clears the chips of any category that just went off. Waiting for the next
  snapshot would not do — the push loop skips idle ticks, so between fights that can be
  minutes of staring at the thing you just switched off.
- The sound cue now also requires `castAlerts`. Summons are tier 3 and still beep while
  warnings are on, exactly as before; with warnings off the settings checkbox is greyed
  out, and a beep would make a liar of it.

## Settings (`src/renderer/setup/`)

- The `Cast warnings` section becomes `Alerts`: four checkboxes, each with its gloss,
  `cast-alert-sound` indented under its parent and disabled when the parent is unchecked.
- A hint states the trade-off plainly: with all four off the window is closed, so the
  in-game `pet Name = Owner` command still works but has nowhere to answer. Pet-mapping
  replies get no switch of their own — they are an acknowledgement of a command the player
  typed, not an alert, and spawning a window for a two-second chip would be worse.
- A `Mute alerts` hotkey row alongside the existing four.

## Verified

- 325 tests passing (was 317): 8 new in `tests/config.test.js` covering the
  `alertsEnabled` truth table (each category alone, all off, muted-with-preferences-intact,
  a config predating a category), both migration directions, the no-double-fire guard, and
  that no two default hotkeys share an accelerator.
- Headless renderer check in Windows Chrome against **real** parser output — warnings,
  a summon (`rock golem` → `Emalina`), a CC state (`Rhale` stunned) and boss timers
  harvested from the live session log, merged into one snapshot because no single moment
  in the log had all four lists populated at once. For each of the four keys: switching it
  off removed exactly its own list and left the other three untouched, on the config push
  alone with no snapshot; it stayed off across the next snapshot; switching it back on
  restored the list to the same chip count with no stale entries. All four off drew
  nothing. Tier ordering (summon 3 → warning 1 → warning 0) survived the split. The sound
  gate was confirmed both ways with a counting `AudioContext` stub: one cue with warnings
  on, none with them off.
- Not covered here: the manual Windows pass — toggling from settings *and* the tray with a
  fight running, and the mute hotkey mid-raid.
