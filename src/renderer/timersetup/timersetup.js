/**
 * The Timers window: boxes on the left, the timers in the selected box on the right.
 *
 * Holds no runtime state — it reads the document from main, edits it through four
 * channels, and asks main to show things on screen. Nothing here knows what a trigger
 * pack is, which is the point: "remind me to recast this" and "run this pack somebody
 * sent me" are different jobs, and the second one's machinery is what made the first
 * unusable.
 *
 * Two rules the window is built around:
 *
 *  - **Nothing reflows.** Selecting a box swaps the middle pane's content; the rail and
 *    the header sit on the same pixel for every box. The History window's rule, for the
 *    same reason.
 *  - **Nothing is silently invisible.** Every reason a countdown might not draw — muted,
 *    box switched off, HUD hidden — is named where the player is looking, and where the
 *    fix is a switch this window can flip, it offers to flip it.
 */

const $ = (id) => document.getElementById(id);

const state = {
  model: { categories: [], timers: [] },
  palette: [],
  muted: false,
  arranging: false,
  selected: null,
  /** The editor draft, or null when the dialog is closed. */
  draft: null,
  /**
   * Which boxes currently have a "Show me this box" preview up.
   *
   * A SET, not a flag. Previews are per box and they stay up when you click another one
   * in the rail — so a single flag made the button lie: it would read "Show me this box"
   * for a box that was already showing, and pressing it did nothing visible because a
   * second preview just restarted the row that was already there.
   * @type {Set<string>}
   */
  showing: new Set(),
};

const BOSS = 'boss';

init();

async function init() {
  await refresh();
  wire();
  // The same switches are reachable from the tray mid-raid, so a window left open beside
  // the game can go stale. Never mid-edit: that would drop the draft.
  window.addEventListener('focus', () => { if (!state.draft) refresh(); });
}

async function refresh() {
  const data = await window.api.get();
  state.model = { categories: data.categories ?? [], timers: data.timers ?? [] };
  state.palette = data.palette ?? [];
  state.muted = Boolean(data.muted);
  state.arranging = Boolean(data.arranging);
  if (!state.model.categories.some((c) => c.id === state.selected)) {
    state.selected = state.model.categories[0]?.id ?? null;
  }
  render();
}

function render() {
  // A box that has been switched off or removed cannot still be showing anything, and
  // leaving it in the set would make its button offer to hide a preview that is gone.
  for (const id of [...state.showing]) {
    const c = state.model.categories.find((x) => x.id === id);
    if (!c || !c.enabled) state.showing.delete(id);
  }
  renderAlarm();
  renderRail();
  renderContents();
  $('arrange').setAttribute('aria-pressed', String(state.arranging));
  $('arrange').textContent = state.arranging ? 'Done arranging' : 'Arrange on screen';

  const boxes = state.model.categories.length;
  const timers = state.model.timers.length;
  $('summary').textContent =
    `${boxes} box${boxes === 1 ? '' : 'es'} · ${timers} timer${timers === 1 ? '' : 's'}`;
}

/**
 * The one thing stopping every box from drawing, if there is one.
 *
 * Mute is a session gesture bound to a hotkey, so it is very easy to have left on and
 * completely forgotten — and its symptom is identical to a broken timer. Naming it here,
 * with the switch beside it, is the difference between a five-second fix and an evening
 * spent debugging something that was never wrong.
 */
function renderAlarm() {
  if (!state.muted) {
    $('alarm').hidden = true;
    return;
  }
  $('alarm').hidden = false;
  $('alarm-text').textContent =
    'Alerts are muted, so none of these boxes will draw — including the boss timers.';
  $('alarm-fix').textContent = 'Unmute';
}

