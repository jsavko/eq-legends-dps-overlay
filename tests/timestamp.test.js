import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimestamp, formatDuration } from '../src/parser/timestamp.js';

test('parses a real log header', () => {
  const r = parseTimestamp('[Fri Jul 31 18:31:35 2026] Fuaim pierces a shriveled mummy for 1 point of damage.');
  assert.ok(r);
  assert.equal(r.body, 'Fuaim pierces a shriveled mummy for 1 point of damage.');
  const d = new Date(r.ts);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 6);      // July
  assert.equal(d.getDate(), 31);
  assert.equal(d.getHours(), 18);
  assert.equal(d.getMinutes(), 31);
  assert.equal(d.getSeconds(), 35);
});

test('handles the space-padded single-digit day EQ writes', () => {
  const r = parseTimestamp('[Sun Aug  3 09:05:01 2026] You are low on drink.');
  assert.ok(r);
  assert.equal(new Date(r.ts).getDate(), 3);
  assert.equal(r.body, 'You are low on drink.');
});

test('one-second resolution: two lines in the same second share a timestamp', () => {
  const a = parseTimestamp('[Fri Jul 31 18:48:29 2026] You smite a froglok for 48 points of damage.');
  const b = parseTimestamp('[Fri Jul 31 18:48:29 2026] You smite a froglok for 54 points of damage.');
  assert.equal(a.ts, b.ts);
});

test('rejects malformed and untimestamped lines', () => {
  assert.equal(parseTimestamp('no timestamp here'), null);
  assert.equal(parseTimestamp('[Fri Xyz 31 18:31:35 2026] body'), null);
  assert.equal(parseTimestamp('[Fri Jul 31 99:31:35 2026] body'), null);
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp(null), null);
});

test('keeps an empty body rather than failing', () => {
  const r = parseTimestamp('[Fri Jul 31 18:31:35 2026] ');
  assert.ok(r);
  assert.equal(r.body, '');
});

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(9_000), '0:09');
  assert.equal(formatDuration(65_000), '1:05');
  assert.equal(formatDuration(3_725_000), '1:02:05');
  assert.equal(formatDuration(-5), '0:00');
});
