---
status: completed
---
# Configurable notification durations, by category

**Date:** 2026-08-15

---

## Goal

Let the player set how long each kind of transient notification stays on screen,
per category: quest-loot/completion chips, pet-id and command-feedback notices,
interrupt (enemy cast) warnings, summon chips, charm-break chips, GINA trigger
chips, and meter toasts. Today every one of these lifetimes is a hard-coded
constant, scattered across four files:

| Category | Constant | Where | Default |
|---|---|---|---|
| Interrupt / enemy-cast warnings | `HOSTILE_CAST_TTL_MS` | `src/parser/index.js` | 6000 |
| Summon chips | `SUMMON_TTL_MS` | `src/parser/index.js` | 5000 |
| Charm-break chips | `CHARM_BREAK_TTL_MS` | `src/parser/index.js` | 6000 |
| Pet-id / command notices | `NOTICE_TTL_MS` | `src/parser/index.js` | 6000 |
| Quest chips | `QUEST_CHIP_TTL_MS` | `src/main/main.js` | 6000 |
| Trigger-pack chips | `TRIGGER_WARN_TTL_MS` | `src/triggers/engine.js` | 8000 |
| Meter toasts (default) | `showToast(msg, ms = 2600)` | `src/renderer/overlay/overlay.js` | 2600 |

Deliberately **out of scope**: CC state chips (`CC_STATE_CAP_MS`). Those clear on
the log's own end-lines; the 30s figure is a safety cap against a missed line, not
a display duration. Exposing it as "how long MEZZED shows" would misdescribe what
the chip is — a state report, not a timer — and invite "why did my mez chip vanish"
confusion. Also out of scope: toasts with authored explicit durations (the 15s
update-found notice, 8s error toasts) — those lengths were chosen per message;
only the 2600ms *default* becomes configurable.

## Approaches Considered

### 1. Duration keys in config, edited where each category's switch already lives
- **Description:** One flat config key per category (`castChipSec`, `summonChipSec`,
  `charmBreakChipSec`, `questChipSec`, `noticeChipSec`, `triggerChipSec`,
  `toastSec`), defaults exactly matching today's constants. Chip durations are
  edited in the **Triggers window** — a compact "stays N s" stepper on each
  built-in *group* row that owns a timed chip (Enemy casts, Summons, Charm
  breaks, Quest loot), carried through the `builtin-pack.js` shim the same way
  the on/off switches already are. Trigger-pack chip duration is one control in
  the titlebar chips pill, beside the `triggerAlerts` surface it modifies. The meter-toast
  default goes in the settings form, which owns overlay behavior. Parser and
  trigger engine take the values as constructor options with the current constants
  as defaults, mirroring `encounterOptions`.
- **Pros:** Respects the architecture decision that removed the ALERTS section from
  settings — one place answers "what may put something on my screen (and for how
  long)". Parser and engine stay pure Node and unit-testable; defaults preserved
  means zero behavior change for anyone who never touches the controls. Follows
  the exact precedent of `combatTimeoutSec` → `parser.encounterOptions`.
- **Cons:** Touches five layers (config, parser, engine, builtin-pack shim,
  triggers-window UI); the pet-notice category has no builtin row yet, so one must
  be added.

### 2. A "Notifications" section in the settings form
- **Description:** All seven duration fields as numeric inputs in the setup window.
- **Pros:** One screen, least UI plumbing — the settings form already has numeric
  fields (combat timeout, grace).
- **Cons:** Re-creates the exact two-places bug that got the ALERTS section removed
  from settings: the Triggers window says what a category does, settings would say
  for how long, and a Save in one clobbers or contradicts the other. CLAUDE.md
  records this as a deliberate one-way door. Rejected on architecture.

### 3. One global linger multiplier
- **Description:** A single "notifications stay ×1.5 longer" slider scaling every
  TTL.
- **Pros:** One knob, trivial plumbing, impossible to misconfigure one category.
- **Cons:** Not what was asked — "configurable by category" is the request. A
  player who wants quest chips up 15s but interrupt calls snappy cannot express
  that with one multiplier.

### 4. Per-trigger durations in the pack format
- **Description:** Extend the trigger/pack schema so every row (builtin rows
  included) carries its own chip duration, editable per trigger and exported with
  the pack.
- **Pros:** Maximum granularity; duration travels with a shared pack.
- **Cons:** Pack-format change with import/export compat to manage, per-trigger
  editor UI, and `pack.edited` semantics to work out — far more surface than the
  request needs. Category-level is the ask; this can layer on later without
  conflicting with approach 1.

## Chosen Approach

