/**
 * EverQuest log timestamps look like:
 *   [Fri Jul 31 18:31:35 2026] <body>
 *
 * Resolution is one second, which the DPS math has to tolerate (see encounter.js).
 * Times are local to the machine that wrote the log, so we build a local Date.
 */

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

// [Ddd Mmm D HH:MM:SS YYYY] — day-of-month is space-padded to width 2 by EQ.
const LINE_RE = /^\[([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})\] ?(.*)$/;

/**
 * Split a raw log line into its timestamp and body.
 * @param {string} line
 * @returns {{ ts: number, body: string } | null} null when the line has no valid header
 */
export function parseTimestamp(line) {
  if (typeof line !== 'string') return null;

  const m = LINE_RE.exec(line);
  if (!m) return null;

  const month = MONTHS[m[2]];
  if (month === undefined) return null;

  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const year = Number(m[7]);

  // Reject values a real clock never produces; a malformed line is better
  // dropped than silently folded into an encounter at the wrong time.
  if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;

  const ts = new Date(year, month, day, hour, minute, second, 0).getTime();
  if (Number.isNaN(ts)) return null;

  return { ts, body: m[8] };
}

/** Format epoch ms as M:SS (or H:MM:SS past an hour) for encounter elapsed display. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
