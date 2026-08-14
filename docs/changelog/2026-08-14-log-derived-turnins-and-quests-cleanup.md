# Log-derived turn-ins, inventory dumps, and the Quests window cleanup

**Date:** 2026-08-14
**Plan:** `.claude/plans/archive/2026-08-14-posky-tracker-cleanup.md`

The Quests window shipped this morning needing an eqlposky.com export to know what was
already done, and looking like it was built to fit data rather than to be read. Both
went in one pass: the ledger now reads turn-ins out of the log and possessions out of
`/outputfile inventory` dumps, and the window was rebuilt against an approved Pencil
mock — bigger type, collapsible rail, parsed reward cards, island chips, provenance
captions, effect tooltips.

## The engine: claims that fill themselves, honestly

### Turn-ins are in the log

`You offered 1 Crude Wooden Flute to Cilin Spellsinger.` — the give-item line was
always there; no rule read it. A new `offer` rule in `src/session/rules.js` does now
(kind `offer`, category `loot`, item greedy so a name containing " to " splits at the
last one). The rule deliberately does not decide what is a turn-in: the recipient
arrives raw, and `src/quests/index.js` scopes it — an offer counts only when the NPC
is one of the sixteen quest NPCs AND the item is on that class's list, which silences
vendor quantity dumps (`262 Metal Bits to Crusader Iktra`) and trades to other players
with no second NPC list to go stale. The scoping is also the offer's advantage over a
loot line: a looted Wind Rune Izah could be for any of seven classes; the same rune
handed to Holwin can only be the monk test's. The session tracker drops offers on the
floor — no session pane shows gives, and a turn-in between sittings must not open a
session.

### Tri-state claims with provenance

The store's claims (`owned`, `done`) went from bare booleans to explicit
`{ value, source }` — true, false, or unset — and derivation fills only the unset, at
read time, from the facts:

- a quest whose every slot has been offered to its NPC is **done** (source `log`);
- an item with surviving loot arithmetic — kept + stored + created, minus what was
  offered away — is **owned** (source `log`), which is what makes the rune-in-currency
  case honest: offering the rune to one class's NPC takes the "owned" claim off every
  class's slot, because there is no longer a rune anywhere to be owned;
- a NO DROP reward sitting in an inventory dump proves its turn-in (source
  `inventory`) — it could not have been bought or traded, so holding one has exactly
  one explanation, even for a turn-in from before logging began. A tradeable reward
  (two of the 95, both necromancer's) proves nothing and derives nothing.

Precedence, both flags: **manual > inventory > log > import**. A manual un-check is
stored as an explicit `false` and sticks against any amount of evidence; the import
demotes to last place — a dated website snapshot the two live sources exist to
replace. Every effective flag carries its source into the snapshot, and the window
prints the receipt: "every item handed in per the log · Aug 6", "owned — in your
inventory dump", "your claim". Store file bumps to v2 with an in-place v1 migration
(v1's bare trues lift as `import` when the file recorded an import, `manual`
otherwise — a mislabel costs a caption, never a value, since every non-manual source
only ever asserts true).

### Inventory dumps

`src/quests/inventory.js` parses the game's `/outputfile inventory` TSV (fixture: the
real 627-row dump, committed). Names normalize exactly like loot (`+N` strip, article
strip, lowercase), so upgrade suffixes fold onto dataset names. Main polls the dump
file for the tailed character (`<Char>_<server>-Inventory.txt` beside the log's
`Logs/` folder) every five seconds; the store dedups on the file's own mtime, so the
in-game flow is just: run the command, alt-tab. Facts follow the import's only-ever-
SETS rule — presence sets, absence never clears — because absence is weak evidence
(traded, on cursor, destroyed). Currency-stored Wind Runes do not appear in dumps
(verified); their owned state stays log-derived.

### Measured against reality

Backfilling the live log: 410 quest events, 131 of 177 offered lines were real
hand-ins. The log derives **56 turn-ins**; James's eqlposky export claimed 49 — **all
49 agree**, zero contradictions, and the 7 log-only extras postdate the export. The
real inventory dump alone proves 7 turn-ins and auto-owns 40 slots. The loot chip's
"needed" judgement now runs BEFORE an event lands, so the first pickup of a wanted
item still chips instead of deriving "owned" and silencing itself.

