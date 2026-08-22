/**
 * The history window: three fixed panes, every click swaps content in place.
 *
 * All selection state (fight, member, metric, chip, search) lives here, renderer-local
 * — main only serves the store over IPC. Rendering is strictly "replaceChildren into a
 * fixed pane": nothing in this file may change a pane's geometry, because content that
 * pushes other content around is exactly the accordion failure this window replaced.
 */

import {
  isBoss, applyFilters, groupByDay,
  pct, accPct, formatRate, formatDuration, timeOfDay, shortDate, readingAge,
} from './organize.js';
// The overlay's pure half. Both windows describe the same fight, so both derive accuracy
// the same way — one of them knowing which attack whiffs and the other not is the kind of
// quiet divergence that makes a player distrust the pair.
import { abilityAccuracy } from '../overlay/breakdown.js';
// The graph's pure half: bucket series in, drawable geometry out. Shared verbatim with
// the mobile page, so a curve on the phone and the same fight's curve here can never
// disagree about what the buckets say.
import {
  ratePerSec, sumSeries, smooth, niceMax, axisTicks, timeTicks, polylinePoints,
} from './timeline.js';

const $ = (id) => document.getElementById(id);
const SKULL = '☠';

const state = {
  characters: [],
  key: null,           // selected character file key
  encounters: [],      // lightweight index, newest first
  chip: 'all',
  search: '',
  fightId: null,
  record: null,        // full record for fightId
  metric: 'damage',
  member: null,        // selected member name within the record
};

init();

async function init() {
  wireEvents();
  await loadCharacter(null);
}

function wireEvents() {
  $('char').addEventListener('change', () => loadCharacter($('char').value));

  $('search').addEventListener('input', () => {
    state.search = $('search').value;
    renderRail({ reveal: true });
  });

  for (const btn of document.querySelectorAll('#chips .chip')) {
    btn.addEventListener('click', () => {
      state.chip = btn.dataset.chip;
      for (const b of document.querySelectorAll('#chips .chip')) {
        b.setAttribute('aria-selected', String(b === btn));
      }
      renderRail({ reveal: true });
    });
  }

  // Live refresh: main announces every fight appended to the store, so a window left
  // open across a raid session shows each fight seconds after it ends instead of a
  // list frozen at whatever moment the window was opened.
  window.api.onAppended(({ key }) => { void refreshList(key); });

  for (const btn of document.querySelectorAll('#metrics .seg')) {
    btn.addEventListener('click', () => setMetric(btn.dataset.metric));
  }

  $('clear').addEventListener('click', async () => {
    const label = $('char').selectedOptions[0]?.textContent ?? 'this character';
    if (!window.confirm(`Delete ALL recorded encounters for ${label}? This cannot be undone.`)) return;
    await window.api.historyClear(state.key);
    await loadCharacter(null);
  });

  // The window is resizable and the canvas is a bitmap: a resize without a redraw
  // leaves the curves stretched. One rAF of debounce keeps a drag from redrawing
  // hundreds of times.
  let resizeRaf = null;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { if (state.record) drawTimeline(); });
  });

  // ↑/↓ walk the filtered fight list. Not while typing in the search box, where the
  // arrows belong to the text cursor.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.target === $('search')) return;
    const shown = filteredEncounters();
    if (shown.length === 0) return;
    const idx = shown.findIndex((f) => f.id === state.fightId);
    const next = idx === -1 ? 0 : Math.min(shown.length - 1, Math.max(0, idx + (e.key === 'ArrowDown' ? 1 : -1)));
    e.preventDefault();
    if (shown[next].id !== state.fightId) selectFight(shown[next].id);
  });
}

async function loadCharacter(key) {
  const r = await window.api.historyList(key ?? null);
  state.characters = r.characters;
  state.key = r.selected;
  state.encounters = r.encounters;
  state.fightId = null;
  state.record = null;
  state.member = null;

  rebuildCharacterOptions();
  renderRail();
}

