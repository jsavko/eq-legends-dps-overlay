import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setLogEnabled, isLogEnabled, detectEol, eqclientIniPath,
  runningLogReaders, LOG_READERS, GAME_PROCESS,
} from '../src/main/eqconfig.js';

/** A realistic slice of an eqclient.ini, CRLF like the game writes it. */
const REAL = [
  '[Defaults]',
  'Gamma=1.0',
  'Log=0',
  'NumMouseButtons=5',
  '',
  '[VideoMode]',
  'Width=2560',
  'Height=1440',
  '',
].join('\r\n');

// ---------------------------------------------------------------------- the transform

test('an existing Log=0 in [Defaults] is flipped and nothing else moves', () => {
  const { text, changed, action } = setLogEnabled(REAL);
  assert.equal(changed, true);
  assert.equal(action, 'updated');
  assert.equal(isLogEnabled(text), true);
  assert.equal(text, REAL.replace('Log=0', 'Log=1'), 'exactly one byte differs');
});

test('a file already set is returned unchanged, so the caller can skip the write', () => {
  const on = REAL.replace('Log=0', 'Log=1');
  const { text, changed, action } = setLogEnabled(on);
  assert.equal(changed, false);
  assert.equal(action, 'already-set');
  assert.equal(text, on);
});

test('a missing Log key is added inside [Defaults], not at the end of the file', () => {
  const without = REAL.replace('Log=0\r\n', '');
  const { text, changed, action } = setLogEnabled(without);
  assert.equal(changed, true);
  assert.equal(action, 'key-added');
  assert.equal(isLogEnabled(text), true);

  const lines = text.split('\r\n');
  const at = lines.indexOf('Log=1');
  assert.ok(at > lines.indexOf('[Defaults]'));
  assert.ok(at < lines.indexOf('[VideoMode]'), 'the key landed in the wrong section');
  // Against the settings it belongs to, not after the blank line that ended the section.
  assert.equal(lines[at - 1], 'NumMouseButtons=5');
});

test('a file with no [Defaults] gets one appended, never prepended', () => {
  const other = '[VideoMode]\r\nWidth=2560\r\n';
  const { text, changed, action } = setLogEnabled(other);
  assert.equal(changed, true);
  assert.equal(action, 'section-added');
  assert.equal(isLogEnabled(text), true);
  // Prepending would swallow every key above the first existing header into our section.
  assert.ok(text.startsWith('[VideoMode]'));
  assert.ok(text.indexOf('[Defaults]') > text.indexOf('Width=2560'));
});

test('an empty file becomes a valid one-section ini', () => {
  const { text } = setLogEnabled('');
  assert.equal(isLogEnabled(text), true);
  assert.match(text, /\[Defaults\]/);
});

test('every other byte of the file survives', () => {
  const withComments = [
    '; EverQuest client settings — hand-edited, do not reorder',
    '',
    '[Defaults]',
    '; logging',
    'Log = 0',
    'Gamma=1.0',
    '',
    '[VideoMode]  ',
    'Width=2560',
  ].join('\r\n');

  const { text } = setLogEnabled(withComments);
  assert.equal(text, withComments.replace('Log = 0', 'Log = 1'));
  assert.match(text, /; EverQuest client settings/, 'comments survive');
  assert.match(text, /\[VideoMode\]  /, 'trailing whitespace survives');
});

test('the file keeps its own spacing around the equals sign', () => {
  assert.match(setLogEnabled('[Defaults]\nLog = 0\n').text, /Log = 1/);
  assert.match(setLogEnabled('[Defaults]\nLog=0\n').text, /Log=1/);
  assert.match(setLogEnabled('[Defaults]\n  Log=0\n').text, /\n {2}Log=1/);
});

test('CRLF is preserved, and so is LF, and so is a mixture', () => {
  assert.equal(detectEol('a\r\nb'), '\r\n');
  assert.equal(detectEol('a\nb'), '\n');
  assert.equal(detectEol('no endings at all'), '\n');

  const crlf = setLogEnabled('[Defaults]\r\nLog=0\r\n').text;
  assert.equal(crlf, '[Defaults]\r\nLog=0\r\n'.replace('Log=0', 'Log=1'));
  assert.equal(crlf.includes('\n\n'), false, 'no bare LF crept in');

  const lf = setLogEnabled('[Defaults]\nLog=0\n').text;
  assert.equal(lf.includes('\r'), false, 'no CR crept in');

  // A file that has been through an editor. The untouched lines keep what they had —
  // rewriting them would be a diff on lines this function never meant to change.
  const mixed = '[Defaults]\nGamma=1.0\r\nLog=0\r\n';
  assert.equal(setLogEnabled(mixed).text, '[Defaults]\nGamma=1.0\r\nLog=1\r\n');
});

