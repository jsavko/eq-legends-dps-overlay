# Quieter cast alerts — six switches for what warns, three presets for how much

**Date:** 2026-08-07

## Summary

The enemy-cast warning stack had become wallpaper. Measured over 150 hours of live log
(920,137 lines) it raised **64 warnings an hour** with something on screen **18.7% of
the time** and a worst-case stack **16 chips deep** — and 70% of every chip was a spell
name with no call to act. The player had learned to look past it, which is the one
failure a warning surface cannot survive.

The severity ladder the warnings already had could not fix this, because it sorts by
DANGER and the problem is VALUE. Roots and snares raise ~11/hour and there is usually
nothing to do about one; mez, charm and fear together raise **less than 1/hour** and are
the warnings you drop everything for. Both sat in adjacent tiers.

So warnings now answer to six **group** switches named after what the cast would make
you do, with three presets that write them in one click. At the new default the same log
raises **21 warnings an hour**, occupies the screen **5.9%** of the time, and never
stacks deeper than 8.

| Preset | Per hour | Per 8h raid | Screen occupied | Max stack |
|---|---|---|---|---|
| Essential | 10.5 | 84 | 3.1% | 6 |
| **Balanced** *(new default)* | 21.4 | 171 | 5.9% | 8 |
| Everything | 66.0 | 528 | 12.0% | 13 |
| *(old behaviour)* | *~64* | *~510* | *18.7%* | *16* |

## What shipped

### Six groups, three presets

`spellwatch.js` now stamps a `group` on every entry alongside its tier, and **the two
answer different questions**: the TIER decides how loud a chip draws (banner / warn line
/ calm line), the GROUP decides whether it draws at all. That split is why none of this
needed a single CSS change.

The group lives on the table ENTRY rather than being derived from the category, because
`nuke` spans two severities that belong in two different switches — Harm Touch is
something you brace for, a lightning bolt is something you read afterwards.

| Switch | Covers | Measured |
|---|---|---|
| Heals & gates | `heal`, `gate` | 7.3/hr |
| Mez, charm & fear | `mez`, `charm`, `fear` | 0.6/hr |
| Big hits | tier-2 `nuke` (Harm Touch) | 1.6/hr |
| Roots, snares & stuns | `root`, `snare`, `stun` | 10.9/hr |
| Routine nukes & lifetaps | tier-1 `nuke`, `lifetap`, `dispel` | 11.8/hr |
| Unrecognized casts | unlisted | 32.8/hr |

Summons keep their own `summonAlerts` switch: they announce a fact in a banner shape of
their own, and they had a switch before the groups existed.

### The preset is derived, never stored

`presetOf(cfg)` is pure — if the six booleans match a preset's pattern that preset shows
selected, otherwise the state is Custom. Storing the preset alongside the switches would
create two things that can disagree, and the one that would be wrong is the label on
screen. A test pins `presetOf(DEFAULTS) === 'balanced'` so the shipped default and the
preset it claims to be cannot drift apart.

Each preset states **all six** switches rather than only what it turns on: a partial
preset would leave whatever was on before still on, so "Essential" after "Everything"
would have done almost nothing.

### The self-buff line is silenced at every setting

A new tier `-1` meaning "identified as not worth a chip" — deliberately distinct from
tier 0's "not identified at all", which is what keeps the standing never-hide-an-unknown
rule intact. 1,936 casts over the log (12.9/hr), suppressed even at Everything.

**The empirical check for this list overturned six of its own entries and is the most
important thing in this changelog.** The obvious test — "this spell has never once been
observed harming anybody" — is wrong twice over:

- It misfiles every NPC **heal**, the single most valuable warning the window draws.
- It misfiles the classic HP/AC buff line as harmless when those spells *do* print heal
  lines: `Inner Fire` heals 20, `Center` 55, `Skin like Rock` 44–57, `Bravery` 1–62.
  That is the buff landing — the hit points it grants — not a wounded mob topping itself
  up, and against pools in the thousands interrupting one changes nothing.

Three names that look like self-buffs and are not, now explicitly kept out:

