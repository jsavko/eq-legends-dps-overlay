---
status: created
---
# Discord-style updates: prove the differential download, then make it visible

**Date:** 2026-08-08

---

## Goal

Make self-update feel the way Discord's does — a small background fetch that swaps itself
in without anyone downloading an 80 MB installer — and be able to *prove* that is what is
happening rather than assuming it.

The investigation behind this plan turned up something worth stating up front: **the
machinery is already in place, and the numbers say it should already be working.** What is
missing is not a feature, it is evidence.

Measured from the two blockmaps sitting in `C:\eqoverlay-dev\dist` right now:

| Update | Installer size | Blocks that change | Bytes a differential update must fetch |
|---|---|---|---|
| 0.7.1 → 0.7.2 | 82.0 MB (3877 blocks) | 40 | **0.9 MB (1.1%)** |
| 0.6.1 → 0.7.0 | 82.0 MB (3878 blocks) | 40 | **0.9 MB (1.0%)** |

That is the Discord number. It is also *smaller than `app.asar` itself* (2.5 MB), which
kills the obvious hand-rolled alternative before it starts.

What the code review confirmed about the runtime path (electron-updater 6.8.9, read from
`C:\eqoverlay-dev\node_modules`):

- `NsisUpdater.doDownloadUpdate` calls `differentialDownloadInstaller(...)` **by default** —
  `disableDifferentialDownload` is `false` unless we set it.
- The old file it diffs against is
  `%LOCALAPPDATA%\eq-legends-dps-overlay-updater\installer.exe`. Nothing in our code puts
  it there — **the NSIS installer copies itself there at install time**
  (`app-builder-lib` `NsisTarget.js:475` sets `APP_INSTALLER_STORE_FILE`,
  `templates/nsis/include/installer.nsh:93` does the copy, unconditionally for a non-web
  NSIS target). Confirmed empirically: three other electron-builder apps on this machine
  (`curseforge-updater`, `pen-updater`, `wowup-updater`) each have an `installer.exe`
  sitting in that cache directory.
- The old blockmap URL is derived by substituting the version into the new asset's URL,
  so it resolves to `…/download/v0.7.1/EQL-DPS-Overlay-Setup-0.7.1.exe.blockmap` — which
  `dev.sh release` already uploads for every release.
- GitHub sets `isUseMultipleRangeRequest: false`, so the 40 changed blocks arrive as ~40
  sequential range requests rather than one multipart response. Slower, still ~0.9 MB.

And the reason we cannot currently tell whether any of that happens: **every failure in
that path is caught and silently downgraded to a full download.**
`differentialDownloadInstaller` ends in `catch (e) { this._logger.error(...); return true }`
— `return true` meaning "go fetch all 82 MB". Our `_logger` is the default `console`, and a
packaged Electron app with no terminal writes that to nowhere. A broken diff path and a
working one look identical from the outside.

So the work is: turn the invisible on, measure it, and say the real number on screen.

## Approaches Considered

### 1. Instrument the differential path that already exists
- **Description:** Give `autoUpdater` a real file logger (`<userData>\updater.log`), set
  `disableWebInstaller = true` (electron-updater warns about the default and says it flips
  in a future version), subscribe to `download-progress` — which is also what makes
  electron-updater attach `onProgress` to the *differential* downloader at all — and put
  the actual transferred bytes in the existing toast. Then cut two releases and read the
  log. Add `scripts/blockmap-diff.js` so the update size for a pending release can be
  measured before it ships.
- **Pros:** No new dependency, no new artifact, no change to how anyone installs. Turns an
  unverifiable claim into a measured one. If the path is already working, the whole job is
  the instrumentation; if it is broken, the log says exactly why on the next release.
  Downloads land at ~1% of the installer, which is the thing actually being asked for.
