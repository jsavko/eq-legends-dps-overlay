---
status: completed
---
# The drops popup is silent on the mobs you farm, and mob-led when it does speak

**Date:** 2026-08-24

---

## Goal

Two defects reported against the popup that shipped this morning (`2fbc80e`), both
reproduced against the live session rather than reasoned about:

1. **It stays silent on the mobs actually being farmed.** It fires for eleven named
   dataset bosses and nothing else. The six *family* source strings — `"bee" mobs`,
   `Bazzt Zzzt "Bees"`, `spiroc mobs`, `drake/sphinx/spirit mobs`,
   `essence/soul mobs, Eternal Spirit`, `soul/essence griffons (maybe also Eternal
   Spirit)` — are still unmatchable, which is exactly what the last plan set out to
   fix and did not.
2. **When it does speak, the mob name is the headline and the drop is small print.**
   The question being asked is *what do I need off this corpse*; the panel answers
   *which corpse* in bold uppercase and *what* in body text underneath.

A third thing to correct in the record: the popup is **not** broken, not parked, and
not lost. That was my first hypothesis and it is wrong — see Findings.

## Findings — measured 2026-08-24 against the running build and the live log

**The window works.** Polling `GetWindowRect` on the live `EQL Needed Drops` window
through a real pull: parked at `-32000,-32000` while nothing was owed, and at
**13:17:50 it came back on screen at `1800,1349 401×64`** and stayed there through
13:19:26 — the Bazzt Zzzt fight, which owes `Fine Wool Cloak`. The park/return path,
the `PANEL_FIT` plumbing and the anchor arithmetic are all fine. Nothing in this plan
should touch them.

**Two things make it read as "not coming up".** It is a 401×64 sliver — three stacked
lines — in the bottom-right corner, and the anchor the window was dragged to puts its
bottom edge at y=1413 on a work area that ends at **1392**, so its last 21px sit under
the taskbar. And it is silent for most of a session.

**Why it is silent, and why the learned index cannot fix it.** The 2026-08-24 approach
was "record the corpse name off every loot line, match on that". It works, it has
learned 37 mobs / 267 pairs for Rhale — and it contributes **zero rows today**, which
is not bad luck. It is structural:

> You only learn that a mob drops X by looting X. The popup exists to tell you about
> the X you have **not** looted. The index is blind by construction to exactly the
> items the popup is for.

It can only ever help for a second copy of something already looted, or for a need
reopened by a hand-in. Measured: **0 of Rhale's 16 outstanding items has a learned
source**, and every one of the 267 learned pairs resolves to an item already owned.

**The live case, exactly.** They are on island 6 killing bees for the `Adamantium
Earring`. The dataset sources it `Island 6: Bazzt Zzzt "Bees"`. `Bzzzt`, `Bzzazzt` and
`Bazzzazzt` are bees and match nothing; `Bazzt Zzzt` matches the *other* island-6 chip
and so shows `Fine Wool Cloak` while the earring — the reason they are there — stays
hidden behind a chip whose text starts with the mob's own name.

**Deriving membership from the learned index does not rescue it either.** The tempting
composition is "Bzzzt dropped Bixie Essence, whose source is `"bee" mobs`, therefore
Bzzzt is a bee, therefore Bzzzt can drop anything else sourced to `"bee" mobs`" — a
measured inference, not a guess. Built and measured, it fails twice:

- **It misses the live case.** The earring is sourced to `Bazzt Zzzt "Bees"`, a second
  and differently-spelled bee blob. Deriving `"bee" mobs` membership tells you nothing
  about it unless you also decide those two strings mean the same family — which is
  text interpretation, i.e. the guessing this project does not do.
- **It over-generalises through multi-source items.** `Efreeti Standard` is sourced
  `Noble Dojorn / Overseer of Air / the Hand of Veeshan`, so any mob that ever dropped
  one is tagged a member of all three chips. It tagged Eye of Veeshan as a Noble
  Dojorn, an Overseer of Air *and* a Hand of Veeshan.

