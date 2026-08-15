/**
 * The trigger runtime: a sibling of the parser, not a part of it.
 *
 * Main feeds every tailed line to BOTH `parser.feed` and `engine.feed`. That duplication
 * is the whole design, and it is deliberate. The alternative — folding user triggers into
 * `rules.js`'s ordered table — would put arbitrary regexes downloaded from a guild
 * Discord inside the pipeline that decides who did the damage: a pack could shadow a
 * combat rule, and a catastrophically backtracking pattern would stall the tailer and
 * take the DPS meter, the history and the learned timers down with it. Here the blast
 * radius of a bad pack is triggers, and nothing else.
 *
 * Everything is pure Node — the one import outside `src/triggers/` is the parser's
 * `parseTimestamp`, which is a pure function and is shared rather than duplicated so
 * both halves of the app agree to the second about what time a line happened.
 *
 * ## What it produces
 *
 * Two shapes, both of which the app already draws:
 *   - `warnings(now)` → chips for the alerts window, carrying `category: 'trigger'`
 *   - `timers(now)`   → countdown rows for the boss-timers window, `source: 'trigger'`
 *
 * ## The rules the timers panel imposes
 *
 * A boss-timer row never moves. Slots are claimed in first-armed order, held through
 * every state they can reach, and never re-sorted by what is due next — sorting by
 * `dueMs` is the exact bug that window was built to replace. Trigger rows obey the same
 * rule and carry `since` so main can merge them with the parser's learned rows into one
 * globally first-armed-first list.
 *
 * ## Safety
 *
 * A raid pushes hundreds of lines a second past what may be hundreds of patterns:
 *   - every pattern is compiled ONCE, at pack load and on character switch;
 *   - a literal prefilter (`String.includes`) runs before the regex, which measured out
 *     at 365,000 lines/second against a live rate under 100;
 *   - a per-trigger time budget disables a pattern that repeatedly overruns, and names
 *     it, rather than letting it stall the tailer. Isolation alone is not enough here:
 *     a stalled engine still stops the line stream it shares with the parser.
 */

import { parseTimestamp } from '../parser/timestamp.js';
import { compilePack } from './pack.js';
import { renderTemplate, renderPattern, compileTemplate } from './tokens.js';

/** How long a trigger chip stays up. Matches the parser's own cast-warning window. */
export const TRIGGER_WARN_TTL_MS = 8000;

/**
 * A pattern is suspect once one line costs it this long.
 *
 * Generous by three orders of magnitude: a healthy regex over a log line is measured in
 * microseconds, so anything at a millisecond is already backtracking. The threshold is
 * not the defence on its own — see STRIKES.
 */
export const SLOW_MATCH_MS = 1;

/**
 * ...and it is disabled after this many slow lines.
 *
 * Strikes rather than a single overrun because the first call into a regex may be slow
 * for reasons that are not the regex's fault — JIT warm-up, a GC pause landing on it,
 * the machine being busy. A pattern that is genuinely pathological hits the threshold on
 * nearly every line it sees, so it reaches five strikes almost immediately, while a
 * healthy one never accumulates them.
 */
export const STRIKES = 5;

/**
 * How long a finished slot stays on screen, lapsed, before its row leaves.
 *
 * A row that vanishes the instant its countdown reaches zero reads as a glitch rather
 * than as a timer finishing — the same reasoning behind the alert chips' fade-out.
 */
export const SPENT_LINGER_MS = 3000;

/**
 * Trigger chips share the alerts stack with the parser's own warnings, and the renderer
 * keys chip ELEMENTS by id — so an id issued by both would make one chip reuse the
 * other's element and show the wrong text. Starting a billion above anything the parser
 * will issue in a session keeps them numeric (the stack sorts on id within a tier) and
 * keeps them apart.
 */
export const WARNING_ID_BASE = 1_000_000_000;

