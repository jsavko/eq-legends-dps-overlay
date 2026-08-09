import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFilters, groupByDay, railSummary, headline, categories, detail, progressRows,
  formatCoin, formatPlatinum, formatCount, formatSpan, formatDuration, formatRate,
  timeRange, dayHeading, zoneLabel, closeReasonLabel, currentSegment,
} from '../src/renderer/session/organize.js';
import { combatBetween } from '../src/main/history.js';
import { SessionTracker } from '../src/session/session.js';

const T0 = new Date(2026, 7, 8, 9, 12, 0).getTime();
const HOUR = 3_600_000;

/** A full record, built by the real tracker so the shapes cannot drift apart. */
function realRecord(lines = DEFAULT_LINES) {
  const t = new SessionTracker({
    character: 'Rhale', server: 'oggok', isOurs: (n) => n === 'Rhain',
  });
  for (const [secs, body] of lines) {
    const d = new Date(T0 + secs * 1000);
    const p = (n) => String(n).padStart(2, '0');
    t.feed(`[Sat Aug  8 ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} 2026] ${body}`, null);
  }
  return t.close('idle');
}

const DEFAULT_LINES = [
  [0, 'You have slain a froglok shin knight!'],
  [10, 'You receive 3 gold, 6 silver and 7 copper from the corpse.'],
  [20, "--You have looted a Mote of Lesser Potential from a shin ghoul knight's corpse.--"],
  [30, 'You gain experience! (10%)'],
  [40, 'Your faction standing with Frogloks of Guk has been adjusted by -5.'],
  [50, 'Your faction standing with Undead Frogloks of Guk could not possibly get any worse.'],
  [60, 'You have become better at Athletics! (135)'],
  [70, 'You have gained an ability point!  You now have 1 ability point.'],
  [80, 'You have entered The Ruins of Old Guk.'],
  [3600, 'You have gained a level! Welcome to level 28!'],
  [5400, 'You gain experience! (25%)'],
  [7200, 'A froglok shin knight has been slain by Rhain!'],
];

const ENTRY = {
  id: '1', startTs: T0, endTs: T0 + 4 * HOUR, durationMs: 4 * HOUR,
  kills: 142, deaths: 0, loot: 88, copperEarned: 3418, netCopper: 3418,
  levelsGained: 1, aaEarned: 2, zones: 2, zoneNames: ['Lower Guk', 'Upper Guk'],
  closeReason: 'idle',
};

// ------------------------------------------------------------------------ the rail

test('the rail summary always states deaths, faint when there were none', () => {
  // A line that renders only on death-sessions shifts every row below it — the exact
  // failure the History window already fixed once.
  const clean = railSummary(ENTRY);
  assert.equal(clean.deaths, 'no deaths');
  assert.equal(clean.hadDeaths, false);

  const died = railSummary({ ...ENTRY, deaths: 2 });
  assert.equal(died.deaths, '2 deaths');
  assert.equal(died.hadDeaths, true);
  assert.equal(railSummary({ ...ENTRY, deaths: 1 }).deaths, '1 death');
});

test('the rail summary names the zones rather than counting them', () => {
  assert.equal(railSummary(ENTRY).zone, 'Lower Guk, Upper Guk');
  assert.equal(zoneLabel({ zoneNames: ['A', 'B', 'C', 'D'] }), 'A, B +2');
  assert.equal(zoneLabel({ zoneNames: [] }), 'Unknown');
});

test('the session in flight ends its span in "now", never in a time it has not reached', () => {
  // The live entry carries `endTs = this instant`, so the ordinary formatting would state
  // as fact that the night finished at the moment the player happened to look at it.
  const finished = railSummary(ENTRY);
  assert.equal(finished.range, '09:12 – 13:12');
  assert.equal(finished.live, false);

  const live = railSummary({ ...ENTRY, live: true });
  assert.equal(live.range, '09:12 – now');
  assert.equal(live.live, true);

  // Everything else about the row is the same sentence about a shorter night.
  assert.equal(live.zone, finished.zone);
  assert.equal(live.stats, finished.stats);
  assert.equal(live.deaths, finished.deaths);
});

