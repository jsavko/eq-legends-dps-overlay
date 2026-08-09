import test from 'node:test';
import assert from 'node:assert/strict';

import { updateMode, isNewerVersion, fetchLatestVersion } from '../src/main/updater.js';

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

// ------------------------------------------------------------------ comparing versions

test('versions compare by number, not as strings', () => {
  // The one this project will actually meet: a string compare puts "0.10.0" BELOW "0.9.0"
  // and would sit on an update forever without ever saying so.
  assert.equal(isNewerVersion('0.10.0', '0.9.0'), true);
  assert.equal(isNewerVersion('0.9.0', '0.10.0'), false);

  assert.equal(isNewerVersion('0.8.1', '0.8.0'), true);
  assert.equal(isNewerVersion('1.0.0', '0.99.99'), true);
  assert.equal(isNewerVersion('0.8.0', '0.8.0'), false, 'the same version is not an update');
});

test('a leading v and a short version are both understood', () => {
  // GitHub tags are "v0.8.0"; package.json says "0.8.0". Both reach this function.
  assert.equal(isNewerVersion('v0.9.0', '0.8.0'), true);
  assert.equal(isNewerVersion('V0.9.0', 'v0.9.0'), false);
  assert.equal(isNewerVersion('0.9', '0.8.9'), true, 'a missing field reads as zero');
  assert.equal(isNewerVersion('0.8', '0.8.0'), false);
});

test('garbage never announces an update', () => {
  // Every one of these is a real possibility from a hand-typed tag, and the safe answer
  // to "I cannot read this" is silence rather than a notice the player cannot act on.
  assert.equal(isNewerVersion('', '0.8.0'), false);
  assert.equal(isNewerVersion(undefined, '0.8.0'), false);
  assert.equal(isNewerVersion('nightly', '0.8.0'), false);
  assert.equal(isNewerVersion('0.8.0', undefined), true, 'no current version means anything is newer');
});

// -------------------------------------------------------------------- reading the feed

test('the latest version is read off the tag, with the v stripped', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ tag_name: 'v0.9.0' }) };
  };
  assert.equal(await fetchLatestVersion({ fetchImpl }), '0.9.0');

  // GitHub rejects API requests with no agent, and a bare 403 in a toast is
  // indistinguishable from being offline.
  assert.match(calls[0].init.headers['User-Agent'], /eq-legends/);
});

test('a failed check reports why rather than claiming to be up to date', async () => {
  const rateLimited = async () => ({ ok: false, status: 403 });
  await assert.rejects(() => fetchLatestVersion({ fetchImpl: rateLimited }), /403/);

  // A release that exists but names nothing is not "no update" — it is a broken feed, and
  // the two must not look the same to the caller.
  const nameless = async () => ({ ok: true, json: async () => ({}) });
  await assert.rejects(() => fetchLatestVersion({ fetchImpl: nameless }), /no tag/);
});
