---
status: completed
---
# People who vanish from the meter: charm brands a friendly as an enemy, forever

**Date:** 2026-08-10

---

## Goal

James reports that occasionally somebody who should be on the meter simply is not there.
This plan records what an audit of the live log actually found and fixes it.

The investigation instrumented `LogParser` and replayed the whole live session
(`eqlog_Rhale_oggok.txt`, 1,282,562 lines, 1,690 encounters), recording every damage line
that scored nothing and every call that can remove a name from view
(`noteHostileByAction`, `bindPet`, `charm`). It found one dominant cause and three
smaller ones. The dominant cause is not a display bug and not a rules gap — it is
`hostileByAction`, the Plane-of-Sky fix, misfiring on a friendly and never letting go.

**The headline case.** In Plane of Hate the mobs charm group members. EQ Legends prints
**no line at all** when a *player* is charmed — the log has 35 `has been charmed.` lines
and every one of them names a mob, zero name a player. James knows this and said so
in-game mid-pull:

```
[Wed Aug 05 22:51:02 2026] You tell your party, 'i hate that if i get charmed it destorys my pet'
```

So a charmed member turns on the group with nothing in the log to mark the moment. Nine
minutes later a friendly water-elemental pet takes two swings at the charmed member, and
`markHostileFromDamage` reads that as proof:

```
[Sat Aug 08 00:31:47 2026] Goneker cleaves Cleric of Innoruuk for 70 points of damage.   <- friendly, fighting the mob
[Sat Aug 08 00:31:47 2026] Goneker cleaves Syphon for 34 points of damage.               <- Syphon is charmed
[Sat Aug 08 00:31:47 2026] Goneker is pierced by Syphon's thorns for 24 points ...        <- BRAND: Goneker is now an enemy
```

Syphon is a confirmed group member; Goneker is not, has never spoken on a channel (pets
never do), so Goneker is branded. `hostileByAction` is session-lifetime and one-way:
`isFriendly` returns false from that instant, `resolve()` strips its pet-hood, `implicit`
loses it and `notPets` blacklists it so no later summon can re-bind it. The only escapes
are a channel message from that name or a character switch.

**Cost, measured:** Goneker's remaining **1,362 damage lines / 69,394 damage** were
dropped for the rest of that session. A second friendly pet, Vabann, was branded the same
way three days earlier (`Vabann cleaves Venun for 42 points of damage.` — Venun charmed).
On the meter this reads exactly as James described it: a row that was there is gone, and
stays gone.

Both victims here were pets, which is luck rather than design: **the same code path deletes
a person.** The only thing that saved the human raid-mates in this log is that they were
in the group (`isConfirmedMember`) or had talked on a channel (`knownPlayers`). A raid-mate
in another group who never types anything and gets charmed once is branded for the night.

## What the audit found, in order of size

