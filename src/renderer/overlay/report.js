/**
 * The meter as one line of chat.
 *
 * This module answers two questions, and they are deliberately the same module because
 * the feature's whole claim is that the copied line says exactly what the meter says.
 *
 *   rowsForMetric — which rows the current metric shows, and in what order
 *   chatReport    — those rows as one pasteable line
 *
 * `render()` in overlay.js calls `rowsForMetric` too. That is the point: there is one
 * row-selection in the codebase, so "the copy matches the screen" holds by construction
 * rather than by two implementations being kept in step. The failure mode of the
 * alternative is silent — the copied line disagrees with the meter and nobody finds out
 * until it has been pasted into guild chat.
 *
 * No DOM and no Electron here, so `node --test` exercises the interesting half — the
 * ranking, the wording and the shrink ladder — in WSL, the same bargain `breakdown.js`,
 * `layout.js` and `organize.js` already make.
 */

/**
 * Field names for the metric on screen.
 *
 * All three metrics are rendered by exactly the same code — only the fields it reads
 * differ. Rows are always sorted by damage on arrival, so the other views re-sort.
 *
 * This lives here rather than in overlay.js because the chat line reads the same fields
 * the rows do; a second copy of the map is a second thing to get wrong when a metric is
 * added.
 */
export const METRICS = {
  damage: { total: 'damage', rate: 'dps', rolling: 'rollingDps', share: 'share', unit: 'dps', group: 'groupDps' },
  healing: { total: 'healing', rate: 'hps', rolling: 'rollingHps', share: 'healShare', unit: 'hps', group: 'groupHps' },
  taken: { total: 'damageTaken', rate: 'dtps', rolling: 'rollingDtps', share: 'takenShare', unit: 'dtps', group: 'groupDtps' },
};

export const METRIC_CYCLE = ['damage', 'healing', 'taken'];

/**
 * How many characters EverQuest's chat input takes.
 *
 * An ASSUMPTION, not something the log or the client tells us: it is classic
 * EverQuest's limit and the entire reason the shrink ladder below exists. It is one
 * named constant so a measured value replaces it in a single edit — worth measuring
 * in-game once, since a too-low guess costs percentages nobody needed to lose.
 */
export const CHAT_LIMIT = 255;

/**
 * The separator between the fight header and the ranking.
 *
 * EQ's chat is latin1 and prints `|` fine; an em dash is riskier — it is 0x97 in
 * Windows-1252 rather than anything in ISO-8859-1 proper — so if a pasted line ever
 * shows a mangled character this is the first thing to swap for a plain `-`. Named for
 * exactly that reason.
 */
const DASH = '—';

/**
 * The rows the meter is showing, in the order it is showing them.
 *
 * Damage needs no work: the parser sorts rows by damage on the way out and every row it
 * emits was credited with something. The other two views are filters with their own
 * sort, and each filter is a judgement:
 *
 *   healing — `heals > 0`, the CAST count, not the healed total. A healer whose every
 *             point was overheal still cast, still spent mana, and still belongs in the
 *             list; keyed on `healing` they would vanish from the view that exists to
 *             show them.
 *   taken   — a death keeps a row visible at zero damage taken. Dying is the one fact
 *             this view must never hide.
 *
 * @param {Object|null} snap
 * @param {'damage'|'healing'|'taken'} metric
 */
export function rowsForMetric(snap, metric) {
  const rows = snap?.rows ?? [];
  if (metric === 'healing') {
    return rows.filter((r) => r.heals > 0).sort((a, b) => b.healing - a.healing);
  }
  if (metric === 'taken') {
    return rows
      .filter((r) => r.damageTaken > 0 || r.deaths > 0 || r.petDeaths > 0)
      .sort((a, b) => b.damageTaken - a.damageTaken);
  }
  return rows;
}

/**
 * What the line looks like at each rung of the ladder, worst-case last.
 *
 * Read top to bottom, this is the order in which the line gives things up, and the order
 * is an argument about what a reader of the pasted line actually needs. Shares go first
 * because they are derivable from the numbers already beside them. The group total goes
 * next for the same reason — it is the sum. Third goes everything else the reader can
 * reconstruct: the `1)` rank prefixes, which say what the left-to-right order already
 * says, and the last two digits of a five-figure rate. The fight's name and duration go
 * fourth, leaving the bare ranking that was asked for.
 *
 * The rank prefixes are that third rung because the obvious candidate does not work.
 * Abbreviating rates the way the meter's own `formatNumber` does — `1234` into `1.2k` —
 * costs exactly as many characters as it saves at every magnitude (`12345` into `12.3k`
 * likewise), so a rung built on it would be inert: it would shrink nothing and hand the
 * overrun straight to the rung that drops people. Dropping `1) ` saves three characters
 * per member with nothing lost, which is what this rung was for.
 *
 * Names never degrade. A line that abbreviated "Khanvikt" would be a line nobody can act
 * on, and dropping members entirely (stage 5, below) is honest in a way a truncated name
 * is not — it says out loud that it dropped them.
 */
const STAGES = [
  { header: true, shares: true, ranks: true, tail: true, abbrev: false },
  { header: true, shares: false, ranks: true, tail: true, abbrev: false },
  { header: true, shares: false, ranks: true, tail: false, abbrev: false },
  { header: true, shares: false, ranks: false, tail: false, abbrev: true },
  { header: false, shares: false, ranks: false, tail: false, abbrev: true },
];

/** The index the last-resort member drop reports as, one past the table above. */
const DROP_STAGE = STAGES.length;