**The blob problem is small and finite.** 18 distinct source strings in the whole
dataset → 18 chips: 11 name a mob the log writes, 1 is the zone-wide rune bucket
(95 items), and **6 are families, between them sourcing 8 items**. Of Rhale's 16
outstanding items exactly **one** is blob-sourced. So this is not a sweeping data
problem — it is six strings, and a member list for them is small enough to read in one
sitting.

**Loose ends found on the way.** `mobNeeds()` in `src/quests/needs.js` has no caller
anywhere outside its tests — the last plan built it and never wired it. `itemRow`'s
`alsoFrom` is computed on every row and rendered by nothing.

## Approaches Considered — the matching half

### 1. Ship hand-verified family member lists, as visible, editable data
- **Description:** A `families` map committed beside `posky.json`: blob source string →
  the mob names that are members, seeded by mining the live log for which mobs have
  dropped blob-sourced items and completed by hand. Surfaced in the Quests window so
  it can be read and corrected; a mob in the player's log that no family claims is
  *reported*, never silently ignored.
- **Pros:** Fixes the live case and the other five blobs on day one, for a fresh
  character with no history. Small and finite — six families, ~40 names. Follows the
  precedent this project actually set: `seed-pack.js` ships sixteen boss timers
  *measured off a real server and reviewed by hand*, and replaced a live estimator
  that was worse for being "learned". Being visible and editable is what answers the
  "fails silently" objection that killed this option last time.
- **Cons:** It is a shipped table of facts, which the 2026-08-24 plan rejected by name
  citing the spell-duration argument. That argument does not transfer cleanly —
  a buff's duration varies per player (level, spell rank, AAs) and *which mobs are bees
  on island 6* does not vary at all — but the objection is on the record and this plan
  is overturning it, which should be deliberate rather than quiet. Needs maintenance if
  Legends adds mobs.

### 2. Derive family membership from the learned drop index
- **Description:** Compose the learned `mob → item` index with the dataset's
  `item → source chip` to get `mob → chip`, then let a mob fire for anything else that
  chip sources.
- **Pros:** No shipped table. Every membership is something the character watched
  happen. Reuses data already stored.
- **Cons:** **Measured and it does not work** — misses the one live case (two spellings
  of the bee family), and over-generalises through multi-source items (see Findings).
  Fixable only by also deciding which blob strings mean the same thing, which is the
  guessing being avoided. Still needs a loot before it knows anything.

### 3. Substring / family-word matching on the blob text
- **Description:** `a spiroc vanquisher` contains `spiroc` → member of `spiroc mobs`.
- **Pros:** No data, a dozen lines.
- **Cons:** Rejected twice already and demonstrably wrong here: `Bzzazzt` is a bee and
  contains no `bee`; `a blade storm` is a spirit and contains no `spirit`. It would
  miss real members and invent false ones with no way to tell which — the exact shape
  of the bug that made `looksLikeMobName` a one-way answer.

### 4. Widen to the ISLAND — show what the island owes while you are on it
- **Description:** Stop asking "what does this corpse owe" and ask "what does this
  island owe", deriving the island from mobs already proved to be on it.
- **Pros:** No member lists. Answers the farming question directly.
- **Cons:** Abandons the question the popup was built to answer one plan ago, and the
  island is not in the log — it would be derived from the same learned index, which
  over-generalises through multi-source items exactly as in 2 (`Efreeti Standard` spans
  islands 1.5, 4 and 8). Also loses the "is THIS corpse worth looting" precision that
  makes the popup better than the Quests window.

### 5. Nothing — accept named bosses only, fix the display half alone
- **Description:** The popup is honest and correct as built; the six blobs stay dead.
- **Pros:** Zero risk, zero new data.
- **Cons:** It leaves the reported defect unfixed. The player is farming bees for an
  earring the app knows they need and knows comes from bees, and says nothing.

