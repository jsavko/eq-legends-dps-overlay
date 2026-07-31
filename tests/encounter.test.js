import test from 'node:test';
import assert from 'node:assert/strict';
import { Encounter } from '../src/parser/encounter.js';

const T0 = new Date(2026, 6, 31, 18, 48, 13).getTime();
const s = (n) => T0 + n * 1000;

function hit(enc, name, amount, second, extra = {}) {
  enc.addDamage({
    name,
    amount,
    ts: s(second),
    source: 'melee',
    ability: 'Crush',
    isPet: false,
    crit: false,
    ...extra,
  });
}

test('sums damage and divides by encounter duration', () => {
  const enc = new Encounter(s(0));
  hit(enc, 'Rhale', 100, 0);
  hit(enc, 'Rhale', 100, 10);

  const snap = enc.snapshot(s(10));
  assert.equal(snap.totalDamage, 200);
  assert.equal(snap.durationMs, 10_000);
  assert.equal(snap.groupDps, 20);
  assert.equal(snap.rows[0].dps, 20);
});

test('every row uses the encounter duration so rows sum to the group total', () => {
  const enc = new Encounter(s(0));
  hit(enc, 'Rhale', 300, 0);
  hit(enc, 'Rhain', 100, 8);   // joined late; still divided by the full 10s

  const snap = enc.snapshot(s(10));
  const rowSum = snap.rows.reduce((acc, r) => acc + r.dps, 0);
  assert.ok(Math.abs(rowSum - snap.groupDps) < 1e-9);
  assert.equal(snap.rows[0].name, 'Rhale');
  assert.equal(snap.rows[0].share, 0.75);
  assert.equal(snap.rows[1].share, 0.25);
});

test('a fight inside a single second does not divide by zero', () => {
  // Log timestamps have one-second resolution, so this is a real case, not a corner case.
  const enc = new Encounter(s(0));
  hit(enc, 'Rhale', 500, 0);
  const snap = enc.snapshot(s(0));
  assert.equal(snap.durationMs, 1000);
  assert.equal(snap.groupDps, 500);
  assert.ok(Number.isFinite(snap.rows[0].dps));
});

test('rows sort by damage, highest first', () => {
  const enc = new Encounter(s(0));
  hit(enc, 'Gann', 10, 0);
  hit(enc, 'Rhale', 500, 0);
  hit(enc, 'Rhain', 200, 0);
  const names = enc.snapshot(s(1)).rows.map((r) => r.name);
  assert.deepEqual(names, ['Rhale', 'Rhain', 'Gann']);
});

test('pet damage folds into the owner but stays separately visible', () => {
  const enc = new Encounter(s(0));
  hit(enc, 'Rhale', 100, 0);
  hit(enc, 'Rhale', 71, 1, { isPet: true, source: 'spell', ability: 'Blast of Frost' });

  const row = enc.snapshot(s(1)).rows[0];
  assert.equal(row.damage, 171);
  assert.equal(row.petDamage, 71);
  assert.equal(row.playerDamage, 100);

  // Pet abilities get their own row so "your Crush" and the warder's are distinguishable.
  const petAbility = row.abilities.find((a) => a.pet);
  assert.equal(petAbility.name, 'Blast of Frost (pet)');
  assert.equal(petAbility.damage, 71);
});

test('tracks crits, max hit, source buckets and per-ability totals', () => {
  const enc = new Encounter(s(0));
  hit(enc, 'Rhale', 34, 0, { crit: true });
  hit(enc, 'Rhale', 16, 0);
  hit(enc, 'Rhale', 126, 1, { source: 'spell', ability: 'Smiting Strike' });

  const row = enc.snapshot(s(1)).rows[0];
  assert.equal(row.crits, 1);
  assert.equal(row.maxHit, 126);
  assert.equal(row.bySource.melee, 50);
  assert.equal(row.bySource.spell, 126);
  assert.equal(row.abilities[0].name, 'Smiting Strike');
  assert.equal(row.abilities[0].damage, 126);
  assert.equal(row.abilities[1].name, 'Crush');
  assert.equal(row.abilities[1].hits, 2);
  assert.equal(row.abilities[1].crits, 1);
});

