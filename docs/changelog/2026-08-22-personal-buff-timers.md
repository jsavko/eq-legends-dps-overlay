# The player's own timer panels

**22 Aug 2026**

A countdown for *your* things — a buff to recast, an item cooldown, a repop clock — now
draws in a panel of your own: named by you, placed by you, switched by you, and as many
of them as you want. The durations come out of your own log rather than out of a table
somebody else wrote.

Ask that started it: *"a small timer overlay that I can set where I want on the screen
that shows total duration with a bar that is slowly draining until it's gone."*

---

## What was already there, and why that was not the answer

Most of the machinery existed. `src/triggers/` already matched a log line, armed a
countdown and handed the timers panel a row with a bar that drains at 4 Hz; the Triggers
window's editor already had NAME / PATTERN / SHOW / TIMER-kind / duration / ENDS EARLY ON
and a "Test against my log" button. A player could already write this and get a draining
countdown:

| field | value |
|---|---|
| PATTERN | `^You begin to snarl as your features become feline\.$` |
| ENDS EARLY ON | `^The spirit of the puma departs\.$` |

So the feature was not absent. It was **mislabelled, mis-placed, and it took the boss
panel's top slot.**

That last one is the load-bearing part and it is measured, not theorised. Slots are
claimed in first-armed order and are **never** re-sorted — the rule that window was built
to hold, after a session displaced its rows 524 times. A personal buff is the worst
possible thing to put into that ordering: it is cast during the pull-in, before the boss
has cast anything, and at 146 seconds it outlasts most pulls. It would claim the top slot
and hold it for the whole fight.

The same failure is already on record from the other direction, in
`.claude/plans/archive/2026-08-07-boss-timers-self-buff-noise.md`: two mob self-buffs held
both slots on a Plane of Fear pull for fifteen minutes while Maestro of Rancor's Superior
Healing — the cast that undoes the kill — armed last and drew below them.

**Separate panels is the only arrangement in which "a row never moves" and "the boss's
cast is the row I need" are both true.**

## What shipped

### Panels are the player's

`timer.panel` on a trigger names where its countdown draws: `'boss'` for the fight's
clock, or the id of one of the player's panels in `config.timerPanels`
(`{id, title, enabled, bounds}`). A panel id rather than a two-value enum because the
panels are *theirs* — a fixed pair chosen here would be this app deciding what kinds of
waiting a player has.

**The default is `boss` and it has to stay `boss` forever.** Every pack in existence
predates the field: the sixteen shipped boss timers, every `.gtp` a guild passes around,
every trigger already authored here. An upgrade that read an absent panel as anything
else would silently relocate countdowns somebody had placed and learned to glance at.

An id naming a panel that no longer exists is deliberately **not** normalized away on
read. The store knows which panels exist and `pack.js` does not; rewriting the reference
there would destroy the assignment on a mere read.

- **Tray** grows one checkbox per panel, generated from the list.
- **Triggers window** gains `Panels…`: rename, switch, remove. Remove is offered only
  when a panel holds nothing — a panel with countdowns in it can always be switched
  **off**, which takes it off the screen and moves nobody's triggers, while deleting it
  would have to send them to the boss window, which is exactly the outcome the feature
  exists to prevent.
- **Editor** gains DRAWS IN: a select of every panel, `Boss timers` first and always,
  plus `＋ New panel…` which makes one on the way through.
- **Trigger rows** name their panel inline, struck through when that panel is off or
  gone — "why is this not on my screen" is the question the whole feature turns on.
- **Pack sub-line** says "N timers draw in a panel that is off", the same trap `live`
  covers one level up.

### The panel itself — `src/renderer/timerpanel/`

One renderer, N windows, told which it is by `?panel=<id>` on its file URL. The id rides
the URL rather than arriving over IPC because it is needed in the first frame; a window
waiting for a message would paint somebody else's rows first.

