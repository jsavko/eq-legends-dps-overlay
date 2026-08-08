/**
 * Persistent trigger packs: one JSON file per pack under `<userData>/triggers/`.
 *
 * Same construction rules as `EncounterStore` and `RhythmStore` — the directory arrives
 * as a constructor argument, so this unit-tests against a temp dir with no Electron
 * present, and it is plain JSON because a native module is exactly the wrong dependency
 * for the two-worlds build (see CLAUDE.md).
 *
 * One file per pack rather than one file holding all of them, for two reasons that both
 * come down to blast radius: a pack imported from a stranger's Discord is the thing most
 * likely to be malformed, and a single combined file would let one bad pack take every
 * other pack down with it. Removing a pack is also then an unlink rather than a
 * read-modify-write, which cannot half-succeed.
 *
 * `enabled` lives in the pack file rather than in config.json on purpose. It is a
 * property OF the pack — the same switch GINA's own `EnableByDefault` sets — and keeping
 * it beside the triggers means importing, exporting and removing a pack never has to
 * reach into a second store to stay consistent.
 */

import fs from 'node:fs';
import path from 'node:path';

import { normalize, validate, packStats, MY_TRIGGERS_ID, myTriggersPack } from '../triggers/pack.js';

export class TriggerStore {
  /** @param {string} dir directory to hold the pack .json files */
  constructor(dir) {
    this.dir = dir;
  }

  fileFor(id) {
    return path.join(this.dir, `${safeId(id)}.json`);
  }

  /**
   * Every pack on disk, by filename order.
   *
   * A file that will not parse is SKIPPED rather than thrown over: the same posture the
   * history store takes, and for the same reason — one corrupt pack must not stand
   * between the player and the rest of their triggers, or between them and the overlay.
   * `problems` names what was skipped so the settings screen can say so.
   *
   * @returns {{packs: object[], problems: Array<{file: string, error: string}>}}
   */
  loadAll() {
    let names;
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return { packs: [], problems: [] };   // no triggers yet is not an error
    }

    const packs = [];
    const problems = [];
    for (const name of names) {
      try {
        packs.push(normalize(JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'))));
      } catch (err) {
        problems.push({ file: name, error: err.message });
      }
    }
    return { packs, problems };
  }

  /** One pack by id, or null. */
  get(id) {
    try {
      return normalize(JSON.parse(fs.readFileSync(this.fileFor(id), 'utf8')));
    } catch {
      return null;
    }
  }

  /**
   * Write a pack, refusing one that would not load again.
   *
   * Validation happens on the way IN rather than on the way out, because a pack that
   * fails to validate has to be reported while the player is still looking at the import
   * screen — discovering it at the next launch, as a pack that silently does nothing, is
   * exactly the failure mode this feature is built to avoid.
   *
   * @returns {{ok: true, pack: object}|{ok: false, errors: string[]}}
   */
  save(input) {
    const pack = normalize(input);
    const check = validate(pack);
    if (!check.ok) return { ok: false, errors: check.errors };

    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.fileFor(pack.id), JSON.stringify(pack, null, 2), 'utf8');
    return { ok: true, pack };
  }

  /**
   * Import under an id that is free, so a second copy of a pack never silently replaces
   * the first. Two packs from different guilds may genuinely share a name.
   */
  add(input) {
    const pack = normalize(input);
    return this.save({ ...pack, id: this.freeId(pack.id) });
  }

  remove(id) {
    try {
      fs.unlinkSync(this.fileFor(id));
      return true;
    } catch {
      return false;   // already gone is the state the caller wanted
    }
  }

  /** Flip a pack's switch without rewriting anything else about it. */
  setEnabled(id, enabled) {
    const pack = this.get(id);
    if (!pack) return null;
    const next = { ...pack, enabled: Boolean(enabled) };
    return this.save(next).ok ? next : null;
  }

  /** Flip one GROUP inside a pack — how a GINA pack shipped EnableByDefault=False
   *  gets switched on a group at a time, which is how its author meant it to be used. */
  setGroupEnabled(id, groupId, enabled) {
    const pack = this.get(id);
    if (!pack) return null;
    const groups = pack.groups.map((g) => (g.id === groupId ? { ...g, enabled: Boolean(enabled) } : g));
    const next = { ...pack, groups };
    return this.save(next).ok ? next : null;
  }

  /** Flip one trigger inside a pack. */
  setTriggerEnabled(id, triggerId, enabled) {
    const pack = this.get(id);
    if (!pack) return null;
    const triggers = pack.triggers.map((t) => (t.id === triggerId ? { ...t, enabled: Boolean(enabled) } : t));
    const next = { ...pack, triggers };
    return this.save(next).ok ? next : null;
  }

  /**
   * The pack authored triggers go into, created on first use.
   *
   * Kept separate from every imported pack so the player's own work is never mixed into
   * someone else's — which matters the moment that pack is removed, re-imported, or
   * exported back out with an attribution it no longer deserves.
   */
  myTriggers() {
    return this.get(MY_TRIGGERS_ID) ?? myTriggersPack();
  }

  /** What the settings list shows: each pack, with the counts that make it legible. */
  summary() {
    const { packs, problems } = this.loadAll();
    return {
      packs: packs.map((pack) => ({
        id: pack.id,
        name: pack.name,
        origin: pack.origin,
        edited: pack.edited,
        enabled: pack.enabled,
        comments: pack.comments,
        ...packStats(pack),
      })),
      problems,
    };
  }

  /** Every pack the engine should be matching with right now. */
  enabledPacks() {
    return this.loadAll().packs.filter((p) => p.enabled);
  }

  /** `name`, `name-2`, `name-3`… — the first that is not already a file. */
  freeId(id) {
    const base = safeId(id);
    if (!fs.existsSync(this.fileFor(base))) return base;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base}-${n}`;
      if (!fs.existsSync(this.fileFor(candidate))) return candidate;
    }
    throw new Error(`cannot find a free id for "${id}"`);
  }
}

/**
 * A pack id that is safe as a filename.
 *
 * The id comes from a pack NAME chosen by a stranger, so it reaches the filesystem
 * untrusted: `../../config` is a name someone could give a pack, and this is the only
 * place standing between that and a write outside the triggers directory.
 */
function safeId(id) {
  const clean = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  return clean.slice(0, 80) || 'pack';
}