function renderRail() {
  const list = $('boxes');
  list.replaceChildren();

  for (const category of state.model.categories) {
    const li = document.createElement('li');
    li.setAttribute('aria-selected', String(category.id === state.selected));
    if (!category.enabled) li.dataset.off = '';

    const text = document.createElement('div');
    text.className = 'b-text';
    text.append(div('b-name', category.name));
    const count = state.model.timers.filter((t) => t.categoryId === category.id).length;
    text.append(div('b-sub', category.builtin
      ? 'from your trigger packs'
      : `${count} timer${count === 1 ? '' : 's'}`));

    const onoff = document.createElement('button');
    onoff.type = 'button';
    onoff.textContent = category.enabled ? 'on' : 'off';
    onoff.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.api.saveCategory({ id: category.id, enabled: !category.enabled });
      await refresh();
    });

    li.append(text, onoff);
    li.addEventListener('click', () => {
      state.selected = category.id;
      $('box-note').textContent = '';
      render();
    });
    list.append(li);
  }
}

function selected() {
  return state.model.categories.find((c) => c.id === state.selected) ?? null;
}

/**
 * The Show/Hide button, for the box that is selected right now.
 *
 * Derived from `state.showing` every time rather than toggled in place, because previews
 * stay up when you click another box in the rail — a button that toggled its own label
 * would go on describing whichever box you pressed it on last.
 */
function renderPreviewButton() {
  const category = selected();
  const on = Boolean(category && state.showing.has(category.id));
  $('preview-box').textContent = on ? 'Hide it again' : 'Show me this box';
  $('preview-box').setAttribute('aria-pressed', String(on));
}

function renderContents() {
  const category = selected();
  if (!category) return;
  renderPreviewButton();

  $('box-name').textContent = category.name;
  $('box-sub').textContent = category.enabled ? '' : 'switched off';
  $('box-note').textContent = category.builtin
    ? 'Built in. It can be renamed, placed and switched off like any other box.'
    : 'Rename it by double-clicking the title, place it with Arrange on screen.';

  const mine = state.model.timers.filter((t) => t.categoryId === category.id);
  $('builtin').hidden = !category.builtin;
  $('new-timer').hidden = category.builtin;
  $('empty').hidden = category.builtin || mine.length > 0;

  const list = $('rows');
  list.replaceChildren();
  if (category.builtin) return;

  for (const timer of mine) {
    const li = document.createElement('li');
    if (!timer.enabled) li.dataset.off = '';

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.setProperty('--swatch', timer.color);

    const text = document.createElement('div');
    text.className = 't-text';
    text.append(div('t-name', timer.name), div('t-line', timer.startsOn));

    li.append(swatch, text, div('t-dur', duration(timer.durationMs)), div('t-go', 'edit ›'));
    li.addEventListener('click', () => openEditor(timer));
    list.append(li);
  }
}

const div = (cls, text) => {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  return el;
};

