/**
 * The native trigger-pack format: our own JSON, and the source of truth.
 *
 * GINA's `.gtp` is read AND written, but it is not the format packs are stored in. The
 * reason is not preference — the JSON carries three things GINA has no element for:
 *
 *   - **`warn.group`**, which of the six warning groups a trigger belongs to. GINA sorts
 *     warnings by nothing; this app sorts by what the player would DO about them, and a
 *     format that could not say "this is a heal" would have to guess.
 *   - **`warn.tier`**, how loud a chip draws. GINA has one severity: on.
 *   - **`provenance`**, which separates an authored duration from a learned estimate.
 *     That distinction is the whole reason the timers panel can be honest — a countdown
 *     from a pack is exact-but-maybe-wrong-for-this-server, a learned one is an estimate
 *     with a spread, and a format that flattened them into one number would make the
 *     panel claim more than it knows.
 *
 * So export to `.gtp` is lossy by construction, and `gina-export.js` says so in a report
 * rather than writing a file that silently means less than the one it came from.
 *
 * Pure Node with no Electron import, like everything under `src/triggers/`, so it
 * unit-tests in WSL exactly as `parser/`, `layout.js` and `history.js` do.
 */

import { compileTemplate, patternTemplate, literalPrefilter } from './tokens.js';

export const PACK_VERSION = 1;

/** The tier a trigger chip may claim, and the default an imported one gets. */
export const MIN_TIER = 1;
export const MAX_TIER = 3;
export const DEFAULT_TIER = 2;

/** The pack authored triggers land in, so the player's own work is never mixed
 *  into someone else's imported pack — see `myTriggersPack`. */
export const MY_TRIGGERS_ID = 'my-triggers';

/**
 * The reserved panel id: the boss-timer window, which is not one of the player's panels.
 *
 * It predates them, it has its own window, its own bounds key and its own switch, and it
 * is the default every pack in existence lands on. Reserved rather than seeded as a
 * player panel so that "delete this panel" can never be asked about it.
 */
export const BOSS_PANEL = 'boss';

/** Longest a timer may run. See `validateTrigger` for why there is a ceiling at all. */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Fill in every optional field, so consumers never branch on absence.
 *
 * Normalizing rather than validating on read is deliberate: a pack file written by an
 * older version of this app, or hand-edited by a player, should degrade to something
 * usable rather than refusing to load. `validate()` is for the moment a pack ENTERS the
 * store; this is for every read afterwards.
 */
export function normalize(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const groups = Array.isArray(raw.groups) ? raw.groups : [];
  const triggers = Array.isArray(raw.triggers) ? raw.triggers : [];

  return {
    v: PACK_VERSION,
    id: String(raw.id ?? 'pack'),
    name: String(raw.name ?? raw.id ?? 'Untitled pack'),
    comments: String(raw.comments ?? ''),
    category: String(raw.category ?? ''),
    modified: String(raw.modified ?? ''),
    origin: raw.origin === 'native' ? 'native' : 'gina',
    /**
     * Installed from this app's own build rather than made here.
     *
     * The distinction `origin` cannot make: the seed boss-timer pack is `native` — it is
     * our JSON, not a GINA import — and it still has an upstream copy sitting in the
     * build that a later version will want to replace. A pack the player created has no
     * such copy and must never be replaced by anything.
     */
    shipped: raw.shipped === true,
    enabled: raw.enabled !== false,
    /** Set once a pack with an upstream is edited here, so neither a re-export nor an
     *  upgrade can pass over the player's changes as if they were not there. */
    edited: raw.edited === true,
    groups: groups.map((g, i) => ({
      id: String(g?.id ?? `g${i + 1}`),
      name: String(g?.name ?? 'Untitled group'),
      comments: String(g?.comments ?? ''),
      path: Array.isArray(g?.path) ? g.path.map(String) : [String(g?.name ?? '')],
      enabled: g?.enabled !== false,
    })),
    triggers: triggers.map((t, i) => normalizeTrigger(t, i)),
  };
}

