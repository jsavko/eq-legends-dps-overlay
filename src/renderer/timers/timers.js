/**
 * The boss-timer panel. Holds no engine state — just the `triggerTimers` array from the
 * last snapshot, painted into fixed slots.
 *
 * There used to be two kinds of row here and there is now one. The second kind was the
 * learned rhythm: a countdown this app computed live from watching a boss recast
 * something, hedged with a `~`, a spread, a "warm" state for a prior learned last week
 * and a retraction path for when reality stopped matching. It is gone, and the bosses it
 * covered ship as a trigger pack instead — so every row on this panel now comes from a
 * pattern and a duration somebody wrote down, which the player can open, read and
 * correct. See src/triggers/seed-pack.js.
 *
 * What survives unchanged is the rule this window exists for: a row, once drawn, does not
 * move. Elements are reused by key, the order comes from the engine and is never
 * re-sorted by what is due next, and a state change swaps text and colour inside a slot
 * of unchanging height.
 */

const panel = document.getElementById('panel');
const who = document.getElementById('who');
const slotList = document.getElementById('slots');

let cfg = null;
/** @type {Map<string, {el, due, spell, caster, fill}>} slot elements by key */
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
 * The rows to paint, already in first-armed order.
 *
 * The engine sorts on `since` and holds a slot for as long as it lives, so there is
 * nothing to merge and nothing to re-sort. Gated here rather than in main so flipping the
 * switch takes effect on the next push without the window being torn down and rebuilt.
 */
function rows(snapshot) {
  if (cfg?.triggerTimers === false) return [];
  // This panel's share of the one list. A row carrying no `panel` at all is one from a
  // pack written before panels existed, and it belongs here — that absence is exactly
  // what `normalizeTimer` turns into `boss`, and reading it any other way would have
  // relocated every countdown in every existing pack on the upgrade that added them.
  return (snapshot.triggerTimers ?? []).filter((t) => (t.panel ?? 'boss') === 'boss');
}

/**
 * What keys a slot.
 *
 * The engine issues an explicit key per slot, because two packs may name a countdown the
 * same thing and one row would otherwise silently overwrite the other's element. The
 * fallback covers a snapshot from a main process that predates it.
 */
const slotKey = (t) => t.key ?? `${t.caster}|${t.ability}`;

function applyConfig(config) {
  cfg = config;
  document.documentElement.style.setProperty('--scale', config.scale ?? 1);

  // Switching the timers off clears the panel HERE, on the config push, rather than
  // waiting for the next snapshot: the push loop skips ticks when nothing has changed,
  // so between fights "next snapshot" can be minutes away — long enough for the player
  // to watch the thing they just turned off sit there. Main closes this window on the
  // same key, but the order of the two messages is not ours to assume.
  if (cfg?.triggerTimers === false) clear();
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
  // Idle means gone: nothing armed paints NOTHING — not an empty frame, not placeholder
  // rows. The window stays alive and click-through, so getting it back costs no gesture;
  // there is simply nothing on screen between fights.
  if (!timers.length) {
    clear();
    return;
  }
  panel.hidden = false;

  const keys = new Set(timers.map(slotKey));

  // The engine holds a slot until it has finished and lingered, so this only fires when a
  // countdown is genuinely over — never underneath a live one, which is the point.
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

  // Each row's own sub-line already names the pack it came from, so with one pack on
  // screen — the overwhelmingly common case — the header would only repeat it. It counts
  // instead, and only once there is something to count.
  const packs = new Set(timers.map((t) => t.caster));
  const heading = packs.size > 1 ? `${packs.size} packs` : '';
  if (who.textContent !== heading) who.textContent = heading;
}

function buildSlot(t) {
  const el = document.createElement('div');
  el.className = 'slot';

  const fill = document.createElement('i');
  fill.className = 'fill';

  const due = document.createElement('span');
  due.className = 'due';

  const names = document.createElement('span');
  names.className = 'names';

  const spell = document.createElement('span');
  spell.className = 'spell';
  spell.textContent = t.ability;

  const caster = document.createElement('span');
  caster.className = 'caster';

  names.append(spell, caster);
  el.append(fill, due, names);
  return { el, due, spell, caster, fill };
}

/**
 * Paint one slot for the state it is in.
 *
 * No tilde anywhere. The tilde meant "estimate", and there are no estimates left on this
 * panel: an authored duration is exact, and it is marked rather than hedged — "exact" and
 * "correct for this server" are different claims and only the first is the pack's to
 * make. See the trigger-row rail in timers.css.
 */
function paint(slot, t) {
  const armed = t.state === 'armed';

  slot.el.dataset.state = t.state;
  if (armed && t.dueMs <= DUE_NOW_MS) slot.el.dataset.dueNow = '';
  else delete slot.el.dataset.dueNow;
  // The author's own "ending soon" window, if they set one.
  if (t.ending) slot.el.dataset.ending = '';
  else delete slot.el.dataset.ending;

  const due = armed ? `${Math.ceil(t.dueMs / 1000)}s` : '—';
  if (slot.due.textContent !== due) slot.due.textContent = due;

  const note = detail(t);
  const caster = note ? `${t.caster} · ${note}` : t.caster;
  if (slot.caster.textContent !== caster) slot.caster.textContent = caster;

  // Draining while it is armed, empty once it is spent — a bar for a finished row would
  // be a claim about time that has already gone.
  const fraction = armed && t.intervalMs ? t.dueMs / t.intervalMs : 0;
  slot.fill.style.width = `${Math.max(0, Math.min(100, fraction * 100))}%`;
}

/** Below this the countdown is saying "now". */
const DUE_NOW_MS = 1500;

/**
 * What the sub-line adds, beyond the pack the row came from.
 *
 * Usually nothing, and that is the honest answer: the pack name already says why the row
 * is on screen. A trigger row has no spread to quote and never "broke a pattern" — it
 * either ran out, or was ended early by a line its author nominated.
 */
function detail(t) {
  if (t.state === 'lapsed') return 'done';
  if (t.ending && t.endingText) return t.endingText;
  return null;
}
