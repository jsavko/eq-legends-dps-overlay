import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_RULES, SESSION_CATEGORIES, matchSessionRule, parseCoin, creatureKey, itemKey,
} from '../src/session/rules.js';
import { SessionTracker } from '../src/session/session.js';
import { LogParser } from '../src/parser/index.js';
import { CHAT_RULE_IDS } from '../src/parser/rules.js';

/**
 * One confirmed sample per rule, read off the live log. The table below is the contract:
 * every rule must match its own line, and `every rule is covered` fails loudly when a
 * rule is added without a sample, which is how a pattern that never fires gets caught
 * before it ships rather than after a session comes back empty.
 */
const SAMPLES = {
  'kill-self': 'You have slain a froglok shin knight!',
  'kill-other': 'A froglok shin knight has been slain by Rhain!',
  'death-self': 'You have been slain by an urd ghoul wizard!',
  'coin-corpse': 'You receive 3 gold, 6 silver and 7 copper from the corpse.',
  'coin-sale': 'You receive 7 gold 2 silver from Wanderer Rakshaazi for the Cyclops Toes(s).',
  'coin-item': 'You received 3 platinum, 2 gold, 1 silver and 4 copper from that item.',
  'coin-split': 'You receive 1 platinum 2 gold as your split.',
  purchase: 'You purchased 1 Spell: Wrath from Zealot Zorshais for  6 platinum 3 gold 9 copper.',
  loot: "--You have looted a Mote of Lesser Potential from a shin ghoul knight's corpse.--",
  'xp-solo': 'You gain experience! (8.001%)',
  'xp-party': 'You gain party experience! (0.769%)',
  'level-up': 'You have gained a level! Welcome to level 28!',
  'level-lost': 'You LOST a level! You are now level 27!',
  'aa-earned': 'You have gained an ability point!  You now have 1 ability point.',
  'aa-spent': 'You have gained the ability "Combat Fury" at a cost of 1 ability points.',
  'aa-improved': 'You have improved Unbound Nature 2 at a cost of 0 ability points.',
  'faction-adjust': 'Your faction standing with Frogloks of Guk has been adjusted by -5.',
  'faction-cap': 'Your faction standing with Undead Frogloks of Guk could not possibly get any worse.',
  'skill-up': 'You have become better at Athletics! (135)',
  tradeskill: 'You have fashioned the items together to create something new: Metal Bits.',
  zone: 'You have entered The Northern Desert of Ro.',
};

test('every rule has a sample and matches it, under its own id', () => {
  for (const rule of SESSION_RULES) {
    const sample = SAMPLES[rule.id];
    assert.ok(sample, `no sample line for rule ${rule.id}`);
    const event = matchSessionRule(sample);
    assert.ok(event, `${rule.id} did not match its own sample: ${sample}`);
    assert.equal(event.rule, rule.id, `${sample} was claimed by ${event.rule}`);
    assert.equal(event.category, rule.category);
  }
});

test('every sample belongs to a real rule', () => {
  const ids = new Set(SESSION_RULES.map((r) => r.id));
  for (const id of Object.keys(SAMPLES)) assert.ok(ids.has(id), `stale sample for ${id}`);
});

test('every rule sits in one of the seven switchable categories', () => {
  for (const rule of SESSION_RULES) {
    assert.ok(SESSION_CATEGORIES.includes(rule.category), `${rule.id}: ${rule.category}`);
  }
});

// ---------------------------------------------------------------------------- the chat guard

/**
 * The one that matters. A player quoting a session line must not score, and the
 * protection is not in this table — it is `rules.js` classifying chat first and the
 * tracker skipping what it labelled. So this asserts the whole chain end to end, across
 * every channel a person can talk on.
 *
 * Note the guard is on the RULE ID, not the event kind: the parser's chat rule answers
 * `player-proof` rather than `chat` for group, guild, raid and auction lines, and an
 * earlier draft of this that checked the kind let every one of them through.
 */
const CHANNELS = [
  (s) => `Spoob tells the guild, '${s}'`,
  (s) => `Spoob tells the group, '${s}'`,
  (s) => `Spoob tells the raid, '${s}'`,
  (s) => `Spoob tells General3:1, '${s}'`,
  (s) => `Spoob says, '${s}'`,
  (s) => `Spoob shouts, '${s}'`,
  (s) => `Spoob auctions, '${s}'`,
  (s) => `Spoob tells you, '${s}'`,
  (s) => `You say, '${s}'`,
  (s) => `You told Rhain, '${s}'`,
];

