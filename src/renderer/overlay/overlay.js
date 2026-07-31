/**
 * Overlay renderer. A pure view: it holds no parser state, only the last snapshot.
 *
 * Two things here are less obvious than they look:
 *
 * 1. Click-through with hover. The window ignores mouse events so clicks reach the
 *    game, but `forward: true` still delivers mousemove, so pointerenter fires on a
 *    row. That handler asks main for mouse events back, the breakdown opens and is
 *    interactive, and leaving the slab gives them up again.
 *
 * 2. Rows are reused, not rebuilt. At 4 Hz with a bar transition, replacing the DOM
 *    every push would restart every animation and make the bars stutter.
 */

const $ = (id) => document.getElementById(id);

const els = {
  body: document.body,
  slab: $('slab'),
  target: $('target'),
  elapsed: $('elapsed'),
  dps: $('dps'),
  rolling: $('rolling'),
  rows: $('rows'),
  detail: $('detail'),
  dName: $('d-name'),
  dTotal: $('d-total'),
  dSelfBar: $('d-self-bar'),
  dPetBar: $('d-pet-bar'),
  dSelfLabel: $('d-self-label'),
  dPetLabel: $('d-pet-label'),
  dStats: $('d-stats'),
  dSources: $('d-sources'),
  dAbilities: $('d-abilities'),
  status: $('status'),
  toast: $('toast'),
};

let snapshot = null;
let selfName = null;
let hoveredName = null;
let toastTimer = null;
/** 'damage' or 'healing'. Every snapshot carries both, so switching is instant. */
let metric = 'damage';
/** Row elements by combatant name, so pushes update in place. */
const rowCache = new Map();

init();

async function init() {
  const config = await window.api.getConfig();
  applyConfig(config);

  window.api.onSnapshot(render);
  window.api.onStatus(applyStatus);
  window.api.onConfig(applyConfig);
  window.api.onToast(({ message }) => showToast(message));
  window.api.onLockChanged(applyLock);

  wireHover();
  wireControls();
}

// ---------------------------------------------------------------- config

function applyConfig(config) {
  if (!config) return;
  document.documentElement.style.setProperty('--opacity', String(config.opacity));
  document.documentElement.style.setProperty('--scale', String(config.scale));
  metric = config.metric === 'healing' ? 'healing' : 'damage';
  els.body.dataset.metric = metric;
  applyLock(config.locked);
  if (snapshot) render(snapshot);   // repaint in the new metric without waiting for a push
}

function applyLock(locked) {
  els.body.dataset.locked = String(Boolean(locked));
  if (locked) {
    hideDetail();
    // Locking restores the auto-fit that manual resizing suspended.
    requestAnimationFrame(fitHeight);
  }
}

function applyStatus(status) {
  if (!status) return;
  selfName = null;   // re-derived from the snapshot's `self` field
  els.body.dataset.stale = String(Boolean(status.stale));
  els.status.textContent = status.stale
    ? `${status.character}: log is stale — type /log on`
    : `${status.character}`;
  els.status.title = status.logPath;
}

// ---------------------------------------------------------------- rendering

/**
 * Field names for the metric on screen.
 *
 * Damage and healing are rendered by exactly the same code — only the fields it reads
 * differ. Rows are always sorted by damage on arrival, so the healing view re-sorts.
 */
const METRICS = {
  damage: { total: 'damage', rate: 'dps', rolling: 'rollingDps', share: 'share', unit: 'dps' },
  healing: { total: 'healing', rate: 'hps', rolling: 'rollingHps', share: 'healShare', unit: 'hps' },
};

function render(snap) {
  snapshot = snap;
  selfName = snap.self;
  const m = METRICS[metric];

  els.body.dataset.state = snap.active ? 'live' : 'idle';

  const rows = metric === 'healing'
    ? snap.rows.filter((r) => r.heals > 0).sort((a, b) => b.healing - a.healing)
    : snap.rows;

  els.body.dataset.hasRows = String(rows.length > 0);

  els.target.textContent = snap.idle ? 'No combat' : (snap.label ?? 'Combat');
  els.elapsed.textContent = formatDuration(snap.durationMs);
  els.dps.textContent = formatNumber(metric === 'healing' ? snap.groupHps : snap.groupDps);
  $('dps-unit').textContent = m.unit;

  const topRolling = rows.reduce((a, r) => a + r[m.rolling], 0);
  els.rolling.textContent = formatNumber(topRolling);

  renderRows(rows, m);

  // The pace tick marks the share an even group would each have.
  if (rows.length >= 2) {
    els.rows.dataset.pace = '';
    els.rows.style.setProperty('--pace', String(1 / rows.length));
  } else {
    delete els.rows.dataset.pace;
  }

  if (hoveredName) {
    const row = rows.find((r) => r.name === hoveredName);
    if (row) renderDetail(row);
    else hideDetail();
  }

  fitHeight();
}

