# Plane of Sky quest tracker + charm-break sound

**Date:** 2026-08-14

Two features that shared one plan: a persistent ledger for the Plane of Sky class-test
quests, and the charm break finally saying something out loud.

## The Quests window and the ledger behind it

EQ Legends gates class unlocks on 95 Plane of Sky quests across 16 classes — island
drops plus one specific Wind Rune each. The app now ships that dataset, counts the
drops as they are looted, and shows the whole picture in a fourth reading surface
(tray → **Quests…**), three fixed panes on the History model against the approved
mockup in `docs/design/2026-08-14-quests-window-mockups.html`:

- **Rail**: all 95 quests grouped by class, done ones dimmed with a ✓, in-progress
  ones showing owned-of-needed. Dataset order, never re-sorted — the order is part of
  the data's meaning (see refs below).
- **Middle**: the selected quest — reward with its stats text, the class's quest NPC,
  and a manual **Turned in** toggle.
- **Right**: the item checklist — owned checkbox, log-derived looted count with its
  per-disposition split, drop source verbatim from the dataset. The rune row dresses
  gold and reads "random zone-wide drop", because that is what a rune is.

The honesty rule the whole feature stands on: **looted counts are facts, owned and
done are claims.** The log states loot, so counts accumulate from it alone; the log
cannot see inventory (pre-logging loot, trades, turn-ins), so owned/done are flags set
only by hand or by importing an eqlposky.com progress export — never guessed. An
import is a dated snapshot: it only ever SETS flags, re-importing is idempotent, the
window shows "imported from eqlposky export of Aug 14", and live counts keep running
past it.

### The dataset

`src/quests/posky.json`, transformed from https://www.eqlposky.com/ (itself sourced
from EQProgression's Legends guide; both attributed in the file) by
`scripts/fetch-posky.js` — which never writes without `--write` and diffs against the
committed copy so a refresh shows what moved upstream. Class ids and array order are
the site's, verbatim: its progress-export keys are positional (`bard:0:0` = class :
quest index : item index) and imports resolve through them. Stats text rides along;
icon/wiki URLs deliberately do not (no hotlinking a fan site's CDN).

Cross-checked against the live log: 105 of 974 distinct looted names hit the index,
including all 15 Wind Runes; the one near-miss ("Silver Ring" vs "Silvery Ring")
turned out to be two genuinely different items, both resolving correctly.

### Loot rules: one wording became four

`src/session/rules.js` matched only the kept form (`--You have looted…--`). The live
log has three more, and they matter: **Wind Runes overwhelmingly arrive auto-stored to
currency**, so a tracker on the kept form alone would have missed nearly every rune.
The family is now:

- `loot` — kept (`--You have looted a X from Y's corpse.--`), the NO DROP form
- `loot-stored` — auto-store, container captured generically ("currency",
  "Dragon Hoard" and "tradeskill depot" are all live), no trailing period
- `loot-created` — the Legends upgrade path (`…to create a X +3`), also unterminated
- `loot-sold` — auto-sell, coin or "free" (coin deliberately NOT counted into the
  session's coin category — that is its own fix, see plan notes)

plus the quantity form on all of them (`You have looted 2 Bone Chips…`). Every event
carries `disposition` and `qty`; the session tracker's loot pane now adds quantities.
Verified: 6,536 loot-shaped lines in the live log, 0 unmatched.

### The module

`src/quests/` is a third pure-Node sibling of the parser (after `src/session/` and
`src/triggers/`): `index.js` builds the normalized item-name → quest-slots index
(article strip + ` +N` upgrade-suffix strip + lowercase), `progress.js` is the
per-character JSON store (`<userData>/quests/<Char>_<server>.json`, directory injected
for tests, write failures toast — a full disk must not take the overlay down). The
same inclusive high-water-mark floor the session tracker keeps makes the tailer's
64 KB seek-back and re-runs of `scripts/backfill-quests.js` double-count nothing.
Backfilling the live log found 263 quest loots on day one.

### The loot chip

A new builtin-pack row **Quest loot** (`questLootAlerts`, default on) raises an alerts
chip when a looted item matches a quest slot the player **still needs** — quest not
turned in, item not owned. The needed-filter was James's one addition to the approved
mock, and it is the right rule: a chip for the tenth Wind Rune Kala after every Kala
quest is checked off teaches the player to stop reading the window. Tier 2, no cue.

## Charm break: a chip and a falling cue

When *your* charm breaks, the freed mob's first act is usually to turn on you — and
until now the app processed the break silently. The parser already detected it (the
worn-off line ending a live charm); it now announces it:

- The returned event carries `charmBroke`, and a **CHARM BROKE — <mob>** chip rides
  `hostileCasts` exactly as summons do (tier 3, own TTL, freed mob in the victim
  slot). Only the explicit worn-off path raises it: the charmed-mob-dies uncharm is a
  fight ending, and inferred breaks of other people's charms are stale news.
- New builtin-pack row **Charm breaks** (`charmBreakAlerts`, default on — a freed mob
  attacking you is tier-3 class information) with a sound-modifier row underneath
  (`charmBreakSound`, default off — sound is opt-in, always).
- The cue is two **falling** notes, the mirror of the rising interrupt cue, synthesized
  in `alerts.js` like its sibling — no media assets. Played only when the chip is
  actually drawn, and never both cues for one chip.

Both new categories join `ALERT_CATEGORIES` (window existence, tray toggles) and the
old-"alerts off" config migration, so an upgrade cannot hand chips to a player who had
said no alerts.

## Files

- `src/quests/index.js`, `src/quests/progress.js`, `src/quests/posky.json` — new module
- `src/renderer/quests/` — new window (index.html, quests.css, quests.js, organize.js,
  preload.cjs)
- `scripts/fetch-posky.js`, `scripts/backfill-quests.js` — new scripts
- `src/session/rules.js`, `src/session/session.js` — loot rule family, qty handling
- `src/parser/index.js` — charm-break signal + warning entry
- `src/renderer/alerts/alerts.js` — two new chip categories, parameterized cue
- `src/main/main.js` — quest tracker wiring, Quests window, IPC, tray, quest chips
- `src/main/config.js` — `charmBreakAlerts`, `charmBreakSound`, `questLootAlerts`,
  `questsBounds`, migration coverage
- `src/main/builtin-pack.js` — three new rows; session-rule-backed patterns
- `src/main/ipc.js` — `QUESTS_*` channels
- `docs/design/2026-08-14-quests-window-mockups.html` — the approved mockup
- `tests/quests.test.js`, `tests/quests-organize.test.js`,
  `tests/fixtures/posky-progress.json` (James's real export) — new tests; plus updates
  to parser, session-rules, config and preload-channels tests. 764 tests green.

## Found along the way

Turn-ins ARE logged — `You offered 1 Crude Wooden Flute to Cilin Spellsinger.`, 171
lines in the live log — under a wording the plan's research didn't probe ("You give"
was checked, "You offered" exists). Auto-marking quests done from offers stays out of
scope (an offer is one item of several, and vendor/coin offers share the wording), but
the follow-up is now concrete and worth its own plan.
