/**
 * The import dry-run: replay a pack against the player's OWN log and report what fires.
 *
 * This is the headline of the whole feature, and it exists because of a measurement. The
 * full public corpus — 140 triggers, collapsing to 31 distinct patterns — was replayed
 * against 948,677 lines of a real EverQuest Legends session. Fifteen patterns fired, for
 * 6,515 matches. Sixteen did not, and grepping the log for each dead pattern's subject
 * separated "this text does not exist" from "this text exists, slightly reworded":
 *
 *   - `^You gain (|party )experience!!$` — EQL prints `You gain party experience! (0.769%)`
 *   - `(?<mob>.*) is engulfed in a swarm` — EQL says "engulfed **by** a swarm"
 *   - `Your spell fizzles!` — EQL names the spell: `Your Creeping Crud spell fizzles!`
 *
 * Seven of the sixteen are one wording delta from working. The tempting response is an
 * import-time pass that rewrites a stranger's regex toward EQL conventions — and that is
 * guessing, which is the one thing this project refuses to do. Every rewrite would be a
 * claim about what someone else meant, applied silently, to a warning the player is
 * going to trust in a raid.
 *
 * So the honest version is this: measure, and say what you measured. Before a pack is
 * enabled the player sees "22 of 31 fired against your last 149 hours; 9 never matched",
 * with the dead ones listed by pattern so a near-miss is visible and editable rather than
 * mysterious. Adaptations are then offered one at a time, explicitly, and re-measured by
 * the same replay — see `rankTolerantPattern`, the only one that is mechanical enough to
 * be safe.
 *
 * The same code path is the authoring Test button: write a pattern, press Test, and see
 * it fired 989 times in your own 149 hours with a sample line. That is what GINA users
 * do by hand-grepping their logs, and here it falls out of the machinery already built.
 */

import fs from 'node:fs';

import { parseTimestamp } from '../parser/timestamp.js';
import { compilePack, normalize } from './pack.js';
import { compileTemplate, literalPrefilter } from './tokens.js';

/**
 * How much of the log's tail to read, and in what bites.
 *
 * The TAIL rather than the whole file, and in chunks with a yield between them, because
 * this runs in the main process while a raid is in progress: reading 79 MB synchronously
 * takes 2.6 seconds, and 2.6 seconds of blocked event loop is a stalled tailer and ten
 * missed snapshot pushes. The report states how many lines it actually saw, so "989 hits
 * in the last 948,677 lines" is never mistaken for a claim about the whole file.
 */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Replay lines against a pack.
 *
 * @param {object|object[]} packs
 * @param {Iterable<string>} lines  raw log lines, timestamps included
 * @param {{character?: string, rankTolerant?: boolean}} [opts]
 * @returns {{lines: number, matched: number, triggers: Array<object>}}
 */
export function dryRun(packs, lines, opts = {}) {
  const list = (Array.isArray(packs) ? packs : [packs]).map(normalize);
  const character = opts.character ?? null;

  const entries = [];
  for (const pack of list) {
    // Every trigger is measured, including ones switched off: the whole point is to
    // decide what to switch ON, and a report that hid the disabled half would be
    // answering a question nobody asked.
    const open = {
      ...pack,
      groups: pack.groups.map((g) => ({ ...g, enabled: true })),
      triggers: pack.triggers.map((t) => ({ ...t, enabled: true })),
    };
    const { compiled, failed } = compilePack(open, character);

    for (const c of compiled) {
      entries.push({
        packId: pack.id,
        packName: pack.name,
        id: c.trigger.id,
        name: c.trigger.name,
        pattern: c.trigger.pattern,
        regex: c.regex,
        prefilter: c.prefilter,
        adapted: opts.rankTolerant ? adapt(c.trigger.pattern, character) : null,
        hits: 0,
        adaptedHits: 0,
        sample: null,
        adaptedSample: null,
        error: null,
      });
    }
    for (const f of failed) {
      entries.push({
        packId: pack.id, packName: pack.name, id: f.id, name: f.name,
        pattern: null, regex: null, prefilter: null, adapted: null,
        hits: 0, adaptedHits: 0, sample: null, adaptedSample: null, error: f.error,
      });
    }
  }

  let count = 0;
  let matched = 0;
  for (const line of lines) {
    const parsed = parseTimestamp(line);
    if (!parsed) continue;
    count++;
    const body = parsed.body;
    let any = false;

    for (const entry of entries) {
      let hit = false;
      if (entry.regex) {
        if (!entry.prefilter || entry.prefilter.some((literal) => body.includes(literal))) {
          hit = entry.regex.test(body);
        }
      }
      if (hit) {
        entry.hits++;
        entry.sample ??= body;
        any = true;
      }
      // The adaptation is measured SEPARATELY and alongside, never instead — the player
      // is being shown what one specific, named change would buy, not handed a rewritten
      // pattern and told it works now.
      if (entry.adapted?.regex && entry.adapted.regex.test(body)) {
        entry.adaptedHits++;
        // The sample is a line the adaptation GAINED, not just the first it matched.
        // Showing one the original already caught would illustrate nothing about what
        // the change buys, which is the only question being asked.
        if (!hit) entry.adaptedSample ??= body;
      }
    }
    if (any) matched++;
  }

  return {
    lines: count,
    matched,
    triggers: entries.map((e) => ({
      packId: e.packId,
      packName: e.packName,
      id: e.id,
      name: e.name,
      pattern: e.pattern,
      hits: e.hits,
      sample: e.sample,
      error: e.error,
      // What rank tolerance would add, and nothing more. Null when it was not asked for
      // or when the pattern has no place to put a rank.
      adapted: e.adapted
        ? { pattern: e.adapted.pattern, hits: e.adaptedHits, sample: e.adaptedSample, gain: e.adaptedHits - e.hits }
        : null,
    })),
  };
}

