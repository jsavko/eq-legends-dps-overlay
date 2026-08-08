/**
 * Editing the player's `eqclient.ini` so they stop having to type `/log on` every login.
 *
 * The single highest value-per-line idea in EQBuddy's repository, and worth taking on its
 * own merits: this overlay can only see what the client writes, so a player who forgets
 * `/log on` gets an app that appears broken through no fault of anything in it. The game
 * has a setting for exactly this and nobody knows it is there.
 *
 * Pure — no Electron, no `fs` — because it is a text transform on somebody else's file
 * and the whole risk lives in the transform. `main.js` reads, calls `setLogEnabled`, and
 * writes; everything that could go wrong with the CONTENT is unit-testable here.
 *
 * ## Three rules, and the reason for each
 *
 * **Only `[Defaults]`.** `eqclient.ini` has many sections and more than one of them can
 * carry a `Log` key. Rewriting every match would change settings nobody asked about; the
 * client reads logging out of `[Defaults]`, so that is the only place this touches.
 *
 * **Every other byte survives.** This is the player's file, not ours. Comments, blank
 * lines, key order, unknown sections, trailing whitespace and the file's own line endings
 * all come back exactly as they went in. A "helpful" reserialization would silently drop
 * comments a person wrote and reorder keys the game may or may not care about.
 *
 * **A no-op returns the input unchanged**, identity-equal, so the caller can skip the
 * write entirely rather than touching an mtime for nothing.
 */

/** The section EverQuest reads its logging preference out of. */
export const LOG_SECTION = 'Defaults';
export const LOG_KEY = 'Log';

/** `[Section]`, with whatever spacing the file happens to use around it. */
const SECTION_RE = /^\s*\[([^\]]*)\]\s*$/;
/**
 * `Key=Value`, capturing all three runs of whitespace around it separately.
 *
 * The indent, the space before the `=` and the space after it are each captured so the
 * rewritten line can be reassembled from the file's own spacing rather than a template.
 * A file that writes `Log = 0` keeps both spaces; one that writes `Log=0` keeps neither.
 */
const KEY_RE = /^(\s*)([A-Za-z0-9_]+)([ \t]*)=([ \t]*)(.*)$/;

/**
 * Which line endings this file uses.
 *
 * `eqclient.ini` is written by a Windows game and is CRLF in practice, but a file that
 * has been through a text editor, a wiki paste or a git checkout can be anything. Mixing
 * a lone LF into a CRLF file is the kind of thing that works everywhere until it does
 * not, so whatever the file already uses is what it keeps.
 */
export function detectEol(text) {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

/**
 * Return `text` with `Log=1` set in `[Defaults]`, and nothing else changed.
 *
 * Handles the four shapes a real file arrives in:
 *   - `[Defaults]` exists and holds `Log=0` — the value is flipped in place
 *   - `[Defaults]` exists and holds `Log=1` — the input is returned unchanged
 *   - `[Defaults]` exists without a `Log` key — the key is appended to that section
 *   - there is no `[Defaults]` section at all — one is appended at the end
 *
 * @param {string} text     the file's current contents
 * @param {boolean} [on]    false writes `Log=0`, for a caller offering to undo this
 * @returns {{text: string, changed: boolean, action: string}}
 */
export function setLogEnabled(text, on = true) {
  const want = on ? '1' : '0';
  const source = String(text ?? '');
  const eol = detectEol(source);
  // Lines and their ORIGINAL separators, kept side by side. A plain split/join would
  // rewrite every line ending in the file to one style, which for a mixed-ending file is
  // a diff on lines this function never meant to touch — and this is the player's file.
  const { lines, seps } = splitLines(source);

  let inDefaults = false;
  /** The last line index that belonged to [Defaults] — where a missing key is appended. */
  let lastDefaultsLine = -1;
  let sawDefaults = false;

  for (let i = 0; i < lines.length; i++) {
    const sec = SECTION_RE.exec(lines[i]);
    if (sec) {
      inDefaults = sec[1].trim().toLowerCase() === LOG_SECTION.toLowerCase();
      if (inDefaults) {
        sawDefaults = true;
        lastDefaultsLine = i;
      }
      continue;
    }
    if (!inDefaults) continue;

    // Blank lines and comments still count as inside the section: appending a key BEFORE
    // a trailing comment would attach that comment to the wrong thing.
    lastDefaultsLine = i;

    const kv = KEY_RE.exec(lines[i]);
    if (!kv || kv[2].toLowerCase() !== LOG_KEY.toLowerCase()) continue;

    if (kv[5].trim() === want) return { text: source, changed: false, action: 'already-set' };
    // Rebuilt from the captured whitespace rather than from a template, so a file that
    // writes `Log = 0` keeps its spaces and one that writes `Log=0` keeps none.
    lines[i] = `${kv[1]}${kv[2]}${kv[3]}=${kv[4]}${want}`;
    return { text: joinLines(lines, seps, eol), changed: true, action: 'updated' };
  }

  if (sawDefaults) {
    // Back up over any blank lines the section ended with, so the new key lands against
    // the settings it belongs to rather than after a gap.
    let at = lastDefaultsLine;
    while (at > 0 && lines[at].trim() === '') at -= 1;
    lines.splice(at + 1, 0, `${LOG_KEY}=${want}`);
    // The inserted line takes the file's own ending, and the line it was inserted after
    // keeps whatever it had.
    seps.splice(at + 1, 0, seps[at] || eol);
    return { text: joinLines(lines, seps, eol), changed: true, action: 'key-added' };
  }

  // No [Defaults] at all. Appended rather than prepended: an INI section runs until the
  // next header, so putting ours first would silently swallow every key above the first
  // existing header into it.
  const tail = lines[lines.length - 1] === '' ? [] : [''];
  const added = [...tail, `[${LOG_SECTION}]`, `${LOG_KEY}=${want}`, ''];
  // The final piece stops being final, so it needs an ending; everything appended takes
  // the file's own.
  seps[seps.length - 1] = eol;
  return {
    text: joinLines([...lines, ...added], [...seps, ...added.map(() => eol)], eol),
    changed: true,
    action: 'section-added',
  };
}

/**
 * Split into lines while remembering each line's ORIGINAL separator.
 *
 * The last entry is the text after the final separator — empty when the file ends with a
 * newline, as it should — and its separator is the empty string, so a round trip through
 * `joinLines` with no edits is byte-identical to the input.
 */
function splitLines(text) {
  const lines = [];
  const seps = [];
  const re = /\r\n|\n/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    lines.push(text.slice(last, m.index));
    seps.push(m[0]);
    last = re.lastIndex;
  }
  lines.push(text.slice(last));
  seps.push('');
  return { lines, seps };
}

