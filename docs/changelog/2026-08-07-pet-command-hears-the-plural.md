# The pet command hears the plural, and answers when it cannot

**2026-08-07**

## What happened

James reported that mapping a pet in-game "doesn't seem to be working". The live log
said exactly why:

```
[Fri Aug 07 09:39:14 2026] You tell your party, 'pets Jonarn = Khanvikt'
```

`pets`. The rule accepted only the singular `pet`, so the line fell through to the chat
rule, was filed as ordinary party chatter, and wrote nothing. Jonarn kept his own damage
row for the rest of the session.

The plural is not a slip worth punishing. The settings section is headed **Named pets**,
the concept is plural everywhere it is written down, and the command names a table rather
than a single animal. If anything the rule was the thing spelled wrong.

## Two defects, not one

The plural was the trigger. The reason it became a bug report rather than a shrug is the
second defect: **a command that fails says nothing at all.**

This command is typed blind. It goes into a chat channel with no completion, no echo and
no error — the game has no idea the overlay exists. So before this change the player had
no way to tell these apart:

- the overlay never recognised the line
- the overlay recognised it and refused it
- the overlay applied it and the pet's damage simply had not landed yet

All three look identical: an overlay that did not change. The original rule commented
that a malformed command "falls through to the chat rule and writes nothing", which is
correct as safety and wrong as an interface — safety was never the reason to stay quiet
about something the player themself typed.

## What changed

**The keyword is forgiving** (`src/parser/rules.js`). `pet` and `pets`, either
capitalization, and whitespace slack on every seam a typist can get wrong — a doubled
space after the keyword, a trailing space before the closing quote. Each of those used to
mean silence and none of them changes what was meant.

This costs nothing in safety. What keeps ordinary chat out has never been the keyword: it
is the anchor to the **entire** quoted message plus letters-only names, and neither moved.
"pets are expensive" still cannot match — no `=`, and its words have spaces.

**A near miss now answers.** A third rule sits after the other two, so a well-formed
command never reaches it. Whatever lands there opened with the keyword, contains an `=`,
and still failed to parse — and gets one toast reprinting the syntax:

```
Pet command: pet <Pet> = <Owner>
```

The `=` requirement is what keeps this off conversation. Talking about pets is common in
the live log ("pet weapon - jk lol", "pet heals don't trigger divine invo which i think
is dumb lol") and none of it carries an equals sign. The self-channel anchor still
applies too, so the worst case is one stray toast about a line the player wrote.

The same line answers the name-shaped failures the parser catches after matching — a
lowercase name, a name that is a number, an owner equal to the pet. Deliberately one
sentence for all of them rather than a diagnosis per failure: the player does not need to
know which of the two names offended, only what a correct line looks like.

## What was checked, and what was already fine

The mapping machinery itself was never broken. A full replay of the 79 MB live log with
James's seven configured mappings folded every one of them into its owner and left none
of them holding a row:

```
resolve() of each mapped pet:
  Gann -> Rhain     Gobn -> Ribbers    Xobekn -> Kadomony   Gantik -> Khanvikt
  Libaner -> Kadomony   Xabann -> Glorb    Gibarn -> Venun
mapped pets that still got their own row: []
```

So the settings box, the config round-trip, `setPetOwners` and the resolve path were all
doing their jobs. Only the front door was stuck.

## Files

- `src/parser/rules.js` — `PET_CMD` keyword constant; `pet-command-list` and
  `pet-command-set` widened; new `pet-command-malformed` rule
- `src/parser/index.js` — `handlePetCommand` answers the malformed action and the two
  name-shape refusals; new `notePetSyntax`
- `tests/parser.test.js` — the forgiving forms, the malformed answer, and a test built
  from real chatter in the live log pinning that talking about pets stays silent
