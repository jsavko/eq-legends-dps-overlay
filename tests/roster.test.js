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

// -------------------------------------------------------------- friendly proof

test('friendly proof blocks a branding', () => {
  const r = new Roster('Rhale');
  assert.equal(r.noteFriendlyByAction('Goneker'), true);
  assert.equal(r.hasFriendlyProof('Goneker'), true);

  // The pet took a swing at a charmed group member. That used to be enough.
  assert.equal(r.noteHostileByAction('Goneker'), false);
  assert.equal(r.isHostileByAction('Goneker'), false);
});

test('friendly proof arriving later revokes a branding', () => {
  const r = new Roster('Rhale');
  assert.equal(r.noteHostileByAction('Goneker'), true);
  assert.equal(r.isHostileByAction('Goneker'), true);
  assert.equal(r.notPets.has('Goneker'), true);

  // A group member heals it: whatever it was mistaken for, it is ours.
  assert.equal(r.noteFriendlyByAction('Goneker'), true);
  assert.equal(r.isHostileByAction('Goneker'), false);
  // The blacklist goes with the brand, or the next summon could never re-bind it.
  assert.equal(r.notPets.has('Goneker'), false);
});

test('a mob the group has charmed does not collect permanent friendly standing', () => {
  const r = new Roster('Rhale');
  r.charm('a tal ghoul wizard', 'Rhain');
  // Healing your own charmed pet proves nothing that charmedPets does not already say,
  // and recording it would outlive the charm.
  assert.equal(r.noteFriendlyByAction('a tal ghoul wizard'), false);

  r.uncharm('a tal ghoul wizard');
  assert.equal(r.noteHostileByAction('a tal ghoul wizard'), true);
});

test('only shape-dependent names can collect friendly proof at all', () => {
  const r = new Roster('Rhale');
  // The set the branding mechanism can wrongly claim: player-shaped, or a pet.
  assert.equal(r.noteFriendlyByAction('Goneker'), true);
  assert.equal(r.noteFriendlyByAction('Rhale`s warder'), true);

  // Everything else was never friendly by shape, so it needs no protection — and giving
  // it any is how a charmed mob the group healed keeps standing after the charm breaks.
  // Five did exactly that in the live log before this guard, including a loathling lich
  // with 85,374 damage that would have scored as the group's own.
  for (const mob of ['a loathling lich', 'an elemental warrior', 'Cleric of Innoruuk',
                     'Knight V`Tal', 'skeleton L`rodd', 'Innoruuk`s Chosen']) {
    assert.equal(r.noteFriendlyByAction(mob), false, mob);
    assert.equal(r.hasFriendlyProof(mob), false, mob);
    assert.equal(r.noteHostileByAction(mob), true, `${mob} can still be branded`);
  }
});

test('a branding still sticks to something nobody ever healed', () => {
  const r = new Roster('Rhale');
  assert.equal(r.noteHostileByAction('Bzzazzt'), true);
  assert.equal(r.isHostileByAction('Bzzazzt'), true);
  assert.equal(r.hasFriendlyProof('Bzzazzt'), false);
});

test('friendly proof is discarded on a character switch', () => {
  const r = new Roster('Rhale');
  r.noteFriendlyByAction('Goneker');
  r.setSelf('Fuaim');
  assert.equal(r.hasFriendlyProof('Goneker'), false);
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
