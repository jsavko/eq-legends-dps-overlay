/**
 * Persistent encounter history: one JSONL file per character, one record per line.
 *
 * Deliberately NOT SQLite. The data volume never justifies it — a heavy raid night is
 * ~100 encounters at a few KB each, so a whole year filters instantly in memory — and a
 * native module is precisely the wrong dependency for this project's two-worlds build
 * (Windows npm + Electron ABI + a second Linux build for the WSL test suite). Should
 * the data ever outgrow this, the store interface is the seam to swap behind.
 *
 * Append-only by design: a crash can at worst tear the final line, and readers skip
 * any line that does not parse as JSON rather than declaring the file corrupt.
 *
 * Like ConfigStore, the directory arrives as a constructor argument so the store can
 * be unit-tested against a temp dir with no Electron present.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The record schema version, bumped if the shape ever changes incompatibly. */
export const RECORD_VERSION = 1;

/** "Rhale", "oggok" -> "Rhale_oggok" — the per-character file key. */
export function storeKey(character, server) {
  const clean = (s) => String(s ?? 'unknown').replace(/[^A-Za-z0-9-]/g, '_');
  return `${clean(character)}_${clean(server)}`;
}

export class EncounterStore {
  /** @param {string} dir directory to hold the .jsonl files */
  constructor(dir) {
    this.dir = dir;
  }

  fileFor(key) {
    return path.join(this.dir, `${key}.jsonl`);
  }

  /**
   * Append one encounter record. The record carries its own character/server, so the
   * store never has to be told separately which fight belongs to whom — a mid-session
   * character switch just starts filling a different file.
   */
  append(record) {
    const key = storeKey(record.character, record.server);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.fileFor(key), JSON.stringify(record) + '\n', 'utf8');
    return key;
  }

  /** Every record in a character's file, oldest first. Torn/garbage lines are skipped. */
  records(key) {
    let raw;
    try {
      raw = fs.readFileSync(this.fileFor(key), 'utf8');
    } catch {
      return [];   // no history yet is not an error
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A torn final line from a crash mid-append, or hand-editing damage. The rest
        // of the file is intact; losing one record beats refusing to load any.
      }
    }
    return out;
  }

  /**
   * Lightweight listing for the history browser, newest first. Derived from the full
   * records on every call rather than kept as a second index file — at this volume the
   * derivation is milliseconds, and one file per character means one source of truth.
   */
  list(key) {
    return this.records(key)
      .map((r) => {
        const rows = r.snapshot?.rows ?? [];
        const self = rows.find((row) => row.name === r.character) ?? null;
        return {
          id: r.id,
          label: r.label,
          zone: r.zone,
          startTs: r.startTs,
          durationMs: r.durationMs,
          closeReason: r.closeReason,
          members: rows.length,
          totalDamage: r.snapshot?.totalDamage ?? 0,
          groupDps: r.snapshot?.groupDps ?? 0,
          totalDamageTaken: r.snapshot?.totalDamageTaken ?? 0,
          deaths: (r.snapshot?.deaths ?? []).filter((d) => !d.isPet).length,
          self: self && {
            dps: self.dps,
            damage: self.damage,
            damageTaken: self.damageTaken ?? 0,
            deaths: self.deaths ?? 0,
          },
        };
      })
      .sort((a, b) => b.startTs - a.startTs);
  }

  /** @returns {Object|null} the full record, breakdowns and all */
  get(key, id) {
    return this.records(key).find((r) => r.id === id) ?? null;
  }

  /** Delete a character's history file. Irreversible, so the UI confirms first. */
  clear(key) {
    try {
      fs.unlinkSync(this.fileFor(key));
      return true;
    } catch {
      return false;
    }
  }

  /** The characters with history on disk, from the filenames alone. */
  characters() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => {
        const key = n.slice(0, -'.jsonl'.length);
        const sep = key.indexOf('_');
        return {
          key,
          character: sep === -1 ? key : key.slice(0, sep),
          server: sep === -1 ? null : key.slice(sep + 1),
        };
      });
  }
}
