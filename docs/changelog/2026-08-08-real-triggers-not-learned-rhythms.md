# Real triggers, not learned rhythms — and every shipped rule shows its pattern

**Date:** 2026-08-08

## What changed

Three things that turned out to be one thing. Everything this app puts on screen is now
either a real trigger with a pattern and a number you can read, or a parser rule that
shows the real regex behind it.

1. **The learned recast estimator is deleted.** `src/parser/rhythm.js`, `src/main/rhythms.js`
   and `src/main/baseline-rhythms.json` are gone. The boss timers it produced ship instead
   as `src/triggers/seed-pack.js` — an ordinary trigger pack, installed on first run,
   visible in the Triggers rail, switchable, editable and exportable like anything imported.
2. **The built-in rules show their patterns.** Every row in the Triggers window carries its
   real pattern under its name, in the same treatment an imported trigger's gets, and
   clicking one opens a dialog with the live `rules.js` and `spellwatch.js` sources, the
   lines they catch, and the same rule written out as a trigger you can take away.
3. **Authoring is reachable.** `+ New trigger` is no longer hidden on the pack the window
   opens on, `+ New pack` exists at all, and the editor can make a group.

## Why the estimator went

`rhythm.js` predicted a boss's next cast from a median of observed gaps, computed live at
4 Hz, hedged with a `~`, a spread, a "warm" state for a prior learned last week, and a
retraction path for when reality stopped matching.

**The statistics were never the problem — the placement was.** A median of observed gaps is
a perfectly good way to arrive at "Mana Drain every 19s". Doing it during a raid, and
showing the intermediate guesses, is not: the player could not see how the number was
arrived at, could not correct it when it was wrong for their server, and could not give it
to anybody else. That last one matters most — a guild passing its boss pack around is the
entire reason GINA compatibility was built, and the app's own timers were the one thing
that could not travel.

So the same computation moved to authoring time, where a person reviews it before it ships.

**The replacement is strictly better, not merely simpler.** A shipped timer is a `countdown`
with `restart: 'new'`, armed by the boss's own cast line, so it arms on cast **#1** — where
the learner needed three agreeing gaps, or a stored prior from a previous week, before it
would show anything at all. Each subsequent cast restarts the slot in place rather than
opening a second row, which is what the never-move rule forbids. A `repeating` timer would
have been wrong for a different reason: it would go on re-arming itself after the boss was
dead.

**What it costs, stated plainly.** A written duration does not adapt to a server that
retunes a boss. The answer is that the player can now *see* the number is wrong and change
it, which the learner never allowed, and can re-measure from their own log with
`scripts/mine-rhythms.js` whenever they like. Adaptation moved from invisible-and-automatic
to visible-and-manual, which for a number that drives a countdown is the right trade.

**Death is no longer special-cased.** The invariant that a slain caster's rows leave at
once used to live in `RhythmTracker.dropCaster`. Each shipped trigger now names its own
caster's death line as an `earlyEnders` pattern — the engine's ordinary mechanism — so the
rule is visible in a pack a player can open and read.

## The shipped pack

Sixteen countdowns, measured by `scripts/mine-rhythms.js` over 983,057 lines of one
character's own logs on oggok between 2026-07-31 and 2026-08-08, then reviewed by hand.
Lord Nagafen, Lady Vox, King Tranix, Hoptor Thaggelum, Quag Maelstrom, Warlord Skarlon's
pet, Baron Telyx V\`Zher, Sister of the Spire, Bazzt Zzzt, Overseer of Air, Noble Dojorn,
Asaka L\`Rei and the Cleric of Innoruuk.

Two pattern shapes, and which one a row uses says what it was measured from. Most bosses
announce themselves (`^Lord Nagafen beg(?:ins|in) casting Shadow Vortex\.$`). An innate
breath weapon prints no cast line at all, so its clock is the damage it did *plus* the
resists — a volley the whole group shrugs off leaves no damage line anywhere, and without
the resist form the countdown would silently skip that cycle.

**The review mattered.** The miner found 35 candidates tight enough to ship as a fixed
number; 16 survived. What was cut: self-buffs (a Footman of V\`Zher recasting Center on
itself every seven seconds is metronomic and worthless), a friendly player's pet, generic
trash mobs, and four-second chain-casts that expire before the row can be read. Several
pairs that the old `baseline-rhythms.json` shipped as measured facts came out too irregular
once more evidence arrived. That file having held `Footman of V\`Zher | Center` at all is
the clearest possible argument for review happening at authoring time.

Verified end-to-end: replaying the live log through the engine with the pack installed
arms all 16, 96 times over 1,121,986 lines. Nothing in it is dead.

## Making the built-in rules readable

The Triggers window's job is to answer *what may put something on my screen*. It answered
it twice over for imported packs — pattern under the name, full detail on click — and for
the rules this app ships it showed prose and a callout reading *"Curated, not a pattern —
this one is decided by a spell table checked against real sessions, not by a regex you
could edit."*

That was untrue. The rules **are** patterns: `rules.js` holds the log-line regexes and
`spellwatch.js` holds the spell table that sorts a cast into one of the six warning groups.
Every one of them is a worked example of the exact thing the editor asks a player to write
from scratch, and all of them were hidden.