const duration = (ms) => {
  const total = Math.round(ms / 1000);
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/* ---------------------------------------------------------------- the editor */

function openEditor(timer) {
  const category = selected();
  state.draft = timer
    ? { ...timer, isNew: false }
    : {
        id: null,
        isNew: true,
        categoryId: category && !category.builtin ? category.id : firstOwnBox(),
        name: '',
        startsOn: '',
        match: 'contains',
        durationMs: 120_000,
        // Step through the palette so a box filled without any deliberate choice is
        // still readable — every bar the same colour is the same as no colour at all.
        color: state.palette[state.model.timers.length % Math.max(1, state.palette.length)]
          ?? '#2f8f7a',
        endsOn: '',
        enabled: true,
      };
  writeEditor();
  $('e-preview-note').textContent = '';
  $('e-errors').hidden = true;
  // Guarded. `showModal()` on a dialog that is already open throws InvalidStateError,
  // and the throw happens inside a click handler where nothing catches it — so the
  // symptom is a row that silently does nothing from the second click onward, which is
  // indistinguishable from a dead button.
  if (!$('editor').open) $('editor').showModal();
  $('e-name').focus();
}

const firstOwnBox = () => state.model.categories.find((c) => !c.builtin)?.id ?? null;

function writeEditor() {
  const d = state.draft;
  $('e-title').textContent = d.isNew ? 'New timer' : d.name || 'Timer';
  $('e-name').value = d.name;
  $('e-starts').value = d.startsOn;
  $('e-ends').value = d.endsOn ?? '';
  $('e-min').value = Math.floor(d.durationMs / 60_000);
  $('e-sec').value = Math.round((d.durationMs % 60_000) / 1000);
  $('e-color').value = d.color;
  $('e-delete').hidden = d.isNew;

  for (const [id, mode] of [['e-contains', 'contains'], ['e-exact', 'exact'], ['e-regex', 'regex']]) {
    $(id).setAttribute('aria-pressed', String(d.match === mode));
  }

  const swatches = $('e-swatches');
  swatches.replaceChildren();
  for (const color of state.palette) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.background = color;
    btn.title = color;
    btn.setAttribute('aria-pressed', String(color.toLowerCase() === String(d.color).toLowerCase()));
    btn.addEventListener('click', () => {
      state.draft.color = color;
      writeEditor();
    });
    swatches.append(btn);
  }

  const box = $('e-box');
  box.replaceChildren();
  // The built-in box is not offered: its rows come from trigger packs, so a timer filed
  // there would be one that could never appear.
  for (const c of state.model.categories.filter((c) => !c.builtin)) {
    box.append(new Option(c.name, c.id));
  }
  box.value = d.categoryId ?? '';

  validate();
}

function readEditor() {
  const d = state.draft;
  if (!d) return;
  d.name = $('e-name').value;
  d.startsOn = $('e-starts').value;
  d.endsOn = $('e-ends').value;
  d.durationMs = ((Number($('e-min').value) || 0) * 60 + (Number($('e-sec').value) || 0)) * 1000;
  d.color = $('e-color').value;
  d.categoryId = $('e-box').value || d.categoryId;
}

/** Live feedback on the one field that can be wrong in a way the player cannot see: a
 *  regex that does not compile matches nothing, forever, silently. */
function validate() {
  const d = state.draft;
  let error = null;
  if (d.match === 'regex' && d.startsOn) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(d.startsOn);
    } catch (err) {
      error = err.message;
    }
  }
  $('e-error').textContent = error ?? '';
  $('e-error').hidden = !error;
  $('e-save').disabled = Boolean(error) || !d.name.trim() || !d.startsOn.trim() || d.durationMs <= 0;
}

async function saveDraft() {
  readEditor();
  const d = state.draft;
  const result = await window.api.saveTimer({
    id: d.isNew ? null : d.id,
    form: {
      categoryId: d.categoryId,
      name: d.name,
      startsOn: d.startsOn,
      match: d.match,
      durationSec: d.durationMs / 1000,
      color: d.color,
      endsOn: d.endsOn,
      enabled: d.enabled,
    },
  });
  if (!result.ok) {
    const list = $('e-errors');
    list.replaceChildren(...(result.errors ?? ['could not save']).map((e) => li(e)));
    list.hidden = false;
    return;
  }
  closeEditor();
  await refresh();
}

const li = (text) => {
  const el = document.createElement('li');
  el.textContent = text;
  return el;
};

function closeEditor() {
  const draftCategory = state.draft?.categoryId ?? null;
  state.draft = null;
  $('e-errors').hidden = true;
  if ($('editor').open) $('editor').close();
  // A preview must not outlive the dialog that raised it, or it sits on the panel
  // afterwards looking exactly like a real countdown that nothing will ever end.
  if (state.showingDraft) {
    state.showingDraft = false;
    $('e-preview').textContent = 'Preview on screen';
    window.api.clearPreviews({ categoryId: draftCategory });
  }
}

/**
 * Show this timer on screen, now.
 *
 * A box draws nothing until something fires, which makes it invisible at exactly the
 * moment you are deciding where it goes and how long the countdown should be.
 */
