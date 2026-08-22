/**
 * The Triggers window: every source of a warning, in one place.
 *
 * Holds no engine state. It asks main for the pack list, renders it, and sends back the
 * one thing the player changed.
 *
 * TWO panes plus dialogs, not three panes. The editor was originally docked as a 380px
 * third column and it was unreadable — a pattern field, a token row and a test result do
 * not fit beside a list. Editing is now a dialog: a task you open, finish and leave.
 *
 * The built-in rules are just the first source. That is the point of this window: "what
 * may put something on my screen" is one question, and it used to be answered in two
 * places that could quietly disagree.
 */

const $ = (id) => document.getElementById(id);

const BUILTIN_ID = '__builtin__';

const state = {
  cfg: null,
  builtin: null,
  packs: [],
  /** Full pack bodies, fetched on demand and cached until the next refresh. */
  bodies: new Map(),
  /** Dry-run results per pack id — what actually fired against the player's own log. */
  dryRuns: new Map(),
  selectedPack: BUILTIN_ID,
  /** The editor draft, or null when the dialog is closed. */
  draft: null,
  /** The built-in row the info dialog is open on, so its recipe can be taken away. */
  infoRow: null,
  rankTolerant: false,
};

init();

async function init() {
  await refresh();
  wire();
  // The same switches are reachable from the tray mid-raid, so a window left open beside
  // the game can go stale. Re-reading on focus is enough — nothing changes while you are
  // looking at it except by your own hand. Never mid-edit: that would drop the draft.
  window.addEventListener('focus', () => { if (!state.draft) refresh(); });
}

async function refresh({ keepSelection = true } = {}) {
  const [cfg, list] = await Promise.all([window.api.getConfig(), window.api.list()]);
  state.cfg = cfg;
  state.builtin = list.builtin;
  state.packs = list.packs ?? [];
  state.bodies.clear();

  if (!keepSelection || !packById(state.selectedPack)) state.selectedPack = BUILTIN_ID;

  renderSurfaces();
  renderRail();
  await renderContents();
}

const packById = (id) =>
  id === BUILTIN_ID ? state.builtin : state.packs.find((p) => p.id === id) ?? null;

function text(kind, content, cls) {
  const el = document.createElement(kind);
  el.textContent = content;
  if (cls) el.className = cls;
  return el;
}

function tag(label, cls) {
  return text('span', label, `tag${cls ? ` ${cls}` : ''}`);
}

/* ------------------------------------------------------------------ titlebar */

function renderSurfaces() {
  $('surfaces').toggleAttribute('data-muted', state.cfg?.alertsMuted === true);
  $('surface-chips').setAttribute('aria-pressed', String(state.cfg?.triggerAlerts !== false));
  $('surface-timers').setAttribute('aria-pressed', String(state.cfg?.triggerTimers !== false));

  const on = state.packs.filter((p) => p.enabled).length + (state.builtin?.enabled ? 1 : 0);
  const rules = (state.builtin?.stats.on ?? 0) +
    state.packs.filter((p) => p.enabled).reduce((n, p) => n + (p.live ?? 0), 0);
  $('summary').textContent =
    `${on} of ${state.packs.length + 1} sources on · ${rules} rules running`;
}

/* ------------------------------------------------------------------ rail */

function renderRail() {
  const list = $('packs');
  list.replaceChildren();

  for (const pack of [state.builtin, ...state.packs].filter(Boolean)) {
    const li = document.createElement('li');
    li.setAttribute('aria-selected', String(pack.id === state.selectedPack));
    li.addEventListener('click', () => selectPack(pack.id));

    const row = document.createElement('div');
    row.className = 'pack-row';

    const sw = document.createElement('button');
    sw.className = 'sw';
    sw.setAttribute('aria-pressed', String(pack.enabled));
    sw.title = pack.id === BUILTIN_ID
      ? 'Switch every built-in rule on or off'
      : 'Switch this pack on or off';
    sw.append(document.createElement('i'));
    // The switch must not also select the pack: they are different intents, and a click
    // that did both would make "just look at this one" impossible without changing it.
    sw.addEventListener('click', (e) => { e.stopPropagation(); togglePack(pack); });

    row.append(sw, text('span', pack.name, 'pack-name'));

    const meta = document.createElement('div');
    meta.className = 'pack-meta';
    meta.append(text('span', statLine(pack)));
    if (pack.origin === 'builtin') meta.append(tag('built-in', 'builtin'));
    else if (pack.origin === 'gina') meta.append(tag('GINA'));
    else meta.append(tag('authored'));
    if (pack.edited) meta.append(tag('edited', 'edited'));

    li.append(row, meta);
    list.append(li);
  }

  const selected = packById(state.selectedPack);
  const real = selected && selected.id !== BUILTIN_ID;
  $('export').disabled = !real;
  $('remove').disabled = !real;
}

