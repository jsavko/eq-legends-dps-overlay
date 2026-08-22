# Class trio and level — on the overlay hover, and stamped into fight history

**Date:** 2026-08-22

## The `/who` rule had never fired on this server

Start here, because it is the part nobody would guess. `rules.js` has carried a
`who-entry` rule since the beginning, matching the classic EverQuest shape
`[50 Cleric] Name (Human)`. Its class capture was `[A-Za-z' ]+?` — no slash in it.

EverQuest Legends gives a character up to **three classes at once** and prints all of
them in one bracket:

```
[29 PAL/DRU/BST] Rhale (Dwarf)  ZONE: The Greater Faydark (gfaydark)
```

That pattern cannot match that line. Measured against the live log: **649 `/who` result
lines, zero events.** The roster's `/who` tier has been fed nothing for the entire life
of the app. Nothing downstream broke visibly, because `/who` was one of four identity
sources and the other three carried it — which is exactly why it went unnoticed.

That finding stands on its own, quite apart from the feature built on top of it.

## What changed

**The overlay hover** now carries a line under the member's name saying what `/who`
last said about them, and how long ago it said it:

```
Binnon                                    1.2M dmg · 12.3k dps
50 SHD/WIZ/ENC · Ancient Skeleton · 35m ago
```

**The History window** carries the same reading for the fight being reviewed, dated
against the pull rather than against now:

```
Binnon · 1.2M dealt · 12.3k dps · 412 hits · max 1,204 · 88,410 proc
50 SHD/WIZ/ENC · Ancient Skeleton · read 33m before the pull
```

A pull reviewed a week later still says what everybody was that night.

## A reading, not a fact

EQ Legends lets a player change classes at will. That single constraint shapes
everything here: **there is no durable "Emalina is a cleric" fact to store anywhere.**

What is stored is a *reading with a timestamp on it*.

- The live session holds only the most recent one per name, in
  `roster.whoSightings`, overwritten on every new `/who`. Memory only — nothing is
  written to config, nothing survives a restart, and a character switch clears it.
- The only durable copies live **inside encounter records**, stamped at fight close.
  That is honest because of what they are attached to: "the `/who` current when we
  pulled this mob said Emalina was 27 CLR/ROG/NEC" is a fact about a fight that has
  its own start and end, and a month from now it is still true.
- The age is never dropped, on either surface, because it is part of the claim. A trio
  read six hours before the pull is weaker evidence than one read a minute before, and
  the line has to say which it is.

**No manual entry**, deliberately. A hand-typed trio is a value nothing verifies and
nothing expires — the guessed-number failure this codebase keeps legislating against.
The answer to the gap is `/who group`, which fills a whole group in one command.

## `/who` proves PLAYER, not GROUP MEMBER

Fixing the regex meant deciding what a matching line is now allowed to conclude, and
the old branch's answer was wrong the moment it started firing. It added the name to
`roster.explicit` — the tier meaning *the game named this person as one of ours* — and
a bare zone `/who` returns every stranger standing in Greater Faydark. `explicit` feeds
`isConfirmedMember`, which drives the charm inference in `noteMemberTurned`; fifty
strangers landing in it is a real change to what the parser believes.

`/who` lists players. That is all it proves, so it now feeds `knownPlayers` and nothing
else. This is also what keeps the regex fix from changing any scoring: `standing()`
already answers `'ours'` off `knownPlayers` one tier down, and channel chat has always
been able to fill that set with strangers from across the server. `explicit` goes back
to being the group-message tier it was named for.

## Two surfaces, opposite calls on absence

The overlay **hides** the line when there is no reading. It auto-fits, its panel height
already varies by member, and a hidden line costs the measurement nothing.

History **always draws** it — the trio, or a faint "no /who reading for this fight".
That window's reason to exist is that clicking a fight, member or metric swaps content
inside a fixed pane and moves nothing, and a line that appeared only on the members who
happened to be `/who`'d would shove the abilities table down every time. It is the exact
failure the deaths line already taught this pane.

## Found while executing: AFK entries and a corpse

The plan's survey of the live log reported no `AFK`, `<LINKDEAD>` or `<LFG>` markers. It
had scanned lines beginning with `[`, and EQ writes the AFK form with a **leading
space**:

```
[Sat Aug 01 09:42:21 2026]  AFK [13 WAR/CLR/BRD] Nope (Wood Elf)  ZONE: …
```

