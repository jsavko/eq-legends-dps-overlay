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
  // Rhain needs STANDING before he can be credited with damage nobody was named for.
  // A single capitalized token nobody has proven anything about is "unknown", not a
  // player — that guess is what made a Plane of Sky bee a group member.
  p.feed(`${D(18, 48, 20)} Rhain smites a froglok shin knight for 11 points of damage.`);
  p.feed(`${D(18, 48, 22)} Rhain begins casting Lightning Strike.`);
  p.feed(`${D(18, 48, 23)} A froglok shin knight was hit by non-melee for 200 damage.`);

  const row = p.snapshot().rows[0];
  assert.equal(row.name, 'Rhain');
  assert.equal(row.damage, 211);
  assert.equal(row.abilities.find((a) => a.name === 'Lightning Strike').damage, 200);
});

test('an unproven caster is not credited with unattributed damage', () => {
  const p = makeParser();
  // Identical to the test above minus the swing that established Rhain. Nothing in the
  // log has said whether "Rhain" is a groupmate, a passer-by or a single-token mob, so
  // the damage lands in the visible Unknown row instead of being guessed onto him.
  p.feed(`${D(18, 48, 22)} Rhain begins casting Lightning Strike.`);
  p.feed(`${D(18, 48, 23)} A froglok shin knight was hit by non-melee for 200 damage.`);

  const row = p.snapshot().rows[0];
  assert.equal(row.name, 'Unknown');
  assert.equal(row.damage, 200);
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

test('with no party list, everyone the log sees gets a row', () => {
  const p = makeParser();
  // A group line used to be the trigger for the old filter: `hasExplicitData` flipped
  // true and everyone who predated it silently vanished. It must now change nothing.
  p.feed(`${D(18, 47, 0)} Rhain has joined the group.`);
  p.feed(`${D(18, 48, 15)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 48, 15)} Rhain smites a froglok shin knight for 11 points of damage.`);
  p.feed(`${D(18, 48, 15)} Passerby smites a froglok shin knight for 500 points of damage.`);

  const names = p.snapshot().rows.map((r) => r.name).sort();
  assert.deepEqual(names, ['Passerby', 'Rhain', 'Rhale']);
});

test('a party list is applied literally, and only to the rows', () => {
  const p = makeParser({ partyMembers: ['Rhale', 'Rhain'] });
  p.feed(`${D(18, 48, 15)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 48, 15)} Rhain smites a froglok shin knight for 11 points of damage.`);
  p.feed(`${D(18, 48, 15)} Passerby smites a froglok shin knight for 500 points of damage.`);

  assert.deepEqual(p.snapshot().rows.map((r) => r.name).sort(), ['Rhain', 'Rhale']);

  // Nothing about the fight changed — only which of its rows were drawn. Clearing the
  // list shows the same numbers that were being computed all along.
  p.setPartyMembers([]);
  const all = p.snapshot().rows;
  assert.equal(all.length, 3);
  assert.equal(all.find((r) => r.name === 'Passerby').damage, 500);
  assert.equal(all.find((r) => r.name === 'Rhain').damage, 11);
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
  const p = makeParser();
  p.feed(`${D(18, 47, 0)} Rhain has joined the group.`);
  p.feed(`${D(18, 54, 5)} Targeted (NPC): Gann`);
  p.feed(`${D(18, 54, 16)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 54, 16)} Rhain slashes a froglok shin knight for 100 points of damage.`);
  p.feed(`${D(18, 54, 16)} Gann slashes a froglok shin knight for 12 points of damage.`);

  assert.equal(p.roster.knownNpcs.has('Gann'), true);
  assert.equal(p.roster.includes('Gann'), false, 'not a member, whatever its name looks like');
  // It still gets a row: it is fighting our mob and its damage is real group damage,
  // so dropping it would make the group total quietly wrong. See isUnownedPet.
  assert.deepEqual(p.snapshot().rows.map((r) => r.name).sort(), ['Gann', 'Rhain', 'Rhale']);
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
// charmed." — and a break message ONLY for your own charm (the worn-off line); everyone
// else's end must be inferred.
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

test('a charm with no charm spell in flight gets its own row, not somebody else\'s', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);
  p.feed(`${D(19, 20, 4)} A tal ghoul wizard slashes a ghoul savant for 40 points of damage.`);

  // It is helping kill the mob we are on, so it counts — under its own name, because
  // the charmer could not be identified and guessing one was never the honest option.
  // Discarding it was the OTHER dishonest option, and it cost 84,676 damage in the live
  // log from a single loathling lich.
  const snap = p.snapshot();
  assert.equal(snap.totalDamage, 140);
  assert.equal(snap.rows.find((r) => r.name === 'tal ghoul wizard').damage, 40);
  assert.equal(snap.rows.find((r) => r.name === 'Emalina').damage, 100);
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

test('your worn-off line ending a live charm announces the break', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);

  const e = p.feed(`${D(19, 20, 30)} Your Beguile spell has worn off of a tal ghoul wizard.`);
  assert.equal(e.charmBroke, true, 'the returned event carries the signal');
  assert.equal(p.roster.isCharmed('a tal ghoul wizard'), false);

  // And the alerts window is told, through the same list summons ride: tier 3, the
  // freed mob in the victim slot, retiring on its own TTL.
  const warn = p.snapshot().hostileCasts.find((c) => c.category === 'charm-break');
  assert.ok(warn, 'a charm break raises a warning chip');
  assert.equal(warn.tier, 3);
  assert.equal(warn.victim, 'tal ghoul wizard');
});

test('a DoT fading is not a charm break', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);

  const e = p.feed(`${D(19, 20, 30)} Your Drifting Death spell has worn off of Master Yael.`);
  assert.equal(e.charmBroke, undefined);
  assert.equal(p.snapshot().hostileCasts.some((c) => c.category === 'charm-break'), false);
  assert.equal(p.roster.isCharmed('a tal ghoul wizard'), true, 'the charm is untouched');
});

test('a charm-family worn-off with no live charm behind it raises nothing', () => {
  // The wording alone is not the signal — the parser must have seen the charm land.
  // A worn-off for a charm that already ended (killed, zoned, re-charmed elsewhere)
  // would otherwise warn about a mob that is not turning on anybody.
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  const e = p.feed(`${D(19, 20, 30)} Your Beguile spell has worn off of a tal ghoul wizard.`);
  assert.equal(e.charmBroke, undefined);
  assert.equal(p.snapshot().hostileCasts.some((c) => c.category === 'charm-break'), false);
});

test('the charmed mob dying is an uncharm but never a charm-break warning', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);
  p.feed(`${D(19, 20, 9)} A tal ghoul wizard has been slain by Emalina!`);

  assert.equal(p.roster.isCharmed('a tal ghoul wizard'), false);
  assert.equal(p.snapshot().hostileCasts.some((c) => c.category === 'charm-break'), false,
    'a fight ending is not a mob turning');
});

