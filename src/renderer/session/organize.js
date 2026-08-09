/**
 * Pure list logic for the session window: filtering, day grouping, the category
 * summaries and the shared formatters. No DOM, no Electron — the half of the window that
 * runs under `node --test` in WSL, exactly as `history/organize.js` and `breakdown.js` do.
 *
 * The one rule that makes this file worth reading rather than skimming is at the bottom,
 * in `progressRows`: experience is a per-level ledger and there is no such thing as a
 * session-wide experience total. Everything else here is arithmetic.
 */

/** Apply the rail's chips and search box, preserving the store's order. */
export function applyFilters(entries, { chip = 'all', search = '' } = {}, now = Date.now()) {
  const needle = search.trim().toLowerCase();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  return entries.filter((e) => {
    if (chip === 'week' && !(e.startTs >= weekAgo)) return false;
    if (chip === 'deaths' && !(e.deaths > 0)) return false;
    if (needle) {
      // Zone names and the day, which are the two things a player actually remembers
      // about a night. `e.zones` is a count, not a list — the names are `zoneNames`.
      const haystack = `${(e.zoneNames ?? []).join(' ')} ${dayLabel(e.startTs)}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

/**
 * Group a (newest-first) list into day buckets for the rail's "TODAY · SAT 8 AUG" headers.
 *
 * Order within a group, and of the groups themselves, is the input's — grouping must
 * never re-sort what the store already ordered.
 */
export function groupByDay(entries, now = Date.now()) {
  const groups = [];
  for (const entry of entries) {
    const key = dayKey(entry.startTs);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else groups.push({ key, label: dayHeading(entry.startTs, now), entries: [entry] });
  }
  return groups;
}

/**
 * One rail row's subtitle: what this sitting was, in one line.
 *
 * The deaths clause renders ALWAYS — a faint "no deaths" on a clean night rather than
 * nothing at all. A line that appears only sometimes shifts every row below it by its own
 * height, which is the exact failure the history window already fixed once and the reason
 * this window inherits its no-reflow rule.
 *
 * The session in flight is one of these rows like any other. It differs in exactly two
 * visible ways and both live here rather than in the renderer, so they are unit-tested:
 * the span ends in "now" rather than in a time it has not reached, and `live` is passed
 * through for the marker. Everything else about a live row — the zone, the kills, the coin
 * — is the same sentence about a shorter night.
 */
export function railSummary(entry) {
  return {
    zone: zoneLabel(entry),
    live: entry.live === true,
    range: timeRange(entry.startTs, entry.endTs, { live: entry.live === true }),
    stats: [
      `${entry.kills} kills`,
      `${formatPlatinum(entry.copperEarned)}pp`,
      entry.levelsGained > 0
        ? `${entry.levelsGained} level${entry.levelsGained === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' · '),
    deaths: entry.deaths > 0
      ? `${entry.deaths} death${entry.deaths === 1 ? '' : 's'}`
      : 'no deaths',
    hadDeaths: entry.deaths > 0,
  };
}

/**
 * The night's progress as ONE number: levels gained, and how far into the current one.
 *
 * This slot used to print the current segment's percentage — "+31%" — which is the least
 * useful true statement available. A night that gained four levels and is 31% into a fifth
 * showed "+31%", throwing away the four; and the percentage cannot be added across levels
 * to recover them, so the discarded part was genuinely unrecoverable from what was shown.
 *
 * `4.31` is the whole of it: four levels, plus 31% of the one you are standing in. Below a
 * single level there is no leading digit worth printing, so it falls back to the plain
 * percentage — which is exactly when a percentage IS the useful form.
 *
 * This does not break the no-summing rule. It never adds percentages across a boundary: the
 * integer is a COUNT of level-up lines, and the fraction belongs to one level only. The one
 * softness worth knowing is that a session which began mid-level got part of its first
 * level-up from experience earned before it started — `levelsGained` has always had that
 * property, and the Progress pane is where "started mid-level" is spelled out.
 */
function levelProgress(xp, seg) {
  const gained = xp.levelsGained ?? 0;
  if (gained < 1) {
    if (!seg) return { value: '—', unit: '' };
    return {
      value: `${round(seg.percent, 0)}`,
      unit: seg.level === null ? '%' : `% at ${seg.level}`,
    };
  }
  // Floored, not rounded: 4.99 must never print as "5.00" and claim a level that has not
  // happened. Capped at 99 for the same reason — a segment can read over 100% when the game
  // hands out a chunk of experience larger than the level it lands in.
  const part = Math.min(99, Math.floor(seg?.percent ?? 0));
  return { value: `${gained}.${String(part).padStart(2, '0')}`, unit: 'levels' };
}

/** The four headline numbers above the category list. */
export function headline(record) {
  const seg = currentSegment(record);
  const xp = record.xp ?? { levelsGained: 0 };
  return [
    {
      id: 'kills', label: 'Kills',
      value: formatCount(record.kills?.total ?? 0),
      unit: formatRate(record.kills?.perHour, '/hr'),
    },
    {
      id: 'coin', label: 'Coin',
      value: formatPlatinum(record.coin?.earned?.copperTotal ?? 0),
      unit: `pp${formatRate(coinPlatinumPerHour(record), '/hr', ' · ')}`,
      accent: true,
    },
    {
      id: 'levels', label: 'Levels',
      ...levelProgress(xp, seg),
      accent: true,
    },
    {
      id: 'loot', label: 'Loot',
      value: formatCount(record.loot?.total ?? 0),
      unit: 'items',
    },
  ];
}

/**
 * The middle pane: one row per category, each with a one-line summary.
 *
 * **Order is the answer to "what was this night for", and Progress is first.** The list led
 * with Combat for as long as this window has existed, which meant the detail pane opened on
 * damage every single time — the one question this window is NOT for, since the meter and
 * the History window both answer it better and in more detail. What a session is actually
 * asked about is what it advanced: levels, then what it earned, and kills last because a
 * kill count is the *means* to those rather than the point of them. The first row is also
 * the one selected on open (see `state.category`), so this order decides what you see
 * before you click anything.
 *
 * Combat still comes from `combat`, which the main process derives by summing the encounter
 * records that started inside this session — NOT from anything the session tracker counted.
 * The session module is a sibling of the combat parser precisely so it never scores damage;
 * a second damage pipeline here would be a second answer to one question, able to disagree
 * with the meter.
 *
 * Every row renders even when empty ("nothing recorded"), for the same no-reflow reason
 * the rail's deaths line does: a category that vanishes on a quiet night moves every row
 * under it, and the panes must sit on the same pixel for every session.
 */
export function categories(record, combat = null) {
  const xp = record.xp ?? { segments: [], levelsGained: 0 };
  const aa = record.aa ?? { earned: 0 };
  const seg = currentSegment(record);
  const faction = record.faction ?? [];
  const capped = faction.filter((f) => f.cappedAt).length;
  const zones = record.zones ?? [];

  return [
    {
      id: 'progress',
      label: 'Progress',
      summary: seg || xp.levelsGained > 0 || aa.earned > 0
        ? [
          // Levels lead the summary as well as the list. The percentage is where you are;
          // the level count is what the night was worth, and it is the rarer fact.
          xp.levelsGained > 0 ? `${xp.levelsGained} level${xp.levelsGained === 1 ? '' : 's'}` : null,
          seg ? `+${round(seg.percent, 0)}%${seg.level === null ? '' : ` at ${seg.level}`}` : null,
          aa.earned > 0 ? `${aa.earned} AA` : null,
        ].filter(Boolean).join(' · ')
        : 'nothing recorded',
    },
    {
      id: 'loot',
      label: 'Loot',
      summary: (record.loot?.total ?? 0) > 0
        ? `${record.loot.total} items · ${record.loot.items.length} kinds` +
          formatRate(record.loot.perHour, '/hr', ' · ')
        : 'nothing recorded',
    },
    {
      id: 'coin',
      label: 'Coin',
      summary: (record.coin?.earned?.copperTotal ?? 0) > 0 || (record.coin?.spent?.copperTotal ?? 0) > 0
        ? `${formatCoin(record.coin.earned.copperTotal)} earned` +
          (record.coin.spent.copperTotal > 0 ? ` · ${formatCoin(record.coin.spent.copperTotal)} spent` : '')
        : 'nothing recorded',
    },
    {
      id: 'kills',
      label: 'Kills',
      summary: (record.kills?.total ?? 0) > 0
        ? `${record.kills.total} · ${record.kills.byCreature.length} kinds` +
          formatRate(record.kills.perHour, '/hr', ' · ')
        : 'nothing recorded',
    },
    {
      id: 'combat',
      label: 'Combat',
      summary: combat && combat.encounters > 0
        ? [
          `${formatCount(combat.damage)} dealt`,
          combat.dps === null ? null : `${formatCount(combat.dps)} DPS`,
          combat.accuracy === null ? null : `${Math.round(combat.accuracy * 100)}% acc`,
        ].filter(Boolean).join(' · ')
        : 'no fights recorded',
    },
    {
      id: 'faction',
      label: 'Faction',
      summary: faction.length > 0
        ? `${faction.length} faction${faction.length === 1 ? '' : 's'}` +
          (capped > 0 ? ` · ${capped} at cap` : '')
        : 'nothing recorded',
    },
    {
      id: 'skills',
      label: 'Skills',
      summary: (record.skills?.ups?.length ?? 0) > 0 || (record.skills?.tradeskills?.length ?? 0) > 0
        ? [
          record.skills.ups.length > 0
            ? `${totalUps(record.skills.ups)} skill-ups` : null,
          record.skills.tradeskills.length > 0
            ? `${totalCount(record.skills.tradeskills)} combines` : null,
        ].filter(Boolean).join(' · ')
        : 'nothing recorded',
    },
    {
      id: 'travels',
      label: 'Travels',
      summary: zones.length > 0
        ? `${zones.length} zone${zones.length === 1 ? '' : 's'} · ` +
          (record.deaths?.length
            ? `${record.deaths.length} death${record.deaths.length === 1 ? '' : 's'}`
            : 'no deaths')
        : 'nothing recorded',
    },
  ];
}

/**
 * The detail pane for one category: a heading line and a table of rows.
 *
 * EVERY entry is returned. No top-N slice, no "+N more" — the same rule the overlay's
 * hover panel and the history window's breakdown follow, and for the same reason: a cap
 * is how DoT damage once vanished from a list while still being counted in the total.
 * The window's footer states the count so the promise is visible rather than assumed.
 */
export function detail(record, id, combat = null) {
  switch (id) {
    case 'combat':
      return {
        title: 'Combat',
        lead: combat && combat.encounters > 0
          ? {
            value: formatCount(combat.damage),
            rest: `damage over ${combat.encounters} fight${combat.encounters === 1 ? '' : 's'} · ` +
              `${formatDuration(combat.fightMs)} in combat`,
          }
          : null,
        columns: ['', ''],
        rows: combat && combat.encounters > 0 ? [
          row('Damage dealt', formatCount(combat.damage), `${formatCount(combat.dps ?? 0)} DPS`),
          row('Damage taken', formatCount(combat.damageTaken)),
          row('Healing done', formatCount(combat.healing)),
          row('Accuracy', combat.accuracy === null ? '—' : `${Math.round(combat.accuracy * 100)}%`,
            `${combat.hits} hits · ${combat.misses} misses`),
          row('Criticals', formatCount(combat.crits)),
          row('Group damage', formatCount(combat.groupDamage)),
        ] : [],
        footer: combat && combat.encounters > 0
          ? `summed from ${combat.encounters} encounter(s) in history — measured, not re-counted`
          : 'no encounters in history for this session',
      };

    case 'kills': {
      const k = record.kills ?? { total: 0, byCreature: [], byKiller: [], mine: 0, others: 0 };
      return {
        title: 'Kills',
        lead: k.total > 0
          ? { value: formatCount(k.total), rest: `kills · ${k.byCreature.length} kinds${formatRate(k.perHour, ' per hour', ' · ')}` }
          : null,
        columns: ['Creature', 'Qty'],
        rows: k.byCreature.map((c) => row(c.name, String(c.count))),
        footer: k.total > 0
          ? `${k.byCreature.length} of ${k.byCreature.length} kinds shown — nothing truncated` +
            (k.others > 0 ? ` · ${k.others} more killed by others in zone, not counted as ours` : '')
          : 'nothing recorded',
      };
    }

    case 'loot': {
      const l = record.loot ?? { total: 0, items: [] };
      return {
        title: 'Loot',
        lead: l.total > 0
          ? { value: formatCount(l.total), rest: `items · ${l.items.length} kinds${formatRate(l.perHour, ' per hour', ' · ')}` }
          : null,
        columns: ['Item', 'Qty'],
        rows: l.items.map((i) => row(i.name, String(i.count))),
        footer: l.total > 0
          ? `${l.items.length} of ${l.items.length} kinds shown — nothing truncated`
          : 'nothing recorded',
      };
    }

    case 'coin': {
      const c = record.coin ?? { earned: { copperTotal: 0 }, spent: { copperTotal: 0 }, bySource: [], purchases: [] };
      return {
        title: 'Coin',
        lead: c.earned.copperTotal > 0
          ? { value: formatPlatinum(c.earned.copperTotal), rest: `platinum earned${formatRate(coinPlatinumPerHour(record), ' per hour', ' · ')}` }
          : null,
        columns: ['Source', 'Amount'],
        rows: [
          ...c.bySource.map((s) => row(SOURCE_LABEL[s.source] ?? s.source, formatCoin(s.copperTotal))),
          ...(c.spent.copperTotal > 0
            ? [row('Spent', `−${formatCoin(c.spent.copperTotal)}`, `${c.purchases.length} purchase(s)`)]
            : []),
          row('Net', formatCoin(c.netCopper ?? 0)),
        ],
        footer: 'exact to the copper — every amount came out of your own log',
      };
    }

    case 'progress':
      return progressDetail(record);

    case 'faction': {
      const f = record.faction ?? [];
      return {
        title: 'Faction',
        lead: f.length > 0
          ? { value: String(f.length), rest: `standings moved · ${f.filter((x) => x.cappedAt).length} at cap` }
          : null,
        columns: ['Faction', 'Change'],
        rows: f.map((x) => row(
          x.name,
          x.cappedAt ? '—' : signed(x.delta),
          x.cappedAt ? `capped ${x.cappedAt} · ${x.hits} hits` : `${x.hits} hits`,
        )),
        // A cap is not a delta, and printing it as 0 would say "nothing changed" about a
        // faction you spent all night grinding. Explained only when there IS one on
        // screen: a note about a symbol nobody can see is noise.
        footer: f.some((x) => x.cappedAt)
          ? 'a capped standing shows — rather than 0: the log states a cap, not an amount'
          : `${f.length} of ${f.length} standings shown — nothing truncated`,
      };
    }

    case 'skills': {
      const s = record.skills ?? { ups: [], tradeskills: [] };
      return {
        title: 'Skills',
        lead: s.ups.length > 0
          ? { value: String(totalUps(s.ups)), rest: `skill-ups across ${s.ups.length} skill(s)` }
          : null,
        columns: ['Skill', 'Gain'],
        rows: [
          ...s.ups.map((k) => row(k.skill, `${k.from} → ${k.to}`, `${k.ups} ups`)),
          ...s.tradeskills.map((t) => row(t.name, String(t.count), 'fashioned')),
        ],
        // The number EQ prints is the new VALUE, not the gain — so this reports where the
        // skill started and where it ended, never a sum of the printed numbers.
        footer: 'from the first value seen to the last — the log prints the new value, not the gain',
      };
    }

    case 'travels': {
      const z = record.zones ?? [];
      const deaths = record.deaths ?? [];
      return {
        title: 'Travels',
        lead: z.length > 0 ? { value: String(z.length), rest: 'zones visited' } : null,
        columns: ['Zone', 'Time'],
        rows: [
          ...z.map((v) => row(v.zone, formatDuration(v.ms), timeOfDay(v.enterTs))),
          ...deaths.map((d) => row(`Died to ${d.killer}`, timeOfDay(d.ts), null, 'death')),
        ],
        footer: deaths.length > 0
          ? `${deaths.length} death${deaths.length === 1 ? '' : 's'} this session`
          : 'no deaths this session',
      };
    }

    default:
      return { title: '', lead: null, columns: ['', ''], rows: [], footer: '' };
  }
}

/**
 * The Progress pane, and the one place in this window where the honesty rule is visible.
 *
 * EverQuest prints experience as a percentage OF THE CURRENT LEVEL and nothing else.
 * Summing those across a level boundary produces a number that describes nothing — 12% at
 * 27 and 12% at 28 are different amounts of experience — so this pane lists one row per
 * level and carries an explicit dash where a session total would go, with the reason in
 * plain words underneath. If a single summed percentage ever appears here, this window has
 * been got wrong.
 *
 * Time-to-level appears only on an ANCHORED segment — one that began with a level-up, and
 * therefore at a known 0%. A session that started mid-level knows what was gained and not
 * how far in it began, so it says so instead of extrapolating.
 */
function progressDetail(record) {
  const xp = record.xp ?? { segments: [], levelsGained: 0, levelsLost: 0 };
  const aa = record.aa ?? { earned: 0, spent: 0, abilities: [] };
  const seg = currentSegment(record);

  return {
    title: 'Progress',
    lead: seg
      ? {
        value: `+${round(seg.percent, 0)}%`,
        rest: `${seg.level === null ? 'this level' : `at level ${seg.level}`}` +
          formatRate(seg.percentPerHour, '% per hour', ' · '),
      }
      : null,
    columns: ['Level', 'Gain'],
    rows: [
      ...progressRows(xp),
      {
        name: 'Per level, never summed',
        value: '—',
        sub: 'the log prints no absolute XP — 1% at 27 is not 1% at 28',
        kind: 'note',
      },
      /**
       * Levels gained, as a count, beside the ability points.
       *
       * The segment rows above list what each level EARNED — "+99%", "15:47 in level" —
       * and never state how many levels the night was worth. Reading it off them means
       * counting rows and knowing that the first one is a level you were already in, which
       * is arithmetic the pane should be doing. Ability points had a row of their own and
       * levels did not, which made the rarer and larger event the harder one to find.
       *
       * Placed before the ability points for the same reason it outranks them on the meter
       * line: a level is the bigger event of the two.
       */
      ...(xp.levelsGained > 0 || xp.levelsLost > 0 ? [{
        name: 'Levels',
        value: String(xp.levelsGained),
        sub: [
          xp.levelUps?.length > 0
            ? `reached level ${xp.levelUps[xp.levelUps.length - 1].level}`
            : null,
          // A de-level is rare enough to be worth stating outright rather than netting
          // away — the count above is gross, and silence would make it look like it was not.
          xp.levelsLost > 0
            ? `${xp.levelsLost} lost` : null,
        ].filter(Boolean).join(' · '),
        kind: 'level',
      }] : []),
      ...(aa.earned > 0 || aa.abilities.length > 0 ? [{
        name: 'Ability points',
        value: String(aa.earned),
        // Spending more than was earned is not a bug and is common: points bank across
        // sessions, so a night can spend what a previous one saved.
        sub: `${aa.earned} earned · ${aa.spent} spent this session`,
        kind: 'aa',
      }] : []),
      // One row per ability rather than their names run together. A single session in the
      // live log bought thirteen; joined with separators that is an unreadable paragraph
      // pretending to be a value, and this is a list, so it lists.
      ...aa.abilities.map((a) => ({
        name: a.name,
        value: a.cost === 0 ? 'free' : `−${a.cost}`,
        sub: a.improved ? 'rank up' : 'new ability',
        kind: 'aa-spend',
      })),
    ],
    footer: [
      xp.levelsGained > 0 ? `${xp.levelsGained} level${xp.levelsGained === 1 ? '' : 's'}` : null,
      aa.earned > 0 ? `${aa.earned} ability point${aa.earned === 1 ? '' : 's'}` : null,
      (record.skills?.ups?.length ?? 0) > 0 ? `${totalUps(record.skills.ups)} skill-ups` : null,
    ].filter(Boolean).join(' · ') || 'nothing recorded',
  };
}

/** One row per experience segment. Never a total — see progressDetail. */
export function progressRows(xp) {
  const segments = xp?.segments ?? [];
  return segments.map((seg, i) => {
    const isLast = i === segments.length - 1;
    const name = seg.level === null ? 'This level' : `Level ${seg.level}`;
    const bits = [];
    if (!seg.anchored) bits.push('started mid-level');
    if (seg.ms > 0) bits.push(`${formatDuration(seg.ms)} in level`);
    if (seg.timeToLevelMs !== null && seg.timeToLevelMs !== undefined) {
      bits.push(`${formatDuration(seg.timeToLevelMs)} to ${(seg.level ?? 0) + 1}`);
    } else if (isLast && !seg.anchored) {
      // Named rather than left blank: "we cannot compute this" and "this is zero" must
      // never look the same.
      bits.push('no time-to-level — the log never said where this level started');
    }
    return {
      name,
      value: `+${round(seg.percent, 0)}%`,
      sub: bits.join(' · '),
      kind: isLast ? 'current' : 'past',
    };
  });
}

// ------------------------------------------------------------------------- formatters

const SOURCE_LABEL = {
  corpse: 'From corpses',
  sale: 'Sold to merchants',
  item: 'From items',
  split: 'Group split',
};

/** The segment experience is currently landing in — the last one, or null. */
export function currentSegment(record) {
  const segments = record?.xp?.segments ?? [];
  return segments.length ? segments[segments.length - 1] : null;
}

function coinPlatinumPerHour(record) {
  const perHour = record?.coin?.copperPerHour;
  return perHour === null || perHour === undefined ? null : perHour / 1000;
}

function row(name, value, sub = null, kind = null) {
  return { name, value, sub, kind };
}

function totalUps(ups) {
  return ups.reduce((n, k) => n + k.ups, 0);
}

function totalCount(rows) {
  return rows.reduce((n, r) => n + r.count, 0);
}

/** "1.2k", "412k", "1.5M" — the overlay's own scale, so the two windows read alike. */
export function formatCount(n) {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 1000)}k`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

/**
 * Copper as the game says it: "3p 4g 1s 8c", never 3418.
 *
 * Every denomination the amount actually contains, unlike the meter's session line which
 * shows two — this window has the room, and the exact purse is the reason to open it.
 */
export function formatCoin(copperTotal) {
  const neg = copperTotal < 0;
  let rest = Math.abs(Math.round(Number(copperTotal) || 0));
  const parts = [];
  for (const [suffix, per] of [['p', 1000], ['g', 100], ['s', 10], ['c', 1]]) {
    const q = Math.floor(rest / per);
    rest -= q * per;
    if (q > 0) parts.push(`${q}${suffix}`);
  }
  return (neg ? '−' : '') + (parts.join(' ') || '0c');
}

/** Platinum with one decimal — the unit a camp's worth is actually discussed in. */
export function formatPlatinum(copperTotal) {
  const pp = (Number(copperTotal) || 0) / 1000;
  if (Math.abs(pp) >= 1000) return `${Math.round(pp)}`;
  if (Math.abs(pp) >= 100) return pp.toFixed(0);
  return pp.toFixed(1);
}

/** M:SS, or H:MM:SS past an hour — the same shape timestamp.js uses. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "4h 36m" — the rail's coarser unit, because a session is not a fight. */
export function formatSpan(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 60000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** A rate, or nothing at all when there is not enough elapsed time to mean anything. */
export function formatRate(n, unit, prefix = ' ') {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  return `${prefix}${round(n, 1)}${unit}`;
}

function round(n, places) {
  const v = Number(n) || 0;
  return places === 0 ? String(Math.round(v)) : String(Number(v.toFixed(places)));
}

function signed(n) {
  const v = Math.round(Number(n) || 0);
  return v > 0 ? `+${v}` : String(v);
}

export function timeOfDay(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * "09:12 – 13:48" — a sitting is a span, and both ends matter.
 *
 * A session still running has no end, and printing one is not a formatting detail: the
 * record in flight carries `endTs = now`, so the honest-looking "09:12 – 13:48" would
 * state as fact that the night finished at the moment you happened to look at it. "– now"
 * is the only end this session has.
 */
export function timeRange(startTs, endTs, { live = false } = {}) {
  return `${timeOfDay(startTs)} – ${live ? 'now' : timeOfDay(endTs)}`;
}

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function dayLabel(ts) {
  const d = new Date(ts);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "TODAY · SAT 8 AUG" for today, plain "FRI 7 AUG" otherwise. */
export function dayHeading(ts, now = Date.now()) {
  const label = dayLabel(ts);
  return dayKey(ts) === dayKey(now) ? `TODAY · ${label}` : label;
}

/** Where a session was spent: the zones it visited, longest first, at most two named. */
export function zoneLabel(entry) {
  if (typeof entry.zoneLabel === 'string') return entry.zoneLabel;
  const zones = entry.zoneNames ?? [];
  if (zones.length === 0) return 'Unknown';
  if (zones.length <= 2) return zones.join(', ');
  return `${zones.slice(0, 2).join(', ')} +${zones.length - 2}`;
}

/**
 * How a session closed, in words rather than a key.
 *
 * 'recovered' is the one worth spelling out: it means the app went down without closing
 * this session, so the minutes between its last checkpoint and the crash are genuinely
 * missing. Printing it as "closed" would quietly assert data we do not have.
 */
export function closeReasonLabel(reason) {
  return {
    idle: 'closed by 60m idle',
    character: 'closed by character switch',
    shutdown: 'closed when the overlay quit',
    disabled: 'closed when tracking was switched off',
    recovered: 'recovered after a crash — the last few minutes are missing',
    imported: 'imported from a log file',
    manual: 'closed by hand',
    open: 'still running',
  }[reason] ?? reason;
}
