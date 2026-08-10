# The ability table names its columns, and every column means one thing

**Date:** 2026-08-10

## The report

The hover breakdown printed four cells per row and named none of them:

```
Slash     88   73%   2/3
Frenzy    25   21%     1
Kick       7    6%   1/2
Bash       1   <1%     1
```

"What is the third value?" It was hits over swings when any missed, and a bare hit count
otherwise — correct, self-consistent (2+1+1+1 against `hits 5`, the two denominators
accounting for `misses 2`), and unguessable from the screen. The sibling History window
has captioned the identical table since it shipped, so the two windows were giving a
player different amounts of help with the same numbers.

## Why the fix was not "add a header row"

The fourth cell was a **compound cell whose meaning moved per view and per row** — `2/3`
in damage, `3 · 120 over` in healing, `17 · FR` in taken. Nothing captions "hits,
sometimes over swings, sometimes with an overheal, sometimes with a resist". A header over
it would have been a half-truth on exactly the rows that confused people, and `2/3` under
a `HITS` heading reads as a fraction — arguably worse than no label at all.

So the riders are gone and every column carries **one fact**. All three views now have the
same shape: a name and four labelled numbers.

| view | columns |
|---|---|
| damage | `ability` `%dmg` `dmg` `acc` `hits` |
| healing | `ability` `%heal` `healed` `overheal` `casts` |
| taken | `ability` `%taken` `taken` `hits` `resist` |

Overhealing and the resist tag stop being riders and become data. Accuracy replaces the
`2/3` fraction, and the hit count keeps a column of its own — accuracy answers "what is
whiffing" and the count answers "how much did it actually swing", which are different
questions and were being answered by one cell.

No parser change anywhere. Every number here was already in the snapshot; this is entirely
a display-layer change, which is where the standing rule says to look first when data
seems to be missing.

## Accuracy, and the one case it must not fake

`abilityAccuracy(hits, misses)` lives in `breakdown.js` — the pure, unit-tested half of
the overlay renderer — and returns `hits / (hits + misses)`, or **null when there were no
swings**. That distinction is the whole of it:

- An ability that swung and never landed is a **real 0%**, and the most worth-reading row
  in the list. It must print.
- An ability with no swings at all — a heal, a DoT tick, an incoming ability that carries
  no swing count — has nothing to divide, and a fabricated `0%` there would say "this
  always whiffs" about a thing that never swung. It prints an em dash.

Both existing share formatters (`formatShare` in the overlay, `pct` in History) turn
anything at or below zero into a dash, so accuracy could not reuse either. `formatAccuracy`
and `accPct` are its printers, one per window, each with a comment saying why it is not
the share formatter next to it.

Spells and DoT ticks cannot miss and therefore all read 100%. That is uniform for a caster
and interesting only for melee, but it is true; the alternative — blank for anything that
never missed — would leave most of a caster's list empty.

## The caption row, and why there is one per column

The overlay cannot scroll, so the list flows into two and then three columns when one
would outgrow the work area. A header drawn once would have captioned the first column and
left the others bare — worse than no header, because it reads as applying to all of them.
`layoutAbilityColumns` now emits **one caption per rendered column**, all on grid row 1,
with the ability rows starting at row 2. The clones are marked `data-clone` and cleared on
every re-layout exactly as the row placement is, so moving from a 23-ability member to a
7-ability one leaves nothing behind.

The vertical budget accounts for it explicitly: the caption's height comes out of `nonList`
and back out of the `available` handed to `abilityColumns`, which nets to the same
arithmetic — the header sits on row 1 of every column, so it costs its height once no
matter how many columns there are.

Header cells are grid items in the same subgrid as the numbers, so **they size the tracks**.
That is why the labels are short and the caption font is 0.72em: at body size an uppercase
`OVERHEAL` would be wider than any figure beneath it and would widen that column for every
row. It is a requirement, not a style preference.

`ABILITY_TRACKS = 5` replaces the bare `4` in the placement arithmetic, with a comment
tying it to the `repeat(n, 1fr auto auto auto auto)` rules in the stylesheet — the number
lives in both files and a drift there would place rows into tracks that do not exist.

## A pre-existing bug the verification pass turned up

