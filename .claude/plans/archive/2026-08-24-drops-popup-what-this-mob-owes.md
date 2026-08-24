---
status: completed
---
# The drops popup answers "what does THIS corpse owe me"

**Date:** 2026-08-24

---

## Goal

The engaged-drops popup currently answers a narrower question than the one being
asked. It matches the fight's engaged NPC names against the **quest dataset's source
strings** by strict case-insensitive equality, so it can only ever fire on a mob whose
name eqlposky spelled exactly the way the log spells it. Everything else in the
dataset's source vocabulary is dead to it:

| Source string | Why it can never fire |
|---|---|
| `Island 6: "bee" mobs` | not a name the log writes |
| `Island 6: Bazzt Zzzt "Bees"` | log writes `Bazzt Zzzt` |
| `Island 7: drake/sphinx/spirit mobs` | a family, not a name |
| `Island 7: Sister of the Spire / drake/sphinx/spirit mobs` | second chip dead |
| `Island 4: essence/soul mobs, Eternal Spirit` | a family with a name buried in it |
| `Island 4: soul/essence griffons (maybe also Eternal Spirit)` | ditto, plus a hedge |
| `Random zone-wide drop` | excluded by design |

Six of the eighteen source strings in the dataset are unmatched forever, and the ones
that *do* match name only the island boss — so a spiroc trash mob that drops
`Spiroc Earth Totem` produces no popup at all, even though the corpse in front of the
player owes exactly that.

**What it should answer instead:** for whatever mob is engaged, every item still
outstanding in this character's ledger that *this mob can actually drop* — all sixteen
classes, still-needed only. And the behaviour needs its own switch.

The measurement that decides the approach: the log already carries the answer. EQ
prints the corpse's name on every loot line (`--You have looted a Spiroc Elder's Totem
from The Spiroc Lord's corpse.--`), the session rules already capture it as `from`, and
`QuestProgress#feed` currently **throws it away**. Mining the live 201 MB log for it
yields a real, per-mob loot table with no guessing anywhere in it:

```
8,282 corpse-loot lines · 433 of them quest items · 37 distinct mobs

18  Bazzt Zzzt          6  an essence tamer        3  a spiroc arbiter
17  The Spiroc Lord     6  a spiroc vanquisher     2  a spiroc walker
17  Sister of the Spire 6  Bzzazzt                 2  a soul harvester
17  Eye of Veeshan      6  a spiroc banisher       2  a watchful guard
16  Noble Dojorn        5  a blade storm           2  a crystaline cloud
16  Protector of Sky    5  a greater sphinx        2  a sprited harpie
14  Gorgalosk           5  an essence carrier      2  a spiroc caller
14  Overseer of Air     5  a soul carrier          1  Bizazzzt
12  Keeper of Souls     4  The Spiroc Guardian     1  an avenging gazer
 9  the Hand of Veeshan 3  a spiroc revolter       1  a fatestealer drake   …
```

Every family blob in the table above is present under the names the log actually
writes. Matching against *those* needs no heuristic at all — the names came from the
log, so equality is exact by construction.

## Approaches Considered

