/**
 * The second screen: a phone-shaped view of the same facts the overlay renders.
 *
 * All data arrives over plain HTTP from the overlay's own server (src/main/mobile.js):
 * the live view rides the SSE stream — a lean snapshot per push, timeline buckets as
 * deltas — and the history views fetch the same JSONL-backed answers the History
 * window gets over IPC. The pure modules are imported from their home directories
 * unchanged, which is the point: a curve here and the same fight's curve on the
 * desktop can never disagree, because they are the same arithmetic.
 *
 * This page holds view state only (which tab, which metric, which row is open); every
 * number on it came from the wire.
 */

import {
  ratePerSec, sumSeries, smooth, niceMax, axisTicks, timeTicks, polylinePoints,
} from '../history/timeline.js';
import {
  isBoss, applyFilters, groupByDay, pct, formatRate, formatDuration, timeOfDay, shortDate,
} from '../history/organize.js';
import { splitShares } from '../overlay/breakdown.js';

const $ = (id) => document.getElementById(id);
const SKULL = '☠';

/** The pairing token, straight off the QR code's URL; every request carries it. */
const token = new URLSearchParams(location.search).get('t') ?? '';
const api = (path) => fetch(`${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`);

/** Same smoothing the History window draws with — one look, two screens. */
const TL_SMOOTH_RADIUS = 2;

/** Who appears and how they rank under each metric — the History window's tests. */
const METRIC = {
  damage: {
    include: (r) => r.damage > 0 || r.hits > 0,
    value: (r) => r.damage,
    rate: (r) => r.dps,
    share: (r) => r.share,
    groupRate: (s) => s.groupDps,
    unit: 'dps',
  },
  healing: {
    include: (r) => r.heals > 0,
    value: (r) => r.healing,
    rate: (r) => r.hps,
    share: (r) => r.healShare,
    groupRate: (s) => s.groupHps,
    unit: 'hps',
  },
  taken: {
    include: (r) => r.damageTaken > 0 || r.deaths > 0 || r.petDeaths > 0,
    value: (r) => r.damageTaken,
    rate: (r) => r.dtps,
    share: (r) => r.takenShare,
    groupRate: (s) => s.groupDtps,
    unit: 'dtps',
  },
};

const state = {
  view: 'live',        // 'live' | 'history' | 'fight'
  metric: 'damage',
  snapshot: null,      // last lean snapshot off the stream
  tl: null,            // assembled live timeline: {key, bucketMs, rows: Map, upTo}
  expanded: null,      // live row whose breakdown is open
  index: null,         // /api/history response
  chip: 'all',
  search: '',
  record: null,        // fight view record
  fightMember: null,   // selected member in the fight view
};

init();

function init() {
  for (const btn of document.querySelectorAll('#tabbar button')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.view === 'history') void openHistory();
      else switchView('live');
    });
  }
  for (const btn of document.querySelectorAll('#metrics .seg')) {
    btn.addEventListener('click', () => {
      state.metric = btn.dataset.metric;
      document.body.dataset.metric = state.metric;
      for (const b of document.querySelectorAll('#metrics .seg')) {
        b.setAttribute('aria-selected', String(b === btn));
      }
      renderLive();
      drawLiveGraph();
    });
  }
  $('hist-search').addEventListener('input', () => {
    state.search = $('hist-search').value;
    renderHistoryList();
  });
  for (const chip of document.querySelectorAll('#hist-chips .chip')) {
    chip.addEventListener('click', () => {
      state.chip = chip.dataset.chip;
      for (const c of document.querySelectorAll('#hist-chips .chip')) {
        c.setAttribute('aria-selected', String(c === chip));
      }
      renderHistoryList();
    });
  }
  $('fight-back').addEventListener('click', () => switchView('history'));

  let raf = null;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (state.view === 'live') drawLiveGraph();
      if (state.view === 'fight') drawFightGraph();
    });
  });

  connect();
}

/**
 * The stream. EventSource reconnects by itself (the server asks for 3s), and every
 * reconnect gets the full greeting — snapshot plus complete timeline — so a phone
 * whose screen slept through half the fight comes back whole, not holey.
 */
