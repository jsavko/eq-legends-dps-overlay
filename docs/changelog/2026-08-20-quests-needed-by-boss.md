# Quests "By boss" panel + engaged-boss drops popup

**Date:** 2026-08-20

## What changed

Two new readings of the quest ledger's boss index, both strictly "still needed":

1. **The Quests window grew a fifth rail screen, "By boss"** — beside All / In
   progress / Done / Ready. It inverts the ledger to Boss → Item → class flags:
   every island in pull order, every boss that still owes something, every owed
   item with the classes it is owed to. Clicking a class flag selects that class's
   quest (the middle and right panes follow as usual); hovering one previews the
   reward card. Zone-wide runes collapse to one gold group at the end. An item
   with alternative sources lists under each of its bosses with a faint
   "also ISL 4 · ISL 8" note. The list empties as the ledger completes, and the
   empty state is a sentence, not a blank pane.

2. **A sixth click-through window: the engaged-drops popup.** When a Sky boss
   with drops still needed is engaged, a small corner panel lists exactly those
   drops and their class flags — the loot question answered at the moment it is
   asked. It updates as bosses join the pull and as loot lands, flips its state
   line to "slain — while you loot" when the encounter closes, and stays up 90
   seconds — because the loot window opens *after* the kill. A new pull that
   matches a boss replaces the list; one that matches nothing (a stray trash
   aggro mid-loot) leaves it alone until the deadline. When nothing is owed the
   window paints nothing at all, except the drag placeholder while unlocked.

## The shared foundation

`src/quests/needs.js` — new, pure, WSL-tested, and the single source both
surfaces read, so they can never disagree about what a boss owes:

- `parseSources` **moved here** from the Quests window's `organize.js` (which now
  imports and re-exports it, so renderer imports read unchanged): the source
  vocabulary is shared with main now, and a renderer module is the wrong home for
  something main imports.
- `bossNeeds(snapshot)` — the inversion. Undone quests' unowned items through
  `parseSources`, grouped by the same island+mob key the rail flags dedupe on,
  merged across classes on plain name equality (the `sharedIndex` justification,
  pinned by its property test), islands ascending (1.5 before 2), verbatim
  unparseable shapes ridden through after them, zone-wide last.
- `engagedNeeds(groups, engagedNames)` — case-insensitive **equality**, nothing
  looser. Equality *is* the "named bosses only" rule: blob descriptions like
  "spiroc mobs" are not names the log will ever write, so they can never match,
  and no substring guessing was built. Zone-wide never triggers the popup.
- `nextDropsState` / `dropsDisplay` — the popup's lifetime as a pure state
  machine (engage → accumulate → linger 90 s → gone), and the paint-time rejoin
  that re-reads the live inversion so a drop looted mid-linger leaves the list
  with no invalidation plumbing.

## Plumbing

- **Parser** (`src/parser/index.js`): `snapshot()` now carries `engagedNames` —
  the encounter's enemy set by name. The label alone would not do: it is only the
  headline mob, and a multi-mob pull engages more names than it can name.
- **Main** (`src/main/main.js`): `pushDrops()` runs on the 4 Hz tick *before*
  the snapshot skip (the linger must expire during exactly the silence that skip
  exists for), recomputes the inversion only while a state is live or an
  encounter is running, and pushes on its own channel (`drops:state`) only when
  the payload changed. `createDropsWindow()` / `syncDropsWindow()` follow the
  timers pattern to the letter: own bounds key (`dropsBounds`, bottom-right
  default), click-through on the shared lock, Ctrl+Shift+H hides it, mute closes
  it, `broadcastConfig` reaches it.
- **Config** (`src/main/config.js`): `dropsOverlay` (default on), `dropsBounds`,
  `dropsEnabled()` (mute wins, absent reads on), `DROPS_KEYS`.
- **Settings** (`src/renderer/setup/`): one switch, "Show needed Sky drops when
  a boss is engaged", in its own Needed drops section on the Overlay page. One
  switch on one screen — the key backs no other surface, so the two-places
  failure that removed the ALERTS section cannot recur.
- **Renderer** (`src/renderer/drops/`): a dumb painter of `{ phase, groups }` in
  the timers window's dress. The panel **bottom-anchors** inside its oversized
  invisible box — unlike the timers' top anchor — so the default placement reads
  as a corner popup that grows upward into dead space. No scroll container
  anywhere; the box (620×760) is sized for the worst realistic list (a fresh
  ledger meeting an island-8 boss owes ~19 items) with the same "generosity is
  load-bearing" bet the alerts box makes.

## Files

- `src/quests/needs.js`, `tests/quests-needs.test.js` — new.
- `src/renderer/drops/{index.html,drops.css,drops.js,preload.cjs}` — new window.
- `src/renderer/quests/{index.html,quests.js,quests.css,organize.js}` — the
  By boss rail mode; `parseSources` re-exported from its new home.
- `src/parser/index.js`, `tests/parser.test.js` — `engagedNames`.
- `src/main/{main.js,config.js,ipc.js}`, `tests/config.test.js`,
  `tests/preload-channels.test.js` — window, lifecycle, keys, channel.
- `src/renderer/setup/{index.html,setup.js}` — the switch.

## Why this shape

Pencil mocks ("Quests Window — needed by boss", the three "Drops popup" frames
and their note, `pencil-new.pen`) pinned both surfaces before code; James folding
the popup into the plan and saying "execute" in one breath was read as the mock
approval, per the 2026-08-19 precedent. The 2026-08-19 boss-flags plan had
rejected a boss-first rail mode as "a much bigger surface than asked for" — it
became exactly the thing asked for, and the flags, the panel and the popup are
now three readings of one index sharing parser, dedupe key and vocabulary.

Deliberate omissions, all honesty-driven: no substring matching for mob-family
blobs (a hand-verified member list could add them later), no zone-wide rows in
the popup ("anything in the zone" is not a fact about this mob), no `alsoFrom`
notes in the popup (mid-fight the question is this boss, and the full story is
one window away), and the popup lists every item with no cap — the show-all-data
rule applies to it exactly as it does to the breakdowns.
