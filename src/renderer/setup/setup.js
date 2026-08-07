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
  $('cast-alerts').checked = cfg.castAlerts;
  $('cast-alert-sound').checked = cfg.castAlertSound;
  $('summon-alerts').checked = cfg.summonAlerts;
  $('cc-alerts').checked = cfg.ccAlerts;
  $('cast-timers').checked = cfg.castTimers;
  for (const group of WARN_GROUPS) {
    $(`warn-${group}`).checked = warnGroupOn(cfg, group);
  }
  $('pet-owners').value = formatPetOwners(cfg.petOwners);
  $('hk-lock').value = cfg.hotkeys.toggleLock;
  $('hk-show').value = cfg.hotkeys.toggleVisible;
  $('hk-reset').value = cfg.hotkeys.resetEncounter;
  $('hk-metric').value = cfg.hotkeys.toggleMetric;
  $('hk-alerts').value = cfg.hotkeys.toggleAlerts ?? '';
  syncOutputs();
  syncAlertSound();
  syncPreset();
}

function syncOutputs() {
  $('opacity-out').textContent = `${Math.round($('opacity').value * 100)}%`;
  $('scale-out').textContent = `${Number($('scale').value).toFixed(2)}×`;
}

/**
 * The six warning groups, and the presets that write them.
 *
 * Mirrors `WARN_GROUPS` / `ALERT_PRESETS` in main/config.js, which this window cannot
 * import (that module reaches for `fs`). The checkbox ids follow the same convention
 * the renderer's group lookup does — group `bigHits` is `#warn-bigHits` and config key
 * `warnBigHits` — so all three sides are one rule rather than three lists.
 */
const WARN_GROUPS = ['heals', 'control', 'bigHits', 'locks', 'routine', 'unknown'];
const WARN_DEFAULTS = {
  heals: true, control: true, bigHits: true, locks: true, routine: false, unknown: false,
};
const PRESETS = {
  essential: { heals: true, control: true, bigHits: true, locks: false, routine: false, unknown: false },
  balanced: { heals: true, control: true, bigHits: true, locks: true, routine: false, unknown: false },
  everything: { heals: true, control: true, bigHits: true, locks: true, routine: true, unknown: true },
};

const warnKeyFor = (group) => `warn${group[0].toUpperCase()}${group.slice(1)}`;

/** A missing key reads as its default, matching `warnGroupOn` in main/config.js. */
function warnGroupOn(cfg, group) {
  return (cfg?.[warnKeyFor(group)] ?? WARN_DEFAULTS[group]) !== false;
}

/** The cue only plays for drawn interrupt warnings, so it follows their checkbox. */
function syncAlertSound() {
  $('cast-alert-sound').disabled = !$('cast-alerts').checked;
  // Every group switch is meaningless while warnings are off, and a live-looking
  // checkbox that changes nothing is worse than a greyed-out one.
  $('warn-groups').toggleAttribute('data-disabled', !$('cast-alerts').checked);
}

/**
 * Light whichever preset the six boxes currently amount to, or show "Custom".
 *
 * Derived on every change rather than remembered, for the same reason `presetOf` in
 * main/config.js is derived: a stored preset and the boxes under it can disagree, and
 * the one that would be wrong is the label the player is reading.
 */
function syncPreset() {
  const state = Object.fromEntries(WARN_GROUPS.map((g) => [g, $(`warn-${g}`).checked]));
  const match = Object.keys(PRESETS).find(
    (name) => WARN_GROUPS.every((g) => PRESETS[name][g] === state[g]),
  );
  for (const btn of document.querySelectorAll('.preset-btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.preset === match));
  }
  document.querySelector('.preset-custom').hidden = Boolean(match);
}

/** Selecting a preset writes all six boxes — see ALERT_PRESETS for why all six. */
function applyPreset(name) {
  for (const group of WARN_GROUPS) $(`warn-${group}`).checked = PRESETS[name][group];
  syncPreset();
}

function wireEvents() {
  $('opacity').addEventListener('input', syncOutputs);
  $('scale').addEventListener('input', syncOutputs);
  $('cast-alerts').addEventListener('change', syncAlertSound);
  for (const group of WARN_GROUPS) {
    $(`warn-${group}`).addEventListener('change', syncPreset);
  }
  for (const btn of document.querySelectorAll('.preset-btn')) {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  }

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
    castAlerts: $('cast-alerts').checked,
    castAlertSound: $('cast-alert-sound').checked,
    summonAlerts: $('summon-alerts').checked,
    ccAlerts: $('cc-alerts').checked,
    castTimers: $('cast-timers').checked,
    ...Object.fromEntries(
      WARN_GROUPS.map((group) => [warnKeyFor(group), $(`warn-${group}`).checked]),
    ),
    petOwners: parsePetOwners($('pet-owners').value),
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
