---
status: created
---
# Boss timers must not slot a mob's self-buffs

**Date:** 2026-08-07

---

## Goal

The boss-timer panel is filling with mobs re-buffing themselves, and on a Plane of Fear
pull that is *all* it shows. Reproduced against the live log (11:18–11:34, 7 Aug):

```
=== 15:21:38  2 slots
   1. Master of Spite   Firefist          armed  5s int=10.0 tier=0
   2. Master of Spite   Spiritual Brawn   armed  8s int=10.0 tier=0
...fifteen minutes of exactly those two rows, until:
=== 15:33:13  3 slots
   1. Master of Spite   Firefist          armed  5s int=10.0 tier=0
   2. Master of Spite   Spiritual Brawn   armed  9s int=10.0 tier=0
   3. Maestro of Rancor Superior Healing  armed  4s int=4.0  tier=3  cat=heal
```

The one timer worth having — the Maestro's Superior Healing, the cast that undoes the
kill — arms *last* and sits *below* two self-buffs that do nothing to the group. (The
reported "Maestro of Rancor casting Firefist" is Master of Spite; two Fear bosses with
near-identical names, and the panel names its rows correctly. The complaint is right
about everything that matters: the panel is showing spells that mob isn't a threat with.)

Both spells are confirmed self-buffs, not guesses:
- `Master of Spite's fist bursts into flame.` follows every Firefist cast.
- Rhale scribes and memorizes both — they are the shaman STR / fire-damage-add line.
- Neither ever appears in a damage, resist or debuff line from any NPC in 149 hours.

**Root cause:** `noteHostileCast` feeds the rhythm tracker every named hostile cast and
never consults `classify()`. Nothing in the timer path distinguishes "casts that will
hurt you" from "casts the mob does to itself" — and because a rebuff cycle is the most
metronomic thing a mob does, self-buffs are the spells *most* likely to qualify, claim
the first slots, and hold them for the whole fight (slots never re-sort, by design).

It is not a one-mob problem. The user's persisted memory already holds six pairs the
existing buff table would have rejected outright had anything asked it —
`Footman of V'Zher | Center`, `| Inner Fire`, `Ice boned skeleton | Alacrity`,
`Ice boned skeleton pet | Skin like Wood`, `Gynok Moltor pet | Courage`,
`Cleric of Innoruuk | Shield of Thistles` — plus Firefist and Spiritual Brawn, which the
table does not yet know. The shipped `baseline-rhythms.json` carries one too
(`Footman of V'Zher | Center`), so a fresh install starts polluted.

Scope: stop self-buffs claiming timer slots, stop them being learned and persisted,
purge the ones already stored, and keep every timer that is genuinely worth having.

## Approaches Considered

### 1. Name the buffs — extend the spellwatch table, gate timers on `tier !== -1`
- **Description:** Add `firefist` and `spiritual brawn` to the tier -1 buff pattern,
  sweep the log for other NPC self-buffs, and refuse a timer slot to anything the table
  classifies as a self-buff.
- **Pros:** Smallest change; reuses a table that already exists and already carries the
  right verdict for six of the eight polluted pairs. Fixes the alert chips at the same
  time (Firefist currently draws as an "unrecognized cast").
- **Cons:** A names list. The next unlisted self-buff on the next boss repeats the bug
  exactly, and nobody finds out until the panel is useless again mid-raid.

### 2. Make a spell prove it touched us — timers only for pairs with harm evidence
- **Description:** Drop the table from the decision entirely. A (caster, ability) pair
  arms a slot only once that exact pair has been observed damaging, being resisted by,
  or CC'ing a friendly. A self-buff never touches us, so it never earns a slot.
- **Pros:** Empirical and self-maintaining — reads the log rather than a list of names,
  the same reasoning that makes `isProc` trustworthy. Covers unknown future buffs.
- **Cons:** Kills timers for real casts the log never shows landing. Verified casualties:
  `Quag Maelstrom | Mana Drain` (19s ±1.5 — the exemplar in `rhythm.js`'s own header;
  it prints only *"Your mind clouds as your concentration bleeds away."*, unattributed)
  and every NPC heal, including the Maestro's Superior Healing, which heals the *mob* and
  by definition never touches a friendly. Alone, this approach deletes the single most
  valuable timer in the app.

### 3. Hybrid — the table decides what it knows, evidence decides the rest
- **Description:** Three-way gate on arming a slot:
  - `tier === -1` (positively identified self-buff) → **never** a timer, whatever else
    happens. Table extended with Firefist, Spiritual Brawn and anything else the log
    sweep turns up.
  - `tier >= 1` (identified threat: heal, gate, CC, nuke, lifetap, dispel) → **always**
    eligible. This is what saves the boss heal, which can never prove harm.
  - `tier === 0` (unclassified) → eligible **only** once that pair has been observed
    affecting a friendly. This is what saves the breath weapons — Lava Breath, Frost
    Breath, Soul Devour, Entomb in Ice, Efreeti Fire all land damage on us and all pass —
    while an unknown self-buff never does.
  Plus one table addition so nothing valuable falls through the tier-0 branch:
  classify Mana Drain (its only evidence line is unattributed prose).
- **Pros:** Fixes the reported bug twice over — Firefist is rejected by the table *and*
  by having no harm evidence. Generalizes: an unlisted self-buff on a future boss cannot
  claim a slot without proving harm first. Every currently-valuable stored rhythm
  survives (verified pair-by-pair against the user's own `oggok.json`, below).
- **Cons:** Two mechanisms instead of one, and a tier-0 spell that is genuinely dangerous
  but leaves no parseable line stays out until someone classifies it. That failure mode
  is a missing timer, not a lying one.

### 4. Rank the panel by tier instead of filtering
- **Description:** Keep learning everything; sort or prioritize slots so threats sit above
  buffs, or cap the panel at N and drop the low tiers.
- **Cons:** Rejected. "A boss-timer row never moves" is the invariant that window exists
  to hold — a measured session displaced rows 524 times before it was built. Tier-ordering
  moves a row the moment a higher-tier slot arms later, which is precisely the Fear case
  (Superior Healing arms twelve minutes in). It also leaves the store being poisoned and
  the buff rhythms still consuming screen space at the bottom.

### 5. A user-editable ignore list in settings
- **Description:** Let the player type spell names the timers should skip.
- **Cons:** Rejected as the primary fix — it makes the player do the parser's job, mid-raid,
  per boss. Reasonable as a much later escape hatch; not what is wrong here.

## Chosen Approach

**Approach 3 — the hybrid gate**, because it is the only option that removes the noise
without removing the signal, and because each half covers the other's blind spot: the
table knows things evidence can't observe (a heal that never touches us), and evidence
knows things the table hasn't been told (next patch's unnamed buff).

Checked against every pair in the user's live `oggok.json` (48) and the shipped
baselines (19), the gate:
- **drops** all 8 self-buff pairs, including the two reported;
- **keeps** all 6 heals, all 6 CC/root, all 9 lifetap/nuke (tier ≥ 1);
- **keeps** the tier-0 spells that land on us — Soul Devour, Entomb in Ice, Efreeti Fire,
  Lava Breath, Frost Breath, Ice Bone Frost Burst, Shadow Vortex, Furor, Water Elemental
  Attack, Disease Cloud, Sicken, Frost Shard, Ice Spear, Plague;
- **keeps** Mana Drain via the one deliberate table addition.

Two structural decisions:

**Gate at arming, not at feeding.** The tracker keeps recording gaps for every named
hostile cast; only *eligibility to claim a slot and to be exported* is gated. So a spell
that lands on the group ten seconds after its first cast shows a timer built from the
gaps it has already banked, rather than starting its count from zero.

**The decision stays in `index.js`.** `rhythm.js`'s header states it knows nothing about
spell categories, and that stays true: the parser calls `markEligible(caster, ability)`,
the tracker carries a boolean and filters `timers()` and `learned()` on it. Eligibility
rules stay next to the classification they depend on; slot lifetime stays unit-testable.

## Tasks

- [ ] Sweep the live log for every NPC self-buff cast that leaves no harm line, so the
      table extension is empirical rather than two names — write the findings into the
      plan Notes before editing `spellwatch.js`
- [ ] Add `firefist` and `spiritual brawn` (plus whatever the sweep confirms) to the
      tier -1 `buff` entry in `src/parser/spellwatch.js`, with a comment recording the
      evidence (`Master of Spite's fist bursts into flame.`, player-scribed shaman line)
- [ ] Add a `manadrain` entry to `spellwatch.js` (tier 1, group `routine`) so Mana Drain
      is classified rather than depending on harm evidence it can never produce
- [ ] Add `eligible` to a rhythm entry in `src/parser/rhythm.js` (default false) and a
      `markEligible(caster, ability)` method; skip ineligible entries in both `timers()`
      and `learned()` so nothing ineligible reaches the screen or the store
- [ ] In `src/parser/index.js`, call `markEligible` from `noteHostileCast` when
      `classify(ability).tier >= 1`
- [ ] In `src/parser/index.js`, call `markEligible` from the three places a hostile spell
      is observed affecting a friendly — the `targetFriendly` branch of `handleDamage`
      (~line 566), `handleResist` (~line 1141), and the CC-state path (~line 1364) —
      guarded so a `tier === -1` pair can never be marked eligible by any of them
- [ ] Purge the polluted store: filter `RhythmStore.knownFor()` / `load()` through the
      same tier -1 rejection, and drop rejected pairs from the file on the next merge so
      the cleanup is permanent rather than re-applied every launch
- [ ] Regenerate or hand-filter `src/main/baseline-rhythms.json` to drop
      `Footman of V'Zher | Center`, and make `scripts/seed-rhythms.js` apply the gate so
      future seeds cannot reintroduce buff rhythms
- [ ] Tests: `tests/rhythm.test.js` — an ineligible pair never appears in `timers()` and
      never exports from `learned()`; a tier-0 pair arms only after harm evidence, and
      arms with its already-banked gaps rather than from zero
- [ ] Tests: `tests/spellwatch.test.js` — Firefist and Spiritual Brawn classify as tier -1
      `buff`; Mana Drain classifies at tier ≥ 1; the existing heal/CC/breath expectations
      still hold
- [ ] Tests: the rhythm store drops tier -1 pairs on load and does not write them back
- [ ] Verify against the live log: replay 11:18–11:34 of 7 Aug and confirm the panel shows
      Maestro of Rancor's Superior Healing and **no** buff rows; diff the whole-log learned
      set before and after the gate and record the drop list in the changelog
- [ ] Write `docs/changelog/2026-08-07-timers-ignore-self-buffs.md` covering the measured
      before/after, why the harm-evidence branch exists alongside the table, and why the
      panel is not tier-sorted
- [ ] Bump `package.json`, run `npm test`, then `taskkill` the overlay and `scripts/dev.sh dist`

## Notes

- Reproduction script lives at
  `/tmp/claude-1000/-home-james-Projects-eqlparser/.../scratchpad/timers-dump.mjs` —
  it replays a log window with the user's real `oggok.json` loaded as known rhythms and
  prints `castTimers` exactly as the renderer receives them. Worth promoting to
  `scripts/` if this class of bug recurs; a `--timers` flag on `replay.js` would be the
  natural home.
- The renderer needs no change. `timers.js` paints what the parser sends, and the header
  ("N casters" / the single caster's name) is already correct.
- Open question, deliberately out of scope: with buffs gone the Fear panel shows one row.
  If a later pull produces more eligible rows than fit, the answer is more panel height,
  not a cap — the never-truncate rule applies here as everywhere.
- Names worth remembering, since they will come up again: **Master of Spite** and
  **Maestro of Rancor** are two different Plane of Fear bosses that are easy to conflate
  in a bug report. The parser told the truth about which was which.
