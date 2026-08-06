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
  pct, formatRate, formatDuration, timeOfDay, shortDate,
} from './organize.js';

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

  const parts = state.metric === 'damage' ? damageBreakdown(row)
    : state.metric === 'healing' ? healingBreakdown(row)
    : takenBreakdown(row);
  pane.replaceChildren(...parts);
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
    ['ability', 'damage', 'share', 'hits', 'crits', 'max'],
    r.abilities.map((a) => ({
      bar: a.damage,
      cells: [
        abilityName(a),
        a.damage.toLocaleString(),
        dim(pct(r.damage > 0 ? a.damage / r.damage : 0)),
        dim(String(a.hits)),
        dim(String(a.crits)),
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
