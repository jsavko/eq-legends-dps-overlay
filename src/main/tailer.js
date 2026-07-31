/**
 * Polling tail for EverQuest log files.
 *
 * Polling rather than fs.watch: the game holds the file open and appends to it, and
 * fs.watch on Windows is unreliable for that pattern (missed events, no size delta).
 * An fstat every 200 ms costs nothing and is never wrong.
 *
 * Handles, in order of how often they actually happen:
 *   - growth            the normal case: read the new bytes
 *   - partial lines     a read can land mid-line; the tail is buffered until \n arrives
 *   - truncation        size < position, e.g. the player deleted or rotated the log
 *   - replacement       same path, different file (birthtime/inode changed)
 *   - character switch  a *different* eqlog_*.txt in the folder starts growing
 *
 * Emits: 'lines' (string[]), 'switch' ({from, to, character}), 'error', 'reset'.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseLogFilename } from '../parser/roster.js';

const DEFAULT_POLL_MS = 200;
/** On startup, read back this far so an encounter already in progress is picked up. */
const BACKFILL_BYTES = 64 * 1024;
/** How often to look for a different character's log becoming the active one. */
const DIR_SCAN_MS = 5000;
/** A rival log must have been written this recently to count as "active". */
const SWITCH_STALENESS_MS = 30_000;