test('timeRange states an end only when there is one', () => {
  assert.equal(timeRange(T0, T0 + HOUR), '09:12 – 10:12');
  assert.equal(timeRange(T0, T0 + HOUR, { live: true }), '09:12 – now');
});

test('filters narrow by week, deaths and free text without re-sorting', () => {
  const now = T0 + 2 * 24 * HOUR;
  const old = { ...ENTRY, id: '2', startTs: T0 - 20 * 24 * HOUR, zoneNames: ['Befallen'] };
  const entries = [ENTRY, old];

  assert.deepEqual(applyFilters(entries, {}, now).map((e) => e.id), ['1', '2']);
  assert.deepEqual(applyFilters(entries, { chip: 'week' }, now).map((e) => e.id), ['1']);
  assert.deepEqual(applyFilters(entries, { chip: 'deaths' }, now), []);
  assert.deepEqual(
    applyFilters([{ ...ENTRY, deaths: 3 }, old], { chip: 'deaths' }, now).map((e) => e.id), ['1'],
  );
  assert.deepEqual(applyFilters(entries, { search: 'befallen' }, now).map((e) => e.id), ['2']);
  assert.deepEqual(applyFilters(entries, { search: 'nothing here' }, now), []);
});

test('day grouping preserves the store order and names today', () => {
  const sameDayLater = { ...ENTRY, id: '2', startTs: T0 - HOUR };
  const dayBefore = { ...ENTRY, id: '3', startTs: T0 - 26 * HOUR };
  const groups = groupByDay([ENTRY, sameDayLater, dayBefore], T0);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].entries.map((e) => e.id), ['1', '2']);
  assert.deepEqual(groups[1].entries.map((e) => e.id), ['3']);
  assert.match(groups[0].label, /^TODAY · /);
  assert.doesNotMatch(groups[1].label, /TODAY/);
  assert.equal(dayHeading(T0, T0), 'TODAY · SAT 8 AUG');
});

// ---------------------------------------------------------------- summary + categories

test('the headline reads the four numbers off a real record', () => {
  const stats = headline(realRecord());
  assert.deepEqual(stats.map((s) => s.id), ['kills', 'coin', 'xp', 'loot']);
  assert.equal(stats[0].value, '2');
  assert.equal(stats[3].value, '1');
  // The XP figure is the CURRENT segment's, never a session total.
  assert.equal(stats[2].value, '+25');
});

test('every category renders, empty ones included', () => {
  // A category that vanishes on a quiet night moves every row under it. The panes must
  // sit on the same pixel for every session.
  const full = categories(realRecord());
  const bare = categories(realRecord([[0, 'You have slain a froglok shin knight!']]));

  assert.deepEqual(full.map((c) => c.id), bare.map((c) => c.id));
  assert.deepEqual(
    full.map((c) => c.id),
    ['combat', 'kills', 'loot', 'coin', 'progress', 'faction', 'skills', 'travels'],
  );
  for (const c of bare) assert.ok(c.summary.length > 0, `${c.id} rendered an empty summary`);
  assert.equal(bare.find((c) => c.id === 'loot').summary, 'nothing recorded');
});

test('the combat category comes from the encounter store, not the tracker', () => {
  const record = realRecord();
  const encounters = [
    {
      startTs: T0 + 100, durationMs: 60_000,
      snapshot: {
        totalDamage: 5000, totalHealing: 200,
        deaths: [],
        rows: [{ name: 'Rhale', damage: 3000, healing: 100, damageTaken: 400, hits: 61, misses: 39, crits: 7 }],
      },
    },
    {
      startTs: T0 + 200, durationMs: 60_000,
      snapshot: {
        totalDamage: 1000, totalHealing: 0,
        deaths: [{ name: 'Rhale', isPet: false }],
        rows: [{ name: 'Rhale', damage: 1000, healing: 0, damageTaken: 100, hits: 0, misses: 0, crits: 0 }],
      },
    },
    // Outside the window: a fight from a different sitting.
    { startTs: T0 - HOUR, durationMs: 60_000, snapshot: { totalDamage: 9999, rows: [] } },
  ];

  const combat = combatBetween(encounters, record.startTs, record.endTs, { character: 'Rhale' });
  assert.equal(combat.encounters, 2, 'a fight that started before the session is not in it');
  assert.equal(combat.damage, 4000);
  assert.equal(combat.groupDamage, 6000);
  assert.equal(combat.deaths, 1);
  // Rates divide by TIME IN COMBAT, not by session length.
  assert.equal(combat.fightMs, 120_000);
  assert.equal(combat.dps, 4000 / 120);
  assert.equal(Math.round(combat.accuracy * 100), 61);

  const cats = categories(record, combat);
  assert.match(cats[0].summary, /4\.0k dealt/);
  assert.match(cats[0].summary, /61% acc/);
});