- **Cons:** Doesn't change the *mechanism*, so if the diff path turns out to be broken for
  a reason we can't fix from our side, this plan buys diagnosis rather than a fix. An
  Electron version bump still costs a near-full download (true of Discord too).

### 2. `nsis-web` target with `differentialPackage`
- **Description:** Switch the installer to electron-builder's web target: a small stub exe
  plus a separate `.7z` payload, and let electron-updater diff the package rather than the
  installer.
- **Pros:** This is the configuration electron-builder explicitly designed around
  differential updates; block alignment in a 7z payload is more predictable than inside a
  monolithic NSIS exe.
- **Cons:** Solves a problem the measurement says we do not have — the monolithic installer
  already diffs to 1.1%. It also breaks the friend-facing property that the Setup exe is
  one file you can hand someone: a web installer needs the network at *install* time, and
  the first-run SmartScreen prompt now guards a stub that then downloads more. Real cost,
  no measured benefit.

### 3. Squirrel.Windows (the literal Discord mechanism)
- **Description:** Swap NSIS for `squirrel.windows`: versioned `app-<version>` directories
  under `%LOCALAPPDATA%`, a stub launcher, per-file delta `.nupkg` packages.
- **Pros:** Exactly what Discord does, including applying in the background with the next
  launch picking up the new version.
- **Cons:** Squirrel.Windows is effectively unmaintained and electron-builder steers people
  off it. Every existing install would need reinstalling into a different location. The
  `portable` target does not coexist with it. All of that to reach a download size we can
  already reach with the config we have.

### 4. Hand-rolled `app.asar` hot-swap
- **Description:** Skip installers entirely — download `app.asar` from the release, verify
  a hash, replace it on quit, fall back to the full installer when the Electron version
  changes.
- **Pros:** Conceptually the smallest possible update; no installer runs at all.
- **Cons:** The measurement kills it: `app.asar` is 2.5 MB and the blockmap diff is 0.9 MB,
  so the "smaller" approach is nearly 3× larger. It also puts signature verification,
  atomic replacement and rollback on us, desynchronises the NSIS uninstaller's file
  inventory from what is on disk, and cannot carry an Electron upgrade. Custom risk in
  exchange for a worse number.

### 5. Do nothing
- **Description:** Assume it works, because on paper it should.
- **Pros:** Free.
- **Cons:** "On paper" is exactly the state this plan exists to leave. The failure mode is
  silent by construction — a user quietly pulling 82 MB every release would look identical
  to one pulling 0.9 MB, and nobody would ever find out.

## Chosen Approach

**Approach 1.** The differential download is already configured, already fed by published
blockmaps, and already measured at ~1% of the installer for the last two real releases. The
honest answer to "can it work more like Discord" is that it is built to, and we have no
evidence either way — which is a defect of instrumentation, not of design. Every other
approach trades a real cost (a worse artifact, an unmaintained framework, hand-rolled
update safety) for a number we can already hit.

This also fits the project's own bias toward honest numbers over plausible ones: the toast
currently says a version "downloaded" without saying how much, and the plan replaces that
with what actually crossed the wire.

The apply step needs nothing: the NSIS installer already runs with `/S` on quit and
`autoInstallOnAppQuit`, with no restart prompt — which is exactly Discord's "it's just
newer next time you open it" behaviour, and is already an invariant in `CLAUDE.md`.

If the first instrumented release shows the diff path falling back, this plan's log line
will name the reason, and *that* becomes the next plan — with approach 2 as the most likely
remedy.

## Tasks

- [ ] Add `scripts/blockmap-diff.js <old.blockmap> <new.blockmap>`: gunzip both, hash-match
      blocks, print total / reusable / must-download bytes and percentage. This is the
      before-you-ship measurement, and it works entirely in WSL against files in
      `C:\eqoverlay-dev\dist`.
