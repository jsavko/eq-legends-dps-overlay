/**
 * The Timers window's markup and its script, checked against each other.
 *
 * The same check the Triggers window gets, for the same reason: `$('look-widht')`
 * returns null, the listener is never attached, and the only symptom is a control that
 * does nothing. The size sliders make that worse than usual — their ids are BUILT from
 * the model's own field names (`look-${field}`), so a field renamed in `model.js` breaks
 * three controls at once and the literal-id check below would not see it. That is why
 * the second test walks `LOOK` rather than the script.
 *
 * Static source reading rather than a DOM: the renderer needs Electron to run and this
 * suite deliberately does not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { LOOK } from '../src/timers/model.js';

const DIR = path.join(import.meta.dirname, '..', 'src', 'renderer', 'timersetup');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(DIR, 'timersetup.js'), 'utf8');

const idsInHtml = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
const idsUsed = [...new Set([...script.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];

test('every id the script reaches for exists in the markup', () => {
  assert.ok(idsUsed.length > 15, 'expected to find the script’s element lookups');
  for (const id of idsUsed) {
    assert.ok(idsInHtml.has(id), `timersetup.js uses #${id}, which index.html does not define`);
  }
});

test('every size the model can hold has a control and a readout', () => {
  for (const field of Object.keys(LOOK)) {
    assert.ok(idsInHtml.has(`look-${field}`), `no slider for the box's ${field}`);
    assert.ok(idsInHtml.has(`look-${field}-out`), `no readout for the box's ${field}`);
  }
  // The script must ask for all three by name, or a field could gain a control here and
  // never be read from it.
  for (const field of Object.keys(LOOK)) {
    assert.ok(script.includes(`'${field}'`), `timersetup.js never names the ${field} field`);
  }
});

test('the size strip is drawn for every box, including the built-in one', () => {
  // The pane has to sit on the same pixel whichever box is selected — that no-reflow rule
  // is why this window exists in the shape it does. `renderContents` returns early for
  // the built-in box, so the strip has to be written BEFORE that return or the boss box
  // would show a shorter header than every other box.
  const body = script.slice(script.indexOf('function renderContents('));
  const drawn = body.indexOf('renderLook(');
  const bail = body.indexOf('if (category.builtin) return;');
  assert.ok(drawn > -1 && bail > -1, 'expected renderContents to draw the strip and bail for the built-in box');
  assert.ok(drawn < bail, 'the size strip must be written before the built-in box bails out');

  assert.doesNotMatch(script, /\$\('look'\)\.hidden/, 'the size strip must never be hidden');
});

test('a box can take another box\'s size', () => {
  // Matching two boxes by eye means dragging three sliders to numbers you cannot read
  // off the other box, which is a thing people try and quietly fail at.
  assert.ok(idsInHtml.has('look-copy'), 'no "copy size from" control');
  const body = script.slice(script.indexOf("$('look-copy').addEventListener"));
  assert.match(body.slice(0, 600), /state\.model\.categories\.find/, 'the copy is not read off a real box');
  assert.match(body.slice(0, 600), /onLookInput\(\)/, 'the copied size is never applied');
  // Its own list must never include the box it would copy into.
  assert.match(script, /filter\(\(c\) => c\.id !== category\.id\)/,
    'the box being sized must not offer to copy from itself');
});

test('dragging a size slider puts the box it sizes on screen', () => {
  // A box with nothing running draws nothing at all: the window shrinks to nothing and
  // parks off-screen. Sizing one between pulls would be done blind without this, which
  // is the whole reason the controls are inline rather than behind a modal.
  const body = script.slice(script.indexOf('function onLookInput('));
  assert.match(body.slice(0, body.indexOf('\n}')), /showBox\(/);
  assert.match(script, /function showBox[\s\S]*?window\.api\s*\n?\s*\.preview\(/,
    'showBox must raise a preview row in that box');
});
