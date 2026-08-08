---
status: completed
---
# Scrap the rhythm learner; ship real triggers, with their rules visible

**Date:** 2026-08-08

---

## Goal

Everything this app puts on screen should be a thing a player can read, and where possible
a thing they can edit and share. Three failures of that, which turn out to be one problem:

**1. The learned recast rhythm has never worked well, and it goes.** `src/parser/rhythm.js`
predicts a boss's next cast from a median-of-gaps computed live, mid-pull, and hedges the
result with a `~`, a spread, a "warm" state for a prior learned last week, and a retraction
path for when reality stops matching. It is a lot of machinery in the hot path to produce a
number the player cannot see the derivation of, cannot correct when it is wrong, and cannot
give to anybody else. The statistics were never the problem — the **placement** was. A
median of observed gaps is a perfectly good way to arrive at "Mana Drain every 19s"; doing
it at 4 Hz during a raid, and showing the intermediate guesses, is not. Move that
computation to authoring time, where a person reviews it, and write the answer down as a
trigger.

**2. The built-in pack is a black box.** `builtin-pack.js` describes the shipped rules in
pack shape, but where an imported trigger shows its pattern under its name, a built-in row
shows prose, and clicking it opens a dialog whose last word is a callout reading *"Curated,
not a pattern — this one is decided by a spell table checked against real sessions, not by
a regex you could edit."* The rules **are** patterns: `rules.js` holds the log-line regexes
(`cast-start`, `summon-say`, `charm`, `crowd-control`, …) and `spellwatch.js` holds the
spell-name table that sorts a cast into one of the six warn groups. Every one of those is a
worked example of the exact thing the editor asks a player to write from scratch, and we
hide all of them.

**3. There is no New button where anyone would look.** `renderContents()` runs
`$('new-trigger').hidden = builtin`, and the built-in pack is the selection every time the
window opens (`selectedPack: BUILTIN_ID`). The default view of the Triggers window has no
way to create anything. The only routes to `newTrigger()` are the *"Write my own instead…"*
button buried inside the info dialog, or selecting an imported pack first — which does not
exist if you have imported nothing. There is also **no way to create a pack at all**:
`My Triggers` is conjured by `triggerStore.myTriggers()` on first save and is invisible in
the rail until it holds something, and GINA-style groups can be toggled via `setPartEnabled`
but never created.

After this plan, every countdown on screen comes from a trigger with a pattern and a number
you can read; every parser-backed alert shows the real regex behind it and offers it as a
starting point; and writing your own is one visible button from the window's default state.

## Approaches Considered

### 1. Keep the learner, just show its numbers better
- **Description:** Leave `rhythm.js` in place, surface the learned interval and sample count
  in the timers panel and the Triggers window, and let the player override an interval.
- **Pros:** No deletion, no migration, no risk to a working raid.
- **Cons:** It is not working, which is the premise. An override UI on top of a live
  estimator is more machinery guarding a number nobody asked for, and it still cannot be
  exported, shared or read by anyone but the player who learned it. Rejected.

### 2. Rebuild *everything* the app ships — alerts and timers — as engine-run triggers
- **Description:** Convert the `spellwatch.js` table and the cast-alert path into pack
  triggers too, delete the parser's alert path, and let one engine run all of it.
- **Pros:** Total consistency; every shipped rule is the same kind of object a player writes.
- **Cons:** It throws away most of what the cast alerts actually do. They are pattern
  matches *plus* what the parser knows: is the caster hostile (a player typing "Lord Nagafen
  begins casting Complete Heal." into /general must not alert), what tier is this (banner vs
  calm line), was the cast interrupted (which clears the warning), is this a standing CC
  state or a moment that passed. None of that survives a regex. The learner has no such
  value to lose — which is exactly why it goes and the alerts stay.

### 3. Replace the learner with a shipped trigger pack; make the parser rules readable
- **Description:** Two moves. **(a)** Repurpose `scripts/seed-rhythms.js` — which already
  computes medians offline against a real log — into a generator that emits a **native
  trigger pack**: real patterns, real durations, reviewed by a person before it ships.
  Install it on first run as an ordinary pack in the rail, editable and exportable like any
  other. Then delete `rhythm.js`, `rhythms.js`, `baseline-rhythms.json`, the `castTimers`
  key and the `~`/warm rendering. **(b)** For the parser-backed alert rules that stay, derive
  their patterns from the live tables (never hand-copied), show them in a rebuilt info
  dialog, and add a "Start a trigger from this" button that opens the editor prefilled with
  the pack-shaped equivalent.
