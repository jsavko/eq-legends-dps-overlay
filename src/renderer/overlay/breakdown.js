/**
 * Column arithmetic for the breakdown's ability list.
 *
 * The list always contains EVERY ability — the overlay ignores mouse input so the game
 * keeps every click, which means nothing in it can scroll and anything without room on
 * screen is simply gone. When one column of rows would be taller than the screen allows,
 * the list flows into more columns instead of truncating: ceil(count / cols) rows per
 * column falls as cols rises, so some column count always fits.
 *
 * Kept free of any DOM access so `node --test` can exercise it directly.
 */

/**
 * The number of columns the ability list needs for every row to fit.
 *
 * Returns the SMALLEST count that fits, and `maxColumns` when even that does not —
 * never more. The caller renders the whole list regardless; past `maxColumns` the
 * names start ellipsizing before the layout gets any narrower, which is the last
 * resort, not a row being dropped.
 *
 * @param {Object} args
 * @param {number} args.count       ability rows to place
 * @param {number} args.rowHeight   height of one row, including its gap
 * @param {number} args.available   vertical pixels the list may use
 * @param {number} [args.maxColumns]
 * @returns {number} 1 .. maxColumns
 */
export function abilityColumns({ count, rowHeight, available, maxColumns = 3 }) {
  if (!Number.isFinite(count) || count <= 0) return 1;
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) return 1;
  // Never more columns than items: an extra empty column cannot shorten the list,
  // it only squeezes width out of the name tracks.
  const max = Math.max(1, Math.min(Math.floor(maxColumns), count));

  for (let cols = 1; cols < max; cols++) {
    if (Math.ceil(count / cols) * rowHeight <= available) return cols;
  }
  return max;
}