/**
 * Shrink the window to exactly the rows on screen.
 *
 * A fixed-height overlay spends most of a session as a mostly-empty translucent slab
 * sitting over the game, because a group of four needs a quarter of the height a raid
 * does. Only done while locked: unlocked means the player is deliberately sizing the
 * window, and fighting them for the height would be maddening.
 */
function fitHeight() {
  if (els.body.dataset.locked !== 'true') return;

  let height = 2;   // the slab's top and bottom border
  for (const child of els.slab.children) {
    if (child === els.detail || child.hidden) continue;
    if (child === els.rows) {
      // NOT scrollHeight: #rows is a flex-grow scroller, and scrollHeight never
      // reports less than the stretched client height, so it would just measure the
      // window back to itself and the fit would never shrink. Sum the rows instead.
      const style = getComputedStyle(child);
      height += parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      for (const row of child.children) height += row.offsetHeight;
    } else {
      height += child.offsetHeight;
    }
  }

  height = Math.ceil(height);
  // A dead band stops a 1px rounding difference from starting a resize feedback loop.
  if (Math.abs(height - window.innerHeight) < 3) return;
  window.api.fitHeight(height);
}

function renderRows(rows, m) {
  const seen = new Set();

  rows.forEach((row, index) => {
    seen.add(row.name);
    let el = rowCache.get(row.name);

    if (!el) {
      el = buildRow(row.name);
      rowCache.set(row.name, el);
    }

    // Order changes as the fight develops; re-appending is cheap and keeps the
    // element (and therefore its running bar transition) alive.
    if (els.rows.children[index] !== el) {
      els.rows.insertBefore(el, els.rows.children[index] ?? null);
    }

    el.dataset.self = String(row.name === selfName);
    el.dataset.unknown = String(row.name === 'Unknown');

    const total = row[m.total];
    const petTotal = metric === 'healing' ? row.petHealing : row.petDamage;
    const petFraction = total > 0 ? petTotal / total : 0;

    el.refs.fill.style.width = `${(row[m.share] * 100).toFixed(2)}%`;
    el.refs.pet.style.width = `${(petFraction * 100).toFixed(2)}%`;
    el.refs.pet.hidden = petTotal === 0;

    el.refs.name.textContent = row.name;
    el.refs.dps.textContent = formatNumber(row[m.rate]);
    el.refs.share.textContent = `${Math.round(row[m.share] * 100)}%`;
  });

  for (const [name, el] of rowCache) {
    if (!seen.has(name)) {
      el.remove();
      rowCache.delete(name);
    }
  }
}

function buildRow(name) {
  const li = document.createElement('li');
  li.className = 'row';

  const fill = document.createElement('span');
  fill.className = 'fill';
  const pet = document.createElement('span');
  pet.className = 'fill-pet';
  fill.append(pet);

  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  const dpsEl = document.createElement('span');
  dpsEl.className = 'dps tabular';
  const shareEl = document.createElement('span');
  shareEl.className = 'share tabular';

  li.append(fill, nameEl, dpsEl, shareEl);
  li.refs = { fill, pet, name: nameEl, dps: dpsEl, share: shareEl };

  li.addEventListener('pointerenter', () => {
    hoveredName = name;
    const row = snapshot?.rows.find((r) => r.name === name);
    if (row) renderDetail(row);
  });

  return li;
}

// ---------------------------------------------------------------- breakdown

function renderDetail(row) {
  els.detail.hidden = false;
  els.dName.textContent = row.name;

  if (metric === 'healing') renderHealDetail(row);
  else renderDamageDetail(row);
}

function renderDamageDetail(row) {
  els.dTotal.textContent = `${row.damage.toLocaleString()} dmg · ${formatNumber(row.dps)} dps`;

  const petPct = row.damage > 0 ? (row.petDamage / row.damage) * 100 : 0;
  setSplit(petPct,
    `player ${row.playerDamage.toLocaleString()}`,
    `pet ${row.petDamage.toLocaleString()}`);

  setStats(els.dStats, [
    ['hits', row.hits],
    ['misses', row.misses],
    ['crits', row.crits],
    ['accuracy', `${Math.round(row.accuracy * 100)}%`],
    ['max hit', row.maxHit.toLocaleString()],
    ['share', `${Math.round(row.share * 100)}%`],
  ]);

  const sources = Object.entries(row.bySource)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  setChips(sources.map(([kind, value]) => [SOURCE_LABEL[kind] ?? kind, value.toLocaleString()]));

  setAbilities(row.abilities.slice(0, 6), {
    value: (a) => a.damage,
    detail: (a) => (a.misses > 0 ? `${a.hits}/${a.hits + a.misses}` : `${a.hits}`),
  });
}