## Approaches Considered — the display half

### A. Invert the type weight, keep the grouping
- **Description:** The mob line becomes a small, faint caption above its items; the
  item name becomes the loud line — larger and bolder than anything else in the row.
  One row per item still, same fixed row heights, same order.
- **Pros:** Answers the complaint exactly, changes no geometry, cannot reflow, and
  keeps the mob visible (you still need to know which corpse). Smallest diff.
- **Cons:** None found; the caption must stay above the 12px floor
  (0.82em × 1.25 scale = 13.3px — fine).

### B. Item-led rows with the mob as a sub-line per item
- **Description:** Drop the group header; every row is `Item name` with
  `Gorgalosk · ISL 3 · engaged` underneath it.
- **Pros:** Maximum emphasis on the drop; reads correctly with several mobs engaged.
- **Cons:** Doubles row height and repeats the mob on every row — on the common
  single-boss pull it is the same word four times in a four-item list.

### C. Item-led, mob folded into the right-hand end of the row
- **Description:** One line per item: item name left, class flags and mob right.
- **Pros:** Most compact.
- **Cons:** Puts three competing things in one flex row; `.who` is `flex: none`, so a
  long mob name plus class chips squeezes the item name into an ellipsis — reintroducing
  the reported symptom by another route.

## Chosen Approach

**Matching: approach 1.** Ship the six family member lists as reviewable data, and
overturn the last plan's rejection explicitly and in writing rather than by omission.
The reasoning that stands it up:

- The thing being tabled is not player-dependent. A spell's duration varies by level,
  rank and AA — that is why `mine-buffs.js` measures instead. *Which mobs are the bees
  on island 6* is a fact about the zone, identical for every character on the server.
- The project already ships hand-reviewed tables when live measurement cannot answer:
  `seed-pack.js` is sixteen boss timers measured off a real server, reviewed by hand,
  and shipped — and it *replaced* the learned estimator.
- The "fails silently" objection is answered by construction, not by promise: the map
  is visible in the Quests window, every entry says where it came from, and mining the
  player's own log reports any mob it does not account for. A wrong entry is a thing
  you can see and edit, which is what the objection asked for.
- Measurement is kept where measurement works. The learned index is **not** removed —
  it costs nothing, it is honest, and it catches the second-copy case. It just stops
  being the only answer to a question it cannot answer.

`Bazzt Zzzt "Bees"` gets the named mob **and** its bees, which is what the string says.

**Display: approach A.** Invert the weight, keep everything else. A Pencil mock goes to
James before any CSS changes, per the project's own convention.

**Not in scope, deliberately:** the popup's placement. Its anchor puts 21px of the panel
under the taskbar, but the player dragged it there and main does not move windows the
player placed. It is called out in Notes so the choice is theirs.

## Tasks

- [x] `src/quests/families.json` (new, committed beside `posky.json`) — the six blob
      source strings mapped to member mob names, each entry carrying how it was
      established (`log` for a name the live log proved dropped a blob-sourced item,
      `hand` for one added by review). Seed it from the mining script below, then
      complete it by hand against the log's own Sky mob vocabulary.
- [x] `scripts/mine-families.js` (new) — replay a log and print, per blob chip, the
      mobs that have dropped an item that chip sources, plus **the mobs in the log that
      no family and no named chip accounts for**. Print-only by default, `--write` to
      fold into `families.json`, following `mine-drops.js` / `mine-rhythms.js`. The
      unaccounted-for list is the whole point: it is what stops the table failing
      silently.
- [x] `src/quests/index.js` — load `families.json` beside the dataset and expose it,
      the way `EFFECTS` is loaded and exposed. Absent or malformed reads as empty; a
      broken supplement must not take the ledger down.
- [x] `src/quests/progress.js` — carry the families through on `snapshot()`, alongside
      `drops`, so `needs.js` stays free of any `fs` import (it is loaded by a renderer).
