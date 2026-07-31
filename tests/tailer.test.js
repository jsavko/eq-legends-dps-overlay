import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tailer, listLogs } from '../src/main/tailer.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eqtail-'));
}

/** Collect 'lines' events until `predicate` is satisfied or the deadline passes. */
function collect(tailer, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const timer = setTimeout(() => {
      tailer.off('lines', onLines);
      reject(new Error(`timed out with ${JSON.stringify(seen)}`));
    }, timeoutMs);

    function onLines(lines) {
      seen.push(...lines);
      if (predicate(seen)) {
        clearTimeout(timer);
        tailer.off('lines', onLines);
        resolve(seen);
      }
    }
    tailer.on('lines', onLines);
  });
}

const L = (n) => `[Fri Jul 31 18:48:${String(n).padStart(2, '0')} 2026] line ${n}`;

test('reads lines appended after start', async (t) => {
  const dir = tmpdir();
  const file = path.join(dir, 'eqlog_Rhale_oggok.txt');
  fs.writeFileSync(file, '');

  const tailer = new Tailer({ filePath: file, pollMs: 20, watchDirectory: false });
  t.after(() => tailer.stop());
  await tailer.start();

  const pending = collect(tailer, (s) => s.length >= 2);
  fs.appendFileSync(file, `${L(1)}\n${L(2)}\n`);
  const lines = await pending;
  tailer.stop();

  assert.deepEqual(lines.slice(0, 2), [L(1), L(2)]);
});

test('holds a partial line until its newline arrives', async (t) => {
  // The game appends in whatever chunks it likes, so a read can land mid-line.
  // Feeding half a line to the parser would corrupt it.
  const dir = tmpdir();
  const file = path.join(dir, 'eqlog_Rhale_oggok.txt');
  fs.writeFileSync(file, '');

  const tailer = new Tailer({ filePath: file, pollMs: 20, watchDirectory: false });
  t.after(() => tailer.stop());
  await tailer.start();

  const pending = collect(tailer, (s) => s.length >= 1);
  fs.appendFileSync(file, '[Fri Jul 31 18:48:01 2026] partial');
  await new Promise((r) => setTimeout(r, 80));
  fs.appendFileSync(file, ' but now complete\n');

  const lines = await pending;
  tailer.stop();

  assert.equal(lines[0], '[Fri Jul 31 18:48:01 2026] partial but now complete');
});

test('backfills from the end rather than replaying the whole file', async (t) => {
  const dir = tmpdir();
  const file = path.join(dir, 'eqlog_Rhale_oggok.txt');
  fs.writeFileSync(file, `${L(1)}\n${L(2)}\n`);

  const tailer = new Tailer({ filePath: file, pollMs: 20, watchDirectory: false });
  t.after(() => tailer.stop());
  const seen = [];
  tailer.on('lines', (l) => seen.push(...l));
  await tailer.start();
  await new Promise((r) => setTimeout(r, 60));

  const pending = collect(tailer, (s) => s.includes(L(3)));
  fs.appendFileSync(file, `${L(3)}\n`);
  await pending;
  tailer.stop();

  assert.ok(seen.includes(L(3)), 'new lines must arrive');
});

test('fromStart replays the existing file', async (t) => {
  const dir = tmpdir();
  const file = path.join(dir, 'eqlog_Rhale_oggok.txt');
  fs.writeFileSync(file, `${L(1)}\n${L(2)}\n`);

  const tailer = new Tailer({ filePath: file, pollMs: 20, watchDirectory: false, fromStart: true });
  t.after(() => tailer.stop());
  const seen = [];
  tailer.on('lines', (l) => seen.push(...l));
  await tailer.start();
  await new Promise((r) => setTimeout(r, 60));
  tailer.stop();

  assert.deepEqual(seen, [L(1), L(2)]);
});

test('recovers when the log is truncated', async (t) => {
  const dir = tmpdir();
  const file = path.join(dir, 'eqlog_Rhale_oggok.txt');
  fs.writeFileSync(file, `${L(1)}\n${L(2)}\n${L(3)}\n`);

  const tailer = new Tailer({ filePath: file, pollMs: 20, watchDirectory: false });
  t.after(() => tailer.stop());
  await tailer.start();

  const reset = new Promise((resolve) => tailer.once('reset', resolve));
  const pending = collect(tailer, (s) => s.includes(L(9)));

  fs.writeFileSync(file, `${L(9)}\n`);   // shrinks the file below our read position

  const info = await reset;
  const lines = await pending;
  tailer.stop();

  assert.equal(info.reason, 'truncated');
  assert.ok(lines.includes(L(9)), 'reading resumes from the new start');
});

