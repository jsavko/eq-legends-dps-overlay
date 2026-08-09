/**
 * Persistent play sessions: one JSONL file per character, one record per line.
 *
 * Construction copied deliberately from `history.js` — append-only, directory injected so
 * it unit-tests against a temp dir with no Electron present, torn lines skipped rather
 * than declaring the file corrupt, and emphatically not SQLite. The reasoning there
 * applies here with more force, not less: a heavy month is thirty session records, and a
 * native module is still exactly the wrong dependency for this project's two-worlds build.
 *
 * The one thing this store has that the encounter store does not is a CHECKPOINT. An
 * encounter is seconds long, so losing the one in flight to a crash costs a pull. A
 * session is hours long, and a crash at hour four with no checkpoint costs the whole
 * night — which is the difference between a feature that records your play and one that
 * records your play unless something goes wrong, and nobody wants the second.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The record schema version, bumped if the shape ever changes incompatibly. */
export const SESSION_RECORD_VERSION = 1;

/** How often the in-flight session is written to its checkpoint file. */
export const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;

/** "Rhale", "oggok" -> "Rhale_oggok" — the per-character file key. */
export function sessionKey(character, server) {
  const clean = (s) => String(s ?? 'unknown').replace(/[^A-Za-z0-9-]/g, '_');
  return `${clean(character)}_${clean(server)}`;
}

/**
 * Zone visits -> distinct zone names, most time spent first.
 *
 * Revisits are folded together: walking back through the same zone four times is one
 * place, and listing it four times would push the actual camp off the end of the line.
 */
function dedupeZones(visits) {
  const total = new Map();
  for (const v of visits) total.set(v.zone, (total.get(v.zone) ?? 0) + (v.ms ?? 0));
  return [...total.entries()].sort((a, b) => b[1] - a[1]).map(([zone]) => zone);
}

/**
 * One full record -> the compact row the session browser's rail draws.
 *
 * Exported and pure because two callers need it and they must not diverge: `list()` maps
 * the records on disk, and the SESSION_LIST handler maps the checkpoint of the session
 * still in flight so tonight appears in the rail alongside the nights that finished. If
 * that mapping existed twice, the live row and the stored row would carry different
 * fields, and the rail's filters and summary line would work on one and quietly not on the
 * other — the sort of difference nobody sees until the night ends and the row changes
 * shape under them.
 *
 * Every field is defaulted, because this is fed both a finished record and a checkpoint,
 * and an early checkpoint legitimately has categories that have not happened yet.
 */
export function listEntry(r) {
  return {
    id: r.id,
    character: r.character,
    server: r.server,
    startTs: r.startTs,
    endTs: r.endTs,
    durationMs: r.durationMs,
    closeReason: r.closeReason,
    kills: r.kills?.total ?? 0,
    deaths: (r.deaths ?? []).length,
    loot: r.loot?.total ?? 0,
    copperEarned: r.coin?.earned?.copperTotal ?? 0,
    netCopper: r.coin?.netCopper ?? 0,
    levelsGained: r.xp?.levelsGained ?? 0,
    aaEarned: r.aa?.earned ?? 0,
    zones: (r.zones ?? []).length,
    /**
     * The zones themselves, longest visit first and de-duplicated.
     *
     * Names rather than a count, because "Lower Guk, Upper Guk" is how a player
     * recognises which night they are looking for and "2 zones" is not. Longest
     * first rather than in visit order for the same reason: the camp is what the
     * night was, and the two-minute walk through Innothule Swamp is not.
     */
    zoneNames: dedupeZones(r.zones ?? []),
  };
}

export class SessionStore {
  /** @param {string} dir directory to hold the .jsonl and .current.json files */
  constructor(dir) {
    this.dir = dir;
  }

  fileFor(key) {
    return path.join(this.dir, `${key}.jsonl`);
  }

  checkpointFileFor(key) {
    return path.join(this.dir, `${key}.current.json`);
  }

