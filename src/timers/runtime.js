/**
 * The running countdowns: fed log lines, asked for rows.
 *
 * A sibling of the parser and of the trigger engine, and independent of both. It is fed
 * the same lines by main and knows nothing about encounters, packs or scoring.
 *
 * The rules it inherits from the boss-timer panel, because they were learned the hard
 * way and apply to any countdown on a screen:
 *
 *  - **A row never moves.** Slots are held in first-armed order and are never re-sorted
 *    by what is due next. Sorting by remaining time means the row you learned to glance
 *    at is somewhere else every second.
 *  - **A re-match restarts in place.** Recasting a buff refreshes it, so a second match
 *    resets THIS row rather than opening a second one beside it.
 *  - **A spent row lingers briefly** rather than blinking out, which reads as a glitch
 *    instead of as a timer finishing.
 *
 * Pure Node. No Electron, no filesystem — the store hands it a model and it runs it.
 */

import { compile, compileEnder } from './model.js';

/** How long a finished row stays on screen, spent, before it leaves. */
export const SPENT_LINGER_MS = 3000;

/** A pattern is suspect once one line costs it this long, and is dropped after enough
 *  of them. Only reachable by a regex timer, but a player CAN write a catastrophic one
 *  and it shares the line stream with the parser — a stall here stops the meter too. */
export const SLOW_MATCH_MS = 1;
export const STRIKES = 5;

export class TimersRuntime {
  constructor() {
    /** @type {Array<{timer, matcher, ender}>} */
    this.compiled = [];
    /** @type {Map<string, object>} live rows, in first-armed order (Map keeps it) */
    this.slots = new Map();
    /** @type {Map<string, {strikes: number, worstMs: number}>} */
    this.budget = new Map();
    /** @type {Set<string>} timer ids switched off for overrunning */
    this.disabled = new Set();
    /** Bumped whenever anything visible changes, so main can skip an unchanged push. */
    this.revision = 0;
    /** Categories, kept so rows can carry their box id and name. */
    this.categories = [];
  }

  /**
   * Replace the whole model and recompile.
   *
   * Wholesale rather than incremental: adding a timer, editing one and deleting one all
   * end here, and a diffing path would be three ways to get the same state slightly
   * wrong. Recompiling a few dozen matchers takes microseconds.
   */
  setModel(model) {
    this.categories = model?.categories ?? [];
    this.compiled = [];
    for (const timer of model?.timers ?? []) {
      if (!timer.enabled) continue;
      const matcher = compile(timer);
      if (!matcher) continue;
      this.compiled.push({ timer, matcher, ender: compileEnder(timer) });
    }
    this.budget.clear();
    this.disabled.clear();
    this.revision++;
  }

  /** One log line, timestamp already stripped. @returns {number} how many armed */
  feed(body, ts) {
    let fired = 0;
    this.expire(ts);

    for (const entry of this.compiled) {
      if (this.disabled.has(entry.timer.id)) continue;

      const started = performance.now();
      let hit = false;
      try {
        hit = entry.matcher.test(body);
      } catch {
        this.strike(entry.timer.id, Infinity);
        continue;
      }
      const elapsed = performance.now() - started;
      if (elapsed >= SLOW_MATCH_MS) this.strike(entry.timer.id, elapsed);
      if (!hit) continue;

      fired++;
      this.arm(entry, ts);
    }

    // Enders after the starters, so a line that both starts one timer and ends another
    // does both in the order a player would describe it.
    for (const entry of this.compiled) {
      if (!entry.ender) continue;
      const slot = this.slots.get(entry.timer.id);
      if (!slot || slot.done) continue;
      let hit = false;
      try {
        hit = entry.ender.test(body);
      } catch { hit = false; }
      if (!hit) continue;
      // Marked done rather than deleted, so the row survives to the end of its natural
      // life as a spent slot instead of vanishing from under the player's eyes.
      slot.done = true;
      slot.endedTs = ts;
      this.revision++;
    }
    return fired;
  }

