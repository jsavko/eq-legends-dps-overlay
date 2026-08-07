---
status: created
---
# GINA trigger compatibility: read their packs, share ours

**Date:** 2026-08-07

---

## Goal

GINA (Gimagukk's Incantatory Notation Apparatus) is the EverQuest community's long-standing
trigger program, and its shared trigger packages are the closest thing EQ has to a public
library of boss-mechanic knowledge. A package is a `.gtp` file — a ZIP containing a
`SharedData.xml` of nested trigger groups — and thousands of them have been passed around
guild Discords for a decade.

Three things follow from that, and this plan does all three:

1. **Read GINA packages.** Import a `.gtp` (or a bare `SharedData.xml`) and have the
   overlay actually act on the triggers inside it.
2. **Author our own triggers, in a sharable format that is compatible.** The overlay gets a
   real trigger editor — write a pattern, say what it should show, give it a countdown — and
   what you write lands in a native JSON pack that can express things GINA cannot. That pack
   exports back out as a `.gtp`, so a trigger authored in this overlay still opens in GINA
   and EQ Nag. Authoring is not an afterthought here: without it, "our own sharable format"
   would only ever re-share other people's work.
3. **Mine the corpus.** A public trigger package is a stranger's hard-won notes on what a
   boss does. Harvested across many packs, the spell names that keep recurring are exactly
   the knowledge `spellwatch.js` exists to hold — so a mining script turns the corpus into
   reviewed additions to the curated table.

### Scope decision (confirmed with the user before writing this plan)

**Imported triggers map onto the two surfaces this app already draws** — cast-warning chips
in the alerts window and countdown rows in the boss-timers window. This is deliberately
*not* a general trigger engine: no text-to-speech, no media files, no clipboard, no
free-floating text overlay, no counters. GINA features with no honest home here are dropped
at import and **reported to the player by name and count**, never silently discarded. That
choice keeps the click-through/no-scroll invariants intact, adds no new window, and avoids
competing with EQ Nag and EQLogParser, which already are full GINA replacements.

**The native format is our own JSON pack; GINA `.gtp` is read *and* written.** The JSON
pack is the source of truth because it carries what GINA has no element for — warning
group, severity tier, and the provenance mark that separates an authored duration from a
learned estimate. Export to `.gtp` is lossy by construction and says so.

### The corpus is public, and it has already been read

The user has never used GINA, so there was no local pack to learn from. That turned out not
to matter: **nine real packages were downloaded and fully parsed during planning**, so the
schema below is measured rather than assumed.

| Source | Contents |
|---|---|
| `perotan/respawntimer` → `RespawnTimer.gtp` | 68 triggers, 35 groups, 68 early-enders |
| `mattnac/gina_cloud` → `triggers/{druid,warrior,enchanter,shaman,sieve,common_casting}.gtp`, `zone-timers-gina.gtp` | 36 triggers across six class packs |
| `mattnac/gina_cloud` → `all-data.xml` | 36 triggers, bare XML (no ZIP) — proves the unzipped form must also import |
| `jasonsoprovich/pq-companion` → `backend/internal/trigger/gina.go` | a Go reference importer, **with two confirmed bugs** (below) |

All of it is reachable with plain `curl` from WSL, and a 25-line pure-`zlib` extractor read
every one — which also demonstrates ahead of time that the no-new-dependency claim in this
plan holds. Phase A's fixture task is therefore a download, not a hunt.

### What this feature is worth — measured against 949,000 real log lines

The whole corpus was compiled and replayed against `eqlog_Rhale_oggok.txt` (78.9 MB,
948,677 lines, 149 hours) during planning. **This is no longer a guess.**

The 140 triggers collapse to **31 distinct patterns** (the RespawnTimer pack is 34 copies of
one "slain" pattern, one per zone-respawn duration). Of those 31:

**15 fire — 48% — for 6,515 matches.** And *what* fires is the finding that should shape
the whole feature:

|  hits | trigger | pattern |
|---:|---|---|
| 1,494 | respawn / zone timer | `(You have slain (?<mob>.*)!)\|…` |
| 989 | slow landed | `(?<mob>.*) yawns` |
| 537 | damage shield | `(?<player>.*) ((is)\|(are)) surrounded by a thorny barrier` |
| 463 | resist | `^(?<player>.*) is resistant to (?<effect>.*)\.$` |
| 294 | regen | `(?<player>.*) begins? to regenerate` |
| 294 | slow | `(?<mob>.*) slows down` |
| 238 | skin buff | `(?<player>(.*'s)\|(Your)) skin turns hard as (?<type>.*)` |
| 197 | immolate | `(?<mob>.*) is surrounded by blazing flames.` |
| 165 | strength | `(?<player>.*) looks stronger` |
| 87 | malo | `(?<mob>.*) looks very uncomfortable` |
| 74 | tashani | `(?<mob>.*) glances nervously about` |
| 48 | divine power | `(?<player>…) skin shimmers with divine power` |

**Every single survivor keys on a spell's EMOTE, never on the spell's name.** That is the
mechanism, and it is why they port: EQ prints the same emote for every rank and every
variant of a spell family, so "a froglok shin knight yawns" is identical on P99 and on EQ
Legends while "Mesmerization" became "Mesmerization VIII". The user's instinct — *raid
target timers would match, spells match minus the ranks* — is right, and the data sharpens
it: **the triggers that survive a port are the ones that never say a spell's name at all.**

This is also exactly the shape of thing the overlay wants: a debuff-landed emote with an
authored duration is a buff/debuff timer, which is a countdown row.

#### The 16 dead patterns, by cause — and most are near-misses

Grepping the live log for each dead pattern's subject separates "this text does not exist"
from "this text exists, slightly reworded". Only two are genuinely absent:

| GINA expects | EQ Legends actually prints | verdict |
|---|---|---|
| `^You gain (\|party )experience!!$` | `You gain party experience! (0.769%)` | one `!`, plus a trailing percentage — the end-anchor kills it |
| `(?<mob>.*) is engulfed in a swarm` | `a froglok shin knight is engulfed **by** a swarm.` | one preposition |
| `Your spell fizzles!` | `Your **Creeping Crud** spell fizzles!` | EQL names the spell mid-sentence |
| `Your spell is interrupted.` | `Emalina's **Renewing Echo** spell is interrupted.` | same shape |
| `Your (.*) Roots spell has worn off` | `Your pet's **Ghoul Root** spell has worn off.` | possessive + singular |
| `^(?<mob>.*) staggers in pain\.$` | `A froglok shin knight staggers.` | genuinely reworded |
| `^You begin casting Harmony\.$` | `You begin casting **Spirit of Wolf V**.` | the form exists 5,095 times — **this is the rank case, confirmed** |
| `was hit by non-melee for **75** points` (×4) | — | hardcoded P99 spell damage; dead by design |
| `(?<player>**Innah**)`, `a Mistmoore guard`, `Xicotl` | — | hardcoded player / mob / zone content |
| `resisted the {S} spell` | *zero lines in 949k* | genuinely absent |
| `Thorns spring from your skin.` | *zero lines in 949k* | genuinely absent |

So the realistic ceiling is well above 48%: four are dead by design (hardcoded numbers),
three are hardcoded content, two are genuinely absent — and **seven are one wording delta
away from working**.

#### What that implies: measure, never silently rewrite

The tempting move is an import-time "adaptation" pass that rewrites a stranger's regex
toward EQL conventions. That is guessing, and guessing is the thing this project refuses to
do. The honest version is better and is already proven to work, because this plan just did
it: **replay the player's own log against a pack and report which triggers actually fire.**

That becomes the headline feature — an **import dry-run**. Before a pack is enabled, the
player sees "22 of 31 fired against your last 149 hours; 9 never matched" with the dead ones
listed. No promises, no silent rewrites, and the truth is measured against *their* log
rather than asserted from ours. Adaptations may then be offered individually and explicitly
(rank-suffix tolerance is the obvious first one), each one re-measured by the same replay.

#### Performance, also measured

31 patterns × 948,677 lines ran in **2.6 seconds** with the longest-literal prefilter — about
365,000 lines/second. A busy raid produces well under 100 lines/second. The prefilter design
in this plan is not merely adequate, it is three orders of magnitude clear, and the same
harness doubles as the dry-run engine.

Also relevant: **`eq.gimasoft.com` no longer resolves.** GINA's own site and its share-code
service are gone. There is no online sharing endpoint left to integrate with, which (a)
rules out share codes entirely and (b) makes a reader for the orphaned `.gtp` files that
remain in circulation more useful than it would have been five years ago.

## Approaches Considered

### 1. Fold triggers into `LogParser.feed()`
- **Description:** Teach the existing parser about user triggers — a stranger's regexes
  join `rules.js`'s ordered table, trigger hits become typed events, and everything rides
  the snapshot the parser already builds.
- **Pros:** One pipeline consuming the line stream. The snapshot assembly stays in one
  place. Nothing new to wire in `main.js`.
- **Cons:** Puts arbitrary user-supplied regex inside the scoring pipeline. `src/parser/`
  is a closed, curated system whose correctness is the product; a pack downloaded from a
  Discord could shadow a combat rule, and a catastrophically backtracking pattern would
  stall the tailer and take the DPS meter down with it. The blast radius is the whole app.

### 2. Sibling engine in `src/triggers/`, merged into the snapshot by main
- **Description:** A `TriggerEngine` — pure Node, no Electron, same construction rules as
  the parser — is fed the same raw lines by `main.js`. It produces warnings and timer rows
  in exactly the shapes the alerts and timers renderers already consume, and main merges
  them into the snapshot alongside `hostileCasts` and `castTimers`.
- **Pros:** `src/parser/` stays closed and curated. A pack that misbehaves degrades
  triggers only — the meter, the history and the learned timers are untouched. The engine
  unit-tests standalone in WSL like every other pure module here. Renderers need almost no
  change because the output shapes already exist.
- **Cons:** Two consumers of the line stream instead of one, and snapshot assembly is
  split between the parser and main. Modest, and the isolation is worth it.

### 3. A dedicated trigger overlay window (full GINA replacement)
- **Description:** Build the missing half of GINA: free text overlay, TTS, sound files,
  counters, per-character trigger groups, a trigger-management window.
- **Pros:** Genuine feature parity; nothing gets dropped at import.
- **Cons:** This is a second application bolted onto the first — media asset handling in a
  project that ships none, a whole new window, a management UI dwarfing the settings form.
  Ruled out by the scope decision above.

### 4. Match in the renderer
- **Description:** Push raw log lines over IPC and run the trigger regexes in the alerts
  renderer.
- **Cons:** A raid produces hundreds of lines a second and the whole point of the 4 Hz
  push is to not forward them. A slow regex would block the paint thread of a window that
  floats over a game. Rejected outright.

### 5. Convert on import into `spellwatch.js` entries — no engine at all
- **Description:** An imported trigger just becomes another row in the spell classification
  table; no runtime matching machinery ever exists.
- **Pros:** Almost no new code, and it is exactly the right treatment for the *mining* half.
- **Cons:** Discards everything a trigger is beyond a spell name. No timers, no early
  enders, no display text — and it only works for triggers matching "begins casting", when
  most GINA triggers match emotes, says, and "You have been struck by" lines that spellwatch
  has no concept of. Insufficient on its own; adopted as the mining strategy in Phase E.

## Chosen Approach

**Approach 2 — a sibling `TriggerEngine` under `src/triggers/`, merged into the snapshot by
main**, with Approach 5 as the separate, offline mining path.

It is the only option that lets a stranger's regex run in this app without putting it
anywhere near the code that decides who did the damage. Everything in `src/triggers/` is
pure Node with an injected directory for its store, so it tests in WSL exactly like
`parser/`, `layout.js`, `history.js` and `rhythms.js` already do — and the two surfaces it
feeds, the alerts stack and the timers panel, already accept precisely these shapes.

### Dependency constraints this respects

**No native modules, and no new runtime dependency.** A `.gtp` is a ZIP, so:

- **Reading** uses Node's built-in `zlib.inflateRawSync` behind a ~100-line pure-JS ZIP
  reader (scan backwards for the end-of-central-directory signature, walk the central
  directory, inflate or copy each entry). Both stored and deflated entries; zip64 is not a
  concern at `.gtp` sizes but the reader errors clearly rather than silently truncating.
- **Writing** emits **stored (uncompressed) entries only** — a trigger pack is a few KB, so
  compression buys nothing and skipping it removes a whole class of bugs. .NET's
  `ZipArchive`, which GINA uses, reads stored entries without complaint.
- **XML** is a small purpose-built reader rather than a dependency. GINA's XML is
  machine-generated by .NET's `XmlSerializer`: no namespaces, no attributes on the elements
  that matter, fixed schema. The reader must still handle a UTF-16 BOM (the .NET serializer
  writes UTF-16 in some versions), CDATA, comments, self-closing tags, XML entities, and
  repeated siblings collapsing to arrays. **Note the encoding trap: `.gtp` XML is UTF-8 or
  UTF-16 per its declaration — it is *not* latin1 like the eqlogs.**

### The GINA container, as measured

- **The ZIP entry is `ShareData.xml` — no "d" — while the root element is `<SharedData>`.**
  All nine packages agree. The reader must still not hardcode the name: take the first
  `.xml` entry, because `all-data.xml` proves bare unzipped XML also circulates and must
  import too.
- Every observed entry is DEFLATE, handled by `zlib.inflateRawSync`.
- **XML entity decoding is load-bearing, not cosmetic.** Real patterns are written
  `(?&lt;player&gt;.*)` — without decoding they are broken regexes, not merely ugly ones.
- Booleans are strings and must be read loosely: `True`/`true`/`1`/`yes`.
- `Triggers` normally sits inside a `TriggerGroup`, but a top-level `SharedData > Triggers`
  is valid (unobserved here, handled by the Go reference impl). Support both.

### The token model, settled empirically

GINA's documentation is offline, so this was recovered from 114 `{C}` uses, 6 `{S}` uses and
the surrounding trigger bodies. It is **not** what this plan first guessed:

| Token | Where | Meaning | Translation |
|---|---|---|---|
| `(?<name>…)` | pattern | a **.NET named capture group** | already valid JS regex — passes through untouched |
| `${name}` | display / timer name | that group's value | JS named backreference |
| `${1}`, `${2}` | display / timer name | numbered group values | JS `$1`, `$2` — **unmatched groups must render empty, not `undefined`** (real packs use `${2}${3}${4}` across an alternation where only one ever matches) |
| `{C}` | pattern **and** output | the current character's name | substituted at compile time, regex-escaped when it lands in a pattern; recompiled on character switch |
| `{S}` | pattern **and** output | a wildcard capture for literal (non-regex) triggers, referenced back as `{S}` — *not* `${S}` | e.g. `Your target resisted the {S} spell.` → display `Resisted {S}` |
| `{COUNTER}` | output | fire count | **dropped, reported** |

The correction that matters: `{mob}`/`{player}`/`{dmg}` are **not** GINA tokens. They are
ordinary .NET named groups, and .NET's named-group syntax is identical to JavaScript's — so
the single largest category of pattern in the corpus needs no translation at all.

### The GINA field mapping

| GINA element | Becomes | Notes |
|---|---|---|
| `Name`, `Comments`, `Category`, `Modified` | pack metadata | preserved for round-trip |
| `TriggerText` + `EnableRegex` | match pattern | `EnableRegex=False` ⇒ escape as a literal (after `{S}`/`{C}` handling) |
| `UseText` + `DisplayText` | warning chip text | |
| `TimerType: NoTimer` | warning chip only | 22 of 140 in corpus |
| `TimerType: Timer` / `RepeatingTimer` | a countdown row | 118 of 140 are `Timer`; `RepeatingTimer` unobserved but handled |
| `TimerType: Stopwatch` | **dropped, reported** | a count-up has no honest home in a countdown panel; unobserved in the corpus |
| `TimerName` | the row's label | tokens substituted |
| `TimerDuration` / `TimerMillisecondDuration` | row duration | ms field wins when present. **`TimerDuration` is not always integer seconds** — it may be a float or `HH:MM:SS`/`MM:SS`. All corpus values are bare integers, but the Go impl handles the colon forms and so must we |
| `TimerStartBehavior` | slot behaviour | `StartNewTimer` (124) and `RestartTimer` (16) observed; `DoNothingIfRunning` handled defensively |
| `RestartBasedOnTimerName` | slot identity | the *rendered* `TimerName` keys the slot — which is exactly how a per-mob respawn timer distinguishes one mob from another |
| `TimerEarlyEnders/EarlyEnder/`**`EarlyEndText`** | patterns that end the row early | maps cleanly — this is how a countdown should die when the boss does |
| `TimerEndingTime` + `UseTimerEnding` + `TimerEndingTrigger` | "ending soon" emphasis | `TimerEndingTrigger` is an **element with children** (`UseText`, `DisplayText`, …), not a string |
| `TriggerGroup` nesting + `EnableByDefault` | our pack's group tree with per-group switches | |
| `UseTextToVoice` + `TextToVoiceText` | **chip text fallback** — see below | |
| `PlayMediaFile`, `CopyToClipboard`, `ClipboardText`, `InterruptSpeech` | **dropped, reported** | `PlayMediaFile` is a bare boolean carrying no filename, and no `.gtp` bundles audio — so dropping media is forced by the format, not merely by our scope |
| `UseCounterResetTimer`, `CounterResetDuration`, `{COUNTER}` | **dropped, reported** | |
| `UseFastCheck` | a hint for the literal prefilter | |

#### Two bugs in the Go reference importer — do not copy them

`pq-companion`'s `gina.go` is the most complete public reader found, and it is wrong twice.
Both were caught by diffing it against the real packages:

1. It reads the early-ender pattern from an `EndingTrigger` element. **The real element is
   `EarlyEndText`** — 68 uses in one package, zero uses of `EndingTrigger` anywhere in the
   corpus. That importer silently imports no early-enders at all.
2. It declares `TimerEndingTrigger` as a `string`. It is an element with children, so the
   ending-notification text is silently lost.

Our reader is written against the packages, and the tests assert against them.

#### Text-to-speech: a fallback, not a drop

54 of 140 corpus triggers set `UseTextToVoice`, and in several the TTS text is the **only**
output — `DisplayText` is empty. "Gift of * Mana" speaks *"Free cast for {C}"* and displays
nothing. Importing those as text-only would import them as **silent no-ops**, which is worse
than dropping them: the player would see a trigger listed as imported and working, doing
nothing at all.

So: **when `DisplayText` is empty and `TextToVoiceText` is not, the spoken text becomes the
chip text.** Costs nothing, adds no surface, and turns a third of the corpus from dead
weight into working warnings. Actually *speaking* it stays out of scope — though it is worth
knowing that a renderer's built-in `speechSynthesis` would need no native module and no
shipped assets, should the user ever want it. That is a deliberate later decision, not a
silent one.

### How it draws, and what that costs the existing invariants

- **Warnings.** Trigger hits become chips with `category: 'trigger'`, gated by a new
  `triggerAlerts` key joining `ALERT_CATEGORIES` — so a player with only triggers imported
  gets an alerts window containing only those, and turning the last category off still
  closes the window. Pack-level enablement is resolved *in the engine*, not the renderer,
  so `shows()` gains one branch and no more.
- **Timers.** Trigger rows carry `source: 'trigger'` against the learned rows' `'learned'`.
  The **never-move rule is unchanged**: a trigger row claims its slot in first-armed order
  and is held through every state it can reach. The row is marked as coming from a pack —
  not hedged as an estimate, because an authored duration is exact; marked because exact
  and *correct for this server* are different claims.
- **One documented behaviour change.** The timers panel is currently *gone* between fights,
  because a learned prediction about a mob nobody is fighting is a promise the log cannot
  keep. GINA timers are frequently out-of-combat by nature (respawns, spell durations), so
  a trigger row may run with no encounter open, and the panel exists whenever any row does.
  **With no packs imported, behaviour is bit-for-bit what it is today** — which is the
  property that makes this change acceptable rather than a regression.
- **Timer window gating** splits: `castTimers` keeps meaning "learned recast countdowns"
  and a new `triggerTimers` covers imported ones; `timersEnabled()` ORs them, and mute
  still beats both.

### Performance and safety

A raid pushes hundreds of lines a second past a table of regexes that could now number in
the hundreds. Mitigations, all cheap:

- Compile every pattern once at pack load, never per line.
- A **literal prefilter**: extract the longest literal substring from each pattern and
  `String.includes` it before running the regex. GINA's own `UseFastCheck` flag is a hint
  toward the same idea.
- **A per-trigger time budget.** A pattern that repeatedly blows it is disabled and named
  in settings, rather than being allowed to stall the tailer. This is the specific failure
  Approach 1 was rejected over, and the engine must handle it rather than merely be
  isolated from the parser when it happens.

### Mining, and the line it must not cross

`baseline-rhythms.json` is documented as *measured from real logs by `seed-rhythms`* —
never hand-written. Authored GINA durations must **not** be merged into it; doing so would
quietly turn a file of measurements into a file of claims, and the warm-start logic that
trusts it would be trusting something else. Mining output goes to two other places instead:

- **`spellwatch.js` additions** — spell names recurring across many independent packs are
  facts about the game, and the curated table is where facts about spells live. Additions
  follow the existing provenance convention, marked as corpus-derived rather than
  `(confirmed)` against a live session.
- **Optionally, a shipped starter pack** — kept separate, marked authored, and **off by
  default**. Recommendation: ship only the derived spell knowledge and *not* verbatim
  third-party packs. Redistributing another author's trigger pack inside our installer is
  an attribution question we do not need to have; the spell names are not anyone's
  authorship.

## Tasks

### Phase A — read a GINA package

- [ ] Commit the fixture corpus under `tests/fixtures/gina/`: `common_casting.gtp` (5
      triggers, `{S}` + TTS-only), `sieve.gtp` (1 trigger, named groups + `{COUNTER}`),
      `zone-timers-gina.gtp` (9 timer triggers) and a trimmed slice of `RespawnTimer.gtp`
      (`{C}` in-pattern, `${2}${3}${4}`, early-enders). Total well under 10 KB. Record the
      source URLs and licences in a fixture README. **Already downloaded and verified during
      planning** — re-fetch with `curl` from the repos named above.
- [ ] Write `src/triggers/unzip.js`: pure-JS ZIP reader — EOCD scan, central-directory walk,
      stored + deflate entries via `zlib.inflateRawSync`, clear errors on zip64/encrypted.
      Selects the first `.xml` entry rather than hardcoding `ShareData.xml`.
- [ ] Write `src/triggers/xml.js`: minimal XML → plain-object reader handling BOM/UTF-16
      detection, XML entities (**required** — patterns contain `&lt;`/`&gt;`), CDATA,
      comments, self-closing tags, and repeated siblings → arrays.
- [ ] Write `src/triggers/gina.js`: `readGinaXml(text)` and `parseGinaPackage(buffer)`,
      returning `{ pack, dropped: [{ trigger, reason }] }` per the mapping table above.
      Accepts both a `.gtp` buffer and bare XML; handles top-level `SharedData > Triggers`.
- [ ] Implement token translation in `gina.js` per the settled token model: `{C}` →
      character name (regex-escaped in patterns), `{S}` → wildcard capture referenced back as
      `{S}`, `${name}`/`${1}` → group refs with **unmatched groups rendering empty**,
      `(?<name>…)` passed through untouched, `EnableRegex=False` → escaped literal.
- [ ] Implement loose boolean parsing and `ginaDuration()` covering the ms field, bare
      integers, floats and `HH:MM:SS`/`MM:SS`.
- [ ] Implement the TTS-to-chip-text fallback (spoken text becomes chip text when
      `DisplayText` is empty), so a TTS-only trigger never imports as a silent no-op.
- [ ] Add `tests/gina-import.test.js` covering unzip, XML edge cases (UTF-16 BOM, CDATA,
      entities), the field mapping, every token form, duration formats, the TTS fallback,
      and the dropped-feature report — asserting against the committed real packages.
- [ ] Add regression tests for the two reference-implementation bugs: `EarlyEndText` is read
      (not `EndingTrigger`), and `TimerEndingTrigger`'s child `DisplayText` survives.
- [x] **Measure the hit rate.** Done during planning: 15/31 distinct patterns fire, 6,515
      matches over 948,677 lines, 2.6s with the prefilter. Findings are in the section above;
      the throwaway harness is worth re-deriving as `scripts/gina-dryrun.js` below.

### Phase B — our format, and writing GINA back out

- [ ] Write `src/triggers/pack.js`: the native JSON pack schema (`version`, groups tree,
      triggers with pattern/warning/timer/provenance), plus `validate()` and `normalize()`.
- [ ] Write `src/triggers/zipwrite.js`: stored-entry ZIP writer with a CRC32 implementation.
- [ ] Write `src/triggers/gina-export.js`: pack → `SharedData.xml` → `.gtp`, returning a
      report of everything that could not be expressed in GINA's schema.
- [ ] Write `src/main/triggers-store.js`: `TriggerStore(dir)` — one JSON file per pack under
      `<userData>/triggers/`, list/add/remove/setEnabled, directory injected for testing.
      Same construction rules as `EncounterStore` and `RhythmStore`.
- [ ] Add `tests/trigger-pack.test.js`: round-trip a native pack through GINA export and
      back through GINA import, asserting the mappable subset survives unchanged and the
      unmappable parts are reported rather than silently lost.
- [ ] Add `tests/triggers-store.test.js` against a temp dir.

### Phase C — the runtime engine

- [ ] Write `src/triggers/engine.js`: `TriggerEngine` with `setPacks()`, `setCharacter()`,
      `feed(line, ts)`, `warnings(now)`, `timers(now)`, `reset()`. Per-trigger timer state
      honouring `TimerStartBehavior`, early enders, and ending-time emphasis.
- [ ] Add the literal prefilter and one-time regex compilation to the engine.
- [ ] Add the per-trigger time budget: a pattern that repeatedly overruns is disabled and
      surfaced by name to settings.
- [ ] Add `tests/trigger-engine.test.js`: matching, `{C}` recompilation on character switch,
      each `TimerStartBehavior`, early enders, ending-time, the budget guard, and slot
      ordering (a trigger row never moves once armed).
- [ ] Wire into `src/main/main.js`: feed each tailed line to the engine alongside
      `parser.feed`, merge `warnings`/`timers` into the pushed snapshot, and recompile on
      character switch, config change and pack enable/disable.
- [ ] Update `src/main/config.js`: add `triggerAlerts` to `ALERT_CATEGORIES`, add
      `triggerTimers`, and extend `timersEnabled()` to OR the two timer sources (mute still
      wins over both). Extend `tests/config.test.js` to pin it.
- [ ] Update `src/renderer/alerts/alerts.js`: one branch in `shows()` for
      `category === 'trigger'`, and the chip shape for a trigger's display text.
- [ ] Update `src/renderer/timers/timers.js`: render the `source: 'trigger'` mark, and let
      the panel exist out of combat **only** when a trigger row is live.

### Phase C½ — the import dry-run (the headline feature)

- [ ] Write `scripts/gina-dryrun.js <pack> [--log <path>]`: compile a pack and replay it
      against a log, reporting per-trigger hit counts, a sample matched line, and the dead
      list. Re-derive it from the planning harness — it already works.
- [ ] Reuse the same code path in the app: `TriggerEngine.dryRun(pack, logPath)` so the
      settings UI reports against the player's *own* log, not against ours.
- [ ] Report dead triggers with their pattern, so a near-miss is visible and editable rather
      than mysterious.
- [ ] Offer rank-suffix tolerance as an **explicit, per-pack, opt-in** adaptation — allow an
      optional ` VIII`-style rank before a trailing anchor — and re-measure with the dry-run
      so the player sees exactly what it bought. No other automatic rewriting.
- [ ] Add `tests/gina-dryrun.test.js` against `tests/fixtures/combat-sample.log`, pinning
      the emote-keyed triggers as firing and a hardcoded-damage trigger as dead.

### Phase D — import/export UI

- [ ] Pencil mockup of the settings "Triggers" section — pack list with per-pack switches,
      Import…, Export…, Remove, and the import report — approved by the user before
      implementation, per the project convention.
- [ ] Add IPC channels to `src/main/ipc.js`: `TRIGGERS_LIST`, `TRIGGERS_IMPORT`,
      `TRIGGERS_EXPORT`, `TRIGGERS_REMOVE`, `TRIGGERS_SET_ENABLED`.
- [ ] Build the section in `src/renderer/setup/index.html` + `setup.js` against the approved
      mockup (this window takes real mouse input and may scroll — the no-scroll rule does
      not apply here).
- [ ] Show the import report honestly: "imported 41, dropped 12 — 9 text-to-speech,
      3 stopwatch", with the dropped triggers listed by name.

### Phase D½ — authoring your own triggers

The measurement in this plan is also the authoring loop: write a pattern, press **Test**,
and see it fired 989 times in your own 149 hours with a sample line. That is what GINA users
do by hand-grepping their logs, and here it falls out of the dry-run engine already built in
Phase C½. It is also what finally makes the round-trip claim true — a trigger authored here
exports as a `.gtp` and goes back to the wider EQ community.

- [ ] Pencil mockup of the editor pane, approved before implementation. Target shape:
      ```
      Pattern  [ (?<mob>.*) yawns                    ]  (● regex  ○ literal)
      Show     [ Slowed: ${mob}                       ]
      Timer    [ Countdown ▾ ]  [ 310 ]s   Ends early on [ ${mob} is no longer slowed ]

              [ Test against my log ]
              ✓ 989 hits in 948,677 lines
                e.g. "a froglok shin knight yawns."
      ```
- [ ] Extend `src/triggers/pack.js` with `createTrigger()`, `updateTrigger()`,
      `deleteTrigger()` and per-field validation — the pattern must compile, a duration must
      be positive, a name must be non-empty. A pattern that does not compile shows its
      JavaScript error inline and is never saved.
- [ ] Add a **"My Triggers"** pack, created on first authored trigger, so the player's own
      work is never mixed into an imported pack. Editing an *imported* trigger is allowed but
      marks the pack modified, so a later re-export is honest about no longer being upstream.
- [ ] Add IPC channels: `TRIGGERS_SAVE_TRIGGER`, `TRIGGERS_DELETE_TRIGGER`,
      `TRIGGERS_TEST_PATTERN`.
- [ ] **Make the log scan non-blocking.** The planning harness read 79 MB synchronously in
      2.6 s; doing that in main would stall the tailer and the 4 Hz push mid-raid. Scan the
      **tail** of the log in chunks that yield between reads, and report the honest caveat —
      "989 hits in the last 948,677 lines" — rather than implying the whole file.
- [ ] Build the editor in `src/renderer/setup/` against the approved mockup, wired to
      `TRIGGERS_TEST_PATTERN` for the Test button.
- [ ] Apply the Phase C time-budget guard to authored patterns too — a regex you wrote can
      stall the engine exactly as readily as one you imported.
- [ ] Add `tests/trigger-authoring.test.js`: pack mutation ops, validation rejections
      (uncompilable pattern, zero duration, empty name), and single-pattern dry-run counts
      against `tests/fixtures/combat-sample.log`.

### Phase E — mine the corpus

- [ ] Widen the corpus beyond the nine packages already collected — `gh api search/code` on
      `TimerStartBehavior extension:xml` found them and is the repeatable method; the
      EQLogParser "shared triggers" discussions are a second seam. Mining wants breadth
      (many independent authors agreeing) far more than the import tests do.
- [ ] Read `jasonsoprovich/pq-companion`'s `packs.go` (136 KB of curated built-in triggers
      for Project Quarm) as prior art before designing the mining output — someone has
      already done this job once, and it is worth knowing what they concluded.