/** The inverse of splitLines. A line with no remembered separator gets the file's own. */
function joinLines(lines, seps, eol) {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    out += lines[i];
    out += i === lines.length - 1 ? (seps[i] ?? '') : (seps[i] ?? eol);
  }
  return out;
}

/** Is logging already on, according to this file? `null` when the file does not say. */
export function isLogEnabled(text) {
  let inDefaults = false;
  for (const line of String(text ?? '').split(/\r\n|\n/)) {
    const sec = SECTION_RE.exec(line);
    if (sec) {
      inDefaults = sec[1].trim().toLowerCase() === LOG_SECTION.toLowerCase();
      continue;
    }
    if (!inDefaults) continue;
    const kv = KEY_RE.exec(line);
    if (kv && kv[2].toLowerCase() === LOG_KEY.toLowerCase()) return kv[5].trim() === '1';
  }
  return null;
}

/**
 * Where `eqclient.ini` lives, derived from the log file we were told to follow.
 *
 * EverQuest keeps its logs in `<game root>/Logs/`, so the game root is that folder's
 * parent and the ini sits directly in it. Derived rather than searched on purpose: this
 * function writes to a path, and guessing at one we were never given is how an app ends
 * up editing an unrelated file on somebody's disk. A log path that is not shaped like an
 * EverQuest log path returns null and the feature simply does not offer itself.
 *
 * @param {string} logPath  e.g. "C:\\...\\EverQuest Legends\\Logs\\eqlog_Rhale_oggok.txt"
 * @returns {string|null}
 */
export function eqclientIniPath(logPath) {
  const raw = String(logPath ?? '');
  if (!raw) return null;

  const sep = raw.includes('\\') ? '\\' : '/';
  const parts = raw.split(/[\\/]/);
  if (parts.length < 3) return null;

  const file = parts[parts.length - 1];
  const folder = parts[parts.length - 2];
  if (!/^eqlog_.+\.txt$/i.test(file)) return null;
  if (folder.toLowerCase() !== 'logs') return null;

  return [...parts.slice(0, -2), 'eqclient.ini'].join(sep);
}

/**
 * Processes that hold a byte offset into the eqlog and must not have it moved.
 *
 * The game itself is obvious. The other two are the lesson EQBuddy learned the hard way:
 * GINA and GamParse both tail the same file by position, and truncating it under them
 * corrupts their state — they keep reading from an offset that is now past the end and go
 * silent until restarted. We can have that fix without first shipping the bug.
 *
 * Matched case-insensitively against a process list, so this is a list of names rather
 * than a list of paths.
 */
export const LOG_READERS = Object.freeze(['eqgame.exe', 'gina.exe', 'gamparse.exe']);

/** Just the game — the only one that has to be closed before its own ini may be edited. */
export const GAME_PROCESS = 'eqgame.exe';

/**
 * Which of `LOG_READERS` appear in a process listing.
 *
 * Takes the listing as a string so the parsing is testable without spawning anything;
 * `main.js` supplies `tasklist` output. Substring matching rather than a column parse
 * because `tasklist`'s columns shift with locale and window width, and a name like
 * `eqgame.exe` is specific enough that a false positive is not a realistic worry.
 */
export function runningLogReaders(tasklistOutput) {
  const haystack = String(tasklistOutput ?? '').toLowerCase();
  return LOG_READERS.filter((name) => haystack.includes(name));
}
