# Evac ghosts and the backtick mob

**Date:** 2026-08-10

## The report

Evacuating out of a Plane of Hate pull "broke the parser": the meter went on showing a
fight against a mob the group had fled and never went back to, and only Ctrl+Shift+R plus
a fresh session put it right.

Replaying that session (`eqlog_Rhale_oggok.txt`, Mon Aug 10 00:25–00:47) reproduces it and
shows the evac was the *trigger*, not the cause. Three defects stacked up, and the biggest
of them had nothing to do with evacuating at all.

## 1. A mob whose name contains a backtick possessive read as somebody's pet

`entities.js` split `` X`s Y `` into owner `X` unconditionally — advertised in its own
header comment as "the single biggest simplification available in EQ Legends logs". It is
not a simplification, it is a bug: EQ writes proper names with the same punctuation.

**`Innoruuk`s Chosen`** therefore resolved to a combatant called `Innoruuk`, which is a
single capitalized token with no article, which `looksLikePlayerName` calls a player,
which made a Plane of Hate boss *friendly*. Every line in either direction then read as
friendly fire and was silently dropped — and nothing could ever correct it, because
`markHostileFromDamage`, the one mechanism that fixes a bad identity, skipped a pet-shaped
side outright (`if (side.isPet) continue`, there so that a pet can never brand its owner
an enemy).

This is what actually froze the meter. The group fought `Innoruuk`s Chosen` for eight
minutes and the overlay never registered a single point of it. It is the same failure as
the Plane of Sky bees (`2026-08-06-single-token-entity-identity.md`), arriving through
punctuation instead of spelling.

## 2. Lingering DoT ticks from the mob you fled opened a phantom encounter

After the succor, `Rhain has taken 124 damage from Wrath of the Elements by Magi P`tasa.`
kept arriving every six seconds. The zone line had correctly closed the fight; the first
tick opened a brand-new encounter labelled **`Magi P`tasa`** with zero outgoing damage.
That is literally the reported symptom — the meter's headline was a mob in a room the
group had left. It reached history too: `main.js:466` only skips a record when damage
*and* damage-taken are both zero, so the phantom was filed as a fight.

## 3. A mob that left without dying stayed "alive" forever

`aliveNpcs` drained only through a death line. The fled `Magi P`tasa` sat in it for the
whole of the next encounter, which could then end only on the 15s idle timeout — and any
pull chained inside 15s merged into it. Every clean fight in the same session closed
`reason=killed ... alive=[]`; the post-evac one closed `reason=timeout ... alive=[Magi
P`tasa]`.

## What changed

### The pet split is now two-tier (`src/parser/entities.js`)

The backtick split survives, but only calls something a pet when the possessed noun is
**lowercase**. That is the game's own generic/proper distinction, and it holds across
every backtick-possessive name in the live log (~186k occurrences): every real pet is a
generic noun (`Rhale`s warder`, `Someone`s pet`) and every non-pet, mob or item, is
title-case (`Innoruuk`s Chosen`, `Hierophant`s Crook`).

Capitalization is still a *shape* rule, and shape rules are the class of rule that caused
this, so the split that was declined is **reported rather than discarded**:
`properPossessive: {owner, noun}` rides along on the resolved entity. `entities.js` cannot
weigh it — it is deliberately table-free and roster-free — so it hands the question up.

### The parser decides it on evidence (`src/parser/index.js`)

`resolve()` folds a `properPossessive` into its owner only when
`roster.hasPlayerProof(owner)`. A hypothetical `Rhale`s Warder` still lands on Rhale;
`Innoruuk`s Chosen` stays the mob it is, because nothing has ever proven an "Innoruuk" to
be a player. That division of labour is the one the two files already had: shape lives in
`entities.js`, evidence lives in the parser.

### Proof by action reaches pet-shaped names (`markHostileFromDamage`)

The blanket `if (side.isPet) continue` is gone. A pet-shaped side is now markable **by its
display name** — never by its owner — and only when that owner has no player proof. The
guard the skip existed for is exactly as strong: a real warder's owner talks, groups, or
*is* the logging character, so they always have proof.

`resolve()` then refuses to fold a display already in `hostileByAction`. Together this is
the self-correcting net under the shape rule: a lowercase-nouned mob name that rule waves
through fixes itself the first time it trades a blow with a confirmed member, and stays
fixed for the session. Nothing is even lost in the exchange — `resolveFriendlyFire`
re-scores the line that taught us — except the warning that line might have raised.

### An incoming DoT tick may extend a fight but never opens one (`handleDamage`)

Same principle as the fall-damage rule already in `handleUnattributed`: a mob's residual
DoT ticking on you is not proof you are fighting it. The outgoing side keeps its power to
open a pull, deliberately — a DoT *you* cast is a choice you made, and is often the first
damage line of a fight.

### An NPC silent in both directions for 60s stops counting as alive (`encounter.js`)

`aliveNpcs` becomes a `Map<name, lastSeenTs>`, fed by `engage()` — which every scoring
line in either direction already calls first. `update()` drops stale entries before the
all-slain check and arms the post-kill grace if that empties the set, because "nothing the
group engaged is still here" is the same fact whether it arrives by death line or by
silence. `engagedNpcs` is untouched: the fight must still be able to name every mob that
was in it.

60s, and the floor is what sets it. It has to be longer than a mezzed add's silence, or
killing the primary would close the fight and the add breaking mez would open a second
one — splitting one pull in two. The parser does track `ccStates`, and exempting a CC'd
mob from staleness is the obvious refinement, but it couples `encounter.js` to something
it currently knows nothing about, so: not yet.

## Measured

The reported Plane of Hate slice (7,111 lines, 00:25–00:47), traced encounter by
encounter:

| | before | after |
|---|---|---|
| encounters with damage | 3 | 7 |
| damage scored | 125,698 | 276,572 |
| `Innoruuk`s Chosen` fights | 0 | 4 |
| post-evac encounter | opens 00:26:28, `reason=timeout`, label `Magi P`tasa`, 0 damage | opens 00:27:07, `reason=killed`, label `Innoruuk`s Chosen`, 30,069 damage |