### 1. Ship a hand-authored blob → member table
- **Description:** A committed map: `"bee" mobs` → `[Bazzt Zzzt, Bazzzazzt, Bzzzt,
  Bzzazzt, Bizazzzt]`, `spiroc mobs` → the seven spiroc types, and so on. The
  2026-08-20 changelog explicitly parked this as the option ("a hand-verified member
  list could add them later").
- **Pros:** Works on a brand-new install with no history. No new state, no migration,
  no backfill. Small diff.
- **Cons:** It is a shipped table of facts that vary per server — the thing
  `CLAUDE.md` names as the failure mode of a spell-duration table, for the same
  reason: Legends is a custom server and a member list transcribed from a classic wiki
  is wrong for everybody in a slightly different way. It fails **silently** — a mob
  missing from the list produces no popup and no complaint, which is exactly the bug
  being fixed. And it needs maintenance forever, by hand, per island.

### 2. Substring / family matching on the blob text
- **Description:** `a spiroc vanquisher` contains `spiroc`, so match it to
  `spiroc mobs`; strip `mobs`, lowercase, look for the stem.
- **Pros:** Zero data, zero storage, a dozen lines.
- **Cons:** Guessing, and the project has already decided against it twice — the
  2026-08-20 changelog rejected it by name ("no substring guessing was built"), and
  `looksLikeMobName` exists because reading meaning out of a name's *shape* is what
  made a whole raid zone score nothing. It also does not work: `Bzzazzt` is a bee and
  contains no `bee`; `a blade storm` is a spirit and contains no `spirit`. It would
  simultaneously miss real members and match wrong ones, with no way to tell which.

### 3. Learn the drop index from the player's own log — **chosen**
- **Description:** Record the corpse name that the loot rule already parses and the
  store already discards. `mob → item → count` becomes a fourth **fact** in
  `QuestProgress` alongside loot, offer and inventory counts, obeying the store's own
  rule (counts are facts; facts are never edited, only accumulated). The popup matches
  the engaged mob against the union of *learned drops* and the dataset's named-boss
  sources, so day one still works and every pull after it knows more. A
  `scripts/mine-drops.js` seeds an existing character's index from their log in one
  pass.
- **Pros:** Honest by construction — every row is something this character watched
  drop. No matching heuristic anywhere: the keys are log names, so equality is exact.
  It catches all three failure classes at once (family blobs, odd spellings, and trash
  mobs the dataset never associated with a drop). It follows the established
  precedent — `mine-rhythms.js` and `mine-buffs.js` both measure rather than table,
  and the boss-timer pack that replaced the live estimator was built exactly this way.
  The data is already flowing past the code that needs it.
- **Cons:** A fresh character knows only the shipped named-boss sources until it has
  looted something, so the fix is not retroactive without the backfill script. New
  state in the quest store (small: 37 mobs / 433 records for a 201 MB log). Firing on
  trash mobs is louder than firing on bosses — which is why the switch matters.

### 4. Widen the match and show everything, no new data
- **Description:** Keep the dataset as the only source, but match loosely and stop
  filtering to still-needed.
- **Pros:** Smallest possible change.
- **Cons:** Inherits every problem of 2, and answers the opposite of what was asked —
  "only what I still need" was the explicit narrowing.

## Chosen Approach

**Approach 3**, with the dataset kept as the seed rather than replaced.

The popup's question becomes *"does this corpse owe me anything?"* and it is answered
from two sources unioned at read time:

1. **Learned** — `mob → items`, accumulated per character from this character's own
   loot lines. Keys are the log's own creature names (`creatureKey`, article-stripped,
   the same normalization the session tracker uses), so matching the engaged mob is
   equality with nothing clever in it.
2. **Shipped** — the dataset's named-boss chips, exactly as today. This is what makes
   a fresh install useful before it has learned anything, and it is why nothing
   regresses.

An item shows when it is in the union for that mob **and** still outstanding in the
ledger. Approach 1's member table is deliberately *not* built: the learned index makes
it unnecessary for anyone who has fought the mob, and shipping one for anyone who has
not would be a guess we would then have to defend.

**Where the two surfaces diverge, on purpose.** The Quests window's "By boss" rail
keeps grouping by the dataset's islands and bosses. The rail answers *"where do I go
next"*, and thirty-seven trash mobs is noise in that question; the popup answers *"is
this corpse worth looting"*, and those same thirty-seven are the whole point. They
still share one need computation — only the grouping differs — so they cannot disagree
about what is owed, which was the original justification for putting `needs.js` in the
pure layer.

**The switch.** `dropsOverlay` stays the master on/off it already is (Settings →
Overlay → Needed drops). The new reach gets its own key beside it, so the louder
behaviour can be turned off without losing the popup:

- `dropsOverlay` — show the popup at all *(existing, default on)*
- `dropsAnyMob` — *"Include mobs your log has proved drop what you need"*; off means
  named dataset bosses only, i.e. exactly today's behaviour *(new, default on)*