| # | Cause | Evidence in the live log |
|---|---|---|
| 1 | **`hostileByAction` brands a friendly permanently.** Trigger: a charmed group member. | Goneker (1,362 lines / 69,394 dmg lost), Vabann. 20 brandings total; 18 correct, 2 wrong. |
| 2 | **Friendly-vs-friendly damage is dropped wholesale** when nothing resolves — everything a charmed member does, and everything done to them. | ~1,417 dropped lines in the top-40 attacker buckets alone (Syphon↔Sparked 372, Rhale`s warder↔Emalina 275, Khanvikt 180, Sparked 191). Also `Venun hit Venun … by Cannibalization I` — 18 lines, 20,965 self-damage, counted nowhere, not even as damage taken. |
| 3 | **`reave` is missing from `ATTACK_VERBS`.** | 1,374 hits + 1,264 misses unparsed, across 8+ players (Glorb 536, Rhain 416, Syphon 112, Ribbers 100, Vaezerk 77, Darkhorse 60, Crusader 58, Qeleigh 22). |
| 4 | **Heals with no `by <Spell>` clause match no rule.** | 4,715 lines (`You healed Rhale for 92 hit points.`, `Rhazendude healed Vaezerk for 67 hit points.`). |
| 5 | **`tormented` is missing from the damage-shield verb set.** | 225 lines (`… is tormented by Kadomony's frost for 12 points of non-melee damage.`). |

Two more are structural rather than observed here, and are noted because they produce the
identical symptom:

- **First-sight summon binding can fold a real player into a summoner's row.** `bindPet`
  refuses a name with player proof, but a raid-mate who has never spoken and is not in the
  group has none; if their first action lands inside the 12s weak-summon window they
  become somebody's pet and lose their row. All 39 bindings in this log were genuine
  generated pet names, so this did not fire — but nothing prevents it.
- **`groupOnly` + `hasExplicitData`.** `hasExplicitData` flips true on *any* group line,
  after which the group-only view shows `explicit` only. Anyone already in the group when
  logging began was never added to `explicit`, so the first join/leave line by anybody
  else silently drops them from the view. Default is off, so this never fired for James —
  but it is a filter that hides people on the strength of an inference, which is the same
  failure class as everything above.

## James's directive on filtering

> "Settings should have a list of party members if we want to specifically parse only
> specific people, otherwise anyone in the log should be showing up."

That settles the filtering half of this plan and it settles it against the current design.
`groupOnly` decides who to show from *inferred* membership — it fails closed, it fails
silently, and the player has no way to see or correct what it decided. The replacement is
an explicit list the player types, and no filtering at all when that list is empty.

Note the roster already has the machinery: `overridesOn` / `overridesOff` and
`roster.override(name, include)` exist and are honoured first in `includes()` and
`isFriendly()`. They are reachable from nothing — no config key, no IPC channel, no UI.
This is wiring an existing mechanism up to a settings field, not building a new one.

## Approaches Considered

### 1. Expire the brand — make `hostileByAction` encounter- or zone-scoped
- **Description:** Keep the mechanism, drop the lifetime. Clear the set on encounter close (or on zone).
- **Pros:** Two-line change. Bounds the loss to one fight. A real mob re-brands within seconds because it keeps hitting the group, so the Plane-of-Sky fix mostly still works.
- **Cons:** "Mostly" is the problem. The bee island is exactly the case where the first seconds of every pull are scored wrong, repeatedly, and `docs/changelog/2026-08-06-single-token-entity-identity.md` chose session lifetime deliberately ("a mob does not stop being a mob"). It also treats the symptom: the parser still *believes* something false about Goneker, it just forgets it periodically.

### 2. Evidence ledger — score hostility for and against
- **Description:** Replace the Set with counters. Friendly acts (damaging engaged NPCs, being healed) subtract; hostile acts add; the brand holds while the balance is hostile.
- **Pros:** General, self-correcting, handles cases nobody has thought of.
- **Cons:** Turns "is this a friend" into a tunable number, which is the one thing this codebase refuses to do everywhere else ("honest numbers over guessed ones"; ambiguity goes to Unknown, not to the most plausible answer). Untestable in the way the rest of the parser is testable — every test becomes an assertion about a threshold.

### 3. Positive friendly proof, symmetric with the hostile proof that already exists
- **Description:** `hostileByAction` is built on positive proof in one direction only: *it traded damage with a confirmed member*. Add the mirror — `friendlyByAction`, fed by acts an enemy cannot perform — and let it both **block** a branding and **revoke** one. The strongest such act is being healed by a proven friendly. Separately, when one side of a friendly-fire line **is** a confirmed member, prefer "this member has been turned" over "the other side is an enemy", raise it as a `charm` member state, and brand nobody.
- **Pros:** Same shape of reasoning as the existing code, so it is unit-testable the same way. Empirically exact on the live log (see below). Fixes the cause, not the lifetime. It also finally *tells* James he has been charmed, on the alerts surface that already renders `memberEffects` — the thing the log itself never says.
- **Cons:** More moving parts than option 1. Needs the heal path, which currently feeds the roster only via the healer, to also feed it via the target.

### 4. Never brand from damage at all — drop the ambiguous line and move on
- **Description:** Delete `markHostileFromDamage`; friendly-fire lines simply score nothing.
- **Pros:** Cannot delete anybody. Simplest possible rule.
- **Cons:** Reinstates the Plane-of-Sky bug wholesale — 409,749 outgoing and 95,983 incoming damage read as friendly fire and dropped, and 639 Deadly Poison warnings never raised. That regression is the reason this mechanism exists.

## Chosen Approach

**Option 3.** The deciding factor is that the friendly proof is not a heuristic — it is a
clean measurement. Every one of the 20 brandings in the live log was tested against
"was this name ever healed by a proven friendly":

```
Goneker      healed by Taneldar, Sparked, You     <- wrongly branded, rescued
Vabann       healed by Glorb, Venun, You          <- wrongly branded, rescued
Bzzazzt / Bzzzt / Bazzzazzt / Bizazzzt   never    <- correctly branded, stays branded
Gorgalosk / Rocksoul / Bonefire / Marrowbane / Orc Warden / Efreeti Lord Djarn   never
Knight V`Tal   healed 3x — by "a Teir`Dal ranger", a mob, not a proven friendly
```

20/20. The two friendly pets separate perfectly from the eighteen real enemies, and the one
mob that *is* healed is healed by another mob, which the "proven friendly healer" guard
already excludes. You do not heal an enemy; a mob healing a mob is not friendly proof.

Damaging an NPC the group is currently engaged with is a second, weaker friendly signal
worth admitting for the *block* but not the *revoke*: a branded mob can plausibly land a
hit on a charmed pet, so letting that alone lift a brand would risk un-branding a bee.

The charm inference is the other half and is what stops the bad branding at source. The
parser already infers a charm *break* from friendly-hits-friendly with no log line to go
on (`breakCharm`); inferring a member being *charmed* from the same evidence is the same
move in the other direction, and the member-state surface for it already exists.

Rule gaps 3–5 are independent, cheap, and land in the same pass.

**On filtering, second decision:** replace `groupOnly` with an explicit `partyMembers`
list in settings. Empty (the default) means no filter — every combatant the log produces
gets a row. Non-empty means that list and nothing else. This is `overridesOn` used as a
whitelist rather than a set of exceptions, so `includes()` gains one branch and loses one.
The inferred group-membership filter goes entirely: nothing on screen should be hidden by
a guess the player cannot see. Explicit group tracking (`explicit`, `hasExplicitData`)
**stays** — it is load-bearing for `isConfirmedMember`, which is what protects a real
player from being branded hostile. Only its use as a *display filter* is removed.

## Tasks

**The brand must be revocable (cause #1)**
- [x] Add `friendlyByAction` Set + `noteFriendlyByAction(name)` to `src/parser/roster.js`, documented as the mirror of `hostileByAction`: positive proof, never inference from absence.
- [x] `noteFriendlyByAction` lifts an existing brand — deletes from `hostileByAction` and from `notPets` — so a name wrongly branded earlier in the session comes back.
- [x] `noteHostileByAction` refuses a name that carries friendly proof, exactly as it already refuses one with `hasPlayerProof`.
- [x] `isFriendly` in `src/parser/index.js` consults `friendlyByAction` above the `hostileByAction` / `engagedNpcs` checks.
- [x] `handleHeal` calls `roster.noteFriendlyByAction(target.name)` when `isProvenFriendly(healer.name)` — a mob healing a mob must not qualify.
- [~] ~~`markHostileFromDamage` skips a side that has damaged an NPC the current encounter has engaged (the weaker block-only signal)~~ — **dropped deliberately**; it would hand the Plane of Sky bees the same immunity, since they are scored as friendly right up until they are branded. See the execution notes.
- [x] `setSelf` clears `friendlyByAction` alongside the other per-session state.

**Infer the charm the log never prints (cause #2)**
- [x] In `resolveFriendlyFire`, before `markHostileFromDamage`: if exactly one side is a confirmed group member, treat that member as turned — `startCcState(member, 'charm', ts)` — score nothing, brand nothing, and return handled.
- [x] End that state when the member next damages an engaged NPC, and on a timeout, so a stuck banner cannot outlive the charm.
- [x] Decide and document what happens to a turned member's damage. Recommendation: score neither side (it is not group DPS and the victim's "what is killing me" row would name a friend), but keep the member state visible so the number's absence is explained on screen rather than silent.

**Rule gaps (causes #3–#5)**
- [x] Add `'reaves', 'reave'` to `ATTACK_VERBS` in `src/parser/rules.js` (1,374 hits + 1,264 misses).
- [x] Add a `heal-no-spell` rule for `^(.+?) healed (.+?)( over time)? for (\d+)(?: \((\d+)\))? hit points\.` + MODS — must sit after `heal` and cannot swallow it (`hit points.$` cannot match `hit points by Bravery.`). The ability has no honest name; label it the way unattributed damage is labelled rather than inventing one.
- [x] Add `tormented` to the damage-shield verb alternation, mapping to no element (it names none).
- [x] Re-run `scripts/collect-unknown.js` afterwards and confirm all three shapes are gone.

**An explicit party list replaces the inferred group filter**
- [x] Add `partyMembers: []` to `src/main/config.js` defaults, documented as: empty means show everyone, non-empty is an exact whitelist.
- [x] Remove `groupOnly` from the config defaults, from `setup.js` (`group-only` checkbox at `src/renderer/setup/setup.js:111` and `:402`), and from the `patch` handler at `src/main/main.js:1840`. Migrate an existing `groupOnly: true` to an empty `partyMembers` — silently showing *more* is the safe direction, and there is nothing honest to migrate it to.
- [x] `LogParser.setPartyMembers(names)` → `roster.override(name, true)` for each, replacing the whole set (a wholesale replace, like `setPetOwners`, so deleting a name in settings actually deletes it).
- [x] `roster.includes(name)` loses its `groupOnly` parameter: pins win, then `overridesOff`, then — when any pin exists — membership of the pin list, else true for anyone the encounter has a row for. Same for `members()`.
- [x] `index.js:1554` `include` collapses to the pin check; `UNKNOWN` keeps its exemption (it is a real bucket of real damage and hiding it makes the group total lie).
- [x] Settings UI: an editable name list in `src/renderer/setup/`, cool-slate palette, sitting with the pets mapping since it answers the same kind of question. Empty state must say what empty *means* ("showing everyone in the log") rather than looking like a broken field.
- [x] Typo guard: reuse `nearestName` from `entities.js` the way `handlePetCommand` does — a mistyped party member is a person silently missing from the meter, which is this entire plan.

**Tests**
- [x] `tests/roster.test.js`: friendly proof blocks a branding; friendly proof arriving later revokes one; a mob healing a mob is not friendly proof.
- [x] `tests/roster.test.js`: an empty party list shows everyone with a row, including names the log never proved anything about; a non-empty one shows exactly those names; a group join/leave line changes neither.
- [x] `tests/parser.test.js` (or wherever `markHostileFromDamage` is covered): the Goneker sequence — friendly pet fights a mob, swings once at a charmed member, keeps its row and keeps scoring.
- [x] Regression pin: the Plane-of-Sky bee sequence still brands `Bzzazzt` and still scores its damage as incoming.
- [x] A confirmed member hitting a friendly raises a `charm` member state and brands nobody.
- [x] Rules tests for `reave`, the spell-less heal, and `tormented`.

**Verification against the live log**
- [x] Re-run the audit script over `eqlog_Rhale_oggok.txt`; assert Goneker and Vabann are no longer in `hostileByAction` and their ~70k damage is credited, and that the 18 correct brandings are unchanged.
- [x] `scripts/dev.sh pack`, relaunch. (The in-game Plane of Hate eyeball is James's — the fix is verified against the recorded session of that same content.)
- [x] `docs/changelog/2026-08-10-a-charmed-friend-is-still-a-friend.md`.

**Deliberately out of scope for this plan** (write up, do not fix here)
- [x] The first-sight summon binding claiming a silent real player. Same symptom, never fired in this log; note it in the changelog so the next report is not re-derived from scratch.

## Notes

- Audit scripts live in this session's scratchpad (`audit-missing.mjs` instruments dropped
  damage lines by reason; `audit2.mjs` captures the exact log line behind every branding,
  binding and charm). They are worth promoting to `scripts/` if this class of bug recurs —
  "which lines scored nothing, and why" is not answerable any other way today.
- `feedback-trust-james-on-what-works` applied cleanly here: the report was vague ("people
  occasionally don't appear"), the instinct was to look at the display layer, and the
  actual cause was 1,362 damage lines being dropped in the parser eleven minutes into a
  raid. The measurement found it; reading the renderer would not have.
- The `dot-no-encounter` drops the audit reported are the evac-ghost rule working as
  designed (`docs/changelog/2026-08-10-evac-ghosts-and-the-backtick-mob.md`) — 20 lines,
  left alone.
- `Venun hit Venun for 1924 points of unresistable damage by Cannibalization I.` is a
  shaman converting health to mana. It correctly does not count as DPS. Whether it should
  count as damage taken is a real question and deliberately not answered here.
- Unrelated but visible in the roster dump: a large number of generated pet names
  (`Gobeker`, `Jonantik`, `Vebeker`, …) sit in the *implicit* roster as if they were
  players, giving unowned pets their own rows. That is the documented `isUnownedPet`
  behaviour — honest, but it means an owner's row is missing that pet's damage. Separate
  problem, separate plan.

## Notes from execution

- **The weak "damaged an engaged NPC" block signal was NOT implemented, on purpose.** The
  plan asked for it as a second, block-only friendly signal. Working it through against
  the Plane of Sky case kills it: the bees were scored as friendly right up until the
  moment they were branded, so a mob has that signal available to it too, and the block
  would have handed `Bzzazzt` immunity from the mechanism built to catch it. The heal
  signal is immune to that reasoning precisely because a heal names a TARGET. One signal,
  and it measures 20/20 on the live log.
- **The charm inference is tighter than the plan's wording.** "Exactly one side is a
  confirmed group member" would have read `Bzzazzt hit you for 100 points of poison
  damage` as YOU being charmed rather than as a bee — it would have destroyed the Sky fix
  outright. It requires the other side to carry positive friendly proof AND not be a
  confirmed member itself, which is what makes it an inference rather than a guess.
- **`noteFriendlyByAction` had to be restricted by name shape, and the live log is what
  caught it.** The first version admitted any heal target, and five charmed mobs promptly
  collected PERMANENT friendly standing from their own charmer's heals — one of them a
  loathling lich with 85,374 damage, which would then have scored as group damage the
  moment the charm broke. Strictly worse than the bug being fixed. Now only player-shaped
  names and generic possessives qualify; article-bearing names were never friendly by
  shape and so never needed protection.
- **`overridesOn` / `overridesOff` were NOT reused as the party list**, as the plan
  suggested. Reading `isFriendly` shows why: those pins force an IDENTITY answer, while
  the party list must be a display filter that changes no attribution. Conflating them
  would have made "hide this row" silently mean "stop counting this person". They stay as
  they are — still reachable from nothing, still tested, and now documented as the
  identity half beside `partyMembers` as the display half.
- **The self-damage guard cannot use resolved names.** `attacker.name === target.name` is
  true for a charmed pet hitting its own owner, which is the charm-break signal, not
  self-damage. The existing tests caught this within a minute of the first run.
- **`handleHeal` now resolves before the encounter guard**, so heals between pulls feed
  the roster. This is where the group tops its pets up, and it is the evidence that stops
  one being branded later. Side effect, consistent with what `resolve()` already
  documents: a pet may now announce itself by healing out of combat, not only in it.
- Verified end to end by replaying the live log: 20 → 18 brandings, exactly Goneker and
  Vabann rescued (87,612 and 13,452 damage credited), 18 real mobs unchanged, and of 156
  names granted friendly proof only 4 are not player-shaped — all four real backtick pets.
  `collect-unknown` matches 8,930 more lines than before.
