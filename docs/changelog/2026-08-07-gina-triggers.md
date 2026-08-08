# GINA trigger compatibility, and one place for everything that warns you

**Date:** 2026-08-07 (window and fold-in: 2026-08-08)

## What changed

The overlay can now read GINA trigger packages (`.gtp`), run the triggers inside them
against the live log, and draw what fires on the two surfaces it already owns — warning
chips in the alerts window and countdown rows in the boss-timers panel. It can also
author its own triggers and export them back out as `.gtp`, so a trigger written here
still opens in GINA and EQ Nag.

All of it lives in a new **Triggers window** (tray → Triggers…), and **the rules this app
already shipped with moved in there too**. The ALERTS and BOSS TIMERS sections are gone
from the settings form.

## Why the built-in rules moved

The settings form and the trigger window would have been answering the same question in
two places: *what is allowed to put something on my screen.* Two places meant they could
disagree in a way neither screen surfaced — a pack switched on while the surface it drew
to was switched off, and the only symptom is that nothing ever appears.

So the curated rules are now simply the first pack in the rail, called **EverQuest
Legends** and marked `built-in`. Its rows are the settings that already existed, one per
config key: **Enemy casts** (`castAlerts`) with the six warn groups nested under it and
the sound cue, then **Summons**, **Crowd control** and **Boss timers**. The
Essential/Balanced/Everything presets moved to that pack's header.

Nothing about the stored settings changed. `src/main/builtin-pack.js` is a shim that
describes those keys in pack shape and translates a row's switch back into the key that
has always backed it, so an older config keeps meaning what it meant and the alerts
renderer needed no new vocabulary.

The rail is therefore **sources** (which packs), the titlebar is **surfaces** (chips and
timers, which is where `triggerAlerts`/`triggerTimers` went), and the detail pane is the
one row you selected. Mute still beats everything.

## A note on the numbers that were removed

The settings form used to quote a firing rate against each warn group — `~7/hr`, `~33/hr`.
Those are gone and are not in the new window either.

They were real measurements, but of the wrong thing: they averaged over a log that is
mostly *not* raid time, so "7 an hour" described hours the player was not in the content
the number implied. Re-measuring on a consistent 174.6-hour basis gave 10.8/hr for heals
and 39.1/hr for unrecognized casts — different enough from the quoted figures to make the
point that the denominator was doing the work. A test now asserts no built-in row quotes a
rate.

An imported pack's hit count stays, because it is a different kind of claim: an absolute
count against a stated number of lines, not a rate extrapolated over uneven time.

## Why a sibling engine and not part of the parser

The obvious move is to let a stranger's regexes join `rules.js`'s ordered table and ride
the snapshot the parser already builds. That was rejected outright. `src/parser/` is a
closed, curated system whose correctness *is* the product: a pack downloaded from a guild
Discord could shadow a combat rule, and a catastrophically backtracking pattern would
stall the tailer and take the DPS meter down with it. The blast radius is the whole app.

So `src/triggers/` is a sibling, fed the same lines by `main.js` and merged into the
snapshot afterwards. It is pure Node with an injected directory for its store, exactly
like `parser/`, `layout.js` and `history.js`, so it unit-tests in WSL. A pack that
misbehaves costs triggers and nothing else — the meter, the history and the learned
timers carry on.

## What the corpus actually taught us

Nine public packages (140 triggers, 31 distinct patterns) were compiled and replayed
against 948,677 real log lines. **15 of 31 patterns fire, for 6,515 matches** — and every
single survivor keys on a spell's *emote*, never on the spell's name. That is the whole
mechanism: EQ prints the same emote for every rank of a spell family, so
`(?<mob>.*) yawns` is identical on P99 and EQ Legends while "Mesmerization" became
"Mesmerization VIII". **The triggers that survive a port are the ones that never say a
spell's name at all.**

That finding shaped the headline feature. The tempting move — an import-time "adaptation"
pass that rewrites a stranger's regex toward EQL conventions — is guessing, and guessing
is the thing this project refuses to do. The honest version is a **dry-run**: replay the
pack against the player's *own* log and report what actually fires, with the dead ones
listed by pattern so a near-miss is visible rather than mysterious. Rank-suffix tolerance
is offered as an explicit, opt-in, per-pack adaptation and re-measured by the same replay.
No other automatic rewriting.

Two other things worth recording: `eq.gimasoft.com` no longer resolves, so there is no
share-code service left to integrate with, which makes a reader for the orphaned `.gtp`
files still in circulation more useful than it would have been five years ago. And the
most complete public reader, `pq-companion`'s `gina.go`, is **wrong twice** — it reads
early-enders from a non-existent `EndingTrigger` element (the real one is `EarlyEndText`,
68 uses in one package) and declares `TimerEndingTrigger` as a string when it is an
element with children. Both are silent data loss. Our reader is written against the
packages, and `tests/gina-import.test.js` pins both bugs as regressions.

