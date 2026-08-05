# Shipped baseline rhythms — timers pre-armed on a fresh install

**Date:** 2026-08-05

## Summary

The 14 boss rhythms measured from the live Rhale log now ship inside the app
(`src/main/baseline-rhythms.json`), so a fresh install's first raid starts with
timers pre-armed for every boss the data covers — Quag Maelstrom's Mana Drain,
Warlord Skarlon's and Hoptor Thaggelum's 8-second self-heals, Lord Nagafen's Shadow
Vortex, Master Yael's Immobilize, and the rest.

This looks like the "shipped boss database" the timer plan rejected, but is not the
thing that was rejected: that was *invented* data (community lore states no recast
periods), and this is *measured* data — produced by `seed-rhythms.js` from real
session logs, spreads and sample counts intact, never hand-written. The honesty rule
was always about where numbers come from, not where they are stored.

## Behavior

- Baselines are read-only gap-fillers: `RhythmStore.knownFor()` returns them merged
  UNDER the local store, so anything a player's own fights have learned for the same
  boss|spell replaces the baseline outright — never pooled with it. A rhythm measured
  on your own server beats one shipped from someone else's.
- They apply on any server (a boss's rhythm comes from game data, not the server),
  and are never written back to disk; the per-server files hold local learning only.
- A missing or damaged baseline file just means no baselines.
- `WARM_START_MIN_SAMPLES` dropped from 4 to 3, matching `QUALIFY_MIN_GAPS`: three
  agreeing gaps is exactly the evidence that shows a timer live mid-fight, and the
  same evidence written down should not become too weak to use on the next pull.
  Several genuinely tight measured rhythms (Skarlon's ±0.5s heal) carry n=3.

## Updating the shipped data

Re-measure and refresh with:

```
node scripts/seed-rhythms.js <eqlog> --dir /tmp/rhythm-seed --fresh
cp /tmp/rhythm-seed/<server>.json src/main/baseline-rhythms.json
```

## Files

- `src/main/baseline-rhythms.json` — new, generated (14 rhythms, 15 fights)
- `src/main/rhythms.js` — baseline-aware constructor + `knownFor`
- `src/main/main.js` — loads the baseline file beside it
- `src/parser/rhythm.js` — warm-start gate 4 → 3
- `tests/rhythms-store.test.js` — precedence/read-only coverage (254 total)
