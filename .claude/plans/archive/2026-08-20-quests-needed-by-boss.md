---
status: completed
---
# Quests "By boss" panel + engaged-boss drops popup

**Date:** 2026-08-20

---

## Goal

Two surfaces, one inversion. The rail's boss flags (2026-08-19) answer "which of my
quests care about this boss?" per quest row; James wants the inversion readable both
ways:

**Phase 1 — the "By boss" panel.** A new screen of the Quests window: one list
organized **Boss → Item**, every mob (and island) that drops something still needed,
each item flying a small flag naming the class that needs it. The hunt list you read
*before* the raid.

**Phase 2 — the engaged-boss drops popup.** A small click-through overlay in a
corner of the game screen that appears **when a Sky boss is engaged**, listing the
drops that boss still owes and which classes want them — the same list, filtered to
the mobs in `engagedNpcs`, at the moment the loot question is actually asked. It
lingers past the kill (looting happens after the encounter closes) and is *gone* —
not an empty frame — whenever the engaged mobs owe nothing.

Both are strictly "still needed": done quests and owned items contribute nothing,
so both surfaces self-heal toward empty as the ledger completes. The data is a pure
inversion of what `questSourceFlags()` already walks — every unowned item of every
undone quest through `parseSources()` — regrouped by island+mob. All 18 distinct
source strings in `posky.json` parse cleanly today (pinned by the existing property
test), so the inversion inherits that guarantee.

Because phase 2 needs the inversion **in main** (which owns both the parser and the
`QuestProgress` store), the pure function lives in `src/quests/needs.js` — the
shared pure-Node layer beside `progress.js` — imported by the Quests renderer for
the rail mode and by main for the popup. One function, two surfaces, no way to
disagree.

## Approaches Considered

### 1. Fifth rail mode + a sixth click-through window fed from main
- **Description:** Phase 1: one more button in the rail's filter row swaps the
  rail's content to island/boss→item groups; clicking a class flag selects that
  class's quest. Phase 2: a new click-through window on the established pattern
  (own bounds key, HUD gestures, oversized invisible box), fed by main computing
  `engagedNeeds()` from the parser's engaged set and the quest store, pushed on
  its own IPC channel.
