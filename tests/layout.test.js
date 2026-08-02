import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampHeight,
  clampWidth,
  placeWindow,
  MIN_HEIGHT,
  MIN_WIDTH,
} from '../src/main/layout.js';

/** A 1080p display with a taskbar, which is what most of this runs on. */
const AREA = { x: 0, y: 0, width: 1920, height: 1040 };

/** The default overlay position: hugging the right edge of the screen. */
const RESTING = { restingX: 1540, restingY: 80 };

test('clampHeight passes through a height that fits', () => {
  assert.equal(clampHeight(315, AREA), 315);
});

test('clampHeight never exceeds 80% of the work area while resting', () => {
  assert.equal(clampHeight(5000, AREA), 832);
});

test('clampHeight allows the full work area while the panel is open', () => {
  assert.equal(clampHeight(5000, AREA, { panelOpen: true }), 1040);
  // A height that fits is untouched either way.
  assert.equal(clampHeight(315, AREA, { panelOpen: true }), 315);
});

test('closing the panel brings the ceiling back down to 80%', () => {
  const open = clampHeight(1000, AREA, { panelOpen: true });
  const closed = clampHeight(1000, AREA, { panelOpen: false });
  assert.equal(open, 1000);
  assert.equal(closed, 832);
});

test('clampHeight keeps the window a window', () => {
  assert.equal(clampHeight(1, AREA), MIN_HEIGHT);
});

test('clampWidth passes through a width that fits', () => {
  assert.equal(clampWidth(500, AREA, { minWidth: 360 }), 500);
});

test('clampWidth never narrows below the resting width', () => {
  // Hovering may widen the overlay, never shrink it.
  assert.equal(clampWidth(100, AREA, { minWidth: 360 }), 360);
});

test('clampWidth caps at the work area', () => {
  assert.equal(clampWidth(5000, AREA, { minWidth: 360 }), 1920);
});

test('clampWidth floors at MIN_WIDTH when no resting width is known', () => {
  assert.equal(clampWidth(1, AREA), MIN_WIDTH);
});

test('with room below, the window stays where the player put it', () => {
  const { x, y, above } = placeWindow({ ...RESTING, width: 360, height: 400, area: AREA });
  assert.equal(x, RESTING.restingX);
  assert.equal(y, 80);
  assert.equal(above, false);
});

test('against the bottom, the bottom edge is anchored and the panel goes above', () => {
  // Resting at 800 with a 400px window would end at 1200, past the 1040 work area.
  const { y, above } = placeWindow({ ...RESTING, restingY: 800, width: 360, height: 400, area: AREA });
  assert.equal(y, 640);          // 1040 - 400: bottom edge exactly on the work area edge
  assert.equal(y + 400, 1040);
  assert.equal(above, true);
});

test('a window taller than the work area still starts on screen', () => {
  const { y, above } = placeWindow({ ...RESTING, restingY: 900, width: 360, height: 1200, area: AREA });
  assert.equal(y, AREA.y);
  assert.equal(above, true);
});

test('a width that fits grows rightward from the resting left edge', () => {
  const { x } = placeWindow({ restingX: 500, restingY: 80, width: 700, height: 400, area: AREA });
  assert.equal(x, 500);
});

test('against the right edge, the right edge is anchored and the window grows left', () => {
  // The default position: resting right edge on the work area edge, so any widening
  // has to go leftward.
  const { x } = placeWindow({ restingX: 1540, restingY: 80, width: 700, height: 400, area: AREA });
  assert.equal(x, 1220);         // 1920 - 700: right edge held on the work area edge
  assert.equal(x + 700, 1920);
});

test('a window wider than the work area still starts on screen', () => {
  const { x } = placeWindow({ restingX: 1540, restingY: 80, width: 2500, height: 400, area: AREA });
  assert.equal(x, AREA.x);
});

test('the work area origin is respected, not assumed to be zero', () => {
  // A second monitor above and to the left of the primary.
  const area = { x: -1920, y: -1080, width: 1920, height: 1040 };
  const { x, y, above } = placeWindow({
    restingX: -400, restingY: -200, width: 700, height: 400, area,
  });
  assert.equal(y, -440);         // (-1080 + 1040) - 400
  assert.equal(above, true);
  assert.equal(x, -700);         // (-1920 + 1920) - 700: right edge on the area edge
});

/**
 * The regression this whole mechanism exists for — now in both axes.
 *
 * The old code derived the new position from the window's CURRENT bounds, so every open
 * moved the window and closing never brought it back — over a session the overlay
 * climbed the screen, and the climb was persisted as the player's own position. The
 * horizontal twin is the same failure sideways: auto-widening from current bounds would
 * walk the window left a panel-width per hover.
 */
test('opening and closing the panel returns the window exactly where it started', () => {
  const resting = { restingX: 1540, restingY: 800 };
  const closed = { width: 380, height: 260 };
  const open = { width: 700, height: 460 };

  const a = placeWindow({ ...resting, ...closed, area: AREA });
  const b = placeWindow({ ...resting, ...open, area: AREA });
  const c = placeWindow({ ...resting, ...closed, area: AREA });

  assert.deepEqual(a, c);
  assert.equal(a.y, 780);        // 1040 - 260
  assert.equal(b.y, 580);        // 1040 - 460, bottom edge unmoved
  assert.equal(a.y + closed.height, b.y + open.height);   // bottom edge is the fixed point
  assert.equal(a.x + closed.width, b.x + open.width);     // and so is the right edge
});

test('repeated fits at one size are idempotent', () => {
  const args = { ...RESTING, restingY: 900, width: 360, height: 400, area: AREA };
  assert.deepEqual(placeWindow(args), placeWindow(placeWindow(args) && args));
});

test('the rows hold still: the space added above equals the panel height', () => {
  // What the renderer relies on. Bottom-anchored, the top edge rises by exactly the
  // panel's height, and the panel is drawn into that new space above the rows.
  const restingY = 900;
  const withoutPanel = placeWindow({ ...RESTING, restingY, width: 360, height: 260, area: AREA });
  const withPanel = placeWindow({ ...RESTING, restingY, width: 360, height: 460, area: AREA });
  assert.equal(withoutPanel.y - withPanel.y, 460 - 260);
});