**Approach 1, revised 2026-08-15 after James's review.** The first mock spread
the controls across the built-in rows plus a settings-form field; James rejected
that — the requirement is the categories *listed together*, each with its own
duration. So: durations become config keys with defaults identical to today's
constants, and all of them are edited in **one Durations dialog in the Triggers
window**, opened from a `durations…` button in the titlebar (between the
surfaces pills and Import). The dialog lists every category — interrupt
warnings, summons, charm breaks, quest loot, pet & command feedback,
trigger-pack chips, and meter toasts — each with a −/value/+ stepper, plus a
prose line explaining that crowd control has no timer (state chips clear on the
log's end-lines) and a "reset to defaults" action. James approved this shape
(ASCII preview) and the Pencil mock is built. It is still one place answering
one question. The parser and trigger engine receive the values as options —
modeled on `encounterOptions` and applied at runtime through the existing
`CONFIG_SET` handler — so `src/parser/` and `src/triggers/` stay Electron-free
and the new behavior is unit-testable in WSL.

Mechanics that make this cheap: the parser already stamps `ttlMs` per chip
(`c.ttlMs ?? HOSTILE_CAST_TTL_MS`), so category TTLs become instance fields read
at chip creation; the trigger engine already stamps `ttlMs: TRIGGER_WARN_TTL_MS`
per warning; quest chips are pruned in `questWarnings()` in main.js, which can
read config directly; the meter-toast default moves from the renderer signature
into main's `toast()` helper so every default-duration call site picks up the
configured value.

## Tasks

- [x] `src/main/config.js`: add defaults `castChipSec: 6`, `summonChipSec: 5`,
      `charmBreakChipSec: 6`, `questChipSec: 6`, `noticeChipSec: 6`,
      `triggerChipSec: 8`, `toastSec: 2.6`; clamp on read/edit to a sane range
      (1–30s) the way other numeric settings are validated.
- [x] `src/parser/index.js`: introduce `this.alertTtls` (shape:
      `{ hostileCastMs, summonMs, charmBreakMs, noticeMs }`, defaults from the
      existing exported constants) set from constructor options; replace the four
      constant reads (chip stamping at ~1316/1409/1597, notice prune/snapshot at
      1106/1821) with the instance fields. Keep the constants exported as the
      defaults.
- [x] `src/triggers/engine.js`: accept `warnTtlMs` as an engine option (default
      `TRIGGER_WARN_TTL_MS`); stamp it on new warnings; add a setter for runtime
      changes.
- [x] `src/main/main.js`: pass the configured values into `LogParser` and the
      trigger engine at construction; in the `CONFIG_SET` handler, apply duration
      patches via `Object.assign(parser.alertTtls, …)` / the engine setter
      (mirror of the encounter-tuning block); make `questWarnings()` read
      `questChipSec` instead of `QUEST_CHIP_TTL_MS`; default `toast(message, ms)`
      to `config.get('toastSec') * 1000` when `ms` is omitted, leaving explicit
      call sites untouched.
- [x] Pencil mockup — **approved shape 2026-08-15**: "Triggers — durations
      entry" (titlebar `durations…` button) and "Triggers — Durations dialog"
      frames in Pencil. First iteration (per-row steppers + settings field) was
      rejected as not-by-category; superseded by the one-dialog design.
- [x] `src/renderer/triggers/`: add the `durations…` titlebar button and the
      Durations dialog (seven categories, −/value/+ steppers, crowd-control
      prose line, Save/Cancel, reset-to-defaults). Save writes one config patch
      with the seven `*Sec` keys over the existing config channel; the dialog
      re-reads config on open. No builtin-pack or per-row changes.
- [x] Tests: parser constructed with custom `alertTtls` shows matching
      `remainingMs`/expiry in snapshots for cast, summon, charm-break and notice
      chips; trigger engine honors `warnTtlMs`; config defaults and clamping.
      (The builtin-pack round-trip test died with the per-row design.)
- [x] `npm test`, then `scripts/dev.sh pack` and relaunch so the running copy
      actually has the change.
- [x] `docs/changelog/2026-08-15-configurable-notification-durations.md`.

## Notes

- **Defaults are behavior-preserving.** Every default equals the constant it
  replaces (including the odd-looking `toastSec: 2.6`) so a player who never opens
  the controls sees exactly today's timing.
- **Mid-flight chips keep their stamped TTL** when a duration changes; the next
  chip uses the new value. Same contract as encounter tuning ("affects fights
  started from here"), and worth a sentence in the UI copy if it ever surprises.
- **Alerts-window sizing:** the click-through alerts window buys its
  never-clipped guarantee with an oversized invisible box, so longer durations
  change nothing geometrically — more chips may coexist, but the stack already
  handles that; no layout work expected.
- **Resolved 2026-08-15:** the long authored toasts (update found 15s, errors
  8s, first-run hint 9s) stay fixed — James confirmed. The standing update line
  in the overlay footer already persists until the update installs, so no
  reminder work is needed there either.
- Per-trigger durations in the pack format (approach 4) remain open as a future
  layer; nothing here blocks it.
