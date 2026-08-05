import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogParser, UNKNOWN } from '../src/parser/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'combat-sample.log');

const D = (h, m, s) => `[Fri Jul 31 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} 2026]`;

/** A parser with a controllable clock so tests never depend on wall time. */
function makeParser(opts = {}) {
  let now = new Date(2026, 6, 31, 18, 48, 13).getTime();
  const p = new LogParser({ selfName: 'Rhale', clock: () => now, ...opts });
  p.setNow = (ts) => { now = ts; };
  return p;
}

test('derives the logging character from the log filename', () => {
  const p = new LogParser({ logFilename: 'eqlog_Rhale_oggok.txt' });
  assert.equal(p.selfName, 'Rhale');
  assert.equal(p.server, 'oggok');
});

test('credits "You" to the logging character', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 16)} You crush a froglok shin knight for 40 points of damage.`);
  const snap = p.snapshot();
  assert.equal(snap.rows[0].name, 'Rhale');
  assert.equal(snap.rows[0].damage, 40);
});

test('pet damage lands on the owner, not on a row of its own', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 16)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 48, 23)} Rhale\`s warder hit a froglok shin knight for 71 points of cold damage by Blast of Frost.`);

  const snap = p.snapshot();
  assert.equal(snap.rows.length, 1, 'the warder must not get its own row');
  assert.equal(snap.rows[0].name, 'Rhale');
  assert.equal(snap.rows[0].damage, 111);
  assert.equal(snap.rows[0].petDamage, 71);
  assert.equal(snap.rows[0].playerDamage, 40);
});

test('incoming damage opens the fight and scores as taken, never as dealt', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 13)} A froglok shin knight hits Rhain for 58 points of damage.`);
  const opened = p.snapshot();
  assert.equal(opened.active, true);
  assert.equal(opened.totalDamage, 0, 'incoming damage must never inflate outgoing DPS');
  assert.equal(opened.totalDamageTaken, 58);

  p.feed(`${D(18, 48, 15)} Rhain smites a froglok shin knight for 11 points of damage.`);
  const snap = p.snapshot();
  assert.equal(snap.totalDamage, 11);
  assert.equal(snap.rows.length, 1);
  assert.equal(snap.rows[0].damageTaken, 58);
});

test('a mob killing another mob never enters the parse', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 13)} A froglok shin knight cleaves a shriveled mummy for 20 points of damage.`);
  assert.equal(p.snapshot().rows.length, 0);
});

test('quoted combat text in chat is not scored', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 13)} Hlep tells General:1, 'Rhain hits a froglok for 9999 points of damage.'`);
  assert.equal(p.snapshot().idle, true);
});

test('fall damage does not open a phantom encounter', () => {
  // Every unattributed non-melee line in the Phase 0 sample was fall damage, proven by
  // the "YOU were injured by falling." line following each one.
  const p = makeParser();
  p.feed(`${D(18, 28, 8)} You were hit by non-melee for 6 damage.`);
  p.feed(`${D(18, 28, 8)} YOU were injured by falling.`);
  assert.equal(p.snapshot().idle, true);
  assert.equal(p.current, null);
});

test('unattributed damage on a mob goes to the sole caster in flight', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 22)} Rhain begins casting Lightning Strike.`);
  p.feed(`${D(18, 48, 23)} A froglok shin knight was hit by non-melee for 200 damage.`);

  const row = p.snapshot().rows[0];
  assert.equal(row.name, 'Rhain');
  assert.equal(row.damage, 200);
  assert.equal(row.abilities[0].name, 'Lightning Strike');
});

test('ambiguous unattributed damage goes to Unknown rather than a guess', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 22)} Rhain begins casting Lightning Strike.`);
  p.feed(`${D(18, 48, 22)} Emalina begins casting Blast of Frost.`);
  p.feed(`${D(18, 48, 23)} A froglok shin knight was hit by non-melee for 200 damage.`);

  const rows = p.snapshot().rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, UNKNOWN);
  assert.equal(rows[0].damage, 200);
});

test('a stale cast outside the 2s window does not get the credit', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 10)} Rhain begins casting Lightning Strike.`);
  p.feed(`${D(18, 48, 23)} A froglok shin knight was hit by non-melee for 200 damage.`);
  assert.equal(p.snapshot().rows[0].name, UNKNOWN);
});

test('a lone miss does not start an encounter', () => {
  // Otherwise a stray swing at a passing mob opens a 0-damage fight whose duration
  // grows forever, dragging every later DPS number down.
  const p = makeParser();
  p.feed(`${D(18, 48, 15)} Rhain tries to frenzy on a froglok shin knight, but misses!`);
  assert.equal(p.current, null);
  assert.equal(p.snapshot().idle, true);
});

test('misses inside a fight count toward accuracy', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 15)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 48, 16)} You try to kick a froglok shin knight, but miss!`);
  p.feed(`${D(18, 48, 16)} You try to crush a froglok shin knight, but a froglok shin knight dodges!`);

  const row = p.snapshot().rows[0];
  assert.equal(row.hits, 1);
  assert.equal(row.misses, 2);
});

test('zoning ends the encounter', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 15)} You crush a froglok shin knight for 40 points of damage.`);
  assert.equal(p.snapshot().active, true);

  p.feed(`${D(18, 49, 1)} LOADING, PLEASE WAIT...`);
  p.feed(`${D(18, 49, 13)} You have entered The Ruins of Old Guk 2 (Adaptive).`);

  const snap = p.snapshot();
  assert.equal(snap.active, false);
  assert.equal(snap.zone, 'The Ruins of Old Guk 2 (Adaptive)');
  assert.equal(snap.totalDamage, 40, 'the finished fight stays on screen');
});

test('the last fight stays readable after combat ends', () => {
  const p = makeParser({ timeoutMs: 15_000 });
  p.feed(`${D(18, 48, 15)} You crush a froglok shin knight for 40 points of damage.`);

  p.setNow(new Date(2026, 6, 31, 18, 50, 0).getTime());
  p.tick();

  const snap = p.snapshot();
  assert.equal(snap.active, false);
  assert.equal(snap.totalDamage, 40);
  assert.equal(snap.durationMs, 1000, 'duration freezes at the last hit');
});

test('a new pull starts a fresh encounter', () => {
  const p = makeParser({ timeoutMs: 15_000 });
  p.feed(`${D(18, 48, 15)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 49, 30)} You crush a froglok wizard for 10 points of damage.`);

  const snap = p.snapshot();
  assert.equal(snap.active, true);
  assert.equal(snap.totalDamage, 10, 'the previous fight must not carry over');
});

