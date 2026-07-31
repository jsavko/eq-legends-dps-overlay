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
#   scripts/dev.sh dist       sync, then build the portable .exe
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WIN_DIR="/mnt/c/eqoverlay-dev"
WIN_PATH='C:\eqoverlay-dev'
NPM='/mnt/c/Program Files/nodejs/npm.cmd'

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
    echo "portable exe -> $WIN_PATH\\dist"
    ;;
  start)
    sync_tree
    [ -d "$WIN_DIR/node_modules" ] || win_npm install
    win_npm start
    ;;
  *)
    echo "usage: scripts/dev.sh [sync|install|test|dist|start]"
    exit 1
    ;;
esac