function connect() {
  const es = new EventSource(`/events?t=${encodeURIComponent(token)}`);
  es.onopen = () => { $('live-dot').dataset.connected = 'true'; };
  es.onerror = () => { $('live-dot').dataset.connected = 'false'; };
  es.addEventListener('snapshot', (e) => {
    state.snapshot = JSON.parse(e.data);
    if (state.view === 'live') renderLive();
  });
  es.addEventListener('timeline', (e) => {
    applyTimeline(JSON.parse(e.data));
    if (state.view === 'live') drawLiveGraph();
  });
}

/**
 * Fold one timeline event into the assembled series. `reset` (or a cursor key this
 * client has not seen) replaces everything — a new pull, or a fight that coarsened
 * and reindexed every bucket under us.
 */
function applyTimeline(d) {
  const key = `${d.startTs}:${d.bucketMs}`;
  if (d.reset || !state.tl || state.tl.key !== key) {
    state.tl = { key, bucketMs: d.bucketMs, rows: new Map(), upTo: 0 };
  }
  for (const [name, series] of Object.entries(d.rows)) {
    let row = state.tl.rows.get(name);
    if (!row) {
      row = { damage: [], healing: [], taken: [] };
      state.tl.rows.set(name, row);
    }
    for (const k of ['damage', 'healing', 'taken']) {
      for (let i = 0; i < series[k].length; i++) row[k][d.from + i] = series[k][i];
    }
  }
  state.tl.upTo = d.upTo;
}

function switchView(view) {
  state.view = view;
  $('view-live').hidden = view !== 'live';
  $('view-history').hidden = view !== 'history';
  $('view-fight').hidden = view !== 'fight';
  for (const btn of document.querySelectorAll('#tabbar button')) {
    btn.setAttribute('aria-selected', String(
      btn.dataset.view === (view === 'fight' ? 'history' : view),
    ));
  }
  if (view === 'live') { renderLive(); drawLiveGraph(); }
}

// --------------------------------------------------------------------- live

function renderLive() {
  const s = state.snapshot;
  const m = METRIC[state.metric];
  if (!s) return;

  $('live-name').textContent = s.idle ? 'No combat yet' : (s.label ?? 'Combat');
  $('live-timer').textContent = s.idle ? '' : formatDuration(s.durationMs);
  const bits = [s.zone, s.idle ? null : `group ${formatRate(m.groupRate(s) ?? 0)} ${m.unit}`,
    s.idle || s.active ? null : 'ended'];
  $('live-sub').textContent = bits.filter(Boolean).join(' · ');

  const rows = (s.rows ?? []).filter(m.include).sort((a, b) => m.value(b) - m.value(a));
  const max = rows.length > 0 ? Math.max(...rows.map((r) => m.value(r))) : 0;
  $('live-rows').replaceChildren(...rows.map((r) => buildLiveRow(r, m, max)));
}

function buildLiveRow(r, m, max) {
  const li = document.createElement('li');
  li.className = 'row-card';
  li.setAttribute('aria-selected', String(r.name === state.expanded));

  const top = document.createElement('div');
  top.className = 'row-top';
  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = r.name;
  top.append(name);
  if (r.deaths > 0) {
    const sk = document.createElement('span');
    sk.className = 'row-skull';
    sk.textContent = SKULL;
    top.append(sk);
  }
  const value = document.createElement('span');
  value.className = 'row-value';
  value.textContent = formatRate(m.rate(r));
  const share = document.createElement('span');
  share.className = 'row-share';
  share.textContent = pct(m.share(r));
  top.append(value, share);

  const bar = document.createElement('div');
  bar.className = 'row-bar';
  const fill = document.createElement('span');
  fill.style.width = max > 0 ? `${(m.value(r) / max) * 100}%` : '0%';
  bar.append(fill);

  li.append(top, bar);
  if (r.name === state.expanded) li.append(buildBreakdown(r));

  li.addEventListener('click', () => {
    state.expanded = state.expanded === r.name ? null : r.name;
    renderLive();
  });
  return li;
}

/**
 * The tapped-open breakdown, inside the row card. EVERY entry renders — the list
 * grows and the page scrolls; a cap is how DoT damage once "disappeared" on the
 * overlay, and the phone does not get to relearn that.
 */