14 entries and 2 `AFK [ANONYMOUS]` lines were invisible to it. Both rules now tolerate
leading whitespace and an optional `AFK ` prefix — which is precisely the gap the feature
exists to close, since otherwise the one member who stepped away when somebody typed
`/who` is the one person with no reading, silently.

One `/who`-shaped line is left unmatched **on purpose**:

```
* RIP *[44 MNK/SHM/NEC] Sisco's corpse (Dark Elf)  ZONE: The Ruins of Old Paineel (hole)
```

`/who` lists corpses. That entry names a corpse, not a combatant, and matching it would
file a class trio under "Sisco's corpse" — a key no row can ever carry. It stays visible
in `collect-unknown.js`'s report.

**Guild is parsed and stored, never displayed.** Guild names run long enough
(`Four Inches Is Fine`, `Heroes of Mithril Halls`) that neither the overlay panel nor the
History head line has the width. It is in the record if it is ever wanted.

## Verified

**Against the live log** (a frozen 2,183,425-line copy, since the real one was being
written to during play):

| | before | after |
|---|---|---|
| matched | 1,880,927 | 1,881,576 |
| unmatched | 302,493 | 301,844 |
| `who-entry` | — | 641 |
| `who-anonymous` | — | 8 |

**Not one existing rule changed its count by a single line** — the new patterns swallowed
nothing another rule was matching. A full replay produced 324 live sightings and put the
trio on every player row of the closing fight, with none on the charmed mobs or the
`Unknown` bucket.

**Both panels, headlessly** — the real renderers driven over CDP in Windows Chrome with a
stubbed preload bridge, fed a real parser snapshot and two real records off the live log
(one with `/who` stamps, one with every stamp stripped, standing in for a record written
before this shipped):

- *Overlay, at the narrowest 360px width and at text scales 0.7 / 1.0 / 1.8:* no
  clipping in any state, including the longest reading in the fight
  (`50 SHD/WIZ/ENC · Ancient Skeleton · 35m ago`). At 1.8 the line wraps to three lines
  and the renderer reports a taller fit plus `extraWidth: 100`, so main grows the window
  rather than cutting it off. `fitWindow()` fires on every row change. Mob rows hide the
  line at height 0.
- *History, across 2 fights × 11 members × both stamp states:* the ABILITIES heading sits
  at **exactly 63px** from the pane top in every single case — one distinct value — and
  `.b-who` is **16px** tall whether it carries a trio or the placeholder. All three metric
  views put exactly one line in the same slot, which is what the single call site in
  `renderBreakdown` buys.

896 tests pass.

## Files

| File | Change |
|---|---|
| `src/parser/rules.js` | `who-entry` rewritten for the EQL trio shape (+ `AFK`, guild, leading space); new `who-anonymous` rule; `className` dropped |
| `src/parser/roster.js` | `whoSightings` map + `sightingFor()`; `who` now feeds `knownPlayers`, not `explicit`; cleared by `setSelf` |
| `src/parser/index.js` | `snapshot()` attaches `row.who` with a derived `seenAgoMs` |
| `src/main/main.js` | `persistEncounter` stamps each record row with the sighting, absolute `ts`, no `RECORD_VERSION` bump |
| `src/renderer/overlay/index.html` | `#d-who` under `.detail-head` |
| `src/renderer/overlay/overlay.css` | `#d-who`, with a `max(12px, …)` floor and no overflow rule |
| `src/renderer/overlay/overlay.js` | `setWho()`, `formatAge()`; wired into `renderDetail` |
| `src/renderer/history/organize.js` | `readingAge()` — dates a reading against the pull, never against now |
| `src/renderer/history/history.js` | `whoLine()`; spliced under the head line at the one call site in `renderBreakdown` |
| `src/renderer/history/history.css` | `.b-who`, fixed 16px line in both states; `.b-head` tightened to sit against it |
| `tests/rules.test.js` | trio, duo, guild, two-word race, AFK, ANONYMOUS, corpse, header/footer |
| `tests/roster.test.js` | `/who` proves player not member; store, overwrite, survive ANONYMOUS, clear on switch |
| `tests/parser.test.js` | reading rides the row; charmed mob and `Unknown` carry none; no stranger confirmed |
| `tests/history-organize.test.js` | `readingAge` before / during / absent, and stability over time |
