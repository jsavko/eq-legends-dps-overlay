---
status: completed
---
# Class trio and level — on the overlay hover, and stamped into fight history

**Date:** 2026-08-22

---

## Goal

Show what `/who` last said about a player — level, class trio, race
(`29 PAL/DRU/BST · Dwarf`) — in two places:

1. **The overlay hover breakdown**, live, for the member under the cursor.
2. **The History window**, as the reading that was current *at that fight*, so a pull
   reviewed a week later still says what everybody was that night.

EverQuest Legends lets a player swap classes at will, which is the whole constraint.
It shapes the design in one specific way: **there is no durable "Emalina is a cleric"
fact anywhere.** What gets stored is a *reading with a timestamp* — attached to a
fight, which is minutes long and cannot go stale, rather than to a person, who can
reroll between pulls. The live session holds only the most recent reading and
overwrites it on every new `/who`; nothing is written to config, and nothing is
carried across restarts.

Before any of that is possible, a bug has to be fixed.

**The `who-entry` rule has never fired on this server.** Its pattern is the classic
single-class shape, `^\[(\d+)\s+([A-Za-z' ]+?)\]` — no `/` in the class character
class. EQ Legends prints trios: `[29 PAL/DRU/BST] Rhale (Dwarf)  ZONE: The Greater
Faydark (gfaydark)`. Verified against the live log by running `matchRule` over it:
**627 `/who` result lines, zero matches**, including every `[ANONYMOUS] Name` form.
So the roster's EXPLICIT tier has been getting nothing from `/who` for the entire
life of the app, and the feature rests on fixing that first.

## Decisions taken

- **No manual entry.** The line comes from `/who` or it does not exist. A
  hand-typed trio is a value nothing verifies and nothing expires — exactly the
  guessed-number failure the codebase keeps legislating against. `/who group` fills
  a whole group in one command, which is the answer to the gap.
- **Encounter records, not session records.** The per-fight stamp is what "at the
  time" means when a fight is the unit being reviewed. A night-roster on the session
  record is a different, smaller feature — noted at the bottom as a follow-on if the
  Session window is what was actually meant.
- **This revises the note in the first draft of this plan that excluded History.**
  The exclusion was reasoned from "never store it", and the distinction that
  dissolves it is the one above: a reading stamped with its own time, attached to a
  fight, is a historical fact about that fight. It is a durable claim about a
  *person* that was ruled out, and nothing here makes one.

## What the live log actually contains

Measured on `eqlog_Rhale_oggok.txt`:

| Shape | Count | Note |
|---|---|---|
| `Players in EverQuest Legends:` + 27 dashes | 128 | the `/who` zone header |
| `Friends currently on EverQuest Legends:` + 33 dashes | 105 | `/who friends` |
| `[<lvl> AAA/BBB/CCC] Name (Race)  ZONE: ...` | most | three classes |
| `[<lvl> AAA/BBB] Name (Race)  ZONE: ...` | many | low level — only two |
| `... (Race) <Guild Name> ZONE: ...` | many | guild tag is optional |
| `[ANONYMOUS] Name ` | 6 | no level, no class, no race |
| `There are N players in EverQuest Legends.` | 116 | the footer |

No `AFK`, `<LINKDEAD>` or `<LFG>` markers appear in this log; `/who group` never
appears either (this player uses zone `/who` and `/who friends`). Race can contain a
space (`Wood Elf`, `Dark Elf`, `Ancient Wolf`). Entries carry trailing whitespace.

## Approaches Considered

### 1. Roster sighting store → snapshot rows (live) + record rows (history)
- **Description:** Fix `who-entry`. `Roster` gains a `whoSightings` Map (name →
  `{ level, classes, race, guild, ts }`), overwritten per sighting, memory only.
  `LogParser#snapshot()` attaches the sighting to the rows it already builds, with
  `seenAgoMs` computed there. `persistEncounter` in main stamps the same sightings
  onto the record's rows at fight close, keeping the absolute `ts` so the History
  window can date the reading against the fight rather than against now.