- **Pros:** The rail mode matches how James talks about the window ("the in
  progress screen" *is* a rail filter); content swap inside an existing pane
  honors the no-reflow rule by construction. The popup joins five existing
  windows that all work exactly this way — main owns placement and lifetime, the
  renderer is a dumb painter. Main already holds both halves side by side
  (`quests?.feedLine` sits in the parser feed loop) and has precedent for
  quest-aware live surfaces (`noteQuestLoot` chips).
- **Cons:** In boss mode the quest list is one click away. A sixth window is a
  sixth bounds key and preload. Both costs are the going rate here.

### 2. Fourth fixed pane in the Quests window; popup as an alerts-stack chip
- **Description:** Permanent hunt-list pane; on engage, push the needed list into
  the existing alerts window as chips.
- **Pros:** No new window.
- **Cons:** The alerts window is for combat warnings the player must act on *now*
  (CLAUDE.md pins this — update notices were kept off it for the same reason);
  a consult-list would displace real warnings, the exact failure the timers
  window was built to escape. Permanent fourth pane duplicates the rail flags
  and costs width forever.

### 3. Fold the popup into the boss-timers panel
- **Description:** Render needed drops as extra rows in the timers window on
  engage.
- **Pros:** Reuses a window and its bounds.
- **Cons:** Every timers row comes from a trigger pack — "there is exactly one
  source now" is that window's design sentence, and drops rows would unsay it.
  Slot lifetime rules (first-armed order, fixed heights, death clears) make no
  sense for a loot list.

### 4. Separate always-on hunt-list window instead of engage-triggered
- **Description:** A sixth window showing the full boss→item list all the time.
- **Pros:** No matching logic at all.
- **Cons:** The full list is a reading surface, not a glance surface — it's
  what the Quests window's boss panel is for. On screen during combat it's
  noise precisely when the filtered version is signal.

## Chosen Approach

**Approach 1**, both phases. Smallest genuine version of each ask, maximal reuse
of established patterns, one shared pure function.

### Semantics, pinned — phase 1 (the panel)

- **Groups key on island+mob** — the same key the rail flags dedupe on — so
  "Island 5: The Spiroc Lord" from one item and the continuation chip from
  "Island 5: spiroc mobs / The Spiroc Lord" merge under one boss header.
- **Order is island number ascending** (1.5 before 2), which is pull order;
  unrecognized verbatim shapes after the numbered islands, **zone-wide last**,
  one gold group — "anything in the zone" is not a trip.
- **An item with alternative sources appears under each of its bosses**, with a
  faint "also drops: ISL 4 · ISL 8" note per row — you fight differently over a
  drop you can get elsewhere, and hiding that would be data invisible on scan.
- **One item row per boss, all its classes flagged on it** — item-name equality
  merges across classes, same justification as `sharedIndex` (every shared name
  is spelled identically; the existing property test pins that). One flag per
  class even if two of its undone quests want the name (undone-wins precedent
  from `sharedIndex`; today no class does).
- **Class flags in dataset class order**, full class names, ≥12px — no
  abbreviations, no hover-only data.
- **Empty state is a sentence, not a blank pane:** "Nothing left to hunt — every
  unfinished quest's items are in hand."
- Rune items keep their gold accent; the selected quest's class flag reads as
  selected so the rail still answers "where am I".

### Semantics, pinned — phase 2 (the popup)

- **Trigger:** an engaged NPC name matching a dataset boss by case-insensitive
  equality. **Named bosses only in v1** — the family blobs ("spiroc mobs",
  "drake/sphinx/spirit mobs", "'bee' mobs", "essence/soul mobs") don't name real
  log mobs, and guessing membership from substrings is what this project doesn't
  do; families stay the Quests window's job until a hand-verified member list
  exists. **Zone-wide runes are omitted** — the popup answers "what does *this*
  mob owe", and zone-wide is not a fact about this mob.
- **Content:** the engaged bosses' groups from the same inversion — island+mob
  header, item rows, class flags, "also drops" notes — every item, no caps.
  A multi-boss pull shows each matched boss's group.
- **Lifetime:** appears on match; content updates if more bosses join the pull;
  **lingers 90 s after encounter close** — the loot window opens *after* the
  kill, which is exactly when the list is needed. A new pull that matches a
  boss replaces the list; one that matches nothing (a stray trash aggro while
  looting) leaves the lingering list alone until its deadline. Looted-while-lingering items vanish from it (the
  ledger moved, the push follows). When nothing matches or nothing is owed, the
  window is gone — except while unlocked, where the drag placeholder shows,
  because an empty window cannot be positioned.
- **Window contract:** click-through, own bounds key (`dropsBounds`), corner
  default placement, joins the HUD gestures (one `applyLock` unlock drags it,
  Ctrl+Shift+H hides it), warm parchment palette, **no scrolling ever** — the
  no-auto-fit pattern: a generously oversized invisible box sized for the worst
  realistic content (the richest single boss owes a handful of items) at the
  largest text size.
- **The lifetime judgement is pure.** A small state helper in `needs.js`
  (engaged names + encounter active + now → show/linger/hide) so the linger
  rule is WSL-tested like `layout.js`, and main just calls it on each push.
- **One switch, one place:** config key `dropsOverlay` (default on), a switch in
  Settings — the setup form owns "how the overlay behaves", and this key backs
  no other surface, so the two-places failure the ALERTS section died of can't
  recur.

## Tasks

### Phase 1 — the "By boss" panel

- [x] Pencil mock "Quests Window — needed by boss" in `pencil-new.pen` at 1:1:
      boss-mode rail with island headers, a multi-class item row, an
      alternative-source item with its "also drops" note, the zone-wide gold
      group, the selected-class flag state, and the empty state
- [x] `src/quests/needs.js`: `bossNeeds(snapshot)` → ordered groups
      `{island, mob, zoneWide, items: [{name, rune, alsoFrom, classes: [{classId, className, ref, reward}]}]}`,
      built from undone quests' unowned items via `parseSources` (imported from
      organize.js or moved beside it — whichever keeps both pure halves clean),
      keyed and ordered per the pinned semantics
- [x] `tests/quests-needs.test.js`: owned/done exclusion; island+mob merge
      across items and classes; alternatives under each boss with correct
      `alsoFrom`; zone-wide collapse to one trailing group; island sort with
      1.5 ordering; verbatim fallback riding through; property over the real
      snapshot (every unowned item of every undone quest appears under each of
      its non-zone-wide sources; a fully-owned snapshot yields `[]`)
