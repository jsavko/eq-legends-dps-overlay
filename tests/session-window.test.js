/**
 * The session line and the SESSION settings section, checked against their scripts.
 *
 * Same class of check as `triggers-window.test.js` and `preload-channels.test.js`, for
 * the same reason: an id that exists in one file and not the other fails silently.
 * `$('session-coin')` after a rename returns null, the checkbox is never filled or read,
 * and the only symptom is a setting that quietly does nothing.
 *
 * Static source reading rather than a DOM: these renderers need Electron and this suite
 * deliberately does not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { SESSION_CATEGORIES, DEFAULTS } from '../src/main/config.js';
import { CHANNELS } from '../src/main/ipc.js';

const RENDERER = path.join(import.meta.dirname, '..', 'src', 'renderer');
const read = (...p) => fs.readFileSync(path.join(RENDERER, ...p), 'utf8');

const setupHtml = read('setup', 'index.html');
const setupJs = read('setup', 'setup.js');
const overlayHtml = read('overlay', 'index.html');
const overlayJs = read('overlay', 'overlay.js');
const overlayCss = read('overlay', 'overlay.css');

const idsIn = (html) => new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
const idsUsedBy = (js) => [...new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];

// ------------------------------------------------------------ the settings section

test('every session id the settings script reaches for exists in the markup', () => {
  const ids = idsIn(setupHtml);
  for (const id of idsUsedBy(setupJs)) {
    assert.ok(ids.has(id), `setup.js uses #${id}, which index.html does not define`);
  }
});

test('all seven categories have a checkbox, named by the convention', () => {
  const ids = idsIn(setupHtml);
  for (const c of SESSION_CATEGORIES) {
    assert.ok(ids.has(`session-${c}`), `no checkbox for the ${c} category`);
  }
  assert.ok(ids.has('session-enabled'), 'no master switch');
  assert.ok(ids.has('session-meter-line'), 'no meter-line switch');
});

test('the settings script restates exactly the seven categories config exports', () => {
  // Restated rather than imported because this renderer cannot reach config.js (it pulls
  // in `fs`). This is the check that the two copies still agree.
  const listed = /const SESSION_CATEGORIES = \[([^\]]+)\]/.exec(setupJs);
  assert.ok(listed, 'setup.js no longer declares its category list');
  const names = [...listed[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(names, [...SESSION_CATEGORIES]);
});

test('the form writes the session block whole, master and categories together', () => {
  assert.match(setupJs, /session:\s*\{/, 'save() does not write a session block');
  assert.match(setupJs, /enabled:\s*\$\('session-enabled'\)\.checked/);
  assert.match(setupJs, /meterLine:\s*\$\('session-meter-line'\)\.checked/);
});

test('the categories grey out with the master rather than disappearing', () => {
  // Disabled, not hidden: a player asking "can this record loot" needs to see that it
  // can and currently is not. A section that vanishes answers neither half.
  assert.match(setupJs, /function syncSessionEnabled/);
  assert.match(setupJs, /\.disabled = !on/);
  assert.match(overlayCss.length ? read('setup', 'setup.css') : '', /\.session-grid/);
});

test('the alert switches did not come back with it', () => {
  // The SESSION section lives in this form and the ALERTS one deliberately does not.
  // That is not inconsistency: alerts had two screens writing one set of keys, and a
  // Save here would clobber what the Triggers window had just set. Sessions have one.
  const markup = setupHtml.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(markup, /id="cast-alerts"/);
  assert.doesNotMatch(setupJs, /castAlerts:/);
  assert.doesNotMatch(setupJs, /triggerTimers:/);
});

// ------------------------------------------------------------- the meter session line

test('the session line sits between the readout and the rows', () => {
  const lineAt = overlayHtml.indexOf('id="session-line"');
  const readoutAt = overlayHtml.indexOf('class="head-line readout"');
  const rowsAt = overlayHtml.indexOf('<ol id="rows">');
  assert.ok(lineAt > readoutAt, 'the session line must come after the DPS readout');
  assert.ok(lineAt < rowsAt, 'the session line must come before the group rows');
});

test('the line is hidden, not emptied, when it has nothing to say', () => {
  // `hidden` is load-bearing: measureContentHeight skips hidden children, so an absent
  // line costs the window exactly zero height. An empty div would still take its padding
  // and borders, and the overlay pays for every pixel it takes from the game.
  assert.match(overlayHtml, /id="session-line" hidden/);
  assert.match(overlayJs, /els\.sessionLine\.hidden = true/);
});

test('both switches gate the line, and the renderer keeps its own copy', () => {
  assert.match(overlayJs, /config\.session\?\.enabled === true && config\.session\?\.meterLine === true/);
  assert.match(overlayJs, /if \(!sessionLineOn \|\| !session\)/);
});

test('overflow drops whole stats rather than clipping or scrolling', () => {
  // The invariant this window is built around: it cannot scroll — it ignores mouse input
  // so the game keeps every click, so the wheel never reaches it. An ellipsis would turn
  // "1038p" into "10…", which reads as a smaller number rather than an absent one.
  assert.match(overlayJs, /function dropOverflowingStats/);
  assert.match(overlayJs, /lastElementChild\.remove\(\)/);

  const block = /#session-line \{[\s\S]*?\n\}/.exec(overlayCss);
  assert.ok(block, 'the session line has no style block');
  assert.doesNotMatch(block[0], /overflow/, 'the line must not solve overflow with CSS');
  assert.doesNotMatch(block[0], /text-overflow/);
  assert.doesNotMatch(block[0], /max-height/);
});

test('the line renders through the same fit path as everything else', () => {
  // It is a child of #slab, so measureContentHeight includes it and main owns the
  // resulting bounds. Deriving placement in the renderer is the "window climbs the
  // screen" bug class.
  assert.match(overlayJs, /renderSessionLine\(snap\.session \?\? null\);/);
  const renderAt = overlayJs.indexOf('renderSessionLine(snap.session');
  const fitAt = overlayJs.indexOf('  fitWindow();\n}');
  assert.ok(renderAt < fitAt, 'the line must be rendered before the window is measured');
});

test('the session summary crosses IPC as a scalar bag, never a list', () => {
  // Four times a second. Every browse-time shape — every creature, item and faction — is
  // fetched by name when the Session window asks for it.
  assert.ok(CHANNELS.SESSION_CURRENT, 'no channel for the session in flight');
  assert.ok(CHANNELS.SESSION_LIST && CHANNELS.SESSION_GET);
  assert.equal(DEFAULTS.session.meterLine, false, 'the line must ship off');
});

// ------------------------------------------------------------------ the Session window

const sessionHtml = read('session', 'index.html');
const sessionJs = read('session', 'session.js');
const sessionCss = read('session', 'session.css');

test('every id the session script reaches for exists in its markup', () => {
  const ids = idsIn(sessionHtml);
  const used = idsUsedBy(sessionJs);
  assert.ok(used.length > 10, 'expected to find the script’s element lookups');
  for (const id of used) {
    assert.ok(ids.has(id), `session.js uses #${id}, which index.html does not define`);
  }
});

test('the window is three fixed panes, and nothing in it reflows', () => {
  // The reason this is its own window rather than a fourth mode of History: every click
  // swaps content INSIDE a pane. A grid with three named areas is what pins that.
  assert.match(sessionCss, /grid-template-areas:\s*\n?\s*"titlebar titlebar titlebar"/);
  assert.match(sessionCss, /"rail\s+summary\s+detail"/);
  // Panes scroll internally, which is fine here — only the click-through windows may not.
  assert.match(sessionCss, /section \{[\s\S]*?overflow-y: auto/);
});

test('the deaths line renders always, in both the rail and the summary', () => {
  // A line that appears only on death-sessions shifts every row below it by its own
  // height. That is the failure the History window already fixed once.
  assert.match(sessionJs, /'no deaths'/);
  assert.match(sessionCss, /\.row-deaths\[data-had="true"\]/);
});

test('the detail pane promises the whole list and says so', () => {
  assert.match(sessionJs, /view\.rows\.map/);
  assert.doesNotMatch(sessionJs, /\.slice\(0,\s*\d+\)/, 'no top-N slice anywhere in the view');
  assert.doesNotMatch(sessionJs, /\+\d+ more/);
});

test('the Import a log button exists and is wired to the channel', () => {
  assert.ok(idsIn(sessionHtml).has('import'));
  assert.match(sessionJs, /window\.api\.sessionImport\(\)/);
  assert.ok(CHANNELS.SESSION_IMPORT);
});

test('an appended session reaches an open window', () => {
  // A session closes after an hour of silence. Without this the rail would be frozen at
  // whatever moment it was opened, missing exactly the session the player came to read.
  assert.match(sessionJs, /window\.api\.onSessionAppended/);
  assert.ok(CHANNELS.SESSION_APPENDED);
});

test('the window wears the overlay palette, not the settings slate', () => {
  assert.match(sessionCss, /--bg:\s*#100d0a/);
  assert.match(sessionCss, /--ink:\s*#f0e3c4/);
});