function rebuildCharacterOptions() {
  $('char').replaceChildren(
    ...state.characters.map((c) => {
      const o = document.createElement('option');
      o.value = c.key;
      o.textContent = c.server ? `${c.character} (${c.server})` : c.character;
      o.selected = c.key === state.key;
      return o;
    })
  );
  $('char').disabled = state.characters.length === 0;
  $('clear').disabled = state.characters.length === 0;
}

/**
 * A fight was just appended to the store (the HISTORY_APPENDED push). Unlike
 * loadCharacter, nothing the user is looking at may be reset: the rail re-renders in
 * place, the selection and filters survive, and panes 2/3 are not touched — except by
 * the sticky-top follow below, which swaps them exactly as a click would.
 *
 * "Sticky top": the window auto-selects the newest fight on open, so a user still
 * sitting on the newest fight they can see is following along live — their selection
 * advances to the fight that just ended. A user parked on an older fight navigated
 * there deliberately, and the new fight only joins the rail.
 */
async function refreshList(key) {
  // A window opened before any history existed has no character selected; the first
  // fight ever recorded is the one moment the full (resetting) load is the right move,
  // because there is nothing on screen to preserve.
  if (state.key === null) {
    await loadCharacter(null);
    return;
  }

  const r = await window.api.historyList(state.key);
  state.characters = r.characters;
  rebuildCharacterOptions();

  // An append for another character changes nothing in this rail — but it may have
  // just created that character's file, which is why the dropdown refreshed above.
  if (key !== state.key) return;

  // "Newest" through the user's current filters — following the top only makes sense
  // for the top the user can actually see.
  const prevNewestShown = filteredEncounters()[0]?.id ?? null;
  state.encounters = r.encounters;
  renderRail();
  const newestShown = filteredEncounters()[0]?.id ?? null;
  if (newestShown && newestShown !== prevNewestShown && state.fightId === prevNewestShown) {
    selectFight(newestShown);
  }
}

function filteredEncounters() {
  return applyFilters(state.encounters, { chip: state.chip, search: state.search });
}

// -------------------------------------------------------------------- rail

function renderRail({ reveal = false } = {}) {
  const shown = filteredEncounters();
  const list = $('fights');

  const foot = $('rail-foot');
  const total = state.encounters.length;
  foot.textContent = shown.length === total
    ? `${total} encounter${total === 1 ? '' : 's'}`
    : `${total} encounters · filtered: ${shown.length}`;

  if (shown.length === 0) {
    const li = document.createElement('li');
    li.className = 'day';
    li.textContent = total === 0
      ? 'No encounters recorded yet. Fights are saved as they end.'
      : 'No fights match.';
    list.replaceChildren(li);
  } else {
    const items = [];
    for (const group of groupByDay(shown)) {
      const day = document.createElement('li');
      day.className = 'day';
      day.textContent = group.dayLabel;
      items.push(day);
      for (const e of group.entries) items.push(buildFightRow(e));
    }
    list.replaceChildren(...items);
  }

  // Keep the selection if it survived the filter; otherwise fall to the newest shown
  // fight, or to the empty pane when nothing is left to show.
  if (shown.some((e) => e.id === state.fightId)) {
    markSelectedRow({ reveal });
  } else if (shown.length > 0) {
    selectFight(shown[0].id);
  } else {
    state.fightId = null;
    state.record = null;
    renderFight();
  }
}

function buildFightRow(e) {
  const li = document.createElement('li');
  li.className = 'fight-row';
  li.dataset.id = e.id;
  li.dataset.trash = String(!isBoss(e));
  li.setAttribute('aria-selected', String(e.id === state.fightId));
  li.addEventListener('click', () => selectFight(e.id));

  const top = document.createElement('div');
  top.className = 'r-top';
  const name = document.createElement('span');
  name.className = 'r-name';
  name.textContent = e.label ?? 'Combat';
  const len = document.createElement('span');
  len.className = 'r-len num';
  len.textContent = formatDuration(e.durationMs);
  top.append(name, len);

  const sub = document.createElement('div');
  sub.className = 'r-sub';
  const when = document.createElement('span');
  when.textContent = e.zone ? `${timeOfDay(e.startTs)} · ${e.zone}` : timeOfDay(e.startTs);
  sub.append(when);
  if (e.deaths > 0) {
    const d = document.createElement('span');
    d.className = 'r-deaths';
    d.textContent = `${SKULL} ${e.deaths}`;
    sub.append(d);
  }

  li.append(top, sub);
  return li;
}