Both live in the one Needed drops section on the Overlay page, which is the only place
either key is written — the two-places failure that removed the ALERTS section cannot
recur here.

## Tasks

- [x] `src/quests/progress.js` — keep the corpse name. `feed()` already receives
      `event.from` and drops it on the floor; record it as `state.drops[creature][itemKey] = count`
      behind the same `lookup(event.item).length` gate the item counts use, so this
      stays a quest ledger and not a second loot pane. Additive key, absent reads as
      empty — no `QUEST_STORE_VERSION` bump and no migration.
- [x] `src/quests/progress.js` — expose the index on `snapshot()` as `drops`, shaped
      `{ [creatureKey]: { [itemName]: count } }`.
- [x] `tests/quests-progress.test.js` — a loot line records its corpse; a non-quest
      item records nothing; a repeat accumulates rather than overwrites; a v2 file
      with no `drops` key loads and starts empty.
- [x] `src/quests/needs.js` — new `mobNeeds(snapshot, mobName, { anyMob })`: the
      outstanding-item computation `bossNeeds` already does, keyed on one mob and
      resolved against the union of the learned index and the dataset chips. Learned
      rows carry `seen: <count>` so the renderer can say the popup is speaking from
      experience.
- [x] `src/quests/needs.js` — `engagedNeeds` matches against the union. Strict equality
      is kept, unchanged, in both halves; the blob chips stay unmatchable by the
      dataset and are reached only through learned names.
- [x] `tests/quests-needs.test.js` — `Bazzt Zzzt` fires from the learned index though
      the dataset spells it `Bazzt Zzzt "Bees"`; `a spiroc vanquisher` fires for
      `Spiroc Earth Totem`; an owned item never appears; `anyMob: false` reproduces
      today's named-boss-only result exactly.
- [x] `src/main/config.js` — `dropsAnyMob` (default true), added to `DROPS_KEYS`;
      `dropsEnabled()` unchanged (mute still wins).
- [x] `tests/config.test.js` — the new key's default, and that it rides `DROPS_KEYS`.
- [x] `src/main/main.js` — `pushDrops` passes `quests.snapshot().drops` and the
      `dropsAnyMob` gate through to `engagedNeeds`. The per-tick recompute already
      only runs while a state is live or an encounter is running; the index is a plain
      object read, so the cost does not change.
- [x] `src/renderer/setup/{index.html,setup.js}` — the second switch in the existing
      Needed drops section, worded so its off state is legible: named bosses only.
- [x] `src/renderer/drops/drops.js` + `drops.css` — render the learned rows. The row
      shape is unchanged (name left, class flags right); a learned-only row gets a
      faint `seen 3×` where the dataset rows show nothing, so the panel never claims
      dataset authority for something it learned. No cap, every item, per the
      show-all-data rule.
- [x] `scripts/mine-drops.js` — replay a log and print `mob → item → count`, `--write`
      to fold it into the character's store. Print-only by default and dedup-safe on
      write, following `mine-rhythms.js` / `mine-buffs.js` / `backfill-history.js`.
- [x] Run `scripts/mine-drops.js` against `eqlog_Rhale_oggok.txt --write` so Rhale's
      index starts at the 37 mobs / 433 drops already in the log rather than empty.
- [x] `npm test`, then `scripts/dev.sh pack`, then **relaunch** the overlay.
- [x] `docs/changelog/2026-08-24-drops-popup-what-this-mob-owes.md`, and archive this
      plan.

## Notes

**Found and decided DURING execution:**

