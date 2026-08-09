# An update says so on the meter, and can be asked for by name

**2026-08-09**

The overlay footer now carries a standing "v0.9.0 available" notice, in the slot the
stale-log warning vacated earlier today. The tray grew a **Check for updates** entry and a
version line. And `scripts/check-update-feed.js` exists to answer the question that
prompted all of it: *is the auto-updater working, or is there just nothing to update to?*

---

## Why it looked broken

It wasn't, and the two facts that explain it are worth writing down because they will look
identical from the outside every time:

1. **The newest published release is v0.8.0, which is the version being run.** A correct
   updater checks, finds nothing newer, and says nothing. That is indistinguishable from an
   updater that never ran.
2. **`win-unpacked` is mode `off` by design** — the build launched from
   `dist\win-unpacked`, which is the one James uses. It is packaged but not installed, so
   "updating" it would drop a second copy into `%LOCALAPPDATA%\Programs` and leave the
   running one untouched. `src/main/updater.js` has always said so; nothing on screen did.

Both checked directly: the release feed at
`releases/latest/download/latest.yml` reports `version: 0.8.0`, points at
`EQL-DPS-Overlay-Setup-0.8.0.exe`, and carries its sha512. The feed is healthy.

## The notice

`pushStatus` now carries an `update` field, and the overlay footer reads
`Rhale · v0.9.0 available` — or `v0.9.0 installs on quit` once an installed copy has
downloaded it. It is deliberately the same slot the stale-log warning used, and deliberately
the opposite kind of claim: pushed at the moment it becomes true, true until acted on, and
incapable of being contradicted by anything else on screen. The old warning failed all three,
which is why it was deleted rather than fixed.

A standing line rather than only a toast, because an update stays available. The toast says
it once; twelve seconds later it is gone and a player who was mid-pull never learns.

**The check that raises it runs in every mode, `off` included.** That rests on a distinction
worth being explicit about: `win-unpacked` is excluded from *installing* an update, not from
*knowing* one exists. The check only ever reads a version number, so it cannot violate the
rule it sits beside — and without it the notice would never appear on the build most in need
of it, since nothing else will ever mention one.

## The tray

```
Version 0.8.0                     (disabled — a fact, not a control)
Check for updates
Get v0.9.0…                       (only once there is something to get)
```

**Check for updates** asks the GitHub releases API directly rather than going through
electron-updater. That is what lets it answer in every mode, including the `off` one the
person most likely to press it is running. It also cannot install anything, which is right:
pressing a menu item should tell you something, not start replacing files. In `auto` mode it
additionally nudges the background updater, so the download starts rather than merely being
announced.

Every outcome says something — "Up to date — v0.8.0" and "Update check failed — GitHub
answered 403" are both results. The entire point of the button is to convert "I don't think
it's working" into a sentence.

## Testing it

Two things, because the release-day path cannot otherwise be exercised without cutting a
release.

**`node scripts/check-update-feed.js`** fetches exactly what electron-updater fetches and
reports every step: what each of the three copy kinds would do, what the API says, what
`latest.yml` says, and a verdict. It catches the failure that actually bites — a release
whose `latest.yml` disagrees with its tag, which electron-updater resolves in favour of the
yml. Read-only; safe to run mid-raid.

**`EQL_UPDATE_TEST_VERSION`** makes the app compare against a version it isn't. Launch with
`EQL_UPDATE_TEST_VERSION=0.7.0` and the real v0.8.0 release is found, the footer notice
appears, the tray entry appears, and the toast fires — the whole path, exactly as it will
behave on release day. Read from the environment rather than config so it cannot be left
switched on by accident.

That is how this was verified. Attaching to the running overlay's renderer over CDP with the
override set:

```
footer #status text : "Rhale · v0.8.0 available"
body[data-update]   : "true"
rendered colour     : rgb(224, 165, 63)      -- the --ember-lit accent
```

On `win-unpacked` — the mode where none of this previously happened at all.

## Files

| File | Change |
|---|---|
| `src/main/updater.js` | `RELEASES_API`, `isNewerVersion`, `fetchLatestVersion`; `startUpdater` returns `{stop, check}` and takes `onUpdate`; `update-available` now registered in both modes |
| `src/main/main.js` | update notice state, `selfVersion()` with the test override, `quietUpdateCheck`, `checkForUpdatesNow`, tray entries, `update` on the STATUS payload |
| `src/renderer/overlay/overlay.js` | the footer notice and its tooltip |
| `src/renderer/overlay/overlay.css` | `body[data-update="true"] #status` accent |
| `scripts/check-update-feed.js` | new — verifies the live feed and says what each copy would do |
| `tests/updater.test.js` | version comparison (including `0.10.0` > `0.9.0`), garbage handling, feed reading and its failures |

## Notes

`isNewerVersion` compares numerically field by field. A string compare puts `0.10.0` below
`0.9.0`, which is the next version boundary this project will actually reach — it would have
sat on that update indefinitely without ever saying so. Unparseable versions never announce
an update: the safe answer to "I cannot read this" is silence.
