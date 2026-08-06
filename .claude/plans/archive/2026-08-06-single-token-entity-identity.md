---
status: completed
---
# Single-token entity identity: other players' pets, PoSky bees, and proc visibility

**Date:** 2026-08-06

---

## Goal

Three reported symptoms — "no pet procs at all", "procs don't show in the pet DPS of other
players such as shadowknight pets", and "the bees on posky are messing up the parser" —
turn out to be **one root cause plus one presentation gap**.

The root cause is `looksLikePlayerName()` in `src/parser/entities.js`. It is a name-shape
guess:

```js
return /^[A-Z][a-z]+$/.test(trimmed);   // single capitalized token, no article, no backtick
```

Every one of these passes it:

```
true  Bzzazzt      true  Bazzt        true  Bzzzt      true  Bazzzazzt    <- PoSky bees
true  Kibektik     true  Zararer      true  Karektik   true  Gantik       <- other players' pets
true  Vabektik     true  Xobekn       true  Lontik     true  Gobarn       <- other players' pets
true  Emalina      true  Rhale                                            <- actual players
```

`isFriendly()` falls through to that heuristic whenever the roster has no opinion, so a
PoSky bee is friendly and a shadowknight's pet is a player. That single fact produces both
bugs. The proc complaint is separate and turns out to be presentational only.

### 1. Other players' pets are scored as separate players (attribution bug)

Replaying the live bee fight (lines 832,500–845,000 of
`eqlog_Rhale_oggok.txt`) through `LogParser` produces these rows:

```
  31315  Syphon
  14792  Kadomony
  12275  Rhale
   6824  Khanvikt
   4523  Zararer     <- a pet, given its own row
   2551  Kibektik    <- a pet, given its own row
```

`Kibektik` is provably Khanvikt's pet. The log shows the summon and two pet-only buffs
landing on it:

```
[10:06:21] Khanvikt begins casting Invoke Death VIII.
[10:06:30] Khanvikt animates an undead servant.      <- summon, names the OWNER
[10:06:46] Khanvikt begins casting Augment Death IV.
[10:06:51] Kibektik's eyes gleam with madness.       <- pet-only buff lands
[10:06:54] Khanvikt begins casting Tiny Companion.
[10:06:57] Kibektik shrinks.                         <- pet-only shrink lands
```

So Khanvikt's real contribution is 6,824 + 2,551 = 9,375 with a 27% pet split — and his
pet's procs (`Specter Lifetap`, 54+40 hits in the sample) belong in his breakdown. Today
he shows 6,824, no pet split, no pet procs. That is exactly the reported symptom.
`` Rhale`s warder `` works only because the beastlord warder uses the backtick possessive
that `entities.js` splits on; every *summoned* pet gets a generated name instead and has
no such marker.

### 2. PoSky bees read as friendly (hostility bug)

```
isHostileCaster('Bzzazzt')              = false
isHostileCaster('a spiroc vanquisher')  = true
```

In the 12,095-line bee fight there are **639 `<bee> begins casting Deadly Poison.` lines
and zero enemy-cast warnings raised.** Deadly Poison is what killed the group —
`Kadomony has been slain by Bzzazzt!`, `Khanvikt has been slain by Bazzzazzt!`,
`Syphon has been slain by Bazzzazzt!`. The alerts feature is silently off for the entire
island.

Two further hazards follow from the same flag, both latent in that sample but live:

- **Attribution.** Every bee cast enters `this.casts` as a *friendly* cast, so
  `attributeNonMelee()` can credit unattributed non-melee damage to a bee, which then
  appears as a friendly row.
- **Charm-break.** `roster.js` infers a charm break from friendly-hits-friendly. Bees sting
  group members 700+ times in this log. With an enchanter charming bees — which general
  chat describes as the standard PoSky strategy ("charming the bees is insane though",
  "there's like 3 ways to split bees off") — every sting would false-break the charm.

This is not a new gap; `index.js` already documents it: *"a single-token named mob casting
before anyone has engaged or targeted it reads as a player."* PoSky bee island is simply
where it stops being occasional. Ordinary mobs carry an article (`a spiroc vanquisher`) or
multiple tokens (`The Spiroc Lord`); `Bzzazzt` carries neither.

### 3. Procs ARE tracked — the gap is that nothing labels them (presentation)

The original complaint does not survive contact with the log:

| Check | Result |
|---|---|
| `... has been struck by the force of Ykesha.` flavor lines | 749 |
| `... hit X for N points of magic damage by Ykesha.` damage lines | **749 — exactly 1:1** |
| Dealt by `` Rhale`s warder `` | 115 |
| Rule that matches them | `spell-damage`, already `(confirmed)` |
| Breakdown row produced | `Ykesha (pet)` |