test('reset clears everything', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 15)} You crush a froglok shin knight for 40 points of damage.`);
  p.reset();
  assert.equal(p.snapshot().idle, true);
});

test('group-only mode hides players outside the group', () => {
  const p = makeParser({ groupOnly: true });
  p.feed(`${D(18, 47, 0)} Rhain has joined the group.`);
  p.feed(`${D(18, 48, 15)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 48, 15)} Rhain smites a froglok shin knight for 11 points of damage.`);
  p.feed(`${D(18, 48, 15)} Passerby smites a froglok shin knight for 500 points of damage.`);

  const names = p.snapshot().rows.map((r) => r.name);
  assert.deepEqual(names.sort(), ['Rhain', 'Rhale']);

  p.setGroupOnly(false);
  assert.equal(p.snapshot().rows.length, 3);
});

// ---------------------------------------------------------------------------
// End-to-end against the real captured session.
//
// Expected values below were computed BY HAND from the fight at 18:48:13-18:48:29
// in tests/fixtures/combat-sample.log (a froglok shin knight in The Ruins of Old Guk),
// so this asserts the pipeline against an independent reading of the log rather than
// against its own output.
// ---------------------------------------------------------------------------

test('end-to-end: the captured froglok fight totals match a hand count', () => {
  const text = fs.readFileSync(FIXTURE, 'latin1');
  const p = new LogParser({ logFilename: 'eqlog_Rhale_oggok.txt', clock: () => Date.now() });
  p.feedChunk(text);

  const snap = p.snapshot();

  assert.equal(snap.label, 'froglok shin knight');
  assert.equal(snap.active, false, 'the mob died, so the fight is closed');

  // 18:48:13 (first swing landed) -> 18:48:29 (last damage) = 16s
  assert.equal(snap.durationMs, 16_000);

  const byName = Object.fromEntries(snap.rows.map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(byName).sort(), ['Rhain', 'Rhale']);

  // Rhale: 592 melee+spell of his own, plus 133 from his warder.
  assert.equal(byName.Rhale.playerDamage, 592);
  assert.equal(byName.Rhale.petDamage, 133);
  assert.equal(byName.Rhale.damage, 725);
  assert.equal(byName.Rhale.crits, 1);          // the 34-point Crush
  assert.equal(byName.Rhale.maxHit, 126);       // Smiting Strike

  // Rhain: 588, no pet.
  assert.equal(byName.Rhain.damage, 588);
  assert.equal(byName.Rhain.petDamage, 0);
  assert.equal(byName.Rhain.crits, 2);          // the 85 Frenzy and the 42 Slash
  assert.equal(byName.Rhain.maxHit, 109);       // Smiting Strike

  assert.equal(snap.totalDamage, 1313);
  assert.equal(snap.groupDps, 1313 / 16);

  // Rows sum to the group total, which is what makes the share percentages honest.
  const dpsSum = snap.rows.reduce((a, r) => a + r.dps, 0);
  assert.ok(Math.abs(dpsSum - snap.groupDps) < 1e-9);
  assert.equal(snap.rows[0].name, 'Rhale');     // sorted highest-first
});

test('end-to-end: no Unknown row appears in the captured session', () => {
  // Every unattributed line in the sample is fall damage against the player, so if an
  // Unknown row shows up here the rules have regressed.
  const text = fs.readFileSync(FIXTURE, 'latin1');
  const p = new LogParser({ logFilename: 'eqlog_Rhale_oggok.txt' });
  p.feedChunk(text);
  assert.equal(p.snapshot().rows.some((r) => r.name === UNKNOWN), false);
});

// ---------------------------------------------------------------------------
// Named summoned pets.
//
// "Gann" is Rhain's animation. It is a pet, but unlike `Rhale`s warder` its name
// carries no ownership marker and is shaped exactly like a player name, so the log
// alone cannot say whose it is.
// ---------------------------------------------------------------------------

test('a configured named pet folds into its owner like a backtick pet does', () => {
  const p = makeParser({ petOwners: { Gann: 'Rhain' } });
  p.feed(`${D(18, 54, 16)} Rhain slashes a froglok shin knight for 100 points of damage.`);
  p.feed(`${D(18, 54, 16)} Gann slashes a froglok shin knight for 12 points of damage.`);
  p.feed(`${D(18, 54, 16)} Gann bashes a froglok shin knight for 1 point of damage.`);

  const snap = p.snapshot();
  assert.equal(snap.rows.length, 1, 'Gann must not get a row of its own');

  const row = snap.rows[0];
  assert.equal(row.name, 'Rhain');
  assert.equal(row.damage, 113);
  assert.equal(row.petDamage, 13);
  assert.equal(row.playerDamage, 100);
  assert.ok(row.abilities.some((a) => a.pet && a.name === 'Slash (pet)'));
});

test('a named pet keeps its own row until it is mapped', () => {
  const p = makeParser();
  p.feed(`${D(18, 54, 16)} Rhain slashes a froglok shin knight for 100 points of damage.`);
  p.feed(`${D(18, 54, 16)} Gann slashes a froglok shin knight for 12 points of damage.`);

  const names = p.snapshot().rows.map((r) => r.name).sort();
  assert.deepEqual(names, ['Gann', 'Rhain'], 'its damage is shown, not silently dropped');
});

test('"Targeted (NPC)" keeps a named pet out of the group roster', () => {
  const p = makeParser({ groupOnly: true });
  p.feed(`${D(18, 47, 0)} Rhain has joined the group.`);
  p.feed(`${D(18, 54, 5)} Targeted (NPC): Gann`);
  p.feed(`${D(18, 54, 16)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 54, 16)} Rhain slashes a froglok shin knight for 100 points of damage.`);
  p.feed(`${D(18, 54, 16)} Gann slashes a froglok shin knight for 12 points of damage.`);

  assert.equal(p.roster.knownNpcs.has('Gann'), true);
  assert.equal(p.roster.includes('Gann', true), false);
  assert.deepEqual(p.snapshot().rows.map((r) => r.name).sort(), ['Rhain', 'Rhale']);
});

test('"Targeted (Player)" confirms a real player', () => {
  const p = makeParser();
  p.feed(`${D(18, 47, 10)} Targeted (Player): Emalina`);
  assert.equal(p.roster.knownPlayers.has('Emalina'), true);
});

