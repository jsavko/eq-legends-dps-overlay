/**
 * The cast-warning stack. Holds no parser state — just the hostileCasts array from
 * the last snapshot, rendered as chips, highest severity first.
 *
 * Chips are reused by warning id, not rebuilt: rebuilding would restart the tier-3
 * breathe animation on every 4 Hz push and make the banner strobe. A warning's
 * content never changes for a given id (a re-cast refreshes the same id's clock in
 * the parser), so reuse costs nothing.
 *
 * Four independent categories share this window — interrupt warnings, summon banners,
 * crowd control and boss timers — each gated on its own config key. The snapshot always
 * carries all four (the parser knows nothing about settings); deciding what to draw is
 * this file's job, and main decides whether the window exists at all from the same keys.
 */

const stack = document.getElementById('stack');
const effectsList = document.getElementById('effects');
const timersList = document.getElementById('timers');
const noticesList = document.getElementById('notices');

let cfg = null;
/** @type {Map<number, HTMLElement>} chip elements by warning id */
const chips = new Map();
/** @type {Map<string, HTMLElement>} member CC state chips by who|effect */
const effectChips = new Map();
/** @type {Map<string, {el: HTMLElement, due: HTMLElement, drain: HTMLElement}>} timer chips by caster|ability */
const timerChips = new Map();
/** @type {Map<number, HTMLElement>} mapping-command acknowledgements by notice id */
const noticeChips = new Map();
/** Ids present in the previous push — how a NEW tier-3 warning is told from an old one. */
let seenIds = new Set();

/** The one call to action; every tier-3 category is an interrupt call — except a
 *  summon, which already happened and gets its announcement verb in buildChip. */
const VERB = { 3: 'Interrupt' };

/** Member CC states, worded as the state they are, not the spell that caused it. */
const EFFECT_VERB = { stun: 'Stunned', mez: 'Mezzed', charm: 'Charmed' };

/** Entries fade for the last moments of their window; matches the CSS transition. */
const FADE_MS = 700;

init();

async function init() {
  applyConfig(await window.api.getConfig());

  window.api.onConfig(applyConfig);
  window.api.onLockChanged((locked) => {
    document.body.dataset.locked = String(locked);
  });
  window.api.onSnapshot((snapshot) => {
    const warnings = snapshot.hostileCasts ?? [];
    render(warnings);
    renderEffects(snapshot.memberEffects ?? []);
    renderTimers(snapshot.castTimers ?? [], warnings);
    renderNotices(snapshot.notices ?? []);
  });
}

function applyConfig(config) {
  cfg = config;
  document.documentElement.style.setProperty('--scale', config.scale ?? 1);

  // A category switched off clears its chips HERE, on the config push, rather than
  // waiting for the next snapshot: the push loop skips ticks when nothing has changed,
  // so between fights "next snapshot" can be minutes away — long enough for the player
  // to watch the thing they just turned off sit there.
  if (!on('castAlerts')) dropChips((el) => el.dataset.category !== 'summon');
  if (!on('summonAlerts')) dropChips((el) => el.dataset.category === 'summon');
  if (!on('ccAlerts')) clearChips(effectChips, effectsList);
  if (!on('castTimers')) clearChips(timerChips, timersList);
}

/**
 * Is a category switched on?
 *
 * A missing key reads as ON, matching the config defaults: a window built by a newer
 * main process than this renderer expects must not silently swallow warnings.
 */
function on(key) {
  return !cfg || cfg[key] !== false;
}

/**
 * Empty one category's list.
 *
 * Every category is gated twice — here when its switch goes off, and at render time
 * when a snapshot arrives — so the teardown lives in one place rather than being
 * re-typed per list, where a fifth category could get it subtly wrong.
 */
function clearChips(map, list) {
  if (!map.size) return;
  list.replaceChildren();
  map.clear();
}

/** Drop the stack chips matching a predicate — the stack holds two categories. */
function dropChips(match) {
  for (const [id, el] of chips) {
    if (!match(el)) continue;
    el.remove();
    chips.delete(id);
  }
}

function render(warnings) {
  // Interrupt warnings and summon banners are two categories in ONE stack: they share
  // the ordering rule, and splitting them into separate lists would let a tier-2 summon
  // sit above a tier-3 interrupt call. So they are filtered here, not partitioned.
  const shown = warnings.filter((w) => on(w.category === 'summon' ? 'summonAlerts' : 'castAlerts'));

  // Highest severity on top; within a tier, oldest first so lines don't reorder
  // under the player's eyes as new casts of the same weight arrive.
  const ordered = shown.slice().sort((a, b) => (b.tier - a.tier) || (a.id - b.id));
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
      // The cue belongs to the interrupt-warning category, which is why the settings
      // checkbox sits under it and greys out with it. Summons are tier 3 too and still
      // beep while warnings are on — but a player who switched warnings off has a
      // disabled sound checkbox in front of them, and a beep would make a liar of it.
      if (w.tier === 3 && !seenIds.has(w.id) && cfg?.castAlertSound && on('castAlerts')) cue();
    }
    if (w.remainingMs <= FADE_MS) el.dataset.fading = '';
    else delete el.dataset.fading;

    // A summon's caster can arrive late — confirmation line first, say-line second
    // filling in who did the yanking — the one field of a live chip that may change.
    if (w.category === 'summon' && w.caster) {
      const caster = el.querySelector('.caster');
      if (caster.textContent !== w.caster) caster.textContent = w.caster;
    }

    // Insert-or-move to the sorted position; appendChild on an attached node is a move.
    if (stack.children[index] !== el) stack.insertBefore(el, stack.children[index] ?? null);
  });

  seenIds = liveIds;
}

