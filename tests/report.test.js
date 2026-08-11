import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_LIMIT, chatReport, formatDuration, rowsForMetric,
} from '../src/renderer/overlay/report.js';

// ---------------------------------------------------------------- fixtures

/** A snapshot row with every field the three metrics read, zeroed. */
function member(name, over = {}) {
  return {
    name,
    damage: 0, dps: 0, share: 0,
    healing: 0, hps: 0, healShare: 0, heals: 0,
    damageTaken: 0, dtps: 0, takenShare: 0, deaths: 0, petDeaths: 0,
    ...over,
  };
}

/** 2:14, the duration in the worked example. */
const DURATION_MS = 134_000;

/**
 * A damage snapshot from `[name, dps]` pairs. Shares and the group rate follow from the
 * pairs rather than being stated, so a test cannot assert a percentage the numbers
 * beside it do not support.
 */
function damageSnap(pairs, over = {}) {
  const total = pairs.reduce((sum, [, dps]) => sum + dps, 0);
  return {
    idle: false,
    active: true,
    label: 'Vessel of Terror',
    durationMs: DURATION_MS,
    groupDps: total,
    deaths: [],
    rows: pairs
      .map(([name, dps]) => member(name, {
        dps,
        damage: dps * (DURATION_MS / 1000),
        share: total > 0 ? dps / total : 0,
      }))
      .sort((a, b) => b.damage - a.damage),
    ...over,
  };
}

/** The group in the plan: four members, 3594 dps between them. */
const GROUP = [['Rhale', 1234], ['Emalina', 980], ['Khanvikt', 870], ['Aanya', 510]];

// ---------------------------------------------------------------- row selection

test('the damage view shows every row, in the order the parser sorted them', () => {
  const snap = damageSnap(GROUP);
  assert.deepEqual(rowsForMetric(snap, 'damage').map((r) => r.name),
    ['Rhale', 'Emalina', 'Khanvikt', 'Aanya']);
});

test('a row that dealt nothing is not on the damage chart', () => {
  // The parser emits one row per combatant, and a combatant is created by taking damage
  // or healing too — so a cleric who never swung, or a shaman whose only entry was the
  // health he spent on mana, used to sit at the bottom of the DPS list reading 0.
  const snap = damageSnap(GROUP, {
    rows: [
      ...damageSnap(GROUP).rows,
      member('Cleric', { damage: 0, dps: 0, heals: 4, healing: 900 }),
      member('Shaman', { damage: 0, dps: 0, damageTaken: 1924 }),
    ],
  });

  assert.deepEqual(rowsForMetric(snap, 'damage').map((r) => r.name),
    ['Rhale', 'Emalina', 'Khanvikt', 'Aanya']);
  // They are still on the charts where they did something.
  assert.ok(rowsForMetric(snap, 'healing').some((r) => r.name === 'Cleric'));
  assert.ok(rowsForMetric(snap, 'taken').some((r) => r.name === 'Shaman'));
});

test('the healing view keeps a healer whose every point was overheal', () => {
  // Keyed on the CAST count, not the healed total: a cleric who landed nothing still
  // cast, still spent the mana, and vanishing from the healing view would be absurd.
  const snap = damageSnap([], {
    rows: [
      member('Emalina', { heals: 12, healing: 40_000, hps: 300 }),
      member('Rhale', { damage: 165_000, dps: 1234 }),
      member('Nubbin', { heals: 3, healing: 0, hps: 0 }),
    ],
  });
  assert.deepEqual(rowsForMetric(snap, 'healing').map((r) => r.name), ['Emalina', 'Nubbin']);
});

test('the taken view keeps a member who only died', () => {
  // Dying at zero damage taken is possible (a killing blow that lands as the encounter
  // closes, a death to a source the log did not attribute) and is the one fact this
  // view must never hide.
  const snap = damageSnap([], {
    rows: [
      member('Rhale', { damageTaken: 5000, dtps: 40 }),
      member('Aanya', { damageTaken: 0, deaths: 1 }),
      member('Khanvikt', { damageTaken: 0, petDeaths: 1 }),
      member('Emalina', { damageTaken: 0 }),
    ],
  });
  assert.deepEqual(rowsForMetric(snap, 'taken').map((r) => r.name),
    ['Rhale', 'Aanya', 'Khanvikt']);
});

test('an unknown metric falls back to damage rather than emptying the line', () => {
  const snap = damageSnap(GROUP);
  const report = chatReport(snap, 'nonsense');
  assert.equal(report.total, 4);
  assert.match(report.text, /group 3594 dps$/);
});

// ---------------------------------------------------------------- the full line

