# A charmed friend is still a friend

**2026-08-10**

James: "Occasionally people don't appear on the parser that should."

They were not missing from the renderer. They were being deleted in the parser, by the
mechanism that exists to stop a mob being counted as a player — and deleted for the rest
of the session, with nothing on screen to say so.

## How it was found

Vague reports need measurement, not reading. `LogParser` was instrumented and the whole
live session replayed — `eqlog_Rhale_oggok.txt`, 1,282,562 lines, 1,690 encounters —
recording two things: every damage line that scored nothing, bucketed by *why*, and the
exact log line behind every call that can remove a name from view (`noteHostileByAction`,
`bindPet`, `charm`).

That produced a suspect immediately. A name called `Goneker` was dropping 1,362 damage
lines and 69,394 damage as "neither side friendly", while quite plainly fighting the mob
the group was fighting:

```
[Sat Aug 08 00:21:52] Goneker pierces a revultant rat for 83 points of damage. (Critical)
[Sat Aug 08 00:21:52] Goneker hit a revultant rat for 49 points of cold damage by Water Elemental Attack.
```

A magician's water elemental, in other words. The branding line was nine minutes later:

```
[Sat Aug 08 00:31:47] Goneker cleaves Cleric of Innoruuk for 70 points of damage.   <- fighting the mob
[Sat Aug 08 00:31:47] Goneker cleaves Syphon for 34 points of damage.               <- ?
[Sat Aug 08 00:31:47] Goneker is pierced by Syphon's thorns for 24 points ...        <- branded an enemy
```

Syphon is a confirmed group member, and `markHostileFromDamage` reads "traded damage with
a confirmed member" as proof of hostility. Syphon was charmed. Three minutes earlier
Syphon had been casting on the group and taking a Frost Storm from Nural.

**EQ Legends prints nothing when a player is charmed.** The log has 35 `has been charmed.`
lines and every one of them names a mob; zero name a player. James already knew, and had
typed it into party chat mid-pull:

```
[Wed Aug 05 22:51:02] You tell your party, 'i hate that if i get charmed it destorys my pet'
```

So the pet swung at the member the group was swinging at, and became an enemy forever.
`hostileByAction` was session-lifetime and one-way: `isFriendly` returned false from that
instant, `resolve()` stripped its pet-hood, `implicit` dropped it and `notPets`
blacklisted it so no later summon could re-bind it. The only escapes were a channel
message from that name — pets never talk — or a character switch.

A second friendly pet, Vabann, went the same way three days earlier when Venun was
charmed. Both victims were pets, which is luck rather than design: the guards that saved
the human raid-mates in this log are group membership and having spoken on a channel. A
raid-mate in another group who never types anything and gets charmed once was gone for
the night.

## The fix: proof in the friendly direction

Hostile proof was one-sided, so it got a mirror. `Roster#friendlyByAction` records
entities proven friendly by something done **to** them, and it both blocks a branding and
revokes one that has already happened.

Exactly one act feeds it, chosen because it is a measurement rather than a guess: **being
healed by a proven friendly**. Nobody heals an enemy. Tested against all twenty brandings
in the live log it separates them 20/20 — the two wrongly-branded pets were healed by
group members, every real mob never was, and the one mob that *is* healed
(`Knight V'Tal`) is healed by `a Teir'Dal ranger`, which the proven-friendly guard on the
*healer* already excludes.

Two things it deliberately does **not** do:

- **"It damaged something we are also fighting" is not admitted.** Tempting, and wrong:
  the Plane of Sky bees were scored as friendly right up until the moment they were
  branded, so any acted-friendly signal is available to a mob too, and admitting one would
  hand it exactly the immunity this set exists to grant. A heal names its *target*, and
  nobody heals a bee.