test('a session with no fights in history says so rather than showing zeros', () => {
  const cats = categories(realRecord(), combatBetween([], T0, T0 + HOUR, { character: 'Rhale' }));
  assert.equal(cats[0].summary, 'no fights recorded');
  assert.equal(detail(realRecord(), 'combat', null).lead, null);
});

// -------------------------------------------------------------------------- the detail

test('detail lists every entry — no top-N, no "+N more"', () => {
  // A cap is how DoT damage once vanished from a list while still counting in the total.
  const items = Array.from({ length: 40 }, (_, i) =>
    [i, `--You have looted a Thing Number ${i} from a shin ghoul knight's corpse.--`]);
  const view = detail(realRecord(items), 'loot');

  assert.equal(view.rows.length, 40);
  assert.match(view.footer, /40 of 40 kinds shown — nothing truncated/);
  assert.doesNotMatch(view.footer, /more/);
});

test('a capped faction shows a dash, never a zero', () => {
  const view = detail(realRecord(), 'faction');
  const capped = view.rows.find((r) => r.name === 'Undead Frogloks of Guk');
  assert.equal(capped.value, '—', 'a cap is not an amount');
  assert.match(capped.sub, /capped worse/);

  const moved = view.rows.find((r) => r.name === 'Frogloks of Guk');
  assert.equal(moved.value, '-5');
});

test('a skill reports first-seen to last-seen, and the footer says why', () => {
  const view = detail(realRecord(), 'skills');
  assert.equal(view.rows[0].value, '135 → 135');
  assert.match(view.footer, /the log prints the new value, not the gain/);
});

test('kills detail names how many were somebody else\'s', () => {
  const withStranger = realRecord([
    ...DEFAULT_LINES,
    [7300, 'A shin ghoul knight has been slain by Randobob!'],
  ]);
  const view = detail(withStranger, 'kills');
  assert.match(view.footer, /1 more killed by others in zone, not counted as ours/);
});

test('travels lists zones and deaths together, and says so when clean', () => {
  const clean = detail(realRecord(), 'travels');
  assert.equal(clean.footer, 'no deaths this session');

  const died = detail(realRecord([
    ...DEFAULT_LINES,
    [7300, 'You have been slain by an urd ghoul wizard!'],
  ]), 'travels');
  assert.equal(died.footer, '1 death this session');
  assert.equal(died.rows[died.rows.length - 1].kind, 'death');
});

// ------------------------------------------------------- the experience honesty rule

test('progress lists one row per level and never a session total', () => {
  const record = realRecord();
  const view = detail(record, 'progress');

  const levelRows = view.rows.filter((r) => r.kind === 'past' || r.kind === 'current');
  assert.equal(levelRows.length, 2);
  assert.equal(levelRows[0].value, '+10%');
  assert.equal(levelRows[1].value, '+25%');
  // 35% appears nowhere — that number would describe nothing.
  assert.equal(view.rows.some((r) => r.value === '+35%'), false);
});

test('the pane carries an explicit dash where a session-wide XP total would go', () => {
  // If this note ever disappears, or the dash becomes a number, the honesty rule has
  // been lost and the window is wrong.
  const view = detail(realRecord(), 'progress');
  const note = view.rows.find((r) => r.kind === 'note');
  assert.ok(note, 'the Progress pane has no "per level, never summed" note');
  assert.equal(note.value, '—');
  assert.match(note.sub, /the log prints no absolute XP/);
});