test('the full line is the fight, the ranking and the group rate', () => {
  const report = chatReport(damageSnap(GROUP), 'damage');
  assert.equal(
    report.text,
    'Vessel of Terror 2:14 — 1) Rhale 1234 (34%) 2) Emalina 980 (27%) '
    + '3) Khanvikt 870 (24%) 4) Aanya 510 (14%) | group 3594 dps',
  );
  assert.equal(report.stage, 0);
  assert.equal(report.shown, 4);
  assert.equal(report.total, 4);
  assert.ok(report.text.length <= CHAT_LIMIT);
});

test('the healing view copies hps, the taken view copies dtps', () => {
  const heals = damageSnap([], {
    groupHps: 1300,
    rows: [
      member('Emalina', { heals: 20, healing: 174_200, hps: 1300, healShare: 1 }),
    ],
  });
  assert.equal(
    chatReport(heals, 'healing').text,
    'Vessel of Terror 2:14 — 1) Emalina 1300 (100%) | group 1300 hps',
  );

  const taken = damageSnap([], {
    groupDtps: 250,
    rows: [member('Rhale', { damageTaken: 33_500, dtps: 250, takenShare: 1 })],
  });
  assert.equal(
    chatReport(taken, 'taken').text,
    'Vessel of Terror 2:14 — 1) Rhale 250 (100%) | group 250 dtps',
  );
});

test('the taken view names who died, and only in that view', () => {
  const snap = damageSnap([], {
    groupDtps: 250,
    groupDps: 1234,
    deaths: [
      { name: 'Aanya', killer: 'a vessel of terror', ts: 0, isPet: false },
      { name: 'Rhale`s warder', killer: 'a vessel of terror', ts: 0, isPet: true },
      { name: 'Aanya', killer: 'a vessel of terror', ts: 0, isPet: false },
      { name: 'Emalina', killer: 'a vessel of terror', ts: 0, isPet: false },
    ],
    rows: [
      member('Rhale', { damageTaken: 20_000, dtps: 150, takenShare: 0.6, damage: 1000, dps: 10, share: 1 }),
      member('Aanya', { damageTaken: 13_500, dtps: 100, takenShare: 0.4, deaths: 2 }),
    ],
  });

  const taken = chatReport(snap, 'taken');
  // Named once each however many times they hit the floor, in the order they fell, and
  // the pet is not among them.
  assert.match(taken.text, /\| deaths: Aanya, Emalina$/);
  assert.ok(!taken.text.includes('warder'));

  // The damage view says nothing about deaths — it is not the question that view asks.
  assert.ok(!chatReport(snap, 'damage').text.includes('deaths'));
});

test('duration reads m:ss, and h:mm:ss on a long fight', () => {
  assert.equal(formatDuration(134_000), '2:14');
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(3_734_000), '1:02:14');
  assert.match(chatReport(damageSnap(GROUP, { durationMs: 3_734_000 }), 'damage').text,
    /^Vessel of Terror 1:02:14 —/);
});

// ---------------------------------------------------------------- the shrink ladder

test('the ladder gives things up in order, and never a name', () => {
  const snap = damageSnap(GROUP);
  const rungs = [];

  // Each pass is given one character less than the last line needed, which is what
  // forces exactly one more rung. Stated as a limit rather than as a widening roster
  // because it pins the ORDER — the argument this table is making — without depending
  // on how many members happen to overrun 255.
  let limit = CHAT_LIMIT;
  for (let expected = 0; expected <= 5; expected++) {
    const report = chatReport(snap, 'damage', { limit });
    assert.equal(report.stage, expected, `expected stage ${expected} at limit ${limit}`);
    assert.ok(report.text.length <= limit, `stage ${expected} overran its own limit`);
    rungs.push(report);
    limit = report.text.length - 1;
  }

  // 0: everything.
  assert.ok(rungs[0].text.includes('(34%)'));
  assert.ok(rungs[0].text.includes('| group 3594 dps'));

  // 1: shares go first — they are derivable from the numbers still on the line.
  assert.ok(!rungs[1].text.includes('%'));
  assert.ok(rungs[1].text.includes('| group 3594 dps'));

  // 2: the group total goes next, for the same reason — it is the sum.
  assert.ok(!rungs[2].text.includes('group'));
  assert.ok(rungs[2].text.startsWith('Vessel of Terror 2:14 —'));

  // 3: the rank prefixes, which say only what the left-to-right order already says.
  // The rates stay exact — see formatRate for why this rung is not an abbreviation.
  assert.ok(!rungs[3].text.includes('1) '));
  assert.ok(rungs[3].text.includes('Rhale 1234'));
  assert.ok(rungs[3].text.startsWith('Vessel of Terror 2:14 —'));

  // 4: the fight's name and duration, leaving the ranking that was asked for.
  assert.ok(!rungs[4].text.includes('Vessel of Terror'));
  assert.ok(rungs[4].text.startsWith('Rhale 1234'));

  // Every rung so far still names all four, in full.
  for (const rung of rungs.slice(0, 5)) {
    assert.equal(rung.shown, 4);
    for (const [name] of GROUP) assert.ok(rung.text.includes(name), `${name} degraded`);
  }

  // 5: only now does anybody go, and the line says so.
  assert.equal(rungs[5].shown, 3);
  assert.ok(rungs[5].text.endsWith('+1 more'));
  assert.ok(!rungs[5].text.includes('Aanya'));
});

