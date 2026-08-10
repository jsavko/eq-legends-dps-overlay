---
status: completed
---
# Evac ghosts and the backtick mob

**Date:** 2026-08-10

---

## Goal

The reported symptom: evacuating out of a Plane of Hate pull "broke the parser" — the
meter went on showing a fight against a mob the group had fled and never returned to,
and only Ctrl+Shift+R (reset encounter) plus a new session put it right.

Replaying that exact session (`eqlog_Rhale_oggok.txt`, Mon Aug 10 00:25–00:47, Plane of
Hate) reproduces it, and shows the evac was the *trigger*, not the cause. Three separate
defects stacked up:

1. **A mob whose proper name contains a backtick possessive is read as somebody's pet.**
   `entities.js` folds ``X`s Y`` into owner `X` unconditionally. **`Innoruuk`s Chosen`**
   therefore resolves to a combatant named `Innoruuk`, which is a single capitalized
   token, which `looksLikePlayerName` calls a player, which makes it *friendly*. Every
   line in either direction then reads as friendly-fire and is silently dropped:
   `markHostileFromDamage` refuses to touch a pet-shaped side (`side.isPet` → `continue`,
   there so a pet can never brand its owner an enemy), so nothing ever corrects it.
   Measured over the whole live log: **409,749 outgoing damage, 95,983 incoming damage
   and 105 hostile cast lines** (Allure, Immobilize, Ensnaring Roots — the charm and the
   root the group most needs warning about) scored and warned nothing at all. In the
   evac session this is what actually froze the meter: the group fought `Innoruuk`s
   Chosen` for eight minutes and the overlay never registered a single point of it.

2. **Lingering DoT ticks from the mob you fled open a phantom encounter.** After the
   succor, `Rhain has taken 124 damage from Wrath of the Elements by Magi P`tasa.` kept
   arriving every 6s. The zone line had correctly closed the fight; the first tick opened
   a fresh encounter labelled **`Magi P`tasa`** with zero outgoing damage. That is
   literally the reported "still fighting a mob we never went back to" — the meter's
   headline was a mob in a room the group had left. It also reaches history:
   `main.js:466` only skips a record when damage *and* damage-taken are both zero, so the
   phantom is filed as a fight.

3. **A mob that leaves a fight without dying stays "alive" forever**, blocking the
   all-slain close for the rest of the encounter. `engagedNpcs`/`aliveNpcs` only drain via
   `npcDied`. The fled `Magi P`tasa` sat in `aliveNpcs` for the whole next encounter,
   which could then only ever end on the 15s idle timeout — and any pull chained inside
   15s merges into it. Confirmed in the prototype trace below: the post-evac encounter
   closed `reason=timeout ... alive=[Magi P`tasa]` where every clean fight in the same
   session closed `reason=killed ... alive=[]`.

The goal is to fix all three, keeping the project's standing rule that identity is
decided by what the log *proves*, never by what a name looks like.

### Evidence

Prototype run (pet split tightened to a lowercase noun, everything else untouched) over
the same 7,111-line slice:

| | before | after |
|---|---|---|
| encounters with damage | 3 | 7 |
| damage scored | 125,698 | 276,572 |
| `Innoruuk`s Chosen` fights | 0 | 4 |

Full suite stayed green (655/655) with that one-character-class change, so nothing in the
codebase depends on a capitalized pet noun.

## Approaches Considered

### 1. Treat it as an evac bug only — close the encounter harder on zone
- **Description:** Add a "you fled" concept: on a zone line, remember the NPCs left
  behind and refuse to score anything from them for a while.
- **Pros:** Directly targets what the user reported; small, local change.
- **Cons:** Fixes the *trigger* and not the cause. The 8-minute `Innoruuk`s Chosen` fight
  would still be invisible, the meter would still look frozen, and the same freeze would
  keep happening in every Plane of Hate pull with no evac in sight. Rejected.

### 2. Pet split requires a lowercase possessed noun
- **Description:** `PET_RE = /^(.+?)`s\s+([a-z].*)$/`. EQ writes pets as generic nouns
  (`Rhale`s warder`, `Someone`s pet`) and proper names title-case (`Innoruuk`s Chosen`,
  `Hierophant`s Crook`), so capitalization is the game's own generic/proper distinction.
- **Pros:** One line; verified against every backtick-possessive name in the live log
  (~186k occurrences), where every real pet is lowercase and every non-pet — mob or item —
  is capitalized; whole suite green; recovers 150,874 of the slice's missing damage on its
  own. Keeps `entities.js` pure and table-free.
