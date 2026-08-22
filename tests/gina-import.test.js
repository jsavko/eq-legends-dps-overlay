/**
 * The GINA importer, asserted against real shared packages rather than against
 * hand-written XML that agrees with our assumptions.
 *
 * That distinction is the point. GINA's documentation is offline and the most complete
 * public reader (`pq-companion`'s `gina.go`) is wrong in two places — both silent data
 * loss — so every schema claim here is measured against `tests/fixtures/gina/`, and the
 * two reference-implementation bugs get regression tests of their own at the bottom.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readZip, readPackageXml, looksLikeZip, ZipError } from '../src/triggers/unzip.js';
import { parseXml, decodeXml, decodeEntities, asArray, XmlError } from '../src/triggers/xml.js';
import { parseGinaPackage, readGinaXml, ginaDuration, bool, GinaError } from '../src/triggers/gina.js';
import { patternTemplate, renderTemplate, renderPattern, compileTemplate, literalPrefilter } from '../src/triggers/tokens.js';
import { compilePack, packStats } from '../src/triggers/pack.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gina');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name));
const load = (name) => parseGinaPackage(read(name), { name: name.replace(/\.\w+$/, '') });
const byName = (pack, name) => pack.triggers.find((t) => t.name === name);

// --------------------------------------------------------------------- unzip

test('a .gtp is a zip holding one xml entry, whatever it is called', () => {
  const entries = readZip(read('common-casting.gtp'));
  assert.equal(entries.length, 1);
  // Every one of the nine measured packages spells it ShareData.xml — no "d" — while
  // the root element is <SharedData>. The reader must not depend on either spelling.
  assert.equal(entries[0].name, 'ShareData.xml');
  // The entry carries a UTF-8 BOM, which is exactly why the bytes go through decodeXml
  // rather than straight into a string — `<?xml` is not the first character.
  assert.match(decodeXml(entries[0].data), /^<\?xml/);

  assert.equal(readPackageXml(read('sieve.gtp')).data.toString('utf8').includes('<SharedData>'), true);
});

test('bare XML is told from a zip by its bytes, not its extension', () => {
  assert.equal(looksLikeZip(read('common-casting.gtp')), true);
  assert.equal(looksLikeZip(read('bare-shared-data.xml')), false);
});

test('a truncated or non-zip buffer fails loudly rather than importing nothing', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all')), ZipError);
  assert.throws(() => readZip(read('common-casting.gtp').subarray(0, 40)), ZipError);
});

// ----------------------------------------------------------------------- xml

test('XML entities decode — patterns are stored as (?&lt;mob&gt;.*) and would be dead otherwise', () => {
  assert.equal(decodeEntities('(?&lt;mob&gt;.*)'), '(?<mob>.*)');
  assert.equal(decodeEntities('&amp;&quot;&apos;&#65;&#x42;'), '&"\'AB');
  // An entity that is not one stays as written rather than becoming a wrong character.
  assert.equal(decodeEntities('&notathing; 100&'), '&notathing; 100&');

  const { pack } = load('sieve.gtp');
  assert.equal(byName(pack, 'sieve').pattern, '^(?<mob>.*) staggers in pain\\.$');
});

test('UTF-16 with a BOM decodes — some XmlSerializer versions write it', () => {
  const text = '<?xml version="1.0" encoding="utf-16"?><SharedData><Triggers /></SharedData>';
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  assert.equal(decodeXml(le), text);

  const beBody = Buffer.from(text, 'utf16le');
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(beBody).swap16()]);
  assert.equal(decodeXml(be), text);

  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  assert.equal(decodeXml(utf8Bom), text);

  // No BOM at all: an ASCII-markup UTF-16 document still betrays itself.
  assert.equal(decodeXml(Buffer.from(text, 'utf16le')), text);
});

test('CDATA is verbatim, comments and self-closing tags are skipped', () => {
  const root = parseXml('<!-- lead --><A><B><![CDATA[a & b < c]]></B><C /><!-- mid --><D>x</D></A>');
  assert.equal(root.name, 'A');
  assert.equal(root.value.B, 'a & b < c');
  assert.equal(root.value.C, '');
  assert.equal(root.value.D, 'x');
});

test('repeated siblings collapse to an array — RespawnTimer states TimerEarlyEnders twice', () => {
  const root = parseXml('<A><B>1</B><B>2</B><C>3</C></A>');
  assert.deepEqual(root.value.B, ['1', '2']);
  assert.deepEqual(asArray(root.value.B), ['1', '2']);
  assert.deepEqual(asArray(root.value.C), ['3']);
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray(''), []);
});

test('malformed XML throws rather than returning half a document', () => {
  assert.throws(() => parseXml('<A><B></A>'), XmlError);
  assert.throws(() => parseXml('<A>'), XmlError);
  assert.throws(() => parseXml('<!-- unterminated'), XmlError);
});

// --------------------------------------------------------------------- tokens

test('.NET named groups are already JavaScript and pass through untouched', () => {
  const { template } = patternTemplate('^(?<mob>.*) staggers in pain\\.$', true);
  assert.equal(template, '^(?<mob>.*) staggers in pain\\.$');
  const { regex } = compileTemplate(template, 'Rhale');
  assert.equal(regex.exec('a froglok shin knight staggers in pain.').groups.mob, 'a froglok shin knight');
});

test('duplicate named groups across alternatives compile — the corpus\'s commonest pattern', () => {
  // .NET has always allowed this; JavaScript only accepted it from ES2025 (V8 12.5).
  // Both Node 22+ and Electron 33's Chromium 130 are past that line.
  const source = '(You have slain (?<mob>.*)!)|((?<mob>.*) has been slain by .*!)';
  const { regex, error } = compileTemplate(source, 'Rhale');
  assert.equal(error, null);
  assert.equal(regex.exec('You have slain a froglok shin knight!').groups.mob, 'a froglok shin knight');
  assert.equal(regex.exec('Gann has been slain by a froglok!').groups.mob, 'Gann');
});

test('{C} survives into the stored pattern and resolves at compile time, escaped', () => {
  const built = patternTemplate('^{C} ##reset\\.$', true);
  assert.equal(built.template, '^{C} ##reset\\.$');
  assert.equal(built.usesCharacter, true);

  assert.equal(compileTemplate(built.template, 'Rhale').regex.source, '^Rhale ##reset\\.$');
  // A character switch recompiles; a name with regex punctuation cannot break it.
  const odd = compileTemplate(built.template, 'O.Rourke');
  assert.equal(odd.error, null);
  assert.equal(odd.regex.test('OxRourke ##reset.'), false);
  assert.equal(odd.regex.test('O.Rourke ##reset.'), true);
});

test('{S} is a wildcard capture in a pattern and a back-reference in the output', () => {
  const built = patternTemplate('Your target resisted the {S} spell.', true);
  assert.equal(built.template, 'Your target resisted the (?<S>.+?) spell.');
  const match = compileTemplate(built.template, 'Rhale').regex.exec('Your target resisted the Ice Comet spell.');
  assert.equal(renderTemplate('Resisted {S}', match, 'Rhale'), 'Resisted Ice Comet');
});

test('a literal trigger escapes its text, but only after the tokens are taken out', () => {
  const built = patternTemplate('Insufficient Mana to cast this spell!', false);
  assert.equal(compileTemplate(built.template, 'Rhale').regex.test('Insufficient Mana to cast this spell!'), true);

  // `{` and `}` are regex metacharacters, so escaping before tokenizing would have
  // turned {S} into \{S\} and lost it.
  const withToken = patternTemplate('a gift of {S} mana (1.0)', false);
  const regex = compileTemplate(withToken.template, 'Rhale').regex;
  assert.equal(regex.exec('a gift of 4000 mana (1.0)').groups.S, '4000');
  assert.equal(regex.test('a gift of 4000 mana (1x0)'), false);   // the dot stayed literal
});

test('unmatched groups render EMPTY — ${2}${3}${4} is a real timer name', () => {
  const source = '^(You have slain (.+)|(.+) has been slain by .+|Rhale (##.*)(|!|\\.))$';
  const match = new RegExp(source).exec('You have slain a froglok shin knight');
  assert.equal(renderTemplate('${2}${3}${4}', match, 'Rhale'), 'a froglok shin knight');

  const other = new RegExp(source).exec('Gann has been slain by a froglok');
  assert.equal(renderTemplate('${2}${3}${4}', other, 'Rhale'), 'Gann');

  // The failure this prevents: `undefined` three times over.
  assert.equal(renderTemplate('${mob}${9}', match, 'Rhale'), '');
  assert.equal(renderTemplate('${mob}', null, 'Rhale'), '');
});

test('an early ender resolves ${…} at arm time, and escapes what it substitutes', () => {
  const built = patternTemplate('${mob} is no longer slowed.', false, { backreferences: true });
  // The reference survived literal-mode escaping; everything around it did not.
  assert.equal(built.usesMatch, true);
  assert.match(built.template, /^\$\{mob\} is no longer slowed\\\.$/);

  const match = /(?<mob>.*) yawns/.exec('a froglok (guard) yawns');
  const source = renderPattern(built.template, match);
  const { regex, error } = compileTemplate(source, 'Rhale');
  assert.equal(error, null, 'a captured name is data and must be escaped, not compiled');
  assert.equal(regex.test('a froglok (guard) is no longer slowed.'), true);
});

// ------------------------------------------------------------------ prefilter

test('the prefilter never rejects a line the regex would have matched', () => {
  // A run inside an alternation is not required on its own. The naive "longest literal
  // run" answer here is `abcdef`, which no line matching the second branch contains.
  assert.deepEqual(literalPrefilter('(abcdef|ghijkl)mnopqr'), ['mnopqr']);

  // Top-level alternation: neither half is required, but ONE of them is — so the
  // answer is a set, not a string. This is the corpus's most common pattern.
  assert.deepEqual(
    literalPrefilter('(You have slain (?<mob>.*)!)|((?<mob>.*) has been slain by .*!)'),
    ['You have slain ', ' has been slain by '],
  );

  // A group name is regex syntax, not text on the line.
  assert.deepEqual(literalPrefilter('^(?<mob>.*) staggers in pain\\.$'), [' staggers in pain']);

  // An optional atom promises nothing, and a `?` takes the character before it with it.
  assert.equal(literalPrefilter('(optional)?.*'), null);
  assert.deepEqual(literalPrefilter('colou?rless'), ['rless']);
  assert.deepEqual(literalPrefilter('surrounded by a thorny barrier'), ['surrounded by a thorny barrier']);

  // One branch with no literal poisons the whole alternation.
  assert.equal(literalPrefilter('(specific text)|(.*)'), null);
});

test('every fixture prefilter is sound against the lines its own regex matches', () => {
  const lines = [
    'You have slain a froglok shin knight!',
    'Gann has been slain by a froglok shin knight!',
    'a froglok shin knight staggers in pain.',
    'You gain party experience!!',
    "You've been granted a gift of 4000 mana!",
    'Your target resisted the Ice Comet spell.',
    'Your spell is interrupted.',
    'Rhale ##reset.',
  ];

  for (const file of ['common-casting.gtp', 'sieve.gtp', 'zone-timers-gina.gtp', 'respawn-slice.gtp']) {
    const { pack } = load(file);
    // Ignore the packs' own EnableByDefault so every pattern gets exercised here.
    const open = { ...pack, groups: pack.groups.map((g) => ({ ...g, enabled: true })) };
    for (const c of compilePack(open, 'Rhale').compiled) {
      for (const line of lines) {
        if (!c.regex.test(line)) continue;
        assert.equal(
          !c.prefilter || c.prefilter.some((literal) => line.includes(literal)),
          true,
          `${file} / ${c.trigger.name}: prefilter ${JSON.stringify(c.prefilter)} rejects a matching line`,
        );
      }
    }
  }
});

// -------------------------------------------------------------------- durations

test('the millisecond field wins only when it is actually set', () => {
  assert.equal(ginaDuration({ TimerMillisecondDuration: '60000', TimerDuration: '90' }), 60000);
  // Every RespawnTimer trigger writes it EMPTY, so "present" is not the test.
  assert.equal(ginaDuration({ TimerMillisecondDuration: '', TimerDuration: '300' }), 300000);
  assert.equal(ginaDuration({ TimerMillisecondDuration: '0', TimerDuration: '300' }), 300000);
});

test('a duration may be seconds, a float, MM:SS or HH:MM:SS', () => {
  assert.equal(ginaDuration({ TimerDuration: '90' }), 90_000);
  assert.equal(ginaDuration({ TimerDuration: '1.5' }), 1500);
  assert.equal(ginaDuration({ TimerDuration: '01:30' }), 90_000);
  assert.equal(ginaDuration({ TimerDuration: '00:22:00' }), 1_320_000);
  assert.equal(ginaDuration({ TimerDuration: '' }), 0);
  assert.equal(ginaDuration({ TimerDuration: 'soon' }), 0);
});

test('booleans are read loosely, and absent takes the caller\'s default', () => {
  for (const yes of ['True', 'true', '1', 'yes', 'ON']) assert.equal(bool(yes), true, yes);
  for (const no of ['False', 'false', '0', 'no', 'off']) assert.equal(bool(no, true), false, no);
  // Absent is not the same claim as off: for EnableByDefault the difference is a whole
  // pack importing switched off.
  assert.equal(bool(undefined, true), true);
  assert.equal(bool('', true), true);
  assert.equal(bool('maybe', true), true);
});

// ----------------------------------------------------------------- field mapping

test('the group tree flattens with its path, and disabled groups disable their children', () => {
  const { pack } = load('common-casting.gtp');
  assert.deepEqual(pack.groups.map((g) => g.path), [['Common'], ['Common', 'Casting']]);
  // The pack ships EnableByDefault=False — respected, not overridden, because it is
  // what its author chose. packStats is how the import report says so out loud.
  assert.equal(pack.groups.every((g) => g.enabled === false), true);
  assert.deepEqual(packStats(pack), { triggers: 5, live: 0, timers: 0, warnings: 5, groups: 2, byPanel: {} });
});

test('a NoTimer trigger is a warning chip and nothing else', () => {
  const { pack } = load('common-casting.gtp');
  const t = byName(pack, 'Insufficient mana');
  assert.equal(t.timer, null);
  assert.deepEqual(t.warn, { text: '{C} is out of mana', from: 'display', group: null, tier: 2 });
});

test('a Timer trigger becomes a countdown row carrying its authored duration', () => {
  const { pack } = load('sieve.gtp');
  const t = byName(pack, 'sieve');
  assert.equal(t.timer.kind, 'countdown');
  assert.equal(t.timer.name, 'sieve ${mob}');
  assert.equal(t.timer.durationMs, 60_000);
  assert.equal(t.timer.restart, 'restart');
  assert.equal(t.provenance, 'imported');
});

test('an unnamed timer falls back to the trigger name rather than sharing one slot', () => {
  const xml = `<SharedData><Triggers><Trigger>
    <Name>Nameless</Name><TriggerText>x marks</TriggerText>
    <TimerType>Timer</TimerType><TimerName></TimerName><TimerDuration>30</TimerDuration>
  </Trigger></Triggers></SharedData>`;
  assert.equal(readGinaXml(xml).pack.triggers[0].timer.name, 'Nameless');
});

test('a Stopwatch loses its count-up, and the trigger only if that was all it had', () => {
  const stopwatch = (extra) => `<SharedData><Triggers><Trigger>
    <Name>Elapsed</Name><TriggerText>go</TriggerText>${extra}
    <TimerType>Stopwatch</TimerType><TimerDuration>0</TimerDuration>
  </Trigger></Triggers></SharedData>`;

  // With a chip to show, the trigger still works and only the stopwatch is lost.
  const kept = readGinaXml(stopwatch('<UseText>True</UseText><DisplayText>go</DisplayText>'));
  assert.equal(kept.pack.triggers.length, 1);
  assert.equal(kept.dropped[0].feature, 'stopwatch timer');
  assert.equal(kept.dropped[0].fatal, false);

  // With nothing else, the same fact is fatal — and says so, rather than reporting the
  // vaguer "nothing to show" and leaving the player to guess which feature did it.
  const gone = readGinaXml(stopwatch(''));
  assert.equal(gone.pack.triggers.length, 0);
  assert.equal(gone.dropped[0].feature, 'stopwatch timer');
  assert.equal(gone.dropped[0].fatal, true);
});

test('a Timer with no duration is refused, and named as the reason', () => {
  const xml = `<SharedData><Triggers><Trigger>
    <Name>Untimed</Name><TriggerText>go</TriggerText>
    <TimerType>Timer</TimerType><TimerName>x</TimerName><TimerDuration>0</TimerDuration>
  </Trigger></Triggers></SharedData>`;
  const { pack, dropped } = readGinaXml(xml);
  assert.equal(pack.triggers.length, 0);
  assert.equal(dropped[0].feature, 'timer with no duration');
  assert.equal(dropped[0].fatal, true);
});

test('a RepeatingTimer is handled even though the corpus has none', () => {
  const xml = `<SharedData><Triggers><Trigger>
    <Name>Tick</Name><TriggerText>tick</TriggerText>
    <TimerType>RepeatingTimer</TimerType><TimerName>Tick</TimerName><TimerDuration>10</TimerDuration>
  </Trigger></Triggers></SharedData>`;
  assert.equal(readGinaXml(xml).pack.triggers[0].timer.kind, 'repeating');
});

test('TimerStartBehavior normalizes, and an unknown value keeps the timer', () => {
  const withBehavior = (value) => {
    const xml = `<SharedData><Triggers><Trigger><Name>T</Name><TriggerText>t</TriggerText>
      <TimerType>Timer</TimerType><TimerName>T</TimerName><TimerDuration>10</TimerDuration>
      <TimerStartBehavior>${value}</TimerStartBehavior></Trigger></Triggers></SharedData>`;
    return readGinaXml(xml).pack.triggers[0].timer.restart;
  };
  assert.equal(withBehavior('StartNewTimer'), 'new');
  assert.equal(withBehavior('RestartTimer'), 'restart');
  assert.equal(withBehavior('DoNothingIfRunning'), 'ignore');
  assert.equal(withBehavior('SomethingNewInGina7'), 'new');
});

test('a top-level SharedData > Triggers imports, with no group at all', () => {
  const { pack } = load('bare-shared-data.xml');
  assert.equal(pack.groups.length, 0);
  assert.equal(pack.triggers.length, 1);
  assert.equal(pack.triggers[0].groupId, null);
  // MM:SS, CDATA and a loose `true` all in one trigger.
  assert.equal(pack.triggers[0].timer.durationMs, 90_000);
  assert.equal(pack.triggers[0].pattern, '^(?<mob>.*) yawns\\.$');
});

// --------------------------------------------------------- the speech fallback

test('speech becomes chip text when there is no display text — never a silent no-op', () => {
  const { pack, dropped } = load('common-casting.gtp');

  // "Gift of * Mana" speaks and displays nothing at all. Importing it as text-only
  // would list a working trigger that does nothing, which is worse than dropping it.
  const gift = byName(pack, 'Gift of * Mana');
  assert.deepEqual(gift.warn, { text: 'Free cast for {C}', from: 'speech', group: null, tier: 2 });
  assert.equal(dropped.some((d) => d.trigger === 'Gift of * Mana'), false);

  // Where BOTH exist the display text wins and the speech genuinely is lost — so it
  // is reported, unlike the fallback above.
  const resisted = byName(pack, 'Spell resisted');
  assert.equal(resisted.warn.from, 'display');
  const report = dropped.find((d) => d.trigger === 'Spell resisted');
  assert.equal(report.feature, 'text-to-speech');
  assert.equal(report.fatal, false);
});

test('every trigger in the corpus shows something, or is reported as showing nothing', () => {
  for (const file of ['common-casting.gtp', 'sieve.gtp', 'zone-timers-gina.gtp', 'respawn-slice.gtp']) {
    const { pack } = load(file);
    for (const t of pack.triggers) {
      assert.equal(Boolean(t.warn || t.timer), true, `${file}: ${t.name} would import as a no-op`);
    }
  }
});

// ------------------------------------------------------- the dropped-feature report

test('clipboard, media and counters are dropped BY NAME, never silently', () => {
  const { dropped } = load('sieve.gtp');
  const features = dropped.map((d) => d.feature).sort();
  assert.deepEqual(features, ['clipboard', 'counter', 'text-to-speech']);
  assert.equal(dropped.every((d) => d.trigger === 'sieve' && d.fatal === false), true);
  // The report names the path, so a 35-group pack can say WHERE.
  assert.equal(dropped[0].path, 'Common › General › debufs');
});

test('an uncompilable pattern costs that trigger and nothing else', () => {
  const xml = `<SharedData><Triggers>
    <Trigger><Name>Bad</Name><TriggerText>(?#a .NET comment)x</TriggerText><EnableRegex>True</EnableRegex>
      <UseText>True</UseText><DisplayText>bad</DisplayText><TimerType>NoTimer</TimerType></Trigger>
    <Trigger><Name>Good</Name><TriggerText>plain text</TriggerText>
      <UseText>True</UseText><DisplayText>good</DisplayText><TimerType>NoTimer</TimerType></Trigger>
  </Triggers></SharedData>`;
  const { pack } = readGinaXml(xml);
  const { compiled, failed } = compilePack(pack, 'Rhale');
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].trigger.name, 'Good');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].name, 'Bad');
  assert.match(failed[0].error, /./);
});

test('a document that is not a GINA package is refused', () => {
  assert.throws(() => readGinaXml('<Something><Else /></Something>'), GinaError);
});

// -------------------------------------- regressions for the reference importer's bugs

test('BUG 1: the early-ender pattern lives in EarlyEndText, not EndingTrigger', () => {
  // pq-companion's gina.go reads an `EndingTrigger` element. There are zero uses of
  // that name in the corpus and 68 of EarlyEndText, so that importer silently imports
  // no early enders at all.
  const { pack } = load('respawn-slice.gtp');
  const slain = byName(pack, '05:00 slain');
  assert.equal(slain.timer.earlyEnders.length, 1);
  assert.equal(slain.timer.earlyEnders[0].pattern, '^{C} ##reset\\.$');
  assert.equal(slain.timer.earlyEnders[0].usesCharacter, true);
});

test('BUG 1b: TimerEarlyEnders appears twice in one trigger and both are read', () => {
  // The real RespawnTimer trigger states it once self-closing and once with content.
  // A reader letting the last occurrence win would be right here by luck; one letting
  // the FIRST win would lose every early ender in the pack.
  const xml = read('respawn-slice.gtp');
  const raw = parseXml(parseGinaPackage(xml) && readPackageXml(xml).data);
  const group = asArray(raw.value.TriggerGroups)[0].TriggerGroup.TriggerGroups.TriggerGroup[0];
  const trigger = asArray(group.Triggers.Trigger)[0];
  assert.equal(Array.isArray(trigger.TimerEarlyEnders), true, 'the fixture must still state it twice');
  assert.equal(load('respawn-slice.gtp').pack.triggers[0].timer.earlyEnders.length, 1);
});

test('BUG 2: TimerEndingTrigger is an element with children, so its text survives', () => {
  // gina.go declares it a string, and loses the ending notice entirely.
  const { pack } = load('respawn-slice.gtp');
  const slain = byName(pack, '05:00 slain');
  assert.equal(slain.timer.endingMs, 30_000);
  assert.equal(slain.timer.endingText, 'spawn soon');
});

test('an ending notice that only speaks still becomes text, and reports nothing lost', () => {
  const { pack, dropped } = load('zone-timers-gina.gtp');
  const lasna = byName(pack, 'lasna');
  assert.equal(lasna.timer.endingText, 'Room Pop in 30 sec');
  // This one has BOTH, so the spoken half is reported.
  assert.equal(dropped.some((d) => d.trigger === 'lasna' && d.feature === 'text-to-speech'), true);
});
