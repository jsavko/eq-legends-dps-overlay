# Damage taken per encounter, and a persistent encounter history

**Date:** 2026-08-04

## What this answers

Two questions the overlay could not answer before: **"what is killing me?"** and
**"how did last night's raid attempts actually go?"**

The parser had always *read* incoming damage — every form of it — and then dropped the
amount on the floor at the target-friendly branch of `handleDamage` ("damage-taken is
out of scope"). And only two encounters ever existed (`current` and `last`), so a raid
boss attempt was overwritten by the next trash pull and gone at quit.

## Damage taken — the third overlay metric

Ctrl+Shift+M now cycles **damage → healing → taken**; the taken view paints in a
dried-blood red so it can never be mistaken for the other two. Aggregation mirrors the
outgoing side in `encounter.js` exactly:

- Per-victim totals, DTPS over the same shared encounter duration as DPS (so shares
  stay additive), rolling DTPS, hits taken, max hit.
- **byAttacker** (who is hitting them) and **takenByAbility** (with what) — every
  entry rendered, never a top-N, per the standing invariant.
- Your pet's beating folds into your row and stays split out, exactly like pet damage.
  An *enemy* pet stays a distinct attacker ("Hoptor Thaggelum`s pet"), never folded
  into its owner.
- **Deaths**, with their killer, recorded on the row and in an encounter-wide list —
  and a pet death is `petDeaths`, never the owner's own. New `death-self` rule for
  "You have been slain by X!" (9 hits in the live log).
- **Avoided swings** (dodge/parry/riposte/block) counted per kind — the incoming miss
  lines already parsed and were dropped.
- Incoming damage now keeps the encounter clock alive through `addDamageTaken` (it
  already did informally; the honest path replaced the manual timestamp poke).

### Damage types and resists (added mid-plan, user request)

Spell lines state their element ("…for 100 points of **fire** damage by Inferno"), so
the taken view now buckets damage per stated type and tags each incoming ability with
the resist that mitigates it — FR/CR/MR/PR/DR, "armor" for melee. Damage-shield verbs
are the log stating the element too (burned→fire, frozen→cold, singed→fire,
shocked→magic), so they map; "pierced"/"struck" name nothing and stay untyped, as do
DoT ticks — **untyped is shown as untyped, never guessed**, per the honest-numbers
invariant.

Verified against the live log: on the 2026-08-03 Lord Nagafen attempt, Rhale's 25,154
taken splits into Lava Breath 13,011 (fire → FR), melee 9,819 (armor), Earthquake
2,324 (magic → MR). That is the actionable answer the feature exists for.

### Empirical find along the way

`collect-unknown.js` against the live log surfaced **"An evil eye smashes YOU for 30
points of damage."** — `smash` was missing from the attack-verb whitelist, so evil-eye
melee (both directions) had never parsed. Added, confirmed.

## Encounter history

Every encounter that closes (timeout, kill, zone) is now persisted; Ctrl+Shift+R
resets remain deliberately unrecorded. Storage is **JSONL, one file per character**
(`<userData>/history/Rhale_oggok.jsonl`) behind `src/main/history.js` —
`append/list/get/clear/characters`. SQLite was considered and rejected: a native
module is precisely the wrong dependency for the two-worlds Windows-npm build, and the
volume never justifies it (the full 439-encounter live log came to 1.9 MB). The store
interface is the seam if that ever changes. Records carry `v: 1` for forward
compatibility; a torn final line from a crash loses one record, not the file.

The parser stays pure Node: it gained only an `onEncounterEnd(encounter)` callback,
fired from both close paths. Main serializes an **unfiltered** snapshot (no group-only
narrowing — view-time filters belong to the view) plus metadata, and skips encounters
with zero damage in both directions. History write failures toast rather than
propagate — a full disk must not take the live overlay down.

### The History tab

In the **settings window**, because the overlay can never scroll and a fight list is
nothing but scrolling. Settings/History tabs at the top; the History tab shows every
recorded encounter for a selectable character (newest first, filter by boss/zone
text): when, length, group DPS, your DPS, deaths. Clicking one expands the full
record: totals, the deaths line with killers, and per-member tables switchable between
Damage / Healing / Damage taken, each member expandable to the complete breakdown —
abilities with crits and max, heal targets and overheal, attackers, incoming abilities
with resist tags, damage-type totals. Clear-history per character, behind a confirm.

## Verification

- `npm test`: **195 passing** (was 169) — new suites/coverage in `rules`, `encounter`,
  `parser` (taken, deaths, avoids, types, hook) and the new `tests/history.test.js`
  (store round-trip, torn line, newest-first, clear; hook on all three close paths and
  its absence on reset).
- Replayed the full 4.5 MB live log through the real store: 439 encounters persisted,
  both Lord Nagafen attempts listed with correct deaths/DTPS.
- Headless-Chrome drive of both renderers (per the CLAUDE.md recipe): the taken
  breakdown opens with every attacker chip and ability row present,
  `scrollHeight === clientHeight` everywhere at the fit-requested size; the History
  tab loads 439 rows, filters, expands the Nagafen record, switches metrics, and
  drills into the member breakdown. Screenshots eyeballed.

## Files

- `src/parser/encounter.js` — taken-side combatant fields; `addDamageTaken`,
  `addAvoidTaken`, `recordDeath`; `takenByType`; snapshot rows + `totalDamageTaken`,
  `groupDtps`, `deaths`; widened row-skip guard (a pure victim renders).
- `src/parser/rules.js` — `death-self` rule; `smash` verb; damage-shield verb → element.
- `src/parser/index.js` — target-friendly branch scores taken; incoming avoids;
  friendly deaths (pet-aware); `onEncounterEnd` hook (both close paths, not reset).
- `src/parser/entities.js` — unchanged; pet folding reused as-is.
- `src/main/history.js` — **new**, the JSONL `EncounterStore`.
- `src/main/main.js` — store wiring, `persistEncounter`, 3-way metric cycle, tray
  label, history IPC handlers.
- `src/main/ipc.js`, `src/renderer/setup/preload.cjs` — `HISTORY_LIST/GET/CLEAR`.
- `src/main/config.js` — metric comment ('damage' | 'healing' | 'taken').
- `src/renderer/overlay/overlay.js` — `METRICS.taken`, 3-way cycle button label,
  `renderTakenDetail`, type chips with resist tags.
- `src/renderer/overlay/overlay.css` — `--wound` palette, taken-mode variable swap,
  `#d-types` chips.
- `src/renderer/overlay/index.html` — `#d-types`, button title.
- `src/renderer/setup/{index.html,setup.css,setup.js}` — tab bar, History section,
  the browser (list, filter, expand, metric tables, member drill-down, clear).
- `tests/{rules,encounter,parser}.test.js` — extended; `tests/history.test.js` — **new**.

## Known limits

- DoT ticks carry no damage type in the log, so they bucket as "untyped" — correct but
  unsatisfying; a spell-name→school table would be guessing and was deliberately not
  built.
- The overlay metric button cycles three states; if that proves clumsy in play, a
  per-metric hotkey is the follow-up.
- History records begin at deploy — there is no backfill command yet, though
  `scripts/replay.js` plus the store would make one straightforward if wanted.