// `reveal` scrolls the selected row into view, and is passed only on an explicit user
// action (a click, the arrow keys, a filter change). A background refresh from a fight
// closing must never move the rail under a user who scrolled away to read something.
function markSelectedRow({ reveal = false } = {}) {
  for (const li of document.querySelectorAll('#fights .fight-row')) {
    const selected = li.dataset.id === state.fightId;
    li.setAttribute('aria-selected', String(selected));
    if (selected && reveal) li.scrollIntoView({ block: 'nearest' });
  }
}

// ------------------------------------------------------------------- fight

async function selectFight(id) {
  state.fightId = id;
  markSelectedRow({ reveal: true });
  state.record = await window.api.historyGet(state.key, id);
  state.member = null;   // a new fight means the old member may not exist here
  renderFight();
}

function renderFight() {
  const empty = $('fight-empty');
  const body = $('fight-body');

  if (!state.record) {
    empty.textContent = state.encounters.length === 0
      ? 'No encounters recorded yet. Fights are saved as they end.'
      : 'Select a fight.';
    empty.hidden = false;
    body.hidden = true;
    return;
  }
  empty.hidden = true;
  body.hidden = false;

  const r = state.record;
  const snap = r.snapshot;

  $('f-name').textContent = r.label ?? 'Combat';
  $('f-meta').textContent = [
    r.zone,
    shortDate(r.startTs),
    formatDuration(r.durationMs),
    `ended by ${r.closeReason ?? 'unknown'}`,
  ].filter(Boolean).join(' · ');

  // The line renders either way — "no deaths" in faint ink, not an absent element —
  // so a death fight and a clean one put the stat strip on the same pixel row.
  const deaths = snap.deaths ?? [];
  const fDeaths = $('f-deaths');
  fDeaths.dataset.none = String(deaths.length === 0);
  fDeaths.textContent = deaths.length === 0 ? 'no deaths' : `${SKULL} ` + deaths
    .map((d) => `${d.name}${d.isPet ? ' (pet)' : ''} — ${d.killer ?? 'unknown'}`)
    .join(' · ');

  const petDeaths = deaths.filter((d) => d.isPet).length;
  $('s-dealt').textContent = snap.totalDamage.toLocaleString();
  $('s-dealt-u').textContent = `${formatRate(snap.groupDps)} dps`;
  $('s-healed').textContent = snap.totalHealing.toLocaleString();
  $('s-healed-u').textContent = `${formatRate(snap.groupHps ?? 0)} hps`;
  $('s-taken').textContent = (snap.totalDamageTaken ?? 0).toLocaleString();
  $('s-taken-u').textContent = `${formatRate(snap.groupDtps ?? 0)} dtps`;
  $('s-deaths').textContent = String(deaths.length - petDeaths);
  $('s-deaths-u').textContent = petDeaths > 0 ? `+${petDeaths} pet` : '';

  renderMembers();
}

// ----------------------------------------------------------------- members

/** Who appears, and how they rank, under each metric — same tests the old tab used. */
const METRIC = {
  damage: {
    colHead: 'dealt · share',
    include: (r) => r.damage > 0 || r.hits > 0,
    rank: (r) => r.damage,
    value: (r) => r.damage,
    share: (r) => r.share,
  },
  healing: {
    colHead: 'healed · share',
    include: (r) => r.heals > 0,
    rank: (r) => r.healing,
    value: (r) => r.healing,
    share: (r) => r.healShare,
  },
  taken: {
    colHead: 'taken · share',
    include: (r) => r.damageTaken > 0 || r.deaths > 0 || r.petDeaths > 0,
    rank: (r) => r.damageTaken,
    value: (r) => r.damageTaken,
    share: (r) => r.takenShare,
  },
};