function statLine(pack) {
  if (pack.id === BUILTIN_ID) return `${pack.stats.rules} rules · ${pack.stats.on} on`;
  const dry = state.dryRuns.get(pack.id);
  if (dry) {
    const fired = dry.triggers.filter((t) => t.hits > 0).length;
    return `${fired} of ${dry.triggers.length} firing`;
  }
  return `${pack.triggers} triggers · ${pack.live} on`;
}

async function selectPack(id) {
  if (state.selectedPack === id) return;
  state.selectedPack = id;
  renderRail();
  await renderContents();
}

async function togglePack(pack) {
  if (pack.id === BUILTIN_ID) {
    // The built-in "source switch" is derived from its rows, so switching it off means
    // switching all of them off — and switching it back on restores the Balanced preset
    // rather than a blanket everything-on, which would be louder than anything the
    // player ever chose.
    const on = !pack.enabled;
    for (const row of pack.rows) {
      if (row.kind === 'option') continue;
      await window.api.setBuiltin(row.key, on);
    }
    if (on) await window.api.setPreset('balanced');
  } else {
    await window.api.setEnabled(pack.id, !pack.enabled);
  }
  await refresh();
}

/* ------------------------------------------------------------------ contents */

async function renderContents() {
  const pack = packById(state.selectedPack);
  const rows = $('rows');
  rows.replaceChildren();
  if (!pack) return;

  $('pack-name').textContent = pack.name;
  const builtin = pack.id === BUILTIN_ID;
  $('presets').hidden = !builtin;
  $('measured').hidden = true;

  if (builtin) {
    $('pack-sub').textContent = 'the rules this app ships with';
    $('pack-note').textContent =
      'Built in and always present — it cannot be removed. Every rule here is a real ' +
      'pattern read straight out of the parser: click one to see it, and to take a ' +
      'working copy into a trigger of your own.';
    renderPresets(pack);
    renderBuiltinRows(pack);
    return;
  }

  $('pack-sub').textContent = pack.origin === 'gina' ? 'imported from GINA' : 'yours';
  $('pack-note').textContent = pack.comments ?? '';
  await renderPackRows(pack);
}

function renderPresets(pack) {
  for (const btn of document.querySelectorAll('.preset')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.preset === pack.preset));
  }
  $('preset-custom').hidden = Boolean(pack.preset);
}

function section(label, right) {
  const li = document.createElement('li');
  li.className = 'section';
  li.append(text('span', label));
  li.append(Object.assign(document.createElement('span'), { className: 'rule' }));
  if (right) li.append(text('span', right));
  return li;
}

function renderBuiltinRows(pack) {
  const rows = $('rows');
  rows.append(section('WHAT WARNS ME', `${pack.stats.on} of ${pack.stats.rules} on`));

  // One block, no second heading. There used to be an "OTHER SURFACES" split for the boss
  // timers row; the timers are a trigger pack now, so every rule here draws to one place.
  for (const row of pack.rows) {
    const li = document.createElement('li');
    li.className = `row${row.parent ? ' child' : ''}${row.inert ? ' inert' : ''}`;
    li.append(switchBox(row.enabled, async () => {
      await window.api.setBuiltin(row.key, !row.enabled);
      await refresh();
    }));

    const wrap = document.createElement('div');
    wrap.className = 'row-text';
    const nameRow = document.createElement('div');
    nameRow.className = 'row-name';
    nameRow.append(text('span', row.name));
    if (row.kind === 'group') nameRow.append(tag('group'));
    wrap.append(nameRow, text('div', row.sub, 'row-sub'));
    // The real pattern, under the name, in the same treatment an imported trigger's gets.
    // That symmetry IS the change: a stranger's trigger has always shown its pattern here
    // and the rules this app ships with showed prose, which is what made ours the only
    // thing in the window a player could not read.
    if (row.pattern) wrap.append(text('div', row.pattern, 'row-pattern'));
    li.append(wrap);

    // Only rows with something to explain are clickable, so a click that opens nothing
    // is impossible rather than merely unlikely.
    if (row.why) {
      li.append(text('span', 'details ›', 'row-go'));
      li.addEventListener('click', (e) => {
        if (e.target.closest('.box')) return;
        openInfo(row);
      });
    } else {
      li.style.cursor = 'default';
    }
    rows.append(li);
  }
}

function switchBox(on, onToggle) {
  const box = document.createElement('button');
  box.className = 'box';
  box.setAttribute('aria-pressed', String(on));
  box.addEventListener('click', (e) => { e.stopPropagation(); onToggle(); });
  return box;
}

