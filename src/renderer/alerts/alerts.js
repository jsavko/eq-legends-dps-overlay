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

let cfg = null;
/** @type {Map<number, HTMLElement>} chip elements by warning id */
const chips = new Map();
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
  window.api.onSnapshot((snapshot) => render(snapshot.hostileCasts ?? []));
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