test('an inferred break of somebody else\'s charm raises no warning either', () => {
  // Other people's charms end by friendly-fire inference, well after the fact — stale
  // news about somebody else's pet, not a call for the logging character to act.
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);
  p.feed(`${D(19, 20, 6)} A tal ghoul wizard hits Emalina for 20 points of damage.`);

  assert.equal(p.roster.isCharmed('a tal ghoul wizard'), false);
  assert.equal(p.snapshot().hostileCasts.some((c) => c.category === 'charm-break'), false);
});

test('a mob-named pet can be mapped in settings despite the article', () => {
  // The lookup path strips articles, so the configured key must be stripped too.
  const p = makeParser({ petOwners: { 'a tal ghoul wizard': 'Rhain' } });
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 4)} A tal ghoul wizard slashes a ghoul savant for 40 points of damage.`);

  const rhain = p.snapshot().rows.find((r) => r.name === 'Rhain');
  assert.equal(rhain.petDamage, 40);
});

test('your own charm break line frees the mob at once, before it swings', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} You begin casting Charm.`);
  p.feed(`${D(19, 20, 2)} a skeletal monk has been charmed.`);
  assert.equal(p.roster.ownerOf('a skeletal monk'), 'Rhale');

  // (confirmed live, Aug 13) The log announces the end of YOUR charm outright. Waiting
  // for the freed mob's first swing instead left a hostile mob resolving to its
  // ex-charmer, and everything it did — and everything done to it — read as friendly
  // fire and was dropped.
  p.feed(`${D(19, 20, 30)} Your Charm spell has worn off of a skeletal monk.`);
  assert.equal(p.roster.ownerOf('a skeletal monk'), null);

  // Its next swing at us is damage taken, not self-damage and not a charm inference.
  p.feed(`${D(19, 20, 31)} A skeletal monk punches YOU for 10 points of damage.`);
  assert.equal(p.snapshot().rows.find((r) => r.name === 'Rhale').damageTaken, 10);
});

test('a worn-off line for a non-charm spell changes nothing', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);
  p.feed(`${D(19, 20, 10)} Your Stinging Swarm spell has worn off of a tal ghoul wizard.`);
  assert.equal(p.roster.isCharmed('a tal ghoul wizard'), true, 'a DoT fading is not a charm break');
});

test('a charm mapping reaches the " pet" spelling the pet actually fights under', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a dark boned skeleton has been charmed.`);

  // The game writes every pet that is not your own as `<base> pet`, while the charm
  // line uses the plain name — 1,354 suffixed lines in the Aug 13 session never matched
  // their mapping, which left the group's own pets scoring as strangers.
  p.feed(`${D(19, 20, 4)} A dark boned skeleton pet slashes a ghoul savant for 40 points of damage.`);
  const rhain = p.snapshot().rows.find((r) => r.name === 'Rhain');
  assert.equal(rhain.damage, 40);
  assert.equal(rhain.petDamage, 40);
  assert.equal(p.snapshot().rows.some((r) => r.name === 'dark boned skeleton pet'), false);
});

test('a mob-named pet reporting to its Master is a charm, never saved config', () => {
  const saved = [];
  const p = makeParser({ onPetOwnersChanged: (m) => saved.push(m) });
  p.feed(`${D(19, 20, 0)} A skeletal monk told you, 'Attacking a lurking mummy Master.'`);

  assert.equal(p.roster.ownerOf('a skeletal monk'), 'Rhale');
  assert.equal(p.roster.petOwners.size, 0, 'a charm gets a charm store, not the durable table');

  // The durable table is persisted wholesale by the next successful command, which is
  // exactly how "basilisk = Rhale" escaped into the live config and branded every wild
  // basilisk 'ours' at every launch since.
  p.feed(`${D(19, 20, 5)} You say, 'pet Kibektik = Khanvikt'`);
  assert.deepEqual(saved.at(-1), { Kibektik: 'Khanvikt' }, 'the monk never reaches disk');

  // And it ends like the charm it is.
  p.feed(`${D(19, 20, 30)} Your Charm spell has worn off of a skeletal monk.`);
  assert.equal(p.roster.ownerOf('a skeletal monk'), null);
});

test('a mob helping kill OUR mob counts; two mobs off on their own do not', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  // Aimed at the mob we are fighting, so it lands. Whether it is charmed, someone
  // else's, or simply a mob that hates this one is not a question the parser can answer
  // and no longer one it has to.
  p.feed(`${D(19, 20, 4)} A tal ghoul wizard slashes a ghoul savant for 40 points of damage.`);
  assert.equal(p.snapshot().totalDamage, 140);

  // Neither end is our fight: still ignored, and still cannot open one.
  p.feed(`${D(19, 20, 5)} A shriveled mummy slashes a rock golem for 500 points of damage.`);
  assert.equal(p.snapshot().totalDamage, 140);
  assert.equal(p.snapshot().rows.some((r) => r.name === 'shriveled mummy'), false);
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
  // The pull has to be opened by something other than the tick itself: an incoming DoT
  // no longer starts a fight (see the succor test below), only joins one.
  p.feed(`${D(18, 48, 12)} You crush a ghoul savant for 40 points of damage.`);
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
  assert.equal(c.group, 'unknown', 'it still needs a switch to answer to');
});

// -------------------------------------------------- warnings clear when they resolve

test('a spell landing clears the warning it was raised for', () => {
  // The chip is a claim that a cast is still in flight. Measured over the live log,
  // 3,857 warnings had their spell land while still on screen, a median of one second
  // in, then sat out the rest of a six-second TTL — 75% of their screen time spent on
  // a cast that was already over.
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} A cyclops begins casting Lightning Bolt.`);
  assert.equal(p.snapshot(T(18, 48, 20)).hostileCasts.length, 1);
  p.feed(`${D(18, 48, 21)} A cyclops hit YOU for 90 points of magic damage by Lightning Bolt.`);
  assert.equal(p.snapshot(T(18, 48, 21)).hostileCasts.length, 0);
});

test('a resist resolves a warning too — the volley fired and we shrugged it off', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} A cyclops begins casting Lightning Bolt.`);
  p.feed(`${D(18, 48, 21)} You resist a cyclops's Lightning Bolt!`);
  assert.equal(p.snapshot(T(18, 48, 21)).hostileCasts.length, 0);
});

test('a landing clears only its own spell, not every warning from that caster', () => {
  // Unlike the interrupt path, which cannot tell WHICH same-named mob was stopped and
  // so is deliberately generous. A damage line names the spell, so there is nothing to
  // be generous about.
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} A cyclops begins casting Lightning Bolt.`);
  p.feed(`${D(18, 48, 20)} A cyclops begins casting Superior Healing.`);
  p.feed(`${D(18, 48, 21)} A cyclops hit YOU for 90 points of magic damage by Lightning Bolt.`);

  const casts = p.snapshot(T(18, 48, 21)).hostileCasts;
  assert.equal(casts.length, 1);
  assert.equal(casts[0].ability, 'Superior Healing', 'the heal is still in flight');
});

test('a melee swing clears nothing — its ability is "Hit", which keys no warning', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} A cyclops begins casting Superior Healing.`);
  p.feed(`${D(18, 48, 21)} A cyclops hits YOU for 45 points of damage.`);
  assert.equal(p.snapshot(T(18, 48, 21)).hostileCasts.length, 1);
});

