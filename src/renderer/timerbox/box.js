/**
 * One timer box. Holds no state beyond the last set of rows addressed to it.
 *
 * Which box this window is arrives as `?category=<id>` on the file URL, because it is
 * needed in the first frame: a window that had to wait for a message to learn what it is
 * would paint somebody else's rows first.
 *
 * Two things this file is responsible for that the boss-timer panel never had to be:
 *
 *  - **Fitting the window to the content.** The other click-through panels buy their
 *    safety with a generously oversized invisible box. That is fine while they are
 *    click-through and disastrous the moment they are not: an invisible 620x900
 *    rectangle swallows every click that lands in the empty part of it, including
 *    clicks meant for a settings window behind it. So this measures itself and asks
 *    main to resize, and the window is never bigger than what it draws.
 *  - **Per-row colour.** Colour belongs to the bar, not to the box — the boxes are told
 *    apart by where they are and what they are called, and what you need mid-pull is
 *    which BAR is which.
 */

const box = document.getElementById('box');
const nameEl = document.getElementById('name');
const hintEl = document.getElementById('hint');
const rowList = document.getElementById('rows');

/** Which box this window is. Never changes for the life of the window. */
const CATEGORY_ID = new URLSearchParams(location.search).get('category') ?? '';

let cfg = null;
let arranging = false;
let lastRows = [];
/** @type {Map<string, {el, layers: Array<{label, time}>}>} row elements by timer id */
const rows = new Map();
/** The last size reported to main, so an unchanged frame costs no IPC. */
let lastFit = { width: 0, height: 0 };

init();

async function init() {
  applyConfig(await window.api.getConfig());
  window.api.onConfig(applyConfig);
  window.api.onArranging((on) => {
    arranging = on;
    document.body.dataset.arranging = String(on);
    hintEl.textContent = on ? 'drag me' : '';
    // Repaint on the mode change itself rather than waiting for the next push: between
    // fights that wait is minutes, and arranging is something you do between fights.
    repaint();
  });
  window.api.onTimers((payload) => {
    if (payload?.name != null && nameEl.textContent !== payload.name) {
      nameEl.textContent = payload.name;
    }
    lastRows = (payload?.rows ?? []).filter((r) => r.categoryId === CATEGORY_ID);
    repaint();
  });
  // A late layout (web font arriving) changes the measured height, so re-report after it.
  if (document.fonts?.ready) document.fonts.ready.then(fit);
}

function applyConfig(config) {
  cfg = config;
  document.documentElement.style.setProperty('--scale', config?.scale ?? 1);
  repaint();
}

/**
 * What to draw: the real rows, or a sample of what they will look like.
 *
 * While arranging, a box with nothing in it still has to be findable and grabbable — so
 * it shows one sample bar at the real height with the real chrome. Not a dashed
 * placeholder of some other size: the question you are answering while you drag is
 * "will this sit on top of my health bar", and only the real shape answers it.
 */
function repaint() {
  if (arranging && !lastRows.length) return render(sampleRows());
  return render(lastRows);
}

function sampleRows() {
  return [{
    id: 'sample', categoryId: CATEGORY_ID, name: 'Example timer',
    color: null, durationMs: 120_000, remainingMs: 78_000, spent: false, since: 0, sample: true,
  }];
}

function render(list) {
  // Nothing running means GONE — not an empty frame. The window stays alive so getting
  // it back costs no gesture; there is simply nothing on screen, and nothing to click
  // through either, because `fit` shrinks the window to nothing with it.
  if (!list.length) {
    if (rows.size) {
      rowList.replaceChildren();
      rows.clear();
    }
    box.hidden = true;
    fit();
    return;
  }
  box.hidden = false;

  const keep = new Set(list.map((r) => r.id));
  for (const [id, row] of rows) {
    if (keep.has(id)) continue;
    row.el.remove();
    rows.delete(id);
  }

  list.forEach((r, index) => {
    let row = rows.get(r.id);
    if (!row) {
      row = buildRow();
      rows.set(r.id, row);
    }
    paint(row, r);
    // Insert-or-move to the runtime's order; appendChild on an attached node is a move.
    if (rowList.children[index] !== row.el) {
      rowList.insertBefore(row.el, rowList.children[index] ?? null);
    }
  });

  fit();
}

