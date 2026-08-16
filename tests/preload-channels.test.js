import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANNELS } from '../src/main/ipc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(HERE, '..', 'src', 'renderer');

/**
 * The preloads repeat the channel names by hand.
 *
 * They have to: a sandboxed preload is CommonJS and cannot import `ipc.js`, which is an
 * ES module. That leaves the names duplicated in five places with nothing but care
 * keeping them in step — and a typo does not fail loudly, it produces an `invoke` that
 * hangs forever on a channel nobody is listening to. This is the check that care was
 * taken.
 */
const PRELOADS = ['overlay', 'setup', 'history', 'alerts', 'timers', 'triggers', 'session', 'quests', 'secondscreen']
  .map((dir) => [dir, path.join(RENDERER, dir, 'preload.cjs')])
  .filter(([, file]) => fs.existsSync(file));

test('every preload names channels that main actually registers', () => {
  const known = new Set(Object.values(CHANNELS));
  assert.ok(PRELOADS.length >= 4, 'expected to find the preloads');

  for (const [name, file] of PRELOADS) {
    const source = fs.readFileSync(file, 'utf8');
    // The shape every channel constant has: 'namespace:some-action'.
    const used = [...source.matchAll(/'([a-z]+:[a-z-]+)'/g)].map((m) => m[1]);
    assert.ok(used.length > 0, `${name}/preload.cjs declares no channels`);

    for (const channel of used) {
      assert.ok(known.has(channel), `${name}/preload.cjs uses unknown channel "${channel}"`);
    }
  }
});

test('every trigger channel is reachable from some preload', () => {
  // The other direction, and the one that catches the real mistake: a channel added to
  // ipc.js and handled in main, with nothing in a preload to call it. Nothing fails —
  // the feature is simply not there, and the only symptom is a button that does nothing.
  const exposed = new Set(
    PRELOADS.flatMap(([, file]) =>
      [...fs.readFileSync(file, 'utf8').matchAll(/'([a-z]+:[a-z-]+)'/g)].map((m) => m[1])),
  );
  for (const [key, channel] of Object.entries(CHANNELS)) {
    if (!key.startsWith('TRIGGERS_')) continue;
    assert.ok(exposed.has(channel), `${key} (${channel}) is not exposed by any preload`);
  }
});