/**
 * Test ONE pattern — the authoring Test button.
 *
 * @param {string} pattern  a stored pattern template (`{C}` may still be in it)
 * @param {Iterable<string>} lines
 * @returns {{ok: boolean, error: string|null, hits: number, samples: string[], lines: number}}
 */
export function testPattern(pattern, lines, opts = {}) {
  const { regex, error } = compileTemplate(pattern, opts.character ?? null);
  if (!regex) return { ok: false, error, hits: 0, samples: [], lines: 0 };

  const prefilter = literalPrefilter(regex.source);
  const samples = [];
  let hits = 0;
  let count = 0;

  for (const line of lines) {
    const parsed = parseTimestamp(line);
    if (!parsed) continue;
    count++;
    const body = parsed.body;
    if (prefilter && !prefilter.some((literal) => body.includes(literal))) continue;
    if (!regex.test(body)) continue;
    hits++;
    // A handful of examples, not every hit: the editor shows them inline and the point
    // is "does this match what I think it matches", which three lines answer.
    if (samples.length < (opts.maxSamples ?? 3)) samples.push(body);
  }
  return { ok: true, error: null, hits, samples, lines: count };
}

/**
 * Rank tolerance — the one adaptation mechanical enough to offer.
 *
 * EverQuest Legends numbers its spell ranks where classic EverQuest did not, so a pattern
 * written for `You begin casting Harmony.` misses `You begin casting Harmony IV.`. That
 * form appears 5,095 times in the measured session, and the change needed is exactly one
 * thing — an optional Roman numeral before whatever ends the pattern — with no judgement
 * about what the author meant. Every other near-miss in the corpus requires guessing at
 * intent, and belongs to the player editing their own trigger rather than to us
 * rewriting theirs.
 *
 * Returns null when the pattern already tolerates a suffix, or has nowhere to put one.
 */
export function rankTolerantPattern(source) {
  const text = String(source ?? '');
  if (!text) return null;
  const RANK = '(?: [IVXLCDM]+)?';
  if (text.includes(RANK)) return null;

  // Inserted before whatever closes the pattern, so `casting Harmony\.$` becomes
  // `casting Harmony(?: [IVXLCDM]+)?\.$` rather than gaining a suffix after the anchor.
  for (const tail of ['\\.$', '$', '\\.']) {
    if (text.endsWith(tail)) {
      return text.slice(0, -tail.length) + RANK + tail;
    }
  }
  // An unanchored pattern already matches a ranked line anywhere in the middle, so
  // there is nothing a rank allowance would add.
  return null;
}

function adapt(pattern, character) {
  const adapted = rankTolerantPattern(pattern);
  if (!adapted) return null;
  const { regex } = compileTemplate(adapted, character);
  return regex ? { pattern: adapted, regex } : null;
}

// ------------------------------------------------------------------- log reading

/**
 * Read the tail of a log as lines, yielding between chunks.
 *
 * latin1, never utf8 — EQ writes single-byte text and utf8 mangles accented mob names
 * (see CLAUDE.md). Note this is the OPPOSITE of a `.gtp`, which states its own encoding.
 *
 * The first line of the tail is dropped when the read did not start at byte zero: it is
 * almost certainly half a line, and half a line either fails to parse or — worse —
 * parses into something that was never in the log.
 *
 * @param {string} logPath
 * @param {{maxBytes?: number, onProgress?: (read: number, total: number) => void}} [opts]
 * @returns {Promise<{lines: string[], bytes: number, total: number, truncated: boolean}>}
 */
export async function readLogTail(logPath, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const stat = await fs.promises.stat(logPath);
  const total = stat.size;
  const start = Math.max(0, total - maxBytes);
  const truncated = start > 0;

  const handle = await fs.promises.open(logPath, 'r');
  let text = '';
  try {
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(1, total - start)));
    let position = start;
    while (position < total) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, total - position), position);
      if (bytesRead <= 0) break;
      text += buffer.subarray(0, bytesRead).toString('latin1');
      position += bytesRead;
      opts.onProgress?.(position - start, total - start);
      // The yield that makes this non-blocking. Without it the whole read is one
      // synchronous burst and the tailer misses lines while it runs.
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    await handle.close();
  }

  const lines = text.split(/\r?\n/);
  if (truncated) lines.shift();
  return { lines, bytes: total - start, total, truncated };
}

/**
 * The whole thing: read the player's log tail and report what a pack does against it.
 *
 * @param {object|object[]} packs
 * @param {string} logPath
 * @param {{character?: string, maxBytes?: number, rankTolerant?: boolean}} [opts]
 */
export async function dryRunLog(packs, logPath, opts = {}) {
  const tail = await readLogTail(logPath, opts);
  const report = dryRun(packs, tail.lines, opts);
  return {
    ...report,
    // Stated so the report can say "in the last N lines" rather than implying the file.
    bytes: tail.bytes,
    total: tail.total,
    truncated: tail.truncated,
  };
}