async function previewDraft() {
  readEditor();
  const d = state.draft;
  if (state.showingDraft) {
    await window.api.clearPreviews({ categoryId: d.categoryId });
    state.showingDraft = false;
    $('e-preview').textContent = 'Preview on screen';
    $('e-preview-note').textContent = '';
    return;
  }
  state.showingDraft = true;
  $('e-preview').textContent = 'Hide preview';
  const result = await window.api.preview({
    one: true,
    categoryId: d.categoryId,
    name: d.name.trim() || 'Preview',
    durationSec: Math.max(1, d.durationMs / 1000),
    color: d.color,
  });
  showPreviewResult($('e-preview-note'), result);
}

/**
 * What the player will actually see, said out loud.
 *
 * A preview that silently did nothing because alerts were muted would be worse than no
 * preview at all: they would conclude the TIMER was broken and go looking in the wrong
 * place entirely.
 */
function showPreviewResult(note, result) {
  note.replaceChildren();
  if (result?.drawing) {
    note.append(document.createTextNode(
      'Showing on screen now. Use Arrange on screen to move the box where you want it.',
    ));
    return;
  }
  note.append(document.createTextNode(
    `Nothing will draw: ${result?.reason ?? 'the box cannot draw right now'}.`,
  ));
  if (/muted/.test(result?.reason ?? '')) {
    const fix = document.createElement('button');
    fix.type = 'button';
    fix.className = 'secondary';
    fix.textContent = 'Unmute';
    fix.addEventListener('click', async () => {
      await window.api.setConfig({ alertsMuted: false });
      await refresh();
      showPreviewResult(note, await window.api.preview({
        one: true,
        categoryId: state.draft?.categoryId,
        name: state.draft?.name?.trim() || 'Preview',
        durationSec: Math.max(1, (state.draft?.durationMs ?? 45_000) / 1000),
        color: state.draft?.color,
      }));
    });
    note.append(document.createTextNode(' '), fix);
  }
}

/* --------------------------------------------------------------- measuring */

