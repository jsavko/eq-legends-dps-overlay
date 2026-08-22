/**
 * Where the player's timer boxes and timers live: one JSON file, read and written whole.
 *
 * Deliberately NOT in `config.json`. The config is a flat bag of scalars merged one level
 * deep on load, and this is a document — two arrays of objects that reference each other.
 * A merge would repair a missing scalar and silently mangle a half-written category, and
 * the failure would be a box that exists but can never be closed or dragged.
 *
 * Whole-file writes rather than anything cleverer: the document is a few kilobytes and is
 * written when a person presses a button, never on the log stream.
 *
 * A write failure toasts rather than propagating, the same policy the history store has —
 * a full disk must not take the live overlay down.
 */

import fs from 'node:fs';
import path from 'node:path';

import { normalize, defaultModel } from '../timers/model.js';

export class TimersStore {
  /** @param {string} dir  injected, so this unit-tests against a temp dir */
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'timers.json');
  }

  /**
   * The whole document.
   *
   * A missing file is a fresh install and gets the defaults; an unreadable or corrupt one
   * ALSO gets the defaults rather than throwing, because the alternative is an overlay
   * that will not start over a file the player has never seen. What it must not do is
   * overwrite the bad file on the way past — that is the player's data, damaged, and
   * they may want it back.
   */
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const model = normalize(raw);
      // A document with no categories cannot draw anything and cannot be added to from
      // the manager's own rail, so it is not a usable state to leave somebody in.
      return model.categories.length ? model : defaultModel();
    } catch {
      return defaultModel();
    }
  }

  save(model) {
    const normalized = normalize(model);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      return { ok: true, model: normalized };
    } catch (err) {
      return { ok: false, errors: [err.message], model: normalized };
    }
  }
}