- **Cons:** Still a *shape* rule, which is the class of rule that produced this bug. If EQ
  Legends ever prints `Someone`s Warder`, that pet stops folding into its owner and — worse
  — reads as an NPC, i.e. a new silent loss.

### 3. Fold a pet only when the owner has standing
- **Description:** Require `roster.hasPlayerProof(owner)` before ``X`s Y`` folds into `X`.
- **Pros:** Pure evidence, no shape guessing; `Innoruuk` has no proof and never folds.
- **Cons:** Breaks the common case. `Rhazendude`s warder` swings long before Rhazendude
  says anything, so another player's pet would spend most of a session as its own
  unattributed row. Too expensive as the *only* gate.

### 4. Proof by action — let a backtick entity be marked hostile once it trades damage
- **Description:** Extend `markHostileFromDamage` to mark a pet-shaped side by its
  *display* name (never its owner) when the other side is a confirmed member, and have
  `LogParser.resolve()` stop folding a display that is `hostileByAction`.
- **Pros:** Self-correcting and shape-independent — the same machinery that fixed the
  Plane of Sky bees (`docs/changelog/2026-08-06-single-token-entity-identity.md`). Catches
  a lowercase-nouned mob name that rule 2 would wave through.
- **Cons:** Reactive: the first few lines of the first pull are still lost, and it needs a
  confirmed group member on the other side. Not sufficient alone.

### 5. Layer 2 + 3 + 4 (chosen)
- **Description:** A two-tier split plus the self-correcting backstop. Details below.
- **Pros:** Right answer on the first line for every name in the live log, a principled
  answer for the capitalized-pet case rule 2 gets wrong, and a proof-by-action net under
  both.
- **Cons:** ~30 lines across two files instead of one; three code paths to test.

## Chosen Approach

**Approach 5**, plus the two encounter-lifecycle fixes.

**Identity.** `entities.js` keeps the backtick split but only calls it a pet when the
possessed noun is **lowercase** — a generic noun, which is how the game writes pets. When
the noun is capitalized the string is returned as one whole entity (`Innoruuk`s Chosen`),
with the attempted split reported alongside as `properPossessive: {owner, noun}` rather
than thrown away. `LogParser.resolve()` — which, unlike `entities.js`, can see the roster —
folds a proper possessive into its owner only when that owner `hasPlayerProof`, so a
hypothetical `Rhale`s Warder` still lands on Rhale while `Innoruuk`s Chosen` stays a mob.
That division of labour is the one the two files already have: shape lives in
`entities.js`, evidence lives in the parser.

Underneath, `markHostileFromDamage` learns to mark a pet-shaped side by its display name
when the owner has no player proof, and `resolve()` refuses to fold a display already
marked hostile — so any backtick mob that slips through the shape rule corrects itself the
first time it trades a blow with the group, and stays corrected for the session.

**Encounter lifecycle.** An *incoming* DoT tick may extend an encounter but never opens
one, on the same principle as the fall-damage rule already in `handleUnattributed`: a mob's
residual DoT ticking on you is not proof you are fighting it. Outgoing ticks keep their
power to open a fight, because a DoT you cast is a choice you made and is often the first
damage line of a pull. And `aliveNpcs` gains a last-seen timestamp so an NPC that has been
silent in both directions for longer than a generous window stops blocking the all-slain
close — a mob that left is not a mob you are still fighting.

## Tasks

- [x] `src/parser/entities.js`: tighten `PET_RE` to require a lowercase possessed noun, and
      return `properPossessive: {owner, noun}` on the capitalized form instead of dropping
      the split. Rewrite the file header comment — it currently *advertises* the generic
      match as the design's big simplification, and that is the bug.
- [x] `src/parser/index.js` `resolve()`: fold a `properPossessive` into its owner only when
      `roster.hasPlayerProof(owner)`; otherwise keep the entity whole.
- [x] `src/parser/index.js` `resolve()`: never fold a backtick pet whose `display` is
      `roster.isHostileByAction(...)` — return it as a plain NPC instead.
- [x] `src/parser/index.js` `markHostileFromDamage()`: replace the blanket `if (side.isPet)
      continue` with a mark on `side.display`, guarded by
      `!roster.hasPlayerProof(side.owner)` so a real pet can still never brand its owner.
- [x] `src/parser/index.js` `handleDamage()`: in the `targetFriendly` branch, skip
      `ensureEncounter` when `event.source === 'dot'` and no encounter is live — the tick
      scores nothing and opens nothing. Comment the asymmetry with the outgoing side.
