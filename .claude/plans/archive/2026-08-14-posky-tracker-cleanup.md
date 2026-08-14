---
status: completed
---
# POSky quest tracker: log-derived turn-ins + visual cleanup

**Date:** 2026-08-14

---

## Goal

The Quests window shipped this morning and works, but James's verdict is that it
"leaves a lot to be desired" — clean it up and make it look nicer. Mid-planning he
added a second, sharper ask: **read the log for the base turn-ins and item checks
instead of needing the eqlposky import.**

Two workstreams, one plan:

**A — Log-derived turn-ins.** Turn-ins ARE logged: `You offered 1 Crude Wooden Flute
to Cilin Spellsinger.` — 171 such lines in the live log, verified today, perfectly
regular (`You offered <qty> <item> to <NPC>.`, upgrade suffixes like `+1` included,
which the quests index already normalizes away). No rule matches them today. Filtering
by NPC ∈ the sixteen dataset quest NPCs kills the vendor noise (`262 Metal Bits to
Crusader Iktra`). So the log can state, as fact, which quest items were handed to
which quest NPC — and a quest whose every item has been offered to its NPC is turned
in. The import demotes from *requirement* to *fallback for history the log never saw*
(loot and hand-ins from before logging began).

**B — Visual cleanup.** James's two named complaints first, then the rest:

