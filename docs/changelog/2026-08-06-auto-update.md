# Auto-update: stop hand-delivering the exe

**Date:** 2026-08-06

Every code change used to reach the friend as a portable exe sent by hand. Now the app
updates itself: `scripts/dev.sh release` publishes a build to GitHub Releases, and an
installed copy notices, downloads it in the background, and swaps itself in on quit
without either person doing anything.

## What shipped

### Two artifacts from one build

`build.win.target` gained `nsis` alongside the existing `portable`, so every `dist`
produces both:

| Artifact | What it is |
|---|---|
| `EQL-DPS-Overlay-Setup-<ver>.exe` | Per-user NSIS installer (`oneClick`, `perMachine: false`) → `%LOCALAPPDATA%\Programs`. The friend-facing artifact, and the only one that can update itself |
| `EQL-DPS-Overlay-<ver>.exe` | The portable build, unchanged. Kept because the single-file property is genuinely nice |
| `latest.yml` + `.blockmap` | What a running copy reads: version, filename, the sha512 it verifies the download against, and the chunk map that makes an update a partial fetch instead of 80 MB |

The `dist` script changed from `electron-builder --win portable` to
`electron-builder --win --publish never`. This is not cosmetic: **a target named on the
CLI overrides `build.win.target` entirely**, so leaving `portable` there would have kept
producing portable-only builds no matter what the config said. `--publish never` is
explicit so no tag or CI heuristic can ever make the Windows-side build try to upload
with no token in its environment.

`build.publish` (github / `jsavko` / `eq-legends-dps-overlay`) is what bakes
`app-update.yml` into `resources/`, which is how a running copy knows where to look. The
repo is public, so there is no token in the app, in the asar, or in the build.

### Update behavior is tiered by how the copy is running

A single self-contained exe has no install location to replace — which is exactly why
electron-builder's `portable` target is unsupported by electron-updater. Rather than drop
an artifact or lie to it, `src/main/updater.js` decides at runtime:

- **`auto`** — exe under `%LOCALAPPDATA%\Programs`: download in the background,
  `autoInstallOnAppQuit`, and a toast naming the version when it lands.
- **`notify`** — `PORTABLE_EXECUTABLE_FILE` set in the environment (the only reliable
  way to know a portable run from the inside): `autoDownload = false`, check only, toast
  pointing at the releases page. Honest about what a lone exe can do, and nobody sits on
  a stale build unknowingly.
- **`off`** — everything else. This includes `win-unpacked`, which is the build James
  actually launches: it is packaged but not *installed*, so letting the updater loose on
  it would silently install a second copy into `%LOCALAPPDATA%\Programs` and leave the
  running one stale, with nothing on screen to say so.

**Install-on-quit only, no restart prompt anywhere.** The overlay is on screen during
raids by assumption; an updater that offers to restart it is an updater that will
eventually restart it at the worst possible moment.

**Update notices are meter toasts, not cast alerts.** The alerts window that shipped in
0.4.0/0.5.0 exists for combat warnings the player must react to *now*, and it floats
top-center over the game. "A new version is out" is not that, so it goes through the same
`toast()` as "Encounter reset" and history write failures.

Checks run 10 seconds after startup and every 4 hours after — sessions run long enough
that a launch-only check would miss a release cut mid-raid. Check failures (offline, rate
limit, a release mid-upload) go to the console and nowhere else: a toast per failed check
would nag through a fight about something the player cannot act on.

### `scripts/dev.sh release`

Builds on the Windows side, publishes from WSL. electron-builder could upload the
artifacts itself, but that would need a `GH_TOKEN` in the *Windows* environment; `gh` in
WSL is already authenticated and pushes the same files.

Before building it refuses to release a commit that is not on `origin` — a release tag is
a promise that the source behind it is fetchable — and it pins the tag to that exact
commit with `--target`. A duplicate tag fails the command, which is the guard we want
against re-releasing a version people may already be running.

## Files

| File | Change |
|---|---|
| `src/main/updater.js` | **New.** `updateMode()` (pure) plus the electron-updater wiring. `electron-updater` is imported *dynamically* so the mode logic stays unit-testable in WSL — a static import reaches for Electron at load time and throws outside it |
| `src/main/main.js` | Starts the updater last in `main()`, never awaited, failure logged and swallowed; stops the recurring check on `will-quit` |
| `tests/updater.test.js` | **New.** Seven cases over `updateMode`, including the win-unpacked trap and the portable marker beating the install path |
| `package.json` | `electron-updater` as the first runtime dependency; `nsis` + `portable` targets; `build.publish`; the `dist` script fix |
| `scripts/dev.sh` | `release` case, dist wording, usage |
| `CLAUDE.md` | The "depends on `electron` alone" invariant restated as what it actually is (no *native* modules); install-on-quit and the win-unpacked exclusion recorded as invariants; `dev.sh release` and the Setup artifact documented |
| `README.md` | The distribution section said "No installer" — it now explains both artifacts and which one updates itself |

## Notes

Neither build is code-signed, so the first run still shows SmartScreen's "Windows
protected your PC" → *More info* → *Run anyway*. That is once per person rather than once
per version: automatic updates arrive without the mark-of-the-web that triggers it.

The invariant that actually matters is **no native modules** — a native dependency would
need a win32 build under Windows npm *and* a linux build for the WSL test suite. That is
why history is JSONL and not SQLite, and it is untouched here: `electron-updater` is pure
JS. It costs about 7 MB in the packaged exe.
