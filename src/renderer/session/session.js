/**
 * The session window: three fixed panes over what a night of play earned.
 *
 * A pure view, like every other renderer here — it holds no tracker state, only whatever
 * main last handed it. All the arithmetic and every formatter lives in `organize.js`,
 * which is unit-tested in WSL; this file's whole job is to put those results into
 * elements and to remember which three things are selected.
 *
 * The rule that shapes everything below: selecting a session, a category or a character
 * swaps content INSIDE a pane. Nothing resizes, expands or pushes a neighbour, and every
 * row that can be empty renders an explicit empty state rather than disappearing.
 */

import {
  applyFilters, groupByDay, railSummary, headline, categories, detail,
  formatSpan, timeRange, closeReasonLabel, zoneLabel,
} from './organize.js';

const $ = (id) => document.getElementById(id);

const state = {
  /** Every character with sessions on disk. */
  characters: [],
  /** The store key being browsed. */
  key: null,
  /** The rail's index, newest first. */
  sessions: [],
  /** Which store key the tracker is actually recording, or null. */
  tracking: null,

  selectedId: null,
  /** The full record for `selectedId`, plus the combat block main derived for it. */
  record: null,
  combat: null,
  category: 'combat',

  chip: 'all',
  search: '',
};

init();

async function init() {
  wireEvents();
  await load();
  // A session closing (or an import landing) has to reach an open window: this window is
  // most useful during the night it is describing, and a rail frozen at the moment it was
  // opened would be missing exactly the session the player came to look at.
  window.api.onSessionAppended(({ key }) => {
    if (key === state.key) load({ keepSelection: true });
  });
}

async function load({ keepSelection = false } = {}) {
  const list = await window.api.sessionList(state.key);
  state.characters = list.characters ?? [];
  state.key = list.selected ?? null;
  state.sessions = list.sessions ?? [];
  state.tracking = list.tracking ?? null;

  renderCharacters();
  renderTracked();
  renderRail();

  const stillThere = keepSelection && state.sessions.some((s) => s.id === state.selectedId);
  await select(stillThere ? state.selectedId : (state.sessions[0]?.id ?? null));
}

function wireEvents() {
  $('search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderRail();
  });

  for (const chip of $('chips').querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      state.chip = chip.dataset.chip;
      for (const other of $('chips').querySelectorAll('.chip')) {
        other.setAttribute('aria-pressed', String(other === chip));
      }
      renderRail();
    });
  }

  $('character').addEventListener('change', async (e) => {
    state.key = e.target.value;
    state.selectedId = null;
    await load();
  });

  $('import').addEventListener('click', importLog);
}

/**
 * Replay a log file into the store.
 *
 * `scripts/backfill-history.js` has been able to do this for encounters since the history
 * window shipped, which is a capability nobody without a terminal has. A player who
 * played for weeks before installing this has all of it sitting in their eqlog.
 *
 * The button is disabled for the duration and says so: a month-old log is over a million
 * lines, and a button that looks idle while working invites a second click.
 */
async function importLog() {
  const btn = $('import');
  const before = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Reading…';
  try {
    const r = await window.api.sessionImport();
    if (r.canceled) return;
    if (!r.ok) {
      $('tracked').textContent = `Import failed — ${r.error}`;
      return;
    }
    // Both numbers, always. "12 imported" alone would leave a player who re-imported the
    // same file wondering where the rest went; "8 already present" is the answer.
    $('tracked').textContent =
      `Imported ${r.imported} session(s) for ${r.character}` +
      (r.duplicates > 0 ? ` · ${r.duplicates} already present` : '');
    state.key = r.key;
    state.selectedId = null;
    await load();
  } finally {
    btn.disabled = false;
    btn.textContent = before;
  }
}

// ---------------------------------------------------------------------- the titlebar

function renderCharacters() {
  const sel = $('character');
  sel.replaceChildren(...state.characters.map((c) => {
    const opt = document.createElement('option');
    opt.value = c.key;
    opt.textContent = `${c.character} · ${c.server}`;
    opt.selected = c.key === state.key;
    return opt;
  }));
  sel.hidden = state.characters.length === 0;
}

function renderTracked() {
  const total = state.sessions.reduce((n, s) => n + (s.durationMs ?? 0), 0);
  const live = state.tracking === state.key ? ' · recording now' : '';
  $('tracked').textContent = state.sessions.length === 0
    ? 'nothing recorded yet'
    : `${state.sessions.length} sessions · ${formatSpan(total)} tracked${live}`;
}

// --------------------------------------------------------------------------- the rail

function renderRail() {
  const filtered = applyFilters(state.sessions, { chip: state.chip, search: state.search });
  const list = $('session-list');
  const empty = $('rail-empty');

  if (filtered.length === 0) {
    list.replaceChildren();
    empty.hidden = false;
    empty.textContent = state.sessions.length === 0
      ? 'No sessions yet. Play with tracking on, or import a log file.'
      : 'No sessions match that filter.';
    return;
  }
  empty.hidden = true;

  const nodes = [];
  for (const group of groupByDay(filtered)) {
    const head = document.createElement('li');
    head.className = 'day-head';
    head.textContent = group.label;
    nodes.push(head);
    for (const entry of group.entries) nodes.push(railRow(entry));
  }
  list.replaceChildren(...nodes);
}

