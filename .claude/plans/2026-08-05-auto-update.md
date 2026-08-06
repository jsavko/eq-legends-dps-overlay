---
status: in-progress
---
# Auto-update: stop hand-delivering the exe

**Date:** 2026-08-05 (updated 2026-08-06 — 0.4.0–0.5.4 shipped in the meantime; version
targets and build-script details refreshed, nothing about the approach changed)

---

## Goal

Every code change currently reaches the friend by James manually sending a new portable
exe. Make the app update itself instead: James cuts a release with one command, and the
friend's copy notices, downloads, and installs it without either of them doing anything.

Current state that shapes the options:

- Source is private (`jsavko/eq-legends-dps-overlay`), `gh` CLI already authenticated
  in WSL.
- The build is an **unsigned portable exe** — the one electron-builder target that
  `electron-updater` explicitly cannot update (a single self-contained exe has no
  install location to update).
- The app deliberately depends on `electron` alone; the hard invariant is **no native
  modules** (two-worlds build). `electron-updater` is pure JS, so it bends the letter
  of the first while honoring the second.
- The overlay runs for hours during raids — an update must never restart the app
  mid-session; install-on-quit is the only acceptable behavior.

## Approaches Considered

### 1. electron-updater + NSIS installer + GitHub Releases on a dedicated public releases repo
- **Description:** Switch the friend-facing artifact from portable to a per-user NSIS
  installer (no UAC, installs to `%LOCALAPPDATA%\Programs`). Add `electron-updater`;
  point its GitHub provider at a new **public, assets-only** repo
  (`jsavko/eq-legends-dps-overlay-releases`) so the private source stays private. A new
  `dev.sh release` builds on the Windows side, then publishes installer + blockmap +
  `latest.yml` from WSL with the already-authenticated `gh`. The friend installs once;
  after that updates download in the background and install silently on quit.
- **Pros:** Battle-tested updater (sha512 integrity from `latest.yml`, differential
  downloads via blockmap, the file-swap dance solved); install-on-quit is the default
  behavior and exactly right for a raid overlay; no server, no token in the app (public
  repo needs none); one-command publishing; private source stays private.
- **Cons:** One new runtime dependency (pure JS); the friend re-installs once (and
  clicks through SmartScreen once — unsigned installer); release binaries are publicly
  downloadable by anyone who finds the repo.

### 2. Release from the private source repo, token embedded in the app
- **Description:** Keep everything in the private repo; ship a GitHub token inside the
  app so the friend's copy can read private releases.
- **Pros:** No second repo.
- **Cons:** A credential in an asar is a credential published — anyone can unzip it,
  and a repo-scoped token exposes the private *source*, not just binaries. Rotation
  breaks the friend's updater silently. Disqualifying.

### 3. Roll-your-own updater, keep the portable exe
- **Description:** Main checks a version JSON, downloads the new portable exe, and a
  spawned cmd script swaps the file after quit.
- **Pros:** Zero new dependencies; distribution format unchanged.
- **Cons:** A self-replacing unsigned exe is prime antivirus-heuristic bait; the swap
  dance (locked running exe, rename tricks, version-stamped filenames, wherever the
  friend keeps the file) is fiddly failure-prone code owned forever; re-implements
  integrity checking electron-updater already does. The portable target is unsupported
  by electron-updater for exactly these reasons.

### 4. Shared synced folder (Dropbox/OneDrive/Syncthing)
- **Description:** Drop the portable exe in a shared folder; the friend always launches
  the latest.
- **Pros:** No code at all.
- **Cons:** Sync clients cannot replace an exe the friend is running (conflict copies);
  no integrity or version gating; still "quit and relaunch when I tell you"; depends on
  a third-party client configured on both ends. Automates the *sending*, not the
  *updating*.

### 5. Make the source repo public and release there
- **Description:** Flip `eq-legends-dps-overlay` public and publish releases on it
  directly — approach 1 minus the second repo.
- **Pros:** Simplest possible topology.
- **Cons:** Publishes the source, which is James's call to make, not a technical
  necessity — approach 1 delivers the same updater without forcing it.

## Chosen Approach

**Approach 5 carrying approach 1's mechanics** — James confirmed mid-planning that the
project isn't sensitive and the repo doesn't need to stay private. So: make
`jsavko/eq-legends-dps-overlay` public and release directly on it, with the same
updater wiring approach 1 described (electron-updater, NSIS, `gh` publishing,
install-on-quit). Everything proven and tokenless, minus the second repo. The
dependency cost is real but pure-JS, so the invariant that actually matters (no native
modules) holds.