async function renderPackRows(pack) {
  const rows = $('rows');
  const body = await packBody(pack.id);
  if (!body) return;

  const dry = state.dryRuns.get(pack.id);
  renderMeasured(dry);

  if (body.groups?.length) {
    rows.append(section('GROUPS', String(body.groups.length)));
    for (const group of body.groups) {
      const li = document.createElement('li');
      li.className = 'row';
      li.style.cursor = 'default';
      li.append(switchBox(group.enabled, async () => {
        await window.api.setPartEnabled({ id: pack.id, groupId: group.id, enabled: !group.enabled });
        await refresh();
      }));
      const wrap = document.createElement('div');
      wrap.className = 'row-text';
      const nameRow = document.createElement('div');
      nameRow.className = 'row-name';
      nameRow.append(text('span', group.name), tag('group'));
      wrap.append(nameRow, text('div',
        `${body.triggers.filter((t) => t.groupId === group.id).length} triggers in this group`,
        'row-sub'));
      li.append(wrap);
      rows.append(li);
    }
  }

  rows.append(section('TRIGGERS', String(body.triggers.length)));
  if (!body.triggers.length) {
    const empty = document.createElement('li');
    empty.className = 'hint-block';
    empty.append(text('p',
      'Nothing here yet. Press “+ New trigger” to write one — you give it a pattern, say ' +
      'what it should show, and test it against your own log before you trust it.',
      'muted small'));
    rows.append(empty);
  }

  for (const trigger of body.triggers) {
    const measured = dry?.triggers.find((t) => t.id === trigger.id);
    rows.append(triggerRow(pack.id, trigger, measured));
  }
}

function triggerRow(packId, trigger, measured) {
  const dead = measured && (measured.hits === 0 || measured.error);
  const li = document.createElement('li');
  li.className = `row${dead ? ' dead' : ''}`;

  li.append(switchBox(trigger.enabled, async () => {
    await window.api.setPartEnabled({ id: packId, triggerId: trigger.id, enabled: !trigger.enabled });
    await refresh();
  }));

  const wrap = document.createElement('div');
  wrap.className = 'row-text';
  const nameRow = document.createElement('div');
  nameRow.className = 'row-name';
  nameRow.append(text('span', trigger.name));
  wrap.append(nameRow, text('div', trigger.pattern, 'row-pattern'));
  li.append(wrap);

  if (measured?.error) li.append(text('span', 'will not compile', 'hits dead'));
  else if (measured?.hits === 0) li.append(text('span', 'never matched', 'hits dead'));
  else if (measured) li.append(text('span', measured.hits.toLocaleString(), 'hits'));

  li.append(text('span', 'edit ›', 'row-go'));
  li.addEventListener('click', (e) => {
    if (e.target.closest('.box')) return;
    openEditor(packId, trigger.id);
  });
  return li;
}

function renderMeasured(dry) {
  const box = $('measured');
  if (!dry) { box.hidden = true; return; }
  box.hidden = false;

  const fired = dry.triggers.filter((t) => t.hits > 0).length;
  const dead = dry.triggers.length - fired;
  $('measured-text').textContent =
    `${fired} of ${dry.triggers.length} fired against your last ${dry.lines.toLocaleString()} lines`;
  $('measured-note').textContent = dead
    ? `Measured against your own log, not ours. ${dead} never matched — their patterns ` +
      'are shown below so you can see why.'
    : 'Measured against your own log, not ours. Everything here fired at least once.';

  const gain = dry.triggers.reduce((n, t) => n + Math.max(0, t.adapted?.gain ?? 0), 0);
  $('rank-label').textContent = state.rankTolerant
    ? `allow rank suffixes (+${gain})`
    : 'allow rank suffixes';
  $('rank-tolerant').checked = state.rankTolerant;
}

async function packBody(id) {
  if (state.bodies.has(id)) return state.bodies.get(id);
  const pack = await window.api.get(id);
  state.bodies.set(id, pack);
  return pack;
}

/* ------------------------------------------------------------------ info dialog */

/**
 * What a copy of a built-in rule's pattern cannot carry with it.
 *
 * Stated in the dialog rather than left for the player to discover, because the copy
 * button would otherwise imply the two are equal. They are not, and the difference is
 * everything the PARSER knows around the pattern — none of which a regex has an opinion
 * about. This is the one place where "everything the app ships is a real trigger" stops,
 * and the honest thing is to say so beside the button that pretends otherwise.
 */
const RECIPE_GAPS = [
  'Whether the caster is an enemy. The built-in rule checks the roster and what the ' +
  'fight has engaged first; a copy fires on a line a player typed into /general.',
  'How loud to be. The built-in rule ranks a heal above a root, and draws a banner for ' +
  'one and a calm line for the other. A copy draws every match the same way.',
  'That an interrupt cancels it. The built-in warning clears itself the moment the log ' +
  'confirms the interrupt — which is the whole point of calling for one.',
  'Your six SHOW switches. Those gate the built-in rules; a copy of one is a trigger ' +
  'like any other and fires whatever preset you are on.',
];

