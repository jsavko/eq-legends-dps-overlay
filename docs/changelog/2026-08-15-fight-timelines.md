# Fights keep their timeline, and the History window draws it

**Date:** 2026-08-15

## What was missing

Every number the meter shows is a total or a rate over the whole fight; nothing
retained *when* the damage happened. The per-second Maps behind the rolling burst
windows (`window`/`healWindow`/`takenWindow` in `src/parser/encounter.js`) looked like
a timeline but were not one — `rollingTotal()` deletes buckets older than ten seconds
on every snapshot, so by the end of a fight they held only its final moments. A
DPS-over-time graph had nothing to read from.

## Durable timeline buckets

Each combatant now carries three durable series alongside the prune-on-read rolling
windows: damage, effective healing and damage taken, bucketed per second
(`tlDamage`/`tlHealing`/`tlTaken`). They fill per log line exactly as the rolling
windows do — nothing is computed at encounter close; close only persists what already
accumulated.

**Coarsening instead of dropping.** A fight that outruns 900 buckets (fifteen minutes
at 1s) doubles its bucket width and pairwise-merges every series — 2s, then 4s, and so
on. Every merge is exact by construction, so a series always sums to the aggregate
beside it; `tests/encounter.test.js` pins that reconciliation, and the merge happens
in place because `addToTimeline` coarsens mid-write while holding a reference to the
very array being merged. A ring buffer was rejected: it would drop the *opening* of a
long fight, which is often the part worth reviewing.

**Emission is opt-in; accumulation is not.** `enc.snapshot(now, { timeline: true })`
adds `timeline: { bucketMs, originTs, buckets }` at the top level and a per-row
`timeline: { damage, healing, taken }` (dense arrays, quiet seconds as real zeros, all
rows sharing one bucket count). The 4 Hz overlay push never asks — serializing every
series four times a second on a long fight would be hundreds of KB a frame for a
window that draws no curve. `persistEncounter()` asks, so every record written from
now on carries the fight's shape; old records simply lack the field.

## The History window's timeline panel

Between the metric buttons and the members/breakdown panes: a fixed 168px panel
(mock approved by James before implementation). Group curve in the metric's color,
selected-member curve in its lit tone — healing gained a lit variant (`#9adfd4`)
because balm-on-balm would have made the pair unreadable in exactly one metric. Curves
are per-second rates, so a coarsened fight's doubled bucket totals do not read as a
DPS spike, and they are lightly smoothed at draw time only — the record keeps the raw
buckets.

The no-reflow rule holds: the panel is 168px for every fight, and a record that
predates the feature shows a faint "no timeline recorded" in the same box — the same
always-in-flow treatment the deaths line gets, so panes sit on the same pixel for
every fight in the rail.

The math is a pure module, `src/renderer/history/timeline.js` (rates, element-wise
group sums, edge-shrinking box smoothing, 1/2/5 axis ceilings, time-tick ladder,
polyline geometry), unit-tested in WSL on the `breakdown.js`/`organize.js` model — and
imported unchanged by the mobile page, so a curve on the phone and the same fight's
curve here are the same arithmetic.

## Verified against the live log

Headless Chrome (the documented harness flow, over HTTP this time) drove the real
window against the tail of `eqlog_Rhale_oggok.txt`: a replayed Protector of Sky fight
drew real curves whose series summed exactly to its aggregate damage (26,943 = 26,943),
the metric buttons recolored the panel, and the store's 3,000 pre-feature records all
fell back to the faint empty line without moving a pane.

## Files

- `src/parser/encounter.js` — durable buckets, `timelineIndex`/`addToTimeline`/`coarsenTimeline`, snapshot emission
- `src/parser/index.js` — `snapshot(now, { timeline })` pass-through
- `src/main/main.js` — `persistEncounter` writes the timeline into the JSONL record
- `src/renderer/history/timeline.js` — pure graph math (new)
- `src/renderer/history/{index.html,history.css,history.js}` — the timeline panel
- `tests/encounter.test.js`, `tests/timeline.test.js` — bucketing, reconciliation, coarsening, geometry