## Design decisions worth keeping

- **No new dependency, and no native module.** A `.gtp` is a ZIP, so reading is a ~100-line
  pure-JS reader over Node's built-in `zlib.inflateRawSync`, and writing emits stored
  (uncompressed) entries only — a pack is a few KB, compression buys nothing, and skipping
  it removes a whole class of bugs. .NET's `ZipArchive` reads stored entries fine.
- **`{mob}`/`{player}` are not GINA tokens.** They are ordinary .NET named capture groups,
  whose syntax JavaScript shares — so the single largest class of pattern in the corpus
  needs no translation at all. The real tokens are `{C}` (character name, regex-escaped
  when it lands in a pattern), `{S}` (wildcard capture for literal triggers, referenced
  back as `{S}`, not `${S}`) and `${name}`/`${1}` group refs, where **unmatched groups must
  render empty rather than `undefined`** — real packs use `${2}${3}${4}` across an
  alternation where only one ever matches.
- **Text-to-speech falls back to chip text rather than being dropped.** 54 of 140 corpus
  triggers set `UseTextToVoice`, and in several the spoken text is the *only* output.
  Importing those as text-only would import them as silent no-ops, which is worse than
  dropping them: the player would see a trigger listed as working, doing nothing.
- **Dropped features are reported by name and count, never silently discarded** — media
  files, clipboard, counters, stopwatch timers.
- **The never-move rule survives.** Learned and trigger rows merge into one list sorted by
  `since`, not appended one block after the other — appending would mean a newly-armed
  learned row shoved every trigger row down the screen, which is exactly the displacement
  the timers window was built to end.
- **Marked, not hedged.** A trigger row shows `310s`, not `~310s`: the tilde says
  "estimate" and an authored duration is not one. It is still marked as coming from a pack,
  because "exact" and "correct for this server" are different claims and only the first is
  the author's to make.
- **`baseline-rhythms.json` is untouched.** It is documented as measured from real logs;
  merging authored GINA durations into it would quietly turn a file of measurements into a
  file of claims, and the warm-start logic that trusts it would be trusting something else.
- **Two switches, not one.** `triggerAlerts` is its own alert category rather than a branch
  of `castAlerts`, because they answer different questions — the others are what this app
  decided is worth saying, and this is what the *player* decided is. Same reasoning splits
  `triggerTimers` from `castTimers`. Mute still wins over both.

## Implementation

- **`src/triggers/unzip.js`** — pure-JS ZIP reader: EOCD scan, central-directory walk,
  stored and deflate entries. Takes the first `.xml` entry rather than hardcoding
  `ShareData.xml` (note: no "d", while the root element is `<SharedData>`), because bare
  unzipped XML also circulates and must import too.
- **`src/triggers/xml.js`** — minimal XML reader: BOM/UTF-16 detection, entities (**load-
  bearing**, since real patterns are written `(?&lt;player&gt;.*)`), CDATA, comments,
  self-closing tags, repeated siblings collapsing to arrays. `.gtp` XML is UTF-8 or UTF-16
  per its declaration — *not* latin1 like the eqlogs.
- **`src/triggers/tokens.js`** — the token model above, plus loose boolean parsing and
  `ginaDuration()` covering the ms field, bare integers, floats and `HH:MM:SS`/`MM:SS`.
- **`src/triggers/gina.js`** — `readGinaXml()` / `parseGinaPackage()`, the full field
  mapping, returning `{ pack, dropped }`.
- **`src/triggers/pack.js`** — native JSON pack schema, `validate()`, `normalize()`, and
  the authoring ops `createTrigger()` / `updateTrigger()` / `deleteTrigger()`. A pattern
  that does not compile is never saved.
- **`src/triggers/zipwrite.js`**, **`gina-export.js`** — stored-entry ZIP writer with CRC32,
  and pack → `SharedData.xml` → `.gtp` with a report of everything GINA's schema cannot
  express.
- **`src/triggers/engine.js`** — `TriggerEngine`: one-time regex compilation, a literal
  prefilter (`String.includes` before the regex), per-trigger timer state honouring
  `TimerStartBehavior`, early enders and ending-time emphasis, and a **per-trigger time
  budget** that disables a pattern which repeatedly overruns and names it. That last one is
  the specific failure the sibling-engine design was chosen over, so the engine handles it
  rather than merely being isolated when it happens.
- **`src/triggers/dryrun.js`** — `dryRun()`, `testPattern()`, `rankTolerantPattern()`,
  `readLogTail()` (chunked and yielding, so a 79 MB scan cannot stall the tailer) and
  `dryRunLog()`.