function normalizeTrigger(raw, index) {
  const t = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(t.id ?? `t${index + 1}`),
    name: String(t.name ?? `Trigger ${index + 1}`),
    groupId: t.groupId == null ? null : String(t.groupId),
    enabled: t.enabled !== false,
    comments: String(t.comments ?? ''),
    category: String(t.category ?? ''),
    modified: String(t.modified ?? ''),
    pattern: String(t.pattern ?? ''),
    literal: t.literal === true,
    usesCharacter: t.usesCharacter === true,
    fastCheck: t.fastCheck === true,
    warn: normalizeWarn(t.warn),
    timer: normalizeTimer(t.timer),
    provenance: t.provenance === 'authored' ? 'authored' : 'imported',
  };
}

function normalizeWarn(raw) {
  if (!raw || typeof raw !== 'object' || !raw.text) return null;
  const tier = Number(raw.tier);
  return {
    text: String(raw.text),
    from: raw.from === 'speech' ? 'speech' : raw.from === 'display' ? 'display' : 'authored',
    group: raw.group ? String(raw.group) : null,
    tier: Number.isFinite(tier) ? Math.min(MAX_TIER, Math.max(MIN_TIER, Math.round(tier))) : DEFAULT_TIER,
  };
}

function normalizeTimer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const durationMs = Number(raw.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const endingMs = Number(raw.endingMs);
  const enders = Array.isArray(raw.earlyEnders) ? raw.earlyEnders : [];

  return {
    kind: raw.kind === 'repeating' ? 'repeating' : 'countdown',
    name: String(raw.name ?? ''),
    /**
     * Which panel this countdown draws in: the id of one of the player's own timer
     * panels, or `BOSS_PANEL` for the fight's clock.
     *
     * An id rather than a two-value enum because the panels are the PLAYER'S — they name
     * them, place them and switch them individually — so what a trigger stores has to be
     * a reference to one of theirs, not a choice from a fixed pair we decided on.
     *
     * The default is `boss` and it has to stay `boss` forever. Every pack that exists
     * predates this field: the sixteen shipped boss timers, every `.gtp` a guild has
     * passed around, and every trigger the player has already authored. An upgrade that
     * read an absent panel as anything else would silently relocate countdowns somebody
     * had already placed and learned to glance at, which is the one thing this whole
     * corner of the app is built not to do. Moving a row is something the player does,
     * once, on purpose.
     *
     * A non-string normalizes rather than failing, on the same reasoning as everything
     * else here: a hand-edited pack should degrade to something usable rather than
     * refusing to load. An id naming a panel that no longer exists is NOT normalized
     * away — the store is what knows which panels exist, and silently rewriting the
     * reference here would destroy the player's assignment on a mere read.
     */
    panel: typeof raw.panel === 'string' && raw.panel ? raw.panel : BOSS_PANEL,
    durationMs: Math.min(MAX_DURATION_MS, Math.round(durationMs)),
    restart: ['restart', 'ignore'].includes(raw.restart) ? raw.restart : 'new',
    restartByName: raw.restartByName === true,
    endingMs: Number.isFinite(endingMs) && endingMs > 0 ? Math.round(endingMs) : null,
    endingText: raw.endingText ? String(raw.endingText) : null,
    earlyEnders: enders
      .filter((e) => e && typeof e === 'object' && e.pattern)
      .map((e) => ({
        pattern: String(e.pattern),
        literal: e.literal === true,
        usesCharacter: e.usesCharacter === true,
        needsMatch: e.needsMatch === true,
      })),
  };
}

/**
 * Is this pack fit to enter the store?
 *
 * Returns every problem rather than the first, because the caller shows them all to a
 * player at once — reporting one error, being fixed, and then reporting the next is how
 * a five-field form becomes five round trips.
 *
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validate(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['not an object'] };
  if (!input.id) errors.push('the pack has no id');
  if (!input.name) errors.push('the pack has no name');
  if (!Array.isArray(input.triggers)) errors.push('the pack has no trigger list');

  const seen = new Set();
  for (const t of Array.isArray(input.triggers) ? input.triggers : []) {
    const label = t?.name || t?.id || 'a trigger';
    for (const err of validateTrigger(t)) errors.push(`${label}: ${err}`);
    if (t?.id) {
      if (seen.has(t.id)) errors.push(`${label}: duplicate trigger id "${t.id}"`);
      seen.add(t.id);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Everything wrong with one trigger, in the wording the editor shows inline.
 *
 * The pattern is compiled here rather than merely inspected: "does this regex work" has
 * exactly one honest test, and a pattern that does not compile must never be saved —
 * it would sit in the list looking live and match nothing forever.
 */
