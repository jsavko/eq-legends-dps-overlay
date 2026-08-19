# Quest rail boss flags — where the missing drops come from

**Date:** 2026-08-19

## What changed

Each unfinished quest row in the Quests window's left rail now carries a second line
of small flags naming the bosses (and the island each stands on) that drop the items
the quest still needs. During a Sky raid the live question is the reverse of what the
window answered before — "we're about to pull Gorgalosk, which of my quests care?" —
and the rail is the only surface you can scan for it. Until now that answer took a
click into every quest's items pane.

## How it works

- **`questSourceFlags(quest)`** in `src/renderer/quests/organize.js` is the whole
  judgement, pure and WSL-tested. It walks the quest's **unowned** items only, runs
  each item's `source` string through the existing `parseSources()` — so the rail and
  the items pane can never disagree about what a source means — and returns groups of
  chips.
- **Alternatives stay grouped.** The chips of one item are alternatives (the item
  drops from any of them), so they stay together in one group and the renderer joins
  them with a faint italic "or" — three bosses on one flag group is one item, not
  three errands.
- **Dedupe runs across items** on island+mob: two missing items off the same boss are
  one trip, so one flag. A chip deduped out of a later group leaves that group's
  other alternatives standing.
- **Zone-wide collapses to one gold flag.** All zone-wide (rune) sources become a
  single `ZONE-WIDE` flag dressed in the rune's gold, reading as a fact about the
  zone rather than a place.
- **Unrecognized source shapes ride through verbatim** — flagged, never dropped, the
  same contract `parseSources` already keeps.
- **Done and ready rows never grow.** A done quest contributes nothing however its
  items stand, and a ready quest has no unowned items, so the second line simply
  never exists for either — the rail converges back to one-line density as a
  character finishes. Owned is owned regardless of source: a manual claim silences a
  flag exactly like a logged loot.

## Files modified

- `src/renderer/quests/organize.js` — new `questSourceFlags()`; `classGroups()` now
  carries it per quest as `q.sources`.
- `src/renderer/quests/quests.js` — `renderRail()` wraps the old one-line row in
  `.qtop` and renders the `.flags` line beneath it when `q.sources` is non-empty.
- `src/renderer/quests/quests.css` — `.qrow` becomes a block with `.qtop` carrying
  the old flex line (selected/hover/done rules untouched on their descendant
  selectors); `.mobflag` chips at 12px+, island bold gold, mob name in full, dimmed
  against the reward name; `.mobflag.zone` in rune gold; `.or` separator.
- `tests/quests-organize.test.js` — seven new tests: cross-item dedupe, alternative
  grouping, zone-wide collapse, owned items contributing nothing, done/ready flying
  no flags, verbatim fallback, and a property over the real snapshot pinning that
  every unfinished quest names at least one source while done/ready name none.

## Why this shape

The Pencil mock ("Quests Window — rail boss flags") pinned the semantics before any
code, per the project's UI flow. Approach chosen over inline island-number badges
(island numbers alone hide the boss name behind a hover — data invisible on scan) and
over a boss-first rail mode (a much bigger surface than asked for). The two-line cost
self-heals: flags exist only while something is missing. Full mob names with no
truncation follow the show-all-data rule; row growth is fine because the rail is its
own scrolling pane — the no-reflow rule is about panes, not rows inside one.