- **`Tashania`** is a magic-resistance debuff cast ON the group ("Glorb is cured of
  Tashania"). It stays unlisted rather than being silenced.
- **`Chaotic Feedback`** deals real magic damage to the group, so no `feedback` pattern
  exists in the buff line at all.
- **The Echo family** (`Celestial`, `Sacred`, `Renewing`) is a genuine heal-over-time —
  "Emalina healed herself over time for 163 hit points by Celestial Echo", 161–330 a
  tick. It carried no "heal" in the name and was falling through to unlisted, so a boss
  healing itself 336 times over one session drew nothing but a calm line. Now tier 3.

### A warning clears when its cast resolves

The third resolution alongside the interrupt confirmation and the caster's death. A
spell-damage or resist line matching (caster, ability) drops the entry — spells only,
since melee carries the ability `Hit` and must never clear anything.

Measured: 3,857 warnings had their spell land while the chip was still up, a median of
**one second** in, then sat out the rest of a six-second TTL — **75% of their screen
time was a cast that had already happened**. After this, a chip on screen means the cast
is still in flight and can still be stopped. On its own this cut occupancy from 18.7% to
16.1%; the groups take it the rest of the way to 5.9%.

Unlike the interrupt path, only the named spell clears: an interrupt line cannot say
which same-named mob was stopped, but a damage line names the spell, so there is nothing
to be generous about.

### Fixed along the way

`Regrowth` never matched the heal pattern despite the comment claiming druid regrowth
was covered — `renew\w*` catches Renewal, not Regrowth. A heal falling through to
unlisted is the one misfile this table cannot afford.

## Decisions worth keeping

- **A missing group key reads as its DEFAULT, not as ON** — a deliberate departure from
  the rule `alertsEnabled` follows. That rule protects a choice the player MADE; nobody
  chose these six, and "absent means on" would restore the exact flood being fixed.
- **No migration.** An existing config gains the keys from `DEFAULTS` and lands on
  Balanced. The `migrateAlerts()` precedent does not apply: it exists because a stored
  key changed meaning underneath the player. Nothing changes meaning here — a config
  that kept the old firehose would be preserving the bug.
- **The engagement gate was dropped.** It was in the plan (26.9% of warnings come from
  mobs nobody is fighting) but with the groups doing the work it buys ~200 chips out of
  9,500, and it would add a second, invisible reason a warning failed to appear that the
  settings pane could not explain.
- **The group→key mapping is a naming convention, not a table** (`heals` → `warnHeals`).
  Two renderers need it and cannot import `config.js` (it reaches for `fs`); a rule
  cannot drift halfway, where a duplicated six-row table can.

## Files

- `src/parser/spellwatch.js` — `group` on every entry, the tier `-1` buff line, the Echo
  family and `regrowth` added to heals, `GROUPS` / `UNKNOWN_GROUP` exports
- `src/parser/index.js` — `resolveHostileCast()` called from `handleDamage`/`handleResist`,
  `group` carried on warnings and through `snapshot()`
- `src/main/config.js` — six `warn*` defaults, `WARN_GROUPS`, `warnKeyFor`, `WARN_KEYS`,
  `ALERT_PRESETS`, `warnGroupOn`, `presetOf`
- `src/main/main.js` — the "Warn about" tray submenu (three presets + six groups)
- `src/renderer/alerts/alerts.js` — `shows()` / `groupOn()`, `data-group` on chips
- `src/renderer/setup/{index.html,setup.js,setup.css}` — preset row and six checkboxes
- `tests/{spellwatch,config,parser}.test.js` — 26 new tests (351 total, was 325)

## Verified

- **351 tests passing**, up from 325. New coverage: the buff line suppresses at tier -1
  while every heal survives it, the two `nuke` entries land in different groups, a
  landing clears only its own spell, a melee swing clears nothing, a suppressed buff
  cast still anchors the rhythm clock, `presetOf` against every preset and a mixed
  state, `DEFAULTS` IS the balanced preset, and a missing group key reads as its default.
- **Headless renderer check in Windows Chrome against a real snapshot** carrying one
  genuine warning per group, harvested from the live log (`Superior Healing`, `Screaming
  Terror`, `Harm Touch`, `Instill`, `Lightning Bolt`, `Negation of Life`, `Quickness`,
  and a summon). Each preset drew exactly its own chips and no others; the buff chip
  drew at none of them; tier ordering survived the split. Switching a group off by
  **config push alone with no snapshot** removed exactly its chips and they stayed gone
  across the next snapshot. Missing keys drew nothing rather than everything. With the
  master off only the summon remained. The cue fired once for a lone tier-3 heal, zero
  times with that group switched off, and three times for three tier-3 chips.
- **Headless settings-form check**: all six checkbox ids resolve, the preset row lights
  the matching preset on load, clicking one rewrites all six boxes, ticking a box lands
  on Custom with no preset lit, and the saved patch carries all six keys.
- Not covered here: the manual Windows pass — the tray submenu with a fight running.