test('a widening roster climbs the ladder rather than truncating', () => {
  const names = ['Rhale', 'Emalina', 'Khanvikt', 'Aanya', 'Nubbin', 'Yegoreff', 'Boltran',
    'Shalee', 'Kintaz', 'Sagar', 'Rhain', 'Tervin'];

  let previous = -1;
  for (let size = 2; size <= names.length; size++) {
    const roster = names.slice(0, size).map((n, i) => [n, 1500 - i * 90]);
    const report = chatReport(damageSnap(roster), 'damage');

    assert.ok(report.text.length <= CHAT_LIMIT, `${size} members overran the cap`);
    assert.ok(report.stage >= previous, 'the ladder went backwards as the roster grew');
    previous = report.stage;

    // Whoever is on the line is on it under their own name.
    for (const row of rowsForMetric(damageSnap(roster), 'damage').slice(0, report.shown)) {
      assert.ok(report.text.includes(row.name), `${row.name} degraded at ${size} members`);
    }
  }
  // Twelve members do not fit 255 characters at full width — the line paid something.
  assert.ok(previous >= 1, 'a twelve-member line should have cost something');
});

test('a five-figure rate abbreviates, a four-figure one never does', () => {
  // `12.3k` is the same five characters as `12345`, so the meter's own formatter would
  // shrink nothing; `12k` shrinks and is still within 3% of the truth. `1k` for 1234
  // would not be, so four figures stay exact however tight the line gets.
  const snap = damageSnap([['Rhale', 12_345], ['Emalina', 1234]]);
  const tight = chatReport(snap, 'damage', { limit: 30 });
  assert.ok(tight.text.includes('Rhale 12k'), tight.text);
  assert.ok(tight.text.includes('Emalina 1234') || tight.shown === 1, tight.text);
});

test('a raid roster names everyone it can and admits the rest out loud', () => {
  const roster = Array.from({ length: 24 }, (_, i) => [`Raider${i + 1}`, 2000 - i * 40]);
  const report = chatReport(damageSnap(roster), 'damage');

  assert.equal(report.total, 24);
  assert.ok(report.text.length <= CHAT_LIMIT);

  if (report.shown === 24) {
    for (const [name] of roster) assert.ok(report.text.includes(name));
  } else {
    assert.ok(report.text.endsWith(`+${24 - report.shown} more`));
    for (const [name] of roster.slice(0, report.shown)) {
      assert.ok(report.text.includes(name), `${name} was dropped before the tail`);
    }
  }
});

test('one member with an unshrinkable name is still copied, over-length', () => {
  // Nothing on the ladder can save a line whose single name is longer than the cap. The
  // player can trim it; a button that silently refuses cannot be diagnosed.
  const long = 'X'.repeat(300);
  const report = chatReport(damageSnap([[long, 1234]]), 'damage');
  assert.ok(report.text.includes(long));
  assert.equal(report.shown, 1);
  assert.equal(report.total, 1);
  assert.equal(report.stage, 5);
});

// ---------------------------------------------------------------- nothing to copy

test('an idle snapshot copies nothing at all', () => {
  // The caller leaves the clipboard alone on an empty string. Replacing whatever the
  // player had copied with an empty meter is the worst thing COPY could do.
  const idle = { idle: true, active: false, label: null, durationMs: 0, groupDps: 0, rows: [] };
  assert.deepEqual(chatReport(idle, 'damage'), { text: '', total: 0, shown: 0, stage: 0 });
  assert.deepEqual(chatReport(null, 'damage'), { text: '', total: 0, shown: 0, stage: 0 });
});

test('a fight with rows but no healing copies nothing in the healing view', () => {
  // The meter shows an empty list here, so the copy is empty too — same rows, same rule.
  const snap = damageSnap(GROUP);
  assert.equal(chatReport(snap, 'healing').text, '');
  assert.equal(chatReport(snap, 'damage').total, 4);
});