Verified end to end: 7 warder procs in a 40k-line slice × 75 = 525, and the snapshot
reports `Rhale | Ykesha (pet) 525`. `collect-unknown.js` finds zero damage-bearing
unmatched lines. Nothing is missing — but nothing says "proc" either, and `Ykesha (pet)`
is 1.6% of pet output sitting at the bottom of an 18-row list.

The category is not small. The warder's abilities split cleanly into ones it is seen
casting and ones it never casts:

```
BEGINS CASTING (spells)          DAMAGE, NEVER CAST (procs)
  Tainted Breath, Sicken,          871  Spirit of Scorpion Strike
  Ice Spear, Drowsy,               860  Spirit of Inferno Strike
  Frost Dagger, Envenomed          382  Spirit of Blizzard Strike
  Breath, Blast of Frost           375  Spirit of Vermin Strike
                                   115  Ykesha
                                    66  Ignite
                                    64  Spirit of Lightning Strike
```

The two sets are **disjoint across the whole log** — 2,733 proc hits vs 3,366 spell hits.
Procs are ~45% of the pet's non-melee damage, all counted, none identifiable.

## Approaches Considered

### 1. Name tables — list the pets, list the bees
- **Description:** Hardcode known pet names and known PoSky mob names, or pattern-match
  them (`/zz/` for bees, `-tik$` for pets).
- **Pros:** Trivial; fixes today's log immediately.
- **Cons:** Contradicts a standing invariant — CLAUDE.md records that a spell-name table
  "would be guessing and was deliberately not built". Pet names are randomly generated per
  summon, so the table can never be complete. `Bzzarzzt` today, something else next zone.
  This is the approach the project has already rejected twice.

### 2. Require `Targeted (NPC): X` before trusting anything
- **Description:** Drop the name-shape heuristic; treat a single-token name as unknown
  until the game classifies it.
- **Pros:** Perfectly honest — the game states the answer outright, and the `targeted` rule
  already exists.
- **Cons:** Requires the player to manually target every entity. In the entire 12k-line bee
  fight `knownNpcs` stayed **empty** — nobody targeted a bee all night. The overlay would
  populate with nothing out of the box, which is the exact failure the implicit heuristic
  was added to prevent.

### 3. Behavioural classification — let actions outrank name shape (chosen)
- **Description:** Keep `looksLikePlayerName` as the last resort it was meant to be, but
  let observed behaviour override it in both directions:
  - **Enemy:** an entity the group damages, or that damages a confirmed group member, is
    hostile whatever its name looks like. This is what `isHostileCaster` already does via
    engagement; `isFriendly` simply never learned it.
  - **Pet:** bind a generated pet name to its owner from the summon line
    (`<Owner> animates an undead servant.` / `<Owner> summons a <frenzied|guardian|
    companion> spirit.`) and from pet-only buffs the owner casts onto it.
- **Pros:** Same family of inference the parser already trusts — charm from cast + "has
  been charmed", charm-break from friendly-hits-friendly, damage-shield ownership from a
  possessive strip. No table to maintain; survives new zones, new pet names, new servers.
- **Cons:** Ownership binding is temporal and can mis-bind if two summoners fire at once.
  Needs an explicit ambiguity rule, and the existing settings mapping as the escape hatch.