function setMetric(metric) {
  state.metric = metric;
  document.body.dataset.metric = metric;
  for (const b of document.querySelectorAll('#metrics .seg')) {
    b.setAttribute('aria-selected', String(b.dataset.metric === metric));
  }
  renderMembers();
}

function metricRows() {
  const m = METRIC[state.metric];
  return (state.record?.snapshot.rows ?? [])
    .filter(m.include)
    .sort((a, b) => m.rank(b) - m.rank(a));
}

function renderMembers() {
  const m = METRIC[state.metric];
  const rows = metricRows();
  $('m-cols').textContent = m.colHead;

  // Selection follows the member across metric switches when they appear in both
  // lists; otherwise it falls to the top of the new ranking.
  if (!rows.some((r) => r.name === state.member)) {
    state.member = rows[0]?.name ?? null;
  }

  const max = rows.length > 0 ? Math.max(...rows.map((r) => m.value(r))) : 0;
  $('member-list').replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    li.dataset.name = r.name;
    li.setAttribute('aria-selected', String(r.name === state.member));
    li.addEventListener('click', () => {
      state.member = r.name;
      for (const el of document.querySelectorAll('#member-list li')) {
        el.setAttribute('aria-selected', String(el.dataset.name === r.name));
      }
      drawTimeline();
      renderBreakdown();
    });

    const top = document.createElement('div');
    top.className = 'm-top';
    const name = document.createElement('span');
    name.className = 'm-name';
    name.textContent = r.name;
    top.append(name);
    if (r.deaths > 0) {
      const s = document.createElement('span');
      s.className = 'm-skull';
      s.textContent = SKULL;
      top.append(s);
    }
    const value = document.createElement('span');
    value.className = 'm-value';
    value.textContent = m.value(r).toLocaleString();
    const share = document.createElement('span');
    share.className = 'm-share';
    share.textContent = pct(m.share(r));
    top.append(value, share);

    const bar = document.createElement('div');
    bar.className = 'm-bar';
    const fill = document.createElement('span');
    fill.style.width = max > 0 ? `${(m.value(r) / max) * 100}%` : '0%';
    bar.append(fill);

    li.append(top, bar);
    return li;
  }));

  // The timeline follows the same three inputs the breakdown does — fight, metric,
  // member — and every path that changes one of them funnels through here.
  drawTimeline();
  renderBreakdown();
}

// --------------------------------------------------------------- breakdown

function renderBreakdown() {
  const pane = $('breakdown');
  const row = metricRows().find((r) => r.name === state.member);
  if (!row) {
    const p = document.createElement('p');
    p.className = 'b-empty';
    p.textContent = {
      damage: 'No damage dealt in this fight.',
      healing: 'No healing in this fight.',
      taken: 'Nothing taken in this fight.',
    }[state.metric];
    pane.replaceChildren(p);
    return;
  }

  // Every builder leads with its head line ("Rhale · 1.2M dealt · 12.3k dps · …"), and
  // the /who reading is spliced in directly under it — ONE call site for all three
  // metrics, which is what stops the damage, healing and taken views from drifting into
  // three slightly different answers to the same question about the same person.
  const [head, ...rest] = state.metric === 'damage' ? damageBreakdown(row)
    : state.metric === 'healing' ? healingBreakdown(row)
    : takenBreakdown(row);
  pane.replaceChildren(head, whoLine(row), ...rest);
}

/**
 * What `/who` said about this member, as of this fight.
 *
 * ALWAYS rendered — the trio when the record carries a reading, a faint placeholder when
 * it does not. That is not symmetry for its own sake: this window never reflows, and a
 * line that appears only on the fights that happen to have one would shove the abilities
 * table down by its own height every time the reader clicked a member who had been
 * /who'd. It is the exact failure the deaths line already taught this pane, and the fix
 * is the same one.
 *
 * Records written before this shipped have no `row.who` at all and get the placeholder,
 * which is the honest answer for them too: nobody read a /who into that fight.
 */
