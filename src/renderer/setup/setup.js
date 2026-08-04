/**
 * First-run setup and, in 'settings' mode, the same screen reopened later.
 *
 * The only difference between the modes is the wording and whether the log picker is
 * pre-satisfied, so they share one renderer rather than duplicating the form.
 */

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  dir: null,
  selected: null,      // absolute path of the chosen log
  validation: null,
  history: {
    loaded: false,
    characters: [],
    key: null,         // selected character file key
    encounters: [],    // lightweight index rows
    openId: null,      // encounter expanded in place, if any
  },
};

const isSettings = window.api.mode === 'settings';

init();

async function init() {
  state.config = await window.api.getConfig();
  state.selected = state.config.logPath ?? null;

  if (isSettings) {
    $('title').textContent = 'Overlay settings';
    $('subtitle').textContent = 'Changes apply immediately.';
    $('save').textContent = 'Save and close';
  }

  fillForm(state.config);
  wireEvents();
  wireTabs();

  await loadDirectory(state.config.logDir);
  if (state.selected) await validate(state.selected);
  refreshSaveButton();
}

function fillForm(cfg) {
  $('dir').value = cfg.logDir ?? '';
  $('opacity').value = cfg.opacity;
  $('scale').value = cfg.scale;
  $('timeout').value = cfg.combatTimeoutSec;
  $('grace').value = cfg.postKillGraceSec;
  $('group-only').checked = cfg.groupOnly;
  $('auto-switch').checked = cfg.autoSwitchCharacter;
  $('pet-owners').value = formatPetOwners(cfg.petOwners);
  $('hk-lock').value = cfg.hotkeys.toggleLock;
  $('hk-show').value = cfg.hotkeys.toggleVisible;
  $('hk-reset').value = cfg.hotkeys.resetEncounter;
  $('hk-metric').value = cfg.hotkeys.toggleMetric;
  syncOutputs();
}

function syncOutputs() {
  $('opacity-out').textContent = `${Math.round($('opacity').value * 100)}%`;
  $('scale-out').textContent = `${Number($('scale').value).toFixed(2)}×`;
}

function wireEvents() {
  $('opacity').addEventListener('input', syncOutputs);
  $('scale').addEventListener('input', syncOutputs);

  $('browse-dir').addEventListener('click', async () => {
    const r = await window.api.pick('directory');
    if (r.canceled) return;
    $('dir').value = r.path;
    await loadDirectory(r.path);
  });

  $('browse-file').addEventListener('click', async () => {
    const r = await window.api.pick('file');
    if (r.canceled) return;
    state.selected = r.path;
    await loadDirectory(dirnameOf(r.path));
    await validate(r.path);
    renderList(state.logs ?? []);
    refreshSaveButton();
  });

  $('dir').addEventListener('change', () => loadDirectory($('dir').value));

  $('clear-log').addEventListener('click', async () => {
    if (!window.confirm(
      'Empty the followed log file on disk?\n\n' +
      'EverQuest keeps logging into the empty file, and recorded fight history is ' +
      'not touched — but the raw log text itself is gone for good.'
    )) return;
    const r = await window.api.clearLog();
    setStatus($('validation'), r.ok ? 'Log file cleared.' : `Could not clear — ${r.error}`, r.ok ? 'ok' : 'bad');
  });

  $('save').addEventListener('click', save);
}

async function loadDirectory(dir) {
  const result = await window.api.listLogs(dir);
  state.dir = result.dir;
  state.logs = result.logs;
  $('dir').value = result.dir;

  if (!result.ok) {
    setStatus($('dir-status'), `Cannot read that folder — ${result.error}`, 'bad');
    renderList([]);
    return;
  }
  if (result.logs.length === 0) {
    setStatus(
      $('dir-status'),
      'No eqlog_*.txt files here. Enable logging in game with /log on, or pick another folder.',
      'warn'
    );
    renderList([]);
    return;
  }

  setStatus($('dir-status'), `${result.logs.length} log file(s) found.`, 'ok');

  // Auto-select the most recently written log — on a fresh install that is almost
  // always the character the player is about to play.
  if (!state.selected) {
    state.selected = result.logs[0].filePath;
    await validate(state.selected);
  }
  renderList(result.logs);
  refreshSaveButton();
}

