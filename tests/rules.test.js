/**
 * Every line asserted here marked "(sample)" is verbatim from the Phase 0 capture in
 * tests/fixtures/combat-sample.log — a live EverQuest Legends session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRule, normalizeVerb, parseMods } from '../src/parser/rules.js';

const m = (body) => matchRule(body);

test('melee hit, third person (sample)', () => {
  const e = m('Rhain smites a froglok shin knight for 11 points of damage.');
  assert.equal(e.kind, 'damage');
  assert.equal(e.source, 'melee');
  assert.equal(e.attacker, 'Rhain');
  assert.equal(e.target, 'a froglok shin knight');
  assert.equal(e.amount, 11);
  assert.equal(e.ability, 'Smite');
});

test('melee hit, second person, with a crit modifier (sample)', () => {
  const e = m('You crush a froglok shin knight for 34 points of damage. (Critical)');
  assert.equal(e.attacker, 'You');
  assert.equal(e.amount, 34);
  assert.equal(e.ability, 'Crush');
  assert.deepEqual(e.mods, ['critical']);
});

test('singular "1 point of damage" (sample)', () => {
  const e = m('Fuaim pierces a shriveled mummy for 1 point of damage.');
  assert.equal(e.amount, 1);
  assert.equal(e.ability, 'Pierce');
});

test('a pet swing keeps the backtick name for entities.js to split (sample)', () => {
  const e = m('Rhale`s warder bashes a froglok shin knight for 4 points of damage.');
  assert.equal(e.attacker, 'Rhale`s warder');
  assert.equal(e.amount, 4);
  assert.equal(e.ability, 'Bash');
});

test('multi-word verb "frenzies on" is not truncated to "frenzies" (sample)', () => {
  const e = m('Rhain frenzies on a froglok shin knight for 85 points of damage. (Critical)');
  assert.equal(e.attacker, 'Rhain');
  assert.equal(e.target, 'a froglok shin knight');
  assert.equal(e.amount, 85);
  assert.equal(e.ability, 'Frenzy');
});

test('an NPC attacking a player parses the same way (sample)', () => {
  const e = m('A froglok shin knight cleaves Rhain for 20 points of damage.');
  assert.equal(e.attacker, 'A froglok shin knight');
  assert.equal(e.target, 'Rhain');
  assert.equal(e.amount, 20);
});

test('spell/skill damage IS attributed in EQ Legends (sample)', () => {
  const e = m('Rhain hit a froglok shin knight for 109 points of magic damage by Smiting Strike.');
  assert.equal(e.kind, 'damage');
  assert.equal(e.source, 'spell');
  assert.equal(e.attacker, 'Rhain');
  assert.equal(e.target, 'a froglok shin knight');
  assert.equal(e.amount, 109);
  assert.equal(e.damageType, 'magic');
  assert.equal(e.ability, 'Smiting Strike');
});

test('pet spell damage (sample)', () => {
  const e = m('Rhale`s warder hit a froglok shin knight for 71 points of cold damage by Blast of Frost.');
  assert.equal(e.attacker, 'Rhale`s warder');
  assert.equal(e.amount, 71);
  assert.equal(e.ability, 'Blast of Frost');
  assert.equal(e.damageType, 'cold');
});

test('second-person spell damage (sample)', () => {
  const e = m('You hit a froglok shin knight for 126 points of magic damage by Smiting Strike.');
  assert.equal(e.source, 'spell');
  assert.equal(e.attacker, 'You');
  assert.equal(e.amount, 126);
});

test('spell damage is not swallowed by the melee rule', () => {
  // "hit" is in the melee verb list, so rule order is what keeps these apart.
  assert.equal(m('You hit a froglok for 126 points of magic damage by Smiting Strike.').source, 'spell');
  assert.equal(m('A froglok shin knight hits Rhain for 58 points of damage.').source, 'melee');
});

test('misses, both persons, with modifiers (sample)', () => {
  const a = m('Rhain tries to frenzy on a froglok shin knight, but misses!');
  assert.equal(a.kind, 'miss');
  assert.equal(a.attacker, 'Rhain');
  assert.equal(a.target, 'a froglok shin knight');
  assert.equal(a.avoidance, 'miss');

  const b = m('You try to kick a froglok shin knight, but miss!');
  assert.equal(b.kind, 'miss');
  assert.equal(b.attacker, 'You');
  assert.equal(b.ability, 'Kick');

  const c = m('Rhale`s warder tries to slash a froglok shin knight, but misses! (Flurry)');
  assert.equal(c.kind, 'miss');
  assert.deepEqual(c.mods, ['flurry']);
});

test('avoidance variants (sample)', () => {
  const dodge = m('You try to crush a froglok shin knight, but a froglok shin knight dodges!');
  assert.equal(dodge.kind, 'miss');
  assert.equal(dodge.avoidance, 'dodge');

  const parry = m('You try to crush a froglok shin knight, but a froglok shin knight parries!');
  assert.equal(parry.avoidance, 'parry');

  const npc = m('A froglok shin knight tries to kick Rhain, but Rhain dodges!');
  assert.equal(npc.attacker, 'A froglok shin knight');
  assert.equal(npc.target, 'Rhain');
});

test('death (sample)', () => {
  const e = m('A froglok shin knight has been slain by Rhain!');
  assert.equal(e.kind, 'death');
  assert.equal(e.target, 'A froglok shin knight');
  assert.equal(e.attacker, 'Rhain');

  assert.equal(m('You have slain a shriveled mummy!').kind, 'death');
});

test('unattributed non-melee and the falling line that follows it (sample)', () => {
  const hit = m('You were hit by non-melee for 6 damage.');
  assert.equal(hit.kind, 'nonmelee-unattributed');
  assert.equal(hit.target, 'You');
  assert.equal(hit.amount, 6);

  const fall = m('YOU were injured by falling.');
  assert.equal(fall.kind, 'environmental');
  assert.equal(fall.cause, 'falling');
});

test('casting, both persons (sample)', () => {
  const a = m('Rhale`s warder begins casting Blast of Frost.');
  assert.equal(a.kind, 'cast');
  assert.equal(a.attacker, 'Rhale`s warder');
  assert.equal(a.ability, 'Blast of Frost');

  const b = m('You begin casting Feral Spirit.');
  assert.equal(b.kind, 'cast');
  assert.equal(b.ability, 'Feral Spirit');
});

test('zone changes (sample)', () => {
  assert.equal(m('LOADING, PLEASE WAIT...').phase, 'loading');
  const z = m('You have entered The Ruins of Old Guk 2 (Adaptive).');
  assert.equal(z.kind, 'zone');
  assert.equal(z.zone, 'The Ruins of Old Guk 2 (Adaptive)');
});

test('heals parse as effective (potential) (sample)', () => {
  // The pair is "what landed (what it could have been)". EQ prints the parenthetical
  // only when they differ, so overhealing is exact rather than estimated.
  const a = m('Emalina healed Rhain for 119 (139) hit points by Bravery.');
  assert.equal(a.kind, 'heal');
  assert.equal(a.attacker, 'Emalina');
  assert.equal(a.target, 'Rhain');
  assert.equal(a.effective, 119);
  assert.equal(a.potential, 139);
  assert.equal(a.overTime, false);
  assert.equal(a.ability, 'Bravery');

  const b = m('You healed Emalina over time for 60 (68) hit points by Flowering Heal.');
  assert.equal(b.kind, 'heal');
  assert.equal(b.target, 'Emalina');
  assert.equal(b.overTime, true);
  assert.equal(b.effective, 60);
  assert.equal(b.potential, 68);

  // No parenthetical: the whole heal landed.
  const c = m('Gann healed himself for 57 hit points by Center.');
  assert.equal(c.kind, 'heal');
  assert.equal(c.effective, 57);
  assert.equal(c.potential, 57);

  // A heal onto a full-health target — this line is what proves the field order.
  const d = m('Emalina healed herself for 0 (2) hit points by Blessing of the Squire.');
  assert.equal(d.effective, 0);
  assert.equal(d.potential, 2);
});

test('a heal with no spell named still parses (live log)', () => {
  // 4,715 of these in the live log, matching nothing and scored nowhere, which reads
  // as a healer contributing less than they did.
  const a = m('You healed Rhale for 92 hit points.');
  assert.equal(a.kind, 'heal');
  assert.equal(a.attacker, 'You');
  assert.equal(a.target, 'Rhale');
  assert.equal(a.effective, 92);
  assert.equal(a.potential, 92);
  // What produced it is not stated and not guessable, so it is labelled the way
  // unattributed damage already is rather than credited to whatever was last cast.
  assert.equal(a.ability, 'Unknown');

  const b = m('Rhazendude healed Vaezerk for 67 hit points.');
  assert.equal(b.target, 'Vaezerk');
  assert.equal(b.effective, 67);

  const c = m('You healed Rhale`s warder for 69 hit points.');
  assert.equal(c.target, 'Rhale`s warder');

  // And it does not steal a line that DOES name its spell — that one keeps its name.
  assert.equal(m('Emalina healed Rhain for 119 (139) hit points by Bravery.').ability, 'Bravery');
});

test('chat is matched first so quoted combat text is never scored', () => {
  // This is the whole reason the chat rule sits at the top of the table. A channel
  // line is typed as player-proof rather than plain chat — see the test below — but
  // either way it terminates the match, which is what keeps the quoted damage out.
  const e = m("Hlep tells General:1, 'he hits me for 100 points of damage.'");
  assert.equal(e.kind, 'player-proof');
  assert.equal(e.who, 'Hlep');

  assert.equal(m("Quartermaster Zevrex told you, 'Welcome to my bank!'").kind, 'chat');
  assert.equal(m("A froglok shin knight says, 'Frrroooaaakkk!'").kind, 'chat');
  assert.equal(m("You tell your party, 'incoming'").kind, 'chat');
  // Channel names carry digits on this server ("General2:1", "NewPlayers1:2"); the
  // pattern used to stop at the first digit, leaving those lines unmatched entirely.
  assert.equal(m("Xilrasis tells General2:1, 'hi'").kind, 'player-proof');
  // "You told Rhain, '...'" is a real form (152 occurrences) that the self-chat rule
  // did not cover, so an outgoing tell reached the damage rules.
  assert.equal(m("You told Rhain, 'he hits me for 100 points of damage.'").kind, 'chat');
});

test('only channel chat is player proof — says and tells-you are not', () => {
  // Bare `says,` is how a boss words its summon call-out, and `tells you` is how a pet
  // reports to its Master. Treating either as proof of a real player would make a mob
  // friendly forever, which is the bee bug with the sign flipped.
  assert.equal(m("Kadomony tells the group, 'the other one too'").kind, 'player-proof');
  assert.equal(m("Khanvikt tells the guild, 'aye'").kind, 'player-proof');
  assert.equal(m("Syphon tells the raid, 'pull'").kind, 'player-proof');
  assert.equal(m("Gorgalosk says, 'You will not evade me!'").kind, 'chat');
  assert.equal(m("Gann tells you, 'Attacking a froglok shin knight Master.'").kind, 'pet-owner');
});

test('unverified forms parse: DoT ticks and damage shields', () => {
  // No DoT class was played in the Phase 0 sample, so this wording follows classic
  // EverQuest and is flagged by collect-unknown.js if EQ Legends words it differently.
  const dot = m('A skeleton has taken 40 damage from Poison Bolt by Rhale.');
  assert.equal(dot.source, 'dot');
  assert.equal(dot.attacker, 'Rhale');
  assert.equal(dot.amount, 40);

  const mine = m('A skeleton has taken 12 damage from your Poison Bolt.');
  assert.equal(mine.source, 'dot');
  assert.equal(mine.attacker, 'You');

  const ds = m('A skeleton is pierced by YOUR thorns for 6 points of non-melee damage.');
  assert.equal(ds.source, 'ds');
  assert.equal(ds.attacker, 'You');
  assert.equal(ds.amount, 6);
});

test('flavor text matches no rule', () => {
  assert.equal(m('You are low on drink.'), null);
  assert.equal(m('A froglok shin knight staggers.'), null);
  assert.equal(m('The golden glow fades.'), null);
});

test('normalizeVerb collapses second and third person onto one bucket', () => {
  assert.equal(normalizeVerb('crushes'), 'Crush');
  assert.equal(normalizeVerb('crush'), 'Crush');
  assert.equal(normalizeVerb('hits'), 'Hit');
  assert.equal(normalizeVerb('punches'), 'Punch');
  assert.equal(normalizeVerb('bashes'), 'Bash');
  assert.equal(normalizeVerb('pierces'), 'Pierce');
  assert.equal(normalizeVerb('frenzies on'), 'Frenzy');
  assert.equal(normalizeVerb('frenzy on'), 'Frenzy');
  assert.equal(normalizeVerb('freezes'), 'Freeze');
  assert.equal(normalizeVerb('backstabs'), 'Backstab');
});

test('parseMods', () => {
  assert.deepEqual(parseMods(' (Critical)'), ['critical']);
  assert.deepEqual(parseMods(' (Critical) (Flurry)'), ['critical', 'flurry']);
  assert.deepEqual(parseMods(''), []);
  assert.deepEqual(parseMods(undefined), []);
});

test('damage shields, both directions (sample)', () => {
  // Outgoing: the shield belongs to Emalina, so the attacker must resolve to HER and
  // not to the literal string "Emalina's thorns" — which matches no combatant and would
  // silently discard several hundred points of real damage per fight.
  const out = m("A wan ghoul knight is pierced by Emalina's thorns for 1 point of non-melee damage.");
  assert.equal(out.kind, 'damage');
  assert.equal(out.source, 'ds');
  assert.equal(out.attacker, 'Emalina');
  assert.equal(out.target, 'A wan ghoul knight');
  assert.equal(out.amount, 1);

  // Incoming: same wording, but the shield's owner is the mob, so nothing is credited.
  const inc = m("Rhain is pierced by a wan ghoul knight's thorns for 8 points of non-melee damage.");
  assert.equal(inc.attacker, 'a wan ghoul knight');
  assert.equal(inc.target, 'Rhain');

  // The self form ends in "!" rather than ".".
  const self = m('YOU are pierced by a wan ghoul knight\'s thorns for 8 points of non-melee damage!');
  assert.equal(self.kind, 'damage');
  assert.equal(self.target, 'YOU');

  const yours = m('A skeleton is pierced by YOUR thorns for 6 points of non-melee damage.');
  assert.equal(yours.attacker, 'You');
});

test('critical heals still parse (sample)', () => {
  // Heals crit. Without the modifier suffix a 457-point critical heal parses as nothing.
  const e = m('Emalina healed herself for 457 hit points by Renewing Echo. (Critical)');
  assert.equal(e.kind, 'heal');
  assert.equal(e.effective, 457);
  assert.deepEqual(e.mods, ['critical']);

  const hot = m('Emalina healed Rhain over time for 20 (232) hit points by Renewing Echo. (Critical)');
  assert.equal(hot.effective, 20);
  assert.equal(hot.potential, 232);
  assert.equal(hot.overTime, true);
});

test('DoT ticks: has/have, self, critical and unattributed (sample)', () => {
  const crit = m('A ghoul scribe has taken 98 damage from your Immolate. (Critical)');
  assert.equal(crit.source, 'dot');
  assert.equal(crit.attacker, 'You');
  assert.equal(crit.amount, 98);
  assert.deepEqual(crit.mods, ['critical']);

  // Second person uses "have", not "has".
  const incoming = m('You have taken 29 damage from Searing Arrow by a ghoul savant.');
  assert.equal(incoming.source, 'dot');
  assert.equal(incoming.attacker, 'a ghoul savant');
  assert.equal(incoming.target, 'You');

  // No caster named at all.
  const anon = m('Gann has taken 10 damage by Poison.');
  assert.equal(anon.kind, 'nonmelee-unattributed');
  assert.equal(anon.amount, 10);
  assert.equal(anon.ability, 'Poison');
});

test('the player\'s own death parses; the generic rule cannot reach second person', () => {
  // 9 hits in the live Rhale log, so the wording is confirmed.
  const e = m('You have been slain by a froglok king!');
  assert.equal(e.kind, 'death');
  assert.equal(e.target, 'You');
  assert.equal(e.attacker, 'a froglok king');

  // Another player's death still goes through the generic rule.
  const other = m('Rhain has been slain by a froglok king!');
  assert.equal(other.kind, 'death');
  assert.equal(other.target, 'Rhain');
});

test('"smashes" is a real EQ Legends verb (live log: evil eyes)', () => {
  // Surfaced by collect-unknown.js — every occurrence was an evil eye, and without
  // the verb both its incoming and outgoing melee vanished from the parse.
  const e = m('An evil eye smashes YOU for 30 points of damage.');
  assert.equal(e.kind, 'damage');
  assert.equal(e.source, 'melee');
  assert.equal(e.attacker, 'An evil eye');
  assert.equal(e.target, 'YOU');
  assert.equal(e.amount, 30);
  assert.equal(e.ability, 'Smash');
});

test('incoming avoids parse in second person', () => {
  const dodge = m('A froglok shin knight tries to hit YOU, but YOU dodge!');
  assert.equal(dodge.kind, 'miss');
  assert.equal(dodge.attacker, 'A froglok shin knight');
  assert.equal(dodge.target, 'YOU');
  assert.equal(dodge.avoidance, 'dodge');

  const riposte = m('A froglok shin knight tries to slash YOU, but YOU riposte!');
  assert.equal(riposte.avoidance, 'riposte');
});

test('damage-shield verbs that state an element carry it as the type', () => {
  const fire = m('YOU are burned by a lava elemental\'s barrier for 12 points of non-melee damage!');
  assert.equal(fire.kind, 'damage');
  assert.equal(fire.damageType, 'fire');

  const cold = m('Rhain is frozen by an ice ghoul\'s shroud for 9 points of non-melee damage.');
  assert.equal(cold.damageType, 'cold');

  // "pierced" names no element — the type must stay honestly absent, not guessed.
  const thorns = m('Rhain is pierced by a wan ghoul knight\'s thorns for 8 points of non-melee damage.');
  assert.equal(thorns.damageType, null);
  assert.equal(thorns.attacker, 'a wan ghoul knight');

  // 225 lines in the live log. "frost" is the shield's own name, not a stated element,
  // so this one joins "pierced" in being honestly untyped.
  const tormented = m('A fire giant warrior is tormented by Kadomony\'s frost for 12 points of non-melee damage.');
  assert.equal(tormented.kind, 'damage');
  assert.equal(tormented.attacker, 'Kadomony');
  assert.equal(tormented.amount, 12);
  assert.equal(tormented.damageType, null);
});

test('reave is an attack verb (live log)', () => {
  // 1,374 hits and 1,264 misses across eight players went unparsed without this.
  const hit = m('Glorb reaves a spite golem for 24 points of damage.');
  assert.equal(hit.kind, 'damage');
  assert.equal(hit.source, 'melee');
  assert.equal(hit.attacker, 'Glorb');
  assert.equal(hit.target, 'a spite golem');
  assert.equal(hit.amount, 24);

  const miss = m('Rhain tries to reave Innoruuk`s Chosen, but misses!');
  assert.equal(miss.kind, 'miss');
  assert.equal(miss.attacker, 'Rhain');
  assert.equal(miss.target, 'Innoruuk`s Chosen');

  const avoided = m('Syphon tries to reave Cleric of Innoruuk, but Cleric of Innoruuk dodges!');
  assert.equal(avoided.kind, 'miss');
  assert.equal(avoided.avoidance, 'dodge');
});

test('an interrupted NPC cast names caster and spell (sample)', () => {
  const e = m("a tal ghoul wizard's Instill spell is interrupted.");
  assert.equal(e.kind, 'interrupt');
  assert.equal(e.attacker, 'a tal ghoul wizard');
  assert.equal(e.ability, 'Instill');
});

test('an apostrophe inside the spell name does not shift the caster split (sample)', () => {
  const e = m("a yun ghoul wizard's Tishan's Clash spell is interrupted.");
  assert.equal(e.attacker, 'a yun ghoul wizard');
  assert.equal(e.ability, "Tishan's Clash");
});

test('a player interrupt uses the same possessive wording (sample)', () => {
  const e = m("Emalina's Renewing Echo spell is interrupted.");
  assert.equal(e.kind, 'interrupt');
  assert.equal(e.attacker, 'Emalina');
  assert.equal(e.ability, 'Renewing Echo');
});

test('the summon say-line outranks chat and names its victim (live log)', () => {
  const e = m("Master Yael says, 'You will not evade me, Emalina!'");
  assert.equal(e.kind, 'summon');
  assert.equal(e.attacker, 'Master Yael');
  assert.equal(e.victim, 'Emalina');

  // The victim can be a pet — the raw backtick name passes through for entities.js.
  const pet = m("Master Yael says, 'You will not evade me, Rhale`s warder!'");
  assert.equal(pet.kind, 'summon');
  assert.equal(pet.victim, 'Rhale`s warder');

  // Any other say-line still falls through to chat as before.
  assert.equal(m("A froglok shin knight says, 'Frrroooaaakkk!'").kind, 'chat');
});

test('a player-shaped sayer still parses as a summon — the hostility guard is the parser\'s', () => {
  // The say-rule now outranks chat, so a troll typing the sentence in /say reaches
  // the parser as a summon event; rules.js stays free of any notion of who is hostile.
  const e = m("Hlep says, 'You will not evade me, Emalina!'");
  assert.equal(e.kind, 'summon');
  assert.equal(e.attacker, 'Hlep');
});

test('the self-summon confirmation parses with no attacker (live log)', () => {
  const e = m('You have been summoned!');
  assert.equal(e.kind, 'summon');
  assert.equal(e.attacker, null);
  assert.equal(e.victim, 'You');
});

test('CC landing on a person parses: stun, entrance, mez (live log)', () => {
  const stun = m('You are stunned!');
  assert.equal(stun.kind, 'effect');
  assert.equal(stun.who, 'You');
  assert.equal(stun.effect, 'stunned');

  const entrance = m('You have been entranced.');
  assert.equal(entrance.kind, 'effect');
  assert.equal(entrance.who, 'You');
  assert.equal(entrance.effect, 'entranced');

  const mez = m('Emalina has been mesmerized.');
  assert.equal(mez.kind, 'effect');
  assert.equal(mez.who, 'Emalina');
  assert.equal(mez.effect, 'mesmerized');
});

test('CC end-lines parse; unrelated "no longer" lines stay unmatched (live log)', () => {
  const stun = m('You are no longer stunned.');
  assert.equal(stun.kind, 'effect-end');
  assert.equal(stun.who, 'You');
  assert.equal(stun.effect, 'stunned');

  assert.equal(m('You are no longer captivated.').effect, 'captivated');
  assert.equal(m('You are no longer entranced.').effect, 'entranced');

  // Effects the parser never tracks must not emit end events.
  assert.equal(m('You are no longer hidden.'), null);
  assert.equal(m('You are no longer ensnared.'), null);
  assert.equal(m('You are no longer poisoned.'), null);
});

test('the awakened line always names the waker on this server (live log)', () => {
  // The bare classic "has been awakened." never occurs — every awakening is the
  // by-form, which the generic crowd-control rule cannot reach.
  const e = m('A wan ghoul knight has been awakened by Rhain.');
  assert.equal(e.kind, 'effect');
  assert.equal(e.who, 'A wan ghoul knight');
  assert.equal(e.effect, 'awakened');
  assert.equal(e.by, 'Rhain');
});

test('resist lines parse in all three forms (sample)', () => {
  const self = m("You resist a zol ghoul knight's Ghoul Root!");
  assert.equal(self.kind, 'resist');
  assert.equal(self.target, 'You');
  assert.equal(self.attacker, 'a zol ghoul knight');
  assert.equal(self.ability, 'Ghoul Root');

  const yours = m('Master Yael resisted your Ykesha!');
  assert.equal(yours.kind, 'resist');
  assert.equal(yours.attacker, 'You');
  assert.equal(yours.target, 'Master Yael');
  assert.equal(yours.ability, 'Ykesha');

  // The pet's backtick never confuses the apostrophe split.
  const pet = m("Lord Nagafen resisted Rhale`s warder's Sicken!");
  assert.equal(pet.attacker, 'Rhale`s warder');
  assert.equal(pet.ability, 'Sicken');
});

test('the worn-off line carries the spell and the target (live log)', () => {
  const e = m('Your Charm spell has worn off of a skeletal monk.');
  assert.equal(e.kind, 'worn-off');
  assert.equal(e.ability, 'Charm');
  assert.equal(e.target, 'a skeletal monk');

  const dot = m('Your Drifting Death spell has worn off of Master Yael.');
  assert.equal(dot.kind, 'worn-off');
  assert.equal(dot.ability, 'Drifting Death');
  assert.equal(dot.target, 'Master Yael');

  // The pet-buff variant has no "of" and no target, and must stay unmatched noise —
  // 136 "Your pet's Ghoul Root spell has worn off." lines in the live log say nothing
  // this parser needs.
  assert.equal(m("Your pet's Ghoul Root spell has worn off.")?.kind ?? null, null);
});

test('the mapping command accepts a mob-shaped pet name (live log)', () => {
  // The exact line typed (twice) on Aug 13 and refused by the letters-only capture.
  const e = m("You tell your party, 'pets a skeletal monk = Rhale'");
  assert.equal(e.kind, 'pet-command');
  assert.equal(e.action, 'set');
  assert.equal(e.pet, 'a skeletal monk');
  assert.equal(e.owner, 'Rhale');

  // Loose captures, same anchors: which half is which is the handler's judgement,
  // so the reversed form must PARSE — refusing it with a specific answer is the point.
  const reversed = m("You tell your party, 'pets Rhale = a dark boned skeletone'");
  assert.equal(reversed.kind, 'pet-command');
  assert.equal(reversed.pet, 'Rhale');
  assert.equal(reversed.owner, 'a dark boned skeletone');

  const cleared = m("You say, 'pet a skeletal monk = none'");
  assert.equal(cleared.action, 'clear');
  assert.equal(cleared.pet, 'a skeletal monk');

  // Talking about pets still is not a command: no equals sign, no match.
  assert.notEqual(m("You tell your raid, 'pets increase level with rank up'")?.kind, 'pet-command');
});