- *An eighth dead source string, and it is the biggest one.* Two dataset chips carry
  an article the log never omits — `Island 8: the Hand of Veeshan` and
  `Island 7: a greater sphinx` — and a third, `Island 5: The Spiroc Lord`, is written
  `The Spiroc Lord` every time. The combat parser's `resolveEntity` strips the article
  from every `engagedNpcs` key, so under the old bare-lowercase equality all three were
  as unmatchable as the family blobs. Measured in the live log: "the Hand of Veeshan"
  5,405 times, "a greater sphinx" 18,790, never once bare. Checked against Rhale's real
  ledger, **The Spiroc Lord owes him 4 items and the Hand of Veeshan 1, and neither
  could ever have fired the popup.**

  So the match folds articles on both sides (`mobKey`), which the plan's "strict
  equality, unchanged" line did not anticipate. It is not the loosening that line was
  guarding against: it is the SAME fold the other two vocabularies already applied
  before reaching the matcher (`resolveEntity` on engaged names, `creatureKey` on
  learned ones), it resurrects no family blob — "spiroc mobs" has no article to lose —
  and it does no substring matching. It is what makes all three vocabularies one.

- *The learned index adds nothing for Rhale TODAY, and that is the expected shape.*
  All 37 mobs and 267 pairs mined from his log resolve to items he already owns or has
  turned in, or to runes he does not need — so `dropsAnyMob` on and off currently paint
  the same eight bosses. The index is not idle: it is what makes `a spiroc vanquisher`
  or `undine spirit` fire the moment one of their drops goes outstanding, and the log
  proves all three failure classes are real — `Bzzzt`/`Bazzzazzt` drop Bixie Essence
  (dataset: `"bee" mobs`), `undine spirit` drops Golden Hilt, Gem of Invigoration and
  Crown of Elemental Mastery (dataset: `drake/sphinx/spirit mobs`). What shipped today
  on Rhale's own screen is the two resurrected bosses above.

- *Where the tests went.* The plan named `tests/quests-progress.test.js`; the store's
  tests already live in `tests/quests.test.js` and the new drop-index section joined
  them there rather than splitting one subject across two files.

- *Dedup on `--write` is a per-pair MAX, not a sum.* There is no record id to dedup on
  the way `backfill-history.js` has one, and the live store is accumulating the same
  facts in parallel. Max makes a re-run and an overlap with the live count both no-ops
  (verified: second run reported `0 raised, 267 already at least that high`, with every
  other fact in the file byte-identical). The cost, stated rather than hidden: mining
  two DIFFERENT logs folds in what each alone proves rather than their sum, so a count
  can be short. It can never be invented, and no count decides anything.

- *Learned groups carry `island: null`.* The item's own dataset chips usually imply an
  island, but inferring one would be a guess wearing a label's clothes. The renderer
  omits the ISL tag instead.

**Verified before planning, so these are not assumptions:**
- The popup is not clipped or mispositioned — anchor is bottom-right at (2542, 1364)
  on a single 2560×1440 display, work area bottom 1392. Well on screen.
- The renderer cannot draw a boss header without its rows: `dropsDisplay` filters out
  any group with an empty item list, and the item loop is inside the same `for` that
  appends the header. Whatever was on screen, it was not that bug.
- The ledger is healthy: 16 classes, 8 fully done, 18 items outstanding across 9
  dataset bosses.

**Open questions:**
- *Runes.* `Random zone-wide drop` stays excluded from the dataset half, as today. But
  the learned index makes "Protector of Sky dropped Wind Rune Kala 5×" a measured
  fact, and if a rune is ever outstanding, nearly every mob in the zone would fire the
  popup. Current intent: learned rune rows **do** show, because they are facts and the
  still-needed filter is what keeps them rare. Worth watching once Rhale needs a rune —
  he needs none today, so this is untested in practice.
- *Trash-mob volume.* With `dropsAnyMob` on, a spiroc camp fires the popup on most
  pulls. That is the requested behaviour and the switch is the escape hatch, but if it
  reads as noise the next lever is a floor (only show a mob whose drop is confirmed
  more than once) rather than reintroducing a boss whitelist.
- *"Toggleable"* is read here as: the new, louder reach needs its own switch, with the
  existing master switch left alone. If what was meant was a **hotkey or tray entry**
  for the popup as a whole, say so — that is a different, smaller task and can be done
  alongside.
- *Mockup.* The row shape does not change, so no Pencil mock is planned. The one new
  piece of chrome is the faint `seen 3×` caption; if that grows into anything more,
  it gets mocked first per the usual flow.