- [ ] Write `scripts/mine-gina.js <dir>`: parse a directory of packs and report the spell
      names and patterns recurring across the most independent packs, with proposed
      `spellwatch.js` classifications. **Prints candidates for review; never auto-writes** —
      same discipline as `collect-unknown.js`.
- [ ] Run it over the collected corpus and apply the reviewed additions to
      `src/parser/spellwatch.js`, marked as corpus-derived rather than `(confirmed)`.
- [ ] Extend `tests/spellwatch.test.js` (or `rules.test.js`, wherever the table is guarded)
      to cover the new patterns.
- [ ] Decide and record: ship derived spell knowledge only — no verbatim third-party pack in
      the installer.

### Phase F — document and ship

- [ ] Write `docs/changelog/2026-08-07-gina-triggers.md`.
- [ ] Update `CLAUDE.md`: `src/triggers/` in the architecture section, the trigger-row
      marking and out-of-combat panel nuance in the invariants, and `mine-gina.js` in the
      commands list.
- [ ] `npm test` green, then `scripts/dev.sh dist` (kill the running overlay first).

## Notes

### Decisions already made
- Scope: map onto the existing alerts + timers surfaces; no general trigger engine, no
  spoken audio, no media, no clipboard, no counters — dropped features are reported, never
  silent.