test('a pet calling you Master maps itself to you automatically', () => {
  // The only ownership fact the log states outright, and it repeats on every attack
  // command, so the mapping re-establishes itself within seconds of any reset.
  const p = makeParser();
  p.feed(`${D(18, 54, 20)} Gann told you, 'Attacking a froglok shin knight Master.'`);
  assert.equal(p.roster.ownerOf('Gann'), 'Rhale');

  p.feed(`${D(18, 54, 21)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 54, 21)} Gann slashes a froglok shin knight for 12 points of damage.`);

  const snap = p.snapshot();
  assert.equal(snap.rows.length, 1);
  assert.equal(snap.rows[0].name, 'Rhale');
  assert.equal(snap.rows[0].petDamage, 12);
});

test('the pet-Master line is not swallowed as chat', () => {
  const p = makeParser();
  const e = p.feed(`${D(18, 54, 20)} Rhale\`s warder told you, 'I am unable to wake a shin ghoul knight, Master.'`);
  assert.equal(e.kind, 'pet-owner');
});

test('an ordinary tell is still chat', () => {
  const p = makeParser();
  assert.equal(p.feed(`${D(18, 33, 0)} Quartermaster Zevrex told you, 'Welcome to my bank!'`).kind, 'chat');
});

test('settings replace the pet mapping rather than accumulating stale entries', () => {
  const p = makeParser({ petOwners: { Gann: 'Rhain' } });
  p.setPetOwners({ Bixie: 'Emalina' });
  assert.equal(p.roster.ownerOf('Gann'), null);
  assert.equal(p.roster.ownerOf('Bixie'), 'Emalina');
});

test('an unmapped named pet still has its damage counted, not discarded', () => {
  // Once the game reports it as an NPC it is known not to be a player, but its damage
  // is still real group damage. Dropping it would make the group total quietly wrong.
  const p = makeParser();
  p.feed(`${D(18, 54, 5)} Targeted (NPC): Gann`);
  p.feed(`${D(18, 54, 16)} Rhain slashes a froglok shin knight for 100 points of damage.`);
  p.feed(`${D(18, 54, 16)} Gann slashes a froglok shin knight for 12 points of damage.`);

  const snap = p.snapshot();
  assert.deepEqual(snap.rows.map((r) => r.name).sort(), ['Gann', 'Rhain']);
  assert.equal(snap.totalDamage, 112);
});

test('a named mob the group is fighting never becomes a damage row', () => {
  const p = makeParser();
  p.feed(`${D(18, 54, 5)} Targeted (NPC): Zevrex`);
  p.feed(`${D(18, 54, 16)} You crush Zevrex for 40 points of damage.`);
  p.feed(`${D(18, 54, 17)} Zevrex hits Rhale for 30 points of damage.`);
  p.feed(`${D(18, 54, 18)} Zevrex cleaves a froglok shin knight for 99 points of damage.`);

  const snap = p.snapshot();
  assert.deepEqual(snap.rows.map((r) => r.name), ['Rhale']);
  assert.equal(snap.totalDamage, 40, "the mob's own swings are never scored");
});

// ---------------------------------------------------------------------------
// Healing.
//
// "healed X for A (B) hit points" is effective (potential): A actually landed, B is what
// the spell would have restored. The "0 (2)" form on a target already at full health is
// what proves the order, and EQ prints the parenthetical only when they differ — so
// overhealing is exact, not estimated.
// ---------------------------------------------------------------------------

test('healing is credited, with exact overhealing', () => {
  const p = makeParser();
  p.feed(`${D(18, 51, 0)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 51, 4)} Emalina healed Rhain for 119 (139) hit points by Bravery.`);

  const row = p.snapshot().rows.find((r) => r.name === 'Emalina');
  assert.equal(row.healing, 119);
  assert.equal(row.overhealing, 20);
  assert.equal(row.heals, 1);
  assert.equal(row.maxHeal, 119);
  assert.equal(row.healTargets[0].name, 'Rhain');
});

test('a single number means nothing was wasted', () => {
  const p = makeParser();
  p.feed(`${D(18, 51, 0)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 51, 2)} Emalina healed Rhain for 403 hit points by Greater Healing.`);

  const row = p.snapshot().rows.find((r) => r.name === 'Emalina');
  assert.equal(row.healing, 403);
  assert.equal(row.overhealing, 0);
  assert.equal(row.healEfficiency, 1);
});

test('a heal onto a full-health target is all overheal', () => {
  const p = makeParser();
  p.feed(`${D(18, 51, 0)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 51, 2)} Emalina healed herself for 0 (206) hit points by Flowering Heal Trigger.`);

  const row = p.snapshot().rows.find((r) => r.name === 'Emalina');
  assert.equal(row.healing, 0);
  assert.equal(row.overhealing, 206);
  assert.equal(row.healEfficiency, 0);
});

test('a reflexive heal credits the healer as its own target', () => {
  const p = makeParser();
  p.feed(`${D(18, 51, 0)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 51, 2)} Gann healed himself for 57 hit points by Center.`);

  const row = p.snapshot().rows.find((r) => r.name === 'Gann');
  assert.equal(row.healing, 57);
  assert.deepEqual(row.healTargets, [{ name: 'Gann', healing: 57 }]);
});

test('heal-over-time lines are credited too', () => {
  const p = makeParser();
  p.feed(`${D(18, 51, 0)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 51, 2)} You healed Emalina over time for 60 (68) hit points by Flowering Heal.`);

  const row = p.snapshot().rows.find((r) => r.name === 'Rhale');
  assert.equal(row.healing, 60);
  assert.equal(row.overhealing, 8);
  assert.equal(row.healAbilities[0].name, 'Flowering Heal');
});

test('pet healing folds into the owner and stays visible', () => {
  const p = makeParser({ petOwners: { Gann: 'Rhain' } });
  p.feed(`${D(18, 51, 0)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 51, 2)} Rhain healed herself for 100 hit points by Greater Healing.`);
  p.feed(`${D(18, 51, 3)} Gann healed himself for 20 hit points by Blessing of the Squire.`);

  const row = p.snapshot().rows.find((r) => r.name === 'Rhain');
  assert.equal(row.healing, 120);
  assert.equal(row.petHealing, 20);
  assert.equal(row.playerHealing, 100);
  assert.ok(row.healAbilities.some((a) => a.pet && a.name === 'Blessing of the Squire (pet)'));
});

