/**
 * Every renderer script parses as an ES MODULE.
 *
 * This exists because of a bug that shipped: `panel.js` grew a second function called
 * `paint` and the whole file stopped loading. Duplicate function declarations are legal
 * in a sloppy-mode script and a SyntaxError in a module, and every renderer here is
 * loaded with `<script type="module">` — so the window opened, the preload bridge
 * attached, and the file inside it never ran. Nothing threw anywhere main could see it.
 * The panel simply drew nothing, which is indistinguishable from a panel with no timers.
 *
 * `node --check some.js` does NOT catch it: Node parses a `.js` file as CommonJS. That
 * is precisely why the check passed while the app was broken, and why this test copies
 * each file to a `.mjs` before checking it — the extension is what selects the grammar.
 *
 * A parse check is a low bar. It is also exactly the bar that was missed, and it costs
 * milliseconds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const RENDERER = path.join(import.meta.dirname, '..', 'src', 'renderer');

/** Every `.js` under src/renderer — they are all module-loaded. Preloads are `.cjs` and
 *  are deliberately excluded: those really are CommonJS. */
function scripts(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...scripts(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('every renderer script parses under module grammar', () => {
  const files = scripts(RENDERER);
  assert.ok(files.length > 5, 'expected to find the renderer scripts');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eql-modcheck-'));
  try {
    for (const file of files) {
      const copy = path.join(tmp, 'check.mjs');
      fs.copyFileSync(file, copy);
      try {
        execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
      } catch (err) {
        const detail = String(err.stderr ?? err.message).split('\n').slice(0, 6).join('\n');
        assert.fail(`${path.relative(RENDERER, file)} does not parse as a module:\n${detail}`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