test('time-to-level is offered only from an anchored segment', () => {
  const rows = progressRows({
    segments: [
      { level: 27, anchored: false, percent: 20, ms: HOUR, percentPerHour: 20, timeToLevelMs: null },
      { level: 28, anchored: true, percent: 25, ms: HOUR, percentPerHour: 25, timeToLevelMs: 3 * HOUR },
    ],
  });
  assert.match(rows[0].sub, /started mid-level/);
  assert.doesNotMatch(rows[0].sub, /to 28/);
  assert.match(rows[1].sub, /3:00:00 to 29/);
});

test('a session that started mid-level says why there is no time-to-level', () => {
  // "We cannot compute this" and "this is zero" must never look the same.
  const rows = progressRows({
    segments: [{ level: null, anchored: false, percent: 12, ms: HOUR, percentPerHour: 12, timeToLevelMs: null }],
  });
  assert.equal(rows[0].name, 'This level');
  assert.match(rows[0].sub, /the log never said where this level started/);
});

test('ability points appear with both halves of the ledger', () => {
  const view = detail(realRecord(), 'progress');
  const aa = view.rows.find((r) => r.kind === 'aa');
  assert.equal(aa.value, '1');
  assert.match(aa.sub, /1 earned · 0 spent/);
});

test('each ability bought gets its own row, free ranks included', () => {
  // A single session in the live log bought thirteen. Their names run together with
  // separators is an unreadable paragraph pretending to be a value.
  const record = realRecord([
    ...DEFAULT_LINES,
    [7300, 'You have gained the ability "Combat Fury" at a cost of 1 ability points.'],
    [7310, 'You have improved Unbound Nature 2 at a cost of 0 ability points.'],
  ]);
  const spends = detail(record, 'progress').rows.filter((r) => r.kind === 'aa-spend');

  assert.deepEqual(spends.map((r) => [r.name, r.value, r.sub]), [
    ['Combat Fury', '−1', 'new ability'],
    ['Unbound Nature 2', 'free', 'rank up'],
  ]);
});

// ---------------------------------------------------------------------- formatters

test('coin is rendered the way the game says it', () => {
  assert.equal(formatCoin(3418), '3p 4g 1s 8c');
  assert.equal(formatCoin(8), '8c');
  assert.equal(formatCoin(1000), '1p');
  assert.equal(formatCoin(0), '0c');
  assert.equal(formatCoin(-500), '−5g');
  assert.equal(formatPlatinum(3418), '3.4');
  assert.equal(formatPlatinum(178_886), '179');
});

test('counts, spans and durations use the units they are read in', () => {
  assert.equal(formatCount(412_000), '412k');
  assert.equal(formatCount(1492), '1.5k');
  assert.equal(formatCount(88), '88');
  assert.equal(formatCount(1_500_000), '1.5M');

  assert.equal(formatSpan(4 * HOUR + 36 * 60_000), '4h 36m');
  assert.equal(formatSpan(58 * 60_000), '58m');
  assert.equal(formatDuration(90_000), '1:30');
  assert.equal(formatDuration(4 * HOUR), '4:00:00');
  assert.equal(timeRange(T0, T0 + 4 * HOUR + 36 * 60_000), '09:12 – 13:48');
});

test('a rate that cannot be computed renders as nothing at all', () => {
  assert.equal(formatRate(null, '/hr'), '');
  assert.equal(formatRate(undefined, '/hr'), '');
  assert.equal(formatRate(Infinity, '/hr'), '');
  assert.equal(formatRate(30.94, '/hr'), ' 30.9/hr');
});

test('a recovered session says what is missing rather than calling itself closed', () => {
  assert.match(closeReasonLabel('recovered'), /the last few minutes are missing/);
  assert.equal(closeReasonLabel('idle'), 'closed by 60m idle');
  assert.equal(closeReasonLabel('open'), 'still running');
  assert.equal(closeReasonLabel('who-knows'), 'who-knows');
});

test('currentSegment is the last one, or null for a session with no experience', () => {
  assert.equal(currentSegment(realRecord()).level, 28);
  assert.equal(currentSegment(realRecord([[0, 'You have slain a froglok shin knight!']])), null);
  assert.equal(currentSegment(null), null);
});