test('healing never starts an encounter', () => {
  // Otherwise buffing and topping the group up between pulls opens a 0-damage fight
  // whose duration keeps growing, dragging the next real fight's DPS down.
  const p = makeParser();
  p.feed(`${D(18, 51, 0)} Emalina healed Rhain for 119 (139) hit points by Bravery.`);
  assert.equal(p.current, null);
  assert.equal(p.snapshot().idle, true);
});

test('healing never extends an encounter either', () => {
  const p = makeParser({ timeoutMs: 15_000 });
  p.feed(`${D(18, 51, 0)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 51, 10)} Emalina healed Rhain for 100 hit points by Bravery.`);
  p.feed(`${D(18, 51, 16)} Emalina healed Rhain for 100 hit points by Bravery.`);

  // 16s after the last damage, so the fight is over despite heals still arriving.
  assert.equal(p.snapshot().active, false);
  assert.equal(p.snapshot().durationMs, 1000);
});

test('group HPS and heal shares are reported alongside damage', () => {
  const p = makeParser();
  p.feed(`${D(18, 51, 0)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 51, 10)} Emalina healed Rhain for 300 hit points by Bravery.`);
  p.feed(`${D(18, 51, 10)} Rhain healed herself for 100 hit points by Center.`);

  const snap = p.snapshot();
  assert.equal(snap.totalHealing, 400);
  assert.equal(snap.groupHps, 400 / (snap.durationMs / 1000));

  const emalina = snap.rows.find((r) => r.name === 'Emalina');
  assert.equal(emalina.healShare, 0.75);
  // Damage figures are still present, so the overlay can switch views instantly.
  assert.equal(snap.totalDamage, 40);
  assert.equal(snap.rows.find((r) => r.name === 'Rhale').damage, 40);
});

test('a mob healing itself is not credited', () => {
  const p = makeParser();
  p.feed(`${D(18, 51, 0)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 51, 2)} A froglok shin knight healed itself for 200 hit points by Ghoul Mending.`);

  assert.equal(p.snapshot().rows.some((r) => r.name === 'froglok shin knight'), false);
  assert.equal(p.snapshot().totalHealing, 0);
});

test("a member's damage shield is credited to them, not dropped", () => {
  const p = makeParser();
  p.feed(`${D(18, 54, 16)} Emalina slashes a wan ghoul knight for 100 points of damage.`);
  p.feed(`${D(18, 54, 17)} A wan ghoul knight is pierced by Emalina's thorns for 8 points of non-melee damage.`);

  const row = p.snapshot().rows.find((r) => r.name === 'Emalina');
  assert.equal(row.damage, 108);
  assert.equal(row.bySource.ds, 8);
});

test('an enemy damage shield hurting us is never credited to anyone', () => {
  const p = makeParser();
  p.feed(`${D(18, 54, 16)} Emalina slashes a wan ghoul knight for 100 points of damage.`);
  p.feed(`${D(18, 54, 17)} Rhain is pierced by a wan ghoul knight's thorns for 8 points of non-melee damage.`);
  p.feed(`${D(18, 54, 17)} YOU are pierced by a wan ghoul knight's thorns for 8 points of non-melee damage!`);

  assert.equal(p.snapshot().totalDamage, 100);
});

// ---------------------------------------------------------------------------
// Charmed pets.
//
// A charmed mob keeps its mob name ("a tal ghoul wizard") but fights for the group, and
// its damage IS logged. EQ Legends emits exactly one charm signal — "<mob> has been
// charmed." — and NO break message at all, so the end of a charm must be inferred.
// ---------------------------------------------------------------------------

test('a charmed mob is credited to whoever cast the charm', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  // Two people casting at once: matching on the SPELL NAME is what picks Rhain.
  p.feed(`${D(19, 20, 1)} Emalina begins casting Greater Healing V.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);
  p.feed(`${D(19, 20, 4)} A tal ghoul wizard slashes a ghoul savant for 40 points of damage.`);
  p.feed(`${D(19, 20, 5)} a tal ghoul wizard hit a ghoul savant for 148 points of magic damage by Lightning Bolt.`);

  const rhain = p.snapshot().rows.find((r) => r.name === 'Rhain');
  assert.equal(rhain.damage, 188);
  assert.equal(rhain.petDamage, 188, "the charmed mob's damage is pet damage");
  assert.equal(p.snapshot().rows.some((r) => r.name === 'tal ghoul wizard'), false);
});

test('mez is not charm', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Mesmerization VIII.`);
  p.feed(`${D(19, 20, 2)} a shin ghoul knight has been mesmerized.`);
  p.feed(`${D(19, 20, 4)} A shin ghoul knight slashes a ghoul savant for 40 points of damage.`);

  const rhain = p.snapshot().rows.find((r) => r.name === 'Rhain');
  assert.equal(rhain, undefined, 'a mezzed mob is asleep, not fighting for us');
});

test('a charm with no charm spell in flight credits nobody', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);
  p.feed(`${D(19, 20, 4)} A tal ghoul wizard slashes a ghoul savant for 40 points of damage.`);

  // Uncounted rather than guessed onto someone.
  assert.equal(p.snapshot().totalDamage, 100);
});

test('charm breaks when the pet turns on the group', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);
  p.feed(`${D(19, 20, 4)} A tal ghoul wizard slashes a ghoul savant for 40 points of damage.`);
  assert.equal(p.roster.isCharmed('a tal ghoul wizard'), true);

  // No break message exists in the log; the ex-pet hitting us is the only signal.
  p.feed(`${D(19, 20, 6)} A tal ghoul wizard hits Emalina for 20 points of damage.`);
  assert.equal(p.roster.isCharmed('a tal ghoul wizard'), false);

  // Its later swings are no longer credited to Rhain.
  p.feed(`${D(19, 20, 8)} A tal ghoul wizard slashes a ghoul savant for 99 points of damage.`);
  assert.equal(p.snapshot().rows.find((r) => r.name === 'Rhain').damage, 40);
});

test('charm breaks when the group turns on the pet, and that hit still counts', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);
  p.feed(`${D(19, 20, 6)} Emalina slashes a tal ghoul wizard for 50 points of damage.`);

  assert.equal(p.roster.isCharmed('a tal ghoul wizard'), false);
  // The line that broke the charm is re-handled, so its damage is not lost.
  assert.equal(p.snapshot().rows.find((r) => r.name === 'Emalina').damage, 150);
});

test('killing the charmed mob ends the charm', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);
  p.feed(`${D(19, 20, 9)} A tal ghoul wizard has been slain by Emalina!`);
  assert.equal(p.roster.isCharmed('a tal ghoul wizard'), false);
});