Each panel filters the one `triggerTimers` list itself rather than main splitting it N
ways — the reason is the comment already in `timers.js#applyConfig`: the push loop skips
unchanged ticks, so a renderer that can only learn about a change from the *next* snapshot
sits wrong for minutes during a lull.

Every rule the boss panel holds applies unchanged: fixed row height in every state, engine
order, never re-sorted, no scroll container anywhere, gone rather than empty between
fights, drag placeholder while unlocked.

**What differs is the bar.** It is the row's main event rather than a wash behind it, and
the text inside it is painted in a contrasting colour — so the row reports its own
progress twice: by the bar's edge, and by where the letters flip from dark-on-bright to
light-on-dark. At a glance across a room the second signal is the readable one.

Two identical text layers, one inside a mask whose width is the same fraction as the bar.
Both transition `width`, so they cannot drift apart the way an animated `clip-path`
against a custom property would. The masked copy is `aria-hidden` and both are painted
from one set of values, so they can never say different things.

The sub-line names the **full** duration (`of 2:26`) — a fraction of an unknown total is
not information. Jade rather than the boss panel's ember or the alerts' red, so which
panel you are looking at is answerable by colour from three feet.

The window box is **620×900**, larger than the boss panel's 560×560, and the arithmetic is
why: these rows are 2.93em against a 15px base where the boss panel's are 2.31em against
13px, so at the 1.8× the settings offer they are 79px against 54px — and a buff bar
legitimately holds ten rows where a fight rarely produced four. Ten rows plus the header
is 828px, which a 560px box would have quietly cut off at six.

### Durations come from your log — `src/triggers/mine-buffs.js`

The obvious implementation is a spell table. It is also wrong here, and not marginally.
Buff length depends on the caster's level, on the **rank** of the spell, and on their AAs —
and which effects a player even has is their class and their character. `Spirit of the
Puma V` and `VI` differ by thirteen seconds in one session of the live log. A shipped
table would be wrong for everybody in a slightly different way, and wrong in the direction
that matters: a countdown that ends before the buff does is worse than none, because you
learn to trust it first.

So the pairs are **discovered**:

1. A **land line** is prose that follows one of *your* `You begin casting …` lines — that
   proximity is what makes it your effect, and the cast line is where the name comes from.
2. A **wear-off line** is the body that keeps turning up a consistent interval after the
   most recent land.
3. The duration is the median of **last-land → wear-off**.

That "last" is the measurement, not a detail. Recasting **refreshes**, and the player
recasts constantly — in the live log the puma buff was recast two or three times per
cycle. Measuring from the first land of a cycle gives anything from 119 to 174 seconds
depending on how twitchy the player was; from the last it gives 146 in seven of nine
cycles.

**The filter is `rules.js` itself.** Buff prose is exactly the text no combat rule
matches — the other half of what `collect-unknown.js` has always reported. This was not
the first attempt, and the failure is worth recording: a digit-and-length filter looked
principled and let `You try to crush Hoptor Thaggelum, but miss!` straight through, which
has no digits, is short, mentions you, repeats forty thousand times and alternates
beautifully with anything. It produced **9,709 "effects"** on the live log. With the rule
table in front of it, plus strict alternation from both ends and a requirement that the
landing line be about the player, the same log yields **103** — and the top of the list is
right:

```
  Spirit of the Puma            134s ±  9  n= 25
     starts: You begin to snarl as your features become feline.
       ends: The spirit of the puma departs.
  Frenzy of Spirit               50s ±  1  n= 17
     starts: Your body channels the spirits of battle.
       ends: The spirits depart.
  O`Keil's Embers                67s ±  9  n= 12
     starts: You begin to radiate.
       ends: The radiation fades.
  Asystole                       43s ±  3  n=  9
     starts: Your heart stops.
       ends: Your heartbeat resumes.