/** One row's real patterns and the trigger they amount to. Everything shown is derived
 *  in `builtin-pack.js` from the live tables — nothing here is a stored copy. */
function openInfo(row) {
  $('i-name').textContent = row.name;
  $('i-sub').textContent = row.sub ?? '';
  $('i-why').textContent = row.why;

  const lines = row.matches?.lines ?? [];
  const spells = row.matches?.spells ?? [];
  $('i-lines-note').textContent = lines.length === 1
    ? `The log line it reads — rules.js, ${lines[0].id}`
    : `The log lines it reads — rules.js, ${lines.map((l) => l.id).join(', ')}`;
  $('i-lines').replaceChildren(...lines.map((l) => text('li', l.source)));
  // A row with no spell filter reads every cast its rule matches, and saying nothing here
  // would leave that looking like a section somebody forgot to fill in.
  $('i-spells-note').textContent = spells.length
    ? `…and which of those casts belong here — spellwatch.js, ${spells.length} patterns`
    : '';
  $('i-spells-note').hidden = !spells.length;
  $('i-spells').replaceChildren(...spells.map((s) => {
    const li = document.createElement('li');
    li.append(Object.assign(document.createElement('b'), { textContent: s.category }), `  ${s.source}`);
    return li;
  }));
  $('i-how-wrap').hidden = !lines.length;

  $('i-catches').replaceChildren(...(row.catches ?? []).map((s) => text('li', s)));
  $('i-catches-wrap').hidden = !(row.catches ?? []).length;

  // A row with no recipe is a modifier rather than a rule — the sound switch is not a
  // thing that matches, so there is nothing to copy and nothing to warn about copying.
  const recipe = row.recipe ?? null;
  $('i-pattern').textContent = recipe?.pattern ?? '';
  $('i-show').textContent = recipe?.warnText ?? '';
  $('i-recipe-wrap').hidden = !recipe;
  $('i-gap-wrap').hidden = !recipe;
  $('i-start-from').hidden = !recipe;
  $('i-gaps').replaceChildren(...RECIPE_GAPS.map((s) => text('li', s)));

  state.infoRow = row;
  $('info').showModal();
}

/* ------------------------------------------------------------------ editor dialog */

async function openEditor(packId, triggerId) {
  const body = await packBody(packId);
  const trigger = body?.triggers.find((t) => t.id === triggerId);
  if (!trigger) return;

  state.draft = {
    packId,
    triggerId,
    packName: body.name,
    groups: body.groups ?? [],
    groupId: trigger.groupId ?? '',
    newGroupName: '',
    isNew: false,
    name: trigger.name,
    pattern: trigger.pattern,
    literal: Boolean(trigger.literal),
    warnText: trigger.warn?.text ?? '',
    timerKind: trigger.timer ? (trigger.timer.kind === 'repeating' ? 'repeating' : 'countdown') : 'none',
    durationSec: trigger.timer ? Math.round(trigger.timer.durationMs / 1000) : 60,
    earlyEndText: trigger.timer?.earlyEnders?.[0]?.pattern ?? '',
    test: null,
    errors: [],
  };
  showEditor();
}

/**
 * A blank trigger, or one prefilled from somewhere.
 *
 * @param {{from?: {name, pattern, literal, warnText, timerKind, durationSec}}} [opts]
 *   `from` is a built-in rule's recipe, in the field names this draft already uses — which
 *   is why `builtin-pack.js` builds it in exactly that shape and this needs no translation.
 */
async function newTrigger({ from = null } = {}) {
  const pack = packById(state.selectedPack);
  // A built-in row has no pack to save into, so an authored trigger always lands in
  // "My Triggers" — main creates it on first use.
  const real = pack && pack.id !== BUILTIN_ID ? pack : null;
  const body = real ? await packBody(real.id) : null;

  state.draft = {
    packId: real?.id ?? null,
    triggerId: null,
    packName: real?.name ?? 'My Triggers',
    groups: body?.groups ?? [],
    groupId: '',
    newGroupName: '',
    isNew: true,
    name: from?.name ?? '',
    pattern: from?.pattern ?? '',
    literal: Boolean(from?.literal),
    warnText: from?.warnText ?? '',
    timerKind: from?.timerKind ?? 'none',
    durationSec: from?.durationSec ?? 60,
    earlyEndText: '',
    test: null,
    errors: [],
  };
  showEditor();
  $('e-name').focus();
}

