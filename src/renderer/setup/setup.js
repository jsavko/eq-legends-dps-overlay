/**
 * First-run setup and, in 'settings' mode, the same screen reopened later.
 *
 * The only difference between the modes is the wording and whether the log picker is
 * pre-satisfied, so they share one renderer rather than duplicating the form.
 */

const $ = (id) => document.getElementById(id);

/**
 * The seven session categories, paired with the checkbox that switches each.
 *
 * Restated here rather than imported because this renderer cannot reach `config.js` (it
 * imports `fs`) — the same constraint the alerts renderer works under. The pairing is a
 * convention, `session-<category>`, so the ids and the config keys cannot drift halfway:
 * either every one resolves or none does, which one render makes obvious.
 */
const SESSION_CATEGORIES = ['kills', 'loot', 'coin', 'xp', 'faction', 'skills', 'zones'];

const state = {
  config: null,
  dir: null,
  selected: null,      // absolute path of the chosen log
  validation: null,
  /** Which rail entry is showing. Purely local — never persisted. */
  page: 'log',
  /** What the parser knows about who is here, refreshed when a picker needs it. */
  roster: { ok: false, key: null, seen: [], group: [], character: null },
  /** The tracked set for THIS character, as a Set for cheap toggling. */
  party: new Set(),
  /** Pet pickers: what needs an owner, and the current left/right selection. */
  pets: { mapped: [], unmapped: [] },
  petPick: null,
  ownerPick: null,
  petOwners: {},
};

const isSettings = window.api.mode === 'settings';

init();

async function init() {
  state.config = await window.api.getConfig();
  state.selected = state.config.logPath ?? null;

  if (isSettings) {
    $('title').textContent = 'Log file';
    $('subtitle').textContent = 'Which character the overlay is following.';
    $('save').textContent = 'Save and close';
  }

  fillForm(state.config);
  wireEvents();
  showPage(isSettings ? 'log' : 'log');

  await loadDirectory(state.config.logDir);
  if (state.selected) await validate(state.selected);
  await refreshRoster();
  await renderPets();
  renderParty();
  await renderTriggerSummary();
  await renderSessionSummary();
  await renderLoggingState();
  refreshSaveButton();
}

/**
 * Show one rail page. Nothing here is persisted: which topic you last looked at is not a
 * preference, and restoring it would open settings somewhere other than where a first-run
 * player needs to be.
 */
function showPage(page) {
  state.page = page;
  for (const b of document.querySelectorAll('#rail button')) {
    b.setAttribute('aria-selected', String(b.dataset.page === page));
  }
  for (const a of document.querySelectorAll('#detail article')) {
    a.hidden = a.dataset.page !== page;
  }
  // Scrolled back to the top, because the pane is shared: landing halfway down a page
  // because the previous one was long reads as a rendering fault.
  $('detail').scrollTop = 0;
}

/**
 * Ask the parser who is here.
 *
 * Failure is silent and leaves the pickers empty, which is the honest state during
 * first-run setup: no log has been chosen, so there is no parser and nobody is here yet.
 */
async function refreshRoster() {
  try {
    state.roster = await window.api.rosterState();
  } catch {
    state.roster = { ok: false, key: null, seen: [], group: [], character: null };
  }
  // The stored list is per character; the picker only ever edits the current one.
  const stored = state.roster.key ? state.config.partyMembers?.[state.roster.key] : null;
  state.party = new Set(Array.isArray(stored) ? stored.filter(Boolean) : []);
}

/** A row in one of the pickers. */
function nameRow({ name, on, meta, why, selected, cls }) {
  const li = document.createElement('li');
  li.dataset.name = name;
  if (on !== undefined) li.dataset.on = on ? '1' : '0';
  if (selected !== undefined) li.setAttribute('aria-selected', String(selected));
  if (cls) li.className = cls;

  if (on !== undefined) {
    const box = document.createElement('span');
    box.className = 'box';
    box.textContent = on ? '\u2713' : '';
    li.append(box);
  }

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = name;
  if (why) {
    const w = document.createElement('span');
    w.className = 'why';
    w.textContent = why;
    who.append(w);
  }
  li.append(who);

  if (meta) {
    const m = document.createElement('span');
    m.className = 'meta';
    m.textContent = meta;
    li.append(m);
  }
  return li;
}

