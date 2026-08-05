# Breath AEs get timers — rhythms learned from landings, not just cast lines

**Date:** 2026-08-05

## Summary

Lord Nagafen's Lava Breath showed no timer. Cause: innate breath weapons never print
a "begins casting" line — the log shows only the landings ("Lord Nagafen hit you for
500 points of fire damage by Lava Breath.") and resists — and the rhythm tracker
learned exclusively from cast lines. The landings, meanwhile, are metronomic: ~13.6s
± 1.4 across 30 observed volleys.

The tracker now learns from a second evidence source: spells LANDING on friendlies
from named hostile casters. Re-seeding found Lava Breath plus three more
landed-only rhythms (Warlord Skarlon's Frost Shard ~12s, his pet's Ice Spear
~22.5s, Hoptor Thaggelum's Ghoul Root ~18s); the store and shipped baselines grew
from 14 rhythms to 19.

## Changes

- **`RhythmTracker.noteLanded()`** — landed evidence with volley collapsing: an AE
  prints one damage line per group member in the same second or two, and those
  echoes must not become 1-second gaps. Lines within 2.5s of the anchor are one
  volley.
- **Cast lines outrank landings for the same spell** — a spell with both would
  contribute a full-cycle gap AND a tiny cast-to-landing gap every cycle, wrecking
  the median. Cast evidence anchors earlier (when the warning matters), so the first
  cast line seen restarts a landings-built entry, and landings are ignored once cast
  evidence exists.
- **New `resist` rules** (three wordings: "You resist X's Y!", "X resisted your Y!",
  "X resisted Y's Z!") — a wholly-resisted breath volley leaves no damage line, and
  without the resist as evidence a clean group resist would read as a skipped beat
  and retract a healthy timer. Incoming resists from named casters feed the tracker;
  outgoing resists teach nothing about the mob and are ignored.
- **Melee and DoT ticks deliberately excluded** — melee is continuous and DoT ticks
  are periodic by game mechanic, not by the boss's decision; both would learn
  garbage rhythms.
- Baselines regenerated with `seed-rhythms.js --fresh` (21 fights, 19 rhythms).

## Files

- `src/parser/rhythm.js` — `noteLanded`, volley collapsing, source precedence
- `src/parser/rules.js` — three resist rules
- `src/parser/index.js` — landed hook in `handleDamage`, `handleResist`
- `src/main/baseline-rhythms.json` — regenerated, 19 rhythms
- `tests/{rules,rhythm,parser}.test.js` — 5 new tests (259 total)