/**
 * Build one row: a bar, and the same text TWICE.
 *
 * The duplicate is what makes the letters flip colour as the bar drains past them. It is
 * `aria-hidden` because it is the same words a second time; `paint` writes both layers
 * from one set of values so they cannot say different things.
 */
function buildRow() {
  const el = document.createElement('div');
  el.className = 'row';

  const fill = document.createElement('i');
  fill.className = 'fill';

  const plain = buildBody();
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.setAttribute('aria-hidden', 'true');
  const inked = buildBody();
  mask.append(inked.body);

  el.append(fill, plain.body, mask);
  return { el, layers: [plain, inked] };
}

function buildBody() {
  const body = document.createElement('div');
  body.className = 'body';
  const label = document.createElement('span');
  label.className = 'label';
  const time = document.createElement('span');
  time.className = 'time';
  body.append(label, time);
  return { body, label, time };
}

const DEFAULT_COLOR = '#2f8f7a';
/** Anything that is not a six-digit hex never reaches the stylesheet. The value is
 *  interpolated into a custom property and the file it comes from is one a player can
 *  hand-edit, so this is the last gate before it becomes CSS. */
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Paint a row's accent from one colour.
 *
 * The text colour is CHOSEN rather than fixed: near-black is right on jade and unreadable
 * on navy, and a player who picks a dark bar should get light letters rather than a row
 * they cannot read. Relative luminance by the usual sRGB weights.
 */
function applyAccent(el, value) {
  const hex = HEX.test(String(value ?? '')) ? value : DEFAULT_COLOR;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  el.style.setProperty('--accent', hex);
  el.style.setProperty('--on-accent', luminance > 0.55 ? '#0a0806' : '#f6f0e4');
}

function paint(row, r) {
  applyAccent(row.el, r.color);

  if (r.spent) row.el.dataset.spent = '';
  else delete row.el.dataset.spent;
  if (r.preview) row.el.dataset.preview = '';
  else delete row.el.dataset.preview;

  const time = r.spent ? '—' : clock(r.remainingMs);
  for (const layer of row.layers) {
    if (layer.label.textContent !== r.name) layer.label.textContent = r.name;
    if (layer.time.textContent !== time) layer.time.textContent = time;
  }

  // Draining while it runs, empty once it is spent — a bar for a finished row would be a
  // claim about time that has already gone. One property drives both the bar and the mask
  // that clips the dark text to it.
  const fraction = r.spent || !r.durationMs ? 0 : r.remainingMs / r.durationMs;
  row.el.style.setProperty('--fill', `${Math.max(0, Math.min(100, fraction * 100))}%`);
}

/** `m:ss` above a minute, bare seconds below it. A buff runs for minutes and "146s" is
 *  arithmetic the player should not have to do mid-pull. */
function clock(ms) {
  const total = Math.ceil(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Tell main how big this window needs to be.
 *
 * Measurements only — main owns the bounds and the clamps, and the window's POSITION is
 * never derived from its current bounds. That separation is not fussiness: deriving
 * placement from live bounds is the "window climbs the screen" bug this project has now
 * fixed twice, and a window that resizes every 250ms would climb fast.
 */
function fit() {
  const width = box.hidden ? 0 : Math.ceil(box.getBoundingClientRect().width);
  const height = box.hidden ? 0 : Math.ceil(box.getBoundingClientRect().height);
  // Unchanged is only skippable while the box is ON screen. Main HIDES a box that
  // reports nothing, so one that empties and then arms again at exactly the size it had
  // before would be skipped here and stay hidden forever — the timer would work once and
  // never again.
  const wasEmpty = !lastFit.width || !lastFit.height;
  const isEmpty = !width || !height;
  if (!wasEmpty && !isEmpty && width === lastFit.width && height === lastFit.height) return;
  lastFit = { width, height };
  window.api.fit({ width, height });
}
