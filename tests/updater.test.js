import test from 'node:test';
import assert from 'node:assert/strict';

import { updateMode } from '../src/main/updater.js';

/** What the per-user NSIS installer actually produces. */
const INSTALLED = 'C:\\Users\\James\\AppData\\Local\\Programs\\EQL DPS Overlay\\EQL DPS Overlay.exe';
/** Where the portable launcher extracts itself before running. */
const EXTRACTED = 'C:\\Users\\James\\AppData\\Local\\Temp\\2F9A\\EQL DPS Overlay.exe';
/** The build James launches himself — packaged, but not installed anywhere. */
const UNPACKED = 'C:\\eqoverlay-dev\\dist\\win-unpacked\\EQL DPS Overlay.exe';

test('dev runs never touch the updater', () => {
  assert.equal(updateMode({ isPackaged: false, exePath: INSTALLED }), 'off');
});

test('an NSIS install updates itself', () => {
  assert.equal(updateMode({ isPackaged: true, exePath: INSTALLED }), 'auto');
});

test('the install path check is case-insensitive and slash-agnostic', () => {
  const shouty = INSTALLED.toUpperCase();
  const unixy = INSTALLED.replace(/\\/g, '/');
  assert.equal(updateMode({ isPackaged: true, exePath: shouty }), 'auto');
  assert.equal(updateMode({ isPackaged: true, exePath: unixy }), 'auto');
});

test('a portable run only notifies', () => {
  const env = { PORTABLE_EXECUTABLE_FILE: 'D:\\Games\\EQL-DPS-Overlay-0.6.0.exe' };
  assert.equal(updateMode({ isPackaged: true, exePath: EXTRACTED, env }), 'notify');
});

test('the portable marker beats the install path', () => {
  // Whatever directory the launcher extracted into, a lone exe still cannot replace
  // itself — the environment marker is the authority, not where the copy landed.
  const env = { PORTABLE_EXECUTABLE_FILE: 'D:\\Games\\EQL-DPS-Overlay-0.6.0.exe' };
  assert.equal(updateMode({ isPackaged: true, exePath: INSTALLED, env }), 'notify');
});

test('win-unpacked is left alone', () => {
  // The dangerous case: updating here would install a second copy under Programs and
  // leave the running one stale, with nothing on screen to say so.
  assert.equal(updateMode({ isPackaged: true, exePath: UNPACKED }), 'off');
});

test('a missing exe path degrades to off rather than throwing', () => {
  assert.equal(updateMode({ isPackaged: true, exePath: undefined }), 'off');
});