### 4. Approach 3, plus the reflexive-pronoun tell — TESTED AND REJECTED
- **Description:** Use `X healed itself` (pet/NPC) vs `X healed himself/herself` (player)
  as a classification signal. The sample is enormous — `Kibektik healed itself` 2,705
  times — and it fires without anyone targeting anything.
- **Verdict: the pronoun tracks the healing EFFECT, not the entity. It is wrong in both
  directions and must not be used.**
  - `Emalina healed itself` 903 times (from `Blessing of the Knight`) alongside 13,680
    `healed herself` — a real player reading as neuter.
  - `Gann healed himself` 366 times (from `Blessing of the Squire`) — and Gann is
    **provably a pet**: `Rhain begins casting Sagar's Animation.` at 18:50:41 is followed
    at 18:50:46 by `Gann begins casting Center.`, Gann's first appearance in the log.
    This also confirms the `{ Gann: 'Rhain' }` mapping the repo has carried as an example.
- Both `Blessing of the Squire` and `Blessing of the Knight` are proc-heals, which report
  neuter or gendered by their own definition regardless of who owns them. Dropped entirely.

### 5. Do the presentation work only (proc labels), defer the identity fixes
- **Description:** Ship proc classification; leave bees and pets.
- **Pros:** Small, safe, addresses the literal opening question.
- **Cons:** Leaves group numbers wrong and the alert system dead on an entire raid zone.
  The proc label would still show nothing for a shadowknight's pet, because that pet's
  damage never reaches its owner's row — so it would not even fix the second complaint.

## Chosen Approach

**Approach 3**, with approach 4 dropped on the evidence above, and the proc labelling from
approach 5 as the last phase.

Behavioural classification is the only option consistent with how this parser already
reasons, and the log supplies every signal it needs. Order matters: the identity fixes come
first because the proc work is worthless for other players' pets until their damage folds
into the right row.

**The governing rule is positive proof in both directions, never inference from absence.**
A prototype classifier that assumed "no player proof ⇒ pet" was run over the full log and
put 46 names in the pet bucket — correctly catching every real pet, but also sweeping in
the PoSky bees (`Bzzazzt`, `Bzzzt`), boss mobs (`Marrowbane`, `Rocksoul`, `Gremwall`), and
enemy pets belonging to mob owners (`Veker` ← `Tormax`). It also misfiled `Fuaim` — a real
player, cited in the `entities.js` docstring — who deals one damage line and never speaks.
So **"not a player" does not mean "pet"**; a third state is required.

Three verified proofs to build on:

| Proof | Reliability | Evidence |
|---|---|---|
| Channel chat (`tells the group`/`tells General:N`/`auctions`/`shouts`) ⇒ **player** | clean | 917 names; zero pets or bees |
| `X has joined/left the group.` ⇒ **player** | clean | 15 names; **wording now confirmed** |
| Summon-cast adjacency ⇒ **pet of that caster** | good, needs window | `Sagar's Animation`→`Gann`, `Invoke Death`→`Kibektik` |

Note that bare `says,` is **not** player proof — mobs use it for summon call-outs
(`Bazzzazzt says, 'You will not evade me, Khanvikt!'`), which is what made the prototype
misclassify `Gorgalosk` as a player. `roster.js` currently records that this server's group
wording is "unverified"; it is verified now, and explicit membership already outranks the
heuristic, so wiring it up fixes part of the bee bug for free.

Ambiguity rule, in keeping with the honest-numbers invariant: if two friendly summons are
pending when a new name appears, bind nothing. An unbound entity keeps the existing
`isUnownedPet` treatment — its own visible row — which is already the documented "honest,
and makes it obvious the pet needs mapping" behaviour. The settings `petOwners` mapping
stays as the manual override.

## Tasks

### Phase 1 — stop treating enemies as friends (the bee bug)

- [x] Wire up explicit group membership in `rules.js` — the wordings are **confirmed** in
      the live log and `roster.js` still records them as unverified:
      `^(.+?) has (joined|left) the group\.$` and `^You have (joined|been removed from) the
      group\.$`. 15 names appear this way. Explicit membership already outranks the
      heuristic, so this alone shrinks the blast radius of every misclassification below.