1. **The text is way too small.** ("Humans read with their eyes and have to see the
   text.") The window runs a 13px body with 9.5–11.5px labels sprinkled everywhere —
   dense micro-type that optimizes for fitting data, not for a human reading it at
   monitor distance mid-raid. The type scale gets rebuilt: ≥15px body, nothing under
   12px, and the window/columns grow to fit rather than the type shrinking.
2. **The rail forces all 95 quests on screen at once.** ("I don't need to see
   everything all the time.") Class groups become collapsible — click the header,
   state remembered — so the rail shows the classes he's working and headers-with-
   progress for the rest.
3. **The reward stats are a raw `<pre>` dump of wiki text** — the single ugliest
   thing on screen. Measured against all 95 quests: 825 stat lines, ~97% falling into
   a dozen regular shapes (`Slot:`, `AC:`, `STR: +8 …`, `SV FIRE: +7 …`, `Effect:`,
   `WT: … Size: …`, `Class:`, `Race:`, flags rows). That is regular enough to parse
   into a proper EQ-style item card with a verbatim fallback for the ~25 odd lines.
4. **Class headers carry text-only `5 / 6 done` counts** — no at-a-glance progress.
5. **Multi-mob sources render as one long slash-joined string** ("Island 1.5: Noble
   Dojorn / Island 4: Overseer of Air / Island 8: the Hand of Veeshan") — 24 items
   have these; they'd read far better as island chips.
6. **The legend is a permanent paragraph** eating the items pane's bottom.
7. The donebox/checkboxes are small and the empty state is bare text.

## Approaches Considered

### A — how turn-ins and owned get set

### 1. Status quo: manual toggles + eqlposky import only
- **Description:** What shipped this morning.
- **Pros:** Maximally honest — the app never writes a claim the player didn't make.
- **Cons:** It's the thing James is asking to stop doing. The log demonstrably knows
  the answer for everything since logging began; making the player re-state it is
  busywork.

### 2. Facts-only display: show offered counts, never touch the flags
- **Description:** Count offers as a new fact column, render "2 handed in" beside
  looted, but leave done/owned entirely manual.
- **Pros:** Zero inference; cleanest fit with the facts-vs-claims doctrine.
- **Cons:** Doesn't answer the ask — James would still check 95 boxes the log already
  answered. The evidence sits on screen next to an unchecked box, which reads as the
  app being obtuse.

### 3. Log-seeded claims with provenance, manual always wins *(chosen)*
- **Description:** Offers to quest NPCs are recorded as facts (per-slot offered
  count + last date, same high-water-mark floor as loot). At read time the claims
  derive: a quest with every slot offered ≥1 to its class NPC is **done**; an item
  with surviving loot evidence (kept + stored + created − offered − sold > 0) is
  **owned**. Stored claims become tri-state (true / false / unset): a manual toggle
  or import sets an explicit value that always beats derivation, so un-checking
  sticks; derivation only fills the unset. The UI names its source: "seen in the
  log · Aug 6" vs "your claim" vs "imported".
- **Pros:** Answers the ask; stays honest because provenance is visible and facts
  never get edited; backfill makes it retroactive over the whole log for free;
  mirrors the roster philosophy (facts first, then claims, player correction final).
- **Cons:** Owned derivation is genuinely an inference — the log can't see trades or
  destroys, so it can over-claim. Bounded by the manual override and by showing the
  arithmetic in the split line.

### B — how the window gets nicer

### 4. CSS polish in place
- **Description:** Spacing, type scale, hover states; no structural change.
- **Pros:** An afternoon; zero risk.
- **Cons:** Leaves the `<pre>` dump, the flat rail, and the slash-strings — the
  actual complaints — untouched.

### 5. Targeted redesign inside the three-pane skeleton *(chosen)*
- **Description:** Keep the approved pane architecture (rail / quest / items) and
  rebuild what's inside each pane: a parsed item card for the reward, island chips
  for sources, progress bars on class headers and the titlebar, a rail filter,
  provenance-aware toggles, legend collapsed to one line.
- **Pros:** Big visual payoff where the ugliness actually is; the no-reflow contract
  and yesterday's approved IA survive; every new judgement (stats parser, source
  parser, filters) is pure and WSL-testable in organize.js.
- **Cons:** The stats parser must be honest about its failures (verbatim fallback,
  never dropped lines) — a naive one would silently eat the 25 odd lines.

### 6. Full IA redesign (class-first drill-down)
- **Description:** Rail becomes 16 class cards; middle lists that class's quests;
  right shows the quest + items.
- **Pros:** Less scrolling to one class.
- **Cons:** Discards a day-old approved design; loses the rail's whole-point answer
  ("where am I across all sixteen classes"); adds a navigation level to a window
  whose selection is already remembered across openings. More work for a worse map.

## Chosen Approach

**3 + 5.** The engine work lands first — it's pure Node, independent of any mockup,
and it's the part James explicitly asked for. The visual pass follows the project's
required flow: mockup in `docs/design/` on real ledger data, approved by James, then
implementation. The three-pane skeleton, the parchment palette, dataset rail order,
and the no-reflow contract are all keepers; everything inside the panes is fair game.

## Tasks

### Workstream A — log-derived turn-ins (no mockup gate)

- [x] `src/session/rules.js`: add an `offer` rule — `You offered <qty> <item> to
      <npc>.` → `{ kind: 'offer', item, qty, npc }`. Item names can contain
      backticks (`` Slaver`s Lash ``) and `+N` suffixes; NPC names contain spaces.
      Tests in `tests/session-rules.test.js` from live-log samples, including the
      vendor forms that must still parse (filtering is the store's job, not the
      rule's).
- [x] `src/quests/index.js`: NPC → class index over the sixteen quest NPCs, and a
      resolver `(npc, normalizedItem) → slot refs` scoped to that class. Where the
      same item fills two slots in one class, prefer the unsatisfied slot.
- [x] `src/quests/progress.js`: accept `kind: 'offer'` in `feedLine`/`feed` (today
      hard-filtered to `loot`); record per-slot `offered` count + last-offered
      timestamp as facts under the same inclusive high-water-mark floor (re-runs and
      the tailer's 64 KB seek-back must not double-count).
- [x] `src/quests/progress.js`: tri-state claims. Migrate stored booleans:
      existing `true` (manual or import) stays explicit; absent stays unset.
      Snapshot derives effective `done`/`owned` per the precedence *explicit >
      log-derived > unset*, and reports provenance (`manual` / `import` / `log`)
      per flag so the renderer can label it.
- [x] `tests/quests.test.js`: offer counting, floor dedup, derivation, precedence
      (manual un-check survives a replay of the same offer lines), rune-in-currency
      owned arithmetic.
- [x] `scripts/backfill-quests.js`: widen its rule filter so offers backfill too;
      re-run against the live log and eyeball the derived turn-ins against James's
      real eqlposky export (`tests/fixtures/posky-progress.json`) — the two should
      largely agree, and where they disagree is either pre-log history (expected) or
      a bug (interesting either way).
- [x] Renderer (small, pre-mockup): donebox and owned checkboxes show provenance
      text; item count split gains "N handed in". Import button stays, reworded as
      the pre-log fallback it now is.

### Workstream A2 — inventory snapshot (`/outputfile inventory`), James's ask

- [x] Real dump located and probed: `<EQ dir>/Rhale_oggok-Inventory.txt` — the
      filename carries character AND server, matching the log's own naming, so
      per-character store keys line up for free. Format: TSV, header row
      `Location	Name	ID	Count	Slots`, `Empty` placeholder rows to skip,
      `+N` suffixes present in names (same strip as loot), sections cover worn
      gear (`Equipment`, slot names), bags (`General*`), `Bank*`, `KeyRing`,
      `Augmentation`. **Currency-stored Wind Runes do NOT appear** — runes' owned
      state stays log-derived (stored-loot counts minus offers), which the loot
      rules already track. Fixture committed:
      `tests/fixtures/Rhale_oggok-Inventory.txt` (627 rows, real).
- [x] `src/quests/inventory.js` (pure, unit-tested against the fixture): parse the
      TSV, skip `Empty`, normalize names the same way the loot index does
      (article strip + ` +N` strip + lowercase), return item → count.
- [x] Facts from the snapshot, same doctrine as loot and offers: per-slot
      "in inventory: N as of <file date>". Two derivations: possessing a turn-in
      item → **owned** (provenance `inventory`); possessing a *reward* → **done**,
      gated on the reward's own stats text carrying NO DROP / No Trade (then
      holding one proves the turn-in, even one from before logging began — for a
      tradeable reward possession proves nothing and derives nothing).
      **Presence sets, absence never clears** — the import's only-ever-SETS rule,
      kept, because absence is weak evidence (traded, on cursor, destroyed).
      Dry-run against the real dump found **52 rewards possessed** (52 turn-ins
      proven vs the ~11 the eqlposky export claimed) and **41 turn-in items**
      auto-owned — the headline numbers for the changelog.
- [x] Watcher in main: EQ dir = parent of the configured log's `Logs/` folder
      (confirmed live); watch `<Char>_<server>-Inventory.txt` for the tailed
      character, poll its mtime alongside the tailer; a fresh dump re-derives and
      the window refreshes — the in-game flow is just "run /outputfile inventory,
      alt-tab".
- [x] Precedence extends to: explicit manual > inventory > log > import for owned;
      manual > (offers-complete OR reward-in-inventory) > import for done. Tests.

### Workstream B — visual cleanup (mockup-gated)

- [x] Mockup built in Pencil (James asked for Pencil over HTML): frame **"Quests
      Window — cleanup"** in `pencil-new.pen`, 1280×960 at 1:1 scale so approving
      it is approving readability. Shows: the rebuilt type scale, collapsible class
      groups (Bard folded / Beastlord expanded, chevrons + header progress bars),
      rail filter (All / In progress / Done), parsed reward cards (flag chip, slot
      line, stat pairs, gold effect line, footer), island chips on items,
      provenance labels ("owned — seen in the log", "2 of 4 handed in per the
      log"), handed-in splits, titlebar progress bar, one-line legend. **Get
      James's approval before touching the renderer.**
- [x] Type scale: body 13px → ≥15px and nothing under 12px anywhere (today's CSS
      runs 9.5–11.5px on caps, counts, sources, hints and the legend); all of those
      scale up with it. Widen the rail/quest columns (292px/336px today) and the
      default `questsBounds` to fit the larger type — the window grows, the type
      never shrinks.
- [x] Rail: collapsible class groups — click the class header to toggle, chevron
      indicator, collapsed state remembered per class alongside `quests.selected`;
      a collapsed header still shows its progress bar and done count; the selected
      quest's class force-expands so a restored selection is never hidden. Collapse
      is user-controlled display inside the one scrolling rail pane — the panes
      themselves still never move or resize.
- [x] `organize.js`: `parseRewardStats(raw)` → card model (flag chips; slot/skill/
      delay/dmg; stat grid; saves row; effect lines; wt/size/class/race footer;
      multi-item rewards split on `Name:` heads — 1 quest has them). Property test
      over all 95 quests: every non-empty input line lands in the model or in the
      verbatim-fallback bucket; nothing is dropped. (Execution note: the heads are
      `Windhowl:`/`Spirit Render:`, not `Name:`; and after teaching the parser the
      bow's `Range:` and `Charges: Unlimited`, all 825 corpus lines land in
      structure — the fallback set is pinned EMPTY in the property test.)
- [x] `organize.js`: `parseSources(source)` → chips (`{island, mob}` per ` / `
      segment; the rune's zone-wide form flagged distinctly; a bare-slash mob blob
      like "drake/sphinx/spirit mobs" stays one chip; an island-less segment
      continues the previous island). Tested over every dataset source.
- [x] `organize.js`: rail filter (All / In progress / Done), selection preserved
      across filter flips; default All; choice remembered like `quests.selected`.
- [x] `quests.css` + `quests.js`: render the card, the chips, thin progress bars on
      class headers (gold fill, balm at complete) and the titlebar total, bigger
      toggle targets, legend as one line with the full wording on hover, richer
      empty state. Fixed panes, no reflow — filter and selection swap content only.
- [x] Reward icons, bundled not hotlinked: `fetch-posky.js --write` also downloads
      the 97 `imageUrl` PNGs from `item-details.js` (verified: every reward entry
      has one; turn-in items have none) into `src/quests/icons/`, committed. The
      no-runtime-hotlinking invariant stands — the app ships the icons and never
      touches the wiki's CDN from the window. Render at 40×40 on the reward cards.
      (Fetched: 97 entries dedupe to **64 distinct PNGs**, 260 KB total, native
      40×40; `posky.json` quests carry `icon` and the two-item pair `cardIcons`.
      Rendering itself lands with the mockup-gated pass below.)
- [x] Hover popups, the eqlposky grammar exactly (verified in their app.js):
      mouseenter shows, mouseleave hides, click pins until Escape/click-away,
      focus/blur for keyboard. One popup component in the Quests window (it takes
      real mouse input — no click-through polling needed here). Two uses:
      **effect-name tooltips** on every rendered reward card (spell name, what it
      does, source line — James's primary ask), and **reward-card popups on rail
      rows** (icon + parsed card), which is where hovering earns its keep since
      the rail doesn't show the card.
- [x] Effect spell data: extend `fetch-posky.js` to fetch descriptions for the 46
      unique effect names in the dataset. P99 wiki covers the classic ones (Fury,
      Complete Heal — verified live); the Luclin-era ones 404 there (Herikol's
      Soothing, Vigor of Zehkes, Sha's Lethargy — verified). Fallback source
      (Allakhazam/Lucy) or hand-authored seed entries for the gap, attribution
      carried like the stats text. **An effect with no entry gets no tooltip** —
      absence honest, nothing guessed. (Fetched: `src/quests/effects.json`, 39 of
      46 with real wiki "Details" lines; 7 Legends-only effects listed under
      `missing` and left tooltip-less — hand-authoring descriptions from memory
      would be guessing, which the task itself forbids. The wiki's broken TLS chain
      is bypassed for that host only, in the dev script only, with a comment.)
- [x] Headless renderer verification per the documented Chrome-debug-port method.
- [x] `npm test` green; `scripts/dev.sh pack`; kill → repack → **relaunch**.
- [x] `docs/changelog/2026-08-14-<slug>.md`; archive this plan.

## Notes

- **Execution findings (2026-08-14, engine pass):**
  - Backfill dry-run over the live log: 410 quest events counted, **131 hand-ins**
    (of 177 `You offered` lines total; the rest were vendor/trade noise, correctly
    dropped by NPC scoping). The log derives **56 turn-ins**; the eqlposky export
    fixture claims 49 — **all 49 agree**, zero contradictions, and the 7 log-only
    extras are turn-ins made after the export was taken (export stale, log live).
    Exactly the validation the plan hoped for.
  - The plan's dry-run headline numbers ("52 rewards possessed", "41 turn-in items
    auto-owned") did not reproduce against the committed fixture: the real numbers,
    now pinned in `tests/quests-inventory.test.js`, are **7 NO DROP rewards
    possessed → 7 turn-ins proven by inventory** and **36 turn-in item names → 40
    slots auto-owned**. All 7 inventory-proven turn-ins are also proven by offers in
    the log, so the fixture-vs-fixture story stays consistent.
  - The owned formula's "− sold" is honored by exclusion: auto-sold loot never joins
    the surviving sum. Merchant sales *from bags* (the coin-sale line) are not
    subtracted — untracked, rare for quest items, bounded by the manual override.
  - v1→v2 store migration can't tell which v1 `true` was manual vs import; a file
    that recorded an import lifts them as `import`, one that never did as `manual`.
    Mislabels cost a caption only — every non-manual source only ever asserts true.
  - Checked empirically: dataset quest items with apostrophes ("Jester's Mask") are
    spelled with apostrophes in the live log too — no backtick folding needed (the
    dump's backtick names are all non-quest items).
  - `feed`/`feedLine` return `{ refs, needed }` now, with `needed` judged BEFORE the
    event lands — otherwise the first pickup of a wanted item would derive "owned"
    and silence its own loot chip.

- **Empirical basis:** 171 `You offered` lines in the live log; sampled turn-ins
  match the dataset exactly (item names, NPC names, `+N` forms). 825 stat lines
  across 95 quests, ~12 regular shapes, ~25 stragglers (`Lore Equipped, No Trade`,
  `Cooldown: 120 seconds`, `Click Effect: …`) → verbatim fallback section, styled
  but unparsed.
- **Open question (observe live):** does `You offered` print when an NPC *refuses*
  and returns the items? If so a mis-give could derive a false done — provenance +
  manual override bound the damage, but worth watching for once live.
- **Deliberately unchanged:** dataset rail order (positional import refs), the
  facts-never-edited rule, no item icons (no hotlinking), no auto-class detection.
- **Collapse vs. the no-accordion rule:** the no-reflow contract bans *panes* that
  resize and push content under the cursor. A collapse the user performs inside the
  one scrolling rail pane is different in kind — James asked for it by name — and
  nothing outside the rail moves when a group folds.
- With offers + inventory in place, the eqlposky import covers only the narrow
  remainder (pre-log turn-ins whose reward was later destroyed); it stays because
  it's built, but the stamp line should present inventory as the primary
  fill-the-past path: run `/outputfile inventory`, not a website export.
- The mock now shows the hover work too: icon slots on both reward cards,
  underlined effect names, and the floating effect tooltip on "Sha's Lethargy"
  (frame "Effect Tooltip" inside the mock).