test('a charmer only holds one charm at a time', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);
  p.feed(`${D(19, 20, 5)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 6)} a wan ghoul knight has been charmed.`);

  assert.equal(p.roster.isCharmed('a tal ghoul wizard'), false, 'the old charm is released');
  assert.equal(p.roster.isCharmed('a wan ghoul knight'), true);
});

test('zoning clears charms', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);
  p.feed(`${D(19, 21, 0)} LOADING, PLEASE WAIT...`);
  assert.equal(p.roster.isCharmed('a tal ghoul wizard'), false);
});

test('a mob-named pet can be mapped in settings despite the article', () => {
  // The lookup path strips articles, so the configured key must be stripped too.
  const p = makeParser({ petOwners: { 'a tal ghoul wizard': 'Rhain' } });
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 4)} A tal ghoul wizard slashes a ghoul savant for 40 points of damage.`);

  const rhain = p.snapshot().rows.find((r) => r.name === 'Rhain');
  assert.equal(rhain.petDamage, 40);
});

test('uncharmed mobs fighting each other are still ignored', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 4)} A tal ghoul wizard slashes a ghoul savant for 40 points of damage.`);
  assert.equal(p.snapshot().totalDamage, 100);
});

// ---------------------------------------------------------------- damage taken

test('incoming melee on YOU lands on the self row, attacker article-stripped', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 13)} A froglok shin knight hits YOU for 30 points of damage.`);
  p.feed(`${D(18, 48, 14)} a froglok shin knight hits YOU for 20 points of damage.`);

  const row = p.snapshot().rows[0];
  assert.equal(row.name, 'Rhale');
  assert.equal(row.damageTaken, 50);
  // "A froglok" and "a froglok" must collapse to ONE attacker entry.
  assert.deepEqual(row.attackers, [{ name: 'froglok shin knight', damage: 50, hits: 2, max: 30 }]);
  assert.equal(row.takenAbilities[0].name, 'Hit');
});

test('a beating taken by the pet folds into the owner, split out like pet damage', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 13)} A froglok shin knight hits Rhale\`s warder for 80 points of damage.`);
  p.feed(`${D(18, 48, 14)} A froglok shin knight hits YOU for 30 points of damage.`);

  const snap = p.snapshot();
  assert.equal(snap.rows.length, 1, 'the warder must not get its own taken row');
  assert.equal(snap.rows[0].damageTaken, 110);
  assert.equal(snap.rows[0].petDamageTaken, 80);
  assert.equal(snap.rows[0].playerDamageTaken, 30);
});

test('incoming DoT ticks and damage shields score as taken', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 13)} You have taken 29 damage from Searing Arrow by a ghoul savant.`);
  p.feed(`${D(18, 48, 14)} YOU are pierced by a wan ghoul knight's thorns for 8 points of non-melee damage!`);

  const row = p.snapshot().rows[0];
  assert.equal(row.name, 'Rhale');
  assert.equal(row.damageTaken, 37);
  assert.deepEqual(row.takenAbilities.map((a) => [a.name, a.damage]), [
    ['Searing Arrow', 29],
    ['Damage Shield', 8],
  ]);
  assert.deepEqual(row.attackers.map((a) => a.name).sort(), ['ghoul savant', 'wan ghoul knight']);
});

test('incoming damage never inflates outgoing DPS, and mob-on-mob still scores nothing', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 13)} A froglok shin knight hits YOU for 30 points of damage.`);
  p.feed(`${D(18, 48, 14)} A froglok shin knight cleaves a shriveled mummy for 20 points of damage.`);

  const snap = p.snapshot();
  assert.equal(snap.totalDamage, 0);
  assert.equal(snap.totalDamageTaken, 30);
  assert.equal(snap.rows.length, 1);
  assert.equal(snap.rows[0].name, 'Rhale');
});

test('incoming avoids are defense credit on the victim row', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 13)} A froglok shin knight hits YOU for 30 points of damage.`);
  p.feed(`${D(18, 48, 14)} A froglok shin knight tries to hit YOU, but YOU dodge!`);
  p.feed(`${D(18, 48, 15)} A froglok shin knight tries to slash YOU, but YOU riposte!`);

  const row = p.snapshot().rows[0];
  assert.equal(row.avoidsTaken, 2);
  assert.deepEqual(row.avoidedTaken, { dodge: 1, riposte: 1 });
});

test('your own death is recorded with its killer, and does not end the pull', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 13)} A froglok king hits YOU for 300 points of damage.`);
  p.feed(`${D(18, 48, 14)} You have been slain by a froglok king!`);

  const snap = p.snapshot();
  assert.equal(snap.active, true, 'a player death must not close the encounter');
  const row = snap.rows.find((r) => r.name === 'Rhale');
  assert.equal(row.deaths, 1);
  assert.deepEqual(snap.deaths.map((d) => [d.name, d.killer]), [['Rhale', 'froglok king']]);
});

test('the pet dying is petDeaths, never the owner\'s own death', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 13)} A froglok king hits Rhale\`s warder for 300 points of damage.`);
  p.feed(`${D(18, 48, 14)} Rhale\`s warder has been slain by a froglok king!`);

  const row = p.snapshot().rows[0];
  assert.equal(row.name, 'Rhale');
  assert.equal(row.deaths, 0);
  assert.equal(row.petDeaths, 1);
});

test('another group member\'s death lands on their row', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 13)} A froglok king hits Rhain for 300 points of damage.`);
  p.feed(`${D(18, 48, 14)} Rhain has been slain by a froglok king!`);

  const row = p.snapshot().rows.find((r) => r.name === 'Rhain');
  assert.equal(row.deaths, 1);
});

test('an NPC death still ends the pull after the grace period (regression)', () => {
  // The death handler grew a friendly branch; the NPC path must be unchanged.
  const p = makeParser({ postKillGraceMs: 3000 });
  p.feed(`${D(18, 48, 13)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 48, 15)} A froglok shin knight has been slain by Rhale!`);
  p.feed(`${D(18, 48, 25)} You have entered The Ruins of Old Guk 2 (Adaptive).`);
  assert.equal(p.snapshot().active, false);
});

test('taken damage buckets by stated type, with the ability carrying its element', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 13)} A froglok shin knight hits YOU for 30 points of damage.`);
  p.feed(`${D(18, 48, 14)} A ghoul savant hit YOU for 100 points of fire damage by Inferno.`);
  p.feed(`${D(18, 48, 15)} You have taken 29 damage from Searing Arrow by a ghoul savant.`);

  const row = p.snapshot().rows[0];
  // Melee is armor's problem, the fire hit names its resist, the DoT line names
  // nothing and must not be guessed at.
  assert.deepEqual(row.takenByType, { melee: 30, fire: 100, untyped: 29 });
  assert.equal(row.takenAbilities.find((a) => a.name === 'Inferno').type, 'fire');
  assert.equal(row.takenAbilities.find((a) => a.name === 'Searing Arrow').type, null);
});