test('every sample quoted on every channel is speech to the parser', () => {
  const stamp = (body) => `[Fri Jul 31 18:48:29 2026] ${body}`;
  for (const sample of Object.values(SAMPLES)) {
    for (const wrap of CHANNELS) {
      const parser = new LogParser({ selfName: 'Rhale' });
      const quoted = wrap(sample);
      const parsed = parser.feed(stamp(quoted));
      assert.ok(
        parsed && CHAT_RULE_IDS.includes(parsed.rule),
        `not guarded as speech (rule ${parsed?.rule}): ${quoted}`,
      );
    }
  }
});

test('the tracker drops a quoted session line and scores the plain one', () => {
  const stamp = (body) => `[Fri Jul 31 18:48:29 2026] ${body}`;
  const kill = 'You have slain a froglok shin knight!';

  const parser = new LogParser({ selfName: 'Rhale' });
  const tracker = new SessionTracker({ character: 'Rhale' });

  const quoted = stamp(`Spoob tells the guild, '${kill}'`);
  assert.equal(tracker.feed(quoted, parser.feed(quoted)), null);
  assert.equal(tracker.current, null, 'a quoted kill must not even open a session');

  const plain = stamp(kill);
  assert.equal(tracker.feed(plain, parser.feed(plain))?.kind, 'kill');
  assert.equal(tracker.current.killsMine, 1);
});

test('the parser never swallows a plain sample as speech', () => {
  for (const [id, sample] of Object.entries(SAMPLES)) {
    const parser = new LogParser({ selfName: 'Rhale' });
    const event = parser.feed(`[Fri Jul 31 18:48:29 2026] ${sample}`);
    // Most of these the combat parser has no rule for at all, which reads as null here —
    // that is fine and expected. What must never happen is a chat rule claiming one.
    assert.equal(
      Boolean(event && CHAT_RULE_IDS.includes(event.rule)), false,
      `${id} was swallowed as speech`,
    );
  }
});

// ------------------------------------------------------------------------------- coin

test('parseCoin handles every denomination shape in the live log', () => {
  assert.deepEqual(parseCoin('3 gold, 6 silver and 7 copper'),
    { platinum: 0, gold: 3, silver: 6, copper: 7, copperTotal: 367 });
  assert.deepEqual(parseCoin('8 copper'),
    { platinum: 0, gold: 0, silver: 0, copper: 8, copperTotal: 8 });
  assert.deepEqual(parseCoin('1 platinum, 4 gold, 2 silver and 9 copper'),
    { platinum: 1, gold: 4, silver: 2, copper: 9, copperTotal: 1429 });
  // Merchant-sale style: plain spaces, no commas, no "and".
  assert.deepEqual(parseCoin('7 gold 2 silver'),
    { platinum: 0, gold: 7, silver: 2, copper: 0, copperTotal: 720 });
  assert.equal(parseCoin('').copperTotal, 0);
});

test('coin rules never assume all four denominations are present', () => {
  const shapes = [
    'You receive 8 copper from the corpse.',
    'You receive 5 silver and 2 copper from the corpse.',
    'You receive 2 platinum from the corpse.',
    'You receive 9 platinum, 1 gold and 3 copper from the corpse.',
    'You receive 4 platinum, 2 gold, 6 silver and 1 copper from the corpse.',
  ];
  for (const line of shapes) {
    const e = matchSessionRule(line);
    assert.equal(e?.rule, 'coin-corpse', line);
    assert.ok(e.coin.copperTotal > 0, line);
  }
});

test('the corpse rule does not swallow a merchant sale, or vice versa', () => {
  const sale = matchSessionRule(SAMPLES['coin-sale']);
  assert.equal(sale.rule, 'coin-sale');
  assert.equal(sale.source, 'sale');
  assert.equal(sale.merchant, 'Wanderer Rakshaazi');
  assert.equal(sale.item, 'Cyclops Toes');
  assert.equal(sale.coin.copperTotal, 720);

  const corpse = matchSessionRule(SAMPLES['coin-corpse']);
  assert.equal(corpse.source, 'corpse');
});

