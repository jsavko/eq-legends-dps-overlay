# Settings becomes panes and pickers

**2026-08-11**

> "You left out the entire settings filter page I asked for. I want the ability to list
> which players we are tracking for when fighting in a public zone" — James

The party list had shipped the day before and worked. It was reported missing because
reaching it meant opening settings and scrolling past five other topics to the sixth of
seven headings — confirmed by attaching to the running app over CDP and reading the DOM,
which found it present and reading *"Empty — everyone the log sees gets a row."*

A form long enough to hide a feature from the person who asked for it is the wrong shape.
And a textarea you hand-type names into is the wrong tool for a public zone anyway: there
you do not want to type names, you want to pick from who is actually there.

> "The settings window is a mess. It needs a full rework anyway and it makes sense to be
> in there."

So it was reworked, against an approved mockup, in the flow the history window established.

## Fixed panes instead of one long scroll

A rail of topics on the left, exactly one of them in the detail pane, a footer that never
moves. Seven topics grouped: **Setup** (Log file · Who's tracked · Pets), **Appearance**
(Overlay · Hotkeys), **Other windows** (Triggers · Session stats).

Every control kept its id and its handler — this is a re-homing, not a rewrite of the
form's behaviour — so log picking, validation, the session switches and the hotkeys work
exactly as they did.

The rail carries **live state**, which is the part that answers the original complaint.
"Who's tracked" reads `3 of 28` or nothing at all, and Pets reads `2 new` when something
is waiting for an owner, so the two settings that quietly change what the meter shows say
so without being opened.

## Who's tracked

Two lists. Everyone the parser has seen this session on the left, with a search box and a
tag beside each name — `you`, `group`, or what they have actually done this fight. The
tracked set on the right. Click either to toggle.

`Track everyone` clears the list back to the default. `Only my group` seeds it from what
the game said in group join and leave lines — a seed, not a filter of its own, and every
name it puts in is then yours to remove. That is the whole difference between it and the
`groupOnly` switch it replaced, which decided and never showed its work.

The free-text box stays for somebody who has not acted yet and so is not in the left list.
Everything else is a click, which is what makes the typo *impossible* rather than merely
caught: a misspelt name in a filter does not fail, it hides a person who is right there
and says nothing.

**The list is now per character.** Keyed `<Character>_<server>`, the same key the history
and session stores use, because the alt you take into a public zone wants a different list
from the one your main raids with. `applyPartyList()` reapplies it on every route by which
the answer can change — a new tail, a character switch, a settings save — and Save merges
into the stored map rather than replacing it, so one character's list can never wipe
another's.

## Pets

The same shape, for the same reason. Left: what needs an owner, each with the evidence for
why the parser thinks it is a pet. Right: who it belongs to, picked from the people seen
this session, filtered so a pet cannot own a pet. `Assign` commits; `Not a pet` blacklists
the name in the running parser immediately rather than waiting for Save, because a summon
firing nearby would otherwise re-learn the very binding you just rejected.

Below, **Mappings in force**: everything currently applied, each labelled with where it
came from — `from the log`, `from the log · weak`, `you set this` — and removable. The
textarea could show none of that. A weak binding, made from cast adjacency rather than a
line naming the owner, is exactly the one worth checking, and it now says so.

Getting the OWNER wrong is the half that hurts: a mistyped pet name matches nothing, but a
mistyped owner folds real damage into somebody who does not exist and grows a phantom row.
That already happened here once, with `pets Jaber = Kodomony`. A name you clicked cannot
be misspelt.

Two things the live app caught that a mockup could not:

- **`a sonic bat` was being offered as a pet.** `unmappedEntities()` includes anything the
  game called an NPC that is not currently an enemy, and a mob you happened to target
  qualifies. A summoned pet's generated name is player-shaped, so anything carrying an
  article or a space is now filtered out — asking who owns a sonic bat is a question with
  no right answer.
- **Every mapping claimed "you set this".** The in-game command writes what it *learns*
  straight to settings, so "is it in config" does not by itself mean the player typed it.
  Provenance now compares the two and only claims authorship when they disagree.

## Verified in the running app

Not by replay. The packed build was relaunched with `--remote-debugging-port=9223`, which
Electron exposes on localhost and WSL can reach, and the settings window driven over CDP:
the rail switching pages, the party picker listing 28 real names from a live public zone,
ticking and unticking from both sides, `Only my group`, `Track everyone`, the search box
keeping its ticks, and the pets picker resolving its sentence to *"Anzen's damage will
fold into Rhale's row from the next fight."*

710 tests pass.

## Files

| File | Change |
|---|---|
| `src/renderer/setup/index.html` | rail + one article per topic; both pickers; the two textareas gone |
| `src/renderer/setup/setup.css` | fixed-pane grid, rail, picker and name-list styling |
| `src/renderer/setup/setup.js` | `showPage`, `refreshRoster`, `renderParty`, `renderPets`, `renderPetsInForce`; the four text-parsing helpers deleted |
| `src/main/config.js` | `partyMembers` becomes per-character; `partyListFor()`; `migrateParty` clears a global array |
| `src/main/main.js` | `applyPartyList()`; `ROSTER_STATE` and `PETS_NOT_A_PET` handlers |
| `src/main/ipc.js`, `src/renderer/setup/preload.cjs` | the two new channels |
| `src/parser/index.js` | `unmappedEntities()` no longer offers mob-shaped names |

## Still open

**The mockup lives in the scratchpad, not the repo.** Pencil was not running, so this was
designed as a clickable HTML prototype instead. It served, but the project's stated flow is
a Pencil mock and that is still the flow to use when Pencil is available.

**A global party list written on 2026-08-10 is cleared, not migrated.** The config never
recorded which character was logged in when those names were typed, so there is nobody to
hand them to; showing everyone is the safe direction and it was empty in practice.