export class TriggerEngine {
  constructor(options = {}) {
    /** @type {object[]} normalized packs, as handed over by the store */
    this.packs = [];
    this.character = options.character ?? null;

    /** @type {Array<object>} compiled triggers, rebuilt on every setPacks/setCharacter */
    this.compiled = [];
    /** @type {Array<{packId, packName, id, name, error}>} patterns that would not compile */
    this.failed = [];
    /** @type {Map<string, {strikes: number, worstMs: number}>} slow-pattern bookkeeping */
    this.budget = new Map();
    /** @type {Set<string>} keys of triggers disabled for overrunning the budget */
    this.disabled = new Set();

    /** @type {Array<object>} live warning chips, oldest first */
    this.warningList = [];
    /** @type {Map<string, object>} live timer slots, in first-armed order (Map keeps it) */
    this.slots = new Map();

    this.nextWarningId = WARNING_ID_BASE + 1;
    /** Bumped whenever anything visible changes, so main can skip an unchanged push. */
    this.revision = 0;

    /**
     * How long a chip this engine raises stays up, in ms. Instance state for the same
     * reason the parser's alertTtls is: the Durations dialog can retune a running
     * session, and the exported constant stays the default so nothing changes for a
     * caller that never passes the option. Stamped per warning at fire time, so a
     * change applies from the next chip — never under one already being read.
     */
    this.warnTtlMs = options.warnTtlMs ?? TRIGGER_WARN_TTL_MS;
  }

  /** Retune the chip lifetime at runtime. Chips already up keep their stamped ttlMs. */
  setWarnTtl(ms) {
    if (Number.isFinite(ms) && ms > 0) this.warnTtlMs = ms;
  }

  /**
   * Replace the pack set and recompile.
   *
   * Wholesale rather than incremental: enabling one pack, editing one trigger and
   * importing a new one all end here, and a diffing path would be three ways to get the
   * same state slightly wrong. Recompiling a few hundred regexes takes microseconds and
   * happens only when the player touches a setting.
   */
  setPacks(packs) {
    this.packs = Array.isArray(packs) ? packs : [];
    this.recompile();
  }

  /**
   * The character changed — the tailer followed the player to an alt.
   *
   * Every `{C}` in every pattern has to be resubstituted, which is exactly why the token
   * survives into the stored pattern instead of being baked in at import.
   */
  setCharacter(character) {
    if (this.character === character) return;
    this.character = character ?? null;
    this.recompile();
  }

  recompile() {
    this.compiled = [];
    this.failed = [];
    for (const pack of this.packs) {
      const { compiled, failed } = compilePack(pack, this.character);
      this.compiled.push(...compiled);
      for (const f of failed) this.failed.push({ packId: pack.id, packName: pack.name, ...f });
    }
    // Strikes are dropped on recompile: the pattern may have been edited, and holding a
    // disablement against a regex the player has since fixed would be unexplainable.
    this.budget.clear();
    this.disabled.clear();
    this.revision++;
  }

  /**
   * Feed one raw log line.
   *
   * The timestamp is stripped before matching, because GINA patterns are written against
   * the line BODY — `^You have slain (.+)$` anchors to the start of the text, not to the
   * `[Fri Jul 31 18:31:35 2026]` in front of it.
   *
   * @param {string} line
   * @returns {number} how many triggers fired on this line
   */
  feed(line) {
    const parsed = parseTimestamp(line);
    if (!parsed) return 0;
    return this.feedBody(parsed.body, parsed.ts);
  }

  /** The same, for a caller that has already split the line (the dry-run replay). */
  feedBody(body, ts) {
    let fired = 0;
    this.expire(ts);

    for (const entry of this.compiled) {
      const key = `${entry.packId}/${entry.trigger.id}`;
      if (this.disabled.has(key)) continue;

      // The cheap precondition first: a `String.includes` of a literal the pattern
      // requires. Sound by construction (see literalPrefilter) — it can never reject a
      // line the regex would have matched.
      if (entry.prefilter && !entry.prefilter.some((literal) => body.includes(literal))) continue;

      const started = performance.now();
      let match = null;
      try {
        match = entry.regex.exec(body);
      } catch {
        // A regex that throws mid-match (stack overflow on a pathological pattern) is
        // exactly what the budget is for; treat it as the worst possible overrun.
        this.strike(key, entry, Infinity);
        continue;
      }
      const elapsed = performance.now() - started;
      if (elapsed >= SLOW_MATCH_MS) this.strike(key, entry, elapsed);

      if (!match) continue;
      fired++;
      this.fire(entry, match, ts);
    }

    // Early enders are checked AFTER the triggers, so a line that both arms a timer and
    // ends an older one does both in the order the player would describe.
    this.checkEarlyEnders(body, ts);
    return fired;
  }