// ------------------------------------------------------------- the self-buff line

test('a mob buffing itself raises no warning at any setting', () => {
  // Tier -1: identified as not worth a chip, as distinct from tier 0's "not identified
  // at all". Measured over the live log, self-buffs were 2,608 of the 5,260 casts that
  // had no category — more than half the noise, and none of it actionable.
  const p = makeParser();
  p.feed(`${D(18, 48, 20)} A cyclops begins casting Shield of Thistles.`);
  p.feed(`${D(18, 48, 20)} A cyclops begins casting Spirit of Wolf.`);
  const casts = p.snapshot(T(18, 48, 20)).hostileCasts;
  assert.equal(casts.length, 2, 'the parser still records them — the renderer drops them');
  assert.deepEqual(casts.map((c) => c.tier), [-1, -1]);
  assert.deepEqual(casts.map((c) => c.group), ['buff', 'buff']);
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

// ---------------------------------------------------------------------------
// Single-token entity identity.
//
// `looksLikePlayerName` is a guess about SPELLING, and on the Plane of Sky it is
// simply wrong: the bees are "Bzzazzt", "Bazzt", "Bzzzt" — single capitalized tokens
// with no article, indistinguishable from a player name — so the parser read an entire
// raid zone as friendly. Every line below is taken from the live bee fight.
// ---------------------------------------------------------------------------

test('an entity that damages a confirmed member is the enemy, whatever its name looks like', () => {
  const p = makeParser();
  p.feed(`${D(10, 44, 0)} Khanvikt has joined the group.`);
  // Shape says nothing either way now — a bare capitalized token is simply unanswered,
  // which is the whole lesson of the bee island.
  assert.equal(p.standing('Bzzazzt'), null);

  p.feed(`${D(10, 44, 1)} Bzzazzt stings Khanvikt for 47 points of damage.`);

  assert.equal(p.isEnemy('Bzzazzt'), true, 'the fight placed it, not its spelling');
  assert.equal(p.isHostileCaster('Bzzazzt'), true);
  const khan = p.snapshot().rows.find((r) => r.name === 'Khanvikt');
  assert.equal(khan.damageTaken, 47);
});

test('a bee the group attacks becomes hostile too, and its casts raise warnings', () => {
  const p = makeParser();
  // No group message at all: the logging character is the only confirmed member, and
  // hitting the thing is proof enough on its own.
  p.feed(`${D(10, 44, 1)} You pierce Bazzzazzt for 60 points of damage.`);
  assert.equal(p.isEnemy('Bazzzazzt'), true);

  p.feed(`${D(10, 44, 2)} Bazzzazzt begins casting Deadly Poison.`);
  const warning = p.snapshot().hostileCasts.find((c) => c.ability === 'Deadly Poison');
  assert.equal(warning.caster, 'Bazzzazzt');

  // The damage the group did to it now counts, where the whole exchange used to be
  // dropped as a friendly hitting a friendly.
  assert.equal(p.snapshot().rows.find((r) => r.name === 'Rhale').damage, 60);
});

test('a charmed mob turning on the group is a charm break, not a fresh enemy', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} You slash a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} You begin casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);
  assert.equal(p.roster.isCharmed('a tal ghoul wizard'), true);

  // The ex-pet turns on us. This must take the charm-break path — the mob is released
  // and the hit re-scored as ordinary incoming damage — and must NOT leave the mob
  // marked hostile-by-action, which would be a second, redundant claim.
  p.feed(`${D(19, 20, 9)} A tal ghoul wizard slashes YOU for 30 points of damage.`);
  assert.equal(p.roster.isCharmed('a tal ghoul wizard'), false);
  assert.equal(p.snapshot().rows.find((r) => r.name === 'Rhale').damageTaken, 30);
});

// ---------------------------------------------------------------------------
// A charmed group member, and the friendly it used to delete.
//
// Plane of Hate charms group members and EQ Legends prints NOTHING when it takes a
// player — 35 charm lines in the live log, all mobs, none a player. So a member turns
// on the group with no marker, the group's own pets swing at them, and that read as
// proof the pet was an enemy. Permanently: Goneker, a water elemental, lost 1,362
// damage lines and 69,394 damage for the rest of that session, its row simply gone.
//
// Every line below is from the live log at [Sat Aug 08 00:31:47 2026].
// ---------------------------------------------------------------------------

/** The live Goneker scene: a group with Syphon in it, and a pet fighting the boss. */
function charmScene() {
  const p = makeParser();
  p.feed(`${D(0, 31, 40)} Syphon has joined the group.`);
  p.feed(`${D(0, 31, 41)} Taneldar slashes Cleric of Innoruuk for 30 points of damage.`);
  p.feed(`${D(0, 31, 42)} Goneker cleaves Cleric of Innoruuk for 70 points of damage.`);
  return p;
}

test('a friendly pet that swings at a charmed member keeps its row', () => {
  const p = charmScene();

  // Syphon is charmed. Nothing in the log says so; these two lines are all there is —
  // and under the old design the second one deleted Goneker for the rest of the session.
  p.feed(`${D(0, 31, 47)} Goneker cleaves Syphon for 34 points of damage.`);
  p.feed(`${D(0, 31, 47)} Goneker is pierced by Syphon's thorns for 24 points of non-melee damage.`);

  assert.equal(p.isEnemy('Goneker'), false, 'never becomes the enemy');

  // It keeps hitting the boss and keeps being counted. No heal, no proof, no branding:
  // it is contributing to this kill, which is the entire test.
  p.feed(`${D(0, 31, 48)} Goneker backstabs Cleric of Innoruuk for 102 points of damage.`);
  assert.equal(p.snapshot().rows.find((r) => r.name === 'Goneker').damage, 172);
});

test('a charmed member shows up in the damage logs of whoever they hit', () => {
  const p = charmScene();
  p.feed(`${D(0, 31, 47)} Goneker cleaves Syphon for 34 points of damage.`);

  // James: "If I get charmed and start attacking a player it's fine for me to show up
  // in their damage logs." So it lands on the victim, naming who did it.
  const syphon = p.snapshot().rows.find((r) => r.name === 'Syphon');
  assert.equal(syphon.damageTaken, 34);
  assert.deepEqual(syphon.attackers.map((a) => a.name), ['Goneker']);

  // But it is not DPS: that column measures damage done to the enemy, and this was not.
  assert.equal(p.snapshot().rows.find((r) => r.name === 'Goneker').damage, 70);
});

