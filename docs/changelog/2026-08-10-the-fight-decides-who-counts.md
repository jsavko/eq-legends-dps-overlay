# The fight decides who counts, not the roster

**2026-08-10** — supersedes `2026-08-10-a-charmed-friend-is-still-a-friend.md`, which
fixed one instance of this bug by making the friend test cleverer.

James, on reading that fix:

> "Why do we care if it's a friendly target or not? It seems you're hung up on trying to
> detect who is a friendly and who isn't when the important part is anyone attacking the
> same mob/encounter/fight should show up regardless of who they are. If I get charmed
> and start attacking a player it's fine for me to show up in their damage logs. If a npc
> gets charmed it's fine for them to show up in the dps logs. Again we can always set
> filters as i requested in settings to limit who shows up if it becomes a problem."

He was right, and the earlier fix was solving the wrong problem carefully.

## The measurement that settled it

Every damage line the parser dropped, bucketed against the fight that was running:

| Dropped | Lines | Damage |
|---|---|---|
| Aimed at a mob the encounter was **already fighting** | 3,486 | 219,010 |
| Dealt **by** a mob the encounter was already fighting | 240 | 17,372 |
| Genuinely unrelated to the fight on screen | 1,007 | 65,508 |

The largest single entry was `loathling lich` — **1,012 lines, 84,676 damage** — a mob
the group had charmed, beating on the boss alongside everybody else. Its damage was
discarded solely because `attributeCharm` could not work out *who* had charmed it. The
old design's answer to "I can't tell whose this is" was to throw it away.

## The new rule

One sentence, and there is no friend test anywhere in it:

> **Damage landing on the mob this fight is against counts, whoever landed it. Damage
> coming from that mob is damage somebody took, whoever they are.**

`Encounter#engagedNpcs` is the axis. `handleDamage` now reads as four questions:

1. is the target a mob we are already fighting? → credit the attacker, no questions asked
2. is the *attacker* one? → credit the target as damage taken, unless the victim is a
   mob we are also fighting (infighting, belonging to neither side) or a mob-shaped
   bystander that has never contributed anything to this fight. A mob-shaped victim that
   HAS already dealt damage here is in the fight — which is exactly what a charmed pet
   looks like from the outside: it beats on the boss, the boss beats back
3. neither, so which end *would* be the enemy, from standing alone? That opens or extends
   the fight. Two mobs going at each other is not our fight and cannot open one.
4. both ends are ours, which means somebody has been turned — see below

The Plane of Sky bees fall out of this for free. You hit `Bzzazzt`, so `Bzzazzt` is the
fight, so everything it does is damage taken. No `looksLikePlayerName`, no branding, no
revocation, no session-long memory that could be wrong.

## What was deleted

- `isFriendly` — the friend test the whole scoring path used to run through
- `isProvenFriendly`'s role as a scoring gate (it survives only for the two things that
  genuinely need standing: owning a summoned pet, and explaining unattributed damage)
- `isUnownedPet` — unowned pets now get rows because they hit the mob, not because a
  special case says they may
- `hostileByAction` / `noteHostileByAction` / `isHostileByAction`
- `friendlyByAction` / `noteFriendlyByAction` / `hasFriendlyProof` — yesterday's fix
- `markHostileFromDamage` and `resolveFriendlyFire`

What replaced them is `standing(name)`, which answers `'ours' | 'enemy' | null`, and is
consulted **only** to seed a fight. Facts first (the logging character, the party list),
then what the game stated outright, then channel chat, then the implicit set, then name
shape. Its failures are cheap by construction: a column in one fight rather than a person
for a session.

Name shape now answers **one way only**. `looksLikeMobName` says "certainly a mob";
nothing says "certainly a player", because "Bzzazzt" is spelled exactly like one. A bare
capitalized token is left unanswered for the fight to place — which means the very first
line of a pull where neither end is placeable simply does not open a fight. That costs a
line or two at the start of a pull nobody in the roster has been seen in before, and it
is the honest price of never inverting a fight.

Two subtleties the live log forced out, both about pets:

