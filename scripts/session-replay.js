#!/usr/bin/env node
/**
 * Replay a saved log through the session tracker and print what the night earned.
 *
 * The mirror of `scripts/replay.js`, and the reason the whole of `src/session/` is pure
 * Node: the entire non-combat half can be checked against a real 1.1M-line log with the
 * game closed and Electron nowhere in sight. If a rule never fires, this is where that
 * shows up — as a category with a zero in it, next to twelve that do not.
 *
 * A real `LogParser` runs alongside the tracker rather than being stubbed out, because it
 * supplies two things nothing else can: the chat classification that keeps quoted lines
 * out of the totals, and the roster that says which of six names in a kill line are ours.
 *
 * Examples:
 *   node scripts/session-replay.js tests/fixtures/combat-sample.log
 *   node scripts/session-replay.js "$LIVE_LOG" --sessions
 *   node scripts/session-replay.js "$LIVE_LOG" --idle 30 --category coin --category loot
 */

import fs from 'node:fs';
import path from 'node:path';
import { LogParser } from '../src/parser/index.js';
import { parseTimestamp, formatDuration } from '../src/parser/timestamp.js';
import { SessionTracker, IDLE_MS } from '../src/session/session.js';
import { SESSION_CATEGORIES } from '../src/session/rules.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const values = (name) => argv.reduce(
  (out, a, i) => (a === `--${name}` && argv[i + 1] ? [...out, argv[i + 1]] : out), [],
);

const VALUED = new Set(['idle', 'category', 'top']);
const logFile = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && VALUED.has(argv[i - 1].slice(2))));

if (!logFile) {
  console.error(
    'usage: node scripts/session-replay.js <logfile> [--sessions] [--idle MINUTES] ' +
    '[--category NAME ...] [--top N]'
  );
  process.exit(1);
}

const only = values('category');
const categories = only.length
  ? Object.fromEntries(SESSION_CATEGORIES.map((c) => [c, only.includes(c)]))
  : null;
const idleMs = value('idle', null) ? Number(value('idle')) * 60_000 : IDLE_MS;
const top = Number(value('top', 15));

const logFilename = path.basename(logFile);
// latin1, never utf8 — EQ writes single-byte text and utf8 mangles accented mob names.
const text = fs.readFileSync(path.resolve(logFile), 'latin1');
const lines = text.split(/\r?\n/).filter((l) => l.length > 0);

const parser = new LogParser({
  logFilename: /^eqlog_/.test(logFilename) ? logFilename : 'eqlog_Rhale_oggok.txt',
  // Log time only, so the output is deterministic and does not depend on when it is run.
  clock: () => logNow,
});

const finished = [];
const tracker = new SessionTracker({
  categories,
  idleMs,
  character: parser.selfName,
  server: parser.server,
  // The roster's own answer, which is the entire point of running a parser alongside:
  // a group member's kill is ours and a passing stranger's is not.
  isOurs: (name) => parser.roster.includes(name, false),
  onSessionEnd: (record) => finished.push(record),
});

let logNow = 0;
let tracked = 0;
for (const line of lines) {
  const stamped = parseTimestamp(line);
  if (stamped) logNow = stamped.ts;
  const parserEvent = parser.feed(line);
  if (tracker.feed(line, parserEvent)) tracked += 1;
}
// Flush whatever is still open, dated to its own last event rather than to now. The
// record arrives via onSessionEnd like every other — close() also returns it, and pushing
// that return value as well is how the last session ended up in the list twice.
tracker.close('replay-end');

console.log(
  `${lines.length} lines, ${tracked} tracked events, ${finished.length} session(s), ` +
  `idle boundary ${Math.round(idleMs / 60_000)} min` +
  (only.length ? `, categories: ${only.join(', ')}` : '')
);

if (flag('sessions')) {
  console.log();
  for (const rec of finished) printSession(rec);
} else {
  console.log();
  for (const rec of finished) printOneLine(rec);
  console.log();
  printSession(merge(finished));
}

function printOneLine(rec) {
  const when = new Date(rec.startTs).toLocaleString();
  console.log(
    `  ${when}  ${formatDuration(rec.durationMs).padStart(8)}  ` +
    `${String(rec.kills.total).padStart(5)} kills  ` +
    `${coin(rec.coin.earned.copperTotal).padStart(14)}  ` +
    `${String(rec.loot.total).padStart(4)} loot  ${rec.closeReason}`
  );
}