  arm(entry, ts) {
    const { timer } = entry;
    const existing = this.slots.get(timer.id);
    if (existing) {
      // A refresh. Reset in place, and leave `since` alone so the row does not move.
      existing.startedTs = ts;
      existing.endTs = ts + timer.durationMs;
      existing.done = false;
      existing.endedTs = null;
      this.revision++;
      return;
    }
    this.slots.set(timer.id, {
      id: timer.id,
      categoryId: timer.categoryId,
      name: timer.name,
      color: timer.color,
      durationMs: timer.durationMs,
      startedTs: ts,
      endTs: ts + timer.durationMs,
      // The moment this slot was CLAIMED, and it never moves again.
      since: ts,
      done: false,
      endedTs: null,
      preview: false,
    });
    this.revision++;
  }

  /**
   * Put a row on screen that no log line asked for.
   *
   * The Preview button, and the reason it exists: a box draws nothing until something
   * fires, so without this the only way to see where a box sat or what a bar looked like
   * was to go and make the effect happen in game.
   */
  preview({ categoryId, name = 'Preview', durationMs = 45_000, color = null,
    key = '', remainingMs = null, ts = Date.now() }) {
    // Keyed per timer within the box, so previewing a box can put ALL of its timers on
    // screen at once rather than one stand-in row. `clearPreviews(categoryId)` still
    // takes the whole box down, because the key is prefixed with it.
    const id = `preview:${categoryId}:${key}`;
    const existing = this.slots.get(id);
    this.slots.set(id, {
      id,
      categoryId,
      name,
      color,
      durationMs,
      // A preview can start part-drained, so a box full of them shows bars at different
      // lengths — which is the point of looking at it: you are judging whether you can
      // read three bars at a glance, not one full one.
      startedTs: ts - (durationMs - (remainingMs ?? durationMs)),
      endTs: ts + (remainingMs ?? durationMs),
      since: existing?.since ?? ts,
      done: false,
      endedTs: null,
      preview: true,
    });
    this.revision++;
  }

  /**
   * Take preview rows off the screen.
   *
   * Scoped to one box when asked. "Hide it again" on one box clearing every box's
   * preview is not a smaller bug than it sounds: the player is comparing two boxes side
   * by side to decide where each goes, and one of them silently taking the other down is
   * the opposite of what the button says.
   *
   * @param {string} [categoryId] omit to clear every preview
   */
  clearPreviews(categoryId = null) {
    let removed = 0;
    for (const [id, slot] of this.slots) {
      if (!slot.preview) continue;
      if (categoryId && slot.categoryId !== categoryId) continue;
      this.slots.delete(id);
      removed++;
    }
    if (removed) this.revision++;
    return removed;
  }

  /** Drop what has outlived its window. */
  expire(now) {
    for (const [id, slot] of this.slots) {
      const finished = slot.done ? slot.endedTs : slot.endTs;
      if (now < finished + SPENT_LINGER_MS) continue;
      this.slots.delete(id);
      this.revision++;
    }
  }

  /**
   * Live rows, first-armed first and never re-sorted by what is due next.
   *
   * `remainingMs` is computed here so the renderer needs no notion of log time.
   */
  rows(now) {
    const out = [];
    for (const slot of this.slots.values()) {
      const spent = slot.done || now >= slot.endTs;
      out.push({
        id: slot.id,
        categoryId: slot.categoryId,
        name: slot.name,
        color: slot.color,
        durationMs: slot.durationMs,
        remainingMs: spent ? 0 : Math.max(0, slot.endTs - now),
        spent,
        since: slot.since,
        preview: slot.preview,
      });
    }
    return out.sort((a, b) => a.since - b.since);
  }

  get live() {
    return this.slots.size > 0;
  }

  tick(now = Date.now()) {
    this.expire(now);
  }

  /** Everything a fight-scoped reset should clear. Compilation survives. */
  reset() {
    this.slots.clear();
    this.revision++;
  }

  strike(id, elapsedMs) {
    const state = this.budget.get(id) ?? { strikes: 0, worstMs: 0 };
    state.strikes++;
    state.worstMs = Math.max(state.worstMs, Number.isFinite(elapsedMs) ? elapsedMs : state.worstMs);
    this.budget.set(id, state);
    if (state.strikes >= STRIKES && !this.disabled.has(id)) {
      this.disabled.add(id);
      this.revision++;
    }
  }

  /** Timers that are not running, and why — for the manager to name them. */
  problems() {
    return [...this.disabled].map((id) => ({
      id,
      name: this.compiled.find((c) => c.timer.id === id)?.timer.name ?? id,
      reason: `took ${this.budget.get(id)?.worstMs.toFixed(1) ?? '?'}ms on a single line`,
    }));
  }
}
