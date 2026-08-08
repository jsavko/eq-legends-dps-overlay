/**
 * Read a GINA trigger package into this app's native pack format.
 *
 * GINA is the EverQuest community's long-standing trigger program, and its shared `.gtp`
 * packages are the closest thing the game has to a public library of boss-mechanic
 * knowledge — a decade of guild Discords passing them around. `eq.gimasoft.com` no longer
 * resolves, GINA's own site and share-code service are gone, and the packages that remain
 * in circulation are orphaned files nobody can re-download. That is much of why reading
 * them is worth doing at all.
 *
 * **Written against real packages, not against a spec or a reference implementation.**
 * `pq-companion`'s `gina.go` is the most complete public reader and it is wrong twice —
 * it looks for the early-ender pattern in an `EndingTrigger` element that does not exist
 * (the real one is `EarlyEndText`, 68 uses in one package and zero of `EndingTrigger`
 * anywhere), and it declares `TimerEndingTrigger` a string when it is an element with
 * children. Both bugs are silent data loss. `tests/gina-import.test.js` pins both against
 * the committed fixtures.
 *
 * ## What is dropped, and why nothing is dropped quietly
 *
 * Imported triggers map onto the two surfaces this app already draws: cast-warning chips
 * in the alerts window, and countdown rows in the boss-timers window. This is not a
 * general trigger engine — no text-to-speech, no media files, no clipboard, no counters,
 * no free-floating text overlay. Those would each be a new surface, and two of them would
 * break the click-through/no-scroll invariants the overlay is built on.
 *
 * So GINA features with no honest home here are dropped — and every one is REPORTED, by
 * trigger name and feature, so the import screen can say "imported 41, dropped 12 — 9
 * text-to-speech, 3 stopwatch" instead of leaving the player to discover it mid-raid.
 *
 * The one thing that is emphatically NOT dropped is speech. 54 of 140 corpus triggers set
 * `UseTextToVoice`, and in several the spoken line is the ONLY output — "Gift of * Mana"
 * speaks "Free cast for {C}" and displays nothing at all. Importing those as text-only
 * would import them as silent no-ops, which is worse than dropping them: the player would
 * see a trigger listed as working and doing nothing. So when `DisplayText` is empty and
 * `TextToVoiceText` is not, the spoken text becomes the chip text.
 */

import { readPackageXml, looksLikeZip } from './unzip.js';
import { parseXml, asArray } from './xml.js';
import { patternTemplate, usesCounter } from './tokens.js';
import { normalize } from './pack.js';

export class GinaError extends Error {}

/** Every reason a feature or a whole trigger fails to survive the crossing. */
export const DROP_FEATURES = {
  SPEECH: 'text-to-speech',
  MEDIA: 'media file',
  CLIPBOARD: 'clipboard',
  COUNTER: 'counter',
  STOPWATCH: 'stopwatch timer',
  PATTERN: 'uncompilable pattern',
  EMPTY: 'nothing to show',
  DURATION: 'timer with no duration',
};

/**
 * Parse a `.gtp` buffer, or a bare `SharedData.xml`.
 *
 * Both forms circulate — `mattnac/gina_cloud` ships `all-data.xml` unzipped beside its
 * packages — so the fork is on the content, not on the file extension.
 *
 * @param {Buffer|string} input
 * @param {{name?: string, id?: string}} [opts] pack name, usually the filename stem
 * @returns {{pack: object, dropped: Array<{trigger, path, feature, detail, fatal}>}}
 */
export function parseGinaPackage(input, opts = {}) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  const xml = looksLikeZip(buf) ? readPackageXml(buf).data : buf;
  return readGinaXml(xml, opts);
}

/**
 * Parse the XML half, once the container (if any) is off.
 *
 * @param {Buffer|string} input
 * @param {{name?: string, id?: string}} [opts]
 */
