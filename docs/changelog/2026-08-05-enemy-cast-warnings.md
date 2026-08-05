# Enemy cast warnings — a DBM-style floating alert window

**Date:** 2026-08-05

## Summary

The overlay now warns about enemy spellcasting, Deadly-Boss-Mods style. When a hostile
NPC starts casting, a warning chip appears in a new floating always-on-top window —
top-center of the screen by default, repositionable like the meter — ranked by how
urgently the group should react. NPC heals, charm, mez, fear and gate get a big
alarm-red **INTERRUPT** banner; stuns, roots, snares and Harm Touch get an amber warn
line; identified nukes/lifetaps/dispels and every *unlisted* spell get a calm compact
line. Warnings clear the moment the log confirms an interrupt, when the caster dies,
on zoning, or after six seconds.

This works because EQ Legends prints real spell names for NPC casts ("A cyclops begins
casting Instill.") where classic EverQuest printed an anonymous "begins to cast a
spell." — and prints interrupt confirmations for NPCs too. The log had everything;
nothing is guessed.

## Features

- **`src/parser/spellwatch.js`** — pure classification table mapping spell names to
  categories (charm, mez, fear, heal, gate, stun, root, snare, lifetap, dispel, nuke)
  and severity tiers. Pattern-based, not exact-name, because this server ranks spells
  ("Mesmerization VIII", "Greater Healing V"). The table only ranks casts — an
  unlisted spell is still shown by name, never hidden.
- **Hostile-cast tracking in `LogParser`** — `hostileCasts` entries created on casts
  by non-friendly casters, refreshed (not duplicated) on a same-caster+spell re-cast,
  cleared on interrupt/death/zone/TTL, exposed in `snapshot()` with `remainingMs`.
  Warnings exist in the idle snapshot branch too: the pull often *opens* with the
  mob's first cast, before any damage line creates an encounter.
- **`cast-interrupted` rule** — parses `<caster>'s <Spell> spell is interrupted.`
  (one wording covers NPCs and players; apostrophes inside spell names split
  correctly). An interrupted cast also leaves the attribution cast table.
- **Alerts window** (`src/renderer/alerts/`) — an invisible fixed 640×720 box whose
  renderer paints only the warning chips. Deliberately none of the overlay's geometry
  machinery: nothing auto-fits or auto-moves, so there is no resting/fitted split to
  get wrong. Shares the overlay's lock (Ctrl+Shift+L): click-through while locked,
  whole-box drag with a dashed placeholder while unlocked. Hides with Ctrl+Shift+H
  alongside the meter. Chips are reused by warning id so the tier-3 pulse never
  strobes across 4 Hz pushes. Full opacity always — the meter may be faded to 20%,
  but a warning that inherits that fade defeats itself.
- **Sound** — optional two-note Web Audio cue on a NEW tier-3 warning only
  (`castAlertSound`, off by default). Synthesized; the app still ships no media assets.
- **Settings** — "Cast warnings" section with toggles for the window (`castAlerts`,
  on by default) and the sound. Disabling tears the window down rather than hiding it.

## Empirical grounding

- Replaying the full live log raises 4,807 warnings: 492 tier-3, 925 tier-2, 851
  tier-1, 2,539 unlisted (almost all NPC self-buffs, which render as calm lines).
- The renderer was verified headlessly (stubbed `window.api`, real snapshot, headless
  Chrome) against the worst real moment: an Aug 4 raid AE pull with **15 simultaneous
  warnings**, three NPC heals casting at once. That moment set the window height
  (worst stack ~600px; a clipped warning is a silently hidden one) and promoted Harm
  Touch — which this server gives a cast time — to tier 2.
- Same-named mobs are indistinguishable in the log ("a cyclops" ×3), so a repeat of
  the same caster+spell refreshes the existing warning, and an interrupt clears every
  warning from that caster name — a stale warning after the group saw "interrupted"
  reads as broken, and a missed real cast re-alerts within seconds.

## Files

- `src/parser/spellwatch.js` — new classification table
- `src/parser/rules.js` — `cast-interrupted` rule
- `src/parser/index.js` — hostile-cast lifecycle, `HOSTILE_CAST_TTL_MS`, snapshot field
- `src/renderer/alerts/{index.html,alerts.css,alerts.js,preload.cjs}` — new window
- `src/main/main.js` — `createAlerts()`, shared lock/visibility, snapshot fan-out,
  config-driven teardown
- `src/main/config.js` — `castAlerts`, `castAlertSound`, `alertsBounds` defaults
- `src/renderer/setup/{index.html,setup.js}` — settings toggles
- `tests/{rules,parser,spellwatch}.test.js` — 19 new tests (230 total)

## Known gaps, on purpose

- A single-token named mob casting before anyone engages or targets it reads as a
  player and raises no warning; engagement closes the gap at the first swing. The
  price of never alerting on random passing players.
- No cast-time progress bar: the log states no cast times, and a guessed bar is
  exactly the kind of invented number this project refuses to show.
- The user-approved mockup was an HTML artifact rather than a Pencil file — the
  Pencil app was not running; the approval flow (mock → user sign-off → build) held.
