/**
 * Where the auto-fitted overlay window goes.
 *
 * Split out of main.js and kept free of Electron so the geometry can be unit-tested: it
 * is the kind of arithmetic that is obviously right until the window is near an edge, on
 * a second monitor, or taller than the screen.
 */

/** Never let auto-fit eat the whole display. */
export const MAX_HEIGHT_FRACTION = 0.8;
/** Below this the window is not a window. */
export const MIN_HEIGHT = 70;

/**
 * Clamp a requested content height to something that fits the display.
 *
 * @param {number} height  what the renderer measured
 * @param {{height: number}} area  the display's work area
 */
export function clampHeight(height, area) {
  const max = Math.floor(area.height * MAX_HEIGHT_FRACTION);
  return Math.max(MIN_HEIGHT, Math.min(Math.round(height), max));
}

/**
 * Decide the window's vertical placement, and which side the breakdown opens on.
 *
 * Normally the top edge stays at `restingY` and the window grows downward. When that
 * would run off the bottom of the work area, the BOTTOM edge is anchored there instead
 * and the panel is reported as opening 'above' — the renderer then draws it between the
 * header and the rows, so the rows do not move under the cursor that opened them.
 *
 * Always derived from `restingY` — the position the player chose — never from the
 * window's current y. Deriving it from the current y is what made the overlay climb the
 * screen: each open moved it up, and the next open started from the moved position.
 *
 * @param {Object} args
 * @param {number} args.restingY  where the player put the window's top edge
 * @param {number} args.height    the window height being fitted to
 * @param {{y: number, height: number}} args.area  the display's work area
 * @returns {{y: number, above: boolean}}
 */
export function placeWindow({ restingY, height, area }) {
  const areaBottom = area.y + area.height;

  if (restingY + height <= areaBottom) {
    return { y: restingY, above: false };
  }
  // Bottom-anchored. Math.max keeps the title end on screen for a window taller than the
  // work area, which is possible when the player has picked a large text size.
  return { y: Math.max(area.y, areaBottom - height), above: true };
}