function printSession(rec) {
  if (!rec) return;
  const when = new Date(rec.startTs).toLocaleString();
  console.log(`── ${when}  ·  ${formatDuration(rec.durationMs)}  ·  ${rec.closeReason}`);

  line('kills', `${rec.kills.total} (${rec.kills.mine} yours)` +
    rate(rec.kills.perHour, '/hr') +
    (rec.kills.others ? `   [${rec.kills.others} by others in zone]` : ''));
  list(rec.kills.byCreature);

  line('deaths', String(rec.deaths.length));

  line('coin', `${coin(rec.coin.earned.copperTotal)} earned, ` +
    `${coin(rec.coin.spent.copperTotal)} spent, net ${coin(rec.coin.netCopper)}` +
    rate(rec.coin.copperPerHour && rec.coin.copperPerHour / 1000, ' pp/hr'));
  for (const s of rec.coin.bySource) {
    console.log(`      ${s.source.padEnd(10)} ${coin(s.copperTotal)}`);
  }

  line('loot', `${rec.loot.total} items, ${rec.loot.items.length} kinds` +
    rate(rec.loot.perHour, '/hr'));
  list(rec.loot.items);

  // The honesty rule, made visible: one line per level, never a sum across them.
  line('xp', rec.xp.segments.length
    ? `${rec.xp.levelsGained} level(s) gained` +
      (rec.xp.levelsLost ? `, ${rec.xp.levelsLost} lost` : '')
    : 'none');
  for (const seg of rec.xp.segments) {
    const name = seg.level === null ? 'level ?' : `level ${seg.level}`;
    const anchor = seg.anchored ? '' : '  (started mid-level — no time-to-level)';
    const tt = seg.timeToLevelMs === null ? '—' : formatDuration(seg.timeToLevelMs);
    console.log(
      `      ${name.padEnd(9)} ${seg.percent.toFixed(3).padStart(8)}%  ` +
      `${(seg.percentPerHour ?? 0).toFixed(1).padStart(7)} %/hr  ` +
      `to level: ${tt}${anchor}`
    );
  }

  line('AA', `${rec.aa.earned} earned, ${rec.aa.spent} spent` +
    (rec.aa.unspent === null ? '' : `, ${rec.aa.unspent} unspent`));
  for (const a of rec.aa.abilities.slice(0, top)) {
    console.log(`      ${a.improved ? '↑' : '+'} ${a.name} (${a.cost})`);
  }

  line('faction', `${rec.faction.length} standing(s) moved`);
  for (const f of rec.faction.slice(0, top)) {
    const cap = f.cappedAt ? `  [capped ${f.cappedAt}]` : '';
    console.log(`      ${String(f.delta).padStart(7)}  ${f.name}${cap}`);
  }

  line('skills', `${rec.skills.ups.length} skill(s), ${rec.skills.tradeskills.length} combine kind(s)`);
  for (const k of rec.skills.ups.slice(0, top)) {
    console.log(`      ${k.skill.padEnd(18)} ${k.from} → ${k.to}  (${k.ups} ups)`);
  }

  line('zones', `${rec.zones.length} visit(s)`);
  for (const z of rec.zones.slice(0, top)) {
    console.log(`      ${formatDuration(z.ms).padStart(9)}  ${z.zone}`);
  }
  console.log();
}

function line(label, text) {
  console.log(`   ${label.padEnd(8)} ${text}`);
}

function rate(n, suffix) {
  return n === null || n === undefined ? '' : `   ${n.toFixed(1)}${suffix}`;
}

function list(entries) {
  for (const e of entries.slice(0, top)) {
    console.log(`      ${String(e.count).padStart(5)}  ${e.name}`);
  }
  if (entries.length > top) console.log(`      … ${entries.length - top} more kind(s)`);
}

/** Render copper the way the game says it: "3p 6g 7c", not 3607. */
function coin(copperTotal) {
  const neg = copperTotal < 0;
  let n = Math.abs(copperTotal);
  const parts = [];
  for (const [d, per] of [['p', 1000], ['g', 100], ['s', 10], ['c', 1]]) {
    const q = Math.floor(n / per);
    if (q > 0) parts.push(`${q}${d}`);
    n -= q * per;
  }
  return (neg ? '-' : '') + (parts.join(' ') || '0c');
}

/**
 * Fold every session into one, for the default whole-log view.
 *
 * Note what does NOT happen to experience: segments concatenate, they do not sum. A
 * whole-log view is exactly where the temptation to print one big percentage lives, and
 * it is exactly as meaningless there as it is in one session.
 */