function whoLine(row) {
  const p = document.createElement('p');
  p.className = 'b-who';

  const who = row.who;
  if (!who || !(who.classes?.length > 0)) {
    p.classList.add('is-absent');
    p.textContent = 'no /who reading for this fight';
    return p;
  }

  const b = document.createElement('b');
  b.textContent = `${who.level} ${who.classes.join('/')}`;
  // Dated against the pull rather than against now, so the line says what it said that
  // night however long ago that was. Guild is stored on the record but not shown: the
  // names run long enough that one would push the age off the end of the line.
  const bits = [who.race, readingAge(who.ts, state.record?.startTs)].filter(Boolean);
  p.append(b, bits.length > 0 ? ` · ${bits.join(' · ')}` : '');
  return p;
}

// ---------------------------------------------------------------- timeline

/** Which series a metric reads — the same axis names the record stores. */
const TL_SERIES = { damage: 'damage', healing: 'healing', taken: 'taken' };

/** Centered box radius for the drawn curves. Presentation only — the record keeps
 *  the raw buckets, and the phone applies the same radius to the same series. */
const TL_SMOOTH_RADIUS = 2;

/**
 * Draw the fight's curves into the fixed timeline box, or clear it and say why not.
 *
 * Runs on every path that changes what it depends on — fight, metric, member, window
 * size — always into the same 168px box. Records written before timeline buckets
 * existed have no `snapshot.timeline`; they get the faint empty line, never a
 * collapsed panel.
 */
function drawTimeline() {
  const canvas = $('tl-canvas');
  const legend = $('tl-legend');
  const snap = state.record?.snapshot;
  const tl = snap?.timeline;
  const hasData = Boolean(tl && tl.buckets > 0 && tl.bucketMs > 0);
  $('tl-empty').hidden = hasData;

  const box = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(box.width * dpr));
  canvas.height = Math.max(1, Math.round(box.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, box.width, box.height);

  if (!hasData || box.width < 60 || box.height < 30) {
    legend.dataset.member = 'false';
    return;
  }

  const key = TL_SERIES[state.metric];
  const rows = snap.rows ?? [];
  const groupRate = smooth(
    ratePerSec(sumSeries(rows.map((r) => r.timeline?.[key] ?? [])), tl.bucketMs),
    TL_SMOOTH_RADIUS,
  );
  const memberRow = rows.find((r) => r.name === state.member && r.timeline);
  const memberRate = memberRow
    ? smooth(ratePerSec(memberRow.timeline[key], tl.bucketMs), TL_SMOOTH_RADIUS)
    : null;
  legend.dataset.member = String(Boolean(memberRow));
  if (memberRow) $('tl-member').textContent = memberRow.name;

  // Resolved at draw time so the curves follow the metric palette the same way the
  // bars do — getComputedStyle collapses the var() chain to real colors.
  const styles = getComputedStyle(document.body);
  const color = (name) => styles.getPropertyValue(name).trim();

  // Geometry: y labels on the left, time labels under, curves in the rest.
  const AXIS_W = 36;
  const AXIS_H = 16;
  const plotW = box.width - AXIS_W - 4;
  const plotH = box.height - AXIS_H - 6;
  const plotX = AXIS_W;
  const plotY = 4;

  const top = niceMax(Math.max(0, ...groupRate));
  ctx.font = '11px "Bahnschrift", "Segoe UI", sans-serif';

  ctx.strokeStyle = color('--line');
  ctx.fillStyle = color('--ink-faint');
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const tick of axisTicks(top, 3)) {
    const y = plotY + plotH - (tick / top) * plotH;
    ctx.beginPath();
    ctx.moveTo(plotX, Math.round(y) + 0.5);
    ctx.lineTo(plotX + plotW, Math.round(y) + 0.5);
    ctx.stroke();
    // formatRate prints small numbers with a decimal; the axis floor is exactly 0
    // and "0.0" reads as measurement where there is none.
    ctx.fillText(tick === 0 ? '0' : formatRate(tick), plotX - 6, y);
  }

  // The x axis spans the buckets, not durationMs: the curve is spaced by bucket, and
  // a label that used a different clock would drift off its own spike.
  const spanMs = tl.buckets * tl.bucketMs;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const tickMs of timeTicks(spanMs, 6).ticks) {
    const x = plotX + (tickMs / spanMs) * plotW;
    ctx.fillText(formatDuration(tickMs), Math.min(plotX + plotW - 14, Math.max(plotX + 14, x)), plotY + plotH + 5);
  }

  const stroke = (series, colorName, width) => {
    const pts = polylinePoints(series, { width: plotW, height: plotH, max: top });
    if (pts.length === 0) return;
    ctx.strokeStyle = color(colorName);
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(plotX + p.x, plotY + p.y) : ctx.lineTo(plotX + p.x, plotY + p.y)));
    ctx.stroke();
  };
  stroke(groupRate, '--metric', 2);
  if (memberRate) stroke(memberRate, '--metric-lit', 2);
}