- [x] In `src/parser/index.js`, make `isFriendly()` consult engagement before falling back
      to `looksLikePlayerName()`: an entity currently engaged by the group in the active
      encounter is not friendly, whatever its name shape. Mirror the reasoning comment
      already on `isHostileCaster`.
- [x] Add a `hostileByAction` set on `Roster`: any entity that damages a *confirmed* group
      member (explicit roster, or self) is marked hostile permanently for the session, and
      that mark outranks `looksLikePlayerName`. Confirmed membership only — using the
      implicit set would let one misclassification cascade.
- [x] Make sure the new hostile mark does **not** fire the charm-break inference. A charmed
      mob hitting the group must still read as a charm break, not as a fresh enemy; check
      `charmedPets` first and take the existing break path.
- [x] Regression test in `tests/` using real bee lines: after
      `Bzzazzt stings Khanvikt for 47 points of damage.`, assert `isFriendly('Bzzazzt')`
      is false and `isHostileCaster('Bzzazzt')` is true, and that
      `Bzzazzt begins casting Deadly Poison.` raises a cast warning.
- [x] Replay the 12,095-line bee fight and assert the warning count for
      `Deadly Poison` is 639, not 0.

### Phase 2 — bind other players' pets to their owners

- [x] Add rules to `src/parser/rules.js` for the summon flavour lines, marked
      `(confirmed)`: `^(.+?) animates an undead servant\.$` (necro/SK, 18 friendly
      occurrences) and `^(.+?) summons an? (?:frenzied|guardian|companion) spirit\.$`
      (shaman/beastlord). Emit `{ kind: 'pet-summon', owner }`. The rule must NOT assume
      the summoner is friendly — the same wording appears from `a shadowknight`,
      `a necro acolyte` and `a froglok sentry`; the friendly guard belongs in `index.js`.
- [x] In `roster.js`, add a `pendingSummon` slot: `{ owner, ts }`, set on a friendly
      `pet-summon`, expiring after a short window. If a second friendly summon arrives
      while one is pending, mark the slot ambiguous and bind nothing.
- [x] Bind on first sight: when a previously-unseen, article-less, single-token name first
      appears in a combat line while a single unambiguous `pendingSummon` is live, record
      `petOwners.set(petName, owner)` and clear the slot.
- [x] Bind from the summon CAST as well as the flavour line — the magician case has no
      flavour line at all (`Rhain begins casting Sagar's Animation.` → 5s →
      `Gann begins casting Center.`). Treat any friendly `cast-start` as arming a weak
      pending-summon slot that only a previously-unseen name can consume, so no spell-name
      table is needed; the flavour line, where present, upgrades it to a strong binding.
- [x] Add the tighter secondary binding from pet-only buffs: when a friendly casts a
      pet-only spell (`Tiny Companion`, `Augment Death`) and the next buff-landed line
      names an unbound single-token entity, bind it to that caster. This corrects a
      mis-bind from the temporal path and is how `Kibektik` → `Khanvikt` is provable in
      the sample.
- [x] Add player proof to `roster.js` so pet binding can never claim a real player:
      channel chat (`tells the group` / `tells General:N` / `auctions` / `shouts`) and
      group join/leave both mark `knownPlayers`. **Exclude bare `says,`** — mobs use it
      for summon call-outs — and exclude `tells you`, which pets use to report to Master.
- [x] **Do NOT use the reflexive pronoun.** `Gann healed himself` 366 times and Gann is a
      pet; `Emalina healed itself` 903 times and Emalina is a player. Add a comment
      recording the disproof so it is not "discovered" again later.
- [x] Add an explicit third state: an article-less single-token entity with neither player
      proof nor a pet binding is **unknown**, not a player. It must not enter the implicit
      roster, must not be counted as friendly for cast attribution, and must not raise a
      false hostile alert either — it gets its own visible row and, if it damages a
      confirmed group member, is promoted to hostile by the Phase 1 rule.