function showEditor() {
  writeEditorFields();
  syncEditor();
  if (!$('editor').open) $('editor').showModal();
}

/** The sentinel the "make one" option carries. Not a valid group id — those are `gN`. */
const NEW_GROUP = '__new__';

/** Draft -> inputs. Only on open: doing it on every keystroke would fight the caret. */
function writeEditorFields() {
  const d = state.draft;
  $('e-name').value = d.name;
  $('e-pattern').value = d.pattern;
  $('e-warn').value = d.warnText;
  $('e-timer-kind').value = d.timerKind;
  $('e-duration').value = d.durationSec;
  $('e-early').value = d.earlyEndText;

  const select = $('e-group');
  select.replaceChildren();
  select.append(new Option('No group', ''));
  for (const group of d.groups) select.append(new Option(group.name, group.id));
  select.append(new Option('＋ New group…', NEW_GROUP));
  select.value = d.groups.some((g) => g.id === d.groupId) ? d.groupId : '';
  $('e-new-group').value = d.newGroupName;
}

/** Inputs -> draft. */
function readEditor() {
  const d = state.draft;
  if (!d) return;
  d.name = $('e-name').value;
  d.pattern = $('e-pattern').value;
  d.warnText = $('e-warn').value;
  d.timerKind = $('e-timer-kind').value;
  d.durationSec = Number($('e-duration').value) || 0;
  d.earlyEndText = $('e-early').value;

  const chosen = $('e-group').value;
  d.groupId = chosen === NEW_GROUP ? '' : chosen;
  d.newGroupName = chosen === NEW_GROUP ? $('e-new-group').value : '';
}

/** Everything that is derived from the draft rather than typed into it. */
function syncEditor() {
  const d = state.draft;
  if (!d) return;

  $('e-title').textContent = d.isNew ? 'New trigger' : d.name || 'Trigger';
  $('e-provenance').textContent = d.isNew
    ? `Saves into ${d.packName} — your own work never lands inside a pack you imported.`
    : `From ${d.packName} · saving marks the pack edited, so a later export is honest ` +
      'about no longer being upstream.';

  $('e-regex').setAttribute('aria-pressed', String(!d.literal));
  $('e-literal').setAttribute('aria-pressed', String(d.literal));

  const timed = d.timerKind !== 'none';
  $('e-duration').hidden = !timed;
  $('e-seconds').hidden = !timed;
  $('e-timer-hint').hidden = timed;
  $('e-early-wrap').hidden = !timed;

  // The name field appears only once "New group…" is chosen, so the common case — leaving
  // it alone, or filing into a group the pack already has — shows one control and not two.
  $('e-new-group').hidden = $('e-group').value !== NEW_GROUP;

  // Live compile check — the engine's own message, never rewritten into something
  // friendlier that could be wrong.
  const err = d.literal ? null : compileError(d.pattern);
  $('e-pattern').setAttribute('aria-invalid', String(Boolean(err)));
  $('e-pattern-error').textContent = err ?? '';
  $('e-pattern-error').hidden = !err;
  $('e-test').disabled = Boolean(err) || !d.pattern.trim();
  $('e-save').disabled = Boolean(err) || !d.pattern.trim() || !d.name.trim();
  $('e-delete').hidden = d.isNew;

  const test = d.test;
  const box = document.querySelector('.test');
  const result = $('e-test-result');
  if (!test) {
    box.removeAttribute('data-state');
    result.removeAttribute('data-state');
    result.textContent = 'Not tested yet.';
    $('e-test-samples').replaceChildren();
  } else if (test.error) {
    box.dataset.state = 'none';
    result.dataset.state = 'none';
    result.textContent = test.error;
    $('e-test-samples').replaceChildren();
  } else {
    const found = test.hits > 0;
    box.dataset.state = found ? 'ok' : 'none';
    result.dataset.state = found ? 'ok' : 'none';
    result.textContent = found
      ? `${test.hits.toLocaleString()} hits in the last ${test.lines.toLocaleString()} lines`
      : `No hits in the last ${test.lines.toLocaleString()} lines`;
    $('e-test-samples').replaceChildren(
      ...(test.samples ?? []).slice(0, 3).map((s) => text('li', s)),
    );
  }

  $('e-errors').replaceChildren(...(d.errors ?? []).map((e) => text('li', e)));
  $('e-errors').hidden = !(d.errors ?? []).length;
}

/** The browser's own regex error, or null. `{C}` and `{S}` are substituted first, as the
 *  engine does, so a pattern using them is not reported broken when it is fine. */
function compileError(pattern) {
  if (!pattern.trim()) return null;
  try {
    new RegExp(pattern.replaceAll('{C}', 'Character').replaceAll('{S}', '(.+)'));
    return null;
  } catch (err) {
    return err.message;
  }
}

