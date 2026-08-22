/**
 * One of the player's own timer panels. Holds no engine state — just the rows addressed
 * to THIS panel out of the last snapshot's `triggerTimers`, painted into fixed slots.
 *
 * There is one of these windows per panel the player has made, all running this same
 * file. Which one this window is arrives as `?panel=<id>` on the file URL rather than
 * over IPC, because the answer is needed in the first frame: a window that had to wait
 * for a message to learn what it is would paint somebody else's rows first.
 *
 * The filtering happens HERE rather than in main for the reason spelled out in
 * `applyConfig` below — the push loop skips unchanged ticks, so a renderer that can only
 * learn about a change from the next snapshot can sit wrong for minutes during a lull.
 * One snapshot goes to every panel and each takes its own share.
 *
 * The rule this window inherits from the boss panel, unchanged: a row, once drawn, does
 * not move. Elements are reused by key, the order comes from the engine and is never
 * re-sorted by what is due next, and a state change swaps text and colour inside a slot
 * of unchanging height.
 */

const panel = document.getElementById('panel');
const titleEl = document.getElementById('title');
const placeholderTitle = document.getElementById('placeholder-title');
const who = document.getElementById('who');
const slotList = document.getElementById('slots');

/** Which panel this window is. Never changes for the life of the window: renaming a
 *  panel changes its TITLE, and removing one closes the window outright. */
const PANEL_ID = new URLSearchParams(location.search).get('panel') ?? '';

let cfg = null;
/** @type {Map<string, {el, layers: Array<{due, spell, of}>}>} slot elements by key */
const slots = new Map();

init();

async function init() {
  applyConfig(await window.api.getConfig());

  window.api.onConfig(applyConfig);
  window.api.onLockChanged((locked) => {
    document.body.dataset.locked = String(locked);
  });
  window.api.onSnapshot((snapshot) => {
    render(rows(snapshot));
  });
}

/**
 * This panel's rows, already in first-armed order.
 *
 * The engine sorts on `since` and holds a slot for as long as it lives, so there is
 * nothing to merge and nothing to re-sort — only rows belonging to another panel to
 * leave alone. A row with no `panel` at all belongs to the boss window and never to
 * this one: that absence is what every pack written before panels existed looks like.
 */
function rows(snapshot) {
  if (!enabled()) return [];
  return (snapshot.triggerTimers ?? []).filter((t) => t.panel === PANEL_ID);
}

/** Is this panel switched on? Mute counts as off — the same rule the boss panel and the
 *  drops popup follow, so "shut up for this pull" has no surface that ignores it. */
function enabled() {
  if (!cfg || cfg.alertsMuted) return false;
  return me()?.enabled !== false;
}

/** This panel's entry in the config list, or null once it has been removed. */
function me() {
  const list = Array.isArray(cfg?.timerPanels) ? cfg.timerPanels : [];
  return list.find((p) => p && p.id === PANEL_ID) ?? null;
}

/**
 * What keys a slot.
 *
 * The engine issues an explicit key per slot, because two packs may name a countdown the
 * same thing and one row would otherwise silently overwrite the other's element.
 */
const slotKey = (t) => t.key ?? `${t.caster}|${t.ability}`;

function applyConfig(config) {
  cfg = config;
  document.documentElement.style.setProperty('--scale', config.scale ?? 1);

  // The player's own title for this panel, re-read on every config push so a rename
  // lands immediately — and without the window being torn down, which would drop it
  // back to its default corner and cost them the placement they chose.
  const title = me()?.title ?? 'Timers';
  if (titleEl.textContent !== title) titleEl.textContent = title;
  if (placeholderTitle.textContent !== title) placeholderTitle.textContent = title;

  // Switching the panel off clears it HERE, on the config push, rather than waiting for
  // the next snapshot: the push loop skips ticks when nothing has changed, so between
  // fights "next snapshot" can be minutes away — long enough for the player to watch the
  // thing they just turned off sit there. Main closes this window on the same key, but
  // the order of the two messages is not ours to assume.
  if (!enabled()) clear();
}

/** Empty the panel and take it off the screen entirely. */
function clear() {
  if (slots.size) {
    slotList.replaceChildren();
    slots.clear();
  }
  panel.hidden = true;
}