function damageBreakdown(r) {
  const head = headLine(r.name, [
    `${r.damage.toLocaleString()} dealt`,
    `${formatRate(r.dps)} dps`,
    `${r.hits} hits`,
    r.crits > 0 && `${r.crits} crits`,
    `max ${r.maxHit.toLocaleString()}`,
    // Always present, zero included, so the head line is the same length on a fight
    // with no procs as on one full of them. `?? 0` covers records written before
    // procs were tracked at all.
    `${(r.procDamage ?? 0).toLocaleString()} proc`,
  ]);
  return [head, heading('Abilities'), table(
    // Accuracy sits beside the counts it is made of. Records written before per-ability
    // misses were tracked have no answer and print a dash rather than a flattering 100%.
    ['ability', 'damage', 'share', 'hits', 'crits', 'acc', 'max'],
    r.abilities.map((a) => ({
      bar: a.damage,
      cells: [
        abilityName(a),
        a.damage.toLocaleString(),
        dim(pct(r.damage > 0 ? a.damage / r.damage : 0)),
        dim(String(a.hits)),
        dim(String(a.crits)),
        dim(accPct(abilityAccuracy(a.hits, a.misses))),
        a.max.toLocaleString(),
      ],
    }))
  )];
}

function healingBreakdown(r) {
  const out = [headLine(r.name, [
    `${r.healing.toLocaleString()} healed`,
    `${formatRate(r.hps)} hps`,
    r.overhealing > 0 && `${r.overhealing.toLocaleString()} overheal`,
    `${r.heals} casts`,
    `max ${r.maxHeal.toLocaleString()}`,
  ])];
  out.push(heading('Heal abilities'), table(
    ['ability', 'healed', 'overheal', 'casts'],
    r.healAbilities.map((a) => ({
      bar: a.healing,
      cells: [
        abilityName(a),
        a.healing.toLocaleString(),
        dim(a.overhealing.toLocaleString()),
        dim(String(a.casts)),
      ],
    }))
  ));
  if (r.healTargets.length > 0) {
    out.push(heading('Healed who'), table(
      ['target', 'healed'],
      r.healTargets.map((t) => ({
        bar: t.healing,
        cells: [t.name, t.healing.toLocaleString()],
      }))
    ));
  }
  return out;
}

