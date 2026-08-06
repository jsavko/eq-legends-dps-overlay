# Single-token entity identity: other players' pets, PoSky bees, and proc labels

**Date:** 2026-08-06

## The root cause

Three separate-sounding complaints — "no pet procs at all", "procs don't show in the pet
DPS of other players such as shadowknight pets", and "the bees on posky are messing up
the parser" — were one bug and one presentation gap.

`looksLikePlayerName()` is a guess about *spelling*: a single capitalized token with no
article and no backtick. Every one of these passes it:

```
Bzzazzt  Bazzzazzt  Bzzzt          <- Plane of Sky bees
Kibektik  Zararer  Gantik  Lontik  <- other players' summoned pets
Emalina  Rhale                     <- actual players
```

`isFriendly()` fell through to that guess whenever the roster had no opinion, so a PoSky
bee was a group member and a shadowknight's pet was a player. Two consequences, both
severe and both invisible:

- **Every exchange with a bee was dropped.** A friendly hitting a friendly is a mis-parse
  and scores nothing, in either direction. Over lines 793,000–845,000 of the live log
  that silently discarded the great majority of the group's output — Syphon reported
  31,315 damage where the real figure is 576,636.
- **The alert system was off for the whole island.** 639 `<bee> begins casting Deadly
  Poison.` lines raised **zero** warnings, and Deadly Poison is what killed the group
  (`Kadomony has been slain by Bzzazzt!`).

The proc complaint did not survive contact with the log at all. Pet weapon procs have
always been parsed, attributed and displayed — 746 `has been struck by the force of
Ykesha.` flavour lines pair exactly 1:1 with 746 damage lines, all matched by the
existing `spell-damage` rule. What was missing was a *label*; group totals do not move.
The reason other players' pet procs looked absent is that those pets' damage never
reached their owner's row in the first place.

## What changed

### Behaviour now outranks name shape (`isFriendly`)

The order is now membership the game stated → behaviour → the shape of the name:

1. An override, the logging character, or an explicit `has joined the group.` line.
2. **Proof by action.** An entity that damaged a confirmed group member, or that a
   confirmed member damaged, is hostile whatever it is called (`hostileByAction`, session
   -long). Engagement in the running encounter says the same thing — the reasoning
   `isHostileCaster` has always used and `isFriendly` never learned.
3. `looksLikePlayerName`, last, as it was always meant to be.

Confirmed membership only, deliberately: keying off the implicit set would let one bad
guess cascade into a second. The friendly-fire branch of `handleDamage` now works through
possibilities in order of how much the log proves — charm break, then a weak pet binding,
then hostility — and re-scores the line the moment one resolves. A charmed mob turning on
the group still reads as a charm break, never as a fresh enemy.

### Other players' pets fold into their owners

A summoned pet gets a *generated* name with none of the backtick possessive that makes
`` Rhale`s warder `` self-describing. Four new signals bind them:

- **Summon flavour lines** (confirmed): `<Owner> animates an undead servant.`,
  `<Owner> summons a {frenzied|guardian|companion} spirit.`,
  `<Owner> summons forth a minor familiar.` These name the owner outright and arm a
  pending slot the next previously-unseen name consumes.
- **Pet-only buffs** (confirmed): `Khanvikt begins casting Augment Death IV.` five seconds
  before `Kibektik's eyes gleam with madness.` Matched on the SPELL name rather than
  "whoever was casting", exactly as charm attribution is, so it survives a busy fight —
  and it corrects a mis-bind the temporal path may have made. `Kibektik shrinks.` alone
  proves nothing (`Khanvikt shrinks.` follows the shaman's Shrink and Khanvikt is a
  player); only the pairing is evidence.
- **Summon-shaped casts**, for the magician animation, which prints no flavour line at all.
- **An in-game command** (below), and the existing settings mapping.

Guards throughout: two summons pending at once binds nothing; a name with player proof is
never claimed; a binding is torn down and blacklisted the moment its "pet" trades blows
with the group. Only a name acting — swinging, casting, healing — can consume a pending
summon, never one we merely hit.

### A third state: unknown

An article-less single token with neither player proof nor a pet binding is now *unknown*,
not a player. It is not trusted to explain unattributed damage and cannot arm a summon
slot (`isProvenFriendly`). It does still get a visible row: dropping its damage would make
the group total quietly wrong, and requiring proof before showing anything is precisely
what made "target everything first" unusable — nobody targeted a bee all night.

### Player proof

Talking on a group, guild, raid or custom channel needs a player client, so those lines
now mark `knownPlayers`, as do group join/leave lines. Bare `says,` is excluded — mobs
use it for summon call-outs — and so is `tells you`, which is how a pet reports to its
Master.

### An in-game mapping command

`pet Kibektik = Khanvikt`, `pet Kibektik = none`, `pet ?` typed into any of the five
self-chat forms the client actually logs (`/say`, `/p`, `/rs`, `/gu`, a custom channel).
Not tied to one channel: party chat does not exist when solo, which is exactly when you
would be mapping your own pet. Only the **self** form matches — everyone else's chat lands
in the same log, and a third-person rule would let anyone in /general reconfigure the
overlay. The mapping persists through the existing `petOwners` config, and the reply
appears in the alerts window, because a command that silently does nothing is worse than
no command.