export class Tailer extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.filePath        the eqlog_*.txt to follow
   * @param {number} [opts.pollMs]
   * @param {boolean} [opts.watchDirectory] auto-follow a character switch
   * @param {boolean} [opts.fromStart]    read the whole file instead of backfilling
   */
  constructor({ filePath, pollMs = DEFAULT_POLL_MS, watchDirectory = true, fromStart = false }) {
    super();
    this.filePath = filePath;
    this.pollMs = pollMs;
    this.watchDirectory = watchDirectory;
    this.fromStart = fromStart;

    this.position = 0;
    this.buffer = '';
    this.fileId = null;      // birthtimeMs + ino, to spot replacement
    this.running = false;
    this.pollTimer = null;
    this.dirTimer = null;
    this.polling = false;    // re-entrancy guard for the async poll
    /** Sizes from the previous directory scan; null until the baseline is taken. */
    this.dirSizes = null;
  }

  get character() {
    return parseLogFilename(this.filePath)?.character ?? null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.openAt(this.fromStart ? 0 : null);

    this.pollTimer = setInterval(() => { void this.poll(); }, this.pollMs);
    if (this.watchDirectory) {
      this.dirTimer = setInterval(() => { void this.scanForSwitch(); }, DIR_SCAN_MS);
    }
  }

  stop() {
    this.running = false;
    clearInterval(this.pollTimer);
    clearInterval(this.dirTimer);
    this.pollTimer = null;
    this.dirTimer = null;
  }

  /** Point the tailer at a different file, resetting all position state. */
  async switchTo(filePath, { fromStart = false } = {}) {
    const from = this.filePath;
    this.filePath = filePath;
    this.buffer = '';
    this.position = 0;
    this.fileId = null;
    await this.openAt(fromStart ? 0 : null);
    this.emit('switch', { from, to: filePath, character: this.character });
  }

  /**
   * Seed the read position.
   * @param {number|null} at 0 for the whole file, null to backfill from the end
   */
  async openAt(at) {
    try {
      const st = await fs.promises.stat(this.filePath);
      this.fileId = fileIdOf(st);
      if (at === 0) {
        this.position = 0;
      } else {
        // Backfill a little so a fight already underway is not missed, but start at a
        // line boundary — a mid-line start would feed the parser a corrupt first line.
        this.position = Math.max(0, st.size - BACKFILL_BYTES);
        if (this.position > 0) this.position = await this.alignToLineStart(this.position);
      }
      this.buffer = '';
      await this.poll();
    } catch (err) {
      this.emit('error', err);
    }
  }

  /** Advance a byte offset to just past the next newline. */
  async alignToLineStart(offset) {
    const handle = await fs.promises.open(this.filePath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
      return nl === -1 ? offset : offset + nl + 1;
    } finally {
      await handle.close();
    }
  }

  async poll() {
    if (!this.running || this.polling) return;
    this.polling = true;
    try {
      let st;
      try {
        st = await fs.promises.stat(this.filePath);
      } catch {
        return;   // the file vanished mid-session; keep polling for it to come back
      }

      const id = fileIdOf(st);
      if (this.fileId !== null && id !== this.fileId) {
        // Same path, different file — the log was rotated out from under us.
        this.fileId = id;
        this.position = 0;
        this.buffer = '';
        this.emit('reset', { reason: 'replaced' });
      } else if (st.size < this.position) {
        // The file shrank, so our offset points past the end.
        this.position = 0;
        this.buffer = '';
        this.emit('reset', { reason: 'truncated' });
      }

      if (st.size === this.position) return;

      const length = st.size - this.position;
      const handle = await fs.promises.open(this.filePath, 'r');
      let chunk;
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, this.position);
        // latin1, never utf8 — EQ writes single-byte text and utf8 mangles accented
        // mob names into replacement characters, which then never match a rule.
        chunk = buf.subarray(0, bytesRead).toString('latin1');
        this.position += bytesRead;
      } finally {
        await handle.close();
      }

      this.buffer += chunk;
      const lines = this.buffer.split(/\r?\n/);
      // The last element is whatever came after the final newline: either '' or a
      // partial line the game has not finished writing. Hold it for the next poll.
      this.buffer = lines.pop() ?? '';

      const complete = lines.filter((l) => l.length > 0);
      if (complete.length > 0) this.emit('lines', complete);
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Notice when the player logs in as a different character.
   *
   * The signal is GROWTH between two scans, not mtime. Two logs written in the same
   * millisecond get identical mtimes, and an mtime comparison then either ties (and
   * never switches) or flaps; "which file is the game appending to right now" is the
   * question actually being asked, and file size answers it directly.
   *
   * A rival must therefore: have grown since the last scan, be fresh in absolute terms,
   * and — decisively — our own log must have stopped growing. As long as the player is
   * still on this character, nothing can steal the tail.
   *
   * The first scan only records a baseline, so a switch takes two scans to detect.
   */
  async scanForSwitch() {
    if (!this.running) return;
    try {
      const dir = path.dirname(this.filePath);
      const candidates = await listLogs(dir);
      const now = Date.now();

      const previous = this.dirSizes;
      this.dirSizes = new Map(candidates.map((c) => [c.filePath, c.size]));

      if (previous === null) return;   // baseline scan

      const grew = (c) => c.size > (previous.get(c.filePath) ?? c.size);

      const mine = candidates.find((c) => c.filePath === this.filePath);
      if (mine && grew(mine)) return;  // still playing this character

      let best = null;
      for (const c of candidates) {
        if (c.filePath === this.filePath) continue;
        if (now - c.mtimeMs > SWITCH_STALENESS_MS) continue;
        if (!grew(c)) continue;
        if (!best || c.mtimeMs > best.mtimeMs) best = c;
      }

      if (best) await this.switchTo(best.filePath);
    } catch (err) {
      this.emit('error', err);
    }
  }
}

function fileIdOf(st) {
  return `${st.ino}:${Math.round(st.birthtimeMs)}`;
}

/**
 * List the eqlog_*.txt files in a directory, most recently written first.
 * @returns {Promise<Array<{filePath: string, fileName: string, character: string, server: string, mtimeMs: number, size: number}>>}
 */
export async function listLogs(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const out = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseLogFilename(entry.name);
    if (!parsed) continue;   // skips dbg.txt, Sky.txt, MemoryStrategy.txt
    const filePath = path.join(dir, entry.name);
    try {
      const st = await fs.promises.stat(filePath);
      out.push({
        filePath,
        fileName: entry.name,
        character: parsed.character,
        server: parsed.server,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    } catch {
      // Raced with a delete; just leave it out of the list.
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