function renderList(logs) {
  const list = $('log-list');
  list.replaceChildren();

  for (const log of logs) {
    const li = document.createElement('li');
    li.setAttribute('aria-selected', String(log.filePath === state.selected));
    li.title = log.filePath;

    const char = document.createElement('span');
    char.className = 'char';
    char.textContent = log.character;

    const server = document.createElement('span');
    server.className = 'server';
    server.textContent = log.server;

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = relativeTime(log.mtimeMs);

    li.append(char, server, when);

    if (Date.now() - log.mtimeMs < 5 * 60 * 1000) {
      const badge = document.createElement('span');
      badge.className = 'badge live';
      badge.textContent = 'active';
      li.append(badge);
    }

    li.addEventListener('click', async () => {
      state.selected = log.filePath;
      await validate(log.filePath);
      renderList(logs);
      refreshSaveButton();
    });

    list.append(li);
  }
}

async function validate(filePath) {
  const v = await window.api.validate(filePath);
  state.validation = v;
  const el = $('validation');

  if (!v.ok) {
    setStatus(
      el,
      v.error
        ? `Cannot read that file — ${v.error}`
        : 'That file has no EverQuest log lines in it.',
      'bad'
    );
    return;
  }

  const bits = [`${v.character} on ${v.server}`, `${v.recognized}/${v.lines} recent lines parsed`];
  if (v.stale) {
    setStatus(el, `${bits.join(' · ')} — last written ${relativeTime(v.mtimeMs)}. Type /log on in game.`, 'warn');
  } else {
    setStatus(el, `${bits.join(' · ')}`, 'ok');
  }
}

function refreshSaveButton() {
  $('save').disabled = !(state.selected && state.validation?.ok);
  if (!state.selected) {
    setStatus($('footer-status'), 'Choose a log file to continue.', '');
  } else {
    setStatus($('footer-status'), state.selected, '');
  }
}

async function save() {
  const patch = {
    logPath: state.selected,
    logDir: state.dir,
    opacity: Number($('opacity').value),
    scale: Number($('scale').value),
    combatTimeoutSec: Number($('timeout').value),
    postKillGraceSec: Number($('grace').value),
    groupOnly: $('group-only').checked,
    autoSwitchCharacter: $('auto-switch').checked,
    petOwners: parsePetOwners($('pet-owners').value),
    hotkeys: {
      toggleLock: $('hk-lock').value.trim(),
      toggleVisible: $('hk-show').value.trim(),
      resetEncounter: $('hk-reset').value.trim(),
      toggleMetric: $('hk-metric').value.trim(),
    },
  };

  if (isSettings) {
    await window.api.setConfig(patch);
    window.close();
  } else {
    await window.api.complete(patch);
  }
}

/** { Gann: 'Rhain' } -> "Gann = Rhain" */
function formatPetOwners(mapping) {
  return Object.entries(mapping ?? {})
    .map(([pet, owner]) => `${pet} = ${owner}`)
    .join('\n');
}

/**
 * "Gann = Rhain" -> { Gann: 'Rhain' }
 * Blank lines and lines with no "=" are skipped rather than rejected, so a half-typed
 * line never blocks saving the rest of the settings.
 */
function parsePetOwners(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const [pet, owner] = line.split('=');
    if (!owner) continue;
    const p = pet.trim();
    const o = owner.trim();
    if (p && o) out[p] = o;
  }
  return out;
}

function setStatus(el, text, cls) {
  el.textContent = text;
  el.className = `status${cls ? ` ${cls}` : ''}`;
}