- **Pros:** One source of truth, two consumers, and each consumer derives its own
  notion of "how old" from the same stored instant — the overlay against the clock,
  History against the pull. Rides the pipeline end to end with no new IPC channel and
  no new preload surface. Enriching *rows* rather than shipping a name→info map keeps
  the 4 Hz payload proportional to the fight, not to the fifty strangers a zone
  `/who` returns. The roster is where the codebase already says identity answers
  live; it is rebuilt per session, which gets the no-durable-fact requirement free.
- **Cons:** Touches six files across parser, main and two renderers.

### 2. Store the reading on the encounter only, and derive the live hover from it
- **Description:** Skip the snapshot enrichment; the overlay reads the sighting out
  of the in-flight encounter object.
- **Pros:** One write path instead of two.
- **Cons:** The overlay's hover is useful precisely *between* pulls and on the
  opening seconds of one, when there is no encounter or it holds nothing yet. It
  would also put roster state inside `encounter.js`, whose entire job is aggregation
  over a single fight and which knows nothing about identity today.

### 3. Separate IPC event, each renderer keeps its own map
- **Description:** Main forwards each `who` event on a new channel; overlay and
  History accumulate `name → info` themselves.
- **Pros:** Zero cost on the 4 Hz hot path.
- **Cons:** State in the renderer, which is documented as holding "no parser state,
  only the last snapshot". A window reload silently empties it while the parser still
  knows. And it cannot serve History at all — a fight from last Tuesday needs the
  reading that was current last Tuesday, which only the record can carry.

### 4. Persist sightings in config, keyed by character name
- **Description:** A durable name → trio table in `%APPDATA%`.
- **Pros:** Populated before anyone types `/who`.
- **Cons:** The one thing explicitly ruled out. A three-week-old trio presented with
  no hedge is a durable claim about a person the game contradicts the moment they
  swap. Rejected.

### 5. Put the trio on the meter row itself, beside the name
- **Description:** `Rhale 29 PAL/DRU/BST  1.2M  12.3k`, no hover needed.
- **Pros:** Always visible.
- **Cons:** The meter is narrow and every pixel is taken from the game. Fourteen
  characters per row on a permanent surface, for a question asked once a night, is
  the wrong trade — and hover is what was asked for.

## Chosen Approach

**Approach 1.** Each piece sits where the architecture already says it goes: the rule
describes the line, the roster remembers who is who, the snapshot carries derived
numbers for the live view, and `persistEncounter` — which already reaches into
`parser.roster` for the party list — stamps the record. The two renderers only paint.

Three design calls inside it:

**`/who` proves PLAYER, not GROUP MEMBER.** Today the (dead) rule adds the name to
`roster.explicit` and sets `hasExplicitData`. Once the regex matches, a zone-wide
`/who` would dump every stranger in Greater Faydark into the set that means "the game
named this person as one of ours" — and `explicit` feeds `isConfirmedMember`, which
drives the charm inference in `noteMemberTurned`. So the fix routes `/who` to
`noteKnownPlayer` + `knownPlayers` instead, which is what it actually proves: `/who`
lists players and nothing else. This is also what keeps the regex fix from changing
any scoring — `standing()` already answers `'ours'` off `knownPlayers` one tier down,
and channel chat has always been able to fill `knownPlayers` with strangers from
across the server, so `/who` introduces no new risk class. `explicit` stays the
group-message tier it was named for.

**The age is part of the reading, and each surface dates it against the right thing.**
The overlay shows it against now (`· 14m ago`); History shows it against the pull
(`· read 8m before the pull`). Same stored instant, two honest framings. A reading
taken six hours before a fight is weaker evidence and the line should say so.

**The two surfaces differ on absence, because their invariants differ.** The overlay
*hides* the line when there is no sighting — it auto-fits, `hidden` costs the
measurement nothing, and its panel height already varies by member. History
*always* renders it, faint "no /who reading" when absent, because the history window
never reflows and this is the exact failure the deaths line already taught: a line
that appears only sometimes moves everything below it.

## Tasks

