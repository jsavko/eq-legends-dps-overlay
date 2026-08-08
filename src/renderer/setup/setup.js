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

  await loadDirectory(state.config.logDir);
  if (state.selected) await validate(state.selected);
  await renderPets();
  await renderTriggerSummary();
  await renderSessionSummary();
  await renderLoggingState();
  refreshSaveButton();
}

/**
 * What the parser currently knows about pets.
 *
 * The `Pet = Owner` box has existed since the first version and never told anyone
 * which names needed an entry — you had to already know the answer, which made the
 * setting unusable in practice. This shows both halves: what the log has worked out on
 * its own, and the names still sitting in the honest "unknown" state, each one a click
 * away from a line in the box above.
 */
async function renderPets() {
  const learnedEl = $('pets-learned');
  const list = $('pets-unmapped');
  if (!learnedEl || !list) return;

  let pets = { mapped: [], unmapped: [] };
  try {
    pets = await window.api.petsState();
  } catch {
    // No parser yet (first-run setup, before a log is chosen) — an empty list is right.
  }

  const learned = pets.mapped.filter((m) => m.weak || !state.config.petOwners?.[m.pet]);
  learnedEl.textContent = learned.length
    ? `Worked out from the log: ${learned.map((m) => `${m.pet} = ${m.owner}`).join(', ')}.`
    : 'Nothing has been worked out from the log yet.';

  const already = new Set(Object.keys(state.config.petOwners ?? {}));
  const names = pets.unmapped.filter((n) => !already.has(n));
  list.replaceChildren(...names.map((name) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = name;
    btn.addEventListener('click', () => {
      const box = $('pet-owners');
      const lines = box.value.split('\n').filter((l) => l.trim());
      if (!lines.some((l) => l.split('=')[0].trim() === name)) lines.push(`${name} = `);
      box.value = lines.join('\n');
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
    li.append(btn);
    return li;
  }));
  if (names.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'none';
    list.append(li);
  }
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

  const session = cfg.session ?? {};
  $('session-enabled').checked = session.enabled === true;
  $('session-meter-line').checked = session.meterLine === true;
  // Absent reads as ON, matching `sessionCategories` in config.js: a config written
  // before a category existed must gain it switched on, not silently off.
  for (const c of SESSION_CATEGORIES) $(`session-${c}`).checked = session[c] !== false;
  syncSessionEnabled();

  $('hk-lock').value = cfg.hotkeys.toggleLock;
  $('hk-show').value = cfg.hotkeys.toggleVisible;
  $('hk-reset').value = cfg.hotkeys.resetEncounter;
  $('hk-metric').value = cfg.hotkeys.toggleMetric;
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

  $('open-triggers').addEventListener('click', () => window.api.openTriggers());
  $('open-session').addEventListener('click', () => window.api.openSession());
  $('session-enabled').addEventListener('change', syncSessionEnabled);

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
    groupOnly: $('group-only').checked,
    autoSwitchCharacter: $('auto-switch').checked,
    // The alert and timer switches are deliberately absent: they belong to the Triggers
    // window now, and a form that still wrote them would clobber whatever was set there
    // the next time somebody pressed Save on an unrelated setting.
    petOwners: parsePetOwners($('pet-owners').value),
    // Written whole, because this form is the only screen that owns them — unlike the
    // alert switches above, which moved out precisely so a Save here would stop clobbering
    // what the Triggers window had just set.
    session: {
      enabled: $('session-enabled').checked,
      meterLine: $('session-meter-line').checked,
      ...Object.fromEntries(SESSION_CATEGORIES.map((c) => [c, $(`session-${c}`).checked])),
    },
    hotkeys: {
      toggleLock: $('hk-lock').value.trim(),
      toggleVisible: $('hk-show').value.trim(),
      resetEncounter: $('hk-reset').value.trim(),
      toggleMetric: $('hk-metric').value.trim(),
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
