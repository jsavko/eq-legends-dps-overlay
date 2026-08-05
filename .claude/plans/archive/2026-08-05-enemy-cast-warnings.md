---
status: completed
---
# Enemy Cast Warnings (DBM-style alerts)

**Date:** 2026-08-05

---

## Goal

Show DBM-style warnings on the overlay when a hostile NPC starts casting something the
group should react to: crowd control aimed at us (mez, charm, fear, root, stun), NPC
self-heals and gates (interrupt or lose the kill), and big nukes/AEs (avoid or brace).
The native EQ UI gives almost no visibility into enemy casting; the log gives us
everything, and the overlay is already floating over the game.

Feasibility check, done against the live Rhale log (`eqlog_Rhale_oggok.txt`):

- **Cast starts name the spell.** `A cyclops begins casting Instill.`,
  `The ghoul arch magus begins casting Tishan's Clash.` — EQ Legends prints real spell
  names for NPCs (classic EQ printed an anonymous "begins to cast a spell"; that
  fallback line exists too and is already a rule). ~13k such lines in the log.
- **Interrupts are confirmed.** `a tal ghoul wizard's Instill spell is interrupted.` —
  fires for NPCs, so an alert can clear the moment the interrupt succeeds.
- **Effects are confirmed.** `a Teir`Dal rogue has been charmed.`,
  `Emalina has been mesmerized.` — landing lines exist if we ever want them.
- **The parser already parses casts.** `rules.js` `cast-start` emits
  `{kind:'cast', attacker, ability}` for every begins-casting line; `index.js` keeps a
  cast table (used today for damage attribution and charm inference). `isFriendly()`
  and `encounter.engagedNpcs` give us friend/foe.

So this is genuinely easy to add at the detection layer; the design work is in
classification (which casts deserve a warning) and the overlay UI (which must obey the
no-scroll / grow-the-window invariants and the Pencil-mockup-first convention).

## Approaches Considered

### 1. Alert on every hostile cast, no classification
- **Description:** Any begins-casting line from a non-friendly caster renders as an
  alert line. No spell knowledge needed.
- **Pros:** Zero guessing, zero table maintenance, complete information — pure
  "show all data".
- **Cons:** Noisy. The sample log shows wizard mobs chain-casting Lightning Bolt every
  4 seconds; a wall of equal-weight alerts buries the one charm that matters. No
  "INTERRUPT NOW" emphasis — which is the entire point of DBM.

### 2. Curated spell→category table, tiered alerts, unlisted casts still shown
- **Description:** A pure module (`spellwatch.js`) maps known spell names to categories
  (charm, mez, fear, root/snare, stun, heal, gate, nuke/AE) with a severity tier per
  category. High tiers (charm, mez, heal, gate) get the big banner treatment; low tiers
  and *unlisted* spells still render as a small cast line, so nothing is hidden.
  Classic EQ spell lists seed the table; spells actually seen in the live log (Instill,
  Tishan's Clash, Bonds of Force, Ensnaring Roots, Screaming Terror, Greater/Superior
  Healing, Wrath, Lightning Bolt…) are confirmed entries.
- **Pros:** DBM-like labels ("CHARM — interrupt!") exactly as requested. Honest: the
  table only *ranks* casts, it never hides one — an unknown spell shows as itself, not
  guessed into a category. Table lives in the pure parser layer, unit-testable, and
  `collect-unknown.js`-style empiricism can grow it over time.
- **Cons:** The table starts incomplete for Legends-specific spells; someone has to add
  entries. Mitigated by showing unlisted casts anyway.

### 3. Effect-learned classification
- **Description:** Watch what a spell *does* when it lands (`has been mesmerized`
  following the cast → that spell is a mez), persist the learned mapping, use it to
  classify the next cast.
- **Pros:** Self-maintaining, no shipped table, fully empirical.
- **Cons:** The first cast — the one that charmed the cleric — carries no warning,
  which is exactly backwards for an alert system. Considerable machinery (cast→effect
  pairing, persistence) for a payoff the curated table already covers. Could be bolted
  on later; wrong foundation.

### 4. Dedicated real-time alert channel with sounds, separate alert window
- **Description:** New IPC channel pushing alerts the instant the line is parsed,
  rendered in its own always-on-top strip window with audio.
- **Pros:** Sub-line latency; alert placement independent of the meter.
- **Cons:** A second click-through window doubles the geometry/fit/clamp surface that
  has bitten this project twice (the "window climbs the screen" class). The 4 Hz
  snapshot cadence is a worst-case 250 ms — irrelevant against 2–3 s cast times.
  Unjustified complexity.

## Chosen Approach

**Approach 2**, transported over the existing snapshot flow (no new window, no new
push channel):

- New rule `cast-interrupted` (`/^(.+?)'s (.+?) spell is interrupted\.$/`) → typed
  `interrupt` event. (Fizzles are self-only in the log and don't matter here.)
- New pure module `src/parser/spellwatch.js`: `classify(spellName)` →
  `{category, tier}` or null, seeded from classic EQ lists + spells confirmed in the
  live log.
- `LogParser` keeps `hostileCasts`: casts whose resolved caster is not friendly and is
  either NPC-article-shaped (`A `/`An `/`The `/lowercase `a `…) or already engaged in
  the current encounter — this keeps random out-of-group players (`Steven begins
  casting Gate.`) out of the alerts. Entries clear on interrupt, caster death, zone,
  or TTL (~6 s — generous past any cast time; we don't know real cast times and
  won't guess a progress bar). Included in `snapshot()`, revision-bumped so pushes
  fire immediately.
- Overlay renders an alert region: banner rows for high tiers (severity-colored, big
  type), compact lines for the rest. Edge-triggered so a new cast can later drive an
  optional sound. The window *grows* to fit alerts via the existing FIT_WINDOW
  measurement flow — never scrolls, never overlaps the meter rows under the cursor.
- Settings: master toggle for cast alerts, sound toggle (Web Audio beep, no asset
  files, no native anything). Defaults: alerts on, sound off.

Latency budget: tailer poll + 4 Hz push ≈ ≤250 ms after the line hits the log, against
2–3 s cast times — leaves 1.5 s+ of human reaction window, same order as DBM.

## Tasks

- [x] Add `cast-interrupted` rule to `rules.js` emitting `{kind:'interrupt', attacker, ability}`; wire into `rules.test.js` with real log wordings
- [x] Create `src/parser/spellwatch.js` with the category table (charm, mez, fear, root/snare, stun, heal, gate, nuke) and `classify()`; unit test it
- [x] Add `hostileCasts` tracking to `LogParser`: populate on hostile `cast`, clear on `interrupt`/death/zone/TTL, expose in `snapshot()`, bump `revision`
- [x] Parser tests: hostile cast appears in snapshot; friendly/pet casts excluded; out-of-group player casts excluded; interrupt clears; TTL clears; engaged named boss included
- [x] Mockup of the alert UI — **user approval before renderer work** (Pencil app was
      not running; approved via HTML mock artifact instead, v2 after user redirect)
- [x] Alerts window (main): frameless always-on-top click-through window, default
      top-center, bounds persisted, lock/drag via the existing Ctrl+Shift+L flow,
      SNAPSHOT pushed to it alongside the overlay
- [x] Alerts renderer: `src/renderer/alerts/` chip stack (tier 3 banner / tier 2 warn /
      tier 1-0 info), keyed row reuse, invisible when empty, drag placeholder when
      unlocked; verify headlessly with a replayed snapshot
- [x] Settings + config: `castAlerts` / `castAlertSound` toggles + `alertsBounds`,
      settings form controls, window created/torn down on config change
- [x] Sound: Web Audio cue on NEW tier-3 warnings only, gated on `castAlertSound`
      (user chose: ship it, off by default)
- [x] Changelog entry, version bump, `scripts/dev.sh dist`

## Notes

**Execution findings (2026-08-05):**
- **User decision, superseding the chosen approach's "no new window":** warnings on
  the meter slab "wouldn't get seen" — they live in a dedicated floating always-on-top
  window instead, default top-center of the screen, repositionable like the overlay.
  The geometry risk the plan flagged is dodged by making the window a fixed-size
  transparent box with centered content: nothing fits, clamps, or anchors, so none of
  the overlay's resting/fitted machinery is duplicated. Mock v2 approved by the user.
- Sound: ship in this pass, off by default (user choice).
- Replaying the full live log raises 4,807 warnings: 492 tier-3 (interrupt-now — NPC
  Greater Healing/Healing, plus CC), 925 tier-2 (Instill roots, Immobilize, Tishan's
  Clash stuns), 851 tier-1 (Lightning Bolt nukes, Lifespike taps), 2,539 unlisted —
  almost all NPC self-buffs (Inner Fire, Spirit of Wolf, Shield of Thistles), which
  render as calm compact lines. Noise level looks right without any filtering.
- Same caster+spell repeat REFRESHES the existing warning rather than stacking:
  same-named mobs are indistinguishable in the log, and a duplicate row of the same
  warning changes nothing about the response.
- An interrupt clears every warning from that caster name (the log cannot say which
  of three same-named mobs was stopped; stale warnings are worse than missing ones).
- Known gap, documented in `isHostileCaster`: a single-token named mob casting before
  anyone engages or targets it reads as a player and raises no warning; engagement
  closes the gap at the first swing. The price of never alerting on passing players.
- Spells with a mid-name backtick ("Teir`Dal ranger") do not false-trigger the pet
  split — the pet regex needs a literal `` `s ``.
- The renderer was verified headlessly against the worst real moment in the log: an
  Aug 4 raid AE pull with 15 simultaneous warnings (three NPC heals casting at once).
  That moment forced two changes: the invisible window is 720px tall (the worst stack
  is ~600px; a clipped warning is a silently hidden one), and Harm Touch — which this
  server gives a cast time — was promoted to tier 2.
- The alert window ignores the overlay's opacity setting on purpose: the meter may be
  faded to 20%, but a warning that inherits that fade defeats itself.

- Spells confirmed cast by NPCs in the live log, for the initial table: Instill,
  Ensnaring Roots (root); Tishan's Clash (stun); Bonds of Force (snare); Screaming
  Terror (mez); Greater Healing, Superior Healing, Healing, Lifespike (heal);
  Lightning Bolt, Wrath, Searing Arrow, Burst of Fire (nuke); Gate. Buff-line noise to
  leave unlisted-but-visible: Inner Fire, Skin like Rock, Lesser Shielding, Center.
- The anonymous fallback (`begins to cast a spell.`, ability null) should still raise
  a generic "casting…" alert when the caster is hostile — unknown ≠ hidden.
- `.claude/plans/2026-08-05-auto-update.md` is also active; when executing, point
  `/execute-plan` at *this* file explicitly.
- Open question for the user: should charm/mez landing **on you or a group member**
  (e.g. `You have been entranced.`) get its own louder alert? Out of scope here unless
  wanted.