// ------------------------------------------------------------- cast warnings

/** Epoch ms matching the D() log-line timestamps, for explicit snapshot times. */
const T = (h, min, s) => new Date(2026, 6, 31, h, min, s).getTime();

test('a hostile cast raises a warning; friendly-pet and stranger casts do not', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} A cyclops begins casting Instill.`);
  p.feed(`${D(18, 48, 20)} Rhale\`s warder begins casting Healing.`);
  p.feed(`${D(18, 48, 20)} Steven begins casting Gate.`);

  const casts = p.snapshot(T(18, 48, 21)).hostileCasts;
  assert.equal(casts.length, 1, 'only the mob warns — never our pet, never a passing player');
  assert.equal(casts[0].caster, 'cyclops');
  assert.equal(casts[0].ability, 'Instill');
  assert.equal(casts[0].category, 'root');
  assert.equal(casts[0].tier, 2);
});

test('the pull-opening cast warns before any damage line exists', () => {
  // Fights routinely open WITH the mob's first cast; a warning gated on an encounter
  // would miss exactly the cast the group most wants to interrupt.
  const p = makeParser();
  p.feed(`${D(18, 48, 19)} A cyclops begins casting Wrath.`);
  const snap = p.snapshot(T(18, 48, 20));
  assert.equal(snap.idle, true, 'no encounter yet');
  assert.equal(snap.hostileCasts.length, 1);
});

test('a confirmed interrupt clears the warning at once', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} A cyclops begins casting Superior Healing.`);
  assert.equal(p.snapshot(T(18, 48, 20)).hostileCasts.length, 1);
  p.feed(`${D(18, 48, 22)} a cyclops's Superior Healing spell is interrupted.`);
  assert.equal(p.snapshot(T(18, 48, 22)).hostileCasts.length, 0);
});

test('an unresolved warning expires after its window', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} A cyclops begins casting Instill.`);
  p.setNow(T(18, 48, 27));
  p.tick();
  assert.equal(p.snapshot(T(18, 48, 27)).hostileCasts.length, 0);
});

test('a dead caster takes its warning with it', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} You crush a cyclops for 40 points of damage.`);
  p.feed(`${D(18, 48, 21)} A cyclops begins casting Superior Healing.`);
  assert.equal(p.snapshot(T(18, 48, 21)).hostileCasts.length, 1);
  p.feed(`${D(18, 48, 22)} A cyclops has been slain by Rhale!`);
  assert.equal(p.snapshot(T(18, 48, 22)).hostileCasts.length, 0);
});

test('an engaged named mob warns even though its name is player-shaped', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 19)} Targeted (NPC): Zevrex`);
  p.feed(`${D(18, 48, 20)} You crush Zevrex for 40 points of damage.`);
  p.feed(`${D(18, 48, 21)} Zevrex begins casting Complete Healing.`);
  const casts = p.snapshot(T(18, 48, 21)).hostileCasts;
  assert.equal(casts.length, 1);
  assert.equal(casts[0].category, 'heal');
});

test('the same mob re-casting refreshes the one warning instead of stacking', () => {
  // Three cyclopes all log as "a cyclops"; whether a repeat came from one mob or two
  // changes nothing about the response, so the warning refreshes rather than piles up.
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} A cyclops begins casting Instill.`);
  p.feed(`${D(18, 48, 24)} A cyclops begins casting Instill.`);
  const casts = p.snapshot(T(18, 48, 24)).hostileCasts;
  assert.equal(casts.length, 1);
  assert.equal(casts[0].remainingMs, 6000);
});

test('zoning clears cast warnings with everything else', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} A cyclops begins casting Instill.`);
  p.feed(`${D(18, 48, 25)} LOADING, PLEASE WAIT...`);
  assert.equal(p.snapshot(T(18, 48, 25)).hostileCasts.length, 0);
});

test('an unlisted spell still warns — unknown is not invisible', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} A cyclops begins casting Utter Doom.`);
  const [c] = p.snapshot(T(18, 48, 20)).hostileCasts;
  assert.equal(c.ability, 'Utter Doom');
  assert.equal(c.category, null);
  assert.equal(c.tier, 0);
});

test('the anonymous classic cast line still warns when the caster is hostile', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} A cyclops begins to cast a spell.`);
  const [c] = p.snapshot(T(18, 48, 20)).hostileCasts;
  assert.equal(c.ability, null);
});

// ------------------------------------------------------------------- summons

test('a boss summon say-line raises an instant tier-3 warning naming the victim', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} Master Yael says, 'You will not evade me, Emalina!'`);
  const [w] = p.snapshot(T(18, 48, 20)).hostileCasts;
  assert.equal(w.category, 'summon');
  assert.equal(w.tier, 3);
  assert.equal(w.caster, 'Master Yael');
  assert.equal(w.victim, 'Emalina');
  assert.equal(w.remainingMs, 5000, 'summons live on their own shorter window');
});

test('a friendly typing the summon sentence in /say never alerts (the troll guard)', () => {
  // summon-say outranks chat now, so this line reaches handleSummon looking exactly
  // like Master Yael — isHostileCaster is the only thing between a troll and a cue.
  const p = makeParser();
  p.feed(`${D(18, 48, 19)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(18, 48, 20)} Emalina says, 'You will not evade me, Rhain!'`);
  assert.equal(p.snapshot(T(18, 48, 20)).hostileCasts.length, 0);
});

test('the self-confirmation folds into the say-line warning instead of stacking', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} Master Yael says, 'You will not evade me, Rhale!'`);
  p.feed(`${D(18, 48, 22)} You have been summoned!`);
  const casts = p.snapshot(T(18, 48, 22)).hostileCasts;
  assert.equal(casts.length, 1, 'one yank, one chip');
  assert.equal(casts[0].caster, 'Master Yael');
  assert.equal(casts[0].victim, 'Rhale');
  assert.equal(casts[0].remainingMs, 5000, 'the confirmation refreshed the clock');
});

test('the self-confirmation alone still warns, with no caster to name', () => {
  // The fallback for a mob that words its say-line differently.
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} You have been summoned!`);
  const [w] = p.snapshot(T(18, 48, 20)).hostileCasts;
  assert.equal(w.category, 'summon');
  assert.equal(w.tier, 3);
  assert.equal(w.caster, null);
  assert.equal(w.victim, 'Rhale');
});