function buildBreakdown(r) {
  const wrap = document.createElement('div');
  wrap.className = 'row-breakdown';

  const line = document.createElement('p');
  line.className = 'b-line';
  let entries;
  if (state.metric === 'damage') {
    const split = splitShares(r.playerDamage ?? r.damage, r.petDamage ?? 0);
    line.textContent = [
      `${r.damage.toLocaleString()} dealt`,
      split && `player ${split.playerPct}% · pet ${split.petPct}%`,
      `max ${r.maxHit.toLocaleString()}`,
    ].filter(Boolean).join(' · ');
    entries = r.abilities.map((a) => ({
      name: a.name, pet: a.pet, value: a.damage,
      share: r.damage > 0 ? a.damage / r.damage : 0,
    }));
  } else if (state.metric === 'healing') {
    line.textContent = [
      `${r.healing.toLocaleString()} healed`,
      r.overhealing > 0 && `${r.overhealing.toLocaleString()} overheal`,
      `${r.heals} casts`,
    ].filter(Boolean).join(' · ');
    entries = r.healAbilities.map((a) => ({
      name: a.name, pet: a.pet, value: a.healing,
      share: r.healing > 0 ? a.healing / r.healing : 0,
    }));
  } else {
    line.textContent = [
      `${r.damageTaken.toLocaleString()} taken`,
      `max hit ${r.maxHitTaken.toLocaleString()}`,
      r.deaths > 0 && `died ${r.deaths > 1 ? `${r.deaths} times` : 'once'}`,
    ].filter(Boolean).join(' · ');
    entries = r.attackers.map((a) => ({
      name: a.name, pet: false, value: a.damage,
      share: r.damageTaken > 0 ? a.damage / r.damageTaken : 0,
    }));
  }
  wrap.append(line);

  const top = entries.length > 0 ? Math.max(...entries.map((e) => e.value)) : 0;
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'b-row';
    const fill = document.createElement('span');
    fill.className = 'b-fill';
    fill.style.width = top > 0 ? `${(e.value / top) * 100}%` : '0%';
    const nm = document.createElement('span');
    nm.className = `b-name${e.pet ? ' pet' : ''}`;
    nm.textContent = e.name;
    const val = document.createElement('span');
    val.className = 'b-val';
    val.textContent = e.value.toLocaleString();
    const sh = document.createElement('span');
    sh.className = 'b-share';
    sh.textContent = pct(e.share);
    row.append(fill, nm, val, sh);
    wrap.append(row);
  }
  return wrap;
}

function drawLiveGraph() {
  const m = METRIC[state.metric];
  $('live-graph-label').textContent = `group ${m.unit}`;
  const tl = state.tl;
  const has = Boolean(tl && tl.upTo > 0);
  $('live-graph-empty').hidden = has;
  if (!has) {
    $('live-graph-stats').textContent = '';
    clearCanvas($('live-canvas'));
    return;
  }
  const group = sumSeries([...tl.rows.values()].map((r) => r[state.metric]))
    .slice(0, tl.upTo);
  const rate = smooth(ratePerSec(group, tl.bucketMs), TL_SMOOTH_RADIUS);
  const now = rate.length > 0 ? rate[rate.length - 1] : 0;
  const peak = Math.max(0, ...rate);
  $('live-graph-stats').textContent = `now ${formatRate(now)} · peak ${formatRate(peak)}`;
  drawGraph($('live-canvas'), [{ series: rate, cssVar: '--metric' }], tl.upTo * tl.bucketMs);
}

// ------------------------------------------------------------------ history

async function openHistory() {
  switchView('history');
  try {
    const r = await api('/api/history');
    state.index = await r.json();
  } catch {
    state.index = null;
  }
  const sel = state.index?.characters?.find((c) => c.key === state.index?.selected);
  $('hist-char').textContent = sel ? (sel.server ? `${sel.character} (${sel.server})` : sel.character) : '';
  renderHistoryList();
}