test('the impossible line says on screen that a member has been turned', () => {
  const p = charmScene();
  p.feed(`${D(0, 31, 47)} Goneker cleaves Syphon for 34 points of damage.`);

  const effects = p.snapshot(T(0, 31, 47)).memberEffects;
  assert.deepEqual(effects.map((e) => [e.who, e.effect]), [['Syphon', 'charm']]);
});

test('swinging at the mob again is what ends the charm state', () => {
  const p = charmScene();
  p.feed(`${D(0, 31, 47)} Goneker cleaves Syphon for 34 points of damage.`);
  assert.equal(p.snapshot(T(0, 31, 47)).memberEffects.length, 1);

  p.feed(`${D(0, 31, 55)} Syphon bashes Cleric of Innoruuk for 40 points of damage.`);
  assert.deepEqual(p.snapshot(T(0, 31, 55)).memberEffects, []);
});

test('a heal landing on the enemy is the enemy\'s business, not our HPS', () => {
  const p = makeParser();
  p.feed(`${D(22, 32, 50)} You hit orc legionnaire for 40 points of damage.`);
  // "Bonefire healed orc legionnaire for 20 hit points by Courage." — an orc topping up
  // an orc. The mirror of the damage rule: a heal counts when it lands on our side.
  p.feed(`${D(22, 32, 59)} Bonefire healed orc legionnaire for 20 hit points by Courage.`);

  assert.equal(p.snapshot().totalHealing, 0);
  assert.equal(p.snapshot().rows.some((r) => r.name === 'Bonefire'), false);
});

test('a heal landing on a friendly pet counts, whoever cast it', () => {
  const p = makeParser();
  p.feed(`${D(0, 31, 41)} Taneldar slashes Cleric of Innoruuk for 30 points of damage.`);
  p.feed(`${D(0, 31, 42)} Goneker cleaves Cleric of Innoruuk for 70 points of damage.`);
  p.feed(`${D(0, 31, 43)} Taneldar healed Goneker for 255 hit points by Skin like Nature.`);

  const taneldar = p.snapshot().rows.find((r) => r.name === 'Taneldar');
  assert.equal(taneldar.healing, 255);
  assert.deepEqual(taneldar.healTargets, [{ name: 'Goneker', healing: 255 }]);
});

test('two mobs with the same name are two mobs, not one hitting itself', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} You slash a fire giant warrior for 40 points of damage.`);
  // James: "that's bullshit because it isn't attacking itself, so it should show up as a
  // friendly and a foe". An article means EQ is saying "one of these", so two of them
  // can share a line — and one is almost always the group's charmed pet. Reading it as
  // self-damage threw away 789 lines and 58,916 damage in the live log.
  p.feed(`${D(19, 20, 4)} A fire giant warrior cleaves a fire giant warrior for 100 points of damage.`);

  const snap = p.snapshot();
  assert.equal(snap.rows.find((r) => r.name === 'fire giant warrior').damage, 100);
  assert.equal(snap.totalDamage, 140);
});

test('a mob already fighting for us takes damage like anybody else', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} You slash Lord Nagafen for 40 points of damage.`);
  // It beats on the boss, so it is in this fight...
  p.feed(`${D(19, 20, 2)} A fire giant warrior cleaves Lord Nagafen for 50 points of damage.`);
  // ...and the boss beating back lands on it. Participation is the test, not the name.
  p.feed(`${D(19, 20, 4)} Lord Nagafen cleaves a fire giant warrior for 200 points of damage.`);

  const giant = p.snapshot().rows.find((r) => r.name === 'fire giant warrior');
  assert.equal(giant.damage, 50);
  assert.equal(giant.damageTaken, 200);
  assert.deepEqual(giant.attackers.map((a) => a.name), ['Lord Nagafen']);
});

test('a bystander the boss swats has no business in the fight', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} You slash Lord Nagafen for 40 points of damage.`);
  // Never contributed anything, so it is not in this fight and gets no row — otherwise
  // a stranger's health bar turns up in the "what is killing me" view.
  p.feed(`${D(19, 20, 4)} Lord Nagafen cleaves a shriveled mummy for 300 points of damage.`);

  assert.deepEqual(p.snapshot().rows.map((r) => r.name), ['Rhale']);
  assert.equal(p.snapshot().totalDamageTaken, 0);
});

test('self-damage lands in the taken row, never in DPS', () => {
  const p = makeParser();
  p.feed(`${D(22, 45, 56)} Venun slashes a revultant rat for 45 points of damage.`);
  // A shaman buying mana with life: 18 lines and 20,965 points in the live log. Health
  // spent on mana is a cost, and the taken view is where costs are read.
  p.feed(`${D(22, 45, 57)} Venun hit Venun for 1924 points of unresistable damage by Cannibalization I.`);

  assert.equal(p.isEnemy('Venun'), false);
  assert.equal(p.standing('Venun'), 'ours');
  const venun = p.snapshot().rows.find((r) => r.name === 'Venun');
  assert.equal(venun.damage, 45, 'not counted as DPS');
  assert.equal(venun.damageTaken, 1924);
  // Named as their own attacker, because that is what the line says happened.
  assert.deepEqual(venun.attackers.map((a) => a.name), ['Venun']);
  assert.equal(venun.takenAbilities[0].name, 'Cannibalization I');
  assert.equal(venun.takenByType.unresistable, 1924);
});

test('self-damage between pulls never opens a fight', () => {
  const p = makeParser();
  // Canni-ing up before the pull. An encounter opened by it would run its clock to the
  // idle timeout with no enemy in it.
  p.feed(`${D(22, 45, 57)} Venun hit Venun for 1924 points of unresistable damage by Cannibalization I.`);
  assert.equal(p.snapshot().idle, true);
});

test('channel chat is player proof; a summon call-out is not', () => {
  const p = makeParser();
  p.feed(`${D(10, 6, 40)} Kadomony tells the group, 'the other one too from what I see'`);
  assert.equal(p.roster.knownPlayers.has('Kadomony'), true);

  // A boss wording a summon as a say-line must never become player proof.
  p.feed(`${D(10, 6, 41)} Bazzzazzt says, 'You will not evade me, Khanvikt!'`);
  assert.equal(p.roster.knownPlayers.has('Bazzzazzt'), false);

  // Nor may a pet reporting to its Master.
  p.feed(`${D(10, 6, 42)} Gann tells you, 'Attacking a froglok shin knight Master.'`);
  assert.equal(p.roster.knownPlayers.has('Gann'), false);
  assert.equal(p.roster.ownerOf('Gann'), 'Rhale');
});

test('a proven player is never claimed as somebody else\'s pet', () => {
  const p = makeParser();
  p.feed(`${D(10, 6, 40)} Kadomony tells the group, 'inc'`);
  p.feed(`${D(10, 6, 45)} Khanvikt animates an undead servant.`);
  p.feed(`${D(10, 6, 50)} Kadomony slashes a spiroc guardian for 40 points of damage.`);

  assert.equal(p.roster.ownerOf('Kadomony'), null);
  assert.equal(p.snapshot().rows.some((r) => r.name === 'Kadomony'), true);
});

// ---------------------------------------------------------------------------
// The backtick mob.
//
// The single-token failure above has a punctuation-shaped twin. Pets are written
// `<Owner>`s <noun>`, and the split used to be unconditional — so `Innoruuk`s Chosen`,
// a Plane of Hate boss, folded into a combatant called "Innoruuk", which passes for a
// player name, which made the boss friendly. Every line went through friendly fire and
// was dropped, and the one mechanism that corrects a bad identity refused to look at a
// pet-shaped side. Eight minutes of fighting it scored nothing. Lines below are the
// live session's own.
// ---------------------------------------------------------------------------

test('a mob with a backtick in its name is an enemy from the first line', () => {
  const p = makeParser();
  assert.equal(p.standing('Innoruuk`s Chosen'), 'enemy', 'before anything has happened');

  p.feed(`${D(0, 25, 42)} You slash Innoruuk\`s Chosen for 42 points of damage.`);

  const snap = p.snapshot();
  assert.equal(snap.rows.length, 1);
  assert.equal(snap.rows[0].name, 'Rhale');
  assert.equal(snap.rows[0].damage, 42);
  assert.equal(snap.label, 'Innoruuk`s Chosen', 'and it is the fight, not a bystander');
  // Crucially not folded into a phantom "Innoruuk" row.
  assert.equal(snap.rows.some((r) => r.name === 'Innoruuk'), false);
});

