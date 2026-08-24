# The drops popup speaks on the mobs you farm, and leads with the drop

**Date:** 2026-08-24

Two defects reported against the popup that shipped this morning (`2fbc80e`), both
reproduced against the live session rather than reasoned about: it stayed silent on the
mobs actually being farmed, and when it did speak the mob name was the headline and the
drop was small print.

---

## Why it was silent, and why the learned index could never fix it

The popup shipped with two matching halves: the dataset's named source chips, and a drop
index learned from the character's own loot lines. The learned half worked — 37 mobs, 267
pairs for Rhale — and contributed **zero rows**. That is not bad luck. It is structural:

> You only learn that a mob drops X by looting X. The popup exists to tell you about the
> X you have **not** looted. The index is blind by construction to exactly the items the
> popup is for.

Measured on the live ledger: 0 of Rhale's 16 outstanding items had a learned source, and
all 267 learned pairs resolved to items already owned. The index can only ever help for a
second copy of something already looted, or for a need reopened by a hand-in.

Meanwhile six of the dataset's eighteen source strings describe a **family** rather than a
name — `Island 6: "bee" mobs`, `Island 6: Bazzt Zzzt "Bees"`, `Island 5: spiroc mobs`,
`Island 7: drake/sphinx/spirit mobs`, `Island 4: essence/soul mobs, Eternal Spirit`,
`Island 4: soul/essence griffons (maybe also Eternal Spirit)`. The log never writes those
words as a creature name, so the equality matcher could never fire on them and the items
behind them were invisible. The live case exactly: farming island-6 bees for the
`Adamantium Earring`, which the dataset sources to `Bazzt Zzzt "Bees"`, while `Bzzzt`,
`Bzzazzt`, `Bazzzazzt` and `Bizazzzt` matched nothing at all.

**The learned index is kept and demoted, not removed.** It costs nothing, every entry is
something the character watched happen, and it still catches the second-copy case. It
just stops being the only answer to a question it cannot answer. Do not rebuild it as the
primary one — the sentence above is why the previous plan measured well and shipped
nothing.

## The measured alternative was built first, and failed on its own numbers

Before writing any table, the tempting composition was tried: compose the learned index
with the dataset — "Bzzzt dropped `Bixie Essence`, whose source is `"bee" mobs`, therefore
Bzzzt is a bee, therefore Bzzzt can drop anything else that chip sources." A measured
inference, not a guess. It fails twice:

- **It misses the live case.** The earring hangs off `Bazzt Zzzt "Bees"`, a second and
  differently-spelled bee blob. Deriving `"bee" mobs` membership says nothing about it
  unless you also decide those two strings mean the same family — text interpretation.
- **It over-generalises through multi-source items.** `Efreeti Statuette` is sourced to
  both island-4 griffon blobs and actually drops off three efreeti bosses, so it tags
  Noble Dojorn, Overseer of Air and the Hand of Veeshan as island-4 griffons.

## What shipped instead: six member lists, established from the log's own kill order

`src/quests/families.json` — the six blob source strings mapped to their member mobs,
each member saying how it was established.

This overturns, deliberately and in writing, the previous plan's rejection of a shipped
table on the grounds CLAUDE.md gives for a shipped spell-duration table. **That argument
does not transfer.** A buff's duration varies per player — level, spell rank, purchased
AAs — which is exactly why `mine-buffs.js` measures it. *Which mobs are the bees on island
6* varies for nobody. The precedent that fits is `src/triggers/seed-pack.js`: sixteen boss
timers measured off a real server, reviewed by hand, shipped — and replacing a live
estimator that was worse for being learned.

**The islands were derived, not read off a wiki.** Plane of Sky is climbed one island at a
time, so the log's own kill order is the island map. Across 854 Sky kills in 28 sessions of
`eqlog_Rhale_oggok.txt`, every session shows the same ladder: `blade storm` before Noble
Dojorn (1.5), `azarack` before Protector of Sky (2), the harpies and gazers before
Gorgalosk (3), the essence/soul mobs around Keeper of Souls and Overseer of Air (4), the
spirocs around The Spiroc Lord (5), the bees around Bazzt Zzzt (6), the sphinxes, drakes
and undine spirits around Sister of the Spire (7), then the two Veeshan bosses (8). Every
member listed is a mob killed on its family's island, or a name the dataset's own source
string writes verbatim (`Eternal Spirit`, which this log has never seen — unverified, not
wrong, and the audit script says so).

Two hand judgements worth recording. `Bazzt Zzzt` is a member of `Bazzt Zzzt "Bees"`
because the string names him, and deliberately **not** of `"bee" mobs`: the log has him
dropping thirteen other quest items and never a `Bixie Essence`, while two of his bees do
drop it. And `thunder spirit` / `thunder spirit princess` are **not** island-7 spirits —
they are Agnarr's island above it, and the kill order never puts them on 7.

