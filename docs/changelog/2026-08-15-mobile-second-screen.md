# A phone on the same Wi-Fi is now a second screen

**Date:** 2026-08-15

## What it is

Tray → **Second screen…** shows a QR code. Scan it and the phone gets a live meter in
the browser: current fight rows with tap-open breakdowns, a live group DPS/HPS/DTPS
graph, and the fight history — list, stats, timeline, members. Nothing installs and
nothing leaves the LAN: the phone talks straight to an HTTP server inside the overlay.

Off by default, on the session tracker's promise: `mobileEnabled: false` means main
never constructs the server, no port opens, no firewall prompt appears, and the app is
bit-for-bit what it was before the feature existed. **The switch is in both places
that name it.** The dialog turns the feature on and off directly ("Turn on the second
screen" / a quiet "Turn off" / "Try again" on a failed bind) — the first cut bounced
the player to Settings to flip a key the dialog had just named, which lasted exactly
one use. Settings shows the same checkbox, and the two stay honest by construction:
the dialog writes the key immediately, the form's checkbox follows `CONFIG_CHANGED`
live, so its Save only ever writes back what is already true. Two *views* of one key;
what the ALERTS-section removal forbade was two writers that cannot see each other.
Second field lesson: the disable path in `syncMobileServer` originally returned before
pushing `MOBILE_CHANGED`, so "Turn off" left a dead QR on screen — every path notifies
now.

## The server (`src/main/mobile.js`)

Node's built-in `http`, no WebSocket dependency — the phone is a *display*, data flows
one way at the push loop's cadence, and that is exactly what Server-Sent Events are.
SSE also reconnects by itself when the phone's screen sleeps and wakes. Pure Node on
the parser's construction rules: every collaborator injected, so the whole server
starts on 127.0.0.1 under `node --test` and `tests/mobile.test.js` exercises it with
plain `fetch` — routes, auth, static serving, and the SSE frame discipline.

**Payload discipline.** The 4 Hz frame is the lean snapshot, never the series. The
timeline travels in its own event with a per-client cursor: full series once on
connect (and after any reset — a new pull, or a coarsening that reindexed every
bucket), then only newly *closed* buckets per push; the still-open second is never
retransmitted. A client connecting mid-lull gets a greeting snapshot immediately,
because the push loop only speaks when something changed.

**Security posture.** LAN-only; a random 16-hex token (generated once, kept forever —
it is in every QR a phone ever scanned) gates every route, compared in constant time.
The refusal is one flat 403 whatever the path, so a port scan learns nothing. The
first authorized request also sets the token as an `HttpOnly` cookie — discovered by
the headless check, not by a user: browsers do not copy query strings onto
sub-resource requests, so without the cookie every stylesheet and module import would
have 403'd and the page would never have rendered. Static serving is confined to the
renderer tree with an extension whitelist; `..` paths dead-end.

## The page (`src/renderer/mobile/`)

Single column, parchment, ≥15px body text, built against the three phone frames James
approved in Pencil: live meter (metric segments, live group graph, member rows —
tapping one opens its full breakdown in place, every ability, no top-N), history list
(search, chips, day groups), and fight view (stat tiles, timeline with group +
selected-member curves, member rows). The pure modules are imported from their home
directories unchanged — `history/timeline.js`, `history/organize.js`,
`overlay/breakdown.js` — which is why the server serves the renderer *tree*, not just
the mobile directory. The connection dot is the stream, not the fight: green while
open, dried-blood while reconnecting, because a stale meter must look stale.

## The pairing dialog

Tray → Second screen… (`src/renderer/secondscreen/`): the QR on a white tile, the URL
in selectable text, alternates listed when the machine has several LAN addresses, and
plain words for the three off states (switched off / port taken / no LAN address).
The QR encoder is `qrcode-generator@1.4.4` **vendored** as a single ES module
(`src/renderer/vendor/qrcode.js`, MIT, UMD tail swapped for an export) rather than
installed — the two-worlds build pays for every package.json dependency twice, and
this file is the entire package.

## Wiring

`syncMobileServer()` rebuilds wholesale on any `MOBILE_KEYS` change, the
`syncSessionTracker` pattern; a server that cannot bind toasts and leaves the overlay
alone. The push loop broadcasts a timeline-laden snapshot only while a client is
actually connected. First-run setup carrying the keys triggers the same rebuild.
New channels: `MOBILE_STATE`, `MOBILE_CHANGED`, `MOBILE_OPEN`.

## Verified

Headless Windows Chrome at phone size against the real server, fed by replaying the
tail of the live log: all three screens rendered with real fight data (Protector of
Sky, 1:44, curves, 10-ability breakdown with pet/proc tags), 3,006 history rows
rendered untruncated, and a pre-feature record fell back to "no timeline recorded".
The live phone check against a real session is the remaining field test.

## Files

- `src/main/mobile.js` (new) — server; `src/main/config.js` — `mobileEnabled`/`mobilePort`/`mobileToken`, `MOBILE_KEYS`
- `src/main/main.js` — sync/start/stop, push-loop broadcast, tray entry, dialog window, IPC
- `src/main/ipc.js` — the three `mobile:*` channels
- `src/renderer/mobile/` (new), `src/renderer/secondscreen/` (new), `src/renderer/vendor/qrcode.js` (vendored)
- `src/renderer/setup/` — SECOND SCREEN section
- `tests/mobile.test.js` (new), `tests/preload-channels.test.js`