export function validateTrigger(raw) {
  const errors = [];
  const t = raw && typeof raw === 'object' ? raw : {};

  if (!String(t.name ?? '').trim()) errors.push('a name is required');
  if (!String(t.pattern ?? '').trim()) {
    errors.push('a pattern is required');
  } else {
    // Compiled against a placeholder character: `{C}` is escaped on substitution, so no
    // real name can turn a valid pattern invalid, and none can rescue an invalid one.
    const { error } = compileTemplate(t.pattern, 'Character');
    if (error) errors.push(`the pattern does not compile — ${error}`);
  }

  if (!t.warn && !t.timer) errors.push('it must show something: a warning, a timer, or both');
  if (t.warn && !String(t.warn.text ?? '').trim()) errors.push('the warning text is empty');

  if (t.timer) {
    const ms = Number(t.timer.durationMs);
    if (!Number.isFinite(ms) || ms <= 0) errors.push('the timer needs a duration above zero');
    // A ceiling, because the timers panel has no scroll and a row never leaves before
    // its time: a fat-fingered "3000 minutes" would hold a slot until the app restarts.
    else if (ms > MAX_DURATION_MS) errors.push('the timer duration is longer than a day');

    for (const e of Array.isArray(t.timer.earlyEnders) ? t.timer.earlyEnders : []) {
      if (e?.needsMatch) continue;   // cannot be compiled until a timer arms
      const { error } = compileTemplate(e?.pattern ?? '', 'Character');
      if (error) errors.push(`an early-end pattern does not compile — ${error}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------- authoring

/** An empty pack for the player's own triggers. */
export function myTriggersPack() {
  return normalize({
    id: MY_TRIGGERS_ID,
    name: 'My Triggers',
    comments: 'Triggers written here rather than imported.',
    origin: 'native',
    enabled: true,
    groups: [],
    triggers: [],
  });
}

/**
 * Build a trigger from what the editor form holds.
 *
 * The form deals in the author's terms — a pattern typed as text, regex or literal, a
 * duration in seconds — and this is where that becomes the stored shape. Notably the
 * pattern goes through the same `patternTemplate` as an imported one, so `{C}` and `{S}`
 * work identically whether a trigger was written here or came out of a stranger's pack.
 *
 * @param {{name, pattern, literal?, warnText?, warnGroup?, tier?, timerName?,
 *          durationSec?, repeating?, endingSec?, endingText?, earlyEndText?,
 *          earlyEndLiteral?, restart?}} form
 */
export function buildTrigger(form, id) {
  const built = patternTemplate(form.pattern ?? '', !form.literal);
  const durationMs = Math.round(Number(form.durationSec ?? 0) * 1000);
  const endingMs = Math.round(Number(form.endingSec ?? 0) * 1000);

  const earlyEnders = [];
  if (String(form.earlyEndText ?? '').trim()) {
    const ender = patternTemplate(form.earlyEndText, !form.earlyEndLiteral, { backreferences: true });
    earlyEnders.push({
      pattern: ender.template,
      literal: Boolean(form.earlyEndLiteral),
      usesCharacter: ender.usesCharacter,
      needsMatch: ender.usesMatch,
    });
  }

  return normalizeTrigger({
    id,
    name: form.name,
    groupId: form.groupId ?? null,
    enabled: form.enabled !== false,
    comments: form.comments ?? '',
    pattern: built.template,
    literal: Boolean(form.literal),
    usesCharacter: built.usesCharacter,
    fastCheck: true,
    warn: String(form.warnText ?? '').trim()
      ? { text: form.warnText, from: 'authored', group: form.warnGroup ?? null, tier: form.tier ?? DEFAULT_TIER }
      : null,
    timer: durationMs > 0
      ? {
          kind: form.repeating ? 'repeating' : 'countdown',
          name: form.timerName || form.name,
          // Straight through from the editor's DRAWS IN select. `normalizeTimer` is
          // what turns silence — an older form, a pack built by a script — into `boss`.
          panel: form.panel,
          durationMs,
          restart: form.restart ?? 'restart',
          restartByName: true,
          endingMs: endingMs > 0 ? endingMs : null,
          endingText: form.endingText || null,
          earlyEnders,
        }
      : null,
    provenance: 'authored',
  }, 0);
}

/**
 * Add a trigger, returning a NEW pack — packs are never mutated in place, so a rejected
 * edit cannot leave half of itself behind in the store's copy.
 *
 * `form.newGroupName` makes a group on the way through. Grouping is how an imported pack
 * is switched on a boss at a time, and until now the player could only ever inherit
 * somebody else's groups — the editor could file a trigger into an existing one and there
 * was no way whatsoever to make one. Creating it here rather than on its own channel is
 * the opposite call from `TRIGGERS_CREATE_PACK`, and for a reason: an empty pack is a
 * destination you plan, an empty group is nothing at all.
 */
export function createTrigger(pack, form) {
  const base = normalize(pack);
  const { pack: withGroup, groupId } = ensureGroup(base, form);
  const trigger = buildTrigger({ ...form, groupId }, nextTriggerId(base));
  const errors = validateTrigger(trigger);
  // The group goes with it: a rejected trigger must not leave an empty group behind,
  // which would be a change the player never asked for on a save that did not happen.
  if (errors.length) return { ok: false, errors, pack: base, trigger: null };
  return {
    ok: true,
    errors: [],
    pack: touch({ ...withGroup, triggers: [...withGroup.triggers, trigger] }),
    trigger,
  };
}

/** @returns {{pack: object, groupId: string|null}} the pack with `newGroupName` added. */
function ensureGroup(pack, form) {
  const name = String(form.newGroupName ?? '').trim();
  if (!name) return { pack, groupId: form.groupId ?? null };

  // A name the pack already uses is the group the player meant, not a second one beside
  // it wearing the same label — two identically-named rows in the list would be a switch
  // whose effect you could only discover by trying it.
  const existing = pack.groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
  if (existing) return { pack, groupId: existing.id };

  const id = nextGroupId(pack);
  const group = { id, name, comments: '', path: [name], enabled: true };
  return { pack: { ...pack, groups: [...pack.groups, group] }, groupId: id };
}

/** The next free `gN`, computed from what exists — see `nextTriggerId`. */
function nextGroupId(pack) {
  let max = 0;
  for (const g of pack.groups) {
    const n = /^g(\d+)$/.exec(g.id);
    if (n) max = Math.max(max, Number(n[1]));
  }
  return `g${max + 1}`;
}

export function updateTrigger(pack, id, form) {
  const base = normalize(pack);
  const index = base.triggers.findIndex((t) => t.id === id);
  if (index === -1) return { ok: false, errors: [`no trigger with id "${id}"`], pack: base, trigger: null };

  const previous = base.triggers[index];
  // The group is the one part of an edit that can add to the pack, so it is resolved the
  // same way a new trigger's is. A form that mentions no group at all leaves the trigger
  // where it was, rather than reading silence as "move it to the top level".
  const moving = 'groupId' in form || String(form.newGroupName ?? '').trim();
  const { pack: withGroup, groupId } = moving
    ? ensureGroup(base, form)
    : { pack: base, groupId: previous.groupId };

  // Provenance survives an edit: a trigger that came from a pack is still a trigger
  // that came from a pack, and the EDITED mark on the pack is what records the change.
  const trigger = { ...buildTrigger({ ...form, groupId }, id), provenance: previous.provenance };
  const errors = validateTrigger(trigger);
  if (errors.length) return { ok: false, errors, pack: base, trigger: null };

  const triggers = withGroup.triggers.slice();
  triggers[index] = trigger;
  return { ok: true, errors: [], pack: touch({ ...withGroup, triggers }), trigger };
}

export function deleteTrigger(pack, id) {
  const base = normalize(pack);
  const triggers = base.triggers.filter((t) => t.id !== id);
  if (triggers.length === base.triggers.length) {
    return { ok: false, errors: [`no trigger with id "${id}"`], pack: base };
  }
  return { ok: true, errors: [], pack: touch({ ...base, triggers }) };
}

/**
 * Mark a pack as no longer being what it was handed over as.
 *
 * Only packs with an UPSTREAM carry the mark, which is two cases and not one: a GINA
 * import, whose author shipped it, and the seed boss-timer pack, which this app's own
 * build ships. A pack the player made here has nothing to have diverged from, and
 * marking every save on it "edited" would tag a pack that is nothing but edits.
 *
 * `gina-export.js` reads the mark so an exported `.gtp` can say plainly that it is a
 * modified copy rather than being passed on as the original, and `installSeedPack` reads
 * it to leave a boss-timer pack the player has corrected exactly where it is.
 */
function touch(pack) {
  return pack.origin === 'gina' || pack.shipped ? { ...pack, edited: true } : pack;
}

/** The next free `tN`, computed from what exists rather than from a stored counter —
 *  a counter in the file would drift the moment a pack was hand-edited. */
function nextTriggerId(pack) {
  let max = 0;
  for (const t of pack.triggers) {
    const n = /^t(\d+)$/.exec(t.id);
    if (n) max = Math.max(max, Number(n[1]));
  }
  return `t${max + 1}`;
}

// ---------------------------------------------------------------------- compiling

/**
 * Compile a normalized pack into what the engine matches with.
 *
 * Done once per pack load and once per character switch — never per line. A raid pushes
 * hundreds of lines a second past what may be hundreds of patterns, and `new RegExp` in
 * that loop would be the whole frame budget.
 *
 * Triggers whose pattern will not compile are returned SEPARATELY rather than silently
 * skipped, because a stranger's pack may hold a .NET-only construct and the player has
 * to be able to see which trigger went quiet and why.
 *
 * @returns {{compiled: Array<object>, failed: Array<{id, name, error}>}}
 */
export function compilePack(pack, character) {
  const base = normalize(pack);
  const compiled = [];
  const failed = [];

  for (const trigger of base.triggers) {
    if (!trigger.enabled) continue;
    if (!groupEnabled(base, trigger.groupId)) continue;

    const { regex, error } = compileTemplate(trigger.pattern, character);
    if (!regex) {
      failed.push({ id: trigger.id, name: trigger.name, error });
      continue;
    }

    compiled.push({
      packId: base.id,
      packName: base.name,
      trigger,
      regex,
      prefilter: literalPrefilter(regex.source),
      // Early enders that name no capture can be compiled now; the rest wait for a
      // match to fill them in and are compiled when a timer actually arms.
      enders: (trigger.timer?.earlyEnders ?? []).map((e) => ({
        ...e,
        regex: e.needsMatch ? null : compileTemplate(e.pattern, character).regex,
      })),
    });
  }
  return { compiled, failed };
}

/**
 * What a pack amounts to, for the import report and the pack list.
 *
 * `live` exists because of a real trap: GINA's `EnableByDefault` is `False` on most
 * shared packs, so three of the five committed fixtures import with every trigger
 * switched off. That is the author's intent and is respected — but a report saying
 * "imported 5 triggers" while nothing whatsoever fires is a mystery the player has no
 * way to solve, so the count that matters is stated separately.
 */
export function packStats(input) {
  const pack = normalize(input);
  let live = 0;
  let timers = 0;
  let warnings = 0;
  // Countdowns per panel. The same trap `live` exists for, one level down: a pack can
  // import with every trigger switched on and still put nothing on screen, because all
  // of its countdowns draw in a panel the player has turned off. "12 timers" beside an
  // empty screen is a mystery with no way in; naming the panel is the way in.
  const byPanel = {};
  for (const t of pack.triggers) {
    if (t.enabled && groupEnabled(pack, t.groupId)) live++;
    if (t.timer) {
      timers++;
      byPanel[t.timer.panel] = (byPanel[t.timer.panel] ?? 0) + 1;
    }
    if (t.warn) warnings++;
  }
  return {
    triggers: pack.triggers.length, live, timers, warnings,
    groups: pack.groups.length, byPanel,
  };
}

/** A trigger inherits its group's switch, and a group inherits its ancestors' —
 *  which the flattened `path` already encodes, since import folds inheritance in. */
function groupEnabled(pack, groupId) {
  if (groupId == null) return true;
  const group = pack.groups.find((g) => g.id === groupId);
  return group ? group.enabled : true;
}