test('a summoned pet is named as the pet, never folded into its owner', () => {
  // The live log has Master Yael yanking Rhale`s warder — the owner stayed put.
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} Master Yael says, 'You will not evade me, Rhale\`s warder!'`);
  const [w] = p.snapshot(T(18, 48, 20)).hostileCasts;
  assert.equal(w.victim, 'Rhale`s warder');
});

test('a summon expires on its own shorter window, before an ordinary warning would', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} Master Yael says, 'You will not evade me, Emalina!'`);
  p.feed(`${D(18, 48, 20)} Master Yael begins casting Inferno.`);
  p.setNow(T(18, 48, 26));
  p.tick();
  const casts = p.snapshot(T(18, 48, 26)).hostileCasts;
  assert.equal(casts.length, 1, 'the 6s cast warning outlives the 5s summon chip');
  assert.equal(casts[0].ability, 'Inferno');
});

test('interrupting the summoner leaves the summon announcement standing', () => {
  // A summon is a fact that already happened, not a cast in progress.
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} Master Yael says, 'You will not evade me, Emalina!'`);
  p.feed(`${D(18, 48, 21)} Master Yael begins casting Inferno.`);
  p.feed(`${D(18, 48, 22)} Master Yael's Inferno spell is interrupted.`);
  const casts = p.snapshot(T(18, 48, 22)).hostileCasts;
  assert.equal(casts.length, 1, 'the interrupt clears the cast, never the summon');
  assert.equal(casts[0].category, 'summon');
});

// ---------------------------------------------------------- member CC states

test('a stun on the player raises a state chip and the end-line clears it', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} You are stunned!`);
  const fx = p.snapshot(T(18, 48, 20)).memberEffects;
  assert.deepEqual(fx, [{ who: 'Rhale', effect: 'stun', remainingMs: 30_000 }]);

  p.feed(`${D(18, 48, 23)} You are no longer stunned.`);
  assert.equal(p.snapshot(T(18, 48, 23)).memberEffects.length, 0);
});

test('the mez family folds onto one state; awakened ends it', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} Emalina has been mesmerized.`);
  p.feed(`${D(18, 48, 21)} Emalina has been entranced.`);
  const fx = p.snapshot(T(18, 48, 21)).memberEffects;
  assert.equal(fx.length, 1, 'mesmerized and entranced are the one mez state');
  assert.equal(fx[0].who, 'Emalina');
  assert.equal(fx[0].effect, 'mez');

  p.feed(`${D(18, 48, 24)} Emalina has been awakened by Rhain.`);
  assert.equal(p.snapshot(T(18, 48, 24)).memberEffects.length, 0);
});

test('our own CC landing on mobs never becomes a member state', () => {
  // 535 of the live log's mez lines are the group's enchanter doing their job.
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} a shin ghoul knight has been mesmerized.`);
  p.feed(`${D(18, 48, 21)} a shin ghoul knight has been stunned.`);
  assert.equal(p.snapshot(T(18, 48, 21)).memberEffects.length, 0);
});

test('rooted and poisoned members are deliberately not tracked', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} Emalina has been rooted.`);
  p.feed(`${D(18, 48, 21)} Emalina has been poisoned.`);
  assert.equal(p.snapshot(T(18, 48, 21)).memberEffects.length, 0);
});

test('an enemy charming a group member alerts instead of roster-charming them', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 2)} Emalina has been charmed.`);

  const fx = p.snapshot(T(19, 20, 2)).memberEffects;
  assert.deepEqual(fx.map((s) => [s.who, s.effect]), [['Emalina', 'charm']]);
  assert.equal(p.roster.isCharmed('Emalina'), false, 'a member is never a group pet');
});

test('re-charming an already-charmed mob stays on the mob path (regression)', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);
  // The charmed wizard now resolves to Rhain, who is friendly — the direction
  // branch must see through that fold, or a re-charm reads as an enemy taking him.
  p.feed(`${D(19, 20, 5)} a tal ghoul wizard has been charmed.`);
  assert.equal(p.snapshot(T(19, 20, 5)).memberEffects.length, 0);
  assert.equal(p.roster.isCharmed('a tal ghoul wizard'), true);
});

test('death clears every state the member held', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} A froglok king hits Emalina for 300 points of damage.`);
  p.feed(`${D(18, 48, 21)} Emalina has been mesmerized.`);
  p.feed(`${D(18, 48, 22)} You are stunned!`);
  p.feed(`${D(18, 48, 23)} Emalina has been slain by a froglok king!`);
  const fx = p.snapshot(T(18, 48, 23)).memberEffects;
  assert.deepEqual(fx.map((s) => s.who), ['Rhale'], "only Emalina's states die with her");
});

test('a state with no end-line leaves at the 30s cap, not before', () => {
  // Charm on a member has no break line at all; the cap is the only way out.
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} Emalina has been mesmerized.`);
  p.setNow(T(18, 48, 45));
  p.tick();
  assert.equal(p.snapshot(T(18, 48, 45)).memberEffects.length, 1, '25s in: still mezzed for all we know');
  p.setNow(T(18, 48, 51));
  p.tick();
  assert.equal(p.snapshot(T(18, 48, 51)).memberEffects.length, 0);
});

test('zoning and manual reset both clear member states', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} You are stunned!`);
  p.feed(`${D(18, 48, 21)} LOADING, PLEASE WAIT...`);
  assert.equal(p.snapshot(T(18, 48, 21)).memberEffects.length, 0);

  p.feed(`${D(18, 48, 30)} You are stunned!`);
  p.reset();
  assert.equal(p.snapshot(T(18, 48, 30)).memberEffects.length, 0);
});