  /**
   * Append one session record, unless one with that id is already there.
   *
   * Deduplication is not optional here the way it is for encounters. A session's id is its
   * start time, and the recovery path can legitimately try to write a session that was
   * already closed and written normally — a checkpoint that outlived a clean shutdown by
   * one crash, say. Re-reading the file to check costs nothing at thirty records a month
   * and turns a whole class of double-counting into a no-op.
   *
   * @returns {{key: string, written: boolean}}
   */
  append(record) {
    const key = sessionKey(record.character, record.server);
    if (this.records(key).some((r) => r.id === record.id)) return { key, written: false };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.fileFor(key), JSON.stringify(record) + '\n', 'utf8');
    return { key, written: true };
  }

  /** Every record in a character's file, oldest first. Torn/garbage lines are skipped. */
  records(key) {
    let raw;
    try {
      raw = fs.readFileSync(this.fileFor(key), 'utf8');
    } catch {
      return [];   // no sessions yet is not an error
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A torn final line from a crash mid-append. The rest of the file is intact;
        // losing one record beats refusing to load any.
      }
    }
    return out;
  }

  /**
   * Lightweight listing for the session browser, newest first.
   *
   * Derived on every call rather than kept as a second index file, exactly as
   * `history.js` does it: at this volume the derivation is microseconds, and one file per
   * character means one source of truth that cannot go stale.
   */
  list(key) {
    return this.records(key)
      .map(listEntry)
      .sort((a, b) => b.startTs - a.startTs);
  }

  /** @returns {Object|null} the full record, every category and all */
  get(key, id) {
    return this.records(key).find((r) => r.id === id) ?? null;
  }

  /** Delete a character's session file and any checkpoint beside it. Irreversible. */
  clear(key) {
    let ok = false;
    try {
      fs.unlinkSync(this.fileFor(key));
      ok = true;
    } catch {
      // Nothing to delete is the same outcome the caller wanted.
    }
    this.clearCheckpoint(key);
    return ok;
  }

  /** The characters with sessions on disk, from the filenames alone. */
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

  // ------------------------------------------------------------------------ checkpoint

  /**
   * Write the session in flight to its own file.
   *
   * Written to a temp path and renamed, because this file is overwritten every five
   * minutes for hours: a crash during a plain write leaves a half-file, and a half-file is
   * exactly what the recovery path would then be handed. `rename` is atomic on both
   * filesystems this app runs on, so the checkpoint is either the previous good one or the
   * new good one and never something in between.
   */
  saveCheckpoint(record) {
    const key = sessionKey(record.character, record.server);
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.checkpointFileFor(key);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record), 'utf8');
    fs.renameSync(temp, target);
    return key;
  }

  /** @returns {Object|null} the checkpoint for one character, or null */
  loadCheckpoint(key) {
    try {
      return JSON.parse(fs.readFileSync(this.checkpointFileFor(key), 'utf8'));
    } catch {
      // Absent is the normal case after a clean shutdown; unparseable means a crash caught
      // the rename, and the previous good checkpoint is gone either way. Neither is fatal.
      return null;
    }
  }

  clearCheckpoint(key) {
    try {
      fs.unlinkSync(this.checkpointFileFor(key));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Every checkpoint on disk — what launch has to deal with before anything else runs.
   *
   * Plural because the player may have crashed on one character and started the app on
   * another, and an orphaned checkpoint is worth recovering whoever it belongs to.
   */
  checkpoints() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.current.json')) continue;
      const key = n.slice(0, -'.current.json'.length);
      const record = this.loadCheckpoint(key);
      if (record) out.push({ key, record });
    }
    return out;
  }

  /**
   * Fold every orphaned checkpoint into the store as a finished session.
   *
   * A checkpoint that survived to the next launch means the app went down without closing
   * its session — a crash, a kill, a power cut. The night still happened, so it is written
   * with `closeReason: 'recovered'` rather than thrown away, and the label is honest: the
   * end time is the last event we ever saw, and the four minutes of play after the final
   * checkpoint are genuinely gone rather than being quietly invented.
   *
   * @returns {Array<{key: string, record: Object, written: boolean}>} what was recovered
   */
  recover() {
    const out = [];
    for (const { key, record } of this.checkpoints()) {
      const finished = { ...record, closeReason: 'recovered' };
      let written = false;
      try {
        written = this.append(finished).written;
      } catch {
        // A store that cannot be written must not stop the app from starting. The
        // checkpoint stays put and the next launch tries again.
        continue;
      }
      this.clearCheckpoint(key);
      out.push({ key, record: finished, written });
    }
    return out;
  }
}