- **Pros:** The timers panel drops to one kind of row and one source of truth. A shipped
  countdown becomes visible, editable, exportable and shareable — a guild can pass its boss
  pack around, which is the entire reason GINA compatibility was built. The derived alert
  patterns cannot drift, because they come from the live tables and a test asserts they
  still match their own sample lines. Deletes far more code than it adds.
- **Cons:** The shipped pack starts thin (19 measured pairs, all from one player's server)
  and the durations are frozen where the learner adapted. Requires a config migration and a
  careful raw-name problem to solve (see Notes).

### 4. Ship the timers as a pack but keep the learner as a fallback for unknown bosses
- **Description:** Pack first; fall back to live learning for any (caster, ability) the pack
  does not name.
- **Pros:** New bosses still get a countdown with no authoring.
- **Cons:** Keeps every line of the machinery being scrapped, plus a precedence rule between
  the two, plus two row kinds in a panel whose founding rule is that rows must be legible at
  a glance. All of the cost, most of the confusion, none of the simplification. The honest
  answer for an unknown boss is the dry-run/Test loop that already exists: fight it, run the
  measurement script over your own log, review, add the trigger.

## Chosen Approach

**Approach 3.** The learner is deleted and its output becomes a shipped, readable,
editable trigger pack; the parser-backed rules that survive show their real patterns and
hand the player a working copy.

The organising principle, and the line to hold in review: **everything the app ships is
either a real trigger, or a parser rule that shows its real pattern.** Nothing is "curated"
in the sense of being unexplainable.

Two design decisions worth stating up front, because they are what make the replacement
strictly better rather than merely simpler:

- **Countdown-that-restarts, not `repeating`.** A shipped boss timer is a `countdown` with
  `restart: 'new'`, armed by the boss's own cast line. Each observed cast restarts the slot
  in place. That arms on cast **#1**, where the learner needed three agreeing gaps (or a
  stored prior) before it would show anything at all — so the replacement is *faster* to
  arm, not just clearer. A `repeating` timer would keep re-arming itself after the boss is
  dead, which is the failure the never-move rule cares about.
- **Death is an early-ender, not special-cased.** The CLAUDE.md invariant that a slain
  caster's rows leave immediately is preserved by giving each shipped boss trigger an
  `earlyEnders` pattern on that boss's death line — a mechanism the engine already has
  (`compileEnders`, with `${mob}` interpolation from the arming match). No new engine
  feature, and the behaviour becomes visible in the pack instead of buried in
  `RhythmTracker.dropCaster`.

Ordering matters: **the pack ships before the learner is deleted**, so no commit in this
sequence leaves the user with no boss timers.

## Tasks

### Phase 1 — the shipped boss-timer pack (the replacement)

- [x] `scripts/seed-rhythms.js` → `scripts/mine-rhythms.js`: same median-of-gaps replay, but
      it **prints a candidate trigger pack** (pattern, duration, evidence source, spread,
      sample count) and writes nothing unless `--write <file>`. Mirrors `mine-gina.js`,
      which already reports candidates and never writes on its own
- [x] Have the miner record, per pair, whether the evidence was a **cast line or a landing**
      (`RhythmStore` never stored this) so it can emit the right pattern — `begins casting`
      for the normal case, the damage line for innate breath weapons like Lava Breath that
      print no cast at all