test('the purchase line survives its double space', () => {
  const e = matchSessionRule(SAMPLES.purchase);
  assert.equal(e.kind, 'spend');
  assert.equal(e.qty, 1);
  assert.equal(e.item, 'Spell: Wrath');
  assert.equal(e.merchant, 'Zealot Zorshais');
  assert.equal(e.coin.copperTotal, 6000 + 300 + 9);
});

// ------------------------------------------------------------------------------ kills

test('kills collapse the two spellings of one creature onto one key', () => {
  const self = matchSessionRule('You have slain a froglok shin knight!');
  const other = matchSessionRule('A froglok shin knight has been slain by Rhain!');
  assert.equal(self.victim, 'froglok shin knight');
  assert.equal(other.victim, 'froglok shin knight');
  assert.equal(self.killer, 'You');
  assert.equal(other.killer, 'Rhain');
});

test('a pet killer arrives raw, backtick and all, for the tracker to resolve', () => {
  const e = matchSessionRule('A froglok shin knight has been slain by Rhale`s warder!');
  assert.equal(e.killer, 'Rhale`s warder');
});

test('creatureKey and itemKey strip the article EQ capitalizes mid-sentence', () => {
  assert.equal(creatureKey('A froglok shin knight'), 'froglok shin knight');
  assert.equal(creatureKey('a froglok shin knight'), 'froglok shin knight');
  assert.equal(creatureKey('Emperor Ssraeshza'), 'Emperor Ssraeshza');
  assert.equal(itemKey('a Mote of Lesser Potential'), 'Mote of Lesser Potential');
  assert.equal(itemKey('an Embroidered Black Cape +2'), 'Embroidered Black Cape +2');
});

// ------------------------------------------------------- experience, levels and ability points

test('xp emits a percentage and its share, never a running total', () => {
  const solo = matchSessionRule('You gain experience! (8.001%)');
  assert.deepEqual(
    { kind: solo.kind, percent: solo.percent, share: solo.share },
    { kind: 'xp', percent: 8.001, share: 'solo' },
  );
  const party = matchSessionRule('You gain party experience! (0.769%)');
  assert.equal(party.share, 'party');
  // Nothing on an xp event may look like an accumulated figure.
  assert.equal('total' in solo, false);
});

test('the ability-point line survives its double space, singular and plural', () => {
  const one = matchSessionRule('You have gained an ability point!  You now have 1 ability point.');
  assert.equal(one.kind, 'aa-earned');
  assert.equal(one.unspent, 1);
  const many = matchSessionRule('You have gained an ability point!  You now have 5 ability points.');
  assert.equal(many.unspent, 5);
});

test('spending and improving an ability are both spend events, improving flagged', () => {
  const spent = matchSessionRule(SAMPLES['aa-spent']);
  assert.deepEqual(
    { ability: spent.ability, cost: spent.cost, improved: spent.improved },
    { ability: 'Combat Fury', cost: 1, improved: undefined },
  );
  const improved = matchSessionRule(SAMPLES['aa-improved']);
  assert.equal(improved.kind, 'aa-spent');
  assert.equal(improved.ability, 'Unbound Nature 2');
  assert.equal(improved.cost, 0);
  assert.equal(improved.improved, true);
});

test('faction caps are recorded in both directions and are not deltas', () => {
  const worse = matchSessionRule('Your faction standing with Undead Frogloks of Guk could not possibly get any worse.');
  assert.deepEqual({ kind: worse.kind, faction: worse.faction, at: worse.at },
    { kind: 'faction-cap', faction: 'Undead Frogloks of Guk', at: 'worse' });
  const better = matchSessionRule('Your faction standing with Emerald Warriors could not possibly get any better.');
  assert.equal(better.at, 'better');
  assert.equal('delta' in better, false);
});

// -------------------------------------------------------------------------- the gate

test('a disabled category never runs its regex', () => {
  const seen = [];
  const isOn = (c) => { seen.push(c); return c !== 'coin'; };
  assert.equal(matchSessionRule(SAMPLES['coin-corpse'], isOn), null);
  assert.ok(seen.includes('coin'), 'the gate should have been consulted for coin');

  // And with it on again, the same line scores.
  assert.equal(matchSessionRule(SAMPLES['coin-corpse'], () => true).rule, 'coin-corpse');
});

test('gating one category leaves the others alone', () => {
  const isOn = (c) => c !== 'kills';
  assert.equal(matchSessionRule(SAMPLES['kill-self'], isOn), null);
  assert.equal(matchSessionRule(SAMPLES.loot, isOn)?.rule, 'loot');
});