export function readGinaXml(input, opts = {}) {
  const root = parseXml(input);
  if (root.name !== 'SharedData') {
    throw new GinaError(`expected a <SharedData> document, found <${root.name}>`);
  }
  const shared = typeof root.value === 'string' ? {} : root.value;

  const groups = [];
  const triggers = [];
  const dropped = [];
  let nextGroupId = 0;
  let nextTriggerId = 0;

  const walk = (node, path, parentId, inheritedEnabled) => {
    // `Triggers` at any level, including directly under SharedData with no group at all.
    // The corpus never does the latter, but the format allows it and the Go reference
    // impl handles it — a pack that imported as empty would be a mystery to debug.
    for (const raw of asArray(node.Triggers).flatMap((t) => asArray(t?.Trigger))) {
      if (typeof raw !== 'object' || raw === null) continue;
      const id = `t${++nextTriggerId}`;
      const result = readTrigger(raw, id, parentId, path);
      dropped.push(...result.dropped);
      if (result.trigger) triggers.push(result.trigger);
    }

    for (const g of asArray(node.TriggerGroups).flatMap((t) => asArray(t?.TriggerGroup))) {
      if (typeof g !== 'object' || g === null) continue;
      const name = text(g.Name) || 'Untitled group';
      const id = `g${++nextGroupId}`;
      // A child of a group that is off is off: GINA's own enablement is hierarchical,
      // and importing a disabled group's children as enabled would switch on a pack
      // half of whose author explicitly shipped it quiet.
      const enabled = inheritedEnabled && bool(g.EnableByDefault, true);
      groups.push({ id, name, comments: text(g.Comments), path: [...path, name], enabled });
      walk(g, [...path, name], id, enabled);
    }
  };

  walk(shared, [], null, true);

  const name = opts.name || groups[0]?.name || 'Imported triggers';
  // Normalized on the way out rather than returned raw: the import is one of several
  // ways a pack can be born, and every one of them must produce the same complete shape
  // — a consumer branching on whether a field happens to be present is a bug waiting to
  // be written, and `edited` in particular is read by the exporter.
  const pack = normalize({
    id: opts.id || slug(name),
    name,
    comments: text(shared.Comments),
    category: triggers.find((t) => t.category)?.category ?? '',
    modified: triggers.map((t) => t.modified).filter(Boolean).sort().pop() ?? '',
    origin: 'gina',
    enabled: true,
    groups,
    triggers,
  });
  return { pack, dropped };
}

// ---------------------------------------------------------------------------