test('the backtick mob hitting a member scores as damage taken', () => {
  const p = makeParser();
  p.feed(`${D(0, 25, 42)} You slash Innoruuk\`s Chosen for 42 points of damage.`);
  p.feed(`${D(0, 27, 39)} Innoruuk\`s Chosen cleaves YOU for 53 points of damage.`);
  p.feed(`${D(0, 25, 59)} Innoruuk\`s Chosen cleaves Rhale\`s warder for 123 points of damage.`);

  const row = p.snapshot().rows.find((r) => r.name === 'Rhale');
  assert.equal(row.damageTaken, 176, 'the warder\'s beating folds into its owner');
  assert.equal(row.petDamageTaken, 123);
  assert.equal(row.attackers[0].name, 'Innoruuk`s Chosen');
});

test('the backtick mob\'s casts raise warnings', () => {
  const p = makeParser();
  p.feed(`${D(0, 25, 42)} You slash Innoruuk\`s Chosen for 42 points of damage.`);
  // Allure is a charm aimed at the group and Ensnaring Roots is the root; 105 casts
  // like these went unwarned across the live log because the caster read as a player.
  p.feed(`${D(0, 25, 44)} Innoruuk\`s Chosen begins casting Allure.`);

  const warning = p.snapshot(T(0, 25, 44)).hostileCasts.find((c) => c.ability === 'Allure');
  assert.equal(warning.caster, 'Innoruuk`s Chosen');
});

test('a real warder is never marked hostile by a friendly-fire line', () => {
  const p = makeParser();
  // Impossible line, in both directions: the mark must land on neither the warder nor
  // its owner, because an owner with player proof is proof the pet is a pet.
  p.feed(`${D(18, 48, 13)} Rhale\`s warder slashes Rhale for 40 points of damage.`);
  p.feed(`${D(18, 48, 14)} Rhale slashes Rhale\`s warder for 40 points of damage.`);

  // A pet is only as ours as its owner, and this owner is the logging character — so
  // both ends read as ours, no fight opens, and nothing is scored in either direction.
  assert.equal(p.standing('Rhale'), 'ours');
  assert.equal(p.snapshot().rows.length, 0, 'and nothing is scored either way');
});

test('a lowercase-nouned mob name is corrected by proof of action', () => {
  // The shape rule waves this one through — the noun is generic, so it reads as a pet
  // belonging to "Dreadlord", who looks like a player. Trading a blow with a confirmed
  // member is what puts it right, and it stays right for the session.
  const p = makeParser();
  // Nobody has ever heard of "Dreadlord", so its "pet" inherits no standing at all.
  assert.equal(p.standing('Dreadlord'), null);

  p.feed(`${D(0, 30, 0)} Dreadlord\`s minion crushes YOU for 61 points of damage.`);
  p.feed(`${D(0, 30, 2)} Dreadlord\`s minion crushes YOU for 61 points of damage.`);

  // The logging character is the one fixed point, so a hit landing on him makes the
  // other end the enemy whatever it is spelled like. Not even the first blow is lost.
  assert.equal(p.isEnemy('Dreadlord'), true);
  const row = p.snapshot().rows.find((r) => r.name === 'Rhale');
  assert.equal(row.damageTaken, 122);
  assert.equal(row.attackers[0].name, 'Dreadlord`s minion');
  // And "Dreadlord" never becomes a phantom combatant row of its own.
  assert.equal(p.snapshot().rows.some((r) => r.name === 'Dreadlord'), false);
});

test('a capitalized possessive still folds when the owner has player proof', () => {
  // The case the shape rule gets wrong, answered with evidence instead. Rhale is the
  // logging character, so `Rhale`s Warder` is a pet however the game capitalized it.
  const p = makeParser();
  p.feed(`${D(18, 48, 16)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 48, 23)} Rhale\`s Warder hit a froglok shin knight for 71 points of cold damage by Blast of Frost.`);

  const snap = p.snapshot();
  assert.equal(snap.rows.length, 1, 'no row of its own');
  assert.equal(snap.rows[0].name, 'Rhale');
  assert.equal(snap.rows[0].petDamage, 71);
});

// ---------------------------------------------------------------------------
// Evacuating a fight.
// ---------------------------------------------------------------------------

test('a DoT ticking after a succor opens no phantom encounter', () => {
  const p = makeParser();
  p.feed(`${D(0, 25, 42)} You slash Magi P\`tasa for 42 points of damage.`);
  p.feed(`${D(0, 26, 22)} You have entered The Plane of Hate - Group 1 (Awakened).`);
  assert.equal(p.snapshot(T(0, 26, 22)).active, false);

  // The mob is in a room the group fled; its DoT keeps landing every six seconds.
  p.feed(`${D(0, 26, 28)} Rhain has taken 124 damage from Wrath of the Elements by Magi P\`tasa.`);
  p.feed(`${D(0, 26, 34)} Rhain has taken 124 damage from Wrath of the Elements by Magi P\`tasa.`);

  const snap = p.snapshot(T(0, 26, 34));
  assert.equal(snap.active, false, 'no fight against something nobody is fighting');
  assert.equal(snap.label, 'Magi P`tasa', 'the CLOSED fight is still the one on screen');
  assert.equal(snap.totalDamageTaken, 0, 'and the ticks joined nothing');
});

