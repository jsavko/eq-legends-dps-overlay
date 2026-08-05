---
status: completed
---
# Boss Spell Timers (learned rhythms, named targets only)

**Date:** 2026-08-05

---

## Goal

For named/raid targets that live long enough to show a pattern, predict their next
cast: a countdown chip in the alert window ("Mana Drain ~5s · Quag Maelstrom") that
promotes to the full warning when the cast line actually lands. Timers are LEARNED
from observed recast intervals — never scripted from a database — and remembered per
boss across fights, so the second pull on a raid target starts pre-armed with what
the first pull taught us.

Scope, per the user: **named bosses and raid targets only** ("really only care about
named and raid targets that are living more than a couple minutes"). Generic trash
never gets a timer regardless of how regular it is — a ghoul scribe rebuffing Shield
of Brambles every 11s is metronomic and worthless. The learning is the point: "it
being able to learn new behaviors is fantastic."

Empirical grounding (full live-log interval analysis, this session): of 220
(caster, spell) pairs with ≥5 in-fight recasts, only 11 are tight enough to trust
(spread <25% of the interval). The tight ones are exactly the timer-worthy moments —
Quag Maelstrom's Mana Drain every 19s ± 1.5s, Foalya's Spike of Disease ~62s,
Ganer's Stun ~28s, Master Yael's Shadow Vortex ~44s. The loose majority (Gonobn's
Stun ± 14s) must never show a countdown, because it would routinely lie. So the
timer must EARN its place per spell: enough samples, low spread, auto-retract when
the pattern breaks.

## Approaches Considered

### 1. In-fight learning only
- **Description:** Track recast gaps per (boss, spell) inside the current encounter;
  show a countdown once ≥3 gaps prove regular. Nothing persists.
- **Pros:** Simple; parser-pure; no storage questions; honest by construction.
- **Cons:** The first ~60s of every fight is blind, every time — including the tenth
  pull on the same raid boss. For raid targets, which the user explicitly scoped to,
  repeat pulls are the norm; throwing the learning away is the worst part of it.

### 2. In-fight learning + per-boss persistent memory (rhythm store)
- **Description:** As (1), plus: when an encounter closes, learned rhythms for named
  casters are merged into a JSON store per server (`<userData>/rhythms/`). On the
  next engage of the same boss, the stored rhythm warm-starts the timer from the
  FIRST cast — one observation anchors the clock, the prior supplies the interval.
- **Pros:** Repeat raid pulls are pre-armed, which is the actual ask. Learning stays
  observational: the store contains only measured medians and spreads, no invented
  numbers. Directory-injected storage unit-tests like the history store.
- **Cons:** Server patches can change a boss; mitigated by continued learning (new
  observations keep merging, and a rhythm that stops matching retracts live).

### 3. Shipped boss-ability database
- **Description:** DBM's actual model — a curated file of each raid boss's timeline.
- **Pros:** Instant timers with zero warm-up.
- **Cons:** No such database exists for EQ Legends; classic-EQ lore doesn't state
  recast periods; it would rot with every patch; and it contradicts the project's
  honesty rule AND the user's stated preference for learning. Rejected outright.

### 4. Scripted fight timelines learned from a full kill (DBM-style phases)
- **Description:** Record the whole cast timeline of a kill anchored to engage time,
  replay it as a script next pull.
- **Pros:** Handles one-off phase abilities, not just periodic ones.
- **Cons:** The interval data shows EQ AI is condition-driven, not rotation-driven —
  anchoring to engage time compounds every deviation, so by 90s the script is
  fiction. Periodic rhythm with live correction (each real cast re-anchors the
  clock) is what the data supports.

## Chosen Approach

**Approach 2.** The moving pieces:

- **`src/parser/rhythm.js`** (pure, unit-tested in WSL): a `RhythmTracker` fed
  `(casterDisplay, ability, ts)` for every hostile cast by a NAMED caster, plus
  interrupt events. Per (caster|spell): keep in-fight cast timestamps; a rhythm
  qualifies once ≥3 gaps with cv < 0.25. Prediction = last cast + median gap; every
  real cast re-anchors. Gaps immediately following a confirmed interrupt are
  excluded from learning (the mob recasts early after interruption — a real effect
  that would poison the median). A timer retracts when overdue by >2× the observed
  spread; it never counts past zero into fiction.
- **Named-only gate:** eligibility is decided at the cast event from the RAW log
  name — no leading article (`A `/`An `/`The `) — AND the caster passing the
  existing `isHostileCaster` test. "Marrowbane pet" style boss pets qualify (named
  prefix). Generic article-mobs are never tracked, which also keeps the tracker's
  memory bounded.
- **Warm start / persistence:** parser exposes learned rhythms on encounter close
  (alongside `onEncounterEnd`); main merges them into `<userData>/rhythms/<server>.json`
  keyed `boss|spell` → `{intervalMs, spreadMs, samples, lastSeen}` (pooled with what
  is already there). On engage+first-cast of a known boss/spell, the stored rhythm
  arms the timer immediately. Store directory injected, so it tests against a temp
  dir exactly like `EncounterStore`. JSON, not SQLite, for the standing reason.
- **Snapshot:** a `castTimers` array (caster, ability, category/tier via spellwatch,
  `dueMs`, `intervalMs`, `spreadMs`, `warm` flag) — active encounter only, caster
  alive, not retracted. Rides the same 4 Hz push.
- **Alert window UI:** a timer section below the live warnings — dim countdown chips
  with a draining hairline bar (honest: the bar is measured data, labeled "~").
  At zero the chip either promotes (the cast line arrives → real warning takes over)
  or retracts. Small mockup pass before renderer work, per convention.
- **Settings:** `castTimers` toggle (default on) in the Cast warnings section.

## Tasks

- [x] `src/parser/rhythm.js`: RhythmTracker (gap collection, qualification, predict,
      re-anchor, interrupt-gap exclusion, retraction, export/import of learned
      rhythms); unit tests including a synthetic Quag-Maelstrom-like series and a
      Gonobn-like loose series that must NEVER qualify
- [x] Parser integration: feed named hostile casts + interrupts to the tracker,
      `castTimers` in `snapshot()`, revision bumps, reset/zone/death lifecycle,
      learned-rhythm export on encounter close, `setKnownRhythms()` warm-start
- [x] Rhythm store in main (`src/main/rhythms.js`, directory-injected, unit-tested):
      load per server, merge on encounter end, provide to parser on tail start and
      character/server switch
- [x] Mockup of timer chips in the alert window (countdown + draining bar, promote/
      retract states) — **user approved** (same artifact, "timer-chips" version)
- [x] Alerts renderer: timer section below warnings, chip reuse by key, countdown
      text + bar driven by `dueMs` between pushes, promote/retract transitions
- [x] Settings + config: `castTimers` toggle, wired like `castAlerts`
- [x] Verify headlessly with a replayed fight from the live log; confirmed the
      loose-spread bosses show no timer (see notes — verified on Hoptor Thaggelum)
- [x] Changelog, version bump, `scripts/dev.sh dist`

## Notes

- Thresholds to start from (tunable constants in rhythm.js, stated in comments):
  qualify at n≥3 gaps and cv<0.25; retract at overdue >2× spread; warm-start needs
  a stored rhythm with samples≥4. The empirical analysis script lives in this
  session's scratchpad; re-run it against future logs to re-tune.
- The store merges rather than replaces: a patched boss re-learns, and `lastSeen`
  lets a future cleanup drop rhythms not seen in months.
- Timers and warnings are separate arrays on purpose: a warning is a fact (the log
  said "begins casting"), a timer is an estimate (we say "~"). The UI must never
  blur them — different visual weight, "~" always present on timers.
- User context: community lore on what bosses do exists, but no recast-period data —
  which is why learning beats shipping a database, and why the user called learning
  "fantastic". Nothing in this plan ships static boss data.

**Execution findings (2026-08-05):**
- Replaying the full live log: timers armed for exactly the right names — Master Yael
  (108 moments), Lord Nagafen (58), Hoptor Thaggelum + pet (93), Magus Rokyl (48),
  King Tranix, Baron Telyx V`Zher, Quag Maelstrom. The loose casters (Gonobn, Zarann)
  never showed a timer once across the whole log. 17 rhythms would have persisted,
  e.g. Hoptor Thaggelum's Superior Healing 8.0s ±0.5 and Quag's Mana Drain 19.0s ±1.5.
- Headless verification: the shipping renderer, fed a replayed mid-cycle snapshot of
  the Hoptor Thaggelum fight, shows "~5s Lifespike · pet" and "~10s Shadow Vortex"
  with partially drained bars; at cast instants the same timers are correctly
  suppressed by their own live warnings (the promotion rule).
- Casts never extend an encounter (by design), so the parser tests that fight a boss
  with one damage line use a 120s timeout — a real bossfight's steady damage is what
  keeps the fight open in practice.
- Two same-named rhythm exports can arrive from different fights of the same boss
  ("Hoptor Thaggelum | Shadow Vortex" at 24s and 12s across sessions) — the store's
  pooled merge absorbs this; the capped sample count keeps re-learning possible.