  /** One trigger matched: raise its chip, arm its timer, or both. */
  fire(entry, match, ts) {
    const { trigger, packName } = entry;

    if (trigger.warn) {
      const text = renderTemplate(trigger.warn.text, match, this.character);
      // An empty render is a chip with nothing on it — which happens when a template is
      // nothing but an unmatched group reference. Nothing to show is not a warning.
      if (text.trim()) {
        this.warningList.push({
          id: this.nextWarningId++,
          category: 'trigger',
          tier: trigger.warn.tier,
          group: trigger.warn.group,
          text,
          pack: packName,
          trigger: trigger.name,
          ts,
          ttlMs: this.warnTtlMs,
        });
        this.revision++;
      }
    }

    if (trigger.timer) this.armTimer(entry, match, ts);
  }

  /**
   * Arm (or re-arm) a timer slot.
   *
   * The slot is keyed by the RENDERED timer name, which is how a per-mob respawn timer
   * distinguishes one mob from another: `${mob}` renders to "a Mistmoore guard" for one
   * kill and "Xicotl" for the next, and those are two countdowns, not one being reset.
   * A trigger whose name renders to a constant gets one slot and restarts it, which is
   * equally what its author meant.
   */
  armTimer(entry, match, ts) {
    const { trigger, packId, packName } = entry;
    const timer = trigger.timer;
    const label = renderTemplate(timer.name, match, this.character) || trigger.name;
    const key = `${packId}/${trigger.id}/${label}`;

    const existing = this.slots.get(key);
    if (existing && !existing.done) {
      // `DoNothingIfRunning`: a second sighting while the countdown runs is not news.
      if (timer.restart === 'ignore') return;
      // `StartNewTimer` and `RestartTimer` both restart THIS slot. GINA's difference
      // between them is whether a second concurrent countdown appears, and a second row
      // for the same label is precisely what the never-move rule forbids — it would push
      // every row below it down. The slot is reset in place instead, and `since` is
      // untouched so the row does not move.
      existing.startedTs = ts;
      existing.endTs = ts + timer.durationMs;
      existing.match = match;
      this.compileEnders(existing, entry, match);
      this.revision++;
      return;
    }

    this.slots.set(key, {
      key,
      packId,
      packName,
      triggerId: trigger.id,
      triggerName: trigger.name,
      label,
      kind: timer.kind,
      durationMs: timer.durationMs,
      endingMs: timer.endingMs,
      endingText: timer.endingText,
      startedTs: ts,
      endTs: ts + timer.durationMs,
      // The moment this slot was CLAIMED, and it never moves again — the same rule the
      // parser's learned rows follow, so the two can merge into one ordered list.
      since: existing?.since ?? ts,
      done: false,
      match,
      enders: [],
    });
    this.compileEnders(this.slots.get(key), entry, match);
    this.revision++;
  }

  /**
   * Resolve an armed slot's early-end patterns.
   *
   * Those naming no capture were compiled once at pack load; the rest name the arming
   * match (`${mob} is no longer slowed`) and can only be built now that a match exists.
   * There are a handful of live slots at most, so compiling per arm is free.
   */
  compileEnders(slot, entry, match) {
    slot.enders = entry.enders.map((e) => {
      if (e.regex) return e.regex;
      const { regex } = compileTemplate(renderPattern(e.pattern, match), this.character);
      return regex;
    }).filter(Boolean);
  }

  /** A line that ends a running countdown early — how a respawn timer dies on a reset. */
  checkEarlyEnders(body, ts) {
    for (const slot of this.slots.values()) {
      if (slot.done || !slot.enders.length) continue;
      if (!slot.enders.some((regex) => regex.test(body))) continue;
      // Marked done rather than deleted, so the row survives to the end of its natural
      // life as a spent slot instead of vanishing from under the player's eyes.
      slot.done = true;
      slot.endedTs = ts;
      this.revision++;
    }
  }

  /**
   * Drop what has outlived its window.
   *
   * A spent slot lingers briefly so the panel can show it lapse rather than blink out,
   * on the same reasoning as the alerts' fade: a row that disappears the instant it
   * completes reads as a glitch, not as a countdown finishing.
   */
  expire(now) {
    const before = this.warningList.length;
    this.warningList = this.warningList.filter((w) => now - w.ts < w.ttlMs);
    if (this.warningList.length !== before) this.revision++;

    for (const [key, slot] of this.slots) {
      const finished = slot.done ? slot.endedTs : slot.endTs;
      if (now < finished + SPENT_LINGER_MS) continue;
      // A repeating timer re-arms itself instead of leaving — that is what its author
      // asked for and what the player chose to import. It keeps its slot, so nothing
      // above or below it moves.
      if (slot.kind === 'repeating' && !slot.done) {
        slot.startedTs = slot.endTs;
        slot.endTs = slot.endTs + slot.durationMs;
        this.revision++;
        continue;
      }
      this.slots.delete(key);
      this.revision++;
    }
  }