- **A pet is only as ours as its owner.** `` Dreadlord`s minion `` is a mob spelled
  exactly like a pet, and "Dreadlord" is an owner nobody has ever heard of, so the pet
  inherits no standing and the hit it lands on the logging character reads as incoming.
  A real warder's owner is a group member, so it reads as ours.
- **A charmed mob is ours under its own name.** It resolves to its *charmer*, who may be
  a shaman nobody has seen act yet, so `standingOf` reads the charm from the display name
  before anything else. Getting this wrong engaged the charmer as a mob.

## What this changes on screen

**A charmed mob gets its own row.** `a loathling lich` with 84,676 damage on a Plane of
Fear night is now a row on the meter. Its charmer usually cannot be identified, so the
choice was between showing it as itself and throwing the damage away. It shows as itself.

**A mob that helps kill your mob also gets a row**, charmed or not, because the log does
not distinguish the two and pretending otherwise is the guessing this change exists to
stop. Measured: 110,174 damage across the session goes to entities that are themselves in
some enemy set, and the top eight are all mob types the group is known to charm. The
filter for this is the party list, as requested.

**A charmed member's swings land in the victim's damage-taken**, naming them as the
attacker — "if I get charmed and start attacking a player it's fine for me to show up in
their damage logs" — and in nobody's DPS, because that column measures damage done to the
enemy. The `Charmed` chip still goes up on the alerts window, since EQ Legends prints
nothing when a player is charmed and nothing when it breaks. It is now a display feature
and not an attribution mechanism, and it names a member only when it can tell which one.

**Healing mirrors damage**: a heal counts when it lands on our side, which is one test on
the target rather than a friend test on the healer. `Bonefire healed orc legionnaire for
20 hit points by Courage.` is an orc topping up an orc and scores nothing.

## Verified against the live session

Replaying all 1,282,562 lines:

| | Before | After |
|---|---|---|
| Damage lines dropped | 4,733 | **219** |
| Damage discarded | 301,890 | **44,462** |
| Total scored | 33,848,834 | **34,106,262** |
| `Goneker` (water elemental) | 0 after branding | **87,612** |
| `Vabann` | 0 after branding | **13,452** |
| `a loathling lich` | 0 | **84,676** |
| `a fire giant warrior` | 0 | **51,629** |

The 219 that still drop are the ones that should: real self-damage (`Syphon -> Syphon`,
`Venun -> Venun`), and genuine mob-on-mob between two things neither of which is in our
fight (`A swampwater crocodile -> a froglok sentry`).

706 tests pass.

## An article means "one of these"

The first cut of this still dropped 1,488 lines, and James spotted why in the sample:

> "A fire giant warrior -> a fire giant warrior that's bullshit because it isn't attacking
> itself, so it should show up as a friendly and a foe"

Correct. The self-damage guard compared display names, and two mobs of the same type share
one. The discriminator is the **article**: `Venun` names exactly one entity, so
`Venun hit Venun` really is a shaman spending health on mana; `a fire giant warrior` names
a type, so `A fire giant warrior cleaves a fire giant warrior` is two giants — one of them
almost certainly the group's charmed pet. Self-damage now requires both sides to be
article-free.

That alone recovered 789 lines and 58,916 damage, and it exposed the next layer: our own
charmed mobs were still being dropped when the boss hit *them* back, because a mob-shaped
victim was excluded outright. Participation replaced shape there — a victim that has
already dealt damage in this fight is in this fight — which took the remaining drops from
595 lines to 219 and moved the lich from 71,795 to its full 84,676.

## Files

| File | Change |
|---|---|
| `src/parser/index.js` | `handleDamage` rewritten onto the fight's axis; `creditDamage` / `creditDamageTaken` split out; `standing` / `standingOf` / `isEnemy` replace `isFriendly` / `isUnownedPet`; `handleMiss`, `handleHeal`, `handleResist`, `handleEffect`, `handleCharm`, `handleDeath`, `isHostileCaster`, `handleUnattributed`, `unmappedEntities` all re-pointed |
| `src/parser/roster.js` | the hostile and friendly brands deleted; header rewritten around seeding rather than gating |
| `src/parser/entities.js` | `looksLikeMobName` — the one-way shape test |
| `CLAUDE.md`, `docs/architecture.md` | the invariant restated: the fight decides, name shape answers one way |
| `tests/parser.test.js`, `tests/roster.test.js` | rewritten onto the new axis |

## Still open

**Mob infighting inside your own pull is credited.** If two mobs the group has engaged
fight each other, the attacker gets a DPS row. It is indistinguishable from a charmed pet
helping, which is what it usually is, and the deliberate choice is to show it rather than
guess. If it ever reads as noise on a specific fight, the party list is the answer.

**Two same-named mobs share one row.** `a fire giant warrior` beating on
`a fire giant warrior` credits and debits the same key, so the charmed one and the boss's
adds pool together. There is nothing in the log to separate them — EQ writes both as the
same string — and inventing a suffix would be inventing identity.