test('a repeat of the same effect refreshes the one state instead of stacking', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} You are stunned!`);
  p.feed(`${D(18, 48, 24)} You are stunned!`);
  const fx = p.snapshot(T(18, 48, 24)).memberEffects;
  assert.equal(fx.length, 1);
  assert.equal(fx[0].remainingMs, 30_000, 'the repeat re-anchored the cap');
});

test('different effects on the same member are separate states', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} You are stunned!`);
  p.feed(`${D(18, 48, 21)} You have been entranced.`);
  const fx = p.snapshot(T(18, 48, 21)).memberEffects;
  assert.deepEqual(fx.map((s) => s.effect).sort(), ['mez', 'stun']);

  // The stun ending must not take the mez with it.
  p.feed(`${D(18, 48, 22)} You are no longer stunned.`);
  assert.deepEqual(p.snapshot(T(18, 48, 22)).memberEffects.map((s) => s.effect), ['mez']);
});

// --------------------------------------------------------------- cast timers

test('a named boss casting on a rhythm earns a timer; article trash never does', () => {
  // Casts never extend an encounter, so the fight needs a timeout longer than the
  // cast series to stay open — as a real bossfight's steady damage would keep it.
  const p = makeParser({ timeoutMs: 120_000 });
  p.feed(`${D(18, 48, 0)} You crush Quag Maelstrom for 40 points of damage.`);
  for (const s of [10, 29, 49, 68]) {
    p.feed(`${D(18, 48 + Math.floor(s / 60), s % 60)} Quag Maelstrom begins casting Mana Drain.`);
    p.feed(`${D(18, 48 + Math.floor(s / 60), s % 60)} A cyclops begins casting Instill.`);
  }

  const snap = p.snapshot(T(18, 49, 10));
  assert.equal(snap.castTimers.length, 1, 'the metronomic boss and ONLY the boss');
  const [timer] = snap.castTimers;
  assert.equal(timer.caster, 'Quag Maelstrom');
  assert.equal(timer.ability, 'Mana Drain');
  assert.equal(timer.warm, false);
  assert.ok(timer.dueMs > 0 && timer.dueMs <= timer.intervalMs);
});

test('a stored rhythm arms the timer from the first cast of the next pull', () => {
  const p = makeParser();
  p.setKnownRhythms([
    { caster: 'Quag Maelstrom', ability: 'Mana Drain', intervalMs: 19_000, spreadMs: 1500, samples: 10 },
  ]);
  p.feed(`${D(18, 48, 0)} You crush Quag Maelstrom for 40 points of damage.`);
  p.feed(`${D(18, 48, 10)} Quag Maelstrom begins casting Mana Drain.`);

  const [timer] = p.snapshot(T(18, 48, 15)).castTimers;
  assert.ok(timer, 'one cast plus the prior is enough on a repeat pull');
  assert.equal(timer.warm, true);
  assert.equal(timer.dueMs, 14_000);
});

test('closing a fight exports what it taught; a manual reset exports nothing', () => {
  const learned = [];
  const p = makeParser({ timeoutMs: 120_000, onRhythmsLearned: (l) => learned.push(...l) });
  p.feed(`${D(18, 48, 0)} You crush Quag Maelstrom for 40 points of damage.`);
  for (const s of [10, 29, 49, 68]) {
    p.feed(`${D(18, 48 + Math.floor(s / 60), s % 60)} Quag Maelstrom begins casting Mana Drain.`);
  }
  p.feed(`${D(18, 50, 0)} You have entered The Ruins of Old Guk 2 (Adaptive).`);

  assert.equal(learned.length, 1);
  assert.equal(learned[0].caster, 'Quag Maelstrom');
  assert.equal(learned[0].samples, 3);

  // Second fight, then a manual reset: the tracker forgets without exporting.
  learned.length = 0;
  p.feed(`${D(18, 51, 0)} You crush Quag Maelstrom for 40 points of damage.`);
  for (const s of [10, 29, 49, 68]) {
    p.feed(`${D(18, 51 + Math.floor(s / 60), s % 60)} Quag Maelstrom begins casting Mana Drain.`);
  }
  p.reset();
  assert.equal(learned.length, 0, 'a disowned fight teaches nothing on the record');
});

test('a breath AE with no cast line earns a timer from its landings', () => {
  const p = makeParser({ timeoutMs: 120_000 });
  p.feed(`${D(18, 48, 0)} You crush Lord Nagafen for 40 points of damage.`);
  // Volleys 13s apart, each hitting two group members in the same second; the third
  // volley is wholly resisted — its resist line is the only proof the cycle fired.
  const volley = (s) => {
    const ts = D(18, 48 + Math.floor(s / 60), s % 60);
    p.feed(`${ts} Lord Nagafen hit you for 500 points of fire damage by Lava Breath.`);
    p.feed(`${ts} Lord Nagafen hit Rhale\`s warder for 500 points of fire damage by Lava Breath.`);
  };
  volley(10);
  volley(23);
  p.feed(`${D(18, 48, 36)} You resist Lord Nagafen's Lava Breath!`);
  volley(49);

  const [timer] = p.snapshot(T(18, 48, 50)).castTimers;
  assert.ok(timer, 'landings and resists together must earn the timer');
  assert.equal(timer.caster, 'Lord Nagafen');
  assert.equal(timer.ability, 'Lava Breath');
  assert.equal(timer.intervalMs, 13_000);
});

test('melee swings and DoT ticks never earn timers', () => {
  const p = makeParser({ timeoutMs: 120_000 });
  p.feed(`${D(18, 48, 0)} You crush Lord Nagafen for 40 points of damage.`);
  for (const s of [10, 23, 36, 49]) {
    const ts = D(18, 48 + Math.floor(s / 60), s % 60);
    // Melee is continuous, and DoT ticks are periodic by mechanic, not by decision.
    p.feed(`${ts} Lord Nagafen hits YOU for 100 points of damage.`);
    p.feed(`${ts} You have taken 40 damage from Ignite Blood by Lord Nagafen.`);
  }
  assert.equal(p.snapshot(T(18, 48, 50)).castTimers.length, 0);
});

test('timers vanish when the fight ends', () => {
  const p = makeParser({ timeoutMs: 120_000 });
  p.feed(`${D(18, 48, 0)} You crush Quag Maelstrom for 40 points of damage.`);
  for (const s of [10, 29, 49, 68]) {
    p.feed(`${D(18, 48 + Math.floor(s / 60), s % 60)} Quag Maelstrom begins casting Mana Drain.`);
  }
  assert.equal(p.snapshot(T(18, 49, 10)).castTimers.length, 1);

  p.feed(`${D(18, 49, 15)} You have entered The Ruins of Old Guk 2 (Adaptive).`);
  assert.equal(p.snapshot(T(18, 49, 16)).castTimers.length, 0);
});