- [x] Have the miner emit the **raw log text**, not the parser's canonical display name.
      This is the trap in the whole phase: `baseline-rhythms.json` is keyed on resolved
      names (`"Marrowbane pet"`), and a trigger pattern must match what the log actually
      says (`` Marrowbane`s warder ``). The miner must carry the raw name through from the
      matched line — see Notes
- [x] Miner prints spread and sample count per candidate and marks the loose ones, so the
      human review step has something to cut on. A pair too irregular to predict should not
      ship as a fixed number
- [x] Generate the pack from the 19 pairs in `baseline-rhythms.json` plus a fresh run over
      the live log; **review every row by hand** and drop the ones that are noise
- [x] Add each trigger's death `earlyEnders` so a slain boss's row leaves at once — confirm
      the real wording against `rules.js` (`death-self`, `death-plain`) and the live log
      before writing the pattern
- [x] `src/triggers/seed-pack.js`: the shipped pack as a native pack asset — name it for
      what it is (measured on a real server, by this app, at these dates), `origin: 'native'`
- [x] Install the seed pack into the trigger store on first run, and **never overwrite a
      copy the player has edited** — `pack.edited` already exists for exactly this
- [x] `tests/seed-pack.test.js`: every trigger compiles; every duration is inside
      `MAX_DURATION_MS`; every pattern matches its own recorded sample line; installing twice
      does not duplicate; installing over an edited copy leaves it alone

### Phase 2 — delete the learner

- [x] Delete `src/parser/rhythm.js`, `src/main/rhythms.js`, `src/main/baseline-rhythms.json`,
      `tests/rhythm.test.js`, `tests/rhythms-store.test.js`
- [x] `src/parser/index.js`: remove `RhythmTracker`, `setKnownRhythms`, `onRhythmsLearned`,
      the `noteCast`/`noteLanded`/`noteInterrupt`/`dropCaster` calls and `castTimers` from
      the snapshot
- [x] `src/main/main.js`: remove `RhythmStore`, `loadBaselineRhythms`, `persistRhythms`,
      `provideKnownRhythms` and the re-provide on character change
- [x] `src/main/config.js`: drop `castTimers` from DEFAULTS and `TIMER_KEYS`; `timersEnabled`
      becomes `!alertsMuted && triggerTimers !== false`
- [x] `src/main/config.js`: migration — a config with either timer key on keeps timers on
      (`triggerTimers = castTimers !== false || triggerTimers !== false`). They asked for
      countdowns; there is now one source of countdowns. Document it beside `migrateAlerts`
      in the same register
- [x] `src/main/main.js`: the tray's "Boss spell timers" toggle points at `triggerTimers`
- [x] `src/renderer/timers/timers.js`: `rows()` drops the two-source merge; remove the
      learned/warm branches, the `~` prefix and the "casting now" path that only learned rows
      could reach. `slotKey` keeps the explicit-key branch
- [x] `src/renderer/timers/timers.css`: remove the warm-row rule
- [x] `src/main/builtin-pack.js`: remove the `castTimers` row — that surface is a pack now
- [x] `tests/config.test.js`, `tests/parser.test.js`: drop the rhythm assertions, add the
      migration test
- [x] Re-read the CLAUDE.md timers section and the never-move invariant, and rewrite the
      parts that describe learned rows and the `~`

### Phase 3 — make the surviving parser rules visible

- [x] `src/parser/spellwatch.js`: export `SPELL_PATTERNS` — a frozen
      `{category, tier, group, source}` list built from the table's `re.source` — without
      exposing the mutable `TABLE`
- [x] `src/parser/rules.js`: export `ruleSource(id)` and the id list it answers for, so a
      display layer can read one rule's regex without importing the ordered table
- [x] `src/main/builtin-pack.js`: give each row `lineRules: [ruleId…]` and derive
      `matches: {lines: [{id, source}], spells: [{category, source}]}` from those two exports
      — **no regex string is written by hand in this file**
- [x] `src/main/builtin-pack.js`: pure `builtinRecipe(row)` returning the pack-shaped
      equivalent (`{name, pattern, literal, warnText, timerKind, durationSec}`) in the field
      names `openEditor()`'s draft already uses
- [x] `src/main/builtin-pack.js`: `ccAlerts` gets its real `lineRules` (`crowd-control`,
      `cc-self-stun`, `cc-awakened-by`, `cc-self-end`) and real `catches` — it is one of the
      rows currently showing nothing
- [x] `tests/builtin-pack.test.js`: every `matches.lines` id resolves to a real rule; every
      derived pattern compiles; **every row's recipe matches every string in that row's
      `catches`** — the anti-drift guard, so a `spellwatch.js` edit that breaks a shipped
      example fails the suite
- [x] `src/renderer/triggers/index.html`: rebuild `#info` — HOW IT MATCHES / WHAT IT CATCHES
      / WRITTEN AS A TRIGGER / WHAT THE RECIPE DOES NOT KNOW. Delete the "Curated, not a
      pattern" callout; replace `#i-author` with `#i-start-from`
- [x] `src/renderer/triggers/triggers.js`: `openInfo(row)` renders the new sections, and
      `#i-start-from` calls `newTrigger({ from: builtinRecipe(row) })`
- [x] `src/renderer/triggers/triggers.js`: show each built-in row's primary pattern under its
      name via the same `.row-pattern` class an imported trigger uses
- [x] `src/renderer/triggers/triggers.js`: rewrite the built-in `pack-note`, which claims the
      rules "are curated rather than matched from a pattern file"
- [x] `src/renderer/triggers/triggers.css`: styling for the pattern block and copy affordance

### Phase 4 — make authoring reachable

- [x] Delete `$('new-trigger').hidden = builtin` — `newTrigger()` already routes a built-in
      selection into My Triggers; the button was hidden, not the capability missing
- [x] `+ New pack` in the rail footer, always enabled, beside Export/Remove
- [x] `src/main/ipc.js`: `TRIGGERS_CREATE_PACK`, with a comment on why creating a pack is its
      own channel rather than a `saveTrigger` side effect
- [x] `src/main/main.js`: handle it — `{name}` → a `native` pack through `triggerStore.add()`
      (already routed through `freeId`/`safeId`, so a pack named `../../config` cannot escape
      the triggers directory) → `reloadTriggerPacks()`
- [x] `src/renderer/triggers/preload.cjs`: expose `createPack`; update
      `tests/preload-channels.test.js`, which asserts preload/channel parity
- [x] Renderer: new-pack prompt → create → select it → open the editor on a blank trigger, so
      "new pack" lands somewhere useful instead of on an empty list
- [x] Editor GROUP field: a `<select>` of the pack's groups plus "＋ New group…", carried
      through `saveTrigger`'s form as `groupId` / `newGroupName`; `createTrigger` makes the
      group when the latter is set
- [x] `tests/triggers-store.test.js`: creating a pack twice under one name yields two packs
      (`freeId`), and a hostile name cannot write outside the triggers directory

### Phase 5 — wrap-up

- [x] ~~Pencil~~ **HTML** mockup of the rebuilt info dialog and the rail footer, approved
      before the Phase 3/4 renderer work started — see Notes for why it is not a `.pen`
- [x] `npm test` green
- [x] Replay the live log with the seed pack installed and confirm the timers panel shows the
      same bosses the learner used to, arming *earlier* (cast #1 rather than gap #3)
- [x] `docs/changelog/2026-08-08-real-triggers-not-learned-rhythms.md` — including why the
      learner went, so nobody rebuilds it in six months
- [x] Archive `.claude/plans/2026-08-07-gina-trigger-compatibility.md` if this closes its
      last open task — archived: its one unchecked box is an explicitly declined optional
      corpus sweep ("*Not done — worth revisiting only if…*"), not outstanding work
- [ ] `scripts/dev.sh dist` so the user's `win-unpacked` launch actually shows it

## Notes

- **The raw-name trap, and why it gets its own task.** `baseline-rhythms.json` is keyed on
  the parser's *canonical* names — `entities.js` has already folded `` Marrowbane`s warder ``
  into `Marrowbane pet` and resolved every alias. A trigger pattern runs against the raw log
  line and knows none of that. Templating the canonical name into a pattern would produce
  triggers that never fire, and the dry-run would report them dead with no obvious cause. The
  miner has to carry the raw matched text through alongside the canonical key.
- **What the pack loses versus the learner, honestly.** A frozen duration does not adapt to a
  server that retunes a boss. The answer is that the player can now *see* the number is wrong
  and change it, which the learner never allowed — and `mine-rhythms.js` re-measures from
  their own log whenever they want. Adaptation moves from invisible-and-automatic to
  visible-and-manual, which for a number that drives a countdown is the right trade.
- **Why the alerts do not follow.** Kept parser-backed for the hostility guard, the tier
  ranking and the interrupt-clears-the-warning behaviour — none of which a regex can express.
  The dialog says so plainly instead of letting the copy button imply the two are equal.
  Flagging this as the one place the "everything is a real trigger" principle stops, in case
  the intent was to go further.
- **The recipe's shape.** For a warn-group row it is one regex over the `cast-start` line
  with the group's spell alternation inlined, e.g.
  `^(?<mob>.+?) begins casting (?<spell>[^.]*\b(?:heal(?:ing|s)?|gate|succor|evacuate)\b[^.]*)\.$`
  with SHOW text `${mob} — ${spell}`. Long, and that is fine: it is a real pattern, and a
  player who wants a shorter one now has something to cut down.
- **The pack starts thin.** Nineteen pairs, all measured on oggok from one character's logs.
  That is honest and it is a floor, not a ceiling: `mine-gina.js` already reports spell names
  recurring across independent GINA packs, which is the obvious next source of authored
  durations, and the pack is exportable so a guild can grow it collectively. The pack's own
  description should say where its numbers came from.
- **Open question — the six warn switches vs. a copied recipe.** A recipe copied out of the
  info dialog fires regardless of the preset the built-in rows answer to. Worth a line in the
  dialog; not worth a mechanism.
- The `catches` samples stay. They are real log wording, and they now double as the fixture
  that keeps the derived patterns honest.

## Notes added during execution

- **The `catches` samples were wrong, and the anti-drift test is what found it.** Every
  cast example shipped in `builtin-pack.js` read *"Lord Nagafen begins to cast Complete
  Heal."*, and `rules.js` matches `beg(?:ins|in) casting` — the "to cast" wording appears
  nowhere in 983,000 lines of real log. So the shipped illustration of what a rule catches
  was a line that rule has never matched. All of them are now real lines lifted from the
  live session, and the test asserts each one is matched by at least one of its row's rules.
- **The recipe test is weaker than the plan asked for, on purpose.** The plan wanted every
  row's recipe to match every string in that row's `catches`. A row backed by several rules
  cannot: crowd control is matched by four different lines and the recipe is composed from
  the first. What is asserted instead is both halves of the honest version — every catch is
  matched by *some* rule of that row, and every catch matched by the recipe's *own* rule is
  matched by the recipe.
- **Case folding.** `spellwatch.js` matches case-insensitively and a trigger pattern cannot
  (the format stores a source string with no flags, and JS has no inline `(?i)`). The
  recipe therefore rewrites each word-initial letter as a two-case class — enough, because
  EQ writes spell names in Title Case, and *checked* rather than assumed by running every
  recipe against its own catches.
- **`pack.shipped` is new.** `touch()` marked only GINA packs as edited, on the reasoning
  that a native pack has no upstream. The seed pack is native and does have one — it sits
  in the build — so the field says which packs have something to have diverged from, and
  `installSeedPack` reads `edited` to leave a corrected copy alone.
- **The miner disagrees with `baseline-rhythms.json`, and the miner wins.** Re-measured
  over the same (now longer) log, several baseline pairs came out too irregular to ship,
  and most of what was left was noise the store had no way to filter: self-buffs, a
  friendly player's pet, and four-second chain-casts. Sixteen of 35 tight candidates
  survived review. That the old file held rows like `Footman of V`Zher | Center` — a mob
  rebuffing itself — is the clearest argument for review happening at authoring time.
- **The mockup is HTML, not Pencil.** The Pencil layout engine stopped reflowing inserted
  nodes partway through — every new node came back `fully clipped` — so the `.pen` was
  restored to its committed six frames rather than left broken, and the mockup was built as
  `docs/design/2026-08-08-rules-shown-mockups.html` instead. It is arguably the truer
  artefact: it renders with the real `triggers.css` and every pattern in it is generated
  from the live `builtinPack()`, so it shows what the window shows.
- **Verified against the live log.** All 16 shipped triggers fire: 96 arms over 1,121,986
  lines, Lava Breath 29 times. Nothing in the pack is dead.
- Two tests were added beyond the plan's list, both guarding work it asked for:
  `tests/mine-rhythms.test.js` (the miner is a new pure module, and the raw-name and
  evidence-kind rules are exactly what a test should pin) and `tests/triggers-window.test.js`
  (markup/script id parity, on the `preload-channels.test.js` precedent — a renamed id fails
  silently, which is how `#i-author` would have rotted).