```

Two ways in, with deliberately different strictness:

- **`node scripts/mine-buffs.js <log>`** prints candidates and writes nothing without
  `--write`, the discipline every miner here follows. It shows the loose ones *marked*,
  because knowing an effect's observed length wanders by forty seconds is exactly how you
  decide it must not ship as a fixed number.
- **"Measure my timers…"** in the Triggers window runs the same module against the
  configured log — chunked and yielding through `readLogTail`, so the tailer keeps running
  — and saves the result as an ordinary editable pack aimed at the player's first panel.
  It asks for `minObs: 5, maxCv: 0.15`, because it *saves* rather than prints: against
  three weeks of the live log that is the difference between ninety-three rows to prune and
  sixteen to glance at. The report shows the two lines each number was measured between,
  so a wrong pairing is obvious there and nowhere else.

A mined pack is never marked `shipped` — it was made from the player's log, on their
machine, and has no upstream in any build.

## Files

| file | what changed |
|---|---|
| `src/triggers/pack.js` | `timer.panel` + `BOSS_PANEL`; `packStats().byPanel` |
| `src/triggers/engine.js` | carries `panel` onto the slot and the row — carried, never decided |
| `src/triggers/gina-export.js` | `panel` joins the lossy-export report; `.gtp` has no second timer window |
| `src/triggers/mine-buffs.js` | **new** — the miner, and `mineBuffsLog` for the in-app path |
| `scripts/mine-buffs.js` | **new** — the review script |
| `src/main/config.js` | `timerPanels`; `allTimerPanels`, `timerPanelsFor`, `panelTitle`, `nextPanelId`, `PANEL_KEYS` |
| `src/main/main.js` | `createTimerPanelWindow`, `syncTimerPanels`, `panelWindows()`, per-panel tray rows, the mine-buffs handler |
| `src/main/ipc.js` | `TRIGGERS_MINE_BUFFS` |
| `src/renderer/timerpanel/` | **new** — the panel: `index.html`, `panel.css`, `panel.js`, `preload.cjs` |
| `src/renderer/timers/timers.js` | filters to `panel === 'boss'`, absence included |
| `src/renderer/triggers/` | DRAWS IN, the Panels dialog, per-row panel labels, Measure my timers |
| `docs/design/2026-08-22-my-timers-mockups.html` | the approved 1:1 mock, three row variants |

## Verified

- **925 tests pass.** New coverage: the panel default and its round-trip through
  create/update/normalize, every shipped seed trigger still on `boss`, a GINA import
  landing on `boss`, `byPanel` counts, `panel` reaching the engine's rows, two panels each
  holding first-armed order, a refresh restarting in place without changing panel, the
  config helpers against half-written entries and mute, the editor and Panels wiring, and
  the miner's last-land rule, alternation test, rule-table filter, scope limit, rank
  folding and `maxCv`.
- **Headless render** of the real renderer fed a real snapshot: four states at 1×, and ten
  rows at 1.8× inside the real 620×900 box with room to spare. No clipping, no scroll, no
  row movement across a state change.
- **End to end against the live log**: mined it, loaded the resulting pack into a real
  `TriggerEngine` beside the shipped boss pack, replayed the 22 Aug window. 77 slots armed;
  every row addressed `p1`; the puma slot ended early on
  `The spirit of the puma departs.`

In-game confirmation is James's — everything up to the pixels is verified here, and the
pixels were verified headlessly.

## Deliberately not done

- **A shipped starter pack of buff timers.** It would be wrong for every class but one.
  The miner exists because the numbers cannot come from anywhere but the player's log.
- **Auto-installing the mined pack on first run.** It would mean writing a pack derived
  from somebody's log without being asked. The button is one click and says what it found.
- **A surface switch per panel in the Triggers titlebar.** Surfaces stay two — `chips` and
  `timers` — because a titlebar that grew a button per panel would grow without bound. The
  per-panel switches live with the panels.
- **A pack-level "move every timer in this pack to…".** Trivial to add later; nobody has
  wanted it yet.
