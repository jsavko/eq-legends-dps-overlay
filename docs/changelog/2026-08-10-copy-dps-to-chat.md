# Copy the meter to the clipboard, pasteable into EQ chat

**Date:** 2026-08-10

A COPY button in the overlay's unlocked controls row writes the current fight to the
Windows clipboard as **one line**, shaped to be pasted straight into an EverQuest chat
window and read by people who are not running the overlay:

```
spite golem 6:53 — 1) Syphon 182 (26%) 2) Rhale 147 (21%) 3) Sparked 122 (17%) 4) Rhain 114 (16%) 5) Taneldar 66 (9%) 6) Goneker 42 (6%) 7) Nural 39 (5%) 8) Unknown 1 (0%) | group 712 dps
```

The workflow is Ctrl+Shift+L → COPY → Ctrl+Shift+L → paste. The button is only reachable
while unlocked, which is both what was asked for and what is physically possible: the
locked overlay is click-through and the game keeps every click.

It copies **whatever metric is on screen** — the healing view copies `hps`, the taken view
copies `dtps` — so the button's meaning is always the meter directly above it. Copying
works between pulls as well as during one: `snapshot()` returns `this.current ?? this.last`,
so after a fight closes the meter, and therefore the copy, still describes the fight that
just ended.

## Features

### The line says exactly what the meter says, by construction

The new `src/renderer/overlay/report.js` owns two things, and it owns them together on
purpose. `rowsForMetric(snap, metric)` is the filter-and-sort that decides which rows a
metric shows — healing keys on the *cast* count so a healer whose every point was overheal
still appears, taken keeps a row at zero damage if its owner died. `chatReport(snap, metric)`
turns those same rows into the line.

`render()` now calls `rowsForMetric` too, and the inline `metric === 'healing'` /
`'taken'` branches are gone from it. That is the whole design: there is one row-selection
in the codebase, so "the copy matches the screen" holds structurally rather than by two
implementations being kept in step. The failure mode of the alternative is silent — a
copied line that disagrees with the meter, discovered only once it is in guild chat.

`METRICS`, `METRIC_CYCLE` and `formatDuration` moved into `report.js` and are imported
back into `overlay.js`, for the same reason: the header's elapsed time and the meter's
elapsed time are a claim about one fight.

### The line shrinks rather than truncates

EQ's chat input caps around 255 characters. When a group does not fit, the line gives
things up in a fixed order, each rung applied only if the previous one still overruns:

| Stage | What goes | Why it goes first |
|---|---|---|
| 0 | — | the full line |
| 1 | per-member shares | derivable from the numbers still beside them |
| 2 | the `\| group N dps` tail | it is the sum of what is already on the line |
| 3 | the `1) ` rank prefixes | the left-to-right order already says it |
| 4 | the `<label> <m:ss> —` header | leaves the bare ranking that was asked for |
| 5 | trailing members, plus `+N more` | last resort, and it says so out loud |

**Every member's name survives every stage.** A line that abbreviated "Khanvikt" would be
a line nobody can act on; dropping a member entirely is honest in a way a truncated name
is not, because the line admits it and so does the toast.

### The taken view names who died

In the taken metric only, `| deaths: Sparked, Rhale, Taneldar, Rhain` rides on the same
rung as the group tail. A taken-damage line that lists the damage while omitting that four
people hit the floor is telling the misleading half of the story — a death is the fact
that view exists to report. Named once each however many times they fell, in the order
they fell; pet deaths are excluded, for the same reason the breakdown counts them
separately.

## Bug Fixes

### The planned stage 3 shrank nothing, and was replaced

The plan called for stage 3 to "abbreviate rates via the existing `formatNumber` rule",
with `1234` → `1.2k` as the example. That abbreviation costs exactly as many characters as
it saves, at every magnitude:

```
1234   -> 1.2k     4 chars -> 4 chars
12345  -> 12.3k    5 chars -> 5 chars
123456 -> 123.5k   6 chars -> 6 chars
```

A rung built on it would have been inert — shrinking nothing and handing the overrun
straight to the rung that drops people, which is the one outcome the ladder exists to
postpone. The rung now drops the `1) ` rank prefixes instead: three characters per member,
and nothing lost that the reader cannot reconstruct from the order.

Abbreviation survives only above ten thousand, where dropping the decimal genuinely
shortens (`12345` → `12k`) and the rounding is a 3% claim. `1k` for 1,234 would be a 20%
one, and would flatten two members half a thousand DPS apart onto the same figure — so
four-figure rates stay exact however tight the line gets. This is the same "honest numbers
over guessed ones" line the parser draws; a shrink ladder is not a licence to cross it.

## Verification