function renderHistoryList() {
  const list = $('hist-list');
  const entries = state.index?.encounters ?? [];
  const shown = applyFilters(entries, { chip: state.chip, search: state.search });

  if (shown.length === 0) {
    const p = document.createElement('li');
    p.className = 'hist-empty';
    p.textContent = entries.length === 0
      ? 'No encounters recorded yet. Fights are saved as they end.'
      : 'No fights match.';
    list.replaceChildren(p);
    return;
  }

  const items = [];
  for (const group of groupByDay(shown)) {
    const day = document.createElement('li');
    day.className = 'day-head';
    day.textContent = group.dayLabel;
    items.push(day);
    for (const e of group.entries) items.push(buildHistRow(e));
  }
  list.replaceChildren(...items);
}

function buildHistRow(e) {
  const li = document.createElement('li');
  li.className = 'hist-row';
  const top = document.createElement('div');
  top.className = 'row-top';
  const name = document.createElement('span');
  name.className = `row-name${isBoss(e) ? '' : ' trash'}`;
  name.textContent = e.label ?? 'Combat';
  const len = document.createElement('span');
  len.className = 'row-len';
  len.textContent = formatDuration(e.durationMs);
  top.append(name, len);

  const sub = document.createElement('div');
  sub.className = 'hist-sub';
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = [timeOfDay(e.startTs), e.zone, `${formatRate(e.groupDps ?? 0)} dps`]
    .filter(Boolean).join(' · ');
  sub.append(when);
  if (e.deaths > 0) {
    const d = document.createElement('span');
    d.className = 'deaths';
    d.textContent = `${SKULL} ${e.deaths}`;
    sub.append(d);
  }

  li.append(top, sub);
  li.addEventListener('click', () => { void openFight(e.id); });
  return li;
}

// --------------------------------------------------------------- fight view

async function openFight(id) {
  try {
    const r = await api(`/api/history/${encodeURIComponent(id)}?key=${encodeURIComponent(state.index?.selected ?? '')}`);
    if (!r.ok) return;
    state.record = await r.json();
  } catch {
    return;
  }
  state.fightMember = null;
  switchView('fight');
  renderFight();
}

function renderFight() {
  const rec = state.record;
  if (!rec) return;
  const snap = rec.snapshot;

  $('fight-name').textContent = rec.label ?? 'Combat';
  const deaths = snap.deaths ?? [];
  $('fight-meta').textContent = [
    shortDate(rec.startTs),
    formatDuration(rec.durationMs),
    rec.closeReason,
    deaths.length > 0 && `${SKULL} ${deaths.map((d) => `${d.name}${d.isPet ? ' (pet)' : ''}`).join(', ')}`,
  ].filter(Boolean).join(' · ');

  const petDeaths = deaths.filter((d) => d.isPet).length;
  const stats = [
    ['DEALT', snap.totalDamage.toLocaleString(), `${formatRate(snap.groupDps)} dps`, ''],
    ['HEALED', snap.totalHealing.toLocaleString(), `${formatRate(snap.groupHps ?? 0)} hps`, 'balm'],
    ['TAKEN', (snap.totalDamageTaken ?? 0).toLocaleString(), `${formatRate(snap.groupDtps ?? 0)} dtps`, 'wound'],
    ['DEATHS', String(deaths.length - petDeaths), petDeaths > 0 ? `+${petDeaths} pet` : '', 'bad'],
  ];
  $('fight-stats').replaceChildren(...stats.map(([label, value, unit, cls]) => {
    const div = document.createElement('div');
    div.className = `stat${cls ? ` ${cls}` : ''}`;
    const l = document.createElement('span');
    l.className = 's-label';
    l.textContent = label;
    const b = document.createElement('b');
    b.textContent = value;
    const u = document.createElement('span');
    u.className = 's-unit';
    u.textContent = unit;
    div.append(l, b, u);
    return div;
  }));

  const m = METRIC[state.metric];
  const rows = (snap.rows ?? []).filter(m.include).sort((a, b) => m.value(b) - m.value(a));
  if (!rows.some((r) => r.name === state.fightMember)) state.fightMember = rows[0]?.name ?? null;
  const max = rows.length > 0 ? Math.max(...rows.map((r) => m.value(r))) : 0;
  $('fight-members').replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    li.className = 'row-card';
    li.setAttribute('aria-selected', String(r.name === state.fightMember));
    const top = document.createElement('div');
    top.className = 'row-top';
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = r.name + (r.deaths > 0 ? `  ${SKULL}` : '');
    const value = document.createElement('span');
    value.className = 'row-value';
    value.textContent = m.value(r).toLocaleString();
    const share = document.createElement('span');
    share.className = 'row-share';
    share.textContent = pct(m.share(r));
    top.append(name, value, share);
    const bar = document.createElement('div');
    bar.className = 'row-bar';
    const fill = document.createElement('span');
    fill.style.width = max > 0 ? `${(m.value(r) / max) * 100}%` : '0%';
    bar.append(fill);
    li.append(top, bar);
    li.addEventListener('click', () => {
      state.fightMember = r.name;
      renderFight();
    });
    return li;
  }));

  drawFightGraph();
}