/**
 * The healing view answers a different question from the damage view, so it shows
 * different things: overhealing and efficiency (was the heal needed?) instead of crits
 * and accuracy, and who was healed instead of damage source types.
 */
function renderHealDetail(row) {
  els.dTotal.textContent = `${row.healing.toLocaleString()} healed · ${formatNumber(row.hps)} hps`;

  const petPct = row.healing > 0 ? (row.petHealing / row.healing) * 100 : 0;
  setSplit(petPct,
    `player ${row.playerHealing.toLocaleString()}`,
    `pet ${row.petHealing.toLocaleString()}`);

  setStats(els.dStats, [
    ['heals', row.heals],
    ['overheal', row.overhealing.toLocaleString()],
    ['landed', `${Math.round(row.healEfficiency * 100)}%`],
    ['max heal', row.maxHeal.toLocaleString()],
    ['share', `${Math.round(row.healShare * 100)}%`],
    ['rolling', formatNumber(row.rollingHps)],
  ]);

  setChips(row.healTargets.slice(0, 5).map((t) => [t.name, t.healing.toLocaleString()]));

  setAbilities(row.healAbilities.slice(0, 6), {
    value: (a) => a.healing,
    detail: (a) => (a.overhealing > 0 ? `${a.casts} · ${a.overhealing} over` : `${a.casts}`),
  });
}

function setSplit(petPct, selfLabel, petLabel) {
  els.dSelfBar.style.width = `${100 - petPct}%`;
  els.dPetBar.style.width = `${petPct}%`;
  els.dSelfLabel.textContent = selfLabel;
  els.dPetLabel.textContent = petLabel;
}

function setChips(pairs) {
  els.dSources.replaceChildren(
    ...pairs.map(([label, value]) => {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = value;
      li.append(document.createTextNode(`${label} `), b);
      return li;
    })
  );
}

function setAbilities(list, { value, detail }) {
  const best = list.length > 0 ? value(list[0]) || 1 : 1;
  els.dAbilities.replaceChildren(
    ...list.map((a) => {
      const li = document.createElement('li');
      li.dataset.pet = String(a.pet);
      li.style.setProperty('--w', `${(value(a) / best) * 100}%`);

      const n = document.createElement('span');
      n.className = 'a-name';
      n.textContent = a.name;

      const d = document.createElement('span');
      d.className = 'a-dmg';
      d.textContent = value(a).toLocaleString();

      const h = document.createElement('span');
      h.className = 'a-hits';
      h.textContent = detail(a);

      li.append(n, d, h);
      return li;
    })
  );
}

const SOURCE_LABEL = {
  melee: 'melee',
  spell: 'spell',
  dot: 'dot',
  ds: 'shield',
  nonmelee: 'unknown',
};

function setStats(dl, pairs) {
  dl.replaceChildren(
    ...pairs.map(([label, value]) => {
      const wrap = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = String(value);
      wrap.append(dt, dd);
      return wrap;
    })
  );
}

function hideDetail() {
  hoveredName = null;
  els.detail.hidden = true;
}

// ------------------------------------------------------- mouse pass-through

function wireHover() {
  // Entering the slab takes mouse events so the breakdown can be read; leaving hands
  // them straight back so the game never loses a click.
  els.slab.addEventListener('pointerenter', () => window.api.setIgnoreMouse(false));

  els.slab.addEventListener('pointerleave', () => {
    hideDetail();
    window.api.setIgnoreMouse(true);
  });

  // Moving off the list but still inside the slab (e.g. onto the header) closes the
  // breakdown, which otherwise sticks open under the cursor.
  els.rows.addEventListener('pointerleave', (event) => {
    if (!els.detail.contains(event.relatedTarget)) hideDetail();
  });
}

function wireControls() {
  $('btn-metric').addEventListener('click', () => window.api.toggleMetric());
  $('btn-reset').addEventListener('click', () => window.api.resetEncounter());
  $('btn-settings').addEventListener('click', () => window.api.openSettings());
  $('btn-lock').addEventListener('click', () => window.api.toggleLock());
  $('btn-close').addEventListener('click', () => window.api.close());
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.dataset.show = 'false'; }, 2600);
}

// ---------------------------------------------------------------- formatting

/** DPS needs three glances-worth of precision, not six digits. */
function formatNumber(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return n.toFixed(1);
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