function render(timers) {
  // Nothing counting means gone: not an empty frame, not placeholder rows. The window
  // stays alive and click-through, so getting it back costs no gesture; there is simply
  // nothing on screen while nothing is running.
  if (!timers.length) {
    clear();
    return;
  }
  panel.hidden = false;

  const keys = new Set(timers.map(slotKey));

  // The engine holds a slot until it has finished and lingered, so this only fires when
  // a countdown is genuinely over — never underneath a live one, which is the point.
  for (const [k, slot] of slots) {
    if (!keys.has(k)) {
      slot.el.remove();
      slots.delete(k);
    }
  }

  timers.forEach((t, index) => {
    const k = slotKey(t);
    let slot = slots.get(k);
    if (!slot) {
      slot = buildSlot(t);
      slots.set(k, slot);
    }
    paint(slot, t);

    // Insert-or-move to the engine's order; appendChild on an attached node is a move.
    if (slotList.children[index] !== slot.el) {
      slotList.insertBefore(slot.el, slotList.children[index] ?? null);
    }
  });

  // Each row's own sub-line already carries the duration, so the header counts sources
  // only when there is more than one to tell apart.
  const packs = new Set(timers.map((t) => t.caster));
  const heading = packs.size > 1 ? `${packs.size} packs` : '';
  if (who.textContent !== heading) who.textContent = heading;
}

/**
 * Build one slot: a bar, and the same text TWICE.
 *
 * The duplicate is what makes the letters flip colour as the bar drains past them. It is
 * `aria-hidden` because it is the same words a second time and a screen reader should
 * hear them once; it carries no state of its own, and `paint` writes both layers from
 * one set of values so they cannot say different things.
 */
function buildSlot(t) {
  const el = document.createElement('div');
  el.className = 'slot';

  const fill = document.createElement('i');
  fill.className = 'fill';

  const plain = buildBody(t);
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.setAttribute('aria-hidden', 'true');
  const inked = buildBody(t);
  mask.append(inked.body);

  el.append(fill, plain.body, mask);
  return { el, layers: [plain, inked] };
}

function buildBody(t) {
  const body = document.createElement('div');
  body.className = 'body';

  const names = document.createElement('span');
  names.className = 'names';

  const spell = document.createElement('span');
  spell.className = 'spell';
  spell.textContent = t.ability;

  const of = document.createElement('span');
  of.className = 'of';

  const due = document.createElement('span');
  due.className = 'due';

  names.append(spell, of);
  body.append(names, due);
  return { body, spell, of, due };
}

/** Below this the countdown is saying "now". */
const DUE_NOW_MS = 1500;

/**
 * Paint one slot for the state it is in.
 *
 * No tilde anywhere, for the same reason the boss panel has none: an authored duration
 * is exact, and "exact" and "right for your server" are different claims. On this panel
 * the durations are the player's own measurements of their own log, which is as close to
 * ground truth as this app gets — and still not a licence to hedge a number that was
 * written down.
 */
function paint(slot, t) {
  const armed = t.state === 'armed';

  slot.el.dataset.state = t.state;
  if (armed && t.dueMs <= DUE_NOW_MS) slot.el.dataset.dueNow = '';
  else delete slot.el.dataset.dueNow;
  if (t.ending) slot.el.dataset.ending = '';
  else delete slot.el.dataset.ending;

  const due = armed ? clock(t.dueMs) : '—';
  const of = detail(t);

  // Both layers, from one pair of values. Two paints from one source is what keeps the
  // dark copy and the light copy from ever disagreeing about what the row says.
  for (const layer of slot.layers) {
    if (layer.due.textContent !== due) layer.due.textContent = due;
    if (layer.of.textContent !== of) layer.of.textContent = of;
    if (layer.spell.textContent !== t.ability) layer.spell.textContent = t.ability;
  }

  // Draining while it is armed, empty once it is spent — a bar for a finished row would
  // be a claim about time that has already gone. One custom property drives both the bar
  // and the mask that clips the dark text to it.
  const fraction = armed && t.intervalMs ? t.dueMs / t.intervalMs : 0;
  slot.el.style.setProperty('--fill', `${Math.max(0, Math.min(100, fraction * 100))}%`);
}

/**
 * Remaining time as a clock.
 *
 * `m:ss` above a minute and bare seconds below it. The boss panel shows seconds only,
 * which is right for a cast that recurs every twenty of them; a buff runs for minutes
 * and "146s" is arithmetic the player should not have to do mid-pull.
 */
function clock(ms) {
  const total = Math.ceil(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * What the sub-line says.
 *
 * The full duration, normally — the bar is a fraction and a fraction of an unknown total
 * is not information. The author's own ending phrase takes over inside their window, and
 * a spent row says so plainly.
 */
function detail(t) {
  if (t.state === 'lapsed') return 'done';
  if (t.ending && t.endingText) return t.endingText;
  if (t.intervalMs) return `of ${clock(t.intervalMs)}`;
  return '';
}
