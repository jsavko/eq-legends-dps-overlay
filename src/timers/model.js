/**
 * Timer categories and the timers in them — the player's own countdowns.
 *
 * Deliberately NOT built on `src/triggers/`. That subsystem exists to run GINA packs: a
 * stranger's regex, groups, early enders, provenance marks, export fidelity. All of it
 * is the right machinery for "run this pack somebody sent me" and all of it is in the way
 * of "remind me to recast Spirit of the Puma". A timer here is four things — a name, the
 * log text that starts it, how long it runs, and which box it draws in — and nothing in
 * this file knows what a pack is.
 *
 * The shapes:
 *
 *   category  { id, name, builtin, x, y, enabled }
 *   timer     { id, categoryId, name, startsOn, match, durationMs, color, endsOn }
 *
 * A category is a BOX on screen: named by the player and dragged where they want it. A
 * timer belongs to exactly one.
 *
 * **Colour belongs to the TIMER, not to the box.** That is the whole point of it: the
 * boxes are already told apart by where they are and what they are called, and what you
 * need at a glance mid-pull is which BAR is which — the red one is the one you must not
 * let drop. A per-box colour would paint every bar in it the same and take that away.
 * The box chrome stays neutral so the bars are the only thing carrying colour.
 *
 * Pure Node, no Electron, so all of it unit-tests in WSL like the parser does.
 */

/** How `startsOn` is compared against a log line. Plain text is the default because it
 *  is what a player pastes out of their log; regex is there for when they need it. */
export const MATCH_MODES = ['contains', 'exact', 'regex'];

/** Longest a timer may run. A countdown longer than this is a calendar entry, and the
 *  boxes have no scroll, so a fat-fingered value would hold a row until restart. */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/** The colour a timer bar gets when it has not been given one. */
export const DEFAULT_COLOR = '#2f8f7a';

/** The palette offered in the UI. Chosen to be distinguishable from each other at a
 *  glance over a game at small size — that is the whole job of a bar colour. New timers
 *  step through it, so a box filled without any deliberate choice is still readable. */
export const PALETTE = [
  '#2f8f7a', '#3d7fc0', '#8f5fc0', '#c0603f',
  '#b9702a', '#4f9c3a', '#c04f7a', '#7a7f8c',
];

/**
 * How a box is SHAPED: how wide it is, how tall one row is, how big the text is.
 *
 * The defaults are not chosen, they are measured off the chrome this generalises. The
 * boss panel was 22.77em wide with a 2.31em row over 13px text, which computes to 296.0
 * and 30.03 — so a player who never opens these controls sees the panel they already
 * know, pixel for pixel, rather than something close to it.
 *
 * The floors matter more than the ceilings. A 100px box cannot show a spell name and a
 * 6px row is a box you cannot find, and both of those are one careless drag away;
 * whereas a box that is too big merely wastes screen the player can SEE being wasted.
 *
 * Size lives here and not on the timer, for the same reason colour lives on the timer
 * and not here: the box is what has a place on the screen, and the bar is what you have
 * to tell apart mid-pull.
 */