function readTrigger(raw, id, groupId, path) {
  const name = text(raw.Name) || `Trigger ${id}`;
  const dropped = [];
  const where = path.join(' › ');
  const drop = (feature, detail, fatal = false) =>
    dropped.push({ trigger: name, path: where, feature, detail, fatal });

  const isRegex = bool(raw.EnableRegex, false);
  const { template: pattern, usesCharacter } = patternTemplate(text(raw.TriggerText), isRegex);
  if (!pattern) {
    drop(DROP_FEATURES.EMPTY, 'the trigger has no text to match on', true);
    return { trigger: null, dropped };
  }

  // ---- warning chip text: display first, spoken as the fallback ----------
  const displayText = bool(raw.UseText, false) ? text(raw.DisplayText) : '';
  const speechText = bool(raw.UseTextToVoice, false) ? text(raw.TextToVoiceText) : '';
  let warn = null;
  if (displayText) {
    warn = { text: displayText, from: 'display', group: null, tier: WARN_TIER };
    // The display text wins, so the spoken line genuinely is lost here — unlike the
    // fallback case below, where it becomes the chip and nothing is dropped at all.
    if (speechText) drop(DROP_FEATURES.SPEECH, `would have spoken "${speechText}"`);
  } else if (speechText) {
    warn = { text: speechText, from: 'speech', group: null, tier: WARN_TIER };
  }

  // ---- timer ------------------------------------------------------------
  // A refused timer is held rather than reported at once, because whether it is FATAL
  // depends on what else the trigger has: a stopwatch trigger that also shows a chip
  // loses its count-up and keeps working, while one with nothing else is gone. Deciding
  // that here would report the same fact with two different meanings.
  const timerType = text(raw.TimerType) || 'NoTimer';
  let timer = null;
  let refusedTimer = null;
  if (/^stopwatch$/i.test(timerType)) {
    // A count-up has no honest home in a panel of countdowns: every row there answers
    // "how long until", and a stopwatch answers a different question in the same shape.
    refusedTimer = [DROP_FEATURES.STOPWATCH, 'a count-up has no row shape in the timers panel'];
  } else if (/^(timer|repeatingtimer)$/i.test(timerType)) {
    const durationMs = ginaDuration(raw);
    if (!durationMs) {
      refusedTimer = [DROP_FEATURES.DURATION, `TimerType is ${timerType} but no duration is set`];
    } else {
      timer = buildTimer(raw, name, timerType, durationMs, drop);
    }
  }

  // ---- features with no home here ---------------------------------------
  // PlayMediaFile is a bare boolean carrying no filename, and no .gtp in the corpus
  // bundles audio — so the file it names is unreachable even to GINA. Dropping media
  // is forced by the format here, not merely by our scope.
  if (bool(raw.PlayMediaFile, false)) drop(DROP_FEATURES.MEDIA, 'no filename is stored in the package');
  if (bool(raw.CopyToClipboard, false)) {
    drop(DROP_FEATURES.CLIPBOARD, `would have copied "${text(raw.ClipboardText)}"`);
  }
  if (bool(raw.UseCounterResetTimer, false) ||
      [raw.DisplayText, raw.TextToVoiceText, raw.ClipboardText, raw.TimerName]
        .some((t) => usesCounter(text(t)))) {
    drop(DROP_FEATURES.COUNTER, 'fire counts are not tracked');
  }

  // A trigger that neither warns nor times is a row in a settings list that does
  // nothing at all — exactly the silent no-op the speech fallback exists to prevent,
  // so it is reported rather than imported. `fatal` says which of the two happened,
  // and the import report counts on the distinction: a feature lost off a working
  // trigger and a trigger that never arrived are not the same news.
  if (!warn && !timer) {
    if (refusedTimer) drop(refusedTimer[0], refusedTimer[1], true);
    else drop(DROP_FEATURES.EMPTY, 'no display text, no speech and no timer', true);
    return { trigger: null, dropped };
  }
  if (refusedTimer) drop(refusedTimer[0], refusedTimer[1]);

  return {
    trigger: {
      id,
      name,
      groupId,
      enabled: true,
      comments: text(raw.Comments),
      category: text(raw.Category),
      modified: text(raw.Modified),
      pattern,
      literal: !isRegex,
      usesCharacter,
      // GINA's own hint that a cheap literal check is worth doing first. We compute the
      // prefilter ourselves either way; this is kept for round-trip fidelity.
      fastCheck: bool(raw.UseFastCheck, false),
      warn,
      timer,
      provenance: 'imported',
    },
    dropped,
  };
}

/** The tier a trigger chip draws at: a warn line, not a full-width interrupt banner.
 *  Tier 3 is reserved for "drop everything" and an imported trigger cannot claim that
 *  on its author's behalf — the player can raise it per-trigger in the editor. */
const WARN_TIER = 2;

