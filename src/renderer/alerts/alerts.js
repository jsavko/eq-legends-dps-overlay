/**
 * The cast-warning stack. Holds no parser state — just the hostileCasts array from
 * the last snapshot, rendered as chips, highest severity first.
 *
 * Chips are reused by warning id, not rebuilt: rebuilding would restart the tier-3
 * breathe animation on every 4 Hz push and make the banner strobe. A warning's
 * content never changes for a given id (a re-cast refreshes the same id's clock in
 * the parser), so reuse costs nothing.
 */

const stack = document.getElementById('stack');
const timersList = document.getElementById('timers');

let cfg = null;
/** @type {Map<number, HTMLElement>} chip elements by warning id */
const chips = new Map();
/** @type {Map<string, {el: HTMLElement, due: HTMLElement, drain: HTMLElement}>} timer chips by caster|ability */
const timerChips = new Map();
/** Ids present in the previous push — how a NEW tier-3 warning is told from an old one. */
let seenIds = new Set();

/** The one call to action; every tier-3 category is an interrupt call. */
const VERB = { 3: 'Interrupt' };

/** Entries fade for the last moments of their window; matches the CSS transition. */
const FADE_MS = 700;

init();

async function init() {
  cfg = await window.api.getConfig();
  applyConfig(cfg);

  window.api.onConfig((next) => { cfg = next; applyConfig(next); });
  window.api.onLockChanged((locked) => {
    document.body.dataset.locked = String(locked);
  });
  window.api.onSnapshot((snapshot) => {
    const warnings = snapshot.hostileCasts ?? [];
    render(warnings);
    renderTimers(snapshot.castTimers ?? [], warnings);
  });
}

function applyConfig(config) {
  document.documentElement.style.setProperty('--scale', config.scale ?? 1);
}

function render(warnings) {
  // Highest severity on top; within a tier, oldest first so lines don't reorder
  // under the player's eyes as new casts of the same weight arrive.
  const ordered = warnings.slice().sort((a, b) => (b.tier - a.tier) || (a.id - b.id));
  const liveIds = new Set(ordered.map((w) => w.id));

  for (const [id, el] of chips) {
    if (!liveIds.has(id)) {
      el.remove();
      chips.delete(id);
    }
  }

  ordered.forEach((w, index) => {
    let el = chips.get(w.id);
    if (!el) {
      el = buildChip(w);
      chips.set(w.id, el);
      if (w.tier === 3 && !seenIds.has(w.id) && cfg?.castAlertSound) cue();
    }
    if (w.remainingMs <= FADE_MS) el.dataset.fading = '';
    else delete el.dataset.fading;

    // Insert-or-move to the sorted position; appendChild on an attached node is a move.
    if (stack.children[index] !== el) stack.insertBefore(el, stack.children[index] ?? null);
  });

  seenIds = liveIds;
}

function buildChip(w) {
  const li = document.createElement('li');
  li.className = 'chip';
  li.dataset.tier = String(w.tier);

  const verb = document.createElement('span');
  verb.className = 'verb';
  verb.textContent = VERB[w.tier] ?? w.category ?? '';

  const spell = document.createElement('span');
  spell.className = 'spell';
  if (w.ability) {
    spell.textContent = w.ability;
  } else {
    // The anonymous classic form: the log said a cast is happening but not what.
    spell.textContent = 'casting…';
    spell.classList.add('unknown');
  }

  const caster = document.createElement('span');
  caster.className = 'caster';
  caster.textContent = w.caster;

  li.append(verb, spell, caster);
  return li;
}

// ---------------------------------------------------------------------- timers

/**
 * The learned-rhythm countdowns, below the warnings. A timer whose cast is already
 * LIVE as a warning hides — that is the promotion: the estimate steps aside the
 * moment the log states the fact. Chips are reused by caster|spell so the drain
 * bar's width transition carries smoothly across pushes.
 */
function renderTimers(timers, warnings) {
  if (cfg && cfg.castTimers === false) {
    if (timerChips.size) {
      timersList.replaceChildren();
      timerChips.clear();
    }
    return;
  }

  const live = new Set(warnings.map((w) => `${w.caster}|${w.ability}`));
  const show = timers.filter((t) => !live.has(`${t.caster}|${t.ability}`));
  const keys = new Set(show.map((t) => `${t.caster}|${t.ability}`));

  for (const [k, chip] of timerChips) {
    if (!keys.has(k)) {
      chip.el.remove();
      timerChips.delete(k);
    }
  }

  show.forEach((t, index) => {
    const k = `${t.caster}|${t.ability}`;
    let chip = timerChips.get(k);
    if (!chip) {
      chip = buildTimerChip(t);
      timerChips.set(k, chip);
    }
    if (t.warm) chip.el.dataset.warm = '';
    else delete chip.el.dataset.warm;   // this fight's own gaps just took over

    chip.due.textContent = `~${Math.ceil(t.dueMs / 1000)}s`;
    chip.drain.style.width = `${Math.max(0, Math.min(100, (t.dueMs / t.intervalMs) * 100))}%`;

    if (timersList.children[index] !== chip.el) {
      timersList.insertBefore(chip.el, timersList.children[index] ?? null);
    }
  });
}

function buildTimerChip(t) {
  const li = document.createElement('li');
  li.className = 'tchip';

  const due = document.createElement('span');
  due.className = 'due';

  const spell = document.createElement('span');
  spell.className = 'spell';
  spell.textContent = t.ability;

  const caster = document.createElement('span');
  caster.className = 'caster';
  caster.textContent = t.caster;

  const drain = document.createElement('i');
  drain.className = 'drain';

  li.append(due, spell, caster, drain);
  return { el: li, due, drain };
}

// ---------------------------------------------------------------------- sound

/** Created on first use; an AudioContext held from load would sit idle forever. */
let audio = null;

/**
 * Two rising notes, ~200 ms total — long enough to register as "look up", short
 * enough to never talk over the next warning. Synthesized here because the app
 * ships no media assets and never will for a beep.
 */
function cue() {
  try {
    audio ??= new AudioContext();
    const t0 = audio.currentTime;
    for (const [freq, at] of [[880, 0], [1174.7, 0.11]]) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(0.22, t0 + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.1);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.12);
    }
  } catch {
    // No audio device is a silent overlay, not a broken one.
  }
}
