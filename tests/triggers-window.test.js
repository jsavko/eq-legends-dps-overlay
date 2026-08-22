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

/** The script's CODE, comments stripped — for the same reason as `markup` above: the
 *  comment in triggers.js that explains why `window.prompt` is gone names it, and a
 *  comment naming a call is not a call. */
const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');

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

test('New pack asks for a name in a way this runtime can actually draw', () => {
  // Electron implements alert and confirm and NOT prompt: the call returns without ever
  // showing a dialog, so the name came back null, the guard beneath it returned, and the
  // channel was never reached. The existing assertion above — that `window.api.createPack`
  // appears in the file — passed the whole time the button was dead, because a string
  // being present says nothing about the code around it being able to run.
  assert.doesNotMatch(code, /window\.prompt/,
    'window.prompt is a no-op in Electron — a control that uses it does nothing');

  for (const id of ['newpack', 'np-name', 'np-create', 'np-cancel', 'np-hint']) {
    assert.ok(idsInHtml.has(id), `the naming dialog is missing #${id}`);
  }
  // ...and the same failure class one level down. The naming ask must NOT depend on the
  // dialog's `close` event to deliver its answer: measured on Electron 33, an occluded
  // window closes the dialog and dispatches no `close` at all (no rendering updates, so no
  // requestAnimationFrame either), which would leave the click handler awaiting forever —
  // the same button doing nothing, in a different costume. The buttons settle it; the
  // events are the backup that catches Escape.
  assert.match(script, /settlePackName\(name\);\s*\n\s*\$\('newpack'\)\.close\(\)/,
    'Create must settle the ask itself rather than leave it to the close event');
  assert.match(script, /\$\('newpack'\)\.addEventListener\('cancel'/,
    'Escape must still settle the pending ask');
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