**Both targets, one build** (James, mid-planning: "the portability is really nice") —
`win.target: [nsis, portable]`, so every release ships an installer *and* a portable
exe. A lone exe still cannot swap itself, so update behavior is tiered by how the copy
is running, detected at runtime:

1. **NSIS-installed** (exe under `AppData\Local\Programs`): full auto-update —
   download in background, install on quit.
2. **Portable** (electron-builder's portable launcher sets
   `PORTABLE_EXECUTABLE_FILE` in the environment): check-only — no download, just a
   toast "v0.6.1 is out — grab it from the GitHub releases page". Honest about what a
   portable exe can do, and the user is never stuck on a stale version unknowingly.
3. **Everything else** (win-unpacked, dev): updater untouched, exactly today's
   behavior.

Key wiring decisions:

- **Install-on-quit only.** `autoInstallOnAppQuit` (electron-updater's default) plus a
  toast when the download lands ("v0.6.1 downloaded — installs when you quit"). No
  restart prompts, ever — the overlay is mid-raid by assumption.
- **Update notices are toasts on the meter, not alerts.** The alerts window that
  shipped in 0.4.0/0.5.0 is for combat warnings (enemy casts, boss timers) — an
  update notice mid-raid does not belong top-center over the game. Use the existing
  `toast()` in `src/main/main.js` (the same channel as "Encounter reset" and history
  write failures).
- **Guard where the updater runs.** James launches `win-unpacked`, which is packaged
  but not NSIS-installed — the updater there would "update" by silently installing a
  second copy to `%LOCALAPPDATA%\Programs`. Only run the updater when the exe path is
  under `AppData\Local\Programs` (the per-user NSIS install dir); dev launches are
  already excluded by `app.isPackaged`.
- **Publish via `gh` from WSL, not `electron-builder --publish`.** Publishing from the
  Windows side would need a GH_TOKEN in the Windows environment; `gh` in WSL is already
  authenticated and uploads the same three artifacts.
- **Check on startup + every 4 hours.** Sessions run long; a launch-only check would
  miss releases cut during a play session. Check errors (offline, rate limit) log to
  console only — a toast per failed check would nag during play.

## Tasks

- [ ] One-time: `gh repo edit jsavko/eq-legends-dps-overlay --visibility public
      --accept-visibility-change-consequences` (recent `gh` requires the second flag;
      James's call, confirmed 2026-08-05: "this isn't a sensitive project". Still
      private as of 2026-08-06).
- [x] `package.json`: add `"dependencies": { "electron-updater": "^6" }`; set
      `win.target` to BOTH `nsis` (per-user default, `oneClick`, artifact
      `EQL-DPS-Overlay-Setup-${version}.exe`) and `portable` (existing block and
      artifact name kept); **change the `dist` script from
      `electron-builder --win portable` to `electron-builder --win`** — the CLI
      target overrides `build.win.target`, so leaving `portable` there would keep
      producing portable-only builds no matter what the config says; add
      `build.publish` = github / owner `jsavko` / repo `eq-legends-dps-overlay`
      (this is what bakes `app-update.yml` into the build so a running copy knows
      where to look).
- [x] `scripts/dev.sh install` so Windows npm fetches `electron-updater`; WSL-side
      `npm install` too so the WSL `node_modules` matches (there is no lockfile —
      verified 2026-08-06).
- [x] `src/main/main.js`: wire `autoUpdater` — ESM-import from the CJS package
      (`import electronUpdater from 'electron-updater'`); tiered by runtime detection:
      exe under `AppData\Local\Programs` → full auto-update (download in background,
      `autoInstallOnAppQuit`, toast on `update-downloaded` naming the version and
      "installs when you quit"); `process.env.PORTABLE_EXECUTABLE_FILE` set →
      `autoDownload = false`, check only, toast on `update-available` pointing at the
      releases page; neither (win-unpacked, dev) → updater not started at all. Checks
      on startup (short delay, after tailing starts) and every 4 hours; check errors to
      console only.
- [x] `scripts/dev.sh`: add a `release` case — sync, install if needed,
      `win_npm run dist`, then read the version from `package.json` and
      `gh release create v<ver> --repo jsavko/eq-legends-dps-overlay` with the
      Setup exe, its `.blockmap`, `latest.yml`, AND the portable exe from
      `C:\eqoverlay-dev\dist`
      (duplicate tag fails the command, which is the correct guard against re-releasing
      a version; the release also tags the source commit it shipped from, a bonus of
      releasing on the source repo). Update the usage comment.
- [x] `CLAUDE.md`: amend the "depends on `electron` alone" wording (the invariant is no
      *native* modules; `electron-updater` is pure JS), document `dev.sh release`, and
      note the friend-facing artifact is now the Setup installer.
- [x] `npm test` — suite stays green (no pure-module changes expected).
- [x] `docs/changelog/2026-08-06-auto-update.md`.
- [ ] Bump to 0.6.0 (own commit — 0.4.0 was taken by enemy cast warnings while this
      plan waited), run `scripts/dev.sh release`, verify the release shows all FOUR
      assets (Setup exe, its `.blockmap`, `latest.yml`, portable exe), and send the
      friend the release link — the last manual send ever.

## Notes

### Deviations taken during execution (2026-08-06)

- **The updater is `src/main/updater.js`, not inline in `main.js`.** main.js is already
  ~970 lines, and splitting it bought a testable pure half: `updateMode()` decides the
  tier from `isPackaged` / `execPath` / `env`, and `tests/updater.test.js` pins all seven
  cases — including the win-unpacked trap the plan calls out. `electron-updater` is
  imported **dynamically** inside `startUpdater()` rather than statically at the top;
  a static import reaches for `electron` at load time and would make the test file
  unrunnable in WSL.
- **`dist` is `electron-builder --win --publish never`**, one flag past the plan's
  `--win`. Verified empirically that `latest.yml` and `app-update.yml` are still
  generated with it (they are — they come from the publish *config*, not the publish
  *action*), and it removes any chance of a tag or CI heuristic making the Windows-side
  build attempt an upload with no token in its environment.
- **The WSL-side `npm install` was skipped.** The plan assumed a WSL `node_modules` to
  keep in sync; there isn't one — the suite runs dependency-free, and the pure half
  deliberately never imports `electron-updater`, so installing would have pulled ~100 MB
  of linux Electron to change nothing. `scripts/dev.sh install` ran on the Windows side,
  which is the one that matters (9 packages added).
- **`README.md` updated too**, which the plan did not list: its distribution section
  read "No installer, no Node, no dev toolchain", which is now wrong.
- **`dev.sh release` refuses an unpushed HEAD** and pins the tag with `--target <sha>`.
  A release tag is a promise that the source behind it is fetchable, and `gh release
  create` would otherwise tag whatever the *remote's* default branch happens to be.
- **Build verified before releasing:** both targets built clean from `dev.sh dist`
  (0.5.5), `latest.yml` carries the Setup exe's sha512, `resources/app-update.yml` holds
  the github/jsavko provider, `electron-updater` is present inside `app.asar`, and the
  packaged win-unpacked build launches with the new import in place.
- **Git-history skim done** (the irreversibility note below): no tokens, keys, passwords
  or unexpected file types in any commit. The only personal path is a local Pencil
  document path in an archived plan (`C:/Users/james/.pencil/...`) — a first name already
  attached to the git author and the GitHub handle.

### Original notes

- Repo visibility: resolved during planning — James said the repo is private only by
  default, not by need, so it goes public and releases live on it directly (this is
  what turned the chosen approach from 1 into 5).
- Portable stays in the lineup (James, mid-planning): every release ships both
  artifacts. The friend should get the *installer* for hands-off updates; the portable
  exe is for whoever values the single file and accepts a "new version is out" toast
  plus a manual download as the update path — a lone exe cannot replace itself.
- **Still worth a glance when reviewing:** the friend's one-time SmartScreen click
  ("More info → Run anyway") on the unsigned installer; auto-updates after that carry
  no mark-of-the-web and install silently.
- Going public also means the git history goes public — worth a skim for anything
  accidental (paths with the Windows username appear in docs/changelogs; no secrets
  are known to be committed, but the skim is cheap and irreversible-to-skip).
- James's own copy: `win-unpacked` keeps working exactly as today (the updater guard
  skips it). To dogfood the friend's experience, optionally install the 0.6.0 Setup
  once and watch it self-update when 0.6.1 ships.
- electron-updater no-ops nothing by itself on a public repo — no token anywhere in
  the app or the build.
- The 4-hour re-check plus install-on-quit means the friend picks up a mid-session
  release the next time they quit and relaunch, with zero interaction.