Replayed the live log — 1,239,757 lines, 1,652 encounters with damage — and ran every
encounter's snapshot through `chatReport` in all three metrics. **4,413 generated lines:
none exceeded 255 characters, and none dropped a member.** Only two lines needed even the
first rung. The widest real case is a 13-member spite golem raid at 215 characters:

```
spite golem 13:49 — 1) Syphon 209 2) Rhain 114 3) Sparked 108 4) Rhale 82 5) Taneldar 59 6) Gonantik 55 7) Qeleigh 46 8) Doober 25 9) Chimkin 16 10) Sigvarr 10 11) Janer 6 12) Gobeker 2 13) Unknown 0 | group 732 dps
```

The **em dash is the only non-ASCII character** in any line the live log produced (U+2014).
EQ's chat is latin1 and prints `|` fine; the em dash is riskier — it is 0x97 in
Windows-1252 rather than anything in ISO-8859-1 proper — so it is worth eyeballing on the
first real paste, and `DASH` in `report.js` is the single edit that swaps it for a plain
`-`. Likewise `CHAT_LIMIT` is one named constant, so a measured in-game value replaces the
assumed 255 in one place.

`npm test`: 688 tests pass, including 15 new ones in `tests/report.test.js`.

## Files Modified

| File | Change |
|---|---|
| `src/renderer/overlay/report.js` | **New.** Pure, no DOM and no Electron: `rowsForMetric`, `chatReport`, the shrink ladder, `METRICS`, `METRIC_CYCLE`, `formatDuration`, `CHAT_LIMIT` |
| `tests/report.test.js` | **New.** 15 tests: per-metric row selection, the worked line, metric wording, the deaths tail, each rung of the ladder in order, a widening roster, a 24-name raid, an idle snapshot |
| `src/renderer/overlay/overlay.js` | `render()` gets its rows from `rowsForMetric`; `copyReport()` and its toasts; `METRICS`/`METRIC_CYCLE`/`formatDuration` now imported |
| `src/renderer/overlay/index.html` | `#btn-copy`, first in `#controls` — one mis-click from RESET is one too few |
| `src/renderer/overlay/overlay.css` | `flex-wrap: wrap` on `#controls`: six buttons can outgrow a narrow overlay, and this window may never clip |
| `src/renderer/overlay/preload.cjs` | `copyText(text)` over `clipboard:copy` |
| `src/main/ipc.js` | `CLIPBOARD_COPY`, with why the renderer sends finished text rather than an intent |
| `src/main/main.js` | `clipboard` imported from `electron`; the `CLIPBOARD_COPY` handler, refusing a non-string or empty payload |

## Rationale

**Why main writes the clipboard.** `navigator.clipboard.writeText` needs a focused
document and a user-gesture context. The overlay is a transparent, always-on-top,
`setIgnoreMouseEvents` window that spends its life unfocused — the case where the Async
Clipboard API fails is the case we ship, and it fails as a rejected promise, so the button
would look like it had worked. Electron's main-process `clipboard` has none of those
conditions. The channel is `invoke`, not a send, so the renderer toasts *after* the write
happened rather than announcing an outcome it did not observe.

**Why the renderer sends the text and not an intent.** This is the opposite of
`TRIGGERS_SET_BUILTIN`, which deliberately names a row rather than a config key, and the
difference is where the knowledge lives. Main would have to re-derive the on-screen row
set from `parser.snapshot()` and `config.metric` — the healing filter, the taken filter,
each view's sort — and that logic would then exist twice with a silent failure mode. The
rows are in the renderer, so the line is built in the renderer.

**Why nothing is copied when there is nothing to copy.** An empty roster returns an empty
string and the clipboard is left untouched. Wiping whatever the player had copied, to
replace it with an empty meter, would be the worst possible outcome of pressing a button
labelled COPY. Main refuses an empty payload independently, so that holds even if a caller
forgets.

**Why one line and not the full breakdown.** This is a *chat* feature and the constraint is
the chat box: EQ takes one line per paste, so a 30-line report arrives as one line or as
nothing. The no-truncation invariant still governs every surface that can grow — the hover
panel and the History window show every ability, always — but a format that ignores the
medium it is pasted into is a format nobody can use.

## Not in scope

- **A copy hotkey.** Ctrl+Shift+C while locked would skip the two unlock presses entirely
  and is the obvious follow-up, but the button on the unlocked screen is what was asked
  for and hotkeys are a config surface of their own.
- **Copy buttons in the History and Session windows**, where the same `report.js` would
  drop straight in.
- **A line per member.** EQ takes one line per paste and there is no keystroke automation
  here, nor should there be — sending keys into the game client is a different kind of
  program than this one.
