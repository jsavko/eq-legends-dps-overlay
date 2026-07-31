import test from 'node:test';
import assert from 'node:assert/strict';
import { Roster, parseLogFilename } from '../src/parser/roster.js';

test('parses the character and server out of the log filename', () => {
  assert.deepEqual(parseLogFilename('eqlog_Rhale_oggok.txt'), { character: 'Rhale', server: 'oggok' });
  assert.deepEqual(
    parseLogFilename('C:\\Users\\Public\\...\\Logs\\eqlog_Rhale_oggok.txt'),
    { character: 'Rhale', server: 'oggok' }
  );
  assert.equal(parseLogFilename('dbg.txt'), null);
  assert.equal(parseLogFilename('Sky.txt'), null);
});

test('the logging character is always a member', () => {
  const r = new Roster('Rhale');
  assert.equal(r.includes('Rhale', true), true);
  assert.equal(r.includes('Rhale', false), true);
});

test('learns members implicitly from combat when no group message exists', () => {
  const r = new Roster('Rhale');
  r.noteFriendlyCombatant('Rhain');
  r.noteFriendlyCombatant('Emalina');
  assert.equal(r.includes('Rhain', false), true);
  // Group-only still shows them, because the log never said who the group is —
  // otherwise the overlay would show a single row and look broken.
  assert.equal(r.includes('Rhain', true), true);
});

test('implicit learning rejects names that are obviously mobs', () => {
  const r = new Roster('Rhale');
  r.noteFriendlyCombatant('a froglok shin knight');
  r.noteFriendlyCombatant('froglok shin knight');
  assert.equal(r.includes('froglok shin knight', false), false);
});

test('an explicit group message overrides the implicit heuristic', () => {
  const r = new Roster('Rhale');
  r.noteFriendlyCombatant('Rhain');
  r.noteFriendlyCombatant('Randomguy');
  r.applyEvent({ kind: 'group', action: 'join', who: 'Rhain' });

  assert.equal(r.hasExplicitData, true);
  assert.equal(r.includes('Rhain', true), true);
  // Randomguy swung at the same mob but is not in the group.
  assert.equal(r.includes('Randomguy', true), false);
  assert.equal(r.includes('Randomguy', false), true);   // still visible in all-players mode
});

test('leaving and disbanding shrink the group', () => {
  const r = new Roster('Rhale');
  r.applyEvent({ kind: 'group', action: 'join', who: 'Rhain' });
  r.applyEvent({ kind: 'group', action: 'join', who: 'Gann' });
  r.applyEvent({ kind: 'group', action: 'leave', who: 'Gann' });
  assert.equal(r.includes('Gann', true), false);

  r.applyEvent({ kind: 'group', action: 'disband', who: null });
  assert.equal(r.includes('Rhain', true), false);
  assert.equal(r.includes('Rhale', true), true);
});

test('/who output seeds the roster', () => {
  const r = new Roster('Rhale');
  r.applyEvent({ kind: 'who', who: 'Emalina', level: 27, className: 'Cleric', race: 'Human' });
  assert.equal(r.includes('Emalina', true), true);
});

test('manual overrides beat everything', () => {
  const r = new Roster('Rhale');
  r.applyEvent({ kind: 'group', action: 'join', who: 'Rhain' });
  r.override('Rhain', false);
  assert.equal(r.includes('Rhain', true), false);

  r.override('Zevrex', true);
  assert.equal(r.includes('Zevrex', true), true);

  r.clearOverrides();
  assert.equal(r.includes('Rhain', true), true);
});

test('switching character discards everything learned about the old group', () => {
  const r = new Roster('Rhale');
  r.applyEvent({ kind: 'group', action: 'join', who: 'Rhain' });
  r.noteFriendlyCombatant('Passerby');
  r.override('Zevrex', true);

  r.setSelf('Fuaim');

  assert.equal(r.includes('Rhain', false), false);
  assert.equal(r.includes('Passerby', false), false);
  assert.equal(r.includes('Zevrex', false), false);
  assert.equal(r.includes('Fuaim', true), true);
  assert.equal(r.hasExplicitData, false);
});

test('re-setting the same character is a no-op, not a wipe', () => {
  const r = new Roster('Rhale');
  r.noteFriendlyCombatant('Rhain');
  r.setSelf('Rhale');
  assert.equal(r.includes('Rhain', false), true);
});