test('a file with no trailing newline does not gain or lose one on a plain flip', () => {
  assert.equal(setLogEnabled('[Defaults]\r\nLog=0').text, '[Defaults]\r\nLog=1');
});

test('only [Defaults] is touched, even when another section has a Log key', () => {
  const twoLogs = [
    '[Defaults]',
    'Log=0',
    '',
    '[SomethingElse]',
    'Log=0',
    '',
  ].join('\r\n');

  const { text } = setLogEnabled(twoLogs);
  const lines = text.split('\r\n');
  assert.equal(lines[1], 'Log=1');
  assert.equal(lines[4], 'Log=0', 'a Log key in another section is not ours to change');
});

test('section and key names are matched case-insensitively, as the game writes them', () => {
  assert.equal(isLogEnabled('[defaults]\r\nlog=1\r\n'), true);
  assert.equal(setLogEnabled('[DEFAULTS]\r\nLOG=0\r\n').action, 'updated');
});

test('setLogEnabled(false) exists, so the offer can be undone', () => {
  const off = setLogEnabled(REAL.replace('Log=0', 'Log=1'), false);
  assert.equal(off.changed, true);
  assert.equal(isLogEnabled(off.text), false);
});

test('isLogEnabled says null when the file has no opinion', () => {
  assert.equal(isLogEnabled('[VideoMode]\r\nWidth=2560\r\n'), null);
  assert.equal(isLogEnabled(''), null);
  // A Log key outside [Defaults] is not an answer to this question.
  assert.equal(isLogEnabled('[Other]\r\nLog=1\r\n'), null);
});

// -------------------------------------------------------------------------- the path

test('the ini path is derived from the log path, never guessed', () => {
  assert.equal(
    eqclientIniPath('C:\\Games\\EverQuest Legends\\Logs\\eqlog_Rhale_oggok.txt'),
    'C:\\Games\\EverQuest Legends\\eqclient.ini',
  );
  assert.equal(
    eqclientIniPath('/mnt/c/Games/EverQuest Legends/Logs/eqlog_Rhale_oggok.txt'),
    '/mnt/c/Games/EverQuest Legends/eqclient.ini',
  );
  assert.equal(eqclientIniPath('C:\\Games\\EQ\\LOGS\\eqlog_Rhale_oggok.txt'),
    'C:\\Games\\EQ\\eqclient.ini', 'the folder name is matched case-insensitively');
});

test('a path we were not given produces no path at all', () => {
  // This function's result is written to. Guessing at a location nobody named is how an
  // app ends up editing an unrelated file on somebody's disk.
  assert.equal(eqclientIniPath('C:\\Games\\EQ\\Logs\\notes.txt'), null, 'not an eqlog');
  assert.equal(eqclientIniPath('C:\\Games\\EQ\\Other\\eqlog_Rhale_oggok.txt'), null, 'not in Logs');
  assert.equal(eqclientIniPath('eqlog_Rhale_oggok.txt'), null, 'no folders to walk up');
  assert.equal(eqclientIniPath(''), null);
  assert.equal(eqclientIniPath(null), null);
});

// ---------------------------------------------------------------- the running guard

test('the reader list covers the three that hold an offset into the eqlog', () => {
  // The game is obvious. GINA and GamParse are the lesson EQBuddy learned the hard way:
  // both tail the same file by byte position, and truncating it under them leaves them
  // reading past the end and silently dead until restarted.
  assert.deepEqual([...LOG_READERS], ['eqgame.exe', 'gina.exe', 'gamparse.exe']);
  assert.equal(GAME_PROCESS, 'eqgame.exe');
  assert.ok(LOG_READERS.includes(GAME_PROCESS));
});

test('runningLogReaders reports every reader it finds, by name', () => {
  const listing = [
    'Image Name                     PID Session Name',
    'eqgame.exe                    4321 Console',
    'GINA.exe                      8765 Console',
    'chrome.exe                    1111 Console',
  ].join('\r\n');

  assert.deepEqual(runningLogReaders(listing), ['eqgame.exe', 'gina.exe']);
  assert.deepEqual(runningLogReaders('chrome.exe 1111'), []);
  assert.deepEqual(runningLogReaders(''), []);
  assert.deepEqual(runningLogReaders(null), []);
});