- The import dry-run is the headline: measure a pack against the player's own log and report
  what fires. Never silently rewrite a stranger's regex to make it match.
- Authoring is in scope (Phase D½): a real editor, with the dry-run doubling as a live Test
  button. Without it the "sharable format" only ever re-shares other people's triggers.
- Format: native JSON pack is the source of truth; `.gtp` is read **and** written, lossily
  and explicitly.
- `baseline-rhythms.json` stays measurement-only. Authored GINA durations never touch it.
- TTS text falls back to chip text rather than being dropped, so a TTS-only trigger never
  imports as a silent no-op.

### Settled during planning (was open, now measured)
- **`{S}` semantics** — a wildcard capture for literal-mode triggers, referenced back as
  `{S}` rather than `${S}`. Recovered from real packs, since GINA's docs are offline.
- **`{mob}`/`{player}` are not tokens** — they are .NET named capture groups, whose syntax
  JavaScript shares. The largest class of pattern in the corpus needs no translation.
- **Fixture sources** — nine public packages, all downloadable, all parsed successfully with
  nothing but `zlib`. No local GINA install is needed by this plan at any point.
- **The reference importer is not trustworthy** — two silent data-loss bugs found by diffing
  it against real packages. Write against the packages, not against `gina.go`.
- **Hit rate against EQ Legends** — 48% of distinct patterns, and the survivors are all
  emote-keyed. Import is worth building; it is not a near-zero score.