function merge(records) {
  if (records.length === 0) return null;
  if (records.length === 1) return records[0];
  return {
    ...records[0],
    endTs: records[records.length - 1].endTs,
    durationMs: records.reduce((n, r) => n + r.durationMs, 0),
    closeReason: `${records.length} sessions combined`,
    kills: mergeKills(records),
    deaths: records.flatMap((r) => r.deaths),
    loot: mergeLoot(records),
    coin: mergeCoin(records),
    xp: {
      segments: records.flatMap((r) => r.xp.segments),
      levelsGained: sum(records, (r) => r.xp.levelsGained),
      levelsLost: sum(records, (r) => r.xp.levelsLost),
      levelUps: records.flatMap((r) => r.xp.levelUps),
    },
    aa: {
      earned: sum(records, (r) => r.aa.earned),
      spent: sum(records, (r) => r.aa.spent),
      unspent: records[records.length - 1].aa.unspent,
      abilities: records.flatMap((r) => r.aa.abilities),
    },
    faction: rollUp(records.flatMap((r) => r.faction), 'name', (a, b) => ({
      delta: a.delta + b.delta, hits: a.hits + b.hits, cappedAt: b.cappedAt ?? a.cappedAt,
    })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
    skills: {
      ups: rollUp(records.flatMap((r) => r.skills.ups), 'skill', (a, b) => ({
        from: Math.min(a.from, b.from), to: Math.max(a.to, b.to), ups: a.ups + b.ups,
      })).sort((a, b) => b.ups - a.ups),
      tradeskills: countUp(records.flatMap((r) => r.skills.tradeskills)),
    },
    zones: records.flatMap((r) => r.zones),
  };
}

// A function declaration, not a const: `merge()` runs at the top of the file, before a
// const down here would be initialized. Same trap `scripts/replay.js` documents.
function sum(records, pick) {
  return records.reduce((n, r) => n + pick(r), 0);
}

function mergeKills(records) {
  const durationMs = sum(records, (r) => r.durationMs);
  const total = sum(records, (r) => r.kills.total);
  return {
    total,
    mine: sum(records, (r) => r.kills.mine),
    others: sum(records, (r) => r.kills.others),
    perHour: durationMs > 0 ? (total * 3_600_000) / durationMs : null,
    byCreature: countUp(records.flatMap((r) => r.kills.byCreature)),
    byKiller: countUp(records.flatMap((r) => r.kills.byKiller)),
  };
}

function mergeLoot(records) {
  const durationMs = sum(records, (r) => r.durationMs);
  const total = sum(records, (r) => r.loot.total);
  return {
    total,
    perHour: durationMs > 0 ? (total * 3_600_000) / durationMs : null,
    items: countUp(records.flatMap((r) => r.loot.items)),
  };
}

function mergeCoin(records) {
  const durationMs = sum(records, (r) => r.durationMs);
  const purse = (pick) => {
    const out = { platinum: 0, gold: 0, silver: 0, copper: 0, copperTotal: 0 };
    for (const r of records) for (const k of Object.keys(out)) out[k] += pick(r)[k];
    return out;
  };
  const earned = purse((r) => r.coin.earned);
  const spent = purse((r) => r.coin.spent);
  const bySource = new Map();
  for (const r of records) {
    for (const s of r.coin.bySource) {
      const prev = bySource.get(s.source) ?? { source: s.source, platinum: 0, gold: 0, silver: 0, copper: 0, copperTotal: 0 };
      for (const k of ['platinum', 'gold', 'silver', 'copper', 'copperTotal']) prev[k] += s[k];
      bySource.set(s.source, prev);
    }
  }
  return {
    earned,
    spent,
    netCopper: earned.copperTotal - spent.copperTotal,
    copperPerHour: durationMs > 0 ? (earned.copperTotal * 3_600_000) / durationMs : null,
    bySource: [...bySource.values()].sort((a, b) => b.copperTotal - a.copperTotal),
    purchases: records.flatMap((r) => r.coin.purchases),
  };
}

/** Fold `{name, count}` rows from several sessions into one list, biggest first. */
function countUp(rows) {
  const map = new Map();
  for (const r of rows) map.set(r.name, (map.get(r.name) ?? 0) + r.count);
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Fold rows keyed by `key` with a caller-supplied combiner. */
function rollUp(rows, key, combine) {
  const map = new Map();
  for (const r of rows) {
    const prev = map.get(r[key]);
    map.set(r[key], prev ? { [key]: r[key], ...combine(prev, r) } : r);
  }
  return [...map.values()];
}