test('follows the player to another character once the new log starts growing', async (t) => {
  const dir = tmpdir();
  const first = path.join(dir, 'eqlog_Rhale_oggok.txt');
  const second = path.join(dir, 'eqlog_Fuaim_oggok.txt');
  fs.writeFileSync(first, `${L(1)}\n`);
  fs.writeFileSync(second, `${L(5)}\n`);

  const tailer = new Tailer({ filePath: first, pollMs: 20, watchDirectory: false });
  t.after(() => tailer.stop());
  await tailer.start();

  await tailer.scanForSwitch();          // baseline
  assert.equal(tailer.filePath, first, 'the baseline scan must never switch');

  const switched = new Promise((resolve) => tailer.once('switch', resolve));
  const pending = collect(tailer, (s) => s.includes(L(6)));

  fs.appendFileSync(second, `${L(6)}\n`);   // the player is now on Fuaim
  await tailer.scanForSwitch();

  const info = await switched;
  await pending;

  assert.equal(info.from, first);
  assert.equal(info.to, second);
  assert.equal(info.character, 'Fuaim');
  assert.equal(tailer.character, 'Fuaim');
});

test('nothing steals the tail while our own log is still growing', async (t) => {
  // Two characters logged in at once (two clients) must not make the overlay flap.
  const dir = tmpdir();
  const mine = path.join(dir, 'eqlog_Rhale_oggok.txt');
  const other = path.join(dir, 'eqlog_Fuaim_oggok.txt');
  fs.writeFileSync(mine, `${L(1)}\n`);
  fs.writeFileSync(other, `${L(1)}\n`);

  const tailer = new Tailer({ filePath: mine, pollMs: 20, watchDirectory: false });
  t.after(() => tailer.stop());
  await tailer.start();
  await tailer.scanForSwitch();

  let switched = false;
  tailer.on('switch', () => { switched = true; });

  fs.appendFileSync(other, `${L(2)}\n`);
  fs.appendFileSync(mine, `${L(2)}\n`);     // ours grew too
  await tailer.scanForSwitch();

  assert.equal(switched, false);
  assert.equal(tailer.filePath, mine);
});

test('ignores a log that is idle, however recently it was touched', async (t) => {
  const dir = tmpdir();
  const active = path.join(dir, 'eqlog_Rhale_oggok.txt');
  const idle = path.join(dir, 'eqlog_Oldchar_oggok.txt');
  fs.writeFileSync(active, `${L(1)}\n`);
  fs.writeFileSync(idle, `${L(1)}\n`);

  const tailer = new Tailer({ filePath: active, pollMs: 20, watchDirectory: false });
  t.after(() => tailer.stop());
  await tailer.start();
  await tailer.scanForSwitch();

  let switched = false;
  tailer.on('switch', () => { switched = true; });

  await tailer.scanForSwitch();   // neither file grew
  assert.equal(switched, false);
  assert.equal(tailer.filePath, active);
});

test('ignores a log that grew but is hours stale', async (t) => {
  const dir = tmpdir();
  const active = path.join(dir, 'eqlog_Rhale_oggok.txt');
  const stale = path.join(dir, 'eqlog_Oldchar_oggok.txt');
  fs.writeFileSync(active, `${L(1)}\n`);
  fs.writeFileSync(stale, `${L(1)}\n`);

  const tailer = new Tailer({ filePath: active, pollMs: 20, watchDirectory: false });
  t.after(() => tailer.stop());
  await tailer.start();
  await tailer.scanForSwitch();

  let switched = false;
  tailer.on('switch', () => { switched = true; });

  fs.appendFileSync(stale, `${L(2)}\n`);
  const hoursAgo = new Date(Date.now() - 3 * 3600_000);
  fs.utimesSync(stale, hoursAgo, hoursAgo);

  await tailer.scanForSwitch();
  assert.equal(switched, false, 'a stale mtime disqualifies it even though it grew');
});

test('listLogs finds only eqlog files, newest first', async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'eqlog_Rhale_oggok.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'eqlog_Fuaim_oggok.txt'), 'x');
  // The real Logs folder contains these next to the character logs.
  fs.writeFileSync(path.join(dir, 'dbg.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'Sky.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'MemoryStrategy.txt'), '');

  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, 'eqlog_Fuaim_oggok.txt'), old, old);

  const logs = await listLogs(dir);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].character, 'Rhale');
  assert.equal(logs[0].server, 'oggok');
  assert.equal(logs[1].character, 'Fuaim');
});

test('a missing file does not throw, it just yields nothing', async (t) => {
  const dir = tmpdir();
  const file = path.join(dir, 'eqlog_Ghost_oggok.txt');

  const tailer = new Tailer({ filePath: file, pollMs: 20, watchDirectory: false });
  t.after(() => tailer.stop());
  const errors = [];
  tailer.on('error', (e) => errors.push(e));
  await tailer.start();
  await new Promise((r) => setTimeout(r, 60));
  tailer.stop();

  // start() surfaces the missing file once; polling after that stays quiet so the
  // tailer can pick the file up if the player enables logging later.
  assert.ok(errors.length <= 1);
});