test('misses lower accuracy without lowering DPS', () => {
  const enc = new Encounter(s(0));
  hit(enc, 'Rhale', 100, 0);
  enc.addMiss({ name: 'Rhale', ts: s(0), isPet: false, ability: 'Crush' });
  enc.addMiss({ name: 'Rhale', ts: s(1), isPet: false, ability: 'Crush' });

  const row = enc.snapshot(s(1)).rows[0];
  assert.equal(row.hits, 1);
  assert.equal(row.misses, 2);
  assert.ok(Math.abs(row.accuracy - 1 / 3) < 1e-9);
  assert.equal(row.damage, 100);
  // The ability row keeps hits and misses apart so accuracy stays meaningful.
  assert.equal(row.abilities[0].hits, 1);
  assert.equal(row.abilities[0].misses, 2);
});

test('rolling window only counts the trailing 10 seconds', () => {
  const enc = new Encounter(s(0));
  hit(enc, 'Rhale', 1000, 0);    // ages out
  hit(enc, 'Rhale', 200, 25);
  hit(enc, 'Rhale', 300, 30);

  const row = enc.snapshot(s(30)).rows[0];
  assert.equal(row.rollingDps, 50);           // (200 + 300) / 10s
  assert.equal(row.dps, 1500 / 30);           // encounter DPS is unaffected
});

test('rolling window divides by elapsed time while the fight is younger than the window', () => {
  const enc = new Encounter(s(0));
  hit(enc, 'Rhale', 400, 0);
  hit(enc, 'Rhale', 400, 4);
  const row = enc.snapshot(s(4)).rows[0];
  assert.equal(row.rollingDps, 200);          // 800 / 4s, not 800 / 10s
});

test('closes on the idle timeout', () => {
  const enc = new Encounter(s(0), { timeoutMs: 15_000 });
  hit(enc, 'Rhale', 100, 0);

  assert.equal(enc.update(s(14)), false);
  assert.equal(enc.closed, false);
  assert.equal(enc.update(s(15)), true);
  assert.equal(enc.closed, true);
  assert.equal(enc.closeReason, 'timeout');
});

test('a closed encounter freezes its duration instead of counting on', () => {
  const enc = new Encounter(s(0), { timeoutMs: 15_000 });
  hit(enc, 'Rhale', 100, 0);
  hit(enc, 'Rhale', 100, 10);
  enc.update(s(25));

  assert.equal(enc.closed, true);
  const snap = enc.snapshot(s(600));
  assert.equal(snap.durationMs, 10_000);      // frozen at the last damage, not 600s
  assert.equal(snap.groupDps, 20);
});

test('closes shortly after the last engaged NPC dies', () => {
  const enc = new Encounter(s(0), { timeoutMs: 15_000, postKillGraceMs: 3000 });
  enc.engage('froglok shin knight', 100);
  hit(enc, 'Rhale', 100, 0);
  enc.npcDied('froglok shin knight', s(2));

  assert.equal(enc.update(s(3)), false);      // still inside the grace period
  assert.equal(enc.update(s(5)), true);
  assert.equal(enc.closeReason, 'killed');
});

test('an add still alive keeps the encounter open past the kill', () => {
  // Mob names are generic, so a death line cannot prove the pull is over. Damage
  // arriving during the grace period is what distinguishes the two cases.
  const enc = new Encounter(s(0), { postKillGraceMs: 3000 });
  enc.engage('froglok shin knight', 100);
  hit(enc, 'Rhale', 100, 0);
  enc.npcDied('froglok shin knight', s(2));

  enc.engage('froglok shin knight', 50);
  hit(enc, 'Rhale', 50, 3);                   // the second one is still up

  assert.equal(enc.update(s(6)), false);
  assert.equal(enc.closed, false);
});

test('the label is whichever mob took the most damage', () => {
  const enc = new Encounter(s(0));
  enc.engage('froglok shin knight', 50);
  enc.engage('froglok wizard', 500);
  assert.equal(enc.snapshot(s(1)).label, 'froglok wizard');
});

test('falls back to "Combat" with no engaged NPC', () => {
  const enc = new Encounter(s(0));
  hit(enc, 'Rhale', 10, 0);
  assert.equal(enc.snapshot(s(1)).label, 'Combat');
});

test('includeNames filters rows and rebases the shares', () => {
  const enc = new Encounter(s(0));
  hit(enc, 'Rhale', 100, 0);
  hit(enc, 'Randomguy', 100, 0);

  const snap = enc.snapshot(s(1), { includeNames: (n) => n === 'Rhale' });
  assert.equal(snap.rows.length, 1);
  assert.equal(snap.totalDamage, 100);
  assert.equal(snap.rows[0].share, 1);
});