### Parser — the rule and the store
- [x] Rewrite the `who-entry` rule in `src/parser/rules.js` for the EQL shape:
      `[<level> AAA/BBB[/CCC]] <Name> (<Race>) [<Guild>] [ZONE: ...]`. Emit
      `{ kind: 'who', who, level, classes: ['PAL','DRU','BST'], race, guild }`. Drop
      `className` (nothing reads it). Race may contain spaces; guild tag and ZONE
      tail are both optional; tolerate trailing whitespace.
- [x] Add the `[ANONYMOUS] <Name>` branch, emitting
      `{ kind: 'who', who, anonymous: true }` with no level or classes.
- [x] `tests/rules.test.js`: cover three classes, two classes, guild present, guild
      absent, a two-word race, ANONYMOUS, and that the `/who` header and footer lines
      match nothing harmful. Fixtures verbatim from the live log.
- [x] `src/parser/roster.js`: add `whoSightings` (Map name → `{ level, classes, race,
      guild, ts }`), cleared by the same reset that clears the other session state,
      plus a `sightingFor(name)` accessor. Store on every `who` event carrying a level
      and classes; an ANONYMOUS sighting records nothing and **does not** erase a
      previous reading — going anonymous is not a class change.
- [x] `src/parser/roster.js`: change the `who` branch of `applyEvent` to
      `noteKnownPlayer` + `knownPlayers.add`, and stop touching `explicit` /
      `hasExplicitData`. Comment the reasoning at the call site.
- [x] `tests/roster.test.js`: update "/who output seeds the roster" to the new
      contract (`hasPlayerProof` true, `isConfirmedMember` false) with the reasoning
      in the test name; add cases for storing, overwriting, and surviving ANONYMOUS.
- [x] `src/parser/index.js`: pass `event.ts` to the roster so sightings are stamped,
      and in `snapshot()` attach `row.who = { level, classes, race, guild, ts,
      seenAgoMs }` to each row that has one (field absent, not null, when there is
      none). Compute `seenAgoMs` from `now`, the way `remainingMs` already is.
- [x] `tests/parser.test.js`: feed a `/who` block then a fight; assert a player row
      carries `who.classes` and a sane `seenAgoMs`, and that a charmed-mob row and
      the `Unknown` row carry none.

### Live overlay
- [x] `src/renderer/overlay/index.html`: `<div id="d-who" hidden></div>` directly
      under `.detail-head`.
- [x] `src/renderer/overlay/overlay.css`: style `#d-who` — `var(--ink-dim)`, single
      line, no `overflow` or `max-height` of any kind (the overlay cannot scroll),
      at or above the 12px floor this project holds labels to.
- [x] `src/renderer/overlay/overlay.js`: in `renderDetail`, fill `#d-who` with
      `<level> <A>/<B>/<C> · <Race> · <age> ago` and unhide, or hide when the row has
      no sighting. Add the age formatter beside `formatNumber`/`formatShare`.

### Fight history
- [x] `src/main/main.js` `persistEncounter`: stamp each row of the snapshot it is
      about to write with `parser.roster.sightingFor(row.name)`, keeping the absolute
      `ts` and **not** a precomputed age — the record must be readable a month later.
      No `RECORD_VERSION` bump: the field is additive, and older records simply have
      none.
- [x] `src/renderer/history/history.js`: render the reading in `renderBreakdown`,
      once, above the three metric breakdowns rather than inside `damageBreakdown` /
      `healingBreakdown` / `takenBreakdown` — one call site is what stops the three
      views from diverging. Always present: the trio when there is a sighting, a
      faint "no /who reading" when there is not.
- [x] `src/renderer/history/history.js`: format the reading's age against
      `record.startTs`, not against now. Put the formatter in `organize.js` with the
      other pure formatters so it is unit-tested.
- [x] `src/renderer/history/history.css`: style the line to occupy the same height
      whether it carries a trio or the faint placeholder.
- [x] `tests/history-organize.test.js`: cover the age formatter — reading before the
      pull, during the fight, and absent.