- [x] `src/parser/encounter.js`: make `aliveNpcs` a `Map<name, lastSeenTs>` fed by
      `engage()` and `addDamageTaken`/`addDamage`; add `DEFAULTS.npcStaleMs` (60s) and have
      `update()` drop stale entries before the all-slain check, arming `allSlainAt` if that
      empties the set. `engagedNpcs` is untouched — the fight must still be able to name
      every mob in it.
- [x] `tests/entities.test.js`: ``Innoruuk`s Chosen`` is not a pet and keeps its whole name;
      every lowercase pet noun still folds; `properPossessive` is reported.
- [x] `tests/parser.test.js`: the group damaging ``Innoruuk`s Chosen`` scores and engages it;
      it hitting a member scores as damage taken; its casts raise hostile-cast warnings; a
      lowercase-nouned mob name is corrected by proof of action on the first trade; a real
      warder is never marked hostile by friendly-fire.
- [x] `tests/parser.test.js`: an incoming DoT tick with no live encounter opens nothing; the
      same tick inside a live encounter still scores and still extends it.
- [x] `tests/encounter.test.js`: a mob silent past `npcStaleMs` no longer blocks the
      `killed` close; one still inside the window does.
- [x] Verify on the real log: re-run the trace over the Plane of Hate slice and confirm the
      post-evac encounter opens at the re-engage (00:27:07, not 00:26:28), closes
      `reason=killed`, and that no encounter is ever labelled `Magi P`tasa` after the zone
      line. Record before/after totals.
- [x] `npm test` green.
- [x] `docs/changelog/2026-08-10-evac-ghosts-and-the-backtick-mob.md` — the three defects,
      the measured damage that was invisible, and why the pet split is now two-tier.
- [x] `taskkill.exe /IM "EQL DPS Overlay.exe" /F` then `scripts/dev.sh dist`, so the
      win-unpacked build James launches actually has the fix.

## Notes

- **The alerts get louder, correctly.** 105 previously-silent hostile casts from
  `Innoruuk`s Chosen` — including `Allure` (a charm aimed at the group) and `Immobilize` —
  will start raising warnings. That is the fix working, but it is a visible change in
  behaviour on the next Hate run and worth saying out loud.
- **History already written is wrong and stays wrong.** Past Plane of Hate encounters were
  recorded with the `Innoruuk`s Chosen` damage missing, and phantom `Magi P`tasa` records
  exist. `scripts/backfill-history.js` could re-derive them from the log if the user wants
  them repaired; not in scope here.
- **Why 60s for `npcStaleMs`:** it has to be longer than a mezzed add's silence, or killing
  the primary would close the encounter and the add breaking mez would open a second one —
  splitting one pull in two. 60s is comfortably past a mez tick and still far short of the
  8-minute merge this is here to prevent. If that proves too coarse, the parser already
  tracks `ccStates`, and exempting a CC'd mob from staleness is the refinement — but it
  couples `encounter.js` to something it currently knows nothing about, so not yet.
- **Open question:** the post-evac DoT ticks are now scored nowhere at all. If the group
  evacs and someone then dies to the DoT, that death goes unrecorded. Consistent with the
  fall-damage precedent (a fight you fled is over), but it is a deliberate loss and the
  changelog should say so rather than let someone rediscover it as a bug.
- Reproduction slice and trace script are in the session scratchpad:
  `hate-evac.txt` (log lines 1178530–1185640) and `trace.mjs`, which prints every
  encounter open/close with its reason and its surviving `aliveNpcs`.

### Verification (2026-08-10)

Traced with `trace.mjs` over the Plane of Hate slice, HEAD parser vs patched parser:

- post-evac encounter now opens **00:27:07** (the re-engage) instead of 00:26:28 (the
  first stray DoT tick), and closes `reason=killed label=Innoruuk\`s Chosen dmg=30069`
  where it used to close `reason=timeout label=Magi P\`tasa dmg=0`.
- no encounter is labelled `Magi P\`tasa` anywhere after the zone line.
- encounters with damage 3 → 7; damage 125,698 → 276,572; four `Innoruuk\`s Chosen`
  fights where there were none.
- three previously-silent hostile-cast warnings from `Innoruuk\`s Chosen` in the slice,
  and its summon say-line now names the caster (the two anonymous `caster=null` summon
  chips are gone).

Whole live log (1,185,808 lines): encounters 1,467 → 1,523; damage 24,066,347 →
24,875,893; damage taken 6,130,749 → 6,245,221; zero-outgoing-damage encounters 20 → 15;
timeout closes 299 → 244; warnings raised 16,236 → 16,336.

Suite 667/667 green (was 655).