test('a DoT tick inside a live fight still scores and still extends it', () => {
  const p = makeParser({ timeoutMs: 15_000 });
  p.feed(`${D(0, 25, 42)} You slash Magi P\`tasa for 42 points of damage.`);
  p.feed(`${D(0, 25, 52)} Rhain has taken 124 damage from Wrath of the Elements by Magi P\`tasa.`);

  const snap = p.snapshot(T(0, 25, 55));
  assert.equal(snap.active, true);
  assert.equal(snap.totalDamageTaken, 124);
  // 10s past the last swing: without the tick's extension this would have timed out.
  p.tick(T(0, 26, 5));
  assert.equal(p.snapshot(T(0, 26, 5)).active, true);
});

// ---------------------------------------------------------------------------
// Binding other players' pets to their owners.
// ---------------------------------------------------------------------------

test('a summon flavour line binds the next unseen name to the summoner', () => {
  // A long timeout so the 20s between summon and first swing stays one encounter.
  const p = makeParser({ timeoutMs: 120_000 });
  p.feed(`${D(10, 6, 20)} Khanvikt slashes a spiroc guardian for 50 points of damage.`);
  p.feed(`${D(10, 6, 30)} Khanvikt animates an undead servant.`);
  p.feed(`${D(10, 6, 40)} Kibektik slashes a spiroc guardian for 65 points of damage.`);

  const rows = p.snapshot().rows;
  assert.equal(rows.some((r) => r.name === 'Kibektik'), false, 'no row of its own');
  const khan = rows.find((r) => r.name === 'Khanvikt');
  assert.equal(khan.damage, 115);
  assert.equal(khan.petDamage, 65);
  assert.equal(khan.abilities.find((a) => a.name === 'Slash (pet)').damage, 65);
});

test('two summons at once bind nothing rather than guess', () => {
  const p = makeParser();
  p.feed(`${D(10, 6, 20)} Khanvikt slashes a spiroc guardian for 50 points of damage.`);
  p.feed(`${D(10, 6, 20)} Kadomony slashes a spiroc guardian for 50 points of damage.`);
  p.feed(`${D(10, 6, 30)} Khanvikt animates an undead servant.`);
  p.feed(`${D(10, 6, 31)} Kadomony animates an undead servant.`);
  p.feed(`${D(10, 6, 40)} Kibektik slashes a spiroc guardian for 65 points of damage.`);

  assert.equal(p.roster.ownerOf('Kibektik'), null);
  // Unbound is not the same as discarded: the damage is real and keeps its own row,
  // which is what makes it obvious the pet still needs mapping.
  assert.equal(p.snapshot().rows.find((r) => r.name === 'Kibektik').damage, 65);
});

test('a pet-only buff binds tighter than adjacency, and corrects it', () => {
  const p = makeParser();
  p.feed(`${D(10, 6, 20)} Khanvikt slashes a spiroc guardian for 50 points of damage.`);
  p.feed(`${D(10, 6, 21)} Kadomony slashes a spiroc guardian for 50 points of damage.`);
  // Two summoners, so nothing binds on adjacency.
  p.feed(`${D(10, 6, 30)} Khanvikt animates an undead servant.`);
  p.feed(`${D(10, 6, 31)} Kadomony animates an undead servant.`);
  p.feed(`${D(10, 6, 40)} Kibektik slashes a spiroc guardian for 65 points of damage.`);
  assert.equal(p.roster.ownerOf('Kibektik'), null);

  // Two people casting at once again — matching the SPELL is what picks Khanvikt.
  p.feed(`${D(10, 6, 46)} Kadomony begins casting Greater Healing V.`);
  p.feed(`${D(10, 6, 46)} Khanvikt begins casting Augment Death IV.`);
  p.feed(`${D(10, 6, 51)} Kibektik's eyes gleam with madness.`);
  assert.equal(p.roster.ownerOf('Kibektik'), 'Khanvikt');
});

test('the shrink line is only evidence when a pet-only spell produced it', () => {
  const p = makeParser();
  p.feed(`${D(10, 36, 20)} Khanvikt slashes a fire giant warrior for 50 points of damage.`);
  // The shaman's Shrink lands on a PLAYER, and says nothing about anybody's pet.
  p.feed(`${D(10, 36, 34)} Khanvikt begins casting Shrink.`);
  p.feed(`${D(10, 36, 41)} Khanvikt shrinks.`);
  assert.equal(p.roster.ownerOf('Khanvikt'), null);
});

test('the magician animation binds from the cast, since it prints no flavour line', () => {
  const p = makeParser();
  p.feed(`${D(18, 50, 30)} Rhain smites a froglok shin knight for 11 points of damage.`);
  p.feed(`${D(18, 50, 41)} Rhain begins casting Sagar's Animation.`);
  p.feed(`${D(18, 50, 46)} Gann begins casting Center.`);
  assert.equal(p.roster.ownerOf('Gann'), 'Rhain');
  assert.equal(p.roster.isWeaklyBoundPet('Gann'), true);
});

test('an ordinary cast never arms the pet slot — every player is unseen exactly once', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Emalina begins casting Greater Healing V.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  assert.equal(p.roster.ownerOf('Rhain'), null, 'Rhain is a groupmate, not a pet');
});

test('a weak binding is torn down the moment its "pet" fights the group', () => {
  const p = makeParser();
  p.feed(`${D(18, 50, 30)} You smite a froglok shin knight for 11 points of damage.`);
  p.feed(`${D(18, 50, 41)} You begin casting Sagar's Animation.`);
  // Not a pet at all — a single-token named mob that happened to appear next.
  p.feed(`${D(18, 50, 46)} Gorgalosk begins casting Ice Comet.`);
  assert.equal(p.roster.ownerOf('Gorgalosk'), 'Rhale');

  p.feed(`${D(18, 50, 50)} Gorgalosk hits YOU for 200 points of damage.`);
  assert.equal(p.roster.ownerOf('Gorgalosk'), null);
  assert.equal(p.roster.notPets.has('Gorgalosk'), true, 'and never re-bound');
  assert.equal(p.snapshot().rows.find((r) => r.name === 'Rhale').damageTaken, 200);
});

// ---------------------------------------------------------------------------
// The in-game mapping command.
// ---------------------------------------------------------------------------

test('the mapping command works on every self chat form and acknowledges', () => {
  for (const line of [
    "You say, 'pet Kibektik = Khanvikt'",
    "You tell your party, 'pet Kibektik = Khanvikt'",
    "You tell your raid, 'pet Kibektik = Khanvikt'",
    "You say to your guild, 'pet Kibektik = Khanvikt'",
    "You tell eqlo:1, 'pet Kibektik = Khanvikt'",
  ]) {
    const p = makeParser();
    p.feed(`${D(10, 6, 0)} ${line}`);
    assert.equal(p.roster.ownerOf('Kibektik'), 'Khanvikt', line);
    // Khanvikt has not acted in this test's log, and the acknowledgement says so
    // rather than implying the overlay recognised him.
    assert.equal(p.snapshot().notices[0].text, 'Kibektik = Khanvikt (not seen yet)');
  }
});

