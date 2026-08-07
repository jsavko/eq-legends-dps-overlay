---
status: completed
---
# Quieter cast alerts — six switches for what warns, three presets for how much

**Date:** 2026-08-06

---

## Goal

The enemy-cast warning stack has become wallpaper. It fires for every hostile cast the
log names, at every severity, including the ones nobody can act on — and the player has
learned to look past it, which is the worst possible outcome for a window whose entire
job is to be looked at.

Measured against the live session log (`eqlog_Rhale_oggok.txt`, 149.3 hours, 920,137
lines), the current behaviour raises **9,502 warnings — 64 an hour**, with something on
screen **18.7% of the time** and a worst-case stack 16 chips deep. Per category:

| Category | Count | Per hour | Per 8h raid |
|---|---|---|---|
| unlisted (tier 0) | 5,260 | 35.2 | 282 |
| root | 1,097 | 7.3 | 59 |
| **heal** | 1,004 | 6.7 | 54 |
| nuke (calm, tier 1) | 819 | 5.5 | 44 |
| lifetap | 511 | 3.4 | 27 |
| snare | 256 | 1.7 | 14 |
| nuke (Harm Touch, tier 2) | 187 | 1.3 | 10 |
| summon | 148 | 1.0 | 8 |
| stun | 139 | 0.9 | 7 |
| **fear / mez / charm** | 81 | 0.5 | 4 |

`gate` and `dispel` never fired once in 149 hours.

That table is the whole argument. **The three warnings a player would drop everything
for — mez, charm, fear — fire 81 times in 149 hours, buried under 5,260 unlisted chips.
Signal to noise is 1:65.** And more than half of the unlisted flood is not even hostile:
2,608 of those 5,260 are spells **never once observed harming anybody** across the whole
log — `Spirit of Wolf`, `Inner Fire`, `Shield of Thistles`, `Quickness`, `Skin like
Rock`, `Center`, `Valor`, `Bravery`, `Alacrity`, `Symbol of Ryltan`. Mobs buffing
themselves. The overlay currently interrupts the player's fight to report them.

Two more sources of irrelevance sit on top:

- **26.9% of all warnings come from a mob the group is not fighting** — 14.0% with no
  encounter running at all, 12.9% mid-fight from an unengaged caster. Only 3% of tier-3
  warnings are like that, so it is almost entirely low-value noise.
- **Chips linger long after the cast is over.** 3,857 warnings had their spell resolve
  on screen (a damage or resist line), a median of **1 second** after the chip appeared
  — yet every chip sits the full 6-second TTL. **75% of that on-screen time is a cast
  that already happened.** A banner still up four seconds after the heal landed is
  actively training the player to ignore banners.

The goal: give the player real control over *what* warns rather than a single blunt
volume knob, default that control somewhere sane, make a visible chip mean "this cast is
still in flight", and keep the see-everything behaviour one click away — without
inventing a number or hiding anything the parser knows.

## Approaches Considered

### 1. A linear severity floor
- **Description:** One key, `castAlertLevel`, with three positions on the existing tier
  ladder — tier 3 only / tier 3+2 / everything.
- **Pros:** One control, reuses tier machinery that already exists and is already
  tested, removes 70% of chips at a tier-3+2 default.
- **Cons:** **The ladder sorts by danger, not by value.** It puts `root` (7.3/hr, and
  there is usually nothing to do about it) in the same tier as `Harm Touch` (1.3/hr,
  brace now), and it cannot express "heals yes, roots no" — which the numbers say is
  exactly the cut worth making. A floor set to tier 2 still admits 9.9/hr of locks to
  buy 1.3/hr of big hits.

### 2. Presets writing six grouped switches — **chosen**
- **Description:** Six switches grouped by what the player would *do* about them, and
  three presets that write those switches in one click. The preset shown is derived from
  the switches, never stored, so the two can't drift.
- **Pros:** Separates value from danger — the 0.5/hr that matters most and the 35/hr
  that matters least become independent switches. Presets keep the common case to one
  click and give the tray something compact to show. Groups are stable vocabulary; new
  spells join an existing group rather than needing a new control.
- **Cons:** Six keys instead of one, and a settings section that grows a block. Needs a
  derived-preset helper so "Custom" is a computed state rather than a stored one.

### 3. Per-category checkboxes, one per `spellwatch` category
- **Description:** Expose all eleven raw categories as individual switches.
- **Pros:** Maximum expressiveness.
- **Cons:** Two of the eleven never fire at all, and `nuke` spans two severities that
  belong in different switches — so the raw categories are the wrong unit even before
  counting the UI weight. Asks the player to learn a taxonomy before they can get
  relief from noise.