async function measure() {
  const button = $('measure');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Reading your log…';
  try {
    const result = await window.api.measure({ categoryId: state.selected });
    await refresh();
    openReport(result);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function openReport(result) {
  const body = $('r-body');
  body.replaceChildren();

  if (!result?.ok) {
    $('r-title').textContent = 'Could not read your log';
    body.append(para((result?.errors ?? ['unknown error']).join('; '), 'muted small'));
    $('report').showModal();
    return;
  }

  const added = result.added ?? [];
  $('r-title').textContent = added.length
    ? `Added ${added.length} timer${added.length === 1 ? '' : 's'} from your log`
    : 'Nothing new to add';

  if (!added.length) {
    body.append(para(
      'A timer needs three things in your log: a line that appears when the effect lands, '
      + 'a line that appears when it wears off, and at least five complete cycles of the two. '
      + 'Anything already in this box was left alone.',
      'muted small',
    ));
  }

  for (const c of added) {
    const row = document.createElement('div');
    row.className = 'report-row';
    row.append(div('r-name', c.name), spacer(), div('r-dur', duration(c.durationMs)));
    body.append(row);
    body.append(para(`starts: ${c.land}`, 'report-line'));
    body.append(para(`ends: ${c.wearOff}`, 'report-line'));
  }

  if (added.length) {
    body.append(para(
      'Every number is the median of last-landing → wear-off in YOUR log — a recast '
      + 'refreshes, so the clock starts at the last landing, not the first. Nothing was read '
      + 'off a spell table, which is why the two lines are shown: a wrong pairing is obvious '
      + 'here and nowhere else. Open any of them to fix or delete it.',
      'muted small',
    ));
  }
  $('report').showModal();
}

const para = (text, cls) => {
  const el = document.createElement('p');
  el.className = cls ?? '';
  el.textContent = text;
  return el;
};
const spacer = () => {
  const el = document.createElement('span');
  el.className = 'spacer';
  return el;
};

/* -------------------------------------------------------------------- wiring */

function wire() {
  $('arrange').addEventListener('click', async () => {
    const result = await window.api.arrange(!state.arranging);
    state.arranging = result.arranging;
    render();
  });

  $('alarm-fix').addEventListener('click', async () => {
    await window.api.setConfig({ alertsMuted: false });
    await refresh();
  });

  $('add-box').addEventListener('click', async () => {
    const name = $('new-box').value.trim();
    if (!name) return;
    const result = await window.api.saveCategory({ name });
    $('new-box').value = '';
    if (result.ok && result.id) state.selected = result.id;
    await refresh();
  });
  $('new-box').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('add-box').click();
  });

  // Renaming in place: the title IS the control, because a rename is a thing you do
  // once and a dialog for it would be a dialog you open once.
  $('box-name').addEventListener('dblclick', async () => {
    const category = selected();
    if (!category) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = category.name;
    $('box-name').replaceChildren(input);
    input.focus();
    input.select();
    const commit = async () => {
      const name = input.value.trim();
      if (name && name !== category.name) await window.api.saveCategory({ id: category.id, name });
      await refresh();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') refresh();
    });
  });

  // A toggle, not a one-way door. Revealing something with no way to put it back leaves
  // a countdown sitting on the player's screen that nothing they can see will end.
  $('preview-box').addEventListener('click', async () => {
    const category = selected();
    if (!category) return;
    if (state.showing.has(category.id)) {
      // This box only. Clearing every preview would take down the other box the player
      // is comparing this one against, which is the opposite of what the button says.
      await window.api.clearPreviews({ categoryId: category.id });
      state.showing.delete(category.id);
      $('box-note').textContent = '';
      renderPreviewButton();
      return;
    }
    const result = await window.api.preview({
      categoryId: category.id, name: category.name, durationSec: 3600,
    });
    state.showing.add(category.id);
    renderPreviewButton();
    showPreviewResult($('box-note'), result);
  });

  $('new-timer').addEventListener('click', () => openEditor(null));
  $('measure').addEventListener('click', measure);

  $('e-save').addEventListener('click', saveDraft);
  $('e-cancel').addEventListener('click', closeEditor);
  $('e-preview').addEventListener('click', previewDraft);
  $('e-delete').addEventListener('click', async () => {
    const d = state.draft;
    if (!d || d.isNew) return;
    await window.api.removeTimer({ id: d.id });
    closeEditor();
    await refresh();
  });

  for (const [id, mode] of [['e-contains', 'contains'], ['e-exact', 'exact'], ['e-regex', 'regex']]) {
    $(id).addEventListener('click', () => {
      readEditor();
      state.draft.match = mode;
      writeEditor();
    });
  }
  for (const id of ['e-name', 'e-starts', 'e-ends', 'e-min', 'e-sec']) {
    $(id).addEventListener('input', () => { readEditor(); validate(); });
  }
  $('e-color').addEventListener('input', () => { readEditor(); writeEditor(); });
  $('e-box').addEventListener('change', () => readEditor());

  $('r-close').addEventListener('click', () => $('report').close());

  // Escape and the backdrop close a <dialog> without going through our own close path,
  // which would leave `state.draft` set and `focus` refusing to refresh forever.
  // Escape and the backdrop close a <dialog> without going through our own close path,
  // which would leave `state.draft` set, `focus` refusing to refresh, and any preview
  // still on screen.
  for (const event of ['close', 'cancel']) {
    $('editor').addEventListener(event, () => {
      const category = state.draft?.categoryId ?? null;
      state.draft = null;
      if (state.showingDraft) {
        state.showingDraft = false;
        $('e-preview').textContent = 'Preview on screen';
        window.api.clearPreviews({ categoryId: category });
      }
    });
  }
}