function railRow(entry) {
  const summary = railSummary(entry);
  const li = document.createElement('li');
  li.className = 'session-row';
  li.dataset.id = entry.id;
  li.setAttribute('aria-selected', String(entry.id === state.selectedId));

  const top = document.createElement('div');
  top.className = 'row-top';
  top.append(
    span('row-time', timeRange(entry.startTs, entry.endTs)),
    span('row-span', formatSpan(entry.durationMs)),
  );

  const stats = document.createElement('div');
  stats.className = 'row-stats';
  stats.append(document.createTextNode(`${summary.stats} · `));
  const deaths = span('row-deaths', summary.deaths);
  deaths.dataset.had = String(summary.hadDeaths);
  stats.append(deaths);

  li.append(top, span('row-zone', summary.zone), stats);
  li.addEventListener('click', () => select(entry.id));
  return li;
}

// ------------------------------------------------------------------------ the summary

async function select(id) {
  state.selectedId = id;
  for (const row of $('session-list').querySelectorAll('.session-row')) {
    row.setAttribute('aria-selected', String(row.dataset.id === String(id)));
  }

  if (id === null) {
    state.record = null;
    state.combat = null;
    renderSummary();
    renderDetail();
    return;
  }

  const got = await window.api.sessionGet({ key: state.key, id });
  state.record = got?.record ?? got ?? null;
  state.combat = got?.combat ?? null;
  renderSummary();
  renderDetail();
}

function renderSummary() {
  const record = state.record;
  if (!record) {
    $('s-when').textContent = '—';
    $('s-sub').textContent = '';
    $('s-deaths').textContent = '';
    $('s-headline').replaceChildren();
    $('category-list').replaceChildren();
    return;
  }

  const day = new Date(record.startTs);
  $('s-when').textContent =
    `${day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · ` +
    timeRange(record.startTs, record.endTs);
  $('s-sub').textContent =
    `${formatSpan(record.durationMs)} tracked · ${zoneLabel({ zoneNames: zoneNamesOf(record) })} · ` +
    closeReasonLabel(record.closeReason);
  // Always rendered, faint when clean — see the no-reflow rule.
  $('s-deaths').textContent = (record.deaths ?? []).length > 0
    ? `${record.deaths.length} death${record.deaths.length === 1 ? '' : 's'}`
    : 'no deaths';

  $('s-headline').replaceChildren(...headline(record).map((stat) => {
    const cell = document.createElement('div');
    cell.append(span('stat-label', stat.label));
    const value = document.createElement('div');
    value.className = 'stat-value';
    value.dataset.accent = String(Boolean(stat.accent));
    const b = document.createElement('b');
    b.textContent = stat.value;
    value.append(b, span('', stat.unit));
    cell.append(value);
    return cell;
  }));

  const rows = categories(record, state.combat);
  // A category that has gone away (an old record with no combat, say) must not leave the
  // detail pane showing a stale heading.
  if (!rows.some((c) => c.id === state.category)) state.category = rows[0].id;

  $('category-list').replaceChildren(...rows.map((cat) => {
    const li = document.createElement('li');
    li.className = 'category-row';
    li.dataset.id = cat.id;
    li.setAttribute('aria-selected', String(cat.id === state.category));
    li.append(span('cat-name', cat.label), span('cat-sub', cat.summary));
    li.addEventListener('click', () => {
      state.category = cat.id;
      for (const other of $('category-list').querySelectorAll('.category-row')) {
        other.setAttribute('aria-selected', String(other.dataset.id === cat.id));
      }
      renderDetail();
    });
    return li;
  }));
}

// ------------------------------------------------------------------------- the detail

function renderDetail() {
  const record = state.record;
  if (!record) {
    $('d-title').textContent = '—';
    $('d-lead').replaceChildren();
    $('d-col-name').textContent = '';
    $('d-col-value').textContent = '';
    $('detail-list').replaceChildren();
    $('d-footer').textContent = '';
    return;
  }

  const view = detail(record, state.category, state.combat);
  $('d-title').textContent = view.title;

  // The lead keeps its row height whether or not it has a number to show, so the column
  // header below it sits on the same pixel for every category.
  $('d-lead').replaceChildren(...(view.lead
    ? [Object.assign(document.createElement('b'), { textContent: view.lead.value }),
      span('', view.lead.rest)]
    : [span('', 'nothing recorded in this category')]));

  $('d-col-name').textContent = view.columns[0];
  $('d-col-value').textContent = view.columns[1];

  $('detail-list').replaceChildren(...view.rows.map((r) => {
    const li = document.createElement('li');
    li.className = 'detail-row';
    if (r.kind) li.dataset.kind = r.kind;

    const name = document.createElement('div');
    name.className = 'd-name';
    name.append(Object.assign(document.createElement('b'), { textContent: r.name }));
    // The sub-line renders always, empty string included, so rows are one height.
    name.append(Object.assign(document.createElement('i'), { textContent: r.sub ?? '' }));

    li.append(name, span('d-value', r.value));
    return li;
  }));

  $('d-footer').textContent = view.footer;
}

// ------------------------------------------------------------------------- small bits

function span(className, text) {
  const el = document.createElement('span');
  if (className) el.className = className;
  el.textContent = text ?? '';
  return el;
}

/** Distinct zone names for a full record, longest visit first — the rail's own rule. */
function zoneNamesOf(record) {
  const total = new Map();
  for (const v of record.zones ?? []) total.set(v.zone, (total.get(v.zone) ?? 0) + (v.ms ?? 0));
  return [...total.entries()].sort((a, b) => b[1] - a[1]).map(([zone]) => zone);
}
