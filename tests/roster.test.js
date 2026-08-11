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
  assert.equal(r.includes('Rhale'), true);
});

test('learns members implicitly from combat when no group message exists', () => {
  const r = new Roster('Rhale');
  r.noteFriendlyCombatant('Rhain');
  r.noteFriendlyCombatant('Emalina');
  assert.equal(r.includes('Rhain'), true);
  assert.equal(r.includes('Emalina'), true);
});

test('implicit learning rejects names that are obviously mobs', () => {
  const r = new Roster('Rhale');
  r.noteFriendlyCombatant('a froglok shin knight');
  r.noteFriendlyCombatant('froglok shin knight');
  assert.equal(r.includes('froglok shin knight'), false);
});

test('an explicit group message adds to membership without narrowing it', () => {
  const r = new Roster('Rhale');
  r.noteFriendlyCombatant('Rhain');
  r.noteFriendlyCombatant('Randomguy');
  r.applyEvent({ kind: 'group', action: 'join', who: 'Rhain' });

  assert.equal(r.hasExplicitData, true);
  assert.equal(r.includes('Rhain'), true);
  // Randomguy is not in the group, but membership is not a display filter any more —
  // he swung at the mob, so he is one of us for attribution purposes and gets a row.
  // Hiding him is the party list's job, and only if the player asked for it.
  assert.equal(r.includes('Randomguy'), true);
  assert.equal(r.inParty('Randomguy'), true);
});

test('leaving and disbanding shrink explicit membership', () => {
  const r = new Roster('Rhale');
  r.applyEvent({ kind: 'group', action: 'join', who: 'Rhain' });
  r.applyEvent({ kind: 'group', action: 'join', who: 'Gann' });
  r.applyEvent({ kind: 'group', action: 'leave', who: 'Gann' });
  assert.equal(r.explicit.has('Gann'), false);
  assert.equal(r.isConfirmedMember('Gann'), false);

  r.applyEvent({ kind: 'group', action: 'disband', who: null });
  assert.equal(r.isConfirmedMember('Rhain'), false);
  assert.equal(r.isConfirmedMember('Rhale'), true);
});

test('/who output seeds the roster', () => {
  const r = new Roster('Rhale');
  r.applyEvent({ kind: 'who', who: 'Emalina', level: 27, className: 'Cleric', race: 'Human' });
  assert.equal(r.includes('Emalina'), true);
  assert.equal(r.isConfirmedMember('Emalina'), true);
});

test('manual overrides beat everything', () => {
  const r = new Roster('Rhale');
  r.applyEvent({ kind: 'group', action: 'join', who: 'Rhain' });
  r.override('Rhain', false);
  assert.equal(r.includes('Rhain'), false);

  r.override('Zevrex', true);
  assert.equal(r.includes('Zevrex'), true);

  r.clearOverrides();
  assert.equal(r.includes('Rhain'), true);
});

// ------------------------------------------------------------------- party list

test('an empty party list shows everyone, including names nothing was proven about', () => {
  const r = new Roster('Rhale');
  assert.equal(r.hasPartyList(), false);
  assert.equal(r.inParty('Rhale'), true);
  assert.equal(r.inParty('Randomguy'), true);
  assert.equal(r.inParty('Goneker'), true);
  assert.equal(r.inParty('a froglok shin knight'), true);
});

test('a party list is taken literally — that list and nothing else', () => {
  const r = new Roster('Rhale');
  r.setPartyMembers(['Rhain', 'Emalina']);
  assert.equal(r.hasPartyList(), true);
  assert.equal(r.inParty('Rhain'), true);
  assert.equal(r.inParty('Emalina'), true);
  assert.equal(r.inParty('Randomguy'), false);
  // Even the logging character: the list means the list, so it is the one place the
  // player can watch three other people without their own row in the way.
  assert.equal(r.inParty('Rhale'), false);
});

test('setting the party list replaces it wholesale, and blanks/whitespace drop out', () => {
  const r = new Roster('Rhale');
  r.setPartyMembers(['Rhain', ' Emalina ', '', '   ', null]);
  assert.deepEqual([...r.partyMembers].sort(), ['Emalina', 'Rhain']);

  r.setPartyMembers(['Rhain']);
  assert.equal(r.inParty('Emalina'), false);

  // Clearing it in settings actually clears it, rather than leaving a filter running.
  r.setPartyMembers([]);
  assert.equal(r.hasPartyList(), false);
  assert.equal(r.inParty('Emalina'), true);
});

test('group join and leave lines never change what the party list shows', () => {
  const r = new Roster('Rhale');
  r.setPartyMembers(['Rhain', 'Emalina']);
  r.applyEvent({ kind: 'group', action: 'join', who: 'Randomguy' });
  r.applyEvent({ kind: 'group', action: 'leave', who: 'Randomguy' });

  assert.equal(r.hasExplicitData, true);
  assert.equal(r.inParty('Rhain'), true);
  assert.equal(r.inParty('Randomguy'), false);

  // And with no list, the same lines still hide nobody — this is the failure the party
  // list replaced: `hasExplicitData` flipping true used to drop everyone who was in the
  // group before logging began, silently.
  const open = new Roster('Rhale');
  open.noteFriendlyCombatant('Washerefirst');
  open.applyEvent({ kind: 'group', action: 'leave', who: 'Someoneelse' });
  assert.equal(open.hasExplicitData, true);
  assert.equal(open.inParty('Washerefirst'), true);
});

// ------------------------------------------------------- what the roster is FOR now

test('the roster seeds a fight, it does not gate one', () => {
  const r = new Roster('Rhale');
  // Everything it can answer, it answers for one purpose: telling the parser which end
  // of the first damage line of a pull is the enemy. Nothing here decides whose damage
  // counts — the fight decides that, so a wrong answer costs a column, not a person.
  assert.equal(r.includes('Rhale'), true);
  assert.equal(r.isConfirmedMember('Rhale'), true);

  r.noteFriendlyCombatant('Goneker');
  assert.equal(r.includes('Goneker'), true, 'fought alongside us, so it seeds as ours');
});

test('the hostile brand is gone, and nothing replaced it', () => {
  const r = new Roster('Rhale');
  // The session-long "this is an enemy" mark deleted a friendly pet for a whole raid
  // night. The fight's own enemy set replaced it, and that set lives on the encounter.
  assert.equal(typeof r.noteHostileByAction, 'undefined');
  assert.equal(typeof r.isHostileByAction, 'undefined');
  assert.equal(typeof r.noteFriendlyByAction, 'undefined');
  assert.equal(typeof r.hasFriendlyProof, 'undefined');
});
