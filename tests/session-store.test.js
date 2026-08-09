import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SessionStore, sessionKey, SESSION_RECORD_VERSION, CHECKPOINT_INTERVAL_MS,
} from '../src/main/session-store.js';
import { SessionTracker } from '../src/session/session.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eql-sessions-'));

function record(overrides = {}) {
  const startTs = overrides.startTs ?? 1_000_000;
  return {
    v: SESSION_RECORD_VERSION,
    id: String(startTs),
    character: 'Rhale',
    server: 'oggok',
    startTs,
    endTs: startTs + 3_600_000,
    durationMs: 3_600_000,
    closeReason: 'idle',
    events: 42,
    kills: { total: 118, mine: 90, others: 4, perHour: 118, byCreature: [], byKiller: [] },
    deaths: [{ ts: startTs + 100, killer: 'urd ghoul wizard' }],
    loot: { total: 14, perHour: 14, items: [] },
    coin: {
      earned: { platinum: 178, gold: 8, silver: 8, copper: 6, copperTotal: 178_886 },
      spent: { platinum: 0, gold: 0, silver: 0, copper: 0, copperTotal: 0 },
      netCopper: 178_886, copperPerHour: 178_886, bySource: [], purchases: [],
    },
    xp: { segments: [], levelsGained: 2, levelsLost: 0, levelUps: [] },
    aa: { earned: 3, spent: 1, unspent: 2, perHour: 3, abilities: [] },
    faction: [],
    skills: { ups: [], tradeskills: [] },
    zones: [{ zone: 'The Ruins of Old Guk', enterTs: startTs, exitTs: null, ms: 3_600_000 }],
    ...overrides,
  };
}

test('sessionKey sanitizes and pairs character with server', () => {
  assert.equal(sessionKey('Rhale', 'oggok'), 'Rhale_oggok');
  assert.equal(sessionKey('Rhale', null), 'Rhale_unknown');
  assert.equal(sessionKey('we/ird', 'na me'), 'we_ird_na_me');
});

test('append/list/get round-trip', () => {
  const store = new SessionStore(tmp());
  const { key, written } = store.append(record());
  assert.equal(key, 'Rhale_oggok');
  assert.equal(written, true);

  const listed = store.list(key);
  assert.equal(listed.length, 1);
  assert.deepEqual(
    {
      kills: listed[0].kills, deaths: listed[0].deaths, loot: listed[0].loot,
      copperEarned: listed[0].copperEarned, levelsGained: listed[0].levelsGained,
      aaEarned: listed[0].aaEarned, zones: listed[0].zones,
    },
    { kills: 118, deaths: 1, loot: 14, copperEarned: 178_886, levelsGained: 2, aaEarned: 3, zones: 1 },
  );

  const full = store.get(key, '1000000');
  assert.equal(full.coin.earned.platinum, 178);
  assert.equal(store.get(key, 'nope'), null);
});

test('list is newest first, across characters kept in separate files', () => {
  const store = new SessionStore(tmp());
  store.append(record({ startTs: 1000, id: '1000' }));
  store.append(record({ startTs: 3000, id: '3000' }));
  store.append(record({ startTs: 2000, id: '2000' }));
  store.append(record({ startTs: 5000, id: '5000', character: 'Rhain' }));

  assert.deepEqual(store.list('Rhale_oggok').map((r) => r.id), ['3000', '2000', '1000']);
  assert.deepEqual(store.list('Rhain_oggok').map((r) => r.id), ['5000']);
  assert.deepEqual(
    store.characters().map((c) => c.character).sort(),
    ['Rhain', 'Rhale'],
  );
});

test('appending the same session twice writes it once', () => {
  const store = new SessionStore(tmp());
  assert.equal(store.append(record()).written, true);
  assert.equal(store.append(record()).written, false);
  assert.equal(store.list('Rhale_oggok').length, 1);
});

test('a torn final line loses one record, not the file', () => {
  const dir = tmp();
  const store = new SessionStore(dir);
  store.append(record({ startTs: 1000, id: '1000' }));
  store.append(record({ startTs: 2000, id: '2000' }));
  fs.appendFileSync(path.join(dir, 'Rhale_oggok.jsonl'), '{"id":"3000","char');

  assert.deepEqual(store.list('Rhale_oggok').map((r) => r.id), ['2000', '1000']);
});

test('reading a store that does not exist yet is empty, not an error', () => {
  const store = new SessionStore(path.join(tmp(), 'not-created'));
  assert.deepEqual(store.list('Rhale_oggok'), []);
  assert.deepEqual(store.characters(), []);
  assert.equal(store.loadCheckpoint('Rhale_oggok'), null);
  assert.deepEqual(store.checkpoints(), []);
});

// ------------------------------------------------------------------------- checkpoint

test('a checkpoint round-trips and is separate from the session file', () => {
  const dir = tmp();
  const store = new SessionStore(dir);
  const open = record({ closeReason: 'open' });

  const key = store.saveCheckpoint(open);
  assert.equal(key, 'Rhale_oggok');
  assert.equal(store.loadCheckpoint(key).id, open.id);
  assert.equal(store.list(key).length, 0, 'a checkpoint is not yet a session');
  assert.equal(fs.existsSync(path.join(dir, 'Rhale_oggok.current.json')), true);
  // No .tmp left lying around — the write is temp-then-rename.
  assert.equal(fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), false);
});

