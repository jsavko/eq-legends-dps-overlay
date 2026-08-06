#!/usr/bin/env bash
#
# Sync the WSL source tree to the Windows side and drive the Windows npm there.
#
# Why this exists: the source of truth is edited in WSL, but the overlay has to run as
# a native Windows process to float over the game. Running Electron straight from
# \\wsl.localhost\... works but is slow and occasionally trips Chromium's sandbox on a
# UNC path, so the tree is mirrored to a real NTFS path instead.
#
# node_modules is deliberately NOT synced: `npm install` must run on the Windows side
# so it fetches the win32 Electron binary rather than the linux one.
#
# Usage:
#   scripts/dev.sh            sync, install if needed, then start the overlay
#   scripts/dev.sh sync       sync only
#   scripts/dev.sh install    sync, then force a fresh npm install
#   scripts/dev.sh test       run the test suite in WSL (no sync needed)
#   scripts/dev.sh dist       sync, then build the Setup installer and the portable .exe
#   scripts/dev.sh release    dist, then publish the build as a GitHub release
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WIN_DIR="/mnt/c/eqoverlay-dev"
WIN_PATH='C:\eqoverlay-dev'
NPM='/mnt/c/Program Files/nodejs/npm.cmd'
REPO='jsavko/eq-legends-dps-overlay'

command -v rsync >/dev/null || { echo "rsync is required: sudo apt install rsync"; exit 1; }
[ -x "$NPM" ] || { echo "Windows npm not found at $NPM"; exit 1; }

sync_tree() {
  mkdir -p "$WIN_DIR"
  rsync -a --delete \
    --exclude 'node_modules/' \
    --exclude '.git/' \
    --exclude 'dist/' \
    --exclude 'unknown-lines.txt' \
    "$SRC/" "$WIN_DIR/"
  echo "synced -> $WIN_PATH"
}

# cmd.exe insists on a Windows working directory, so every npm call is wrapped in a
# `cd` executed by cmd itself rather than by this shell.
win_npm() {
  ( cd "$WIN_DIR" && cmd.exe /c "cd /d $WIN_PATH && npm.cmd $*" )
}

case "${1:-start}" in
  sync)
    sync_tree
    ;;
  install)
    sync_tree
    win_npm install
    ;;
  test)
    cd "$SRC" && npm test
    ;;
  dist)
    sync_tree
    [ -d "$WIN_DIR/node_modules" ] || win_npm install
    win_npm run dist
    echo "installer + portable exe -> $WIN_PATH\\dist"
    ;;
  release)
    # Build on the Windows side, publish from WSL. electron-builder could upload the
    # artifacts itself, but that would need a GH_TOKEN in the *Windows* environment;
    # `gh` over here is already authenticated and pushes the same files.
    sync_tree
    [ -d "$WIN_DIR/node_modules" ] || win_npm install

    command -v gh >/dev/null || { echo "gh CLI is required to publish a release"; exit 1; }
    ver="$(cd "$SRC" && node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")"
    commit="$(git -C "$SRC" rev-parse HEAD)"

    # A release tag is a promise that this source is fetchable. Refuse to make that
    # promise about a commit that exists only in this checkout.
    git -C "$SRC" fetch --quiet origin || echo "warning: could not reach origin; the push check may be stale"
    if ! git -C "$SRC" branch -r --contains "$commit" --list 'origin/*' | grep -q .; then
      echo "HEAD ($commit) is not on origin — push it, then release."
      exit 1
    fi

    win_npm run dist

    setup="$WIN_DIR/dist/EQL-DPS-Overlay-Setup-$ver.exe"
    portable="$WIN_DIR/dist/EQL-DPS-Overlay-$ver.exe"
    # latest.yml is what a running copy actually reads: version, filename and the sha512
    # electron-updater verifies the download against. The .blockmap next to the installer
    # is what lets it fetch only the changed chunks instead of 80 MB every time.
    assets=("$setup" "$setup.blockmap" "$WIN_DIR/dist/latest.yml" "$portable")
    for f in "${assets[@]}"; do
      [ -f "$f" ] || { echo "missing release asset: $f"; exit 1; }
    done

    # A duplicate tag fails here, which is the guard we want against re-releasing a
    # version that people may already be running.
    gh release create "v$ver" \
      --repo "$REPO" \
      --target "$commit" \
      --title "v$ver" \
      --generate-notes \
      "${assets[@]}"
    echo "released v$ver -> https://github.com/$REPO/releases/tag/v$ver"
    ;;
  start)
    sync_tree
    [ -d "$WIN_DIR/node_modules" ] || win_npm install
    win_npm start
    ;;
  *)
    echo "usage: scripts/dev.sh [sync|install|test|dist|release|start]"
    exit 1
    ;;
esac
