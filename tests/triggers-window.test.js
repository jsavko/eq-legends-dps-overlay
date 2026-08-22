/**
 * The Triggers window's markup and its script, checked against each other.
 *
 * The same class of check `preload-channels.test.js` makes, for the same reason: an id
 * that exists in one file and not the other fails silently. `$('i-author')` after the
 * button was renamed returns null, the listener is never attached, and the only symptom is
 * a control that does nothing — which is exactly the failure this whole change is about.
 *
 * Static source reading rather than a DOM: the renderer needs Electron to run and this
 * suite deliberately does not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { builtinPack } from '../src/main/builtin-pack.js';
import { DEFAULTS } from '../src/main/config.js';

const DIR = path.join(import.meta.dirname, '..', 'src', 'renderer', 'triggers');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(DIR, 'triggers.js'), 'utf8');
const css = fs.readFileSync(path.join(DIR, 'triggers.css'), 'utf8');

const idsInHtml = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
const idsUsed = [...new Set([...script.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];

/** What the window actually renders. The comments explain what was REMOVED and why, and
 *  a check for absent wording has to be able to tell the two apart. */
const markup = html.replace(/<!--[\s\S]*?-->/g, '');

test('every id the script reaches for exists in the markup', () => {
  assert.ok(idsUsed.length > 20, 'expected to find the script’s element lookups');
  for (const id of idsUsed) {
    assert.ok(idsInHtml.has(id), `triggers.js uses #${id}, which index.html does not define`);
  }
});

test('the "curated, not a pattern" dialog is gone, and its replacement is wired', () => {
  // The callout was the last word of the old dialog and it was simply untrue: these ARE
  // patterns. Its removal is the point of the change, so nothing may quietly restore it.
  assert.doesNotMatch(markup, /Curated, not a pattern/i);
  assert.doesNotMatch(markup, /i-author/, 'the old "write my own instead" button is gone');
  assert.match(script, /i-start-from/, 'the recipe hand-off is wired');

  for (const id of ['i-how-wrap', 'i-lines', 'i-spells', 'i-catches', 'i-pattern', 'i-show', 'i-gaps']) {
    assert.ok(idsInHtml.has(id), `the rebuilt dialog is missing #${id}`);
  }
});

test('the New buttons are reachable from the window’s default state', () => {
  // The built-in pack is the selection every time this window opens, and `+ New trigger`
  // used to be hidden on exactly that selection — so the default view had no way to make
  // anything at all.
  assert.doesNotMatch(script, /\$\('new-trigger'\)\.hidden/,
    'the New trigger button must never be hidden by the selection again');
  assert.ok(idsInHtml.has('new-pack'), 'the rail footer has no New pack button');
  assert.match(script, /window\.api\.createPack/, 'New pack is not wired to the channel');
});

test('a built-in row shows the same pattern block an imported trigger does', () => {
  // The symmetry is the change. Both use `.row-pattern`; if the class were ever renamed on
  // one side the two would drift apart again without anything failing.
  assert.match(css, /\.row-pattern\s*\{/);
  assert.match(script, /'row-pattern'/);

  // ...and every row must actually have one to show, or the block renders empty.
  for (const row of builtinPack(DEFAULTS).rows) {
    if (row.kind === 'option') continue;
    assert.ok(row.pattern, `${row.key} has no pattern to show under its name`);
  }
});

test('the editor can file a trigger into a group, new or existing', () => {
  assert.ok(idsInHtml.has('e-group') && idsInHtml.has('e-new-group'));
  assert.match(script, /newGroupName/, 'the form does not carry a new group name');
  assert.match(script, /groupId/, 'the form does not carry a group id');
});

test('the editor can send a countdown to a panel, new or existing', () => {
  // The same shape as the group control above and for the same reason — the list is the
  // player's and has no fixed length, so a select and a name field rather than a pair of
  // buttons. A missing id here is a control that silently does nothing.
  assert.ok(idsInHtml.has('e-panel') && idsInHtml.has('e-new-panel'));
  assert.ok(idsInHtml.has('e-panel-wrap'), 'the DRAWS IN field has nothing to hide');
  assert.match(script, /newPanelName/, 'the form does not carry a new panel name');
  assert.match(script, /panel: d\.panel/, 'the form does not carry the panel through to save');
  assert.match(script, /ensurePanel/, 'a panel named in the editor is never created');
});

test('the panels dialog can rename, switch and remove — and refuses a removal that orphans', () => {
  for (const id of ['open-panels', 'panels', 'p-rows', 'p-new', 'p-add', 'p-close']) {
    assert.ok(idsInHtml.has(id), `the panels dialog is missing #${id}`);
  }
  // Delete is offered only when nothing points at the panel. A panel holding countdowns
  // can always be switched OFF, which takes it off the screen and moves nobody's
  // triggers; deleting it would have to send them to the boss window, which is the exact
  // outcome this whole feature exists to prevent.
  assert.match(script, /remove\.disabled = used > 0/,
    'a panel with timers in it must not be removable');
  assert.match(script, /countByPanel/, 'nothing counts what points at a panel');
});

test('a trigger row says which panel it draws in, including when that panel cannot draw', () => {
  // "Why is this not on my screen" is the question the whole feature turns on, and having
  // to open every trigger to answer it would be the list refusing to say.
  assert.match(script, /panelLabel/);
  assert.match(script, /'panel removed'/, 'a dangling panel reference says so');
  assert.match(css, /\.row-panel\s*\{/, 'the label has no style to draw with');
  assert.match(css, /\.row-panel\.off\s*\{/, 'a dark panel is not marked');
});

test('"Measure my timers" is wired all the way to the channel', () => {
  // The durations cannot come from anywhere but the player's own log — buff length
  // depends on their level, the rank they cast and their AAs — so this path is the
  // feature, not a convenience on top of it.
  assert.ok(idsInHtml.has('measure'));
  assert.match(script, /window\.api\.mineBuffs/);
  assert.match(script, /openMeasureReport/);
});