function closeEditor() {
  state.draft = null;
  if ($('editor').open) $('editor').close();
}

async function saveDraft() {
  readEditor();
  const d = state.draft;
  const result = await window.api.saveTrigger({
    packId: d.packId,
    triggerId: d.triggerId,
    form: {
      name: d.name,
      pattern: d.pattern,
      literal: d.literal,
      warnText: d.warnText,
      durationSec: d.timerKind === 'none' ? 0 : d.durationSec,
      repeating: d.timerKind === 'repeating',
      earlyEndText: d.earlyEndText,
      groupId: d.groupId || null,
      newGroupName: d.newGroupName,
    },
  });
  if (!result.ok) {
    d.errors = result.errors ?? ['could not save'];
    syncEditor();
    return;
  }
  const landedIn = result.packId;
  closeEditor();
  state.selectedPack = landedIn;
  await refresh();
}

/* ------------------------------------------------------------------ report dialog */

function openReport(imported) {
  const body = $('r-body');
  body.replaceChildren();
  $('r-title').textContent =
    `Imported ${imported.filter((i) => i.ok).length} of ${imported.length}`;

  for (const file of imported) {
    const card = document.createElement('div');
    card.className = 'report-file';

    const row = document.createElement('div');
    row.className = 'report-row';
    row.append(text('span', file.file, 'report-name'));
    row.append(Object.assign(document.createElement('span'), { className: 'spacer' }));

    if (!file.ok) {
      row.append(text('span', 'failed', 'report-bad'));
      card.append(row, text('p', (file.errors ?? []).join('; '), 'muted small'));
      body.append(card);
      continue;
    }

    row.append(text('span', `${file.pack.triggers} arrived`, 'report-ok'));
    if (file.dropped?.length) {
      row.append(text('span', `${file.dropped.length} dropped`, 'report-drop'));
    }
    card.append(row);
    if (file.dropped?.length) card.append(dropBlock(file.dropped));
    if (file.dryRun) card.append(measureBlock(file.dryRun));
    body.append(card);
  }

  body.append(text('p',
    'Spoken text became chip text where a trigger showed nothing else — importing those ' +
    'as silent no-ops would have listed them as working while they did nothing.',
    'muted small'));

  $('report').showModal();
}

function dropBlock(dropped) {
  const block = document.createElement('div');
  block.className = 'drop-block';
  const byReason = new Map();
  for (const d of dropped) {
    if (!byReason.has(d.reason)) byReason.set(d.reason, []);
    byReason.get(d.reason).push(d.trigger);
  }
  for (const [reason, names] of byReason) {
    const g = document.createElement('div');
    g.append(text('div', `${reason} × ${names.length}`, 'drop-reason'));
    g.append(text('div', names.join(' · '), 'drop-names'));
    block.append(g);
  }
  return block;
}

function measureBlock(dry) {
  const wrap = document.createElement('div');
  wrap.className = 'block';
  const fired = dry.triggers.filter((t) => t.hits > 0).length;

  const head = document.createElement('div');
  head.className = 'measure-headline';
  head.append(text('span', String(fired), 'measure-big'));
  head.append(text('span', `of ${dry.triggers.length} fired`, 'measure-of'));
  wrap.append(head);
  wrap.append(text('p', `against your last ${dry.lines.toLocaleString()} lines`, 'muted small'));

  const bar = document.createElement('div');
  bar.className = 'measure-bar';
  const fill = document.createElement('i');
  fill.style.width = `${dry.triggers.length ? (fired / dry.triggers.length) * 100 : 0}%`;
  bar.append(fill);
  wrap.append(bar);

  const dead = dry.triggers.filter((t) => t.hits === 0);
  if (dead.length) {
    const list = document.createElement('ul');
    list.className = 'samples';
    for (const t of dead.slice(0, 6)) list.append(text('li', `${t.name} — ${t.pattern ?? t.error}`));
    wrap.append(text('p', `${dead.length} never matched`, 'drop-reason'), list);
  }
  return wrap;
}

/* ------------------------------------------------------------------ events */

/* ------------------------------------------------------------ durations dialog */

/**
 * The seven duration categories, in the order the dialog lists them. Each names the
 * config key it edits; the numbers themselves come from config (current values) and
 * from main (defaults, via getDurationDefaults) — nothing numeric is stated here, so
 * this table cannot drift from what the app actually does.
 *
 * Crowd control is deliberately not a row: its chips report a state and clear on the
 * log's own end-lines, so a duration for them would be a number that lies. The dialog
 * says so in prose instead, because a category silently missing from a list that
 * claims "every category" reads as a bug.
 */
