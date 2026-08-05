---
status: completed
---
# Summon Alerts and CC-Landed Alerts

**Date:** 2026-08-05

---

## Goal

Close the two gaps the log audit found in the warning system:

1. **Summons.** Bosses summon players and the log names every victim —
   `Master Yael says, 'You will not evade me, Emalina!'` (33 occurrences across the
   log; Emalina alone yanked 25 times, raid members Khanvikt and Syphon included).
   The chat rule deliberately swallows say-lines today, so the system is blind to
   the single most DBM-shaped mechanic on this server. Target: an instant tier-3
   chip — **SUMMONED · Emalina · Master Yael** — with the existing sound cue.
2. **CC landing on the group.** `You are stunned!` fired 644 times and matches no
   rule; `You have been entranced.` and `You are no longer captivated.` likewise;
   `Emalina has been mesmerized.` parses into an `effect` event that nothing
   consumes. Warnings fire when the enemy *starts casting* mez — nothing shouts
   when it *lands* on the cleric. Target: a state chip — **MEZZED · Emalina** —
   that clears on the explicit end-line, not on a guess.

Both are fact-lines: no estimation anywhere, so neither needs the timer machinery's
qualification gates. Explicit non-goals, per the audit: enrage/rampage/gate/flee
alerts (those wordings do not exist in this server's log), wounded-emote health
hints (`begins to bleed profusely!` fires for trash and players alike — noise), and
unattributed-AE handling (69 non-melee lines vs 68 falling lines — it really is all
fall damage).

## Approaches Considered

### 1. Piggyback everything on `hostileCasts`
- **Description:** Summons AND CC states become entries in the existing warnings
  array with new categories; the renderer styles by category.
- **Pros:** One pipeline; sound, sorting, snapshot plumbing and chip reuse all come
  free.
- **Cons:** CC states have the wrong lifecycle for that list — they are keyed by
  VICTIM, live tens of seconds, and clear on explicit end-lines; hostileCasts is
  keyed by caster, lives 6s, and clears on interrupt/death. Forcing both shapes into
  one list means lifecycle flags on every entry — complexity disguised as reuse.

### 2. Summons join `hostileCasts`; CC states get their own small list
- **Description:** A summon is shaped exactly like a warning (instant fact, tier 3,
  caster-attributed, short TTL, cue-worthy) — it joins `hostileCasts` with
  `category: 'summon'` and a `victim` field. CC states get a separate `ccStates`
  list in the parser (victim-keyed, explicit-end-line clearing, capped lifetime),
  surfaced as `memberEffects` in the snapshot.
- **Pros:** Each shape keeps its natural lifecycle; summons inherit the tier-3
  sound edge-trigger and chip machinery untouched; the new list is small and
  independently testable.
- **Cons:** One more snapshot array (third), one more renderer section.

### 3. Generalize into a typed alert bus
- **Description:** Refactor warnings, summons, timers and CC into one generic alert
  stream with declarative expiry/clear conditions.
- **Pros:** Uniform; future alert types drop in.
- **Cons:** Refactors code that shipped this morning and is covered by 259 tests,
  to serve exactly two new alert types whose shapes are already well understood.
  Speculative generality; wrong day for it.

## Chosen Approach

**Approach 2.**

- **Rules** (all wordings verbatim from the live log):
  - `summon-say`: `/^(.+?) says, 'You will not evade me, (.+?)!'$/` →
    `{kind: 'summon', attacker, victim}`. MUST precede the chat rule — same
    placement precedent as `pet-reports-to-master`.
  - `summon-self`: `/^You have been summoned!$/` → `{kind: 'summon', attacker: null,
    victim: 'You'}` — the confirmation line, and the fallback if a mob words its
    say differently.
  - CC starts: `You are stunned!`; `You have been (entranced|captivated|mesmerized)\.`
    — plus the existing `crowd-control` rule already covering
    `<member> has been mesmerized.`
  - CC ends: `You are no longer (stunned|captivated|entranced)\.`;
    `<member> has been awakened.` (already parsed, unconsumed).
- **Parser — summons:** `handleSummon` resolves the sayer; a summon alerts only when
  the sayer passes `isHostileCaster` — a player typing that sentence in /say must
  not trigger a raid alert (the say-rule now outranks chat, so the troll-guard is
  load-bearing). Entry pushed into `hostileCasts` with `category: 'summon'`,
  `tier: 3`, `victim`, and a shorter TTL (~5s — a summon is over the moment it
  happens; the chip is an announcement, not a countdown). The self-confirmation
  line within a couple of seconds of a say-line naming You refreshes rather than
  duplicates.
- **Parser — CC states:** `ccStates` list keyed `who|effect`, effects limited to
  what matters mid-fight: **mez** (mesmerized/entranced/captivated), **stun**,
  **charm-on-a-friendly**. Charm needs a direction branch: `handleCharm` currently
  assumes the charmed entity is a mob joining us; when the WHO resolves friendly,
  it is an enemy charming a group member — alert instead of roster-charming.
  Clears: the explicit end-lines, `has been awakened`, the victim's death, zone,
  manual reset — plus a 30s cap so a missing break-line (charm has none) cannot
  leave a stale chip. No invented durations: the cap is a safety net, not a claim.
  Surfaced as `memberEffects` with `remainingMs` against the cap.
- **Renderer:** summon chips render in the main stack via the existing tier-3
  banner with verb **SUMMONED**, the victim's name in the spell slot, the boss
  below; the sound cue fires through the existing new-tier-3-id edge trigger.
  `memberEffects` render as a distinct chip style (effect verb + victim) between
  warnings and timers. Mockup update to the existing artifact for approval first —
  the standing convention.
- **Config:** none new. These are warnings; they ride the `castAlerts` master
  toggle.

## Tasks

- [x] Rules: `summon-say` (before chat) + `summon-self` + CC start/end rules;
      rules tests from verbatim log lines, including the troll-shaped say-line
      parsing as `summon` kind (the hostility guard lives in the parser)
- [x] Parser: `handleSummon` with hostility guard, say+self dedupe, short-TTL
      tier-3 `hostileCasts` entry with `victim`; tests including the troll guard
      (a friendly player saying the sentence must not alert)
- [x] Parser: `ccStates` lifecycle (mez/stun/charm-on-friendly starts, explicit-end
      clears, awakened, death, zone, reset, 30s cap), `handleCharm` direction
      branch, `memberEffects` in both snapshot branches; tests
- [x] Mockup update (same artifact): SUMMONED banner + CC state chip — **user
      approval before renderer work** *(approved 2026-08-05, same URL:
      https://claude.ai/code/artifact/3323fddb-e4bd-4c5b-95f2-14d53c19a23e)*
- [x] Renderer: summon verb/victim rendering in the tier-3 chip, `memberEffects`
      section, sound via existing edge trigger; headless verify against a replayed
      Master Yael summon moment from the live log
- [x] Changelog, version bump, `scripts/dev.sh dist`

## Notes

- The summon say-line names victims who are NOT in the group (Khanvikt, Syphon —
  raid members). The alert shows them anyway: it is a fact about the raid, and
  group-narrowing is a meter concern, not a warning concern.
- `You are stunned!` at 644 occurrences is grinding noise as much as raid signal —
  the chip must be compact and short-lived (stuns end in seconds; the end-line
  clears it), not a banner.
- Deliberately NOT alerting: rooted/poisoned/lacerated on members (constant grind
  noise, no raid decision hangs on them), and the wounded emotes.
- The audit that produced this plan is in the conversation of 2026-08-05; the
  negative findings (no enrage/rampage/gate wordings on this server) are worth
  re-checking with `collect-unknown.js` after major game patches.
- **Discovered during execution:** the plan's "`<member> has been awakened.`
  (already parsed, unconsumed)" was wrong — this server ALWAYS words it
  "has been awakened **by <who>**." (298 occurrences, zero bare), which the
  crowd-control rule can't reach. A new `cc-awakened-by` rule covers it.
- **Latent bug found and fixed:** re-charming an already-charmed mob resolved the
  mob to its OWNER (the damage-credit fold), so `roster.charm()` registered the
  owner as their own pet and silently dropped the real charm. `handleCharm` now
  keys the roster on the RAW name. Regression test added.
- Live-log replay of the finished parser: 43 summon warnings, all from real bosses
  (Yael, Skarlon, Rokyl, Nagafen, Vox, Tranix, Slizik, rock golems); 698 CC states,
  all on group members (691 stun:Rhale, 7 mez) — no mob leakage, no troll alerts.