Now `spellwatch.js` exports `SPELL_PATTERNS` and `rules.js` exports `ruleSource(id)`, and
`builtin-pack.js` derives everything the window shows from those two. **No regex string is
written by hand in that file** — a pattern quoted in a display layer is one that goes stale
the first time the real one is corrected, and the failure mode is a screen that lies.

`builtinRecipe(row)` composes the same rule as a trigger the player can own, with the
group's spell filter inlined as a lookahead. It is a *starting point*, never an equivalent,
and the dialog's last section says exactly what a copy will not carry: whether the caster is
an enemy (a player typing "Lord Nagafen begins casting Complete Heal." into /general must
not warn), how loud to be, that an interrupt cancels it, and the six SHOW switches. None of
that survives a regex, which is why the alerts stay parser-backed while the timers did not.

### The `catches` samples were wrong

Every cast example shipped in `builtin-pack.js` read *"Lord Nagafen begins to cast Complete
Heal."*. `rules.js` matches `beg(?:ins|in) casting`, and "begins to cast" appears **nowhere**
in 983,000 lines of real log. The shipped illustration of what a rule catches was a line
that rule has never matched, and nothing could have caught it while the patterns were
hidden. They are now real lines from the live session, and a test asserts every one is
matched by at least one of its row's rules.

## Making authoring reachable

`renderContents()` ran `$('new-trigger').hidden = builtin`, and the built-in pack is the
selection every time the window opens — so the *default view had no way to create anything*.
The only routes were a button buried inside the info dialog, or selecting an imported pack
first, which does not exist if you have imported nothing. There was also no way to create a
pack at all.

- `+ New trigger` is never hidden. It already routed a built-in selection into My Triggers;
  the button was hidden, not the capability missing.
- `+ New pack` sits in the rail footer, always enabled, and creates → selects → opens the
  editor on a blank trigger. "New pack" that left you looking at an empty list would have
  moved the dead end one step along rather than removed it.
- The editor has a GROUP field: the pack's groups plus "＋ New group…". Grouping is how a
  pack gets switched on a boss at a time, and until now the only groups that existed were
  ones an imported pack brought with it.

## Files

### Added
- `src/triggers/mine-rhythms.js` — the surviving half of the estimator: median-of-gaps over
  a whole log, carrying RAW log names and which evidence each pair was measured from.
- `src/triggers/seed-pack.js` — the shipped pack, plus `installSeedPack`.
- `scripts/mine-rhythms.js` — the command line around the miner; writes nothing without
  `--write`, the same discipline `mine-gina.js` follows.
- `tests/mine-rhythms.test.js`, `tests/seed-pack.test.js`, `tests/triggers-window.test.js`.
- `docs/design/2026-08-08-rules-shown-mockups.html` — the approved mockup, rendered with the
  real stylesheet and generated from the live `builtinPack()`.

### Removed
- `src/parser/rhythm.js`, `src/main/rhythms.js`, `src/main/baseline-rhythms.json`,
  `scripts/seed-rhythms.js`, `tests/rhythm.test.js`, `tests/rhythms-store.test.js`.
- The `castTimers` config key, the `~` prefix, the warm-row styling and the `CAST` state.

### Changed
- `src/parser/rules.js` — `ruleSource(id)` and `RULE_IDS`.
- `src/parser/spellwatch.js` — `SPELL_PATTERNS`, frozen, without exposing the table.
- `src/parser/index.js` — the tracker, its four call sites, `onRhythmsLearned`,
  `setKnownRhythms` and `castTimers` in the snapshot all gone.
- `src/main/builtin-pack.js` — `builtinMatches`, `builtinRowPattern`, `builtinRecipe`; the
  `castTimers` row removed; real `lineRules` and real `catches` on every row.
- `src/main/config.js` — `castTimers` dropped; `migrateTimers` carries a config with either
  timer key on forward as timers-on.
- `src/main/main.js` — the rhythm store gone, the seed pack installed at startup, the tray's
  "Boss spell timers" pointing at `triggerTimers`, `TRIGGERS_CREATE_PACK` handled.
- `src/triggers/pack.js` — `pack.shipped`; `touch()` marks any pack with an upstream;
  `createTrigger`/`updateTrigger` can make and move groups.
- `src/renderer/timers/*` — one source, no merge, no tilde, no warm branch, no CAST path.
- `src/renderer/triggers/*` — the rebuilt info dialog, row patterns, the two New buttons,
  the GROUP field.
- `CLAUDE.md` — the timers section, the never-move invariant, `src/triggers/`, the commands.

## Migration

A config holding either timer key on keeps its countdowns. They asked for countdowns; there
is now exactly one place countdowns come from, and it covers the bosses the learned column
used to — so honouring a stored `castTimers: true` by leaving `triggerTimers` off would take
away the very rows that choice was about. Only a config that had switched **both** off gets
silence, which is the one reading under which neither key is contradicted.

The seed pack is installed if absent, replaced when the build ships a newer revision, and
**never** overwritten once the player has edited it. `pack.shipped` is new for this: `touch()`
marked only GINA packs as edited, on the reasoning that a native pack has no upstream — the
seed pack is native and does have one, sitting in the build.

## Do not rebuild the learner

If a future version wants adaptive timers, the answer is not a live estimator. It is the
loop that already exists: fight the boss, run `scripts/mine-rhythms.js` over your own log,
review what it found, add the trigger. The measurement is the same arithmetic either way;
the difference is whether a person sees it before it reaches the screen.