### Verify and ship
- [x] `node scripts/replay.js` over the live log — confirm the 627 `/who` lines now
      produce events and that a member row carries the trio.
- [x] `node scripts/collect-unknown.js` on the live log before and after, confirming
      the new rule did not start swallowing lines another rule was matching.
- [x] Verify both panels headlessly (stub `window.api`, real snapshot / real record,
      Windows Chrome on `--remote-debugging-port=9222`): the overlay panel must not
      clip at its narrowest width and must re-fit; the History panes must sit on the
      same pixel for a fight with a reading and one without.
- [ ] `npm test`, then `scripts/dev.sh pack`, then relaunch the overlay.
- [x] `docs/changelog/2026-08-22-who-class-trio-on-hover.md` — lead with the dead
      regex, which is the part a future reader will never guess, then the
      reading-not-fact distinction that lets this be stored at all.

## Notes

- **Execution finding: the plan's "no AFK markers" survey was wrong.** It scanned lines
  beginning with `[`, and EQ writes the AFK form with a LEADING SPACE — `]  AFK [13
  WAR/CLR/BRD] Nope (Wood Elf)  ZONE: …` — so 14 entries and 2 `AFK [ANONYMOUS]` lines
  were invisible to it. Both `who` rules now tolerate leading whitespace and an optional
  `AFK ` prefix. This is exactly the gap the feature exists to close: without it, the one
  group member who stepped away when somebody typed `/who` is the one person with no
  reading, silently.
- **One `/who`-shaped line is left unmatched on purpose.** `* RIP *[44 MNK/SHM/NEC]
  Sisco's corpse (Dark Elf)  ZONE: …` — `/who` lists corpses. The entry names a corpse,
  not a combatant, and matching it would file a class trio under "Sisco's corpse", a key
  no row can ever carry. It stays in `collect-unknown.js`'s report where it is visible.
- **Measured before/after on a frozen copy of the live log** (the real one is being
  written to during play, which confounds a direct comparison): 2,183,425 lines both
  runs; matched 1,880,927 → 1,881,576 (+649 = 641 `who-entry` + 8 `who-anonymous`);
  unmatched 302,493 → 301,844 (−649). **No existing rule changed its count by a single
  line** — nothing was swallowed.
- **`event.ts` needed no plumbing.** `LogParser#feed` already stamps every event before
  dispatching it to the roster, so the sighting store reads `event.ts` as-is. The plan's
  "pass `event.ts` to the roster" task was already satisfied by existing code.
- **`hasExplicitData` is now written only by group messages.** Nothing in `src/` reads
  it (only tests do); it was left in place rather than removed, since deleting vestigial
  state is not this change's job.

- **The dead-regex finding stands on its own.** Even with no hover line and no
  history stamp, `/who` has fed the roster nothing on this server since the rule was
  written. Worth calling out in the changelog separately from the feature.
- **Which "session history" was meant.** The Session window was not chosen in the
  clarifying round, so this plan takes the encounter records — the History window,
  per fight. If the Session window is what was wanted, the follow-on is small and
  additive: `combatBetween`-style, collect the distinct sightings across a session's
  fights and put a "played with" block on the session record. Nothing here blocks it,
  and the sighting store is the same.
- **Nothing durable is written.** The only persisted copies are inside encounter
  records, each stamped with the instant it was read and bound to a fight that
  already has a start and end time. `whoSightings` itself dies with the process.
- The sighting map is keyed by canonical row name, so pets are a non-issue — a pet
  row resolves to its owner, who is a player `/who` can name. `Unknown` and charmed
  mobs never have a sighting.
- `/who friends` (the 33-dash header) prints identical entry lines, so it feeds the
  store for free. `/who group` is not in this log but would too.
- **Guild is parsed and stored, not displayed.** Guild names run long
  (`<Four Inches Is Fine>`, `<Heroes of Mithril Halls>`) and neither the overlay
  panel nor the History head line has the width. It is in the record if it is ever
  wanted.
- Discoverability: the feature only has data for people actually `/who`'d, and
  `/who group` is the command that fills it for a whole group at once. Worth a
  sentence in the changelog.
