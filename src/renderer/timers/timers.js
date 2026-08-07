/**
 * The boss-timer panel. Holds no parser state — just the castTimers array from the
 * last snapshot, painted into fixed slots.
 *
 * The parser owns slot LIFETIME (see rhythm.js): it hands over every pair that has
 * armed this fight, in first-armed order, with a state saying what the row may claim.
 * This file's whole job is to make sure a row, once drawn, does not move: elements are
 * reused by caster|ability, order comes from the parser and is never re-sorted, and a
 * state change swaps text and colour inside a slot of unchanging height.
 *
 * The one thing decided here rather than in the parser is CAST — whether the alert
 * window is showing this exact cast right now. That is a fact about the OTHER window's
 * contents, not about the rhythm, and it is why the slot no longer disappears at the
 * moment its spell fires: it says so and re-arms in place.
 */

const panel = document.getElementById('panel');
const who = document.getElementById('who');
const slotList = document.getElementById('slots');

let cfg = null;
/** @type {Map<string, {el, due, spell, caster, fill}>} slot elements by caster|ability */
const slots = new Map();

/** Below this the estimate is saying "now" — hot, but still an estimate. */
const DUE_NOW_MS = 1500;

init();

async function init() {
  applyConfig(await window.api.getConfig());

  window.api.onConfig(applyConfig);
  window.api.onLockChanged((locked) => {
    document.body.dataset.locked = String(locked);
  });
  window.api.onSnapshot((snapshot) => {
    render(snapshot.castTimers ?? [], snapshot.hostileCasts ?? []);
  });
}

function applyConfig(config) {
  cfg = config;
  document.documentElement.style.setProperty('--scale', config.scale ?? 1);

  // Switching the timers off clears the panel HERE, on the config push, rather than
  // waiting for the next snapshot: the push loop skips ticks when nothing has changed,
  // so between fights "next snapshot" can be minutes away — long enough for the player
  // to watch the thing they just turned off sit there. Main closes this window on the
  // same key, but the order of the two messages is not ours to assume.
  if (cfg?.castTimers === false) clear();
}

/** Empty the panel and take it off the screen entirely. */
function clear() {
  if (slots.size) {
    slotList.replaceChildren();
    slots.clear();
  }
  panel.hidden = true;
}

function render(timers, warnings) {
  // Idle means gone: no fight and no armed rhythm paints NOTHING — not an empty
  // frame, not placeholder rows. The window stays alive and click-through, so getting
  // it back costs no gesture; there is simply nothing on screen between fights.
  if (!timers.length) {
    clear();
    return;
  }
  panel.hidden = false;

  // Which of these estimates the log has just turned into a fact.
  const live = new Set(warnings.map((w) => `${w.caster}|${w.ability}`));
  const keys = new Set(timers.map((t) => `${t.caster}|${t.ability}`));

  // The parser holds a slot for the whole fight, so this only fires when a fight ends
  // and another begins between two pushes — never mid-fight, which is the point.
  for (const [k, slot] of slots) {
    if (!keys.has(k)) {
      slot.el.remove();
      slots.delete(k);
    }
  }

  timers.forEach((t, index) => {
    const k = `${t.caster}|${t.ability}`;
    let slot = slots.get(k);
    if (!slot) {
      slot = buildSlot(t);
      slots.set(k, slot);
    }
    paint(slot, t, live.has(k));

    // Insert-or-move to the parser's order; appendChild on an attached node is a move.
    if (slotList.children[index] !== slot.el) {
      slotList.insertBefore(slot.el, slotList.children[index] ?? null);
    }
  });

  // One caster is the overwhelmingly common case and the name is worth showing; more
  // than one and the names would not fit, so the header counts them instead.
  const casters = new Set(timers.map((t) => t.caster));
  const heading = casters.size === 1 ? [...casters][0] : `${casters.size} casters`;
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
 * `cast` is a renderer state layered over the parser's: the underlying rhythm is still
 * armed and still counting, we are simply saying so out loud for the moment the log
 * confirms it. Everything else comes straight from the parser, including the refusal
 * to show a number for a prediction that has lapsed.
 */
function paint(slot, t, casting) {
  const state = casting ? 'cast' : t.state;
  const armed = t.state === 'armed';

  slot.el.dataset.state = state;
  if (t.warm) slot.el.dataset.warm = '';
  else delete slot.el.dataset.warm;   // this fight's own gaps just took over
  if (armed && !casting && t.dueMs <= DUE_NOW_MS) slot.el.dataset.dueNow = '';
  else delete slot.el.dataset.dueNow;

  const due = state === 'cast' ? 'CAST' : armed ? `~${Math.ceil(t.dueMs / 1000)}s` : '—';
  if (slot.due.textContent !== due) slot.due.textContent = due;

  const caster = `${t.caster} · ${detail(t, state === 'cast')}`;
  if (slot.caster.textContent !== caster) slot.caster.textContent = caster;

  // Full while the cast is live, draining while it is armed, empty once the prediction
  // is gone — a bar for a lapsed row would be a claim the log stopped supporting.
  const fraction = state === 'cast' ? 1 : armed && t.intervalMs ? t.dueMs / t.intervalMs : 0;
  slot.fill.style.width = `${Math.max(0, Math.min(100, fraction * 100))}%`;
}

/**
 * What the sub-line says about the evidence behind this row.
 *
 * A live cast outranks whatever the prediction was doing: a row reading "CAST" beside
 * "late · pattern broke" says two things at once and one of them is stale news. The
 * spell IS being cast; the retracted prediction is what the log just superseded.
 */
function detail(t, casting) {
  // There is no 'slain' wording any more: a dead caster's rows leave the panel the
  // moment it dies rather than lingering as a dimmed corpse row.
  if (!casting && t.state === 'lapsed') return 'late · pattern broke';
  // A warm row deliberately shows no interval: it is running on a rhythm learned in an
  // earlier fight, and printing "13.0s ±0.8" would dress last week's number up as this
  // pull's measurement.
  if (t.warm) return 'from memory';
  if (t.intervalMs) return `${(t.intervalMs / 1000).toFixed(1)}s ±${(t.spreadMs / 1000).toFixed(1)}`;
  // Casting with no rhythm left to quote — say the fact and claim nothing else.
  return 'casting now';
}