### 4. Learned self-buff suppression from harm evidence
- **Description:** A persistent per-spell store, like `rhythms.js`, recording whether a
  spell was ever observed harming a friendly; suppress those with zero harm evidence.
- **Pros:** Adaptive and empirical — new content classifies itself, the same "learn it
  from the log" instinct the boss timers already embody.
- **Cons:** A whole new store and merge policy, still noisy on a cold start in exactly
  the content where the player is watching hardest. **And the evidence test has a
  dangerous edge:** the same "never harmed anybody" measurement flags all 1,004 NPC
  *heal* warnings, the single most valuable alert the window draws. It could only ever
  demote *unclassified* casts — a large machine guarding a narrow rule.

### 5. Collapse the low tiers into one quiet line
- **Description:** Keep every warning; render the calm ones as a single compact counter
  ("3 minor casts — Inner Fire, Quickness, Spirit of Wolf") instead of a chip each.
- **Pros:** Nothing hidden; the stack stops growing and stops shoving.
- **Cons:** Compacting unhelpful information leaves it unhelpful, and a line whose text
  changes every few seconds still pulls the eye.

## Chosen Approach

**Approach 2 as the spine**, with approach 4's finding captured as a static table entry
rather than a store, plus two relevance gates that need no setting at all.

### The six switches

Grouped by what the player would *do*, not by what the spell is. Rates are measured over
the 149-hour session above.

| Switch | Covers | Rate |
|---|---|---|
| **Heals & gates** — interrupt or the kill resets | `heal`, `gate` | ~7/hr |
| **Mez, charm, fear** — the group loses control | `mez`, `charm`, `fear` | <1/hr |
| **Big hits** — survivable, worth bracing | tier-2 `nuke` (Harm Touch) | ~1/hr |
| **Roots, snares, stuns** — you're stuck, not dying | `root`, `snare`, `stun` | ~10/hr |
| **Routine nukes & taps** — named damage, nothing to do | tier-1 `nuke`, `lifetap`, `dispel` | ~9/hr |
| **Unrecognized casts** — everything else the log names | unlisted | ~18/hr |

Summons keep their existing `summonAlerts` switch and are **not** folded in: they are a
different banner shape announcing a fact rather than calling for an action, and they
already have a switch and a tray entry.

### The three presets

| Preset | Switches on | Result |
|---|---|---|
| **Essential** | heals, control, big hits | ~9/hr |
| **Balanced** *(new default)* | + roots/snares/stuns | ~19/hr |
| **Everything** | all six | ~46/hr |

Today's behaviour is ~64/hr; `Everything` lands at ~46/hr because the self-buff
suppression below applies at every preset.

### Four decisions that keep this honest and cheap

1. **Tier decides how loud, group decides whether at all.** Tiers keep their existing
   job — banner / warn line / calm line — and drive no visibility. Groups are new and
   drive only visibility. No CSS changes, and the two concerns stop being conflated.
2. **The group comes from the `spellwatch` table entry, not from the category.** `nuke`
   appears at two severities and must land in two different switches; a category→group
   map could not express that, and an entry-level `group` field does so for free.
3. **The preset is derived, never stored.** `presetOf(cfg)` is pure: if the six booleans
   match a preset's pattern, that preset is shown selected; otherwise the state is
   Custom. The six booleans are the only truth, so preset and switches cannot drift —
   the same reasoning that makes `alertsEnabled()` derived rather than owned.
4. **A missing group key reads as its DEFAULT, not as ON.** This is a deliberate
   departure from the `on()` convention in `alerts.js`, and the reason is that the
   convention exists to protect choices a player *made* — nobody ever chose these, and
   the behaviour it would preserve is the bug being fixed. `ConfigStore.load()` merges
   `DEFAULTS`, so main always sends real values; this rule only governs version skew.

### Two gates that need no setting

5. **A `buff` classification in `spellwatch.js` at tier `-1` — suppressed at every
   preset, including Everything.** Seeded from the spells the live log proves are
   self-buffs. This is approach 4's finding as a table entry instead of a store, and it
   is what makes `Everything` a usable discovery mode rather than 50% mob-buff spam. It
   stays true to the file's own rule: a spell matching nothing is still shown, and only
   spells *positively identified* as self-buffs are suppressed.
6. **Clear a warning when its cast resolves.** A spell-damage or resist line matching
   (caster, ability) drops the entry, exactly as an interrupt confirmation and a
   caster's death already do. After it, a chip on screen means *the cast is still in
   flight and you can still stop it* — worth 75% of the wasted screen time on the 3,857
   warnings that resolve while visible.