test('a one-letter slip in the owner is refused with the name that was meant', () => {
  const p = makeParser();
  p.feed(`${D(10, 5, 0)} Kadomony has joined the group.`);
  p.feed(`${D(10, 6, 0)} You tell your party, 'pets Jaber = Kodomony'`);

  // Straight from the live log: Kodomony appeared exactly twice in 79 MB, both times
  // as this command. Accepting it grew a phantom row next to the real Kadomony.
  assert.equal(p.roster.ownerOf('Jaber'), null);
  assert.equal(p.snapshot().notices.at(-1).text, 'No Kodomony here — did you mean Kadomony?');

  p.feed(`${D(10, 6, 5)} You tell your party, 'pet Jaber = Kadomony'`);
  assert.equal(p.roster.ownerOf('Jaber'), 'Kadomony');
  assert.equal(p.snapshot().notices.at(-1).text, 'Jaber = Kadomony');
});

test('capitalization is fixed rather than refused', () => {
  const p = makeParser();
  p.feed(`${D(10, 5, 0)} Kadomony has joined the group.`);
  p.feed(`${D(10, 6, 0)} You say, 'pet Jaber = kadomony'`);
  // EQ capitalizes every name, so lowercase is a typing slip and not another person.
  assert.equal(p.roster.ownerOf('Jaber'), 'Kadomony');
  assert.equal(p.snapshot().notices.at(-1).text, 'Jaber = Kadomony');
});

test('an owner unlike anyone here is honoured, since they may not have acted yet', () => {
  const p = makeParser();
  p.feed(`${D(10, 5, 0)} Kadomony has joined the group.`);
  p.feed(`${D(10, 6, 0)} You say, 'pet Jaber = Zarann'`);
  assert.equal(p.roster.ownerOf('Jaber'), 'Zarann');
  assert.equal(p.snapshot().notices.at(-1).text, 'Jaber = Zarann (not seen yet)');
});

test('the backtick pet the Master line teaches is never written to the saved mapping', () => {
  const saved = [];
  const p = makeParser({ onPetOwnersChanged: (m) => saved.push(m) });
  p.feed(`${D(10, 6, 0)} Rhale\`s warder told you, 'Attacking a froglok shin knight Master.'`);
  p.feed(`${D(10, 6, 1)} You say, 'pet Kibektik = Khanvikt'`);

  // It resolves by string split long before any table is consulted, so storing it only
  // put a line in the player's settings box that they never wrote and cannot need.
  assert.deepEqual(saved.at(-1), { Kibektik: 'Khanvikt' });
  p.feed(`${D(10, 6, 2)} Rhale\`s warder crushes a froglok shin knight for 40 points of damage.`);
  assert.equal(p.snapshot().rows[0].name, 'Rhale');
});

test('a third party cannot reconfigure the overlay by typing the magic words', () => {
  const p = makeParser();
  p.feed(`${D(10, 6, 0)} Xilrasis tells General:1, 'pet Kibektik = Khanvikt'`);
  p.feed(`${D(10, 6, 1)} Xilrasis tells you, 'pet Kibektik = Khanvikt'`);
  p.feed(`${D(10, 6, 2)} You told Rhain, 'pet Kibektik = Khanvikt'`);
  assert.equal(p.roster.ownerOf('Kibektik'), null);
  assert.equal(p.snapshot().notices.length, 0);
});

test('the mapping command forgives the ways a person actually types it', () => {
  // Every one of these used to fall through to the chat rule and write nothing at all.
  // The plural is the one that got reported: the setting is called "Named pets", so
  // "pets Jonarn = Khanvikt" is the natural thing to type.
  for (const payload of [
    'pets Kibektik = Khanvikt',
    'Pet Kibektik = Khanvikt',
    'Pets Kibektik = Khanvikt',
    'pet  Kibektik = Khanvikt',
    'pet Kibektik = Khanvikt ',
  ]) {
    const p = makeParser();
    p.feed(`${D(10, 6, 0)} You tell your party, '${payload}'`);
    assert.equal(p.roster.ownerOf('Kibektik'), 'Khanvikt', payload);
  }

  const p = makeParser();
  p.feed(`${D(10, 6, 0)} You say, 'pet Kibektik = Khanvikt'`);
  p.feed(`${D(10, 6, 1)} You say, 'pets ?'`);
  assert.equal(p.snapshot().notices.at(-1).text, 'Pets: Kibektik = Khanvikt');
});

test('a malformed command writes nothing but says so', () => {
  for (const payload of ['pet Kibektik =', 'pet = Khanvikt', 'pet 1 = 2', 'pet kibektik = 4']) {
    const p = makeParser();
    p.feed(`${D(10, 6, 0)} You say, '${payload}'`);
    assert.equal(p.roster.petOwners.size, 0, payload);
    // Silence was the actual bug: nothing changed on screen and nothing said why, so
    // a typo was indistinguishable from a broken feature.
    assert.equal(p.snapshot().notices.at(-1)?.text, 'Pet command: pet <Pet> = <Owner>', payload);
  }
});

test('talking about pets is not a command and stays silent', () => {
  const p = makeParser();
  // Straight from the live log. None of it carries an equals sign, which is exactly
  // what keeps the "I could not read that" answer off ordinary conversation.
  for (const payload of [
    'pet needs heals',
    "pet heals don't trigger divine invo which i think is dumb lol",
    'pet weapon - jk lol',
    'pets are expensive',
  ]) {
    p.feed(`${D(10, 6, 0)} You tell your raid, '${payload}'`);
  }
  assert.equal(p.roster.petOwners.size, 0);
  assert.equal(p.snapshot().notices.length, 0);
});

test('the mapping command unmaps, lists, and hands the mapping to the caller', () => {
  const saved = [];
  const p = makeParser({ onPetOwnersChanged: (m) => saved.push(m) });

  p.feed(`${D(10, 6, 0)} You say, 'pet Kibektik = Khanvikt'`);
  assert.deepEqual(saved.at(-1), { Kibektik: 'Khanvikt' });

  p.feed(`${D(10, 6, 1)} You say, 'pet ?'`);
  assert.equal(p.snapshot().notices.at(-1).text, 'Pets: Kibektik = Khanvikt');

  p.feed(`${D(10, 6, 2)} You say, 'pet Kibektik = none'`);
  assert.equal(p.roster.ownerOf('Kibektik'), null);
  assert.deepEqual(saved.at(-1), {});
  // "not a pet" is the user overruling the log, so the next summon must not re-learn it.
  assert.equal(p.roster.notPets.has('Kibektik'), true);
});