- **Only shape-dependent names can collect it** — a single capitalized token
  (`Goneker`, `Vabann`, every real player) or a generic possessive (`` Rhale`s warder ``).
  That restriction is not tidiness; the first version lacked it and the live log caught
  the consequence. The group heals the mobs it charms, so five charmed mobs collected
  permanent friendly standing, including a loathling lich whose 85,374 damage would then
  have scored as the group's own once the charm broke. A name carrying an article or a
  space was never friendly by shape, so it was never at risk and needs no protection.

## The charm the log never mentions

With Goneker accounted for, the impossible line has one explanation left, and the parser
now names it. `noteMemberTurned` raises a `charm` member state on the group member —
which the alerts window has rendered as "Charmed" since the CC work — and scores neither
side. It runs **last**, after every identity fix has declined, behind two guards:

- the other side must carry friendly proof, so it is known not to be an enemy with a
  player-shaped name. Without this the rule is a catastrophe: `Bzzazzt hit you for 100
  points of poison damage` would read as *you* being charmed rather than as a Plane of Sky
  bee, and the mechanism that fix depends on would never fire again.
- that side must not itself be a confirmed member, because then both sides are equally
  accounted for and naming one of them is a coin flip. Two group members trading blows
  means one of them turned and the log does not say which; the honest answer is silence.

The state ends when the member next damages the mob — the only end-signal a charm has,
since EQ Legends prints nothing for the break either — with the existing 30s cap as the
backstop.

Neither side is scored. A charmed member's swings are not group damage, and filing them
as damage taken would put a friend's name in the victim's "what is killing me" list. The
chip is what explains the missing number.

Self-damage is now dropped explicitly rather than being sent through machinery built to
decide which of two entities was misread: `Venun hit Venun for 1924 points of unresistable
damage by Cannibalization I.` is a shaman buying mana with life, 18 lines and 20,965
points of it. The test is on the **display** names with both sides required to be
non-pets — never on the resolved ones, because a pet resolves to its owner, so
`A tal ghoul wizard slashes YOU` from a charmed mob has the same name on both sides while
being the exact opposite of self-damage. Getting that wrong broke the charm-break path,
and the existing tests caught it.

## Three rule gaps, all of them just missing

Found by the same measurement, and each one a person's numbers reading low:

| Gap | Lines in the live log |
|---|---|
| `reave` was not in `ATTACK_VERBS` | 1,374 hits + 1,264 misses, across 8 players (Glorb 536, Rhain 416, Syphon 112, Ribbers 100, …) |
| Heals with no `by <Spell>` clause matched no rule | 4,715 (`You healed Rhale for 92 hit points.`) |
| `tormented` was not a damage-shield verb | 225 (`… is tormented by Kadomony's frost for 12 points of non-melee damage.`) |

The spell-less heal is labelled `Unknown`, the way unattributed damage already is. What
produced it is not stated and not guessable, and crediting it to whatever the healer last
cast would be inventing a number.

`collect-unknown.js` now matches 1,130,478 lines where it matched 1,121,548 — 8,930 lines
that were being read and discarded.

## The party list replaces "show only my group"

> "Settings should have a list of party members if we want to specifically parse only
> specific people, otherwise anyone in the log should be showing up." — James

`groupOnly` filtered on membership the parser had **inferred** from group join and leave
lines, and it had the same failure shape as everything above: `hasExplicitData` flipped
true on any group line, and anyone already in the group when logging began was never in
`explicit`, so the first join or leave by somebody else dropped them from the view
silently. Nothing on screen said what had been decided or why.

It is replaced by `partyMembers`, a list the player types. Empty — the default, and the
migration target for a stored `groupOnly: true` — means no filter at all. Non-empty means
that list and nothing else, including the logging character unless listed.

It is a **display** filter and nothing more. `roster.inParty()` is read where rows are
chosen and never by `isFriendly`, so hiding a row changes no attribution: clear the list
and the fight on screen is the same fight with more rows. `roster.includes()` lost its
`groupOnly` parameter entirely and is now purely the identity question.

The settings form gains a Party list box above Named pets, with a caption that says what
empty *means* rather than leaving a blank field looking broken, and a live check of what
was typed against who the parser has actually seen. A mistyped name in a filter does not
fail — it hides a person and says nothing, which is this entire bug — so an unrecognised
name is called out with the nearest real combatant offered. Offered, never applied:
`nearestName` returns null on a tie precisely so a coin flip is never presented as an
answer, the same refusal `pet X = Y` makes.

The check runs in main over the new `roster:check` channel rather than in the renderer,
because `nearestName` lives in the parser, no renderer reaches into `src/parser`, and
copying an edit-distance routine into a settings form to avoid one IPC call is the worse
trade. It returns a verdict, like `logs:validate` does.

## Verified against the live session

Replaying the same 1,282,562 lines through the fixed parser:

- brandings: **20 → 18**, and the two that went are Goneker and Vabann. All 18 survivors
  are real mobs, unchanged.
- `Goneker` is credited **87,612 damage** and `Vabann` **13,452**, where both were zero
  after the moment they were branded.
- of the 156 names that gained friendly proof, **4** are not player-shaped, and all four
  are real backtick pets (`` Rhale`s warder ``, `` Rhain`s warder ``,
  `` Rhazendude`s warder ``, `` Beebee`s warder ``). No mob collects standing.
- 710 tests pass.

## Files

| File | Change |
|---|---|
| `src/parser/roster.js` | `friendlyByAction` + `noteFriendlyByAction` / `hasFriendlyProof`; `noteHostileByAction` refuses friendly proof; `partyMembers` + `setPartyMembers` / `hasPartyList` / `inParty`; `includes()` and `members()` lose the `groupOnly` parameter |
| `src/parser/index.js` | `isFriendly` consults friendly proof first; `handleHeal` records it about the target and now runs its resolve before the encounter guard; `noteMemberTurned`; self-damage guard; charm state ends on the next hit against the mob; `setPartyMembers` replaces `setGroupOnly`; the snapshot filter collapses to the party list |
| `src/parser/entities.js` | `looksLikePetName`, the generic-possessive test exported so the roster need not restate it |
| `src/parser/rules.js` | `reave`/`reaves`; `tormented` damage shield; `heal-no-spell` |
| `src/main/config.js` | `partyMembers` replaces `groupOnly`; `migrateParty` drops the retired key; `REPLACE_KEYS` |
| `src/main/ipc.js`, `src/main/main.js` | `roster:check`; the config patch drives `setPartyMembers` |
| `src/renderer/setup/*` | Party list box, live status and typo check; the group-only checkbox is gone |
| `scripts/session-replay.js` | `includes()` call site |
| `tests/*` | 13 new tests across roster, parser, rules and config |

## Still open, deliberately

**A first-sight summon binding can still claim a real player.** `bindPet` refuses a name
with player proof, but a raid-mate who has never spoken and is not in the group has none;
if their first action lands inside the 12s weak-summon window they become somebody's pet
and lose their row. All 39 bindings in this log were genuine generated pet names, so it
never fired here — but nothing prevents it, and the symptom is identical to the one this
changelog is about. Written down so the next report is not re-derived from scratch.

**Unowned pets get their own rows rather than their owner's.** Visible in the roster dump
as a crowd of generated names (`Gobeker`, `Jonantik`, `Vebeker`, …) sitting in the
implicit roster. That is `isUnownedPet` working as documented and the group total stays
honest, but the owner's row is missing that damage. Separate problem.