export const LOOK = {
  width:     { min: 180, max: 800, def: 296 },
  rowHeight: { min: 14,  max: 80,  def: 30 },
  fontSize:  { min: 9,   max: 32,  def: 13 },
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * The prebuilt category: the boss-timer box.
 *
 * It predates the player's own boxes and its rows come from the trigger packs rather
 * than from anything they type. Making it a category anyway means one look, one way to
 * place a box, and one place that answers "what can put a countdown on my screen" —
 * rather than a second panel with its own separate everything.
 */
export const BOSS_CATEGORY = 'boss';

/**
 * A hex colour, or null.
 *
 * Strict shape, silent rejection. This value is interpolated into a CSS custom property,
 * so a loose check here is an injection rather than a typo — and the file it comes from
 * is one a player can hand-edit.
 */
export function color(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim();
  return HEX.test(hex) ? hex.toLowerCase() : null;
}

/** Fill in every optional field, so consumers never branch on absence. Degrade rather
 *  than refuse: a hand-edited file should still open. */
export function normalize(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const categories = (Array.isArray(raw.categories) ? raw.categories : [])
    .filter((c) => c && typeof c === 'object' && c.id)
    .map((c, i) => ({
      id: String(c.id),
      name: String(c.name ?? `Timers ${i + 1}`),
      // The boss-timer box is a category like any other — same chrome, same position
      // handling, same on/off — it just gets its rows from the trigger packs instead of
      // from timers listed here. `builtin` is what stops it being deleted and what tells
      // the manager to show its settings rather than a list of timers to edit.
      builtin: c.id === BOSS_CATEGORY,
      // Position only. Size is measured from the content and never stored, which is what
      // keeps an idle box from being an invisible rectangle that eats mouse clicks — see
      // the box renderer.
      x: Number.isFinite(c.x) ? Math.round(c.x) : null,
      y: Number.isFinite(c.y) ? Math.round(c.y) : null,
      enabled: c.enabled !== false,
      // What it looks like. Three independent numbers rather than one multiplier,
      // because "wide box, tight rows" and "narrow box, big text" are both layouts
      // somebody wants and a single scale can express neither.
      width: clampLook('width', c.width),
      rowHeight: clampLook('rowHeight', c.rowHeight),
      fontSize: clampLook('fontSize', c.fontSize),
    }));

  const known = new Set(categories.map((c) => c.id));
  const timers = (Array.isArray(raw.timers) ? raw.timers : [])
    .filter((t) => t && typeof t === 'object' && t.id)
    .map((t, i) => ({
      id: String(t.id),
      // A timer whose category has been deleted keeps the reference rather than being
      // silently rehomed: the store is what decides where it goes, and rewriting it on a
      // mere read would destroy the player's assignment.
      categoryId: known.has(String(t.categoryId)) ? String(t.categoryId) : (categories[0]?.id ?? null),
      name: String(t.name ?? `Timer ${i + 1}`),
      startsOn: String(t.startsOn ?? ''),
      match: MATCH_MODES.includes(t.match) ? t.match : 'contains',
      durationMs: clampDuration(t.durationMs),
      // Every bar has a colour of its own. Defaulted rather than nullable, because
      // "inherit from the box" is exactly the behaviour that made colour useless.
      color: color(t.color) ?? PALETTE[i % PALETTE.length],
      endsOn: t.endsOn ? String(t.endsOn) : null,
      enabled: t.enabled !== false,
    }));

  return { v: 1, categories, timers };
}

/** One of the three look numbers, clamped into its range. Silent repair rather than
 *  refusal: `timers.json` is a file a player can hand-edit, and a typo there should cost
 *  them the value they typed, never the box. */
export function clampLook(field, value) {
  const spec = LOOK[field];
  if (!spec) return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return spec.def;
  return Math.min(spec.max, Math.max(spec.min, n));
}

/**
 * The three numbers a box actually draws at, in pixels.
 *
 * Effective size is the stored value times the global text scale, and MULTIPLICATION
 * rather than replacement is the whole point: `scale` moves every HUD window together
 * and always has, so a per-box width has to ride on it rather than argue with it. At
 * scale 1 on an untouched box this returns 296 / 30 / 13 — the chrome as it shipped.
 *
 * Pure, and computed in main rather than in the box renderer, so the arithmetic the
 * whole feature rests on is unit-testable in WSL like `layout.js` is.
 */
export function boxLook(category, scale = 1) {
  const c = category && typeof category === 'object' ? category : {};
  const factor = Number(scale);
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  return {
    // Whole pixels for the two that decide the window's size — the window is integer
    // pixels either way, and a fractional width would round differently in the renderer's
    // measurement than in the box's own layout.
    width: Math.round(clampLook('width', c.width) * f),
    rowHeight: Math.round(clampLook('rowHeight', c.rowHeight) * f),
    // Text keeps two decimals: a font rounded to whole pixels quantises the scale slider
    // into visible steps, and nothing measures against this directly.
    fontSize: Math.round(clampLook('fontSize', c.fontSize) * f * 100) / 100,
  };
}

function clampDuration(value) {
  const ms = Math.round(Number(value));
  if (!Number.isFinite(ms) || ms <= 0) return 60_000;
  return Math.min(MAX_DURATION_MS, ms);
}

/**
 * Everything wrong with one timer, in the wording the form shows inline.
 *
 * Returns every problem rather than the first — reporting one, being fixed, then
 * reporting the next is how a four-field form becomes four round trips.
 */
export function validateTimer(raw) {
  const errors = [];
  const t = raw && typeof raw === 'object' ? raw : {};
  if (!String(t.name ?? '').trim()) errors.push('give it a name');
  if (!String(t.startsOn ?? '').trim()) errors.push('paste the log line that starts it');
  else if (t.match === 'regex') {
    try {
      // eslint-disable-next-line no-new
      new RegExp(t.startsOn);
    } catch (err) {
      errors.push(`that is not a valid regex — ${err.message}`);
    }
  }
  const ms = Number(t.durationMs);
  if (!Number.isFinite(ms) || ms <= 0) errors.push('the duration must be more than zero');
  else if (ms > MAX_DURATION_MS) errors.push('the duration is longer than a day');
  if (t.endsOn && t.match === 'regex') {
    try {
      // eslint-disable-next-line no-new
      new RegExp(t.endsOn);
    } catch (err) {
      errors.push(`the "ends on" pattern is not valid regex — ${err.message}`);
    }
  }
  return errors;
}

/** The next free `cN` / `tN`, computed from what exists rather than a stored counter —
 *  a counter drifts the moment the file is hand-edited, and a collision here is two
 *  boxes fighting over one position. */
export function nextId(items, prefix) {
  let max = 0;
  for (const item of items) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(item.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

/**
 * Compile one timer's text into something that can be tested against a log line.
 *
 * Plain text is lower-cased and compared with `includes`, which is what a player means
 * when they paste a line out of their log: they do not want to think about anchors, and
 * EQ writes the same effect line identically every time. Regex is there for the cases
 * plain text cannot reach and is opt-in per timer.
 */
export function compile(timer) {
  const text = String(timer.startsOn ?? '');
  if (!text) return null;
  if (timer.match === 'regex') {
    // Compiled ONCE, here, and null if it will not compile. Both halves matter: a
    // `new RegExp` per log line would be the whole frame budget during a raid, and a
    // pattern that throws mid-match would throw on every line forever. A timer that
    // cannot compile is reported rather than run — it would match nothing, silently.
    try {
      const re = new RegExp(text);
      return { test: (body) => re.test(body) };
    } catch {
      return null;
    }
  }
  if (timer.match === 'exact') {
    return { test: (body) => body === text };
  }
  const needle = text.toLowerCase();
  return { test: (body) => body.toLowerCase().includes(needle) };
}

/** The same for the optional "ends on" line. */
export function compileEnder(timer) {
  if (!timer.endsOn) return null;
  return compile({ ...timer, startsOn: timer.endsOn });
}

/**
 * What a fresh install starts with.
 *
 * The boss box, and one of the player's own so the feature is discoverable — an empty
 * manager is a screen that tells you nothing about what it is for.
 */
export function defaultModel() {
  return normalize({
    categories: [
      { id: BOSS_CATEGORY, name: 'Boss timers', x: null, y: null, enabled: true },
      { id: 'c1', name: 'My timers', x: null, y: null, enabled: true },
    ],
    timers: [],
  });
}

// --------------------------------------------------------------------- editing

/** Add a category, returning a NEW model — models are never mutated in place, so a
 *  rejected edit cannot leave half of itself behind. */
export function addCategory(model, name) {
  const base = normalize(model);
  const title = String(name ?? '').trim();
  if (!title) return { ok: false, errors: ['give the box a name'], model: base, id: null };
  // A name the list already uses is the box they meant, not a second one wearing the
  // same label — two identically-named boxes differ only by which one moves when you
  // drag it, which is not a difference anybody can see.
  const existing = base.categories.find((c) => c.name.toLowerCase() === title.toLowerCase());
  if (existing) return { ok: true, errors: [], model: base, id: existing.id };

  const id = nextId(base.categories, 'c');
  return {
    ok: true,
    errors: [],
    model: { ...base, categories: [...base.categories, normalizeCategory({ id, name: title })] },
    id,
  };
}

function normalizeCategory(raw) {
  return normalize({ categories: [raw], timers: [] }).categories[0];
}

export function updateCategory(model, id, patch) {
  const base = normalize(model);
  // Re-normalized on the way out, which it did not need to be while a patch could only
  // carry a name and a switch. A look patch arrives from a slider and could carry any
  // number at all, and the caller keeps this model in memory as well as writing it — so
  // the clamps have to run here rather than only inside the store's save.
  return {
    ok: true,
    errors: [],
    model: normalize({
      ...base,
      categories: base.categories.map((c) => (c.id === id ? { ...c, ...patch, id: c.id } : c)),
    }),
  };
}

/**
 * Remove a category, and say what happens to what is in it.
 *
 * Refused while it holds timers, and refused outright for the built-in box. A box with
 * timers in it can always be switched OFF, which takes it off the screen and moves
 * nothing; deleting it would have to send its timers somewhere, and silently rehoming
 * somebody's work is the failure this is guarding against.
 */
export function removeCategory(model, id) {
  const base = normalize(model);
  const category = base.categories.find((c) => c.id === id);
  if (!category) return { ok: false, errors: ['no such box'], model: base };
  if (category.builtin) {
    return { ok: false, errors: ['the boss timers box is built in — switch it off instead'], model: base };
  }
  const held = base.timers.filter((t) => t.categoryId === id).length;
  if (held) {
    return {
      ok: false,
      errors: [`${held} timer${held === 1 ? ' draws' : 's draw'} here — move or delete them first, or switch the box off`],
      model: base,
    };
  }
  return { ok: true, errors: [], model: { ...base, categories: base.categories.filter((c) => c.id !== id) } };
}

/** Add a timer from what the form holds. */
export function addTimer(model, form) {
  const base = normalize(model);
  const timer = {
    id: nextId(base.timers, 't'),
    categoryId: form.categoryId ?? base.categories.find((c) => !c.builtin)?.id ?? null,
    name: form.name,
    startsOn: form.startsOn,
    match: form.match,
    durationMs: Math.round(Number(form.durationSec ?? 0) * 1000),
    color: form.color,
    endsOn: form.endsOn || null,
    enabled: form.enabled !== false,
  };
  const errors = validateTimer(timer);
  if (errors.length) return { ok: false, errors, model: base, timer: null };
  const normalized = normalize({ ...base, timers: [...base.timers, timer] });
  return { ok: true, errors: [], model: normalized, timer: normalized.timers.at(-1) };
}

export function updateTimer(model, id, form) {
  const base = normalize(model);
  const index = base.timers.findIndex((t) => t.id === id);
  if (index === -1) return { ok: false, errors: ['no such timer'], model: base, timer: null };

  const timer = {
    ...base.timers[index],
    name: form.name,
    startsOn: form.startsOn,
    match: form.match,
    durationMs: Math.round(Number(form.durationSec ?? 0) * 1000),
    color: form.color,
    endsOn: form.endsOn || null,
    categoryId: form.categoryId ?? base.timers[index].categoryId,
    enabled: form.enabled !== false,
  };
  const errors = validateTimer(timer);
  if (errors.length) return { ok: false, errors, model: base, timer: null };

  const timers = base.timers.slice();
  timers[index] = timer;
  const normalized = normalize({ ...base, timers });
  return { ok: true, errors: [], model: normalized, timer: normalized.timers[index] };
}

export function removeTimer(model, id) {
  const base = normalize(model);
  const timers = base.timers.filter((t) => t.id !== id);
  if (timers.length === base.timers.length) return { ok: false, errors: ['no such timer'], model: base };
  return { ok: true, errors: [], model: { ...base, timers } };
}