- **`src/main/triggers-store.js`** — `TriggerStore(dir)`: one JSON file per pack under
  `<userData>/triggers/`, directory injected for testing, same construction rules as
  `EncounterStore`. A pack id can never escape the directory; one corrupt pack does not
  take the others down.
- **`src/main/main.js`** — feeds each tailed line to the engine alongside `parser.feed`,
  merges `warnings` into `hostileCasts` and `timers` into a new `triggerTimers` field, and
  recompiles on character switch, config change and pack enable/disable. Ten IPC handlers
  registered.
- **`src/renderer/alerts/alerts.js`** — one branch in `shows()`. A trigger chip deliberately
  does *not* pass through the six warning groups: those sort casts by what this app decided
  the player would do about them, and a trigger is something the player already decided is
  worth seeing. The sub-line names the pack — the honest answer to "why is this on my
  screen", and the thing they would go and switch off.
- **`src/renderer/timers/timers.js`, `timers.css`** — merged row list, explicit slot keys
  (two packs may name a countdown the same thing), the pack mark, and the `sources` heading
  when the panel holds both kinds.

## Mining the corpus: an empty result that is worth recording

`scripts/mine-gina.js` (over a pure `src/triggers/mine.js`) reads a directory of packages
and reports the spell names recurring across the most *independent* packs — one pack votes
once per spell however many of its triggers repeat it, so the pack that is 34 copies of one
pattern cannot outvote 34 authors. It prints candidates and never writes, like
`collect-unknown.js`.

Run over the committed corpus it returns **zero candidates**, and that is the finding
rather than a failure. Every pattern in the corpus is emote-keyed or slain-keyed; not one
names a spell. It is this feature's central measurement seen from the other end — the
triggers that survive a port between servers are exactly the ones that never say a spell's
name, so a name-keyed mine over them is empty by construction. A test pins it, so if the
fixtures ever change the claim gets re-checked.

So there are **no `spellwatch.js` additions**: adding any would have meant inventing names
the corpus does not contain. It also settles the attribution question by making it moot —
nothing from anyone else's pack ships in the installer.

## What is not here

- **The corpus was not widened** beyond the nine packages already collected. `gh api
  search/code` on `TimerStartBehavior extension:xml` is the repeatable method, worth
  revisiting only if a broader sweep turns up name-keyed packs. The nine read so far
  suggest it would not.
- **Not exercised through Electron.** Everything is unit-tested in WSL, but the window
  itself has not been driven in the running app.

## Files

- `src/triggers/` — new: `unzip.js`, `xml.js`, `tokens.js`, `gina.js`, `pack.js`,
  `zipwrite.js`, `gina-export.js`, `engine.js`, `dryrun.js`, `mine.js`
- `src/renderer/triggers/` — new: the window (`index.html`, `triggers.css`, `triggers.js`,
  `preload.cjs`)
- `src/main/triggers-store.js`, `src/main/builtin-pack.js` — new
- `scripts/gina-dryrun.js`, `scripts/mine-gina.js` — new
- `src/main/{main,config,ipc}.js` — the engine wiring, the Triggers window, the tray entry,
  `triggersBounds`, and the built-in handlers
- `src/renderer/alerts/alerts.js`, `src/renderer/timers/{timers.js,timers.css}` — the
  trigger chip and trigger row
- `src/renderer/setup/{index.html,setup.js,setup.css,preload.cjs}` — ALERTS and BOSS TIMERS
  sections removed, replaced by a `Triggers…` button and a one-line summary
- `tests/fixtures/gina/` — five real packages plus a README recording sources and licences

## Verified

- **494 tests passing**, of which 130 are new across eight files: `gina-import` (38),
  `trigger-engine` (23), `trigger-pack` (22), `builtin-pack` (14), `gina-dryrun` (14),
  `triggers-store` (10), `mine` (9), `preload-channels` (1).
- Import tests assert against the committed real packages rather than hand-written XML,
  including both `gina.go` regressions.
- Round-trip: a native pack survives export to `.gtp` and re-import unchanged in its
  mappable subset, with the unmappable parts reported rather than silently lost.
- Performance measured at ~365,000 lines/second with the prefilter, against a live raid
  rate well under 100 lines/second — three orders of magnitude of headroom.
- `tests/preload-channels.test.js` pins every hand-synced preload channel name against
  `ipc.js`. The preloads must repeat those strings — a sandboxed preload is CommonJS and
  cannot import an ES module — and a typo does not fail loudly, it produces an `invoke`
  that hangs forever on a channel nobody listens to.

## One test fixed along the way

`dryRunLog yields between chunks` asserted that a 1 ms `setInterval` fired during the
scan. A 1 ms timer needs a full millisecond of wall time to become eligible and a small
scan finishes inside that, so it failed about half the time on a quiet machine — it was
measuring duration, not yielding. It now counts `setImmediate` turns, which is exactly the
invariant: the event loop turned at all. Eight consecutive green runs.