The engagement gate from the earlier draft is **dropped**: with the groups doing the
work it would buy about 200 chips out of 9,502, and it would add a second, invisible
reason a warning failed to appear — one the settings pane could not explain.

## Tasks

### Parser
- [x] `src/parser/spellwatch.js`: add a `group` field to every table entry (`heals`,
      `control`, `bigHits`, `locks`, `routine`), returned by `classify()`. Document that
      the group lives on the entry rather than being derived from the category because
      `nuke` spans two severities that belong to two different switches.
- [x] `src/parser/spellwatch.js`: add a `buff` entry at tier `-1`, group `buff`, ordered
      FIRST so a buff named like a nuke can't be claimed by a later pattern. Seed from
      the live-log evidence (spirit of wolf / wolf form, inner fire, shield of \*, skin
      like \*, symbol of \*, center, valor, bravery, alacrity, quickness, feedback,
      barrier of \*, celestial echo, tashania). Document that `-1` means "identified as
      not worth a chip", distinct from tier 0's "not identified at all" — that
      distinction is what keeps the never-hide-an-unknown rule intact.
- [x] `src/parser/index.js`: carry `group` on `hostileCasts` entries and in `snapshot()`
      (`'unknown'` for unlisted, `'summon'` for summons) so the renderer filters on one
      field and never re-derives classification.
- [x] `src/parser/index.js`: `resolveHostileCast(casterDisplay, ability)` — drop the
      matching entry, called from `handleDamage` (spell source only — melee's
      `ability: 'Hit'` must never match) and `handleResist`. Comment that NPC heals print
      no landing line, so this only shortens offensive warnings, and that the heal banner
      keeping its full TTL is correct rather than an oversight.

### Config
- [x] `src/main/config.js`: six keys in `DEFAULTS` — `warnHeals`, `warnControl`,
      `warnBigHits`, `warnLocks` on; `warnRoutine`, `warnUnknown` off. That is the
      Balanced preset, and the comment should say so and say why the default moved.
- [x] `src/main/config.js`: `WARN_GROUPS` (the six keys in settings order),
      `ALERT_PRESETS` (name → the six booleans), and pure `presetOf(cfg)` →
      `'essential' | 'balanced' | 'everything' | null`. Export alongside
      `alertsEnabled`/`timersEnabled`; no preset key is ever stored.
- [x] `src/main/config.js`: no migration. An existing config gains the new keys from
      `DEFAULTS` on the next `load()` and therefore lands on Balanced — deliberate, and
      the comment should say the `migrateAlerts()` precedent does not apply because no
      *meaning* changes here.

### Renderer
- [x] `src/renderer/alerts/alerts.js`: filter `render()` by `w.group` against the six
      keys (summon still gated on `summonAlerts`, buff never drawn), and drop
      now-hidden chips in `applyConfig` the way the category toggles already do — the
      push loop skips idle ticks, so waiting for the next snapshot can be minutes of
      staring at what you just switched off.
- [x] `src/renderer/alerts/alerts.js`: group lookup must read a missing key as its
      DEFAULT, not as ON — a second accessor beside `on()`, with the comment explaining
      why this one departs from that rule.