- [x] Once bound, route the pet's damage/healing/damage-taken through the existing pet path
      so it folds into the owner's row with `isPet: true`. This is the same code
      `` Rhale`s warder `` already takes — the only change is where `isPet` comes from.
- [x] Verify against the bee fight replay: `Khanvikt` totals 9,375 with a pet split of
      2,551 (27%), `Kibektik` no longer appears as its own row, and `Specter Lifetap`
      shows in Khanvikt's breakdown.
- [x] Surface unbound pets in the settings window so the user can map them by hand — the
      `petOwners` settings mechanism exists but nothing tells the user which names need it.

### Phase 2b — in-game mapping command (no alt-tab)

The parser's only input is the log, so anything the client writes to the log can be a
control channel. `/echo` is **disabled on Legends** (user-confirmed), so the command must
ride on a chat form this client actually logs. Candidates, most private first:

**Do not tie the command to any one channel.** Party chat is unavailable when solo, which
is exactly when you would be mapping your own pet; guild chat needs a guild; raid chat
needs a raid. The rule must therefore accept the payload on **every** self-originated
free-text form, and let the user pick whichever is available at the time.

| Form | Log line | Who sees it | Works solo? | Status |
|---|---|---|---|---|
| custom channel | `You tell eqlo:1, '…'` | only channel members (just you) | **yes** | untested — `/join` returned the channel-command help at 11:23:48 but global chat was down. Best option if it works |
| `/say …` | `You say, '…'` | everyone nearby | **yes** | proven ×77 — the universal fallback |
| `/p …` | `You tell your party, '…'` | 5 groupmates | no | proven ×474 |
| `/gu …` | `You say to your guild, '…'` | guild | needs a guild | proven ×109 |
| `/rs …` | `You tell your raid, '…'` | raid | no | proven ×81 |
| `/tell <self> …` | — | — | — | **ruled out — Legends rejects self-tells** |
| `/echo …` | — | — | — | **ruled out — disabled on Legends** |

- [x] Match the payload across all five proven forms with one alternation on the prefix:
      `^You (?:say|tell your party|tell your raid|say to your guild|tell \w+:\d+), '…'$`.
      Deliberately EXCLUDE `You told <name>,` — a directed tell goes to a real person and
      should not double as a config channel.
- [x] Note in the rule comment that the user's OWN pet usually needs no command at all:
      `pet-reports-to-master` already learns it from
      `` <Pet> told you, '… Master.' ``, which fires solo. The command exists for OTHER
      players' pets and for the case where a pet never reports.
- [x] **Match only the self form.** Other players' chat lands in the same log
      (`Xilrasis tells General:1, '…'` ×6,666), so a rule matching the third-person form
      would let anyone in /general reconfigure the overlay by typing the magic words. This
      is the same trap `summon-say` already documents. Anchor on `^You tell(?:s)? …` /
      `^You say,` and never on `^(.+?) tells …`.
- [x] Place the rule **before** the chat rules in the ordered table, or `CHAT_RE` swallows
      it — the established precedent for `pet-reports-to-master` and `summon-say`.
- [x] Grammar: bare `pet <PetName> = <OwnerName>`, plus `pet <PetName> = none` to unmap and
      `pet ?` to list current mappings. No `eqlo` prefix — the `= ` and the whole-message
      anchor already make accidental collision implausible (`pet needs heals` cannot
      match), and the self-form anchor is what actually provides safety. Anchor the regex
      to the ENTIRE quoted message, not a substring, so chatter that merely contains the
      words is ignored. Reject names failing a sanity check rather than writing garbage
      into config.
- [x] Persist through the existing `petOwners` config store so the mapping survives a
      restart — not having to redo it every session is the entire point.
- [x] Acknowledge visibly. The user cannot see the parser, so a command that silently
      does nothing is worse than no command; route a confirmation through the alerts
      window (which already floats top-center and takes no mouse input).
- [x] Test that a *third-party* chat line carrying the same payload is ignored, and that a
      malformed command neither throws nor writes config.

### Phase 3 — label procs (presentation)

- [x] Add an ignore rule for `^(.+?) has been struck by the force of (.+?)\.$` →
      `{ kind: 'proc-flavor' }`. Comment the 749:749 pairing with `spell-damage`: it
      carries no damage and must never be scored, or every Ykesha proc counts twice.
- [x] Add a session-long `castObserved` set (`` `${caster}|${ability}` ``) in `index.js`,
      populated on every `cast-start`. Unlike `this.casts` it is never pruned — it records
      what has ever been cast, not what is in flight.
- [x] For `source: 'spell'` damage, compute `proc = !castObserved.has(key)` from the
      RESOLVED caster and pass it to `encounter.addDamage`. Leave `dot`, `melee` and `ds`
      alone — a DoT tick arrives long after its cast and is already its own bucket.
- [x] Thread `proc` onto the ability row in `encounter.js` beside `pet`, and clear it
      retroactively when a cast for that pair is first observed, so no ability ends a fight
      mislabelled. Keep **one row per ability per member** — do not add a key dimension, or
      the retroactive flip strands a stale row.
- [x] Label rows `Ykesha (pet proc)` / `Ykesha (proc)`; leave `(pet)` on pet melee and pet
      spells so existing rows are unchanged. Add `procDamage` to the combatant snapshot
      alongside `petDamage` / `playerDamage`.
- [x] Overlay: a `procs` chip in the damage breakdown's `setChips` row, rendering always
      (`0` when there are none) so it cannot push the ability list down and break the
      no-reflow rule. Mark proc rows with a `data-proc` attribute beside `data-pet` and
      style them subtly — no new column.
- [x] Mirror the proc total and marking in `src/renderer/history/history.js`; confirm panes
      land on the same pixel for a fight with zero procs and one with several.
- [x] Parser tests: a pet Ykesha hit with no preceding cast → `Ykesha (pet proc)`; a cast
      then an Ice Spear hit → `Ice Spear (pet)`; and the retroactive case — hit first, cast
      observed after → one row, `Ice Spear (pet)`, both hits counted.
- [x] Full-log replay: the warder's proc set is exactly the seven abilities above, and
      `Ykesha (pet proc)` totals 115 × 75 = 8,625.

### Wrap-up

- [x] `npm test`, then `taskkill.exe /IM "EQL DPS Overlay.exe" /F` and `scripts/dev.sh dist`
      — the user launches the win-unpacked exe, which syncing does not update.
- [x] Changelog `docs/changelog/2026-08-06-single-token-entity-identity.md`, leading with
      the root cause and the 749:749 proc verification, so the next person to ask "are procs
      tracked" finds the evidence instead of re-deriving it.

## Notes

### Findings from implementation (2026-08-06)

- **The bare-cast pet binding does not work as specified and was narrowed.** The plan
  proposed that *any* friendly cast arms a weak slot "that only a previously-unseen name
  can consume, so no spell-name table is needed". Every player is previously-unseen
  exactly once, so the two cases are structurally identical:
  `Emalina casts Greater Healing V → Rhain casts Beguile` (Rhain is a **player**) versus
  `Rhain casts Sagar's Animation → Gann casts Center` (Gann is a **pet**). The
  unconstrained version folded a groupmate into a healer's row, and the existing charm
  test caught it. The slot is now armed only by a **summon-shaped** spell name
  (`SUMMON_SPELL_RE`) — structural (`<X>'s Animation`, `Summoning`, `Familiar`), not an
  enumeration, and the same reasoning `CHARM_SPELL_RE` already rests on. Necromancer and
  shadowknight pets never needed it: they print the flavour line.
