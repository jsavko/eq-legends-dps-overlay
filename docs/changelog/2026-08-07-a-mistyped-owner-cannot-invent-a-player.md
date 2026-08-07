# A mistyped owner cannot invent a player

**2026-08-07**

## What happened

Immediately after the pet command learned to hear the plural
([the plural fix](2026-08-07-pet-command-hears-the-plural.md)), James reported the
overlay showing "a pet version of Kadomony and a player version" that would not merge.
The log had it:

```
[Fri Aug 07 10:18:18 2026] You tell your party, 'pets Jaber = Kodomony'
[Fri Aug 07 10:21:39 2026] You tell your party, 'pets Jaber = Kodomony'
```

**Kodomony**, with an o. The player is **Kadomony**, with an a. `Kodomony` occurs
exactly twice in the whole 79 MB log, and both occurrences are those two commands.

So the overlay did precisely as told: it folded Jaber's damage into a combatant named
Kodomony, who does not exist, and rendered him next to the real Kadomony. Two rows, one
person, one letter of difference.

Typed twice, thirteen minutes apart — because the acknowledgement was
`Jaber = Kodomony`, which reads exactly like success.

## Why this one bites harder than it looks

Get the *pet* name wrong and nothing happens: the mapping sits there matching nothing.
Get the *owner* wrong and the mapping works perfectly, on a person who isn't there.

Worse, it overrides a correct answer. Configuration outranks inference in `ownerOf`, and
replaying the log shows the parser had already worked Jaber out on its own from summon
adjacency — `Jaber resolves to: Kadomony` with no mapping at all. The typo did not fail
to help; it stepped in front of something already right.

## What changed

**A typed owner is now checked against who is actually here** (`src/parser/index.js`).
Three outcomes, and which one you get depends entirely on the evidence:

| The owner you typed | What happens |
|---|---|
| Someone here, any capitalization | Applied. `kadomony` becomes `Kadomony` — EQ capitalizes every name, so lowercase is a slip and not another person |
| Within two edits of exactly one person here | **Refused**, and named: `No Kodomony here — did you mean Kadomony?` |
| Unlike anyone here | Applied, and said so: `Jaber = Zarann (not seen yet)` |

The third row is why this refuses rather than blocks everything unknown. A name the log
has never seen is also what a group member who simply has not swung yet looks like, and
mapping a pet before its owner acts is legitimate. What is *not* legitimate is doing it
silently.

**It refuses rather than auto-corrects.** A near miss is almost always a typo and
correcting it would have worked here. But "almost always" is not the standard this
overlay holds itself to anywhere else — ambiguous attribution goes to Unknown, not to the
most plausible player — and retyping one line costs less than quietly scoring a pet onto
the wrong person. The suggestion carries all the information; the player makes the call.

**The suggestion stays quiet unless it is obvious** (`nearestName` in
`src/parser/entities.js`, pure and unit-tested). Two edits maximum, names under four
characters skipped entirely (they are all within two edits of each other), and a tie
between two candidates returns nothing at all. Offering a coin flip would invite
accepting the wrong half, which is the exact failure this exists to prevent.

## A smaller thing, found on the way

The saved mapping had grown a line nobody wrote:

```json
"Rhale`s warder": "Rhale"
```

The pet-calls-you-Master rule was storing backtick pets in the ownership table. They
resolve by string split long before that table is consulted, so it changed no numbers —
but the next in-game command persists the whole table, so it reached the config file and
from there the settings box, where it reads as a line the player is expected to maintain.
Backtick names are no longer stored (`src/parser/roster.js`).

## James's config, repaired

- `Jaber: Kodomony` → `Jaber: Kadomony`
- `Rhale\`s warder: Rhale` — removed

The other nine mappings were checked against the log and every owner is real: Rhain
37,034 lines, Ribbers 5,892, Kadomony 41,609, Khanvikt 56,684, Glorb 25,077, Venun 37,891.

## Files

- `src/parser/entities.js` — `nearestName`, and a capped edit distance behind it
- `src/parser/index.js` — owner validation in `handlePetCommand`; `friendlyNames`,
  `matchFriendly`
- `src/parser/roster.js` — backtick pets stay out of the stored mapping
- `tests/entities.test.js` — what `nearestName` catches, and what it refuses to guess at
- `tests/parser.test.js` — the live-log slip, the capitalization fix, the unseen owner,
  and the backtick entry staying out of the saved mapping