- [x] `src/quests/needs.js` — `dropGroups` unions a **third** source: for each blob
      chip that still owes something, one group per member mob, items carrying
      `via: '<blob text>'` so a row can say which family statement placed it. Named
      chips and the learned index are unchanged. `Bazzt Zzzt "Bees"` also matches
      `Bazzt Zzzt` itself.
- [x] `tests/quests-needs.test.js` — `Bzzzt` fires for `Adamantium Earring` via the bee
      family; `Bazzt Zzzt` shows both `Fine Wool Cloak` (named chip) and the earring
      (family) as one group, not two; a mob in no family fires nothing; an owned item
      never appears; a family naming a mob the dataset already names does not duplicate
      the row; `anyMob: false` still reproduces named-boss-only exactly.
- [x] Pencil mock of the inverted row hierarchy at 1:1 for `scale: 1.25`, showing a
      one-item mob (Bazzt Zzzt) and a four-item mob (The Spiroc Lord), **approved by
      James before any CSS is written**.
- [x] `src/renderer/drops/drops.css` — the mob line becomes the caption
      (~0.82em, `--ink-dim`/`--ink-faint`, letter-spaced) and `.need .iname` becomes the
      loud line (~1.05em, 600 weight, `--ink`). Runes keep their gold accent. Give
      `.iname` `min-width: 0` and `flex: 1 1 auto` so it can never be crushed by the
      class chips — the failure mode approach C would have shipped.
- [x] `src/renderer/drops/drops.js` — render `via` as a faint qualifier on a family row
      (`from "bee" mobs`), the same exception-marking role `seen N×` plays for a learned
      row, so the panel never claims dataset-named authority for a family inference.
- [x] Quests window — a place to READ the families (and the learned drop index) so the
      table is inspectable rather than buried in the repo. Smallest thing that satisfies
      "never silently wrong"; if it wants more than a pane of text it gets its own mock.
- [x] `mobNeeds()` — wire it or delete it. It has no caller outside its own tests.
      Decide with James; a dead export that looks live is worse than either.
- [x] `npm test` (adds ~6 cases), then **kill the overlay → `scripts/dev.sh pack` →
      relaunch via `powershell.exe Start-Process`**. Three steps, not two.
- [x] Verify on the live session: **done, against the real fight.** James pointed out
      the log already had the pull — island 6 at 13:16–13:18 today. Replayed through
      `LogParser` and main's exact `pushDrops` sequence against the live ledger: the old
      build was silent for the whole 87-second bee phase and then showed Bazzt Zzzt one
      item; the new one opens `Adamantium Earring · Bazzt Zzzt` on the first bee at
      13:16:23 and merges the boss's dataset row with his family row into one group at
      13:17:50. Also verified in the packed build over `--remote-debugging-port=9223`
      (families arrive over IPC, the shipped matcher returns the earring, the drops
      window's computed styles are the approved mock's), and the paint itself by
      rendering the real `drops.js`/`drops.css` headlessly.

- [x] `docs/changelog/2026-08-24-drops-popup-silent-and-mob-led.md`, and archive this
      plan. The changelog must record *why the learned index was kept and demoted*, so
      nobody rebuilds it as the primary answer.

## Notes

**Decisions taken with James during execution (2026-08-24).**

- *The mock.* Pencil was not running, so the 1:1 mock was rendered from the real
  `drops.css` with the proposed rules layered over it — pixel-exact for what the
  renderer would actually draw, which is a stronger check than a redraw of it.
  Approach A was approved as shown, with two amendments below.
- *`seen N×` is gone entirely, not restyled.* James: "Don't need seen 4x times. We only
  want to see the items we still need." The count was the one number on a panel whose
  whole subject is what is MISSING, and beside a needed item it reads as four already
  in the bag. `itemRow` no longer produces it and nothing renders it.