- **Performance** — 365k lines/second with the prefilter, against a live rate under 100.

### Open questions
- **Should the dry-run run automatically on import, or on request?** It takes ~3 seconds
  against 79 MB, which is fast enough to just do it — but it needs the player's log to exist
  and be long enough to be meaningful. Leaning automatic with a "measured against N lines"
  caveat in the report.
- **Which adaptations besides rank tolerance earn their keep?** Seven dead patterns are one
  wording delta from working, but each fix is a guess about a stranger's intent. Rank
  tolerance is mechanical and safe; `Your (?:.+ )?spell fizzles` is close behind. Everything
  else probably belongs to the player editing their own trigger, not to us rewriting it.
- **Repeating timers out of combat** are the one shape that could put a permanent row on
  screen. Decide whether a `RepeatingTimer` with no encounter open should be capped or
  allowed to run forever; leaning toward allowed, since that is what the author intended
  and the player chose to import it.
- **Should `{COUNTER}` really be dropped?** It appears 20 times in the corpus, and a fire
  count is one integer of state per trigger — cheaper to support than to explain away. Left
  out of scope for now; revisit if the import report shows it is common in practice.
- **Text-to-speech**, deliberately deferred rather than closed: `speechSynthesis` in a
  renderer needs no native module and no shipped assets, and 54 of 140 corpus triggers ask
  for it. The chip-text fallback makes them work meanwhile.