- [ ] Add a small file logger in `src/main/updater.js` writing to `<userData>\updater.log`
      (`info`/`warn`/`error`/`debug` methods, since electron-updater calls all four),
      truncating the file at startup if it exceeds ~256 KB. No new dependency — plain
      `fs.appendFileSync` on a resolved path, with all write failures swallowed the way
      history write failures are, because a full disk must not take the overlay down.
- [ ] Inject the log directory rather than importing `app` in `updater.js`, so the logger
      stays unit-testable in WSL like `updateMode` already is.
- [ ] Set `autoUpdater.logger` to that logger, and `autoUpdater.disableWebInstaller = true`
      (we do not ship a web installer, and electron-updater logs a warning telling us to
      say so; the default flips in a future version).
- [ ] Subscribe to `autoUpdater.on('download-progress', …)`. Beyond the numbers, this
      subscription is load-bearing: `differentialDownloadInstaller` only attaches
      `onProgress` when `listenerCount('download-progress') > 0`, so without it the
      differential download reports nothing at all. Record the last progress event; do not
      toast per event.
- [ ] Add a pure `describeDownload({ transferred, total })` helper that formats the
      "0.9 MB of 82 MB" phrasing, and unit-test it in `tests/updater.test.js` alongside the
      existing `updateMode` cases — including the case where no progress was seen, which
      must degrade to the current wording rather than invent a number.
- [ ] Change the `update-downloaded` toast to state what was actually fetched:
      `v0.7.3 downloaded (0.9 MB of 82 MB) — installs when you quit`. Keep it a meter
      toast, never a cast alert.
- [ ] Log one explicit line at the end of a download saying whether the transfer was
      differential or a full fallback, so reading `updater.log` answers the question this
      plan exists to answer without interpreting byte counts.
- [ ] Have `scripts/dev.sh release` check that the *previous* release still has its
      `.blockmap` asset on GitHub (`gh release view`) and warn — not fail — if it does not,
      since a missing old blockmap silently costs every updater a full 82 MB download.
- [ ] Bump the version, `scripts/dev.sh release`, and install the Setup exe on Windows to
      seed `%LOCALAPPDATA%\eq-legends-dps-overlay-updater\installer.exe`.
- [ ] Bump again, release again, let the installed copy check, then read `updater.log` and
      record the real transferred bytes. This is the verification step the whole plan is
      built around — the plan is not done until a number from a real update is written
      down.
- [ ] Write `docs/changelog/2026-08-08-differential-updates.md` with the measured
      before/after, the blockmap mechanism, and where `installer.exe` comes from (that last
      one is the fact most likely to be re-derived painfully later).
- [ ] Update `CLAUDE.md`: note that updates are block-differential, that `updater.log`
      exists and is where to look, and that an Electron version bump costs a near-full
      download by nature.

## Notes

- **`win-unpacked` stays `off`.** Nothing here touches the tiering. James launches
  `win-unpacked`, which is packaged but not installed; letting the updater loose on it
  would install a second copy into `%LOCALAPPDATA%\Programs` and leave the running one
  stale. The verification tasks above therefore need the *Setup* build installed on
  Windows — testing this from `win-unpacked` will silently exercise nothing.
- **Electron bumps break the diff, and that is fine.** The 1.1% figure holds because
  `electron` was pinned across those releases. `scripts/blockmap-diff.js` will show the
  damage before a release goes out, which is enough — Discord has exactly the same cliff
  when it ships a new Chromium.
- **The old-blockmap dependency is a real operational constraint.** Deleting an old GitHub
  release, or renaming the artifact pattern, makes every updater fall back to a full
  download without any user-visible symptom. Hence the `dev.sh release` warning task.
- **No code signing changes here.** SmartScreen on first manual install is unchanged and
  unrelated; automatic updates already arrive without the mark-of-the-web.
- **Open question, deliberately deferred:** whether the ~40 sequential range requests
  against GitHub ever behave badly (rate limiting, CDN redirect churn). The log will show
  it if it happens; guessing at it now would be inventing a problem.