function buildChip(w) {
  const li = document.createElement('li');
  li.className = 'chip';
  li.dataset.tier = String(w.tier);
  // Which switch owns this chip: the stack mixes two categories, and a live toggle has
  // to be able to pick its own chips back out of it.
  li.dataset.category = w.category === 'summon' ? 'summon' : 'warning';

  const verb = document.createElement('span');
  verb.className = 'verb';

  const spell = document.createElement('span');
  spell.className = 'spell';

  const caster = document.createElement('span');
  caster.className = 'caster';

  if (w.category === 'summon') {
    // The banner announces a fact, not a call to act: the VICTIM takes the big
    // slot — the name is the payload — with the boss beneath. A bare confirmation
    // line names no boss, and the caster line stays honestly empty rather than
    // guessed (CSS collapses it so the banner doesn't carry a blank row).
    verb.textContent = 'Summoned';
    spell.textContent = w.victim;
    caster.textContent = w.caster ?? '';
  } else {
    verb.textContent = VERB[w.tier] ?? w.category ?? '';
    if (w.ability) {
      spell.textContent = w.ability;
    } else {
      // The anonymous classic form: the log said a cast is happening but not what.
      spell.textContent = 'casting…';
      spell.classList.add('unknown');
    }
    caster.textContent = w.caster;
  }

  li.append(verb, spell, caster);
  return li;
}

// ------------------------------------------------------------ member CC states

/**
 * Crowd control currently sitting ON the group. Chips are reused by who|effect so
 * nothing flickers across pushes, and they render in parser order (oldest first) —
 * a stack that reorders under the player's eyes reads as new information.
 *
 * Deliberately NO countdown: remainingMs runs against a safety cap, not a stated
 * duration, and drawing it would claim knowledge the log does not have. The chip
 * leaves when the end-line lands (instant) or the cap expires (the same fade as a
 * warning, so a capped chip never just blinks out).
 */
function renderEffects(effects) {
  if (!on('ccAlerts')) {
    clearChips(effectChips, effectsList);
    return;
  }

  const keys = new Set(effects.map((e) => `${e.who}|${e.effect}`));

  for (const [k, el] of effectChips) {
    if (!keys.has(k)) {
      el.remove();
      effectChips.delete(k);
    }
  }

  effects.forEach((e, index) => {
    const k = `${e.who}|${e.effect}`;
    let el = effectChips.get(k);
    if (!el) {
      el = buildEffectChip(e);
      effectChips.set(k, el);
    }
    if (e.remainingMs <= FADE_MS) el.dataset.fading = '';
    else delete el.dataset.fading;

    if (effectsList.children[index] !== el) {
      effectsList.insertBefore(el, effectsList.children[index] ?? null);
    }
  });
}

function buildEffectChip(e) {
  const li = document.createElement('li');
  li.className = 'echip';

  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = EFFECT_VERB[e.effect] ?? e.effect;

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = e.who;

  li.append(tag, who);
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
  if (!on('castTimers')) {
    clearChips(timerChips, timersList);
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

// -------------------------------------------------------------------- notices

/**
 * Replies to the in-game "pet <Name> = <Owner>" command.
 *
 * The parser has no other way to talk back — the player is in fullscreen EverQuest,
 * and the alerts window is the one surface that floats over it without taking a click
 * away from the game. Chips are reused by id and fade out on the same schedule as a
 * warning, so an acknowledgement never just blinks out of existence.
 */
function renderNotices(notices) {
  const liveIds = new Set(notices.map((n) => n.id));
  for (const [id, el] of noticeChips) {
    if (!liveIds.has(id)) {
      el.remove();
      noticeChips.delete(id);
    }
  }

  notices.forEach((n, index) => {
    let el = noticeChips.get(n.id);
    if (!el) {
      el = document.createElement('li');
      el.className = 'nchip';
      el.textContent = n.text;
      noticeChips.set(n.id, el);
    }
    if (n.remainingMs <= FADE_MS) el.dataset.fading = '';
    else delete el.dataset.fading;

    if (noticesList.children[index] !== el) {
      noticesList.insertBefore(el, noticesList.children[index] ?? null);
    }
  });
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
