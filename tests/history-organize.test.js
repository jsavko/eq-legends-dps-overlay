import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isBoss, applyFilters, groupByDay, dayLabel,
  pct, accPct, formatRate, formatDuration, readingAge,
} from '../src/renderer/history/organize.js';

/** Local noon, so timezone offsets can never push a fixture across midnight. */
const day = (y, m, d, hour = 12) => new Date(y, m - 1, d, hour).getTime();

function entry(overrides = {}) {
  return {
    id: '1000-6000',
    label: 'Lord Nagafen',
    zone: "Nagafen's Lair",
    startTs: day(2026, 8, 3),
    durationMs: 45_000,
    deaths: 0,
    ...overrides,
  };
}

// ------------------------------------------------------------------ isBoss

test('capitalized labels are bosses — articles were stripped at engage time', () => {
  assert.equal(isBoss(entry({ label: 'Lord Nagafen', durationMs: 10_000 })), true);
  assert.equal(isBoss(entry({ label: 'Hoptor Thaggelum', durationMs: 5_000 })), true);
});

test('lowercase short fights are trash', () => {
  assert.equal(isBoss(entry({ label: 'froglok shin knight', durationMs: 20_000 })), false);
  assert.equal(isBoss(entry({ label: 'decaying skeleton', durationMs: 89_999 })), false);
});

test('90s of fighting makes any label a boss', () => {
  assert.equal(isBoss(entry({ label: 'froglok shin knight', durationMs: 90_000 })), true);
});

test('a missing label is not a boss', () => {
  assert.equal(isBoss(entry({ label: null, durationMs: 10_000 })), false);
});

// ------------------------------------------------------------- applyFilters

const NOW = day(2026, 8, 4);
const fights = [
  entry({ id: 'a', label: 'Lord Nagafen', zone: "Nagafen's Lair", startTs: day(2026, 8, 4), deaths: 1 }),
  entry({ id: 'b', label: 'froglok shin knight', zone: 'Lower Guk', startTs: day(2026, 8, 4, 9), durationMs: 12_000 }),
  entry({ id: 'c', label: 'giant rat', zone: 'Lower Guk', startTs: day(2026, 8, 3), durationMs: 8_000 }),
  entry({ id: 'd', label: 'Hoptor Thaggelum', zone: 'The Overthere', startTs: day(2026, 8, 3), deaths: 2 }),
];
const ids = (list) => list.map((e) => e.id);

test('chip: all passes everything through in order', () => {
  assert.deepEqual(ids(applyFilters(fights, { chip: 'all' }, NOW)), ['a', 'b', 'c', 'd']);
});

test('chip: bosses keeps named mobs and long fights only', () => {
  assert.deepEqual(ids(applyFilters(fights, { chip: 'bosses' }, NOW)), ['a', 'd']);
});

test('chip: deaths keeps fights where someone (non-pet) died', () => {
  assert.deepEqual(ids(applyFilters(fights, { chip: 'deaths' }, NOW)), ['a', 'd']);
});

test('chip: today compares calendar days, not 24h windows', () => {
  // 'b' started at 9am the same day; 'c' and 'd' are yesterday even though 'd' is
  // well within 24 hours of NOW (noon).
  assert.deepEqual(ids(applyFilters(fights, { chip: 'today' }, NOW)), ['a', 'b']);
});

test('search matches label and zone, case-insensitively', () => {
  assert.deepEqual(ids(applyFilters(fights, { search: 'NAGAFEN' }, NOW)), ['a']);
  assert.deepEqual(ids(applyFilters(fights, { search: 'guk' }, NOW)), ['b', 'c']);
  assert.deepEqual(ids(applyFilters(fights, { search: '  ' }, NOW)), ['a', 'b', 'c', 'd']);
});

test('chip and search compose', () => {
  assert.deepEqual(ids(applyFilters(fights, { chip: 'bosses', search: 'overthere' }, NOW)), ['d']);
});

// --------------------------------------------------------------- groupByDay

test('groupByDay buckets consecutive same-day entries and keeps input order', () => {
  const groups = groupByDay(fights);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].dayLabel, dayLabel(day(2026, 8, 4)));
  assert.deepEqual(ids(groups[0].entries), ['a', 'b']);
  assert.equal(groups[1].dayLabel, dayLabel(day(2026, 8, 3)));
  assert.deepEqual(ids(groups[1].entries), ['c', 'd']);
});

test('dayLabel reads like the mock: "MON · AUG 3"', () => {
  // 2026-08-03 is a Monday.
  assert.equal(dayLabel(day(2026, 8, 3)), 'MON · AUG 3');
});

test('groupByDay of nothing is nothing', () => {
  assert.deepEqual(groupByDay([]), []);
});

// --------------------------------------------------------------- formatters

test('pct: dash at zero, floor at <1%, rounded above', () => {
  assert.equal(pct(0), '—');
  assert.equal(pct(0.004), '<1%');
  assert.equal(pct(0.42), '42%');
});

test('accPct: prints a real zero, dashes only when there is nothing to divide', () => {
  // The whole reason accuracy cannot go through pct — an ability that swung and never
  // landed is 0%, not a dash, and not "<1%".
  assert.equal(accPct(0), '0%');
  assert.equal(accPct(null), '—');
  assert.equal(accPct(2 / 3), '67%');
  assert.equal(accPct(1), '100%');
});

test('formatRate: decimals small, whole mid, k above ten thousand', () => {
  assert.equal(formatRate(3.14), '3.1');
  assert.equal(formatRate(240), '240');
  assert.equal(formatRate(12_345), '12.3k');
});

test('formatDuration: m:ss, hours only when real', () => {
  assert.equal(formatDuration(45_000), '0:45');
  assert.equal(formatDuration(95_000), '1:35');
  assert.equal(formatDuration(3_725_000), '1:02:05');
});

test('readingAge dates a /who against the pull, never against now', () => {
  const pull = new Date(2026, 7, 22, 21, 0, 0).getTime();

  // The ordinary case: somebody typed /who group on the way in.
  assert.equal(readingAge(pull - 8 * 60_000, pull), 'read 8m before the pull');
  assert.equal(readingAge(pull - 3 * 3_600_000, pull), 'read 3h before the pull');
  assert.equal(readingAge(pull - 2 * 86_400_000, pull), 'read 2d before the pull');

  // Seconds before the pull is not worth a number — it is simply current.
  assert.equal(readingAge(pull - 4_000, pull), 'read moments before the pull');

  // Typed mid-fight, which happens on a long one. There is no "before" to measure and
  // none is invented.
  assert.equal(readingAge(pull + 30_000, pull), 'read during the fight');
  assert.equal(readingAge(pull, pull), 'read during the fight');

  // Nothing to date: a record written before sightings were stamped, or a member /who
  // never named. The caller draws its own placeholder rather than a phrase about a
  // reading that does not exist.
  assert.equal(readingAge(undefined, pull), null);
  assert.equal(readingAge(pull - 60_000, undefined), null);
});

test('readingAge is stable however long after the fight it is read', () => {
  // The point of dating against the pull: opening the same record a month later must
  // print the same sentence it printed the night it was written.
  const pull = new Date(2026, 7, 22, 21, 0, 0).getTime();
  const reading = pull - 12 * 60_000;
  assert.equal(readingAge(reading, pull), 'read 12m before the pull');
  assert.equal(readingAge(reading, pull), readingAge(reading, pull));
});
