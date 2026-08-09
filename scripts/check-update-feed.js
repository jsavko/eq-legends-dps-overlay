#!/usr/bin/env node
/**
 * Check the live update feed, and say what each kind of copy would do with it.
 *
 * This exists because "the auto-updater isn't working" is nearly impossible to tell apart
 * from "the auto-updater is working and has nothing to do". Both look identical from the
 * outside: no toast, no download, nothing. This script separates them by fetching exactly
 * what electron-updater fetches and reporting every step.
 *
 * It deliberately reads and prints only. It cannot download or install anything, so it is
 * safe to run mid-raid.
 *
 *   node scripts/check-update-feed.js
 *   node scripts/check-update-feed.js --as 0.7.0    # pretend to be an older build
 *
 * The two things worth knowing before reading the output:
 *
 *   - `win-unpacked` — the build launched from `dist\win-unpacked` — is mode `off` BY
 *     DESIGN and never runs the updater at all. It is packaged but not installed, so
 *     "updating" it would install a second copy under %LOCALAPPDATA%\Programs and leave
 *     the running one untouched. See `src/main/updater.js`.
 *   - Only the NSIS-installed copy self-updates. The portable exe checks and tells you.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  updateMode, isNewerVersion, fetchLatestVersion, RELEASES_URL, RELEASES_API,
} from '../src/main/updater.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

/** The feed file electron-updater actually parses, as opposed to the API the tray uses. */
const FEED_URL = 'https://github.com/jsavko/eq-legends-dps-overlay/releases/latest/download/latest.yml';

const args = process.argv.slice(2);
const asIndex = args.indexOf('--as');
const claimedVersion = asIndex >= 0 ? args[asIndex + 1] : PKG.version;

/** The three exe locations, and what each one earns. Pure — no files are touched. */
const COPIES = [
  {
    what: 'installed (NSIS setup)',
    exePath: 'C:\\Users\\James\\AppData\\Local\\Programs\\eq-legends-dps-overlay\\EQL DPS Overlay.exe',
    env: {},
  },
  {
    what: 'portable exe',
    exePath: 'C:\\Downloads\\EQL-DPS-Overlay-0.8.0.exe',
    env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Downloads\\EQL-DPS-Overlay-0.8.0.exe' },
  },
  {
    what: 'win-unpacked (what dev.sh dist builds)',
    exePath: 'C:\\eqoverlay-dev\\dist\\win-unpacked\\EQL DPS Overlay.exe',
    env: {},
  },
];

const DOES = {
  auto: 'downloads in the background, installs on quit',
  notify: 'checks and tells you; cannot replace itself',
  off: 'never checks — deliberately',
};

async function main() {
  console.log(`This build is v${PKG.version}` +
    (claimedVersion === PKG.version ? '' : `, checking as if it were v${claimedVersion}`));

  console.log('\nWhat each copy does with the feed:');
  for (const copy of COPIES) {
    const mode = updateMode({ isPackaged: true, exePath: copy.exePath, env: copy.env });
    console.log(`  ${copy.what.padEnd(38)} ${mode.padEnd(7)} ${DOES[mode]}`);
  }

  // ---------------------------------------------------------------- the release API
  console.log(`\nGitHub releases API  ${RELEASES_API}`);
  let latest = null;
  try {
    latest = await fetchLatestVersion();
    console.log(`  latest published release: v${latest}`);
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
    console.log('  (the tray\'s "Check for updates" would report exactly this)');
  }

  // ------------------------------------------------------- the electron-updater feed
  console.log(`\nelectron-updater feed  ${FEED_URL}`);
  try {
    const res = await fetch(FEED_URL, { headers: { 'User-Agent': 'eq-legends-dps-overlay' } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const yml = await res.text();
    const field = (name) => (yml.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1] ?? '').trim();
    const feedVersion = field('version');
    const file = field('path');
    console.log(`  version: ${feedVersion || '(missing!)'}`);
    console.log(`  installer: ${file || '(missing!)'}`);
    console.log(`  sha512: ${field('sha512') ? 'present' : 'MISSING — electron-updater will refuse it'}`);

    // The failure that actually bites: a release whose latest.yml disagrees with its tag.
    if (latest && feedVersion && feedVersion !== latest) {
      console.log(`  MISMATCH: the tag says v${latest} and latest.yml says v${feedVersion}.`);
      console.log('  electron-updater trusts latest.yml, so it would offer the second one.');
    }
    if (file && !/Setup/i.test(file)) {
      console.log('  WARNING: the feed points at something other than the Setup installer.');
      console.log('  Only the NSIS installer can be applied by the updater.');
    }
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
  }

  // --------------------------------------------------------------------- the verdict
  console.log('');
  if (!latest) {
    console.log('VERDICT: could not reach GitHub, so nothing can be concluded about the');
    console.log('updater itself. Check the network and run this again.');
  } else if (isNewerVersion(latest, claimedVersion)) {
    console.log(`VERDICT: v${latest} is newer than v${claimedVersion}. An INSTALLED copy would`);
    console.log('download it now and install it on quit. A portable copy would say so.');
    console.log(`win-unpacked would do nothing — get it from ${RELEASES_URL}`);
  } else {
    console.log(`VERDICT: v${claimedVersion} is the newest there is, so a working updater has`);
    console.log('nothing to do and will show nothing. This is indistinguishable from a broken');
    console.log('one by watching the app — which is what this script is for.');
    console.log('\nTo see the whole path run for real, launch with an older version claimed:');
    console.log('  EQL_UPDATE_TEST_VERSION=0.7.0 "…/EQL DPS Overlay.exe"');
    console.log('then use the tray\'s "Check for updates". The footer notice, the tray entry');
    console.log('and the toast all behave exactly as they will on release day.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
