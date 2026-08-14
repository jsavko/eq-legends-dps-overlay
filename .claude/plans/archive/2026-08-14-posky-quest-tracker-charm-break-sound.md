---
status: completed
---
# Plane of Sky quest tracker + charm-break sound

**Date:** 2026-08-14

---

## Goal

Two features, both inspired by jmoyers/everquest-companion (which targets the same
server):

1. **Track Plane of Sky drops and quest items.** EQ Legends gates class unlocks and the
   per-class "Test of …" reward items on PoSky quest turn-ins (95 quests across 16
   classes: each needs specific island drops plus a class rune that drops randomly from
   any Sky mob). The app should know which items each test needs, count them as they are
   looted, and show progress — who drops what, on which island, how many looted so far.
2. **A charm-break sound.** When *your* charm breaks ("Your Charm spell has worn off of
   a skeletal monk.") the freed mob turns on you; today the app silently drops it from
   the charm store and nothing else happens. It should raise an alert chip and,
   opt-in, an audible cue — the whole point is being heard while you look elsewhere.

### What research established

- **The live log is FULL of Plane of Sky data** — 59 zone entries (the most-visited
  zone in the log), ~370k lines in-zone, ~700 loot events across roughly 30 runs: quest
  items, Efreeti weapons, island keys (Key of Scale, Avian Key, Veeshan's Key, …) and a
  dozen distinct Wind Rune names (Meda, Neza, Lena, Kala, Caza, Fana, …). The wiki data
  can therefore be validated *empirically at build time*, and backfill will show real
  progress the moment the window first opens. (An earlier draft of this plan claimed
  the opposite — that conclusion came from a grep truncated to its first five matches,
  which happened to be chat lines.)
- **The data source is https://www.eqlposky.com/** (James's directive). Its `data.js`
  is a plain static file exposing `window.POSKY_DATA`: 16 classes, 95 class-unlock
  quests, each quest = `reward` + `items[]` with `name` and `source`
  ("Island 5: The Spiroc Lord", "Random zone-wide drop"); itself attributed to
  EQProgression's Legends guide. A sibling `item-details.js` (`POSKY_ITEM_DETAILS`)
  carries per-item stats/icon URLs sourced from the P99 wiki. Cross-checked against the
  live log: **94 of the 134 distinct item names Rhale has looted in Sky match this data
  exactly**, including all 15 Wind Runes (Azia→Ozah); the 40 non-matches are
  recognizable non-quest loot (island keys, motes, belts, Griffenne Blood).
- **The eqlwiki.com wiki has bad Sky info for Legends** (James, plus one concrete catch:
  the wiki's Bard data says "Light Woolen Mask" where the log and eqlposky both say
  "Light Woolen Mantle"). Do not source Sky quest data from the wiki.
- **everquest-companion's own `posky.json` is off-limits anyway** — that repo is
  FSL-1.1-MIT licensed: free only for *non-competing* use, and this overlay is plausibly
  a competing product. It served only as an existence proof of the feature.
- **Loot arrives in (at least) four wordings** in the live log, and
  `src/session/rules.js` matches only the first:
  - `--You have looted a X from Y's corpse.--` (kept — the form NO DROP quest items take)
  - `You looted a X from Y's corpse and stored it in your Dragon Hoard` — and the
    container varies: runes store as `...and stored it in your currency`, so the rule
    must capture the container generically, not match "Dragon Hoard" literally
  - `You looted a X from Y's corpse to create a X +N`
  - `You looted a X from Y's corpse and sold it for 3 platinum, 2 gold...`
  - plus a quantity form: `You looted 2 Phosphorous Powder from ...`

  This is load-bearing for Sky specifically: **Wind Runes overwhelmingly arrive via the
  auto-store-to-currency wording**, so a tracker built on the kept form alone would miss
  nearly every rune the player loots.
- **Charm-break detection already exists**: the `worn-off` rule fires for every fading
  spell, and `parser/index.js:1566` calls `roster.uncharm(event.target)` — a `true`
  return IS the charm-break signal, already distinguished from DoT fades. 922
  charm-family lines in the live log confirm the wording. Nothing downstream consumes it.
- **Sound precedent exists**: `castAlertSound` (default off — "sound is opt-in,
  always"), a synthesized two-rising-note `cue()` in `alerts.js` (no media assets, ever),
  gated so it only beeps when the warning is actually drawn. The builtin-pack has a
  "modifier row" pattern for exactly this kind of switch.

## Approaches Considered

### Feature 1 — PoSky tracking

#### 1a. Shipped dataset from eqlposky.com + new Quests window (chosen)
- **Description:** `scripts/fetch-posky.js` downloads eqlposky.com's `data.js` (and
  `item-details.js` for stats), parses `POSKY_DATA`, and emits a hand-reviewed
  `src/quests/posky.json`. A new pure-Node sibling module `src/quests/` builds an
  item→quest index and accumulates looted counts into a per-character store. A new
  fixed-pane **Quests window** (tray → Quests…) shows per-class tests with item
  checklists.
- **Pros:** Persistent ledger (what "track" means); the source is the one James vouches
  for and it already matches the live log's item names exactly; no wikitext parsing —
  the data is a ready JS object; the module follows the parser/session/triggers sibling
  pattern so it unit-tests in WSL; the window follows the History/Triggers three-pane
  model the project already trusts.
- **Cons:** Biggest build of the options; needs a Pencil mockup first; depends on a fan
  site staying up (mitigated: the transformed JSON is committed, the fetch script is
  only for refreshes).

#### 1b. Ship PoSky items as a trigger pack (alert chips on loot)
- **Description:** A shipped pack whose triggers match quest-item loot lines and fire
  alert chips; no new window.
- **Pros:** Zero new UI; reuses the whole trigger pipeline.
- **Cons:** Alerts are transient — "tracking" needs a ledger you can consult between
  sessions. No answer to "what do I still need and who drops it". Rejected as the main
  vehicle (a loot chip survives as a small add-on in 1a).

#### 1c. Annotate the Session window's loot pane with quest badges
- **Description:** Mark quest items in the existing per-session loot list.
- **Cons:** Sessions are per-night; quest progress is cumulative across weeks. Wrong
  scope, answers "what dropped tonight" not "what do I still need". Rejected.

#### 1d. Scrape eqlwiki.com (or copy everquest-companion's posky.json)
- **Cons:** The wiki's Sky data is wrong for Legends (James; confirmed by the
  Mask/Mantle mismatch against the live log), and everquest-companion's JSON is
  FSL-licensed against competing use. Both rejected.

### Feature 2 — charm-break sound

#### 2a. Builtin-pack row + config keys + distinct synthesized cue (chosen)
- **Description:** Parser surfaces the charm-break it already detects; main.js raises a
  warning chip gated by a new `charmBreakAlerts` key (builtin-pack row, default on);
  a sibling sound-modifier row `charmBreakSound` (default off, opt-in like
  `castAlertSound`) makes `alerts.js` play a *descending* two-note cue — audibly
  distinct from the rising cast cue.
- **Pros:** Exactly the existing architecture — the Triggers window stays the single
  answer to "what may put something on my screen"; no media assets; testable in WSL.
- **Cons:** None significant.

#### 2b. Add sound actions to the trigger engine, ship charm break as a trigger
- **Description:** Generalize: GINA packs carry sound refs we currently ignore; implement
  sound playback for triggers and express charm break as a shipped trigger.
- **Pros:** Unlocks sounds for every imported pack.
- **Cons:** Much bigger scope (media file handling, per-pack sound policy, mute
  semantics); charm break is a *parser* judgement (`uncharm()` returning true), not a
  regex a pack could express — a trigger would re-derive it worse. Deferred; worth its
  own plan if pack sounds are ever wanted.

#### 2c. Hardcoded beep in main.js on worn-off
- **Cons:** Invisible to the Triggers window, violating "the single place that answers
  what may put something on my screen"; a beep with no chip is "a noise with no
  explanation". Rejected.

## Chosen Approach

**1a + 2a.** A new pure-Node `src/quests/` sibling (data + index + progress), fed by
main.js like its siblings; a committed `posky.json` transformed from eqlposky.com's
`data.js` and validated against the live log; a fixed-pane Quests window on the History
model (Pencil mockup first, per convention); charm break wired through the existing
builtin-pack/alerts/sound machinery with a distinct descending cue.

Honesty rule applied to quest progress: the store counts what the log shows was
*looted*. It cannot know inventory (items looted before logging began, traded, or
turned in), so each quest also carries a `done` flag and each item an `owned` flag,
set manually or by importing an eqlposky.com progress export — never guessed. An
import is a dated snapshot: it sets flags as of its `exportedAt` and the live log
keeps counting past it. Backfill from the full log is a script run, mirroring
`backfill-history.js`.

## Tasks

### Data
- [x] Write `scripts/fetch-posky.js` (pure Node, no deps): download
      `https://www.eqlposky.com/data.js` and `item-details.js`, evaluate/parse
      `POSKY_DATA` + `POSKY_ITEM_DETAILS`, and transform into our quest shape (class,
      quest npc, reward + stats, items with name/source, rune per quest). Never writes
      without `--write`; prints a diff against the committed file so a refresh shows
      what changed upstream.
- [x] Run it, review, commit as `src/quests/posky.json` with a header attributing
      eqlposky.com (and its stated upstream, EQProgression) and the fetch date. The
      transform MUST preserve the site's class ids ("bard", "shadowknight", …) and its
      quest/item array ordering — the site's progress-export keys are positional
      (`bard:0:0` = class : quest index : item index) and imports resolve through them.
- [x] Re-run the log cross-check as part of review (already done once in research: 94 of
      134 distinct Sky-looted names matched exactly, all 15 runes present): every data
      name the log has looted must survive the index's normalization; investigate any
      near-miss (spelling, articles, latin1) before shipping.

### Loot rules
- [x] Broaden the session `loot` rule family in `src/session/rules.js` to all four
      confirmed wordings (kept/stored/created/sold) plus the `You looted 2 X` quantity
      form, each emitting `kind: 'loot'` with a `disposition` field. The stored form
      captures its container generically (`Dragon Hoard` and `currency` are both live);
      keep the sold wording's coin out of the coin category for now (see Notes).
- [x] Tests in `tests/session-rules.test.js` (or wherever the session rule tests live)
      for every wording, including backtick mob names and a latin1 accented item.

### Quest module (pure Node, WSL-testable)
- [x] `src/quests/index.js`: load `posky.json`, build a normalized item-name → quests
      index (reusing `itemKey`/`stripArticle` normalization, **plus stripping the
      Legends upgrade suffix ` +N`** — the log loots "Bracelet of Exertion +1", the
      data names the base item), expose `lookup(itemName)` and per-class quest listings.
- [x] `src/quests/progress.js`: accumulate loot events into per-item looted counts,
      kept per disposition (bags vs stored-to-currency — runes arrive both ways and
      both count toward totals), + per-item `owned` flags and per-quest `done` flags
      (settable manually or by import, alongside the log-derived counts); plain JSON store at
      `<userData>/quests/<Char>_<server>.json`, directory injected for tests, write
      failures toast (history-store policy: a full disk must not take the overlay down).
- [x] main.js wiring: feed loot events to the quest tracker. Session category switches
      must not starve it — evaluate the loot rules for the quest tracker even when the
      session `loot` category is off.
- [x] `scripts/backfill-quests.js`: replay a full log into the progress store
      (dedup-safe, `--dry-run`), so day one shows everything the log already knows.
- [x] Unit tests: index lookup normalization, progress accumulation, store round-trip
      against a temp dir.

### Quests window
- [x] Pencil mockup of the Quests window and get James's approval **before** building:
      three fixed panes on the History model — rail = quests grouped by class (logging
      character's class pinned first), middle = selected quest (the class's quest NPC,
      its rune, reward + stats, manual done toggle), detail = item checklist (needed
      count, looted count, drop source per the data's island/boss strings, rune row
      rendered as zone-wide). Parchment palette. No reflow: panes swap content on the
      same pixels.
- [x] Build `src/renderer/quests/` with the pure half in `organize.js` (grouping,
      progress math, formatters) unit-tested in WSL; tray entry "Quests…", own
      `questsBounds` key; scrolls internally (it is a real-input window, not HUD).
- [x] eqlposky.com progress import: a button in the Quests window (real-input window,
      file picker) reading the site's export (`posky-progress*.json`, schema v1:
      `looted` keyed `class:questIdx:itemIdx`, `turnedIn` keyed `class:questIdx`,
      `currencyOwned` keyed by lowercased rune name, `inventoryCounts` keyed by
      lowercased item name). Import maps `turnedIn` → quest `done`, `looted` +
      `currencyOwned` → item `owned`; it only ever SETS flags, never clears, and
      re-import is idempotent. Record and display the export's `exportedAt` ("imported
      from eqlposky export of Aug 14") — an export is a snapshot and may lag reality
      (James's current one predates his latest inventory dump), so live log counts keep
      running past it and manual toggles stay editable. Skip `inventoryCounts` (the
      stalest part, derived from whatever dump the site last saw). James's real export
      (`/mnt/c/Users/james/Downloads/posky-progress(6).json`) is the test fixture.
- [x] Small add-on: a builtin-pack row (`questLootAlerts`, default on) that raises an
      alert chip when a looted item matches a quest item — "Light Woolen Mask — Bard
      Test of Tone".

### Charm break
- [x] Parser: at the `worn-off` handler (`src/parser/index.js:1566`), when `uncharm()`
      returns true, surface a typed charm-break signal (annotate the event or emit a
      distinct kind) — only there, not on the charmed-mob-dies uncharm paths and not on
      the inferred end of *other* people's charms.
- [x] main.js: raise an alerts-window warning from that signal, gated by new config key
      `charmBreakAlerts` (default **on** — a freed mob attacking you is tier-3 class
      information).
- [x] `src/main/builtin-pack.js`: a "Charm break" rule row backed by `charmBreakAlerts`
      and a sound-modifier row backed by `charmBreakSound` (default **off** — sound is
      opt-in, always), following the `castAlertSound` row pattern.
- [x] `src/renderer/alerts/alerts.js`: a second synthesized cue — two *descending*
      notes so it cannot be mistaken for the rising cast cue — played on a NEW
      charm-break warning only when the chip is drawn and `charmBreakSound` is on.
- [x] Parser test: charm then worn-off emits the signal; a plain DoT worn-off does not;
      pet-death uncharm does not.

### Wrap-up
- [x] `npm test` green; `node scripts/collect-unknown.js` against the live log to
      confirm the new loot rules eat the previously-unmatched wordings.
- [x] `docs/changelog/2026-08-XX-posky-quests-and-charm-break-sound.md`; archive this
      plan. No version bump unless James asks.
- [x] `scripts/dev.sh pack` after the build so the win-unpacked copy James launches
      actually contains it (kill → pack → relaunch, all three steps).

## Notes

### Execution notes (2026-08-14)

- **Mockup format**: built as `docs/design/2026-08-14-quests-window-mockups.html`, the
  format every shipped mockup in that directory actually uses (the lone `.pen` file
  there is an empty stub). Approved by James with one addition: the loot chip must fire
  only for an item he still *needs* — implemented as `QuestProgress.needed()`, filtering
  the chip (never the ledger) to slots whose quest is not done and item not owned.
- **Turn-ins ARE logged after all**: `You offered 1 Crude Wooden Flute to Cilin
  Spellsinger.` — 171 such lines in the live log, quantity and target NPC included
  (`You offered 816 Phosphorous Powder to Zok Zribb.`, `You offered 1,000 Platinum to
  Foalya.` — note the comma). The plan's "zero You give lines" finding was true of that
  wording only. Auto-marking `done` from offers stays out of scope exactly as planned
  (an offer to the right NPC is one item of several, and coin/vendor offers share the
  wording), but the follow-up is now concrete: its own plan, its own rules.
- **collect-unknown scope**: that script covers the PARSER table only; the new loot
  wordings live in the SESSION table. Verified instead by replaying every loot-shaped
  line in the live log through `matchSessionRule`: 6,536 lines, 0 unmatched.
- **Charm-break placement**: raised in the parser (riding `hostileCasts` exactly as
  summons do, `category: 'charm-break'`, per-entry TTL) rather than in main.js as 2a
  sketched — the summon precedent made that strictly less machinery, and it keeps the
  signal WSL-testable. main.js raises only the quest-loot chips.
- **Log cross-check re-run**: 105 of 974 distinct looted names hit the index (up from
  the research's 94 — the ` +N` strip folds upgrade-suffixed loots in), all 15 runes
  present. One near-miss investigated and benign: "Silver Ring" (vendor trash, necro
  acolytes) vs "Silvery Ring" (the Sky quest item, Keeper of Souls) are different items
  and both resolve correctly.

- **License/attribution**: everquest-companion is FSL-1.1-MIT (non-compete) — nothing
  from that repo is copied, not data, not code. eqlposky.com is a fan site with no
  stated license serving its data as an open static file; James directed its use.
  Attribute both eqlposky.com and its stated upstream (EQProgression) in `posky.json`,
  and don't hotlink their P99 icon URLs — if the Quests window wants item stats, carry
  the text stats in our JSON; icons are out of scope.
- **Charm-break wording risk**: only the "worn off of <target>" form is confirmed. If
  EQ Legends has a targetless variant ("Your charm spell has worn off.") or a dire-charm
  wording, `collect-unknown.js` on a charm-heavy session will expose it.
- **Turn-in detection**: checked — the log contains zero "You give …" lines across the
  whole file, so turn-ins are not logged under that wording and auto-decrement is off
  the table for now. The manual done toggle covers it honestly. (If a Sky turn-in turns
  out to log under some other wording, `collect-unknown.js` on a turn-in session will
  surface it.)
- **Side finding, out of scope here**: the auto-sell loot wording ("…and sold it for 3
  platinum…") carries coin that the session `coin` category currently never counts — its
  `coin-sale` rule only matches the merchant-window wording. Worth its own small fix.
- **Rune prominence**: runes drop from *any* Sky mob (per the data and general-chat
  evidence), so the checklist should render the rune row distinctly rather than under a
  single mob's name.
- **Rune model — settled**: all 15 runes (Azia…Ozah) are confirmed in both the data and
  the log, each quest names one *specific* rune (Bard's flute quest wants Wind Rune
  Azia), and they drop zone-wide from ordinary mobs and nameds alike. **A rune arrives
  two ways and both count** (James): looted to bags (`--You have looted a Wind Rune
  Neza…--`) or auto-stored to currency (`…and stored it in your currency`) — both are
  live in the log. Per-rune totals sum both dispositions; since each loot event carries
  its `disposition`, the rune row can also show the split ("2 in bags · 5 in currency").
  The rune row renders as "random zone-wide drop" rather than under a mob.
  eqlposky.com has a dedicated "Wind Runes helper" for the same reason.
- **Two imports, one in scope**: the eqlposky *progress export* import (in scope, task
  above) carries the site's checkmarks — including 49 turn-ins the log can never know.
  A direct `/outputfile inventory` *dump* import (the site's other mechanic: complete =
  finished reward actually in bags/bank, held pieces = "ready", Hoard included only
  while its window is open) stays a stretch for a later iteration — it would make owned
  state exact without going through the website at all.
- Deliberately NOT doing: voice packs / TTS (everquest-companion ships ~350; this app
  ships no media assets and synthesizes its two cues), and trigger-engine sound actions
  (approach 2b — its own plan if ever wanted).
