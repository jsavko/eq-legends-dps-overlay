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
/**
 * Percentage split for the player/pet legend line.
 *
 * The two figures must read as parts of one whole, so they are rounded as
 * complements: pet gets `Math.round`, player gets the remainder. Rounding each
 * independently can print 66% + 33% or 67% + 34% — a pair that does not sum to 100
 * reads as damage missing, which is the exact failure the breakdown exists to avoid.
 *
 * Returns null when the total is zero (a taken-view row can render with nothing
 * taken, shown only because someone died) — the caller omits the percentages
 * entirely rather than inventing a `player 0 · 100%`.
 *
 * @param {number} playerValue
 * @param {number} petValue
 * @returns {{ playerPct: number, petPct: number } | null}
 */
export function splitShares(playerValue, petValue) {
  const total = playerValue + petValue;
  if (!Number.isFinite(total) || total <= 0) return null;
  const petPct = Math.round((petValue / total) * 100);
  return { playerPct: 100 - petPct, petPct };
}

/**
 * One ability's accuracy, as a fraction — hits over swings.
 *
 * Returns NULL rather than 0 when there is nothing to divide. An ability row can exist
 * with neither a hit nor a miss against it (a heal, a DoT tick, a taken-view row carrying
 * no swing data at all), and printing `0%` there would say "this always whiffs" about a
 * thing that never swung. The caller shows a dash instead.
 *
 * A genuine zero — swung twice, landed nothing — must still come back as 0 and print as
 * `0%`, which is why this cannot be folded into the share formatters: both `formatShare`
 * here and `pct` in the history window turn anything <= 0 into a dash, and an ability that
 * misses every time is the single most worth-knowing row in the list.
 *
 * @param {number} hits
 * @param {number} misses
 * @returns {number | null} 0..1, or null when there were no swings
 */
export function abilityAccuracy(hits, misses) {
  // Records written before per-ability misses were tracked simply have no answer here,
  // and neither does anything nonsensical — a dash beats a fabricated number.
  if (!Number.isFinite(hits) || !Number.isFinite(misses)) return null;
  if (hits < 0 || misses < 0) return null;
  const swings = hits + misses;
  if (swings <= 0) return null;
  return hits / swings;
}

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