### Settings and tray
- [x] `src/renderer/setup/`: an "Enemy casts" block under the existing `cast-alerts`
      checkbox, indented and disabled with its parent like `cast-alert-sound` is —
      a preset radio row, then the six checkboxes with their glosses and rates. One
      hint line above states the provenance of the rates ("measured over a 149-hour
      session in current content"); a rate with no source would be exactly the kind of
      unattributed number this project refuses to print.
- [x] `src/renderer/setup/setup.js`: selecting a preset ticks its six boxes; changing
      any box leaves the boxes alone and re-derives the preset row (landing on Custom
      when it matches none). Read/write through `presetOf` so the form and the tray
      agree by construction.
- [x] `src/main/main.js`: a "Warn about" submenu inside the existing Alerts submenu —
      the three presets as **checkbox**-type items (checked = `presetOf` match, so
      Custom needs no phantom row and no forced selection), then a separator and the six
      groups. Disabled with `castAlerts`, wired through `CONFIG_SET` +
      `refreshTrayMenu()` so the checkmarks stay honest.

### Tests
- [x] `tests/spellwatch.test.js`: every entry carries a group; buff patterns classify at
      tier `-1`; a heal still classifies at 3 (`Word of Healing` must not read as a
      buff); the two `nuke` entries land in different groups; an unlisted spell still
      returns `null`.
- [x] `tests/config.test.js`: `presetOf` returns each preset for its exact pattern and
      `null` for a mixed state; every preset in `ALERT_PRESETS` covers all six keys;
      `DEFAULTS` matches the Balanced preset exactly (the test that stops the default
      and the preset drifting apart).
- [x] `tests/parser.test.js`: a landing clears its warning while a same-caster
      different-spell warning survives; a melee hit clears nothing; a suppressed buff
      cast still feeds the rhythm tracker; `snapshot()` carries `group` on every entry.

### Verification and ship
- [x] Re-run the live-log counters at each preset and record before/after (warnings per
      hour, screen occupancy, max depth) — and use the re-derived figures for the
      settings glosses rather than the ones in this plan.
- [x] Headless renderer check against a real snapshot: each preset draws exactly its own
      chips; toggling one group clears exactly its own chips on the config push alone
      with no snapshot; the tier-3 sound cue still fires for a heal and does not fire
      for a group that is switched off.
- [x] `docs/changelog/2026-08-07-quieter-cast-alerts.md`, then `scripts/dev.sh dist`
      (kill the running overlay first) so it lands in `win-unpacked`.
      (kill the running overlay first) so it lands in `win-unpacked`.

## Notes

- **Measurements** are from `eqlog_Rhale_oggok.txt` at 149.3h / 920,137 lines, via four
  throwaway instrumentation scripts in the session scratchpad. Worth re-deriving rather
  than trusting: the harm-evidence pass silently returned zero on its first run because
  damage events name the victim `target`, not `victim`, and the per-category pass needed
  `handleSummon` patched separately to see summon warnings at all.
- **The `Everything` rate (~46/hr) is lower than today's ~64/hr** purely because of the
  buff suppression. Worth stating in the changelog so it doesn't read as an accounting
  error.
- **Open question — is Balanced the right default, or Essential?** Balanced admits
  ~10/hr of roots, snares and stuns to catch the ones that actually strand a melee;
  Essential drops all of that and lands at ~9/hr total. One line in `DEFAULTS`, and the
  `presetOf` test pins them together, so flipping it later is a two-line change.
- **Not doing:** the persistent harm-evidence store (approach 4). If the static buff
  table starts lagging new content, that is the escalation — and it would slot in behind
  the same tier `-1` / group `buff`, which is why the suppression is expressed as a
  classification rather than a skip in the renderer.
- **Possible follow-up:** the settings rates are from one player's log in one era of
  content. The encounter history store already holds every fight, so the pane could
  eventually count *your own* last N hours per group instead of quoting a fixture. Not
  now — but it is the reason the rates live in the gloss text rather than being baked
  into the group definitions.
- The alerts window's oversized invisible box stays exactly as it is. Fewer chips never
  justifies shrinking it — the no-scroll invariant is priced for the worst realistic
  stack at the largest text size, and a 16-deep stack is still reachable at Everything.
- Boss timers are untouched. They are the other half of the answer to "what is this mob
  about to do", and they already only exist while a fight is running.

## Execution notes (2026-08-07)

- **The buff seed list in this plan was wrong and the empirical check caught it.** Six
  of the fifteen names — `Inner Fire`, `Center`, `Skin like Rock`, `Bravery`,
  `Symbol of Ryltan`, `Celestial Echo` — print heal lines in the log. `Celestial Echo`
  turned out to be a genuine heal-over-time (161-330 a tick) and became a tier-3 heal
  rather than a suppressed buff; the rest are the classic HP buff line, whose "heal" is
  the hit points it grants. `Tashania` (a debuff cast on the group) and
  `Chaotic Feedback` (real damage) were kept out entirely. The shipped buff line is
  narrower than planned as a result: 12.9/hr suppressed, not the ~17.5/hr estimated.
- **The rates in this plan were superseded by re-measurement** and the settings glosses
  use the measured ones. `Unrecognized casts` in particular is ~33/hr, not the ~18/hr
  predicted, partly because the narrower buff line suppresses less and partly because
  clearing a warning on resolution lets a re-cast raise a NEW warning where it used to
  refresh an existing one. Raised-count is therefore not comparable across the change;
  screen occupancy is, and it went 18.7% -> 5.9% at the default.
- **The engagement gate stayed dropped**, as planned.
- `Regrowth` never matched the heal pattern despite the comment claiming it did — fixed
  in passing.
- Answering the plan's open question: **Balanced shipped as the default** at 21.4/hr.