## The window: built to be read

Against the approved Pencil mock ("Quests Window — cleanup", 1:1):

- **Type scale rebuilt:** 15px body, nothing under 12px anywhere (was 13px body with
  9.5–11.5px labels). Columns widen to 348/440px, default window 1280×960 — the
  window grows, the type never shrinks.
- **Collapsible rail:** click a class header to fold it; state remembered per class;
  the selected quest's class force-expands so a restored selection is never hidden.
  Headers carry thin progress bars (gold, balm at complete), as does the titlebar
  total. A filter row — All / In progress / Done — narrows quests but never drops a
  class header; selection survives filter flips. All display-state inside the one
  scrolling rail pane; nothing outside it moves.
- **Parsed reward cards** replaced the raw `<pre>` wiki dump. `parseRewardStats` in
  `organize.js` turns all 825 corpus lines into structure (flags, slot, weapon line,
  stat pairs, saves, effects with attached detail lines, WT/size/class footer; the
  beastlord pair splits into two named cards on its `Windhowl:` / `Spirit Render:`
  heads). The honesty contract is structural: every line fills an empty field,
  appends to a list, or drops verbatim into a styled fallback — occupied fields are
  never overwritten, so nothing can be silently eaten. A property test pins the
  fallback set (currently empty) across all 95 rewards.
- **Icons, bundled not hotlinked:** `fetch-posky.js --write` downloads the wiki's
  item art (97 entries dedupe to 64 PNGs, 260 KB, native 40×40) into
  `src/quests/icons/`, committed; the window never touches the network.
- **Effect tooltips:** `fetch-posky.js` also fetches each effect's own P99 wiki
  "Details" lines into `src/quests/effects.json` — 39 of 46 covered. Effect names
  with an entry render underlined; hover shows the spell's own wiki lines (never a
  summary written here), click pins until Escape or a click away, focus/blur serve
  the keyboard. The 7 Legends-only effects the wiki lacks get NO tooltip — absence
  honest, nothing guessed. The same popup component gives rail rows a hover preview
  of the full reward card.
- **Island chips:** multi-mob sources split into per-mob chips (`ISL 1.5 Noble
  Dojorn`), splitting on spaced slashes only ("drake/sphinx/spirit mobs" stays one
  blob), island inherited by continuation segments; the rune's zone-wide form gets
  its own chip.
- **Provenance everywhere:** the donebox caption names what decided the checkmark
  (including "2 of 4 handed in per the log" mid-quest); owned items carry a visible
  "owned — seen in the log" receipt; the split line gains "N handed in". The legend
  is one line with the full wording on hover; the import button stays, presented as
  the pre-log fallback (the stamp line points at `/outputfile inventory` first).

Verified headlessly (the `--dump-dom` + `document.title` assertions pattern, plus
screenshots) against a snapshot replayed from the live log: 16 headers, 95 rows,
fold/filter behavior, both pair cards with icons, tooltip on Fury, min computed font
12px. `npm test`: 808 pass. Packed and relaunched.

## Files

- `src/session/rules.js`, `src/session/session.js` — the `offer` rule; tracker drops it
- `src/quests/index.js` — NPC index, `offerSlots`, reward index (`noDrop`), `EFFECTS`
- `src/quests/progress.js` — v2 store: offers, inventory facts, tri-state claims,
  derivations, `{refs, needed}` feed contract
- `src/quests/inventory.js` — the dump parser (new)
- `src/quests/posky.json` — now carries `icon` / `cardIcons` per quest
- `src/quests/effects.json`, `src/quests/icons/` — committed wiki data (new)
- `src/main/main.js` — feed contract, inventory poll, bigger default bounds
- `src/renderer/quests/` — the rebuilt window; `organize.js` gains the parsers,
  captions and filter
- `scripts/fetch-posky.js` — icons + effects fetching (TLS relaxed for the wiki host
  only, dev script only); `scripts/backfill-quests.js` — offers replay + derived
  turn-in report
- Tests: `tests/quests-inventory.test.js` (new), plus extended quests / organize /
  session-rules suites
