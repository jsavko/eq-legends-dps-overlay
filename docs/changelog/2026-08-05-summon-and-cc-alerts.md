# Summon alerts and CC-landed alerts

**Date:** 2026-08-05

## What shipped

The warning window now covers the two gaps the log audit found: bosses summoning
players, and crowd control landing ON the group.

1. **SUMMONED banner.** `Master Yael says, 'You will not evade me, Emalina!'` was
   being swallowed by the chat rule — the single most DBM-shaped mechanic on this
   server was invisible (43 yanks in the live log, every one from a real boss).
   It is now an instant tier-3 banner with the VICTIM in the big slot and the boss
   beneath — the name is the payload — plus the existing tier-3 sound cue. The
   confirmation line `You have been summoned!` merges into the say-line's chip by
   victim key, and covers a boss that words its say differently (the caster line
   then collapses rather than showing a guess).
2. **Member CC state chips.** `You are stunned!` fired 691 times and matched no
   rule; `Emalina has been mesmerized.` parsed into an `effect` event nothing
   consumed. Now STUNNED / MEZZED / CHARMED chips (red left edge, between warnings
   and timers) track CC sitting on the group, cleared by the log's own end-lines —
   `You are no longer stunned.`, `has been awakened by <who>.` — the victim's
   death, zoning, manual reset, and a 30s safety cap. Deliberately NO countdown or
   drain bar: the cap is a safety net, not a duration, and the log states none.

## Rules (`src/parser/rules.js`)

- `summon-say` — placed BEFORE the chat rule (the pet-reports-to-master precedent).
  Emits raw names; hostility is the parser's call, so a player typing the sentence
  in /say parses as a summon and then fails the guard, never alerting.
- `summon-self` — `You have been summoned!`, attacker null.
- `crowd-control` — gains `entranced|captivated` (the mez family as this server
  words it on people) and the `ha(?:s|ve)` form so `You have been entranced.` lands.
- `cc-awakened-by` — **plan correction:** the bare classic `has been awakened.`
  never occurs in the live log; every awakening is `has been awakened by <who>.`
  (298 occurrences), which the generic rule cannot reach.
- `cc-self-stun` / `cc-self-end` — `You are stunned!` and
  `You are no longer (stunned|captivated|entranced).`; the end alternation is
  deliberately only the tracked effects, so `no longer hidden/ensnared/poisoned`
  stays unmatched noise.

## Parser (`src/parser/index.js`)

- `handleSummon` — `isHostileCaster` troll guard on the say form; entries join
  `hostileCasts` with `category: 'summon'`, `tier: 3`, a `victim`, and a per-entry
  5s TTL (`SUMMON_TTL_MS`) — an announcement, not a countdown. Keyed by victim so
  say + confirmation fold into one chip; a late say-line fills in the caster.
  Victims resolve to their DISPLAY name, so a summoned pet reads as the pet.
  Interrupts leave summon chips standing (a fact cannot be interrupted); the prune
  and snapshot paths honor per-entry TTLs.
- `ccStates` — keyed who|effect (`CC_EFFECTS` folds mesmerized/entranced/captivated
  to `mez`), friendly-only (535 of the log's mez lines are the group's enchanter
  doing their job — those must never alert), refresh-not-stack, 30s cap
  (`CC_STATE_CAP_MS`), surfaced as `memberEffects` in both snapshot branches.
- `handleCharm` direction branch — when the charmed WHO resolves friendly (and is
  not a charmed mob folding into its owner), it is an enemy taking a member:
  CHARMED state chip instead of roster-charming a player.
- **Latent bug fixed:** re-charming an already-charmed mob resolved to its OWNER,
  so `roster.charm()` registered the owner as their own pet and silently dropped
  the real charm. The roster is now keyed on the RAW name; regression test pins it.

## Renderer (`src/renderer/alerts/`)

- `index.html` — `#effects` list between `#stack` and `#timers`: the call to act
  outranks the status report; the stated fact outranks the estimate.
- `alerts.js` — summon branch in `buildChip` (verb SUMMONED, victim in the spell
  slot, boss below); late-caster fill on live summon chips; `renderEffects` with
  chips reused by who|effect, parser order preserved, cap-expiry fade. The sound
  cue needed no change — a summon is a new tier-3 id and rides the existing edge
  trigger.
- `alerts.css` — `.echip` state-chip style per the approved mockup (flat slab, red
  left edge, no countdown); `.chip .caster:empty` collapse for caster-less summons.

## Verified

- 283 tests passing (was 259): 6 new rules tests, 18 new parser tests covering the
  troll guard, say+self dedupe, pet victims, the shorter TTL, interrupt immunity,
  every ccStates clear path, the charm direction branch, and the re-charm
  regression.
- Full live-log replay: 43 summon warnings, all from real bosses; 698 CC states,
  all on group members; no mob leakage, no troll alerts.
- Headless verify of the real renderer in Windows Chrome against real replayed
  snapshots — a rock golem summoning Rhale WHILE stunned renders banner + state
  chip exactly per the approved mock; tier sorting, caster collapse, late-caster
  fill, instant end-line clear, and cap fade all confirmed in the DOM.

## Deliberately not done (per the audit)

- No enrage/rampage/gate/flee alerts — those wordings do not exist in this
  server's log. Re-check with `collect-unknown.js` after major patches.
- No wounded-emote health hints; no rooted/poisoned member chips (grind noise).
- No invented durations anywhere: state chips show no countdown.