### Proc labels

Damage-dealing abilities with no cast line behind them are now labelled `(proc)` /
`(pet proc)`, counted in a `procDamage` total, and shown as a `procs` chip in the overlay
breakdown and a `N proc` figure in the history head line. Both render **always**, zero
included, so they cannot push the ability list around. One row per ability per member is
preserved: the label is derived at snapshot time and cleared retroactively if a cast
finally shows up, so no fight ends mislabelled and no stale row is stranded.

The flavour half (`... has been struck by the force of Ykesha.`) is matched as a typed
no-op — it carries no damage, and scoring it would count every proc twice.

## Verified

- `npm test`: **310 passing** (was 289). 21 new cases covering hostility by action, charm
  break precedence, player proof, all four binding paths, the ambiguity rule, the unbind
  path, the command across five channels plus third-party and malformed forms, and procs
  including the retroactive relabel and the spell-rank case.
- **Full live log** (881,945 lines, `eqlog_Rhale_oggok.txt`): the warder's proc set is
  exactly the seven abilities predicted and no others — Spirit of Scorpion / Inferno /
  Vermin / Blizzard / Lightning Strike, Ykesha, Ignite. `Ykesha (pet proc)` totals 9,235.
  25 pets bound to owners, including `Gann = Rhain`, which confirms the mapping the repo
  has carried as an example since the beginning.
- **PoSky replay** (lines 793,000–845,000): all three bee names hostile; **629 of 639**
  Deadly Poison casts now warn; `Kibektik` folds into Khanvikt (237,347 total, 127,282 pet)
  with `Specter Lifetap (pet proc)` at 10,686 in his breakdown, and has no row of its own.
- `collect-unknown.js` over the same slice: every new rule fires, nothing regressed.

## Notable during implementation

- **The plan's bare-cast binding was wrong and was narrowed.** "Any friendly cast arms a
  weak slot that only a previously-unseen name can consume" cannot work: every player is
  previously-unseen exactly once, so `Emalina casts → Rhain casts` (a player) is
  structurally identical to `Rhain casts Sagar's Animation → Gann casts Center` (a pet).
  The first version folded a groupmate into a healer's row and the existing charm test
  caught it. The slot is now armed only by a summon-SHAPED spell name — structural
  (`<X>'s Animation`, `Summoning`, `Familiar`), not an enumeration, and the same
  reasoning `CHARM_SPELL_RE` already rests on.
- **`spellStem` was not foreseen.** The cast line carries a rank the damage line does not
  (`Frost Storm VIII` vs `Frost Storm`), so every ranked spell in the game read as an
  ability that is never cast — 163k of Syphon's damage was labelled a proc before the
  stem was added.
- **`shouts` was dropped from player proof.** The plan listed it; EverQuest mobs shout,
  and the live log contains zero player shouts, so it was pure risk for no coverage.
- **Two pre-existing chat bugs** surfaced and were fixed: channel names carry digits on
  this server (`General2:1`, `NewPlayers1:2`) and did not match the chat rule, and
  `You told <name>,` matched no self-chat rule — both left those lines to fall through to
  the damage rules, where quoted combat text would score.
- The group join/leave wordings, carried as unverified classic-EverQuest guesses since
  Phase 0, are **confirmed**: 21 third-person and 16 self lines in the live log, worded
  exactly as `rules.js` already had them.

## Files

- `src/parser/roster.js` — `hostileByAction`, `learnedPetOwners`/`notPets`,
  `pendingSummon`, `bindPet`/`unbindPet`, `isConfirmedMember`, `hasPlayerProof`,
  `noteKnownPlayer`.
- `src/parser/index.js` — `isFriendly` reordered; `isProvenFriendly`; `resolveFriendlyFire`
  and its three paths; `handlePetSummon`, `handlePetBuff`, `handlePetCommand`;
  `castObserved` + `isProc`; `notices`; `unmappedEntities`; the reflexive-pronoun disproof
  recorded so it is not rediscovered.
- `src/parser/rules.js` — pet-summon, pet-buff, pet-command and proc-flavour rules; chat
  rule captures speaker and channel; `spellStem`; group wordings marked confirmed.
- `src/parser/encounter.js` — `procDamage`, `abilityRow`, `unmarkProc`, proc-aware labels.
- `src/main/main.js`, `src/main/ipc.js` — `persistPetOwners`, `PETS_STATE`.
- `src/renderer/overlay/{overlay.js,overlay.css}` — procs chip, `data-proc` marking.
- `src/renderer/history/{history.js,history.css}` — proc total and row marking.
- `src/renderer/alerts/{alerts.js,alerts.css,index.html}` — command acknowledgements.
- `src/renderer/setup/{setup.js,setup.css,index.html,preload.cjs}` — learned mappings and
  clickable unmapped names beside the `Pet = Owner` box.
- `tests/parser.test.js`, `tests/rules.test.js` — 21 new cases.
