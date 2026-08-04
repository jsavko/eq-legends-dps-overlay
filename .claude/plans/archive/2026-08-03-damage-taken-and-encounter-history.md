---
status: completed
---
# Damage Taken per Encounter + Persistent Encounter History

**Date:** 2026-08-03

---

## Goal

Two features, one plan because the second gives the first somewhere to live after the
fight ends:

1. **Damage taken ("what is killing me").** The rules already parse every incoming
   form — melee ("a froglok shin knight hits YOU for 30 points of damage."), DoTs
   ("You have taken 29 damage from Searing Arrow by a ghoul savant."), incoming damage
   shields, incoming spell hits — but `handleDamage` in `src/parser/index.js:274`
   deliberately drops the amount when the target is friendly ("damage-taken is out of
   scope"). Bring it in scope: aggregate per-combatant damage *taken*, broken down by
   attacker and by ability, plus player deaths, and add a third overlay metric
   (damage → healing → taken) with a hover breakdown answering "who is hitting me,
   with what, and how hard".

2. **Encounter history.** Today only `current` and `last` encounters exist; a raid
   boss attempt is overwritten by the next trash pull and gone at quit. Persist every
   closed encounter to disk and add a browsable History view — list of past fights,
   click one to see the full per-member breakdown (damage, healing, and the new
   damage-taken data) — so a raid night can be reviewed afterwards.

## Approaches Considered

(These are the storage options — the user suggested "sqlite or something". The
damage-taken aggregation itself has no real alternative: it mirrors the existing
outgoing-damage structures in `encounter.js`, which is what makes it cheap and
consistent.)

### 1. JSONL files, one per character, behind a small store module
- **Description:** `src/main/history.js` appends one JSON line per closed encounter to
  `<userData>/history/<Character>_<server>.jsonl`. The record is the encounter's
  existing `snapshot()` (already a pure-JSON view built for exactly this) plus
  metadata (character, server, zone, label, timestamps, close reason, schema version).
  Listing/filtering is plain JS over the loaded index.
- **Pros:** Zero dependencies, zero native-module risk, works identically in WSL tests
  and Windows Electron. Append-only writes are crash-safe (a torn last line is
  skippable). The data volume makes queries trivial: a heavy raid night is ~100
  encounters at a few KB each; years of play fit in tens of MB and filter instantly in
  memory. Human-readable and greppable. The store interface (`append/list/get/clear`)
  hides the format, so SQLite can replace it later without touching callers.
- **Cons:** No indexed queries or cross-file aggregation ("my best DPS ever on this
  boss" scans all files — still milliseconds at this scale). Whole-file read on
  startup.

### 2. better-sqlite3
- **Description:** Real SQLite via the standard native module, tables for encounters
  and per-member rows.
- **Pros:** Real queries, incremental reads, the thing the user named.
- **Cons:** It is a **native module**, and this project's two-worlds build is exactly
  where native modules hurt: `node_modules` must be installed by *Windows* npm in
  `C:\eqoverlay-dev`, the module must be rebuilt for Electron 33's ABI
  (electron-rebuild + MSVC toolchain on the Windows side), and electron-builder must
  unpack it from the asar. The WSL-side test suite would need a second, Linux build of
  the same module. All that machinery buys query power the data volume doesn't need.

### 3. `node:sqlite` (built-in) via an Electron upgrade
- **Description:** Node's built-in SQLite — no npm dependency at all.
- **Cons (decisive):** Electron 33 bundles Node 20.18; `node:sqlite` requires Node
  ≥22.5. This path means an Electron major-version upgrade (≥35) purely for storage,
  re-validating the overlay's click-through/always-on-top behavior that the whole app
  depends on. Wrong reason to take that risk.

### 4. sql.js (SQLite compiled to WASM)
- **Description:** SQLite with no native code.
- **Cons:** The database lives in memory and must be serialized back to disk wholesale
  on every write — worse crash behavior than appending a line, plus a ~1 MB wasm
  payload, for SQL we don't need.

## Chosen Approach

**Approach 1 — JSONL behind `src/main/history.js`.** SQLite's benefits only appear at
data volumes and query shapes this app will never reach, and its costs land precisely
on this project's sorest point (Windows-npm native builds). The store module keeps the
decision reversible.

Two placement decisions that follow from existing invariants:

- **Persistence lives in main, not the parser.** `src/parser/` must stay pure Node
  with no fs/Electron. The parser gets an `onEncounterEnd(encounter)` callback option,
  fired from both close paths (`closeCurrent` and `tick`); main serializes and
  appends. `reset()` (Ctrl+Shift+R) discards without firing — a reset is the user
  saying "this one doesn't count". Replay/tests pass no callback and stay side-effect
  free.
- **The history browser lives in the settings window, not the overlay.** The overlay
  cannot scroll — anywhere, ever — and a history list is inherently scrollable. The
  settings window is a normal interactive window; it gets a History tab. The overlay
  itself changes only by gaining the third metric.

Damage-taken design, mirroring the outgoing side in `encounter.js`:

- `newCombatant` gains: `damageTaken`, `petDamageTaken` (your pet's tanking folds into
  your row exactly as its damage does, split out just like `petDamage`), `hitsTaken`,
  `maxHitTaken`, `deaths`, `avoidedTaken` (dodge/parry/riposte/block counts — the
  incoming miss lines already parse), `byAttacker` Map (who is hitting them),
  `takenByAbility` Map (with what), `takenWindow` for rolling DTPS.
- Snapshot rows gain `damageTaken`, `dtps`, `rollingDtps`, `takenShare`, `maxHitTaken`,
  `attackers[]`, `takenAbilities[]`, `deaths` — every attacker and every ability, no
  top-N, same as the outgoing breakdown.
- `handleDamage`'s target-friendly branch calls `addDamageTaken` instead of dropping
  the amount; encounter open/extend behavior is unchanged (it already opens and
  extends on incoming damage).
- Deaths: the existing `death` rule already matches "Rhain has been slain by X!";
  `handleDeath` records it on the friendly's row before its early return. A new
  `death-self` rule covers the second-person "You have been slain by X!".
- The stored snapshot is built **unfiltered** (no groupOnly narrowing) so history
  records everything; view-time filters stay in the UI.

## Tasks

### Parser: damage taken
- [x] `src/parser/encounter.js` — add taken-side fields to `newCombatant`; add
      `addDamageTaken({name, attacker, amount, ts, source, ability, isPet})`,
      `addAvoidTaken({name, avoidance, ts})`, `recordDeath({name, killer, ts})`;
      extend the row-skip guard in `snapshot()` so a pure-victim row (hit but never
      swung) still renders; emit the new row fields with DTPS computed over the same
      shared encounter duration as DPS.
- [x] `src/parser/rules.js` — add `death-self` rule for "You have been slain by X!";
      confirm incoming spell form against the live log with `collect-unknown.js` and
      mark wording `(confirmed)` where verified.
- [x] `src/parser/index.js` — in `handleDamage`'s target-friendly branch, credit
      `addDamageTaken` (victim = resolved target so pets fold to owner; attacker
      display via the resolved entity so "A froglok"/"a froglok" collapse); mirror
      `handleMiss` for incoming avoids; record friendly deaths in `handleDeath`.
- [x] Tests — `tests/rules.test.js`: incoming melee/DoT/DS/self-death fixtures;
      `tests/encounter.test.js`: taken aggregation, DTPS, attacker/ability maps,
      deaths; `tests/parser.test.js`: end-to-end incoming lines land on the right row
      (You, your pet folding to you, another player), and never on an NPC row.

### Overlay: the "taken" metric
- [x] `src/renderer/overlay/overlay.js` — add `METRICS.taken` (`total: 'damageTaken'`,
      `rate: 'dtps'`, `rolling: 'rollingDtps'`, `share: 'takenShare'`, unit `dtps`);
      filter/sort rows by damage taken in that mode; `renderTakenDetail` with attacker
      chips (who), taken-ability list via the existing `setAbilities` (what — every
      entry, never sliced), stats (hits taken, max hit, avoided, deaths, share).
- [x] `src/main/main.js` + config — `toggleMetric` cycles damage → healing → taken;
      tray label reflects the three states; `metric` config value validated.
- [x] Visual check headlessly per the CLAUDE.md recipe (replay the live log, drive
      headless Chrome) — especially that the taken breakdown's growth stays within the
      fit-window rules.

- [x] (added mid-execution, user request) Damage types and resists in the taken
      view: `spell-damage` lines state the element — carry it through
      `addDamageTaken` into a per-victim `takenByType` and onto each taken ability;
      damage-shield verbs (burned/frozen/...) map to their stated element; melee is
      "melee" (armor), unstated types are "untyped", never guessed. Overlay renders a
      type-totals chips row with resist tags (FR/CR/MR/PR/DR) and tags each ability.

### History: store, hook, IPC, UI
- [x] `src/main/history.js` — `EncounterStore(dir)`: `append(record)` (JSONL line),
      `list(character)` (lightweight index: id, label, zone, startTs, durationMs,
      groupDps, self's dps/taken/deaths), `get(id)` (full record), `clear(character)`;
      tolerant of a torn final line; records carry `v: 1`.
- [x] `src/parser/index.js` — `onEncounterEnd` option, fired from `closeCurrent` and
      the `tick` timeout path with the closed `Encounter`; NOT fired by `reset()`.
- [x] `src/main/main.js` — instantiate the store under `userData/history/`; on
      encounter end, append `{v, id, character, server, zone, label, startTs, endTs,
      durationMs, closeReason, snapshot}` using an unfiltered snapshot; skip
      encounters with zero total damage in both directions (a phantom open, not a
      fight).
- [x] `src/main/ipc.js` + `src/renderer/setup/preload.cjs` — `HISTORY_LIST`,
      `HISTORY_GET`, `HISTORY_CLEAR` channels.
- [x] Settings window (`src/renderer/setup/`) — History tab: encounter list (time,
      zone, label, duration, group DPS, your DPS, your deaths) with text filter,
      newest first; clicking a row expands the full per-member breakdown with a
      damage / healing / taken toggle, ability and attacker tables included; a
      Clear-history button with confirm.
- [x] Tests — `tests/history.test.js` against a temp dir (store is pure Node);
      `onEncounterEnd` fires on timeout, zone, and all-slain closes, and not on reset.

### Finish
- [x] `docs/changelog/2026-08-04-damage-taken-and-encounter-history.md`
- [ ] Bump `package.json` version (own commit), `scripts/dev.sh dist`, remind that the
      win-unpacked exe is stale until then.

## Notes

- **Incoming attribution is already honest by construction:** every incoming rule
  names the attacker, so no "Unknown"-style guessing arises on the taken side. The
  unattributed non-melee line targeting a friendly stays ignored — it's fall damage,
  and scoring it would invent a phantom attacker.
- **DTPS uses the shared encounter duration**, same as DPS, so shares stay additive
  and consistent with the bars.
- **The `metric` hotkey becomes a 3-cycle.** If that feels clumsy in play, a
  per-metric hotkey is a follow-up, not part of this plan.
- **History size:** no retention policy initially — the data is small and the user's
  standing preference is "show all data, always". `clear()` exists for a manual reset.
  If files ever grow annoying, retention (or the SQLite swap) goes behind the store
  interface.
- **Character auto-switch:** records are appended to the file matching the character
  at close time, so a mid-session switch just starts filling a different file.
- Open question for later, deliberately out of scope: an overlay affordance to page
  back through recent encounters in-game. The settings-window browser covers the
  stated need (post-hoc raid review) without touching the overlay's no-scroll,
  no-input invariants.