function relativeTime(ms) {
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h ago`;
  return `${Math.floor(delta / 86_400_000)} d ago`;
}

function dirnameOf(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i === -1 ? p : p.slice(0, i);
}

// -------------------------------------------------------------------- tabs

function wireTabs() {
  document.body.dataset.tab = 'settings';
  for (const btn of document.querySelectorAll('#tabs .tab')) {
    btn.addEventListener('click', () => {
      document.body.dataset.tab = btn.dataset.tab;
      for (const b of document.querySelectorAll('#tabs .tab')) {
        b.setAttribute('aria-selected', String(b === btn));
      }
      $('history-section').hidden = btn.dataset.tab !== 'history';
      // Loaded lazily, and re-listed on every visit: the fight that just ended in
      // game should be here without restarting the settings window.
      if (btn.dataset.tab === 'history') loadHistory(state.history.key);
    });
  }

  $('h-char').addEventListener('change', () => {
    state.history.openId = null;
    loadHistory($('h-char').value);
  });
  // Opened from the tray's History… item — land directly on the tab.
  if (window.api.initialTab === 'history') {
    document.querySelector('#tabs .tab[data-tab="history"]').click();
  }

  $('h-filter').addEventListener('input', renderHistory);
  $('h-clear').addEventListener('click', async () => {
    const label = $('h-char').selectedOptions[0]?.textContent ?? 'this character';
    // A native confirm is fine here: this is a normal window, and the deletion is
    // irreversible.
    if (!window.confirm(`Delete ALL recorded encounters for ${label}? This cannot be undone.`)) return;
    await window.api.historyClear(state.history.key);
    state.history.openId = null;
    loadHistory(null);
  });
}

// ----------------------------------------------------------------- history

async function loadHistory(key) {
  const r = await window.api.historyList(key ?? null);
  state.history.loaded = true;
  state.history.characters = r.characters;
  state.history.key = r.selected;
  state.history.encounters = r.encounters;

  const sel = $('h-char');
  sel.replaceChildren(
    ...r.characters.map((c) => {
      const o = document.createElement('option');
      o.value = c.key;
      o.textContent = c.server ? `${c.character} (${c.server})` : c.character;
      o.selected = c.key === r.selected;
      return o;
    })
  );
  sel.disabled = r.characters.length === 0;
  $('h-clear').disabled = r.characters.length === 0;

  renderHistory();
}

function renderHistory() {
  const list = $('h-list');
  const filter = $('h-filter').value.trim().toLowerCase();
  const shown = state.history.encounters.filter((e) =>
    !filter ||
    (e.label ?? '').toLowerCase().includes(filter) ||
    (e.zone ?? '').toLowerCase().includes(filter)
  );

  if (state.history.encounters.length === 0) {
    setStatus($('h-status'), 'No encounters recorded yet. Fights are saved as they end.', '');
  } else {
    const total = state.history.encounters.length;
    setStatus($('h-status'), filter ? `${shown.length} of ${total} encounters` : `${total} encounters`, '');
  }

  list.replaceChildren(...shown.map(buildFightRow));

  // Column captions, once, above the list.
  if (shown.length > 0) {
    const cols = document.createElement('li');
    cols.className = 'fight-cols';
    for (const [text, num] of [['Encounter', false], ['When', false], ['Length', true],
                               ['Group DPS', true], ['Your DPS', true], ['Deaths', true]]) {
      const s = document.createElement('span');
      s.textContent = text;
      if (num) s.className = 'num';
      cols.append(s);
    }
    list.prepend(cols);
  }
}

function buildFightRow(e) {
  const li = document.createElement('li');
  li.dataset.id = e.id;
  li.dataset.open = String(e.id === state.history.openId);

  const head = document.createElement('div');
  head.className = 'fight-head';

  const label = document.createElement('span');
  label.className = 'f-label';
  label.textContent = e.label ?? 'Combat';
  if (e.zone) {
    const z = document.createElement('span');
    z.className = 'f-zone';
    z.textContent = ` · ${e.zone}`;
    label.append(z);
  }

  const when = document.createElement('span');
  when.className = 'f-when';
  when.textContent = shortDate(e.startTs);

  const len = numCell(formatDuration(e.durationMs));
  const gdps = numCell(formatRate(e.groupDps));
  const sdps = numCell(e.self ? formatRate(e.self.dps) : '—');

  const deaths = document.createElement('span');
  deaths.className = 'f-deaths num';
  deaths.dataset.none = String(e.deaths === 0);
  deaths.textContent = String(e.deaths);

  head.append(label, when, len, gdps, sdps, deaths);
  head.addEventListener('click', () => toggleFight(li, e));
  li.append(head);

  if (e.id === state.history.openId) {
    openFight(li, e);   // re-render already-open detail across list refreshes
  }
  return li;
}

async function toggleFight(li, e) {
  const wasOpen = state.history.openId === e.id;
  state.history.openId = wasOpen ? null : e.id;
  document.querySelectorAll('#h-list .fight-detail').forEach((d) => d.remove());
  document.querySelectorAll('#h-list > li').forEach((x) => { x.dataset.open = 'false'; });
  if (!wasOpen) {
    li.dataset.open = 'true';
    await openFight(li, e);
  }
}

async function openFight(li, e) {
  const record = await window.api.historyGet(state.history.key, e.id);
  if (!record) return;
  li.querySelector('.fight-detail')?.remove();
  li.append(buildFightDetail(record));
}

/**
 * The expanded record. Everything the encounter knew is reachable from here:
 * per-member tables for all three metrics, and per-member ability/attacker
 * breakdowns behind a <details> — collapsed is fine in this window because the
 * full list is one click away, unlike the overlay where a cap silently hid data.
 */
function buildFightDetail(record) {
  const wrap = document.createElement('div');
  wrap.className = 'fight-detail';
  const snap = record.snapshot;

  const meta = document.createElement('p');
  meta.className = 'd-meta';
  meta.textContent = [
    new Date(record.startTs).toLocaleString(),
    formatDuration(record.durationMs),
    `ended: ${record.closeReason ?? 'unknown'}`,
    `${snap.totalDamage.toLocaleString()} dealt (${formatRate(snap.groupDps)} dps)`,
    `${snap.totalHealing.toLocaleString()} healed`,
    `${(snap.totalDamageTaken ?? 0).toLocaleString()} taken`,
  ].join(' · ');
  wrap.append(meta);

  const deaths = snap.deaths ?? [];
  if (deaths.length > 0) {
    const d = document.createElement('p');
    d.className = 'd-deaths';
    d.textContent = 'Deaths: ' + deaths
      .map((x) => `${x.name}${x.isPet ? ' (pet)' : ''} — ${x.killer ?? 'unknown'}`)
      .join(', ');
    wrap.append(d);
  }

  const tabs = document.createElement('div');
  tabs.className = 'metric-tabs';
  const table = document.createElement('div');

  const render = (metric) => {
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.m === metric));
    table.replaceChildren(buildMemberTable(snap, metric));
  };
  for (const [m, text] of [['damage', 'Damage'], ['healing', 'Healing'], ['taken', 'Damage taken']]) {
    const b = document.createElement('button');
    b.dataset.m = m;
    b.textContent = text;
    b.addEventListener('click', () => render(m));
    tabs.append(b);
  }
  wrap.append(tabs, table);
  render('damage');
  return wrap;
}

function buildMemberTable(snap, metric) {
  const table = document.createElement('table');
  const cols = {
    damage: ['Member', 'Damage', 'DPS', 'Share', 'Hits', 'Crits', 'Max'],
    healing: ['Member', 'Healed', 'HPS', 'Share', 'Overheal', 'Heals', 'Max'],
    taken: ['Member', 'Taken', 'DTPS', 'Share', 'Max hit', 'Avoided', 'Deaths'],
  }[metric];

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  cols.forEach((c, i) => {
    const th = document.createElement('th');
    th.textContent = c;
    if (i > 0) th.className = 'num';
    hr.append(th);
  });
  thead.append(hr);

  const tbody = document.createElement('tbody');
  const rows = snap.rows
    .filter((r) => (metric === 'damage' ? r.damage > 0 || r.hits > 0
      : metric === 'healing' ? r.heals > 0
      : r.damageTaken > 0 || r.deaths > 0 || r.petDeaths > 0))
    .sort((a, b) => (metric === 'damage' ? b.damage - a.damage
      : metric === 'healing' ? b.healing - a.healing
      : b.damageTaken - a.damageTaken));

  for (const r of rows) {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = r.name;
    det.append(sum);
    det.addEventListener('toggle', () => {
      if (det.open && det.children.length === 1) det.append(buildMemberBreakdown(r, metric));
    });
    name.append(det);
    tr.append(name);

    const cells = {
      damage: [r.damage.toLocaleString(), formatRate(r.dps), pct(r.share),
               String(r.hits), String(r.crits), r.maxHit.toLocaleString()],
      healing: [r.healing.toLocaleString(), formatRate(r.hps), pct(r.healShare),
                r.overhealing.toLocaleString(), String(r.heals), r.maxHeal.toLocaleString()],
      taken: [r.damageTaken.toLocaleString(), formatRate(r.dtps), pct(r.takenShare),
              r.maxHitTaken.toLocaleString(), String(r.avoidsTaken),
              r.petDeaths > 0 ? `${r.deaths} +${r.petDeaths} pet` : String(r.deaths)],
    }[metric];

    for (const c of cells) {
      const td = document.createElement('td');
      td.className = 'num';
      td.textContent = c;
      tr.append(td);
    }
    tbody.append(tr);
  }

  table.append(thead, tbody);
  return table;
}

/** The per-member drill-down: every ability / attacker / type, nothing sliced. */
function buildMemberBreakdown(r, metric) {
  const wrap = document.createElement('div');

  if (metric === 'damage') {
    wrap.append(subTable('Abilities',
      ['Ability', 'Damage', 'Share', 'Hits', 'Crits', 'Max'],
      r.abilities.map((a) => [
        a.pet ? tagPet(a.name) : a.name,
        a.damage.toLocaleString(), pct(r.damage > 0 ? a.damage / r.damage : 0),
        String(a.hits), String(a.crits), a.max.toLocaleString(),
      ])));
  } else if (metric === 'healing') {
    wrap.append(subTable('Heal abilities',
      ['Ability', 'Healed', 'Overheal', 'Casts'],
      r.healAbilities.map((a) => [
        a.pet ? tagPet(a.name) : a.name,
        a.healing.toLocaleString(), a.overhealing.toLocaleString(), String(a.casts),
      ])));
    if (r.healTargets.length > 0) {
      wrap.append(subTable('Healed who',
        ['Target', 'Healed'],
        r.healTargets.map((t) => [t.name, t.healing.toLocaleString()])));
    }
  } else {
    wrap.append(subTable('Hit by',
      ['Attacker', 'Damage', 'Hits', 'Max'],
      r.attackers.map((a) => [a.name, a.damage.toLocaleString(), String(a.hits), a.max.toLocaleString()])));
    wrap.append(subTable('With what',
      ['Ability', 'Damage', 'Hits', 'Max', 'Resist'],
      r.takenAbilities.map((a) => [
        a.name, a.damage.toLocaleString(), String(a.hits), a.max.toLocaleString(),
        a.type ? tagResist(a.type) : '—',
      ])));
    const types = Object.entries(r.takenByType ?? {}).sort((a, b) => b[1] - a[1]);
    if (types.length > 0) {
      wrap.append(subTable('By damage type',
        ['Type', 'Damage', 'Resist'],
        types.map(([t, v]) => [t, v.toLocaleString(), tagResist(t)])));
    }
  }
  return wrap;
}

/** Which resist mitigates which stated type; melee is armor, untyped is unknown. */
const RESISTS = { fire: 'FR', cold: 'CR', magic: 'MR', poison: 'PR', disease: 'DR', corruption: 'Corr' };

function tagResist(type) {
  if (!RESISTS[type]) return type === 'melee' ? 'armor' : '—';
  const s = document.createElement('span');
  s.className = 'resist';
  s.textContent = RESISTS[type];
  return s;
}

function tagPet(name) {
  const s = document.createElement('span');
  s.className = 'pet-tag';
  s.textContent = name;
  return s;
}

function subTable(caption, headers, rows) {
  const t = document.createElement('table');
  t.className = 'sub';
  const cap = document.createElement('caption');
  cap.textContent = caption;
  t.append(cap);

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  headers.forEach((h, i) => {
    const th = document.createElement('th');
    th.textContent = h;
    if (i > 0) th.className = 'num';
    hr.append(th);
  });
  thead.append(hr);

  const tbody = document.createElement('tbody');
  for (const cells of rows) {
    const tr = document.createElement('tr');
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      if (i > 0) td.className = 'num';
      td.append(c instanceof Node ? c : document.createTextNode(String(c)));
      tr.append(td);
    });
    tbody.append(tr);
  }
  t.append(thead, tbody);
  return t;
}

// ------------------------------------------------------ history formatting

function pct(fraction) {
  if (!Number.isFinite(fraction) || fraction <= 0) return '—';
  const p = fraction * 100;
  return p < 1 ? '<1%' : `${Math.round(p)}%`;
}

function formatRate(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return String(Math.round(n));
  return n.toFixed(1);
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function shortDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function numCell(text) {
  const s = document.createElement('span');
  s.className = 'num';
  s.textContent = text;
  return s;
}