const DURATION_CATEGORIES = [
  { key: 'castChipSec', name: 'Interrupt warnings', sub: 'enemy casts and the interrupt calls' },
  { key: 'summonChipSec', name: 'Summons', sub: 'who the boss just yanked to it' },
  { key: 'charmBreakChipSec', name: 'Charm breaks', sub: 'your charm wore off — the mob is loose' },
  { key: 'questChipSec', name: 'Quest loot', sub: 'a drop matches a Plane of Sky class test' },
  { key: 'noticeChipSec', name: 'Pet & command feedback', sub: 'pet-id answers and mapping confirmations' },
  { key: 'triggerChipSec', name: 'Trigger-pack chips', sub: 'chips from imported and authored packs' },
  { key: 'toastSec', name: 'Meter toasts', sub: 'confirmations and errors on the meter' },
];

/** Fetched once — defaults cannot change while the app runs. */
let durationDefaults = null;

/** The same clamp main applies at read time, so the dialog never shows a value the
    app would then quietly refuse to honor. */
const clampSec = (v, fallback) =>
  Number.isFinite(v) ? Math.min(30, Math.max(1, v)) : fallback;

async function openDurations() {
  durationDefaults ??= await window.api.getDurationDefaults();
  // Fresh config rather than state.cfg: the tray or another window may have written
  // since the last refresh, and a dialog opening on stale numbers would overwrite a
  // change the player just made elsewhere.
  const cfg = await window.api.getConfig();
  renderDurationRows((key) => clampSec(Number(cfg?.[key]), durationDefaults[key]));
  $('durations').showModal();
}

/** @param {(key: string) => number} valueFor where each row's number comes from */
function renderDurationRows(valueFor) {
  const list = $('d-rows');
  list.textContent = '';
  for (const cat of DURATION_CATEGORIES) {
    const li = document.createElement('li');

    const wrap = document.createElement('div');
    wrap.className = 'd-text';
    wrap.append(text('div', cat.name, 'd-name'), text('div', cat.sub, 'd-sub'));

    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.dataset.key = cat.key;
    input.value = String(valueFor(cat.key));

    // ±1s per press, clamped. A garbled typed value nudges from the default rather
    // than from NaN, so the buttons always do something visible.
    const nudge = (delta) => {
      input.value = String(clampSec(Number(input.value) + delta, durationDefaults[cat.key]));
    };
    const btn = (label, delta) => {
      const b = text('button', label);
      b.type = 'button';
      b.addEventListener('click', () => nudge(delta));
      return b;
    };

    const step = document.createElement('div');
    step.className = 'd-step';
    step.append(btn('−', -1), input, text('span', 's', 'd-unit'), btn('+', 1));

    li.append(wrap, step);
    list.append(li);
  }
}

async function saveDurations() {
  const patch = {};
  for (const input of document.querySelectorAll('#d-rows input')) {
    patch[input.dataset.key] = clampSec(
      Number(input.value), durationDefaults[input.dataset.key],
    );
  }
  await window.api.setConfig(patch);
  $('durations').close();
}