test('the command maps a mob-named charm pet, with a charm\'s lifetime', () => {
  const saved = [];
  const p = makeParser({ onPetOwnersChanged: (m) => saved.push(m) });
  p.feed(`${D(10, 5, 0)} Rhain has joined the group.`);

  // The exact line from the live log, typed five ways on Aug 13 and refused every time
  // with the very syntax it was already following.
  p.feed(`${D(10, 6, 0)} You tell your party, 'pets a skeletal monk = Rhain'`);
  assert.equal(p.roster.ownerOf('a skeletal monk'), 'Rhain');
  assert.equal(p.roster.petOwners.size, 0, 'charm-scoped, never durable');
  assert.equal(saved.length, 0, 'and never persisted');
  // The acknowledgement names the lifetime, so "gone after zoning" is expected, not a bug.
  assert.equal(p.snapshot().notices.at(-1).text, 'skeletal monk = Rhain (while charmed)');

  // The suffixed spelling and the plain one are the same pet.
  p.feed(`${D(10, 6, 5)} You crush a lurking mummy for 40 points of damage.`);
  p.feed(`${D(10, 6, 6)} A skeletal monk pet pierces a lurking mummy for 30 points of damage.`);
  const rhain = p.snapshot().rows.find((r) => r.name === 'Rhain');
  assert.equal(rhain.petDamage, 30);
});

test('the game\'s " pet" marker is stripped from a typed name, not stored as part of it', () => {
  const p = makeParser();
  p.feed(`${D(10, 5, 0)} Rhain has joined the group.`);
  p.feed(`${D(10, 6, 0)} You tell your party, 'pets a skeletal monk pet = Rhain'`);
  // Mapping the name as the game displays it and mapping the plain name mean the same
  // thing, so both must land on one key.
  assert.equal(p.roster.ownerOf('a skeletal monk'), 'Rhain');
  assert.equal(p.roster.ownerOf('a skeletal monk pet'), 'Rhain');
});

test('owner on the wrong side gets a direction hint, not the generic syntax line', () => {
  const p = makeParser();
  // Straight from the live log: `pets Rhale = a dark boned skeletone`, typed twice.
  // The generic syntax reprint taught nothing — the player was already typing it.
  p.feed(`${D(10, 6, 0)} You tell your party, 'pets Rhale = a dark boned skeletone'`);
  assert.equal(p.roster.charmedPets.size, 0);
  assert.equal(p.roster.petOwners.size, 0);
  assert.equal(p.snapshot().notices.at(-1).text, 'Owner goes on the right: pet <Pet> = <Owner>');
});

test('a typed mapping overrides a live charm attribution, not layers under it', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Ribbers begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);
  assert.equal(p.roster.ownerOf('a tal ghoul wizard'), 'Ribbers');

  // The charm store sits FIRST in ownerOf's precedence, so without eviction the stale
  // attribution would keep answering while the command's acknowledged mapping sat under
  // it doing nothing.
  p.feed(`${D(19, 20, 5)} You tell your party, 'pets a tal ghoul wizard = Emalina'`);
  assert.equal(p.roster.ownerOf('a tal ghoul wizard'), 'Emalina', 'the newest statement wins');
});

test('clearing a mob name unmaps it everywhere, and a later charm may honestly re-map', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);

  p.feed(`${D(19, 20, 5)} You tell your party, 'pets a tal ghoul wizard = none'`);
  assert.equal(p.roster.ownerOf('a tal ghoul wizard'), null);
  assert.equal(p.snapshot().notices.at(-1).text, 'tal ghoul wizard unmapped');

  // "has been charmed" is the game stating a new fact; the clear must not veto it.
  p.feed(`${D(19, 20, 8)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 9)} a tal ghoul wizard has been charmed.`);
  assert.equal(p.roster.ownerOf('a tal ghoul wizard'), 'Rhain');
});

test('the list names live charms and says which they are', () => {
  const p = makeParser();
  p.feed(`${D(19, 20, 0)} Emalina slashes a ghoul savant for 100 points of damage.`);
  p.feed(`${D(19, 20, 1)} Rhain begins casting Beguile.`);
  p.feed(`${D(19, 20, 2)} a tal ghoul wizard has been charmed.`);
  p.feed(`${D(19, 20, 5)} You say, 'pet ?'`);
  assert.equal(p.snapshot().notices.at(-1).text, 'Pets: tal ghoul wizard = Rhain (charmed)');
});

// ---------------------------------------------------------------------------
// Procs: abilities that deal damage and are never cast.
// ---------------------------------------------------------------------------

test('a pet hit with no cast behind it is labelled a proc', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 16)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 48, 20)} Rhale\`s warder hit a froglok shin knight for 75 points of magic damage by Ykesha.`);

  const row = p.snapshot().rows[0];
  assert.equal(row.abilities.find((a) => a.name === 'Ykesha (pet proc)').damage, 75);
  assert.equal(row.procDamage, 75);
});

test('the proc flavour line carries no damage and is never scored', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 16)} You crush a froglok shin knight for 40 points of damage.`);
  // 746 of these in the live log, paired exactly 1:1 with the damage line above.
  p.feed(`${D(18, 48, 20)} A froglok shin knight has been struck by the force of Ykesha.`);
  p.feed(`${D(18, 48, 20)} Rhale\`s warder hit a froglok shin knight for 75 points of magic damage by Ykesha.`);
  assert.equal(p.snapshot().rows[0].damage, 115, 'the flavour line must not double-count');
});

test('an ability that was cast is not a proc', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 16)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 48, 18)} Rhale\`s warder begins casting Ice Spear.`);
  p.feed(`${D(18, 48, 20)} Rhale\`s warder hit a froglok shin knight for 71 points of cold damage by Ice Spear.`);

  const row = p.snapshot().rows[0];
  assert.equal(row.abilities.find((a) => a.name === 'Ice Spear (pet)').damage, 71);
  assert.equal(row.procDamage, 0);
});

test('a cast seen AFTER the first hit relabels the one row retroactively', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 16)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 48, 18)} Rhale\`s warder hit a froglok shin knight for 71 points of cold damage by Ice Spear.`);
  assert.equal(p.snapshot().rows[0].procDamage, 71);

  p.feed(`${D(18, 48, 22)} Rhale\`s warder begins casting Ice Spear.`);
  p.feed(`${D(18, 48, 24)} Rhale\`s warder hit a froglok shin knight for 29 points of cold damage by Ice Spear.`);

  const row = p.snapshot().rows[0];
  const spear = row.abilities.filter((a) => a.name.startsWith('Ice Spear'));
  assert.equal(spear.length, 1, 'one row per ability per member, always');
  assert.equal(spear[0].name, 'Ice Spear (pet)');
  assert.equal(spear[0].damage, 100, 'both hits still counted');
  assert.equal(row.procDamage, 0);
});

test('a spell rank on the cast line still matches the unranked damage line', () => {
  const p = makeParser();
  p.feed(`${D(18, 48, 16)} You crush a froglok shin knight for 40 points of damage.`);
  p.feed(`${D(18, 48, 18)} Syphon begins casting Frost Storm VIII.`);
  p.feed(`${D(18, 48, 20)} Syphon hit a froglok shin knight for 428 points of cold damage by Frost Storm.`);

  const row = p.snapshot().rows.find((r) => r.name === 'Syphon');
  assert.equal(row.abilities[0].name, 'Frost Storm');
  assert.equal(row.procDamage, 0);
});