  /**
   * Live warning chips, in the shape the alerts renderer consumes.
   *
   * `remainingMs` is computed here so the renderer needs no notion of log time — the
   * same contract the parser's own `hostileCasts` follow.
   */
  warnings(now) {
    return this.warningList.map((w) => ({
      id: w.id,
      category: 'trigger',
      tier: w.tier,
      group: w.group,
      text: w.text,
      pack: w.pack,
      trigger: w.trigger,
      remainingMs: Math.min(w.ttlMs, Math.max(0, w.ttlMs - (now - w.ts))),
    }));
  }

  /**
   * Live countdown rows, first-armed first and never re-sorted by what is due next.
   *
   * The shape mirrors the parser's learned rows closely enough that main can merge the
   * two lists on `since` and the renderer paints both — with `source` as the one field
   * that says which kind of claim a row is making. An imported duration is EXACT (its
   * author wrote it down) where a learned one is an estimate with a spread, and the
   * panel must not flatten that difference into one number.
   */
  timers(now) {
    const out = [];
    for (const slot of this.slots.values()) {
      const spent = slot.done || now >= slot.endTs;
      const dueMs = spent ? null : Math.max(0, slot.endTs - now);
      out.push({
        source: 'trigger',
        key: slot.key,
        // The panel's sub-line names where a row came from. For a learned row that is
        // the boss; for an imported one it is the pack, which is the honest answer to
        // "why is this on my screen".
        caster: slot.packName,
        ability: slot.label,
        dueMs,
        intervalMs: slot.durationMs,
        spreadMs: null,
        warm: false,
        since: slot.since,
        state: spent ? 'lapsed' : 'armed',
        // Inside the author's "ending soon" window, if they set one.
        ending: Boolean(!spent && slot.endingMs && dueMs !== null && dueMs <= slot.endingMs),
        endingText: slot.endingText,
        pack: slot.packName,
        trigger: slot.triggerName,
      });
    }
    return out.sort((a, b) => a.since - b.since);
  }

  /** True while any row is on screen — the timers window exists out of combat only
   *  for these, since a GINA countdown is frequently a between-fights thing. */
  get hasTimers() {
    return this.slots.size > 0;
  }

  /** True while anything is on screen at all, so main can tell a live push from a
   *  skippable one during a lull. */
  get live() {
    return this.slots.size > 0 || this.warningList.length > 0;
  }

  /**
   * Advance the clock with no line to advance it.
   *
   * The push loop calls this for the same reason it calls `parser.tick()`: during a lull
   * no log lines arrive, and without it a chip raised just before the pull ended would
   * sit on screen until the next line — which can be minutes.
   */
  tick(now = Date.now()) {
    this.expire(now);
  }

  /** Patterns that are not running, and why — for the settings screen to name them. */
  problems() {
    return [
      ...this.failed.map((f) => ({ ...f, reason: 'pattern' })),
      ...[...this.disabled].map((key) => {
        const entry = this.compiled.find((c) => `${c.packId}/${c.trigger.id}` === key);
        const budget = this.budget.get(key);
        return {
          packId: entry?.packId ?? null,
          packName: entry?.packName ?? null,
          id: entry?.trigger.id ?? key,
          name: entry?.trigger.name ?? key,
          error: `took ${budget?.worstMs.toFixed(1) ?? '?'}ms on a single line`,
          reason: 'slow',
        };
      }),
    ];
  }

  /** Everything a fight-scoped reset should clear. Packs and compilation survive. */
  reset() {
    this.warningList = [];
    this.slots.clear();
    this.revision++;
  }

  /**
   * Record a slow match, and disable the pattern once it has done it enough times.
   *
   * The trigger is switched off in MEMORY only — the pack file is untouched, so a
   * restart gives it another chance and the player's own choice about the trigger is
   * never overwritten by a machine that happened to be busy.
   */
  strike(key, entry, elapsedMs) {
    const state = this.budget.get(key) ?? { strikes: 0, worstMs: 0 };
    state.strikes++;
    state.worstMs = Math.max(state.worstMs, Number.isFinite(elapsedMs) ? elapsedMs : state.worstMs);
    this.budget.set(key, state);
    if (state.strikes >= STRIKES && !this.disabled.has(key)) {
      this.disabled.add(key);
      this.revision++;
    }
  }
}
