# Architecture: a log line's journey

This is the walkthrough CLAUDE.md summarizes. It exists so that understanding the
pipeline does not require reading six files first. When this document and the code
disagree, the code has moved on — fix this file.

## The live pipeline

```
eqlog_<Char>_<server>.txt          (latin1, written by the game when /log is on)
        │  Tailer (src/main/tailer.js) — follows appends, survives truncation
        ▼
LogParser.feed(line)               (src/parser/index.js — pure Node, no Electron)
        │  timestamp.js  strips/parses "[Fri Jul 31 18:48:15 2026]" → epoch ms
        │  rules.js      ordered regex table, first match wins → typed event
        │  entities.js   raw name → canonical combatant (backtick pets fold into owner)
        │  roster.js     friendly or not; named pets; charm state
        ▼
Encounter (src/parser/encounter.js) — per-fight aggregation, three sides:
        │  dealt (byAbility), healed (byAbility, byTarget, exact overheal),
        │  taken (byAttacker, takenByAbility, takenByType, deaths, avoided swings)
        ▼
parser.snapshot() — pulled by main at 4 Hz (PUSH_HZ in src/main/ipc.js),
        │  pushed over CHANNELS.SNAPSHOT; renderers never pull
        ▼
overlay renderer — stateless view of the last snapshot; rows reused, not rebuilt
```

And the slower branch that forks off when a fight ends:

```
Encounter closes (idle timeout, zone, or all-engaged-NPCs-slain + grace)
        │  LogParser fires onEncounterEnd(encounter) — both close paths,
        │  NEVER on Ctrl+Shift+R reset (resets are deliberately unrecorded)
        ▼
persistEncounter (src/main/main.js) — serializes an UNFILTERED snapshot
        │  (the party list never narrows it; view-time filters belong to the view),
        │  skips encounters with zero damage in both directions,
        │  toasts on write failure rather than propagating
        ▼
EncounterStore.append (src/main/history.js)
        │  JSONL, one file per character: <userData>/history/Rhale_oggok.jsonl
        │  one record per line, v: 1, id = "<startTs>-<endTs>" (the dedup key
        │  scripts/backfill-history.js relies on)
        ▼
History window — reads via HISTORY_LIST / HISTORY_GET / HISTORY_CLEAR
```

## The event vocabulary

`rules.js` emits events tagged with a `kind`. The full set, so a new rule lands in
the right bucket and a handler switch is checked against reality:

`chat` `group` `who` `targeted` `logging` `zone` `cast` `charm` `pet-owner`
`damage` `miss` `death` `heal` `effect` `environmental` `nonmelee-unattributed`

Chat kinds come first in the table — a player quoting "he hits me for 100 points of
damage" in /general must match as chat before the damage patterns ever see it.
Melee parsing depends on the `ATTACK_VERBS` whitelist because target names contain
spaces; a missing verb means that mob's melee silently never parses (this happened:
evil eyes `smash`, surfaced by `collect-unknown.js` against the live log).

## Processes and windows

One Electron main process owns ALL state: the parser, the tailer, the config store,
the history store, the tray, the hotkeys. Renderers are pure views that receive
pushes; none of them holds parser state.

| Window | Source | Character |
|---|---|---|
| Overlay | `src/renderer/overlay/` | Frameless, transparent, click-through, always-on-top. Warm parchment palette. The only window with the no-scroll invariant. |
| History | `src/renderer/history/` | Dedicated window (tray → History…), three fixed panes, no reflow ever. Same warm palette — it is the overlay's record book. Panes scroll internally, which is fine here. |
| Setup / Settings | `src/renderer/setup/` | First-run wizard and the settings form. Cool slate palette, deliberately distinct. |

Preloads are `.cjs` (sandboxed preload + `"type": "module"` in package.json).
Every channel name lives in `src/main/ipc.js`, imported by main and preloads alike,
so a rename breaks at import time instead of silently doing nothing. The channels
fall into three groups: main→renderer pushes (snapshot, status, hover, toast…),
renderer→main invokes that return values (config, logs, history…), and
fire-and-forget sends (fit-window, reset, toggles).

## The purity map

The load-bearing design decision: anything that can be pure Node, is. These modules
have zero Electron imports and run under `node --test` in WSL:

- all of `src/parser/` — the entire scoring pipeline
- `src/main/layout.js` — window geometry and clamps
- `src/main/history.js` — the store takes its directory as a constructor argument
- `src/renderer/overlay/breakdown.js` — breakdown column arithmetic
- `src/renderer/history/organize.js` — boss heuristic, filters, day grouping, formatters

The pattern when adding a feature: put the logic in a pure module beside the view or
process that uses it, test it in WSL, and keep the Electron-touching file a thin shell.
`organize.js`/`history.js` (renderer) is the worked example of the split.

## Storage

- Config: `%APPDATA%\eq-legends-dps-overlay` (`ConfigStore`, `src/main/config.js`).
- History: `<userData>/history/<Char>_<server>.jsonl` — append-only; a crash can at
  worst tear the final line, and readers skip unparseable lines rather than declaring
  the file corrupt. Backfill past sessions with `scripts/backfill-history.js`.

## Where truth comes from

- `npm test` in WSL — the whole pure surface, no Electron needed.
- `tests/fixtures/combat-sample.log` — a real captured session; rule wordings marked
  `(confirmed)` were verified against it.
- The live log (path in CLAUDE.md) — the empirical backstop. `scripts/replay.js
  --print` parses it into encounters; `scripts/collect-unknown.js` lists every line no
  rule matched, which is how wording gaps are found.
- Headless Windows Chrome — drives the real renderers without the game; recipe in
  CLAUDE.md, worked example in `docs/changelog/2026-08-02-breakdown-shows-every-ability.md`.
- `docs/changelog/` — one file per completed piece of work, including the reasoning
  and the dead ends. Read these before re-litigating a design decision.