function takenBreakdown(r) {
  const died = r.deaths === 0 ? null
    : r.deaths === 1 ? 'died once'
    : r.deaths === 2 ? 'died twice'
    : `died ${r.deaths} times`;
  const out = [headLine(r.name, [
    `${r.damageTaken.toLocaleString()} taken`,
    `${formatRate(r.dtps)} dtps`,
    `max hit ${r.maxHitTaken.toLocaleString()}`,
    r.avoidsTaken > 0 && `avoided ${r.avoidsTaken}`,
    died,
    r.petDeaths > 0 && `pet died ${r.petDeaths > 1 ? `${r.petDeaths} times` : 'once'}`,
  ])];

  out.push(heading('Hit by'), table(
    ['attacker', 'damage', 'hits', 'max'],
    r.attackers.map((a) => ({
      bar: a.damage,
      cells: [a.name, a.damage.toLocaleString(), dim(String(a.hits)), a.max.toLocaleString()],
    }))
  ));

  out.push(heading('With what'), table(
    ['ability', 'damage', 'hits', 'max', 'resist'],
    r.takenAbilities.map((a) => ({
      bar: a.damage,
      cells: [a.name, a.damage.toLocaleString(), dim(String(a.hits)), a.max.toLocaleString(), resistTag(a.type)],
    }))
  ));

  const types = Object.entries(r.takenByType ?? {}).sort((a, b) => b[1] - a[1]);
  if (types.length > 0) {
    const chips = document.createElement('ul');
    chips.className = 'b-chips';
    for (const [type, dmg] of types) {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = type;
      li.append(b, ` ${dmg.toLocaleString()} `, resistTag(type));
      chips.append(li);
    }
    out.push(heading('By damage type'), chips);
  }
  return out;
}

// ------------------------------------------------------ breakdown building

function headLine(name, bits) {
  const p = document.createElement('p');
  p.className = 'b-head';
  const b = document.createElement('b');
  b.textContent = name;
  p.append(b, ' · ' + bits.filter(Boolean).join(' · '));
  return p;
}

function heading(text) {
  const h = document.createElement('h3');
  h.textContent = text;
  return h;
}

/**
 * A grid "table": caption row, then one row per entry with a background bar behind it,
 * normalized to the section's largest entry so the list ranks at a glance. EVERY row
 * is rendered — no top-N, ever; the pane scrolls if a fight had that many abilities.
 */
function table(headers, entries) {
  const list = document.createElement('ul');
  list.className = 'b-table';
  list.style.gridTemplateColumns = `minmax(0, 1fr) repeat(${headers.length - 1}, auto)`;

  const cols = document.createElement('li');
  cols.className = 'cols';
  headers.forEach((h, i) => {
    const s = document.createElement('span');
    s.className = i === 0 ? 'c-name' : 'c-num';
    s.textContent = h;
    cols.append(s);
  });
  list.append(cols);

  const max = entries.reduce((m, e) => Math.max(m, e.bar), 0);
  for (const entry of entries) {
    const li = document.createElement('li');
    li.style.setProperty('--w', max > 0 ? `${(entry.bar / max) * 100}%` : '0%');
    entry.cells.forEach((c, i) => {
      const s = document.createElement('span');
      s.className = i === 0 ? 'c-name' : 'c-num';
      s.append(c instanceof Node ? c : document.createTextNode(String(c)));
      li.append(s);
    });
    list.append(li);
  }
  return list;
}

/** Which resist mitigates which stated type; melee is armor, untyped is unknown. */
const RESISTS = { fire: 'FR', cold: 'CR', magic: 'MR', poison: 'PR', disease: 'DR', corruption: 'Corr' };

function resistTag(type) {
  if (!RESISTS[type]) return document.createTextNode(type === 'melee' ? 'armor' : '—');
  const s = document.createElement('span');
  s.className = 'resist';
  s.textContent = RESISTS[type];
  return s;
}

/**
 * An ability's name cell. Pet and proc are marked on the NAME rather than given
 * columns of their own — the label already reads "Ykesha (pet proc)", so this only has
 * to help the eye group them, and a new column would widen every table in the pane.
 */
function abilityName(a) {
  if (!a.pet && !a.proc) return a.name;
  const s = document.createElement('span');
  s.className = [a.pet && 'pet-tag', a.proc && 'proc-tag'].filter(Boolean).join(' ');
  s.textContent = a.name;
  return s;
}

function dim(text) {
  const s = document.createElement('span');
  s.className = 'c-dim';
  s.textContent = text;
  return s;
}
