import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEntity, looksLikePlayerName, nearestName, stripArticle, isSelfToken } from '../src/parser/entities.js';

test('normalizes every spelling of the logging character', () => {
  for (const token of ['You', 'YOU', 'you', 'Yourself']) {
    const e = resolveEntity(token, 'Rhale');
    assert.equal(e.name, 'Rhale', `${token} should resolve to Rhale`);
    assert.equal(e.isPet, false);
  }
});

test('folds a pet into its owner via the backtick possessive', () => {
  const e = resolveEntity('Rhale`s warder', 'Rhale');
  assert.equal(e.name, 'Rhale');
  assert.equal(e.owner, 'Rhale');
  assert.equal(e.isPet, true);
  assert.equal(e.display, 'Rhale`s warder');
});

test("another player's pet belongs to that player, not to us", () => {
  const e = resolveEntity('Fuaim`s warder', 'Rhale');
  assert.equal(e.name, 'Fuaim');
  assert.equal(e.isPet, true);
});

test('matches the backtick generically, not a list of pet types', () => {
  for (const suffix of ['pet', 'warder', 'familiar', 'ward', 'skeleton minion']) {
    const e = resolveEntity(`Someone\`s ${suffix}`, 'Rhale');
    assert.equal(e.name, 'Someone');
    assert.equal(e.isPet, true);
  }
});

test('collapses the two spellings of the same mob onto one key', () => {
  // EQ capitalizes the article at the start of a sentence and lowercases it mid-sentence.
  assert.equal(resolveEntity('A froglok shin knight', 'Rhale').name, 'froglok shin knight');
  assert.equal(resolveEntity('a froglok shin knight', 'Rhale').name, 'froglok shin knight');
  assert.equal(stripArticle('The Ancient One'), 'Ancient One');
});

test('player-name heuristic', () => {
  assert.equal(looksLikePlayerName('Rhain'), true);
  assert.equal(looksLikePlayerName('Emalina'), true);
  assert.equal(looksLikePlayerName('a froglok shin knight'), false);
  assert.equal(looksLikePlayerName('froglok shin knight'), false);
  assert.equal(looksLikePlayerName('Quartermaster Zevrex'), false);
  assert.equal(looksLikePlayerName('Rhale`s warder'), false);
  assert.equal(looksLikePlayerName(''), false);
});

test('isSelfToken', () => {
  assert.equal(isSelfToken('YOU'), true);
  assert.equal(isSelfToken('  you '), true);
  assert.equal(isSelfToken('Rhale'), false);
});

const GROUP = ['Rhale', 'Kadomony', 'Khanvikt', 'Emalina', 'Venun'];

test('nearestName catches the slips that produce a phantom player', () => {
  // The one from the live log, and its neighbours: a swapped letter, a dropped one,
  // an extra one, and the wrong case.
  assert.equal(nearestName('Kodomony', GROUP), 'Kadomony');
  assert.equal(nearestName('Kadomny', GROUP), 'Kadomony');
  assert.equal(nearestName('Kadomonyy', GROUP), 'Kadomony');
  assert.equal(nearestName('kadomony', GROUP), 'Kadomony');
  assert.equal(nearestName('Khanvict', GROUP), 'Khanvikt');
});

test('nearestName stays quiet unless the answer is obvious', () => {
  // Far from everyone: a real player who simply has not acted yet must not be
  // "corrected" into somebody else.
  assert.equal(nearestName('Zarann', GROUP), null);
  // Short names are all within two edits of each other, so no suggestion is honest.
  assert.equal(nearestName('Gan', ['Gann', 'Garn', 'Gbak']), null);
  // A tie is a coin flip, and offering one invites accepting the wrong half.
  assert.equal(nearestName('Garn', ['Gaern', 'Gairn']), null);
  assert.equal(nearestName('Kadomony', []), null);
});