test('recovery folds an orphaned checkpoint into the store and clears it', () => {
  const store = new SessionStore(tmp());
  store.saveCheckpoint(record({ closeReason: 'open' }));

  const recovered = store.recover();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].record.closeReason, 'recovered');
  assert.equal(recovered[0].written, true);

  const listed = store.list('Rhale_oggok');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].closeReason, 'recovered');
  assert.equal(store.loadCheckpoint('Rhale_oggok'), null, 'the checkpoint is spent');

  // Idempotent: a second launch finds nothing to do.
  assert.deepEqual(store.recover(), []);
});

test('a checkpoint for a session already written normally does not duplicate it', () => {
  const store = new SessionStore(tmp());
  store.append(record());
  store.saveCheckpoint(record({ closeReason: 'open' }));

  const recovered = store.recover();
  assert.equal(recovered[0].written, false, 'dedup catches it');
  assert.equal(store.list('Rhale_oggok').length, 1);
  assert.equal(store.loadCheckpoint('Rhale_oggok'), null);
});

test('a cleared checkpoint stops recovery resurrecting a session the player ended', () => {
  const store = new SessionStore(tmp());
  store.saveCheckpoint(record({ closeReason: 'open' }));

  // What `startNewSession` does on a manual close: clear the checkpoint whether or not a
  // record was worth writing. A zero-event session is discarded by the tracker and never
  // reaches the store, so without this its five-minute-old checkpoint would survive to the
  // next launch and `recover()` — which appends without re-checking `events` — would write
  // the very session that was just ended.
  assert.equal(store.clearCheckpoint('Rhale_oggok'), true);
  assert.deepEqual(store.recover(), []);
  assert.equal(store.list('Rhale_oggok').length, 0);

  // Clearing one that is already gone is the outcome the caller wanted, not an error.
  assert.equal(store.clearCheckpoint('Rhale_oggok'), false);
});

test('an unparseable checkpoint is ignored rather than blocking launch', () => {
  const dir = tmp();
  const store = new SessionStore(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Rhale_oggok.current.json'), '{"id":"100', 'utf8');

  assert.equal(store.loadCheckpoint('Rhale_oggok'), null);
  assert.deepEqual(store.recover(), []);
});

test('checkpoints from several characters all recover', () => {
  const store = new SessionStore(tmp());
  store.saveCheckpoint(record({ closeReason: 'open' }));
  store.saveCheckpoint(record({ closeReason: 'open', character: 'Rhain', startTs: 2000, id: '2000' }));

  assert.equal(store.recover().length, 2);
  assert.equal(store.list('Rhale_oggok').length, 1);
  assert.equal(store.list('Rhain_oggok').length, 1);
});

test('clearing a character removes the sessions and the checkpoint together', () => {
  const store = new SessionStore(tmp());
  store.append(record());
  store.saveCheckpoint(record({ closeReason: 'open' }));

  assert.equal(store.clear('Rhale_oggok'), true);
  assert.deepEqual(store.list('Rhale_oggok'), []);
  assert.equal(store.loadCheckpoint('Rhale_oggok'), null);
});

// ------------------------------------------------------------- failure does not propagate

test('a write failure surfaces as a throw the caller can toast, not a corrupt store', () => {
  // A path that cannot be a directory: mkdirSync fails, so append does too.
  const dir = tmp();
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'not a directory', 'utf8');
  const store = new SessionStore(blocker);

  assert.throws(() => store.append(record()));
  assert.throws(() => store.saveCheckpoint(record()));
  // And the read side still answers rather than throwing, so a broken store degrades to
  // an empty one instead of taking a window down on open.
  assert.deepEqual(store.list('Rhale_oggok'), []);
  assert.deepEqual(store.checkpoints(), []);
});

test('the tracker survives a store that throws on every write', () => {
  // A regular file standing where the directory should be, so every mkdir/write throws.
  // Deliberately not a path under /proc: mkdirSync there hangs under WSL rather than
  // failing, which turns "this test is red" into "the suite never finishes".
  const dir = tmp();
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'not a directory', 'utf8');

  const store = new SessionStore(blocker);
  const tracker = new SessionTracker({
    character: 'Rhale',
    server: 'oggok',
    onSessionEnd: (rec) => store.append(rec),
  });
  const line = '[Fri Jul 31 18:48:29 2026] You have slain a froglok shin knight!';
  tracker.feed(line, null);

  assert.doesNotThrow(() => tracker.close('idle'));
  assert.equal(tracker.current, null, 'the session still closed cleanly');
});

// -------------------------------------------------------------- a real tracker round-trip

test('a real tracked session survives the store unchanged', () => {
  const store = new SessionStore(tmp());
  const tracker = new SessionTracker({
    character: 'Rhale',
    server: 'oggok',
    isOurs: (n) => n === 'Rhain',
    onSessionEnd: (rec) => store.append(rec),
  });

  const at = (h, m, s, body) =>
    `[Fri Jul 31 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} 2026] ${body}`;
  tracker.feed(at(18, 0, 0, 'You have slain a froglok shin knight!'), null);
  tracker.feed(at(18, 0, 5, 'You receive 3 gold, 6 silver and 7 copper from the corpse.'), null);
  tracker.feed(at(18, 30, 0, 'A froglok shin knight has been slain by Rhain!'), null);
  tracker.close('idle');

  const [row] = store.list('Rhale_oggok');
  assert.equal(row.kills, 2);
  assert.equal(row.copperEarned, 367);
  assert.equal(row.durationMs, 30 * 60 * 1000);

  const full = store.get('Rhale_oggok', row.id);
  assert.deepEqual(full.kills.byKiller, [
    { name: 'Rhain', count: 1 },
    { name: 'Rhale', count: 1 },
  ]);
});

test('the checkpoint interval is five minutes', () => {
  assert.equal(CHECKPOINT_INTERVAL_MS, 5 * 60 * 1000);
});