No encounter is labelled `Magi P`tasa` anywhere after the zone line.

Over the whole 1,185,808-line live log:

| | before | after |
|---|---|---|
| encounters recorded | 1,467 | 1,523 |
| damage scored | 24,066,347 | 24,875,893 |
| damage taken scored | 6,130,749 | 6,245,221 |
| encounters with zero outgoing damage | 20 | 15 |
| fights that dribbled out on the idle timer | 299 | 244 |
| warnings raised | 16,236 | 16,336 |

Suite: 667 tests, all passing (was 655).

## Worth saying out loud

- **The alerts get louder, and that is the fix working.** `Innoruuk`s Chosen` raised no
  warnings at all before; it now raises them, including `Allure` (a charm aimed at the
  group), `Immobilize` and `Ensnaring Roots`. Its summon say-line works too, so
  "You have been summoned!" now names who yanked you instead of showing an anonymous chip.
- **Post-evac DoT ticks are now scored nowhere at all.** If the group evacs and someone
  then dies to the DoT still on them, that death goes unrecorded. This is a deliberate
  loss, consistent with the fall-damage precedent — a fight you fled is over — and it is
  written down here so nobody rediscovers it as a bug.
- **History already written is wrong and stays wrong.** Past Plane of Hate encounters were
  recorded with the `Innoruuk`s Chosen` damage missing, and phantom `Magi P`tasa` records
  exist. `scripts/backfill-history.js` can re-derive them from the log on request; not
  done here.

## Files

- `src/parser/entities.js` — two-tier backtick split, `properPossessive`, header rewritten
  (it used to advertise the bug as the design's big idea).
- `src/parser/index.js` — `resolve()` weighs `properPossessive` and refuses to fold a
  hostile display; `markHostileFromDamage()` marks pet-shaped sides by display name;
  `handleDamage()` no longer lets an incoming DoT open a fight; `npcStaleMs` threaded
  through the encounter options; `engage()` calls pass the event timestamp.
- `src/parser/encounter.js` — `aliveNpcs` is a `Map` of last-seen times, `DEFAULTS.
  npcStaleMs`, `dropStaleNpcs()`, called from `update()`.
- `tests/entities.test.js`, `tests/parser.test.js`, `tests/encounter.test.js` — twelve new
  tests across the three defects; the existing "incoming DoT ticks and damage shields
  score as taken" test now opens its pull with an outgoing swing, since the tick alone no
  longer can.