function buildTimer(raw, triggerName, timerType, durationMs, drop) {
  const endingSec = number(text(raw.TimerEndingTime));
  const useEnding = bool(raw.UseTimerEnding, false);

  // The Go reference importer declares this a string and so loses the text entirely.
  // It is an element with children — the same shape as a trigger's own output fields.
  const endingNode = raw.TimerEndingTrigger;
  const ending = typeof endingNode === 'object' && endingNode !== null ? endingNode : {};
  const endingDisplay = bool(ending.UseText, false) ? text(ending.DisplayText) : '';
  const endingSpeech = bool(ending.UseTextToVoice, false) ? text(ending.TextToVoiceText) : '';
  const endingText = endingDisplay || endingSpeech || null;
  if (endingDisplay && endingSpeech) {
    drop(DROP_FEATURES.SPEECH, `ending notice would have spoken "${endingSpeech}"`);
  }

  const earlyEnders = [];
  // `TimerEarlyEnders` appears TWICE in a single real RespawnTimer trigger — once
  // self-closing and empty, once with content — so both levels flatten rather than
  // letting the last occurrence win, which would drop 68 early enders from that pack.
  for (const block of asArray(raw.TimerEarlyEnders)) {
    for (const ender of asArray(block?.EarlyEnder)) {
      if (typeof ender !== 'object' || ender === null) continue;
      const enderRegex = bool(ender.EnableRegex, false);
      const source = text(ender.EarlyEndText);
      if (!source) continue;
      // `backreferences` is what separates an early ender from a trigger: `{S}` and
      // `${mob}` here name the match that ARMED the timer rather than capturing
      // anything of their own, so they survive as placeholders instead of becoming
      // groups — and, in literal mode, must not be escaped into inert text.
      const built = patternTemplate(source, enderRegex, { backreferences: true });
      earlyEnders.push({
        pattern: built.template,
        literal: !enderRegex,
        usesCharacter: built.usesCharacter,
        // An early ender that names the timer's own capture cannot be compiled until a
        // timer actually arms and supplies the match to fill it in.
        needsMatch: built.usesMatch,
      });
    }
  }

  return {
    kind: /^repeatingtimer$/i.test(timerType) ? 'repeating' : 'countdown',
    // A nameless timer would key every fire to the same slot; the trigger's own name is
    // the only other thing the format guarantees, and it is what GINA shows too.
    name: text(raw.TimerName) || triggerName,
    durationMs,
    restart: restartBehavior(text(raw.TimerStartBehavior)),
    restartByName: bool(raw.RestartBasedOnTimerName, false),
    endingMs: useEnding && endingSec > 0 ? Math.round(endingSec * 1000) : null,
    endingText,
    earlyEnders,
  };
}

/**
 * `TimerStartBehavior`, normalized.
 *
 * `StartNewTimer` (124 uses) and `RestartTimer` (16) are the two the corpus contains;
 * `DoNothingIfRunning` is handled because the format defines it and a pack outside our
 * nine could use it. An unrecognized value falls back to the common case rather than
 * dropping the timer — a behaviour we do not know is not a timer we cannot show.
 */
function restartBehavior(value) {
  if (/^restart/i.test(value)) return 'restart';
  if (/^donothing/i.test(value)) return 'ignore';
  return 'new';
}

/**
 * A timer's duration in milliseconds, or 0.
 *
 * The millisecond field wins when it is actually set — but it is frequently EMPTY
 * (`<TimerMillisecondDuration></TimerMillisecondDuration>` in every RespawnTimer
 * trigger), which is why "present" is not the test and "greater than zero" is.
 *
 * `TimerDuration` is documented nowhere and is not reliably an integer count of seconds:
 * the format also permits a float and the `HH:MM:SS` / `MM:SS` clock forms. Every value
 * in the committed corpus is a bare integer, so the clock forms are handled on the
 * strength of the Go reference implementation rather than on measurement — noted here
 * because that is a weaker basis than the rest of this file rests on.
 */
export function ginaDuration(raw) {
  const ms = number(text(raw.TimerMillisecondDuration));
  if (ms > 0) return Math.round(ms);

  const seconds = text(raw.TimerDuration);
  if (!seconds) return 0;

  if (seconds.includes(':')) {
    const parts = seconds.split(':').map((p) => number(p));
    if (parts.some((p) => !Number.isFinite(p))) return 0;
    const total = parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
    return Math.round(total * 1000);
  }

  const value = number(seconds);
  return value > 0 ? Math.round(value * 1000) : 0;
}

/**
 * Booleans, read loosely.
 *
 * .NET's serializer writes `True`/`False`, but the same files get hand-edited and
 * regenerated by third-party tools, and `true`, `1` and `yes` all occur in the wild.
 * A missing element takes the caller's default rather than reading as false: absent is
 * not the same claim as off, and for `EnableByDefault` the difference is a whole pack
 * importing switched off.
 */
export function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/** An element's text, with objects (an element that had children) reading as empty. */
function text(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  // A repeated element: take the first non-empty, which is what the serializer's own
  // reader would do and is the only choice that cannot invent content.
  if (Array.isArray(value)) return text(value.find((v) => typeof v === 'string' && v.trim()));
  return '';
}

function number(value) {
  const n = Number.parseFloat(String(value).trim());
  return Number.isFinite(n) ? n : 0;
}

/** A filesystem- and id-safe form of a pack name. */
export function slug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'pack';
}
