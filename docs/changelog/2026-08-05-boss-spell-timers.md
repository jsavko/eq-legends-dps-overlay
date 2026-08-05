# Boss spell timers — learned recast rhythms for named targets

**Date:** 2026-08-05

## Summary

The alert window now shows countdown timers for named bosses' recasts: "~5s ·
Lifespike · Hoptor Thaggelum pet", a dim chip with an amber hairline draining toward
zero, sitting below the live warnings. Timers are **learned, never scripted**: a
rhythm must earn its timer with three observed recasts agreeing within 25% in the
current fight — or arrive pre-learned from previous pulls of the same boss, persisted
per server. At zero, the real "begins casting" line promotes the estimate to a full
warning; if the cast doesn't come, the timer retracts rather than counting into
fiction. Named targets only: trash never gets a timer, however metronomic.

Empirical grounding: across the full live log, only 11 of 220 (caster, spell) pairs
recast regularly enough to predict. The design embraces that — replaying the log,
timers armed exactly where they should (Master Yael, Lord Nagafen, Hoptor Thaggelum,
Magus Rokyl, King Tranix, Quag Maelstrom) and never once for the loose casters
(Gonobn, Zarann) whose ±14s wander would make any countdown a lie.

## Features

- **`src/parser/rhythm.js`** — pure `RhythmTracker`. Median + MAD statistics (robust
  to a boss skipping one cycle), qualification gates (≥3 gaps, cv < 0.25), per-cast
  re-anchoring, retraction when overdue by more than twice the observed spread, and
  exclusion of the gap following a confirmed interrupt (mobs retry early — a real
  effect that would drag the learned median down). Gaps over 90s are fight
  boundaries, not evidence.
- **Warm starts** — `setKnown()` holds rhythms from previous fights; a stored rhythm
  with 4+ pooled samples arms a timer from the FIRST cast of the next pull. In-fight
  evidence outranks the prior as soon as it qualifies.
- **`src/main/rhythms.js`** — `RhythmStore`: one JSON file per server under
  `<userData>/rhythms/`, pooled merge weighted by sample count, count capped at 30 so
  a patched boss can re-learn. Directory-injected and unit-tested like the history
  store; corrupt files yield the empty memory. Save failures toast, never crash.
- **Parser integration** — named hostile casters only (no leading article on the raw
  log name) feed the tracker; `castTimers` rides `snapshot()` while a fight is
  active; learned rhythms export on the real encounter-close paths and deliberately
  NOT on a manual reset (a disowned fight teaches nothing on the record, same rule
  as history).
- **Renderer** — timer chips below the warnings, reused by caster|spell so the drain
  bar transitions smoothly across 4 Hz pushes. A timer whose spell is live as a
  warning hides (the promotion); warm timers drop the amber and dim until this
  fight's own gaps confirm them. Timers always wear "~" — an estimate must never
  dress like a fact.
- **Settings** — "Show spell timers for named bosses" toggle (`castTimers`, on by
  default) in the Cast warnings section.

## Files

- `src/parser/rhythm.js` — new tracker (13 tests)
- `src/parser/index.js` — tracker lifecycle, `castTimers` snapshot field,
  `setKnownRhythms`, `onRhythmsLearned`
- `src/main/rhythms.js` — new persistent store (6 tests)
- `src/main/main.js` — store wiring: load on tail start and character switch, merge
  on encounter close
- `src/renderer/alerts/{index.html,alerts.css,alerts.js}` — timer section
- `src/main/config.js`, `src/renderer/setup/{index.html,setup.js}` — `castTimers`
- `tests/{rhythm,rhythms-store,parser}.test.js` — 23 new tests (253 total)

## Verification

- Full log replay: 17 rhythms would have persisted (Hoptor Thaggelum's Superior
  Healing 8.0s ±0.5, Quag Maelstrom's Mana Drain 19.0s ±1.5, King Tranix's Life
  Leech 20s ±3); zero timers ever armed for the loose-spread casters.
- Headless render of the shipping files against a replayed mid-cycle snapshot of the
  real Hoptor Thaggelum fight: two timers with partially drained bars; at cast
  instants the same timers are correctly suppressed by their own live warnings.

## Known limits, on purpose

- A boss whose recasts wander never shows a timer — that is the feature working, not
  a gap. The warning at cast start still covers those.
- Rhythms anchor to the last observed cast, not to engage time: DBM-style scripted
  timelines were considered and rejected because EQ AI is condition-driven, and an
  engage-anchored script compounds every deviation into fiction by the 90s mark.