**The fails-silently objection is answered by construction.** `scripts/mine-families.js`
replays a log against the table and prints what no chip and no family claims. On the live
log that list is eleven mobs, all on islands 1, 2, 3 and 9 — islands the dataset writes no
family string for at all. If the popup is ever quiet about something you farm, its name is
in that list.

## The display: the drop is the headline now

The panel was answering *which corpse* in bold uppercase full-ink and *what* in body text
underneath — the loudest thing on screen was the one word you can already read off your own
target window. Approved 1:1 against a rendered mock at `scale: 1.25` before any CSS moved.

- The mob line becomes a caption: `0.82em`, weight 600, `--ink-dim`, letter-spaced.
  13.3px at the scale it is read at — above the 12px floor, checked rather than assumed.
- The item name becomes the loud line: `1.05em`, weight 600, `--ink`. Runes keep gold.
- `.iname` gets `flex: 0 1 auto; min-width: 0` — shrinkable, never growing. Growing it
  would shove the qualifier out to sit against the class chips, and `min-width: 0` is what
  makes the name's own ellipsis absorb a squeeze instead of the class flags being crushed.
  That last one is the failure the item-led-single-line layout would have shipped.

Grouping, row heights and geometry are untouched. This is a type change and nothing else,
which is why it cannot reflow anything.

**Two things James asked for during review, both of which changed the data model:**

- **`seen N×` is gone entirely**, not restyled. It was the one number on a panel whose
  whole subject is what is MISSING, and beside a still-needed item it reads as four
  already in the bag. `itemRow` no longer produces it and nothing renders it.
- **A qualifier names the BOSS, never the blob.** The row that would have read
  `Adamantium Earring · from "bee" mobs` reads `Adamantium Earring · Bazzt Zzzt`. Blob
  prose names nothing a player can go and kill. Each family carries a hand-reviewed
  `boss`; a learned row takes the item's sole named chip, and stays silent when the
  dataset names none or several — `Efreeti Standard` comes off three bosses, and printing
  one of the three would be a guess in a slot read as a fact.

## Changes

### Features
- **`src/quests/families.json`** (new) — the six family source strings mapped to member
  mobs, 36 members across six families, each with `how: log | hand` and each family with
  its island's boss. Carries its own attribution block: what, why, how the islands were
  established, and why it is not part of `posky.json`.
- **`scripts/mine-families.js`** (new) — replays a log against the table and prints three
  sections: every Sky mob no chip and no family claims (the audit that stops a member
  table failing silently), per-family drop evidence, and what the table asserts checked
  against what the log has seen. Print-only by default; `--write` folds candidates in as
  `how: "log"` members.
- **`src/quests/index.js`** — `FAMILIES`, loaded beside `posky.json` on the
  `effects.json` / `effects-legends.json` precedent, so a `fetch-posky.js` refresh can
  never clobber a hand-reviewed supplement. Absent or malformed reads as empty.
- **`src/quests/progress.js`** — carries `families` on `snapshot()` beside `drops`, so
  `needs.js` (imported by a renderer) stays free of `fs`.
- **`src/quests/needs.js`** — `dropGroups` unions a third source. A blob chip that still
  owes something yields one group per member mob; named chips and the learned index are
  unchanged, and whoever gets to a row first keeps it.

### Bug fixes
- The popup fires on family mobs. `Bzzzt` now shows the `Adamantium Earring`; `Bazzt
  Zzzt` shows `Fine Wool Cloak` (named chip) and the earring (family) as **one** group,
  not two.
- The drop is the headline and the mob is its caption.

### Refactoring
- **`mobNeeds()` deleted**, with its test. It had no caller outside its own tests; no
  surface asks "what does this one named corpse owe", because the popup asks it per pull
  through `engagedNeeds`. A dead export that looks live is worse than either.
- `itemRow`'s `seen` replaced by `boss`.

### Notes on things deliberately NOT done
- **No Quests-window surface for the families.** The audit surface is the mining script.
  A member list is a fact about the zone — the same shape of thing `seed-pack.js` keeps
  in a file rather than in a pane. The `FAMILIES` doc comment says so explicitly, so the
  omission does not read as an oversight.
- **`--write` is screened, and had to be.** Folding "dropped it → member of it" in
  unscreened reproduces the exact over-generalisation above. The script writes only
  SOLE-source evidence — a drop of an item exactly one chip sources — and reports the
  rest for a human. On the live log that screen holds back four candidates (three efreeti
  bosses on the griffon families, The Spiroc Lord on `spiroc mobs`) and admits four.