/**
 * The current fight as one line, shrunk until it fits a chat message.
 *
 * Returns the text plus what it cost to get there, because the caller has to be able to
 * say so: `stage > 0` means something was given up, and `shown < total` means members
 * were dropped, which is the one outcome a player must be told about rather than
 * discovering in guild chat.
 *
 * An empty roster returns an empty string and nothing else happens — the caller leaves
 * the clipboard alone. Wiping whatever the player had copied, to replace it with an
 * empty meter, would be the worst possible outcome of pressing a button labelled COPY.
 *
 * @param {Object|null} snap    a parser snapshot
 * @param {string} metric       'damage', 'healing' or 'taken'
 * @param {{ limit?: number }} [opts]
 * @returns {{ text: string, total: number, shown: number, stage: number }}
 */
export function chatReport(snap, metric, { limit = CHAT_LIMIT } = {}) {
  const key = METRICS[metric] ? metric : 'damage';
  const rows = rowsForMetric(snap, key);
  const total = rows.length;
  if (!snap || total === 0) return { text: '', total: 0, shown: 0, stage: 0 };

  for (let stage = 0; stage < STAGES.length; stage++) {
    const text = compose(snap, key, rows, { ...STAGES[stage], count: total });
    if (text.length <= limit) return { text, total, shown: total, stage };
  }

  // Last resort: drop members from the bottom of the ranking until the line fits, and
  // say so on the line itself. Walked one at a time rather than solved arithmetically
  // because `+N more` can cost more characters than the member it replaced — a roster
  // going from `+9 more` to `+10 more` grows the line by one while shrinking it by a
  // name — so the only reliable test is composing it and measuring.
  const floor = STAGES[STAGES.length - 1];
  for (let count = total - 1; count >= 1; count--) {
    const text = compose(snap, key, rows, { ...floor, count });
    if (text.length <= limit) return { text, total, shown: count, stage: DROP_STAGE };
  }

  // One member and a number still overruns — which needs a name long enough that no
  // format saves it. Send it anyway: an over-length line is the player's to trim, and a
  // button that silently refuses is worse.
  return {
    text: compose(snap, key, rows, { ...floor, count: 1 }),
    total,
    shown: 1,
    stage: DROP_STAGE,
  };
}

/**
 * One rung of the ladder, rendered.
 *
 * `Vessel of Terror 2:14 — 1) Rhale 1234 (34%) 2) Emalina 980 (27%) | group 2214 dps`
 */
function compose(snap, metric, rows, { header, shares, ranks, tail, abbrev, count }) {
  const m = METRICS[metric];

  const parts = rows.slice(0, count).map((row, i) => {
    const rank = ranks ? `${i + 1}) ` : '';
    const rate = formatRate(row[m.rate], abbrev);
    const share = shares ? ` (${formatSharePct(row[m.share])})` : '';
    return `${rank}${row.name} ${rate}${share}`;
  });
  if (count < rows.length) parts.push(`+${rows.length - count} more`);

  const head = header
    ? `${snap.label ?? 'Combat'} ${formatDuration(snap.durationMs ?? 0)} ${DASH}`
    : '';
  const tails = tail ? tailSegments(snap, metric, abbrev) : [];

  return [head, parts.join(' ')].filter(Boolean).join(' ')
    + tails.map((t) => ` | ${t}`).join('');
}

/**
 * What rides at the end of the line: the group rate, and — in the taken view only —
 * who died.
 *
 * The deaths segment is not decoration. A taken-damage line reports what the fight did
 * to the group, and one that lists the damage while omitting that two people hit the
 * floor is telling the misleading half of the story. It sits on the same rung as the
 * group total so a line that has room for one has room for both.
 *
 * Pet deaths are excluded, for the same reason the breakdown counts them separately:
 * "you died" must mean the player hit the floor.
 */
function tailSegments(snap, metric, abbrev) {
  const m = METRICS[metric];
  const segments = [`group ${formatRate(snap[m.group] ?? 0, abbrev)} ${m.unit}`];

  if (metric === 'taken') {
    const names = new Set();
    for (const death of snap.deaths ?? []) {
      if (!death.isPet) names.add(death.name);
    }
    if (names.size > 0) segments.push(`deaths: ${[...names].join(', ')}`);
  }
  return segments;
}

/**
 * A rate, plainly or abbreviated.
 *
 * The abbreviated form is deliberately NOT the meter's `formatNumber` — `12345` into
 * `12.3k` is five characters either way, so it would shrink nothing. Dropping the
 * decimal does shorten, but only above ten thousand is the rounding honest enough to
 * print: `12k` for 12,345 is a 3% claim, while `1k` for 1,234 would be a 20% one and
 * would flatten two members half a thousand DPS apart onto the same figure. Four-figure
 * rates therefore stay exact at every rung, and this rung buys its characters from the
 * rank prefixes instead.
 */
function formatRate(n, abbrev) {
  if (!Number.isFinite(n)) return '0';
  const v = Math.max(0, Math.round(n));
  if (abbrev && v >= 10_000) return `${Math.round(v / 1000)}k`;
  return String(v);
}

function formatSharePct(fraction) {
  if (!Number.isFinite(fraction)) return '0%';
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Elapsed time as the meter prints it — `2:14`, or `1:02:14` past the hour.
 *
 * Shared with the overlay rather than copied for the same reason METRICS is: the header
 * of the copied line and the elapsed time on screen are a claim about one fight, and two
 * formatters are two chances for them to disagree.
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