- [x] `index.html` + `quests.js`: fifth filter button `data-filter="boss"`;
      `renderRail()` branches to `renderBossRail()`; class-flag click selects
      that class's quest; rail preview popup on class flags shows the quest's
      reward cards
- [x] `quests.css`: `.bosshead`, `.need` rows, `.clsflag` chips ≥12px with
      selected state, zone-wide gold group, empty state

### Phase 2 — the engaged-boss drops popup

- [x] Pencil mock "Drops popup — boss engaged" at 1:1: single-boss case,
      multi-boss pull, multi-class item row, linger state (same content, the
      fight over), and the worst-realistic-content box the window is sized for
- [x] Parser: expose the engaged set's names in `snapshot()` as `engagedNames`
      — pure, with a test in parser.test.js
- [x] `needs.js`: `engagedNeeds(groups, engagedNames)` (case-insensitive
      equality on mob, named bosses only, zone-wide never) and the pure linger
      state helpers `nextDropsState`/`dropsDisplay`; tests for match/no-match,
      case, blob non-match, linger transitions
- [x] `ipc.js`: channel for the drops push; `src/renderer/drops/` (index.html,
      drops.css, drops.js, preload.cjs) — dumb painter of the pushed groups,
      parchment palette, oversized invisible box
- [x] `main.js`: create the window (`dropsBounds` key, click-through, HUD
      wiring: applyLock drag, Ctrl+Shift+H, hide/show with lock state); compute
      and push on the 4 Hz tick via `pushDrops` before the snapshot skip;
      `dropsOverlay` + mute honored on every path (startup, setAlertOption,
      CONFIG_SET via `DROPS_KEYS`)
- [x] Settings: `dropsOverlay` switch in the setup form (Overlay page, its own
      "Needed drops" section), load + save wired

### Landing

- [x] `npm test` (886 pass); `scripts/dev.sh pack`; killed + relaunched the
      overlay via Start-Process
- [x] `docs/changelog/2026-08-20-quests-needed-by-boss.md` covering both
      surfaces; archive this plan

## Notes

- The 2026-08-19 boss-flags plan rejected a boss-first rail mode as "a much
  bigger surface than asked for" — it is now the thing asked for; the flags,
  the panel and the popup are three readings of one index and share parser,
  dedupe key and vocabulary on purpose.
- `bossNeeds` moved from the originally-planned `organize.js` home to
  `src/quests/needs.js` when phase 2 arrived: main must import it, and the
  renderer reaching into `src/quests/` is already how icons load. `organize.js`
  keeps `parseSources` (the items pane uses it directly); `needs.js` imports it.
- `RAIL_FILTERS` gains `'boss'`; `railFilter()` is bypassed in boss mode rather
  than taught about it — it filters quests, and boss mode has no quests to
  filter.
- James folded the popup in and said execute in one breath (2026-08-20); as
  with the 2026-08-19 execution, that is read as mock approval — the mocks are
  still built first and remain the redirect point if the shape is wrong.
- Named bosses in the dataset, for the matcher's fixture: Noble Dojorn,
  Protector of Sky, Gorgalosk, Keeper of Souls, Eternal Spirit, The Spiroc
  Lord, Bazzt Zzzt, Sister of the Spire, a greater sphinx, the Hand of
  Veeshan, Eye of Veeshan. ("Bazzt Zzzt 'Bees'" and blob segments are not
  names.)
- Mock questions carried from v1 of this plan, to settle in the mock rather
  than block on: island groups probably don't fold (eight islands, always-open
  reads better); island headers probably show an item count.
- **Executed 2026-08-20.** Mocks built first ("Quests Window — needed by boss",
  three "Drops popup" frames + note in pencil-new.pen); the known raster wedge
  hit the first frame and the recorded copy-to-re-rasterize workaround fixed it.
  One deliberate semantics change during execution: a new pull that matches
  nothing does NOT clear a lingering list before its 90 s deadline — a stray
  trash aggro while looting the boss corpse must not wipe the loot list; only a
  matched pull replaces it early. Plan text, mock note, tests and code all
  updated together. All 886 tests pass; packed and relaunched.