- **The popup's placement.** `dropsBounds` is `1800,1349 401×64` on a work area ending at
  y=1392, so the panel's bottom 21px sit under the taskbar. Main does not move windows
  the player placed and should not start. If it keeps happening the lever is clamping the
  *anchor* to the work area inside `applyPanelFit` — pure, testable, and it would apply
  to the alerts stack too.
- **A correction to the plan's own findings:** `alsoFrom` is not rendered by nothing. The
  Quests window's by-boss rail draws it (`src/renderer/quests/quests.js:248`). It is the
  popup that ignores it, and it is left exactly as it was.

### Files modified
| File | What |
|---|---|
| `src/quests/families.json` | **new** — the six member lists, with provenance per member |
| `scripts/mine-families.js` | **new** — seeds the table and audits it against a log |
| `src/quests/index.js` | `FAMILIES` loader, and the long note on why a shipped table is right here |
| `src/quests/progress.js` | `families` on the snapshot |
| `src/quests/needs.js` | family half in `dropGroups`; `boss` replaces `seen`; `mobNeeds` removed |
| `src/renderer/drops/drops.css` | the inverted hierarchy; `.seen` → `.from` |
| `src/renderer/drops/drops.js` | renders `boss`, no longer renders a drop count |
| `tests/quests-needs.test.js` | +9 cases for the family half and the shipped table |

## Verification

- `npm test` — 966 pass, 0 fail.
- Nine new cases: a family member fires for an item nothing has looted; a named mob shows
  dataset rows and family rows as one group; a family never duplicates a row the dataset
  placed; a mob in no family fires nothing; a family and the learned index agree rather
  than opening two groups; `anyMob: false` still reproduces named-boss-only exactly; a
  missing/empty/malformed family list is silence, never a crash. Two of them are property
  tests over the shipped data: the six entries cover exactly the six blobs the dataset
  writes, and no family names a mob the *same source string* already names on its own.
- **Against James's real ledger, inside the packed build.** `scripts/dev.sh pack`, then
  the shipped `needs.js` run from inside the packed Quests renderer over
  `--remote-debugging-port=9223`: `engagedNeeds(groups, ['Bzzzt'])` returns
  `ISL 6 Bzzzt → Adamantium Earring (boss: Bazzt Zzzt)` with no `seen` field, and
  `The Spiroc Lord` returns its four unqualified dataset rows. The six families arrive
  over IPC in the packed build, so the file is in the asar and the whole chain holds.
- The packed drops window's computed styles: `.iname` 17.06px/600 `--ink`, `.bmob`
  13.33px/600 `--ink-dim` — the approved mock, in the real Electron shell.
- The real `drops.js` and `drops.css` were rendered headlessly against a payload built
  from the live ledger, to see the paint itself.
- **The real fight, replayed through main's own tick.** The island-6 pull of
  13:16–13:18 today — `Bzzazzt`, `Bazzzazzt`, `Bzzzt`, then `Bazzt Zzzt` — fed line by
  line through `LogParser` and the exact `pushDrops` sequence (`dropGroups` →
  `engagedNeeds` → `nextDropsState` → `dropsDisplay`), against the live ledger, with the
  log's own clock driving the 90s linger. The defect and the fix, measured on the same
  87 seconds:

  | | 13:16:23 first bee | 13:17:50 boss joins | 13:18:38 kill |
  |---|---|---|---|
  | **Before** | *nothing* | `Fine Wool Cloak` | linger, cloak only |
  | **After** | `Adamantium Earring · Bazzt Zzzt` | one group: cloak **and** earring | linger, both |

  So the old build was silent for the entire bee phase and then showed the boss one
  item, never the earring the group was there for. The new one opens the earring row on
  the first bee, accumulates a group per bee as the adds join, merges Bazzt Zzzt's
  dataset row and his family row into one group rather than two, lingers 90s past the
  kill, and empties before Sister of the Spire's own rows arrive at 13:20:11 — whose
  three dataset rows are unchanged and carry no qualifier, as they should.

- **A consequence worth knowing.** On a bee pull every engaged bee is its own group and
  every one of them owes the same earring, so at 13:17:50 the panel is four groups and
  five rows, four of which read `Adamantium Earring`. That is honest — each corpse
  genuinely owes it — and it is what "what does THIS corpse owe" means when four corpses
  owe the same thing. It also makes the panel ~228px tall where it used to be 64. If it
  reads as noise in play, the fix is to fold identical rows across groups in
  `dropsDisplay`, which is pure and testable; it was not done here because the grouping
  is what James approved and folding it changes the question the panel answers.
