/**
 * Persistent boss-rhythm memory: what previous fights taught about a named caster's
 * recast intervals, so the next pull's timers arm from the first cast instead of the
 * third. One JSON file per server — a boss name means nothing across servers.
 *
 * Same construction rules as the history store: the directory is injected so this
 * unit-tests against a temp dir with no Electron present, and it is JSON rather than
 * SQLite because a native module is exactly the wrong dependency for the two-worlds
 * build. Volume is trivial — a few hundred (boss, spell) pairs at most.
 *
 * Merging pools by sample count, and the count is CAPPED: an estimate backed by
 * fifty gaps is not meaningfully surer than one backed by thirty, but an uncapped
 * count would make an old rhythm immovable — a patched boss would take months of
 * fights to re-learn. The cap keeps every new fight's evidence worth something.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Pooled sample cap per (boss, spell) — see the header for why it exists. */
export const SAMPLE_CAP = 30;

const key = (caster, ability) => `${caster}|${ability}`;

export class RhythmStore {
  /** @param {string} dir directory for per-server files (Electron's userData/rhythms) */
  constructor(dir) {
    this.dir = dir;
  }

  file(server) {
    return path.join(this.dir, `${server ?? 'unknown'}.json`);
  }

  /** @returns {Record<string, {caster, ability, intervalMs, spreadMs, samples, lastSeen}>} */
  load(server) {
    try {
      return JSON.parse(fs.readFileSync(this.file(server), 'utf8'));
    } catch {
      // Missing or corrupt is not an error: the empty memory is the answer, and a
      // corrupt file is overwritten by the next merge rather than blocking timers.
      return {};
    }
  }

  /** The shape the parser's setKnownRhythms wants. */
  knownFor(server) {
    return Object.values(this.load(server));
  }

  /**
   * Pool a closing fight's qualified rhythms into the store.
   * @param {string|null} server
   * @param {Array<{caster, ability, intervalMs, spreadMs, samples}>} learned
   * @param {number} ts   when this fight ended (drives lastSeen)
   */
  merge(server, learned, ts) {
    if (!learned?.length) return;
    const data = this.load(server);

    for (const r of learned) {
      const k = key(r.caster, r.ability);
      const prev = data[k];
      if (!prev) {
        data[k] = { ...r, samples: Math.min(r.samples, SAMPLE_CAP), lastSeen: ts };
        continue;
      }
      const total = prev.samples + r.samples;
      data[k] = {
        caster: r.caster,
        ability: r.ability,
        intervalMs: Math.round((prev.intervalMs * prev.samples + r.intervalMs * r.samples) / total),
        spreadMs: Math.round((prev.spreadMs * prev.samples + r.spreadMs * r.samples) / total),
        samples: Math.min(total, SAMPLE_CAP),
        lastSeen: ts,
      };
    }

    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(server), JSON.stringify(data, null, 2), 'utf8');
  }
}