- *A qualifier names the BOSS, never the blob.* James: "just the final boss name that
  drops the item." So the row that would have read `Adamantium Earring · from "bee"
  mobs` reads `Adamantium Earring · Bazzt Zzzt`. Each family in `families.json` carries
  a hand-reviewed `boss`; a learned row takes the item's sole named chip, and stays
  silent when the dataset names none or several (`Efreeti Standard` comes off three
  bosses — printing one would be a guess in a slot read as a fact).
- *No Quests-window surface for the families.* James chose "skip it". The audit surface
  is `scripts/mine-families.js`, which is what answers the fails-silently objection; a
  member list is a fact about the zone, the same shape of thing `seed-pack.js` keeps in
  a file rather than in a pane. The `FAMILIES` doc comment says so explicitly so nobody
  reads the omission as an oversight.
- *`mobNeeds()` deleted*, with its test. No surface asks "what does this one named
  corpse owe" — the popup asks it per pull through `engagedNeeds`.
- *Correction to this plan's own Findings:* `alsoFrom` is NOT rendered by nothing. The
  Quests window's by-boss rail draws it at `src/renderer/quests/quests.js:248`. It is
  the popup that ignores it, and it is left exactly as it was.

**Where the six member lists came from.** Not a wiki. Plane of Sky is climbed one island
at a time, so the log's own kill order is the island map: across 854 Sky kills in 28
sessions every session shows the same ladder — `blade storm` before Noble Dojorn, the
`azarack` before Protector of Sky, the harpies and gazers before Gorgalosk, the
essence/soul mobs around Keeper of Souls and Overseer of Air, the spirocs around The
Spiroc Lord, the bees around Bazzt Zzzt, the sphinxes/drakes/undine spirits around
Sister of the Spire, then the two Veeshan bosses. Every member is a mob killed on its
family's island, or a name the dataset's own source string writes verbatim.

**`--write` had to be screened.** Folding "dropped it → member of it" in unscreened
reproduces the exact over-generalisation this plan measured and rejected: `Efreeti
Statuette` is sourced to both island-4 griffon blobs and actually drops off three
efreeti bosses, so an unscreened write tags Noble Dojorn a griffon. `mine-families.js`
therefore writes only SOLE-source evidence — a drop of an item exactly one chip sources
— and reports the rest for a human. On the live log that screen holds back four
candidates and admits four, all correct.

**Correcting my own first reading, for the record.** I opened this believing the popup
was parked off-screen and never returning, and said so. It is not: it un-parked at
13:17:50 and drew for the whole Bazzt Zzzt pull. The park/return machinery, the anchor
arithmetic and the `PANEL_FIT` path are all sound and this plan touches none of them.

**The structural point worth keeping.** A drop index learned from your own loot cannot
answer "what does this corpse owe me", because owing means not-yet-looted. That single
sentence is why the last plan's chosen approach measured well and shipped nothing, and
it belongs in the changelog.

**Placement.** `dropsBounds` is `1800,1349 401×64` and the work area is 2560×1392, so
the panel's bottom 21px are under the taskbar. Main does not move windows the player
placed, and it should not start. If James wants it lifted, dragging it is the fix; if it
keeps happening, the lever is clamping the *anchor* to the work area inside
`applyPanelFit` — pure, testable, and it would apply to the alerts stack too.

**Open questions:**
- *How far does the family table go?* Six blobs is the dataset's whole family
  vocabulary, so the table is complete when those six are. Whether it should also list
  mobs for the eleven **named** chips (so a boss's placeholders or adds fire too) is a
  separate question and deliberately not answered here.
- *Runes.* `Random zone-wide drop` sources 95 items and stays excluded, as today. A
  family table changes nothing about that.
- *Where the families file lives.* Beside `posky.json` in `src/quests/`, not inside it —
  `scripts/fetch-posky.js` rewrites the dataset and must never be able to clobber a
  hand-reviewed supplement. Exactly the `effects.json` / `effects-legends.json` split
  that already exists for the same reason.