`#d-types` — the taken view's damage-type chips — has `display: flex` and was hidden with
the `hidden` attribute, which `display: flex` overrides. `renderDetail`'s
`dTypes.hidden = true` therefore painted nothing at all: once the taken view had filled
that row, its resist chips **stayed on screen underneath the damage and healing
breakdowns**, describing a fight the panel was no longer describing. This is the identical
trap the stylesheet already documents twenty lines up for `#session-line`; `#d-types` never
got the guard. One rule, `#d-types[hidden] { display: none; }`. Caught because it corrupted
the verification screenshots, not by looking for it.

## History gets accuracy too

Its damage table is now `ability damage share hits crits acc max`, from the same
`abilityAccuracy` — the two windows describe the same fight, and one of them knowing which
attack whiffs while the other does not is the kind of quiet divergence that makes a player
distrust both. Records written before per-ability misses were tracked have no answer and
print a dash rather than a flattering 100%.

`history.js` now imports from `../overlay/breakdown.js`, the first cross-window import in
the renderer tree. Verified loading over `file://` under the window's CSP.

**Measured cost:** the acc column takes 29px plus its 12px gap out of the ability-name
track. At the default 1200×780 History window no name ellipsizes (the track lands at
240px against a 240px longest name — on the edge, so a longer ability name than this
fight's will now clip slightly sooner than before). Below roughly 1000px wide the name
column was already being crushed, with or without this column; at the 900px minimum it
collapses entirely, which is pre-existing and untouched here.

## Verified

The real renderer driven headlessly in Windows Chrome, fed real parser snapshots replayed
out of `eqlog_Rhale_oggok.txt` — a 23-ability member (Venun, greater sphinx), a 12-heal-
ability member (Khanvikt, Lord Nagafen), a 26-taken-ability row — with main's width
negotiation simulated.

| case | window granted | cols | captions | rows shown | clipped names |
|---|---|---|---|---|---|
| damage, 1.0× | 360 × 603 | 1 | 1 | 23/23 | none |
| healing, 1.0× | 360 × 520 | 1 | 1 | 12/12 | none |
| taken, 1.0× | 360 × 718 | 1 | 1 | 26/26 | none |
| damage, 1.0×, 520px work area | 544 × 457 | 2 | 2 | 23/23 | none |
| damage, 1.0×, 360px work area | 808 × 383 | 3 | 3 | 23/23 | none |
| damage, 1.8× (slider maximum) | 976 × 795 | 2 | 2 | 23/23 | none |

The width negotiation converged in one round in every multi-column case. Header cell edges
line up with their columns' numbers to within a pixel, in every rendered column. No
container reports `scrollHeight > clientHeight` or `scrollWidth > clientWidth` anywhere.

Edge cases pinned in the same harness: three columns → seven-ability member leaves no
orphan caption clones; a one-ability list still renders its caption above the row; an
**empty** list renders nothing at all — zero children, zero height — because a caption over
nothing is noise the overlay would be taking from the game.

`npm test` — 673 passing.

## Files

- `src/renderer/overlay/breakdown.js` — `abilityAccuracy(hits, misses)`, null on no swings.
- `src/renderer/overlay/overlay.js` — `setAbilities({value, columns})` with a caption row;
  the three view functions pass four labelled columns each; `formatAccuracy`; `resistCell`;
  `ABILITY_TRACKS`; `layoutAbilityColumns` places and repeats the caption.
- `src/renderer/overlay/overlay.css` — fifth track in all three `[data-cols]` templates;
  `.a-acc` / `.a-over` / `.a-resist` alignment and floors; `li.cols` caption styling;
  `#d-types[hidden]`.
- `src/renderer/history/organize.js` — `accPct`, deliberately not `pct`.
- `src/renderer/history/history.js` — `acc` column in the damage table.
- `tests/breakdown.test.js`, `tests/history-organize.test.js` — the accuracy semantics,
  including that a real zero prints and a no-swing row does not.

## Known limits

- Spells read a uniform 100% because they cannot miss. Accepted as the honest reading; if
  it turns out to be noise, the fix is a per-ability source flag from the parser, not a
  guess in the renderer.
- No `max hit` column in the overlay. History has it and it is arguably as useful, but the
  overlay is the width-constrained surface and four value columns is what was asked for.
- The History window's ability-name column at widths near its 900px minimum was already
  unreadable and still is. Its own problem, not this one's.
