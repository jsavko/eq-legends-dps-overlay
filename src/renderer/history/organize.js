/**
 * Pure list logic for the history window: classification, filtering, day grouping
 * and the shared formatters. No DOM, no Electron — this is the half of the window
 * that runs under `node --test` in WSL, the same split breakdown.js gives the overlay.
 */

/**
 * Boss or trash?
 *
 * Encounter labels are stored ARTICLE-STRIPPED — `engage()` receives resolved names,
 * so "a froglok shin knight" is on disk as "froglok shin knight". That kills the
 * obvious "starts with a/an" test before it starts. What survives the stripping is
 * capitalization: named mobs keep their capitals ("Lord Nagafen", "Hoptor
 * Thaggelum") while generic trash is lowercase. The duration test backstops the
 * heuristic for lowercase-but-serious fights — anything the group ground on for a
 * minute and a half was a boss in every sense that matters to "find that fight".
 */
export function isBoss(entry) {
  const label = entry.label ?? '';
  return /^[A-Z]/.test(label) || (entry.durationMs ?? 0) >= 90_000;
}

/**
 * Apply the rail's chip + search box to the raw index, preserving order.
 *
 * `now` is injectable so the "today" chip is testable; callers omit it and get the
 * real clock. Search matches label and zone, case-insensitively, the same fields the
 * old tab's filter matched.
 */
export function applyFilters(entries, { chip = 'all', search = '' } = {}, now = Date.now()) {
  const needle = search.trim().toLowerCase();
  const today = new Date(now);
  return entries.filter((e) => {
    if (chip === 'bosses' && !isBoss(e)) return false;
    if (chip === 'deaths' && !(e.deaths > 0)) return false;
    if (chip === 'today' && !sameDay(new Date(e.startTs), today)) return false;
    if (needle &&
        !(e.label ?? '').toLowerCase().includes(needle) &&
        !(e.zone ?? '').toLowerCase().includes(needle)) return false;
    return true;
  });
}

/**
 * Group a (newest-first) list into day buckets for the rail's "SUN · AUG 3" headers.
 * Order within a group, and of the groups themselves, is the input's — grouping must
 * never re-sort what the store already ordered.
 */
export function groupByDay(entries) {
  const groups = [];
  let current = null;
  for (const e of entries) {
    const label = dayLabel(e.startTs);
    if (!current || current.dayLabel !== label) {
      current = { dayLabel: label, entries: [] };
      groups.push(current);
    }
    current.entries.push(e);
  }
  return groups;
}

/** "SUN · AUG 3" — the rail's day header. */
export function dayLabel(ts) {
  const d = new Date(ts);
  const day = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  const month = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
  return `${day} · ${month} ${d.getDate()}`;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

// ------------------------------------------------------------- formatters
// Shared by every pane; lifted from the old settings tab so both windows agree on
// how a number reads.

export function pct(fraction) {
  if (!Number.isFinite(fraction) || fraction <= 0) return '—';
  const p = fraction * 100;
  return p < 1 ? '<1%' : `${Math.round(p)}%`;
}

/**
 * Accuracy, which is a share but must NOT go through `pct`.
 *
 * `pct` turns anything at or below zero into a dash, on the reasoning that a zero share is
 * a rounding artefact rather than news. Accuracy is the opposite: an ability that swung
 * and never landed is a real 0% and the most worth-reading row in the table, while one
 * that never swung has nothing to divide and is the case the dash is actually for.
 * `abilityAccuracy` draws that line and hands null here for the second.
 */
export function accPct(fraction) {
  if (fraction === null || !Number.isFinite(fraction)) return '—';
  return `${Math.round(fraction * 100)}%`;
}

export function formatRate(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return String(Math.round(n));
  return n.toFixed(1);
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "8:15 PM" for the rail rows; the day is already the group header's job. */
export function timeOfDay(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The fight header's full stamp: "Aug 3, 8:15 PM". */
export function shortDate(ts) {
  const d = new Date(ts);
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${date}, ${timeOfDay(ts)}`;
}
