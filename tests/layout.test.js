import test from 'node:test';
import assert from 'node:assert/strict';

import { clampHeight, placeWindow, MIN_HEIGHT } from '../src/main/layout.js';

/** A 1080p display with a taskbar, which is what most of this runs on. */
const AREA = { x: 0, y: 0, width: 1920, height: 1040 };

test('clampHeight passes through a height that fits', () => {
  assert.equal(clampHeight(315, AREA), 315);
});

test('clampHeight never exceeds 80% of the work area', () => {
  assert.equal(clampHeight(5000, AREA), 832);
});

test('clampHeight keeps the window a window', () => {
  assert.equal(clampHeight(1, AREA), MIN_HEIGHT);
});

test('with room below, the window stays where the player put it', () => {
  const { y, above } = placeWindow({ restingY: 80, height: 400, area: AREA });
  assert.equal(y, 80);
  assert.equal(above, false);
});

test('against the bottom, the bottom edge is anchored and the panel goes above', () => {
  // Resting at 800 with a 400px window would end at 1200, past the 1040 work area.
  const { y, above } = placeWindow({ restingY: 800, height: 400, area: AREA });
  assert.equal(y, 640);          // 1040 - 400: bottom edge exactly on the work area edge
  assert.equal(y + 400, 1040);
  assert.equal(above, true);
});

test('a window taller than the work area still starts on screen', () => {
  const { y, above } = placeWindow({ restingY: 900, height: 1200, area: AREA });
  assert.equal(y, AREA.y);
  assert.equal(above, true);
});

test('the work area origin is respected, not assumed to be zero', () => {
  // A second monitor above the primary, or a taskbar docked at the top.
  const area = { x: 0, y: -1080, width: 1920, height: 1040 };
  const { y, above } = placeWindow({ restingY: -200, height: 400, area });
  assert.equal(y, -440);         // (-1080 + 1040) - 400
  assert.equal(above, true);
});

/**
 * The regression this whole mechanism exists for.
 *
 * The old code derived the new y from the window's CURRENT y, so every open moved the
 * window up by the panel's height and closing never brought it back — over a session the
 * overlay climbed the screen, and the climb was persisted as the player's own position.
 */
test('opening and closing the panel returns the window exactly where it started', () => {
  const restingY = 800;
  const closed = 260;
  const open = 460;

  const a = placeWindow({ restingY, height: closed, area: AREA });
  const b = placeWindow({ restingY, height: open, area: AREA });
  const c = placeWindow({ restingY, height: closed, area: AREA });

  assert.deepEqual(a, c);
  assert.equal(a.y, 780);        // 1040 - 260
  assert.equal(b.y, 580);        // 1040 - 460, bottom edge unmoved
  assert.equal(a.y + closed, b.y + open);   // the bottom edge is the fixed point
});

test('repeated fits at one height are idempotent', () => {
  const args = { restingY: 900, height: 400, area: AREA };
  assert.deepEqual(placeWindow(args), placeWindow(placeWindow(args) && args));
});

test('the rows hold still: the space added above equals the panel height', () => {
  // What the renderer relies on. Bottom-anchored, the top edge rises by exactly the
  // panel's height, and the panel is drawn into that new space above the rows.
  const restingY = 900;
  const withoutPanel = placeWindow({ restingY, height: 260, area: AREA });
  const withPanel = placeWindow({ restingY, height: 460, area: AREA });
  assert.equal(withoutPanel.y - withPanel.y, 460 - 260);
});