function emptyRow(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

// ------------------------------------------------------------------- who's tracked

/**
 * The party picker.
 *
 * A picker rather than a text box because a mistyped name in a filter does not fail — it
 * hides a person who is right there and says nothing, which is the exact failure this
 * feature was built in response to. A name you clicked cannot be misspelt. The free-text
 * box stays for somebody who has not acted yet and so is not in the list.
 */
function renderParty() {
  const seenEl = $('party-seen');
  const pickedEl = $('party-picked');
  if (!seenEl || !pickedEl) return;

  const q = ($('party-search').value || '').trim().toLowerCase();
  const seen = state.roster.seen.filter((p) => p.name.toLowerCase().includes(q));

  seenEl.replaceChildren(...(seen.length
    ? seen.map((p) => nameRow({
      name: p.name,
      on: state.party.has(p.name),
      meta: p.self ? 'you' : (p.inGroup ? 'group' : (p.damage > 0 ? `${Math.round(p.damage)} dmg` : '')),
    }))
    : [emptyRow(state.roster.ok ? 'Nobody has acted yet.' : 'No log is being followed yet.')]));

  // Names in the list but not seen — typed by hand, or somebody who has since gone quiet.
  const known = new Set(state.roster.seen.map((p) => p.name));
  const tracked = [...state.party].sort((a, b) => a.localeCompare(b));
  pickedEl.replaceChildren(...(tracked.length
    ? tracked.map((n) => nameRow({
      name: n,
      on: true,
      meta: known.has(n) ? 'remove' : 'not seen yet',
      cls: 'picked',
    }))
    : [emptyRow('Nobody picked — every player the log sees gets a row.')]));

  const n = state.party.size;
  $('party-count').textContent = String(n);
  $('party-of').textContent = state.roster.seen.length
    ? `of ${state.roster.seen.length} seen this session`
    : 'of nobody seen yet';

  const pill = $('party-pill');
  pill.textContent = n ? 'Filtering' : 'Showing everyone';
  pill.dataset.tone = n ? 'some' : 'all';

  const tag = $('tag-party');
  if (tag) tag.textContent = n ? `${n} of ${state.roster.seen.length || n}` : '';

  $('party-status').textContent = n
    ? `The meter will show ${tracked.join(', ')} and nobody else.`
    : 'The meter will show every player the log sees.';
}

function toggleParty(name) {
  if (state.party.has(name)) state.party.delete(name);
  else state.party.add(name);
  renderParty();
}

// ----------------------------------------------------------------------------- pets

/**
 * What the parser currently knows about pets, as two lists rather than a text box.
 *
 * The `Pet = Owner` box never told anyone WHICH names needed an entry — you had to
 * already know the answer, which made the setting unusable in practice — and it made the
 * one dangerous typo easy: get the pet name wrong and the mapping matches nothing, get
 * the OWNER wrong and real damage folds into somebody who does not exist.
 */
async function renderPets() {
  try {
    state.pets = await window.api.petsState();
  } catch {
    state.pets = { mapped: [], unmapped: [] };
  }

  const configured = new Set(Object.keys(state.petOwners));
  const waiting = state.pets.unmapped.filter((n) => !configured.has(n));
  if (state.petPick && !waiting.includes(state.petPick)) state.petPick = null;
  if (!state.petPick && waiting.length) state.petPick = waiting[0];

  const damageOf = (n) => state.roster.seen.find((p) => p.name === n)?.damage ?? 0;
  $('pets-unmapped').replaceChildren(...(waiting.length
    ? waiting.map((n) => nameRow({
      name: n,
      selected: n === state.petPick,
      why: damageOf(n) > 0 ? `${Math.round(damageOf(n))} damage this fight` : 'fighting alongside you',
    }))
    : [emptyRow('Nothing is waiting for an owner.')]));

  const q = ($('pets-search').value || '').trim().toLowerCase();
  // A pet cannot own a pet, and neither can the name we are currently mapping.
  const owners = state.roster.seen
    .filter((p) => p.name !== state.petPick && !waiting.includes(p.name))
    .filter((p) => p.name.toLowerCase().includes(q));
  $('pets-owners').replaceChildren(...(owners.length
    ? owners.map((p) => nameRow({
      name: p.name,
      on: p.name === state.ownerPick,
      meta: p.self ? 'you' : (p.inGroup ? 'group' : ''),
    }))
    : [emptyRow('Nobody to pick from yet.')]));

  renderPetsInForce();

  $('pets-count').textContent = String(waiting.length);
  const pill = $('pets-pill');
  pill.textContent = waiting.length ? `${waiting.length} unmapped` : 'all mapped';
  pill.dataset.tone = waiting.length ? 'some' : 'all';
  const tag = $('tag-pets');
  if (tag) tag.textContent = waiting.length ? `${waiting.length} new` : '';

  $('pets-assign').disabled = !(state.petPick && state.ownerPick);
  $('pets-notpet').disabled = !state.petPick;
  $('pets-explain').textContent = !state.petPick
    ? 'Nothing is waiting. A pet that needs an owner will appear here on its own.'
    : state.ownerPick
      ? `${state.petPick}'s damage will fold into ${state.ownerPick}'s row from the next fight.`
      : `${state.petPick} is getting its own row. Pick its owner on the right.`;
}

/**
 * Every mapping currently applied, each labelled with where it came from.
 *
 * The provenance is the part the text box could not show: a mapping the log worked out
 * on its own reads very differently from one you typed, and a WEAK one — bound from cast
 * adjacency rather than a flavour line naming the owner — is the one worth checking.
 */
function renderPetsInForce() {
  // `petMappings` reports the learned bindings AND the saved ones, because the in-game
  // command writes what it learns straight to settings — so "is it in config" does not
  // by itself mean the player typed it. A binding the log worked out on its own is one
  // the log can correct; one that only exists in settings is not, and a WEAK one, bound
  // from cast adjacency rather than a line naming the owner, is the one worth checking.
  const learned = new Map(state.pets.mapped.map((m) => [m.pet, m]));
  const rows = [];
  for (const [pet, owner] of Object.entries(state.petOwners)) {
    const m = learned.get(pet);
    rows.push({
      pet,
      owner,
      src: !m || m.owner !== owner ? 'you set this'
        : m.weak ? 'from the log · weak' : 'from the log',
    });
  }
  for (const m of state.pets.mapped) {
    if (state.petOwners[m.pet]) continue;
    // A charm is a mapping in force RIGHT NOW and gone when the charm is — labelling it
    // like a durable binding would invite the player to expect it back next session.
    rows.push({
      pet: m.pet,
      owner: m.owner,
      src: m.charmed ? 'charmed right now' : m.weak ? 'from the log · weak' : 'from the log',
    });
  }
  rows.sort((a, b) => a.pet.localeCompare(b.pet));

  $('pets-inforce').replaceChildren(...(rows.length
    ? rows.map((r) => {
      const li = document.createElement('li');
      li.dataset.name = r.pet;
      const who = document.createElement('span');
      who.className = 'who';
      who.append(`${r.pet} = `);
      const b = document.createElement('b');
      b.textContent = r.owner;
      who.append(b);
      const src = document.createElement('span');
      src.className = 'meta';
      src.textContent = r.src;
      const rm = document.createElement('span');
      rm.className = 'rm';
      rm.dataset.remove = r.pet;
      rm.textContent = 'remove';
      li.append(who, src, rm);
      return li;
    })
    : [emptyRow('No pet is mapped to anybody yet.')]));
}

function fillForm(cfg) {
  $('dir').value = cfg.logDir ?? '';
  $('opacity').value = cfg.opacity;
  $('scale').value = cfg.scale;
  $('timeout').value = cfg.combatTimeoutSec;
  $('grace').value = cfg.postKillGraceSec;
  $('auto-switch').checked = cfg.autoSwitchCharacter;
  state.petOwners = { ...(cfg.petOwners ?? {}) };

  const session = cfg.session ?? {};
  $('session-enabled').checked = session.enabled === true;
  $('session-meter-line').checked = session.meterLine === true;
  // Absent reads as ON, matching `sessionCategories` in config.js: a config written
  // before a category existed must gain it switched on, not silently off.
  for (const c of SESSION_CATEGORIES) $(`session-${c}`).checked = session[c] !== false;
  syncSessionEnabled();

  $('mobile-enabled').checked = cfg.mobileEnabled === true;
  $('mobile-port').value = cfg.mobilePort ?? 8321;

  $('hk-lock').value = cfg.hotkeys.toggleLock;
  $('hk-show').value = cfg.hotkeys.toggleVisible;
  $('hk-reset').value = cfg.hotkeys.resetEncounter;
  $('hk-session').value = cfg.hotkeys.newSession ?? '';
  $('hk-metric').value = cfg.hotkeys.toggleMetric;
  $('hk-copy').value = cfg.hotkeys.copyReport ?? '';
  $('hk-alerts').value = cfg.hotkeys.toggleAlerts ?? '';
  syncOutputs();
}

/**
 * The one line this form still says about warnings.
 *
 * Everything that decides them moved to the Triggers window; what stays here is a
 * pointer and a count, so the form does not simply go silent about a feature it used to
 * own. Failure is silent by design — the count is a courtesy, and a settings screen must
 * still open when the trigger store cannot be read.
 */
async function renderTriggerSummary() {
  const el = $('triggers-summary');
  if (!el) return;
  try {
    const list = await window.api.triggersList();
    const packs = list.packs?.length ?? 0;
    const builtinOn = list.builtin?.stats?.on ?? 0;
    const builtinAll = list.builtin?.stats?.rules ?? 0;
    el.textContent = `${builtinOn} of ${builtinAll} built-in rules on · ${packs} imported pack(s)`;
  } catch {
    el.textContent = '';
  }
}

/**
 * What EverQuest itself currently does about logging.
 *
 * Every uncertain answer says so rather than guessing. Claiming logging is off when the
 * ini simply could not be found would send the player to fix a setting that is not
 * broken; the button stays available in that case, because trying it is how they find out.
 */
async function renderLoggingState() {
  const el = $('enable-log-status');
  const btn = $('enable-log');
  if (!el || !btn) return;

  let state = { ok: false };
  try {
    state = await window.api.eqconfigState();
  } catch {
    // No log chosen yet (first-run setup) — an empty status is the honest answer.
  }

  if (!state.ok) {
    setStatus(el, state.reason === 'no-path'
      ? 'Choose a log file first — that is how the game folder is found.'
      : 'eqclient.ini could not be read.', '');
    btn.disabled = state.reason === 'no-path';
    return;
  }

  btn.disabled = state.logEnabled === true;
  if (state.logEnabled === true) {
    setStatus(el, 'EverQuest is already set to log every session.', 'ok');
  } else if (state.gameRunning) {
    setStatus(el, 'EverQuest is running — close it first, it rewrites this file on exit.', 'warn');
  } else {
    setStatus(el, 'Sets Log=1 in eqclient.ini. One line, original backed up.', '');
  }
}

/**
 * Grey out everything the master switch governs while it is off.
 *
 * Disabled rather than hidden: a player looking for "does this thing record loot" needs
 * to see that it can, and that it is not currently doing so. A section that vanishes
 * answers neither question. The checkboxes keep their values while disabled, so switching
 * tracking off and on again restores the choices rather than resetting them.
 */
function syncSessionEnabled() {
  const on = $('session-enabled').checked;
  $('session-meter-line').disabled = !on;
  for (const c of SESSION_CATEGORIES) $(`session-${c}`).disabled = !on;
  $('session-categories').classList.toggle('disabled', !on);
  $('open-session').disabled = !on;
}

/**
 * What the session store has, in one line.
 *
 * The same courtesy the trigger summary pays, and silent on failure for the same reason:
 * a settings screen must still open when a store cannot be read.
 */
async function renderSessionSummary() {
  const el = $('session-summary');
  if (!el) return;
  try {
    const list = await window.api.sessionList(null);
    const n = list.sessions?.length ?? 0;
    const chars = list.characters?.length ?? 0;
    el.textContent = n === 0
      ? 'no sessions recorded yet'
      : `${n} session(s) recorded · ${chars} character(s)`;
  } catch {
    el.textContent = '';
  }
}

function syncOutputs() {
  $('opacity-out').textContent = `${Math.round($('opacity').value * 100)}%`;
  $('scale-out').textContent = `${Number($('scale').value).toFixed(2)}×`;
}

function wireEvents() {
  $('opacity').addEventListener('input', syncOutputs);
  $('scale').addEventListener('input', syncOutputs);

  $('rail').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-page]');
    if (!b) return;
    showPage(b.dataset.page);
    // Refreshed on entry rather than polled: who is here changes constantly during a
    // raid, and a picker showing the roster as it was when settings opened would offer
    // names that have left and hide the person who just walked up.
    if (b.dataset.page === 'party') refreshRoster().then(renderParty);
    if (b.dataset.page === 'pets') refreshRoster().then(renderPets);
  });

  $('party-search').addEventListener('input', renderParty);
  $('party-seen').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-name]');
    if (li) toggleParty(li.dataset.name);
  });
  $('party-picked').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-name]');
    if (li) { state.party.delete(li.dataset.name); renderParty(); }
  });
  $('party-all').addEventListener('click', () => { state.party.clear(); renderParty(); });
  // A seed, not a filter of its own: it fills the list from what the game said about your
  // group, and every name in it is then yours to remove. That is the difference between
  // this and the `groupOnly` switch it replaced, which decided and never showed its work.
  $('party-group').addEventListener('click', () => {
    state.party = new Set(state.roster.group);
    renderParty();
  });
  $('party-add').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const name = e.target.value.trim();
    if (name) state.party.add(name);
    e.target.value = '';
    renderParty();
  });

  $('pets-unmapped').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-name]');
    if (!li) return;
    state.petPick = li.dataset.name;
    renderPets();
  });
  $('pets-search').addEventListener('input', renderPets);
  $('pets-owners').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-name]');
    if (!li) return;
    state.ownerPick = state.ownerPick === li.dataset.name ? null : li.dataset.name;
    renderPets();
  });
  $('pets-assign').addEventListener('click', () => {
    if (!state.petPick || !state.ownerPick) return;
    state.petOwners[state.petPick] = state.ownerPick;
    state.petPick = null;
    state.ownerPick = null;
    renderPets();
  });
  $('pets-notpet').addEventListener('click', async () => {
    const pet = state.petPick;
    if (!pet) return;
    delete state.petOwners[pet];
    state.petPick = null;
    // Straight through rather than waiting for Save: this one is a blacklist in the
    // running parser, and a summon firing nearby before you press Save would re-learn
    // the very binding you just rejected.
    try { await window.api.notAPet(pet); } catch { /* no parser yet */ }
    await renderPets();
  });
  $('pets-inforce').addEventListener('click', async (e) => {
    const pet = e.target.dataset?.remove;
    if (!pet) return;
    delete state.petOwners[pet];
    try { await window.api.notAPet(pet); } catch { /* no parser yet */ }
    await renderPets();
  });

  $('open-triggers').addEventListener('click', () => window.api.openTriggers());
  $('open-session').addEventListener('click', () => window.api.openSession());
  $('session-enabled').addEventListener('change', syncSessionEnabled);
  $('open-mobile').addEventListener('click', () => window.api.openSecondScreen());
  // The Second Screen dialog writes this same key immediately; the checkbox follows
  // it live so what this form shows — and what Save will write back — is always what
  // is actually true, never a stale snapshot from when the window opened.
  window.api.onConfigChanged?.((cfg) => {
    $('mobile-enabled').checked = cfg.mobileEnabled === true;
  });

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

  $('enable-log').addEventListener('click', async () => {
    if (!window.confirm(
      'Set Log=1 in eqclient.ini?\n\n' +
      'That is EverQuest\'s own "always log" setting, so you never have to type ' +
      '/log on again. Only that one line is changed, and the original file is backed ' +
      'up first.\n\nThe game must be closed — it rewrites this file when it exits.'
    )) return;
    const r = await window.api.enableGameLogging();
    if (!r.ok) setStatus($('enable-log-status'), r.error, 'bad');
    else if (!r.changed) setStatus($('enable-log-status'), 'Already set — nothing to do.', 'ok');
    else setStatus($('enable-log-status'), 'Done. EverQuest will log every session from now on.', 'ok');
    await renderLoggingState();
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
    autoSwitchCharacter: $('auto-switch').checked,
    // Merged over what is stored, never replacing it: the picker only ever edits the
    // character currently logged in, and writing the whole map would wipe every other
    // character's list on every Save.
    partyMembers: state.roster.key
      ? { ...(state.config.partyMembers ?? {}), [state.roster.key]: [...state.party] }
      : (state.config.partyMembers ?? {}),
    // The alert and timer switches are deliberately absent: they belong to the Triggers
    // window now, and a form that still wrote them would clobber whatever was set there
    // the next time somebody pressed Save on an unrelated setting.
    petOwners: { ...state.petOwners },
    // Written whole, because this form is the only screen that owns them — unlike the
    // alert switches above, which moved out precisely so a Save here would stop clobbering
    // what the Triggers window had just set.
    session: {
      enabled: $('session-enabled').checked,
      meterLine: $('session-meter-line').checked,
      ...Object.fromEntries(SESSION_CATEGORIES.map((c) => [c, $(`session-${c}`).checked])),
    },
    // Written by this form AND by the Second Screen dialog — safe only because the
    // checkbox tracks CONFIG_CHANGED live, so a Save can never write back a state
    // the dialog already replaced. That live follow is the contract; removing it
    // reopens the clobber the alert switches left this form over.
    mobileEnabled: $('mobile-enabled').checked,
    // A blank or mangled port falls back rather than saving NaN; main clamps the same
    // way, so the two can only ever agree on what actually gets bound.
    mobilePort: Math.min(65535, Math.max(1024, Number($('mobile-port').value) || 8321)),
    hotkeys: {
      toggleLock: $('hk-lock').value.trim(),
      toggleVisible: $('hk-show').value.trim(),
      resetEncounter: $('hk-reset').value.trim(),
      newSession: $('hk-session').value.trim(),
      toggleMetric: $('hk-metric').value.trim(),
      copyReport: $('hk-copy').value.trim(),
      toggleAlerts: $('hk-alerts').value.trim(),
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