- **`shouts` and `says` are not player proof; `auctions` is kept.** EverQuest mobs shout,
  and the live log contains **zero** player shouts and zero auctions — so including
  `shouts` would have been pure risk for no coverage. Marking a mob a player is the bee
  bug with the sign flipped.
- **Ranked spells needed `spellStem`.** The cast line carries a rank the damage line does
  not — `Syphon begins casting Frost Storm VIII.` versus `... by Frost Storm.` — so every
  ranked spell in the game read as an ability that is never cast. 163k of Syphon's damage
  was labelled a proc before the stem was added. Not foreseen in the plan.
- **The plan's Phase 2 verification figures were measured under the broken behaviour.**
  Because a bee read as friendly, a friendly hitting it took the friendly-fire branch and
  was **dropped entirely** — so the "Khanvikt 6,824 → 9,375" numbers were computed from a
  fight in which none of the damage done to bees counted at all. With bees hostile the
  group's real output appears: over lines 793,000–845,000, Khanvikt totals 237,347 with
  127,282 pet damage, `Kibektik` has no row of its own, and `Specter Lifetap (pet proc)`
  shows 10,686 in his breakdown. Kibektik's binding evidence sits at line 793,806, before
  the plan's 832,500 slice start — which is why the narrower slice cannot bind it.
