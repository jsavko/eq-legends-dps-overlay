# seed-rhythms: warm-start boss timers from an existing log

**Date:** 2026-08-05

## Summary

`scripts/seed-rhythms.js` replays an existing EverQuest log through the same parser +
rhythm store the app uses, so the spell timers don't start life blind: every named
boss the character already fought begins with its learned rhythms in the store, and
the next pull arms timers from the first cast.

```
node scripts/seed-rhythms.js <eqlog file> --dir <userData>/rhythms [--dry-run] [--fresh]
```

Run against the live Rhale log it seeded 14 rhythms from 15 fights — Quag Maelstrom's
Mana Drain ~19s ±1.5, Warlord Skarlon's Greater Healing ~8s ±0.5 (an interrupt-now
heal with a pre-armed countdown), Lord Nagafen's Shadow Vortex ~62s ±5.9, Master
Yael's Immobilize ~72.5s ±17.8.

## Notes

- Unlike `backfill-history.js` there is no per-fight id to deduplicate on — merging
  pools statistics. Re-running pools the same fights again: interval and spread are
  value-stable under that (pooling a value with itself moves nothing), but the sample
  count inflates toward its cap, so `--fresh` wipes the server's file first for a
  clean re-seed.
- `lastSeen` is stamped with each fight's own end time, not the seeding time, so any
  future stale-rhythm cleanup judges historical fights as historical.
- The app reads the store when tailing starts — seeding while the overlay runs takes
  effect on its next launch (or character switch).
- Two sessions of Hoptor Thaggelum's Shadow Vortex carried different rhythms (24s and
  12s); the pooled merge lands between them (~18s ±3.2). In-fight evidence overrides
  the prior within three recasts either way — this is the capped-samples design
  absorbing a boss with modes, not a bug.

## Files

- `scripts/seed-rhythms.js` — new