function wire() {
  $('surface-chips').addEventListener('click', async () => {
    await window.api.setConfig({ triggerAlerts: state.cfg.triggerAlerts === false });
    await refresh();
  });
  $('surface-timers').addEventListener('click', async () => {
    await window.api.setConfig({ triggerTimers: state.cfg.triggerTimers === false });
    await refresh();
  });

  $('open-durations').addEventListener('click', openDurations);
  $('d-save').addEventListener('click', saveDurations);
  $('d-cancel').addEventListener('click', () => $('durations').close());
  // Reset fills the fields and stops — Save is still the only thing that writes, so
  // a mis-click here is recoverable with Cancel.
  $('d-reset').addEventListener('click', () =>
    renderDurationRows((key) => durationDefaults[key]));

  for (const btn of document.querySelectorAll('.preset')) {
    btn.addEventListener('click', async () => {
      await window.api.setPreset(btn.dataset.preset);
      await refresh();
    });
  }

  $('import').addEventListener('click', async () => {
    const result = await window.api.import();
    if (result.canceled) return;
    const first = result.imported.find((i) => i.ok);
    await refresh({ keepSelection: false });
    if (first) {
      state.dryRuns.set(first.pack.id, first.dryRun ?? null);
      state.selectedPack = first.pack.id;
      renderRail();
      await renderContents();
    }
    openReport(result.imported);
  });

  $('export').addEventListener('click', async () => {
    const result = await window.api.export(state.selectedPack);
    if (result?.canceled) return;
    if (!result?.ok) window.alert(`Could not export — ${result?.error ?? 'unknown error'}`);
    else if (result.lost?.length) {
      window.alert(
        'Exported.\n\nGINA has no element for some of what this pack carries, so the ' +
        `following did not survive:\n\n${result.lost.join('\n')}`,
      );
    }
  });

  $('remove').addEventListener('click', async () => {
    const pack = packById(state.selectedPack);
    if (!pack || pack.id === BUILTIN_ID) return;
    if (!window.confirm(
      `Remove "${pack.name}"?\n\nThe file is deleted. Anything you authored inside it ` +
      'goes with it.')) return;
    await window.api.remove(pack.id);
    state.selectedPack = BUILTIN_ID;
    await refresh({ keepSelection: false });
  });

  $('new-trigger').addEventListener('click', () => newTrigger());

  /**
   * Make a pack, select it, and open the editor on a blank trigger.
   *
   * All three, because "new pack" that left you looking at an empty list would have moved
   * the dead end one step along rather than removed it. The name is what becomes the
   * filename, and main sanitizes it — see TRIGGERS_CREATE_PACK.
   */
  $('new-pack').addEventListener('click', async () => {
    const name = window.prompt(
      'Name the pack.\n\nA pack is a set of triggers you can switch, export and hand to ' +
      'somebody else in one go — a boss, a zone, a night.', 'My boss timers');
    if (name === null || !name.trim()) return;

    const result = await window.api.createPack(name.trim());
    if (!result.ok) {
      window.alert(`Could not create it — ${(result.errors ?? ['unknown error']).join('; ')}`);
      return;
    }
    state.selectedPack = result.packId;
    await refresh();
    await newTrigger();
  });

  $('rank-tolerant').addEventListener('change', async (e) => {
    state.rankTolerant = e.target.checked;
    const result = await window.api.dryRun({
      id: state.selectedPack, rankTolerant: state.rankTolerant,
    });
    if (result.ok) state.dryRuns.set(state.selectedPack, result);
    renderRail();
    await renderContents();
  });

  // --- info dialog
  $('i-close').addEventListener('click', () => $('info').close());
  /**
   * Take the recipe away as a trigger of your own.
   *
   * The draft opens on the built-in rule's own pattern and SHOW text, so the starting
   * point is a working thing rather than an empty field — which is what the old "Write my
   * own instead…" button gave you, and why nobody would have pressed it twice.
   */
  $('i-start-from').addEventListener('click', () => {
    const recipe = state.infoRow?.recipe;
    $('info').close();
    if (recipe) newTrigger({ from: recipe });
  });
  $('info').addEventListener('close', () => { state.infoRow = null; });

  // --- editor
  for (const id of ['e-name', 'e-pattern', 'e-warn', 'e-early', 'e-duration']) {
    $(id).addEventListener('input', () => { readEditor(); syncEditor(); });
  }
  $('e-timer-kind').addEventListener('change', () => { readEditor(); syncEditor(); });
  $('e-new-group').addEventListener('input', () => { readEditor(); syncEditor(); });
  $('e-group').addEventListener('change', () => {
    // syncEditor reveals the name field, so focus has to follow it or the player is left
    // looking at a box nothing typed into.
    readEditor();
    syncEditor();
    if ($('e-group').value === NEW_GROUP) $('e-new-group').focus();
  });

  $('e-regex').addEventListener('click', () => { state.draft.literal = false; syncEditor(); });
  $('e-literal').addEventListener('click', () => { state.draft.literal = true; syncEditor(); });

  for (const btn of document.querySelectorAll('.token')) {
    btn.addEventListener('click', () => {
      const input = $('e-pattern');
      const at = input.selectionStart ?? input.value.length;
      const token = btn.dataset.token;
      input.value = input.value.slice(0, at) + token + input.value.slice(at);
      input.focus();
      input.setSelectionRange(at + token.length, at + token.length);
      readEditor();
      syncEditor();
    });
  }

  $('e-test').addEventListener('click', async () => {
    readEditor();
    $('e-test-elapsed').textContent = 'scanning…';
    const started = Date.now();
    state.draft.test = await window.api.testPattern({
      pattern: state.draft.pattern,
      literal: state.draft.literal,
    });
    syncEditor();
    $('e-test-elapsed').textContent = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  });

  $('e-save').addEventListener('click', saveDraft);
  $('e-cancel').addEventListener('click', closeEditor);
  $('e-delete').addEventListener('click', async () => {
    const d = state.draft;
    if (!d?.triggerId) return;
    if (!window.confirm(`Delete "${d.name}"?`)) return;
    await window.api.deleteTrigger({ packId: d.packId, triggerId: d.triggerId });
    closeEditor();
    await refresh();
  });
  // Escape closes a <dialog> natively; the draft has to go with it or the next open
  // would reuse a stale one.
  $('editor').addEventListener('close', () => { state.draft = null; });

  $('r-dismiss').addEventListener('click', () => $('report').close());
}