- **639 Deadly Poison casts, 629 warned.** The ten that do not are each bee's first few
  casts, before any confirmed member has traded damage with that bee. Proof by action
  cannot precede the action; a warning that fires from the second cast onward is the
  honest ceiling here.
- **The third state keeps its visible row.** An unproven single token is not admitted to
  cast attribution or pet binding (`isProvenFriendly`), but it is still scored and shown.
  Requiring proof before showing anything is exactly what made approach 2 unusable, and
  dropping the damage would make the group total quietly wrong.
- **`Targeted (NPC)` beat the new rule to three of the bees** in the full-log replay, so
  they never appear in `hostileByAction` — a stronger signal arriving first, not a gap.
- Two pre-existing chat bugs surfaced and were fixed alongside: channel names carry digits
  on this server (`General2:1`, `NewPlayers1:2`) and did not match, and `You told <name>,`
  matched no self-chat rule — both left those lines to fall through to the damage rules.

### Original notes

- **The proc premise was wrong and that is worth recording.** Pet weapon procs have always
  been parsed, attributed and displayed for `` Rhale`s warder ``. Phase 3 adds a *label*,
  not a number — group totals will not move. What was genuinely broken is that other
  players' pets never reached their owner's row at all, which is why their procs looked
  absent.
- The `Spirit of <element> Strike` family is the beastlord proc buff on the pet
  (`` Rhale`s warder is imbued with the spirit of vermin. ``) and is by far the larger share
  of proc damage; Ykesha is the small tail. Labelling only Ykesha would feel broken for the
  opposite reason.
- 406 `resisted ... Ykesha!` lines exist — over a third of proc attempts land nothing. Those
  correctly produce no damage. Proc *rate* is computable (`resist` is already a matched
  rule) but is deliberately out of scope.
- **Enemy pets use a third naming form the parser does not handle:** `<Owner> pet` with a
  SPACE and no possessive — `Hoptor Thaggelum pet`, `A zol ghoul knight pet`,
  `Marrowbane pet`, `An icy terror pet`. `PET_RE` in `entities.js` requires a backtick, so
  these read as plain NPCs. That is mostly harmless (they are enemies either way) but it
  means their damage never folds into the owning mob for damage-taken purposes. Cheap to
  add alongside the backtick form; not required for either reported bug.
- **Open question:** should the bee fix be generalized to a "suspicious name" warning? Any
  single-token entity that has neither been targeted nor acted is genuinely unknown, and the
  parser currently guesses "player". A visible "unclassified" state would match the
  honest-numbers rule better than either guess, at the cost of a busier overlay.
- **Open question:** pet binding is per-session and does not survive a resummon under a new
  name. A pet that dies and is resummoned gets a fresh generated name and re-binds from the
  next summon line — correct, but it means a mid-fight resummon briefly shows an unowned
  row. Acceptable; note it if it proves noisy.
- **Open question:** should proc rows roll up per weapon? A pet with two proc weapons shows
  two rows with nothing linking them. The log never names the weapon, so any grouping would
  be invented — left alone unless the user asks for "what is my pet's weapon doing" as one
  number.
