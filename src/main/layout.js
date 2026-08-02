/**
 * Where the auto-fitted overlay window goes.
 *
 * Split out of main.js and kept free of Electron so the geometry can be unit-tested: it
 * is the kind of arithmetic that is obviously right until the window is near an edge, on
 * a second monitor, or taller than the screen.
 */

/** Never let the resting auto-fit eat the whole display. */
export const MAX_HEIGHT_FRACTION = 0.8;
/**
 * While the breakdown is open the whole work area is allowed. The 80% rule exists so a
 * raid-sized roster cannot permanently take over the screen; a panel that closes the
 * moment the cursor leaves is not that, and every ability row it holds must land on a
 * real on-screen pixel — this window cannot scroll.
 */
export const PANEL_HEIGHT_FRACTION = 1.0;
/** Below this the window is not a window. */
export const MIN_HEIGHT = 70;
/** Matches the BrowserWindow minWidth in main.js. */
export const MIN_WIDTH = 240;

/**
 * Clamp a requested content height to something that fits the display.
 *
 * @param {number} height  what the renderer measured
 * @param {{height: number}} area  the display's work area
 * @param {{panelOpen?: boolean}} [opts]  breakdown showing: allow the full work area
 */
export function clampHeight(height, area, { panelOpen = false } = {}) {
  const fraction = panelOpen ? PANEL_HEIGHT_FRACTION : MAX_HEIGHT_FRACTION;
  const max = Math.floor(area.height * fraction);
  return Math.max(MIN_HEIGHT, Math.min(Math.round(height), max));
}

/**
 * Clamp a requested width for the open breakdown.
 *
 * The floor is the RESTING width — hovering may widen the overlay, never narrow it —
 * and the ceiling is the work area, past which more width is pixels nobody has.
 *
 * @param {number} width  current width plus the measured name-column shortfall
 * @param {{width: number}} area  the display's work area
 * @param {{minWidth?: number}} [opts]  the player's resting width
 */
export function clampWidth(width, area, { minWidth = MIN_WIDTH } = {}) {
  return Math.max(minWidth, Math.min(Math.round(width), area.width));
}

/**
 * Decide the window's placement, and which side the breakdown opens on.
 *
 * Vertical: the top edge stays at `restingY` and the window grows downward. When that
 * would run off the bottom of the work area, the BOTTOM edge is anchored there instead
 * and the panel is reported as opening 'above' — the renderer then draws it between the
 * header and the rows, so the rows do not move under the cursor that opened them.
 *
 * Horizontal mirrors it: the left edge stays at `restingX` and the window grows to the
 * right; when that would cross the work area's right edge, the RIGHT edge is anchored
 * there and the window grows leftward. Growing left is the common case, not the
 * exception — the default position hugs the right edge of the screen. Rows span the
 * full width, so horizontal growth in either direction leaves the hovered row under
 * the cursor; only vertical movement can change which row is hovered.
 *
 * Always derived from the RESTING position — where the player put the window — never
 * from its current bounds. Deriving from current bounds is what made the overlay climb
 * the screen: each open moved it, and the next open started from the moved position.
 *
 * @param {Object} args
 * @param {number} args.restingX  where the player put the window's left edge
 * @param {number} args.restingY  where the player put the window's top edge
 * @param {number} args.width     the window width being fitted to
 * @param {number} args.height    the window height being fitted to
 * @param {{x: number, y: number, width: number, height: number}} args.area  the work area
 * @returns {{x: number, y: number, above: boolean}}
 */
export function placeWindow({ restingX, restingY, width, height, area }) {
  const areaBottom = area.y + area.height;
  const areaRight = area.x + area.width;

  let y;
  let above;
  if (restingY + height <= areaBottom) {
    y = restingY;
    above = false;
  } else {
    // Bottom-anchored. Math.max keeps the title end on screen for a window taller than
    // the work area, which is possible when the player has picked a large text size.
    y = Math.max(area.y, areaBottom - height);
    above = true;
  }

  const x = restingX + width <= areaRight
    ? restingX
    : Math.max(area.x, areaRight - width);

  return { x, y, above };
}