function drawFightGraph() {
  const snap = state.record?.snapshot;
  const tl = snap?.timeline;
  const legend = $('fight-legend');
  const has = Boolean(tl && tl.buckets > 0);
  $('fight-graph-empty').hidden = has;
  if (!has) {
    legend.dataset.member = 'false';
    clearCanvas($('fight-canvas'));
    return;
  }

  const key = state.metric;
  const rows = snap.rows ?? [];
  const group = smooth(
    ratePerSec(sumSeries(rows.map((r) => r.timeline?.[key] ?? [])), tl.bucketMs),
    TL_SMOOTH_RADIUS,
  );
  const memberRow = rows.find((r) => r.name === state.fightMember && r.timeline);
  legend.dataset.member = String(Boolean(memberRow));
  const curves = [{ series: group, cssVar: '--metric' }];
  if (memberRow) {
    $('fight-legend-member').textContent = memberRow.name;
    curves.push({
      series: smooth(ratePerSec(memberRow.timeline[key], tl.bucketMs), TL_SMOOTH_RADIUS),
      cssVar: '--metric-lit',
    });
  }
  drawGraph($('fight-canvas'), curves, tl.buckets * tl.bucketMs);
}

// ----------------------------------------------------------------- drawing

function clearCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * Stroke rate curves into a canvas: y grid + labels on the left, time labels under,
 * the same geometry helpers the History window draws with.
 */
function drawGraph(canvas, curves, spanMs) {
  const box = canvas.getBoundingClientRect();
  if (box.width < 60 || box.height < 30) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * dpr);
  canvas.height = Math.round(box.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, box.width, box.height);

  const styles = getComputedStyle(document.body);
  const color = (name) => styles.getPropertyValue(name).trim();

  const AXIS_W = 34;
  const AXIS_H = 15;
  const plotW = box.width - AXIS_W - 2;
  const plotH = box.height - AXIS_H - 4;
  const plotX = AXIS_W;
  const plotY = 2;

  const top = niceMax(Math.max(0, ...curves.flatMap((c) => c.series)));
  ctx.font = '10px system-ui, sans-serif';
  ctx.strokeStyle = color('--line');
  ctx.fillStyle = color('--ink-faint');
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const tick of axisTicks(top, 2)) {
    const y = plotY + plotH - (tick / top) * plotH;
    ctx.beginPath();
    ctx.moveTo(plotX, Math.round(y) + 0.5);
    ctx.lineTo(plotX + plotW, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillText(tick === 0 ? '0' : formatRate(tick), plotX - 5, y);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const tickMs of timeTicks(spanMs, 4).ticks) {
    const x = plotX + (tickMs / spanMs) * plotW;
    ctx.fillText(
      formatDuration(tickMs),
      Math.min(plotX + plotW - 14, Math.max(plotX + 14, x)),
      plotY + plotH + 4,
    );
  }

  for (const { series, cssVar } of curves) {
    const pts = polylinePoints(series, { width: plotW, height: plotH, max: top });
    if (pts.length === 0) continue;
    ctx.strokeStyle = color(cssVar);
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0
      ? ctx.moveTo(plotX + p.x, plotY + p.y)
      : ctx.lineTo(plotX + p.x, plotY + p.y)));
    ctx.stroke();
  }
}
