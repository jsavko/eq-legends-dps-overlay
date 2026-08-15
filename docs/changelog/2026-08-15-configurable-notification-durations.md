# Configurable notification durations, by category

**Date:** 2026-08-15

## What changed

Every transient notification's on-screen lifetime is now a setting, edited in one
place: a **Durations dialog** in the Triggers window, opened from a `Durations…`
button in the titlebar. Seven categories, each with its own −/value/+ stepper:

| Category | Config key | Default |
|---|---|---|
| Interrupt warnings (enemy casts) | `castChipSec` | 6 s |
| Summons | `summonChipSec` | 5 s |
| Charm breaks | `charmBreakChipSec` | 6 s |
| Quest loot | `questChipSec` | 6 s |
| Pet & command feedback | `noticeChipSec` | 6 s |
| Trigger-pack chips | `triggerChipSec` | 8 s |
| Meter toasts | `toastSec` | 2.6 s |

Every default equals the hard-coded constant it replaced, so an untouched config
behaves bit-for-bit as before. Values clamp to 1–30 s at read time, so a
hand-edited config.json cannot produce a chip that dies before the 4 Hz push
draws it. The dialog carries a "reset to defaults" action that fills the fields
and stops — Save remains the only thing that writes.

**Deliberately not configurable:** crowd-control state chips (they clear on the
log's own end-lines; the dialog says so in prose rather than omitting the
category silently), and the authored long toasts (update found 15 s, downloaded
12 s, first-run hint 9 s, errors 8 s, up-to-date 6 s, checking 4 s) — those were
sized to their messages, and James confirmed they stay fixed. The standing
update line in the overlay footer already persists until the update installs, so
no reminder work was needed there.

## How it flows

- `src/main/config.js` — `DURATION_DEFAULTS` / `DURATION_KEYS`, the
  `durationSec()` read-time clamp, and `alertTtls()` which shapes the parser's
  four lifetimes in ms. `parserOptions()` now carries `alertTtls`, so a parser is
  born tuned.
- `src/parser/index.js` — the four TTL constants became per-instance state,
  `this.alertTtls`, defaulting to the exported constants (which remain the
  defaults and the test fixtures). Cast warnings are now stamped with `ttlMs` at
  creation like summons and charm breaks already were, so the contract is
  uniform: **a chip already up keeps the ttlMs it was stamped with; a change
  applies from the next chip.**
- `src/triggers/engine.js` — `warnTtlMs` option and `setWarnTtl()` setter;
  stamped per warning at fire time, same contract.
- `src/main/main.js` — passes the values at construction; the `CONFIG_SET`
  handler mirrors the encounter-tuning block (`Object.assign(parser.alertTtls,
  …)` + `triggers.setWarnTtl(…)`); `questWarnings()` reads `questChipSec` from
  config on every call; `toast()` resolves an omitted duration from `toastSec`
  so every default-duration call site follows the setting while explicit call
  sites keep their authored lengths.
- `src/main/ipc.js` — one new invoke channel, `config:duration-defaults`, so the
  dialog's reset button gets its numbers from config.js instead of a renderer
  copy that would drift.
- `src/renderer/triggers/` — the `Durations…` titlebar button, the dialog
  (rows built from a category table in triggers.js — names and subs only, no
  numbers), stepper styling, and the save path: one config patch with the seven
  keys over the existing config channel.

## Why the dialog and not per-row controls

The first design put a "stays N s" stepper on each built-in group row plus a
settings-form field for toasts. James rejected it: the requirement was the
categories *listed together*, each with its own duration. The dialog is that
list, and it keeps the one-place rule intact — the Triggers window remains the
single place that answers what may put something on my screen, now including for
how long. The approved Pencil frames are "Triggers — durations entry" and
"Triggers — Durations dialog".

## Tests

832 pass. New coverage: parser `alertTtls` options (per-category override,
defaults, snapshot `remainingMs`, expiry, and the mid-session retune contract),
engine `warnTtlMs` (option, default, setter, rejection of unsurvivable values),
config (defaults equal the old constants by import, clamping, `parserOptions`
carriage, disk round-trip). One existing test updated: the `parserOptions`
deep-equal pin gained the `alertTtls` field.

## Files

- `src/main/config.js` — duration defaults, clamp, `alertTtls()`, `parserOptions()`
- `src/main/main.js` — construction wiring, CONFIG_SET retune, quest chips, toast default, defaults channel
- `src/main/ipc.js` — `CONFIG_DURATION_DEFAULTS` channel
- `src/parser/index.js` — `this.alertTtls`, uniform per-chip `ttlMs` stamping
- `src/triggers/engine.js` — `warnTtlMs` option + setter
- `src/renderer/triggers/index.html` — titlebar button, durations dialog markup
- `src/renderer/triggers/triggers.css` — dialog width, row/stepper/linkish styles
- `src/renderer/triggers/triggers.js` — category table, open/render/save/reset logic
- `src/renderer/triggers/preload.cjs` — `getDurationDefaults`, channel name
- `tests/parser.test.js`, `tests/trigger-engine.test.js`, `tests/config.test.js`
