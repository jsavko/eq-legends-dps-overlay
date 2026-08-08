/**
 * The session rule table: the non-combat half of a play session.
 *
 * A deliberate SIBLING of `src/parser/rules.js`, not an extension of it. That table is
 * about who did the damage and has to stay auditable for attribution bugs; this one is
 * about what the night earned — kills, coin, loot, experience, faction, skills, zones —
 * and shares nothing with it but the log stream. The same reasoning that put
 * `src/triggers/` beside the parser rather than inside it applies unchanged: two domains
 * that fail in different ways should not be able to break each other.
 *
 * Pure Node, no Electron, exactly like its two neighbours, so the whole thing is
 * unit-testable in WSL and replayable offline against a real log.
 *
 * **The chat guard is not here.** `src/parser/rules.js` classifies chat FIRST by design,
 * and the caller already has that answer: the tracker is fed `(line, parserEvent)` and
 * skips any line the parser called `chat`. Duplicating the chat table here would create a
 * second copy that goes stale the first time the first one is corrected — and the failure
 * mode is a player quoting "You have slain a froglok shin knight!" in /general scoring a
 * kill. One condition in `session.js` buys the same protection with no second table.
 *
 * Every rule carries a `category`, which is the unit the player switches on and off.
 * `matchSessionRule` takes that switch and skips a disabled rule's regex entirely, so a
 * category that is off costs nothing rather than costing everything and hiding the result.
 *
 * Wording marked (confirmed) was read off a real 1.1M-line session
 * (`eqlog_Rhale_oggok.txt`, 2026-07-31 → 2026-08-08). The rest follows classic EverQuest
 * and `scripts/collect-unknown.js` will expose it if this server words it differently.
 */

import { stripArticle } from '../parser/entities.js';

/**
 * The seven switchable categories, in the order they read in the settings form.
 *
 * Ability points and levels live under `xp` rather than getting an eighth switch: they
 * answer the same question the experience ledger does ("what did this night advance?"),
 * and a player who has turned progress tracking off has not asked to keep half of it.
 * The Session window still gives AA its own pane — a category is a switch, not a screen.
 */
export const SESSION_CATEGORIES = ['kills', 'loot', 'coin', 'xp', 'faction', 'skills', 'zones'];

/** How many copper each denomination is worth. The only conversion in the codebase. */
export const COPPER_PER = Object.freeze({ platinum: 1000, gold: 100, silver: 10, copper: 1 });

const DENOM = 'platinum|gold|silver|copper';
const COIN_PART = `\\d+ (?:${DENOM})`;
/**
 * One coin amount followed by any number of further amounts.
 *
 * Three separator styles are in the live log and all three are real:
 *   "3 gold, 6 silver and 7 copper"   — corpse loot, Oxford-comma-free
 *   "7 gold 2 silver"                 — merchant sale, plain spaces
 *   "6 platinum 3 gold 9 copper"      — purchase
 * so the fragment accepts all of them rather than one rule per punctuation style. It
 * must NOT assume all four denominations are present: fifteen of the sixteen possible
 * combinations appear in the sample, including bare "8 copper".
 */
const COIN_FRAG = `${COIN_PART}(?:(?:, | and | )${COIN_PART})*`;

/**
 * Pull a coin fragment apart into denominations and a copper total.
 *
 * Exported because the store and the window both need it and neither should re-derive
 * the conversion. The copper total is what rates and comparisons use; the breakdown is
 * what gets printed, because "3p 6g 7c" is how the game says it and turning that into
 * "3607 copper" on screen would be arithmetic the player then has to undo.
 *
 * @param {string} fragment  e.g. "3 gold, 6 silver and 7 copper"
 * @returns {{platinum: number, gold: number, silver: number, copper: number, copperTotal: number}}
 */
export function parseCoin(fragment) {
  const out = { platinum: 0, gold: 0, silver: 0, copper: 0, copperTotal: 0 };
  const re = new RegExp(`(\\d+)\\s+(${DENOM})`, 'g');
  let m;
  while ((m = re.exec(String(fragment ?? ''))) !== null) {
    const n = Number(m[1]);
    out[m[2]] += n;
    out.copperTotal += n * COPPER_PER[m[2]];
  }
  return out;
}

/**
 * Collapse a creature name to one key.
 *
 * The same mob arrives spelled two ways depending on where it sits in the sentence —
 * "You have slain a froglok shin knight!" against "A froglok shin knight has been slain
 * by Rhain!" — and counting those as two creatures would make every kill list wrong in a
 * way that looks plausible. `stripArticle` already solves exactly this for the combat
 * parser, so it is imported rather than rewritten.
 */
export function creatureKey(raw) {
  return stripArticle(String(raw ?? '').trim());
}

/** Strip a leading article from an item name: "a Mote of Lesser Potential" -> the mote. */
export function itemKey(raw) {
  return stripArticle(String(raw ?? '').trim());
}

/**
 * @typedef {Object} SessionEvent
 * @property {string} kind      event discriminator
 * @property {string} category  which switch governs it
 * @property {number} [ts]      stamped by the tracker, not by the rule
 */

/** The ordered rule table. First match wins, exactly like the combat one. */
export const SESSION_RULES = [
  // ------------------------------------------------------------------ kills and deaths
  {
    // (confirmed) "You have slain a froglok shin knight!"
    //
    // The killing blow was yours. Note this is the same line the combat parser reads as a
    // death event — two tables, two readings of one line, which is the point of keeping
    // them apart: this one does not care who was fighting, only what stopped existing.
    id: 'kill-self',
    category: 'kills',
    re: /^You have slain (.+)!$/,
    make: (m) => ({ kind: 'kill', victim: creatureKey(m[1]), killer: 'You' }),
  },
  {
    // (confirmed) "A froglok shin knight has been slain by Rhain!"
    // (confirmed) "A froglok shin knight has been slain by Rhale`s warder!"
    //
    // Somebody else landed it. The killer arrives RAW — including the backtick pet form —
    // because deciding whether that name is one of ours is the tracker's job, and it needs
    // the roster to answer. A rule that guessed here would credit a passing stranger's
    // kills to the night's total.
    id: 'kill-other',
    category: 'kills',
    re: /^(.+?) has been slain by (.+?)!$/,
    make: (m) => ({ kind: 'kill', victim: creatureKey(m[1]), killer: m[2] }),
  },
  {
    // (confirmed) "You have been slain by an urd ghoul wizard!"
    //
    // Filed under `kills` rather than a switch of its own: it is the same ledger read from
    // the other side, and a player who wanted kill counts and not deaths would be asking
    // for a scoreboard rather than a session.
    id: 'death-self',
    category: 'kills',
    re: /^You have been slain by (.+)!$/,
    make: (m) => ({ kind: 'death', killer: creatureKey(m[1]) }),
  },

  // ------------------------------------------------------------------------------ coin
  {
    // (confirmed) "You receive 3 gold, 6 silver and 7 copper from the corpse."
    // (confirmed) "You receive 8 copper from the corpse."
    id: 'coin-corpse',
    category: 'coin',
    re: new RegExp(`^You receive (${COIN_FRAG}) from the corpse\\.$`),
    make: (m) => ({ kind: 'coin', source: 'corpse', coin: parseCoin(m[1]) }),
  },
  {
    // (confirmed) "You receive 7 gold 2 silver from Wanderer Rakshaazi for the Cyclops Toes(s)."
    //
    // The merchant SALE line — income, and the plan expected not to find it. It is in the
    // log, worded with plain spaces between denominations rather than the corpse line's
    // commas, which is why COIN_FRAG accepts both. The trailing "(s)" is the game's own
    // plural hedge and is dropped from the item name.
    id: 'coin-sale',
    category: 'coin',
    re: new RegExp(`^You receive (${COIN_FRAG}) from (.+?) for the (.+)\\(s\\)\\.$`),
    make: (m) => ({
      kind: 'coin', source: 'sale', coin: parseCoin(m[1]), merchant: m[2], item: m[3],
    }),
  },
  {
    // (confirmed) "You received 3 platinum, 2 gold, 1 silver and 4 copper from that item."
    //
    // Past tense, and a separate source: this is a container or a turn-in paying out, not
    // a corpse and not a merchant. Kept distinct rather than folded into `corpse` because
    // "what did the camp drop" is the question the coin pane exists to answer, and mixing
    // quest payouts into it would inflate the answer.
    id: 'coin-item',
    category: 'coin',
    re: new RegExp(`^You received (${COIN_FRAG}) from that item\\.$`),
    make: (m) => ({ kind: 'coin', source: 'item', coin: parseCoin(m[1]) }),
  },
  {
    // (unconfirmed) "You receive 1 platinum 2 gold as your split."
    //
    // The group coin-split line. Not present in the sample log — every session in it
    // looted corpses directly — so this is classic EverQuest wording carried forward and
    // flagged. `collect-unknown.js` against a night of grouped play settles it in one pass.
    id: 'coin-split',
    category: 'coin',
    re: new RegExp(`^You receive (${COIN_FRAG}) as your (?:split|share)\\.$`),
    make: (m) => ({ kind: 'coin', source: 'split', coin: parseCoin(m[1]) }),
  },
  {
    // (confirmed) "You purchased 1 Spell: Wrath from Zealot Zorshais for  6 platinum 3 gold 9 copper."
    //
    // Note the DOUBLE space before the amount — it is in the real log, and `\s+` rather
    // than a literal space is the whole difference between this rule working and this rule
    // silently never firing.
    id: 'purchase',
    category: 'coin',
    re: new RegExp(`^You purchased (\\d+) (.+?) from (.+?) for\\s+(${COIN_FRAG})\\.$`),
    make: (m) => ({
      kind: 'spend', source: 'purchase', qty: Number(m[1]),
      item: m[2], merchant: m[3], coin: parseCoin(m[4]),
    }),
  },

  // ------------------------------------------------------------------------------ loot
  {
    // (confirmed) "--You have looted a Mote of Lesser Potential from a shin ghoul knight's corpse.--"
    //
    // The double-dash bookends are EQ's own emphasis and are part of the line, not
    // decoration this rule may skip: without them the pattern would also match the loot
    // messages the game prints about OTHER people.
    id: 'loot',
    category: 'loot',
    re: /^--You have looted (.+?) from (.+?)'s corpse\.--$/,
    make: (m) => ({ kind: 'loot', item: itemKey(m[1]), from: creatureKey(m[2]) }),
  },

  // ------------------------------------------------------- experience, levels and AA
  {
    // (confirmed) "You gain experience! (8.001%)"
    //
    // A percentage OF THE CURRENT LEVEL and nothing else — there is no absolute experience
    // number anywhere in the log. Everything downstream of this rule has to respect that;
    // see the per-level ledger in session.js for what it costs and why it is worth it.
    id: 'xp-solo',
    category: 'xp',
    re: /^You gain experience! \((\d+(?:\.\d+)?)%\)$/,
    make: (m) => ({ kind: 'xp', percent: Number(m[1]), share: 'solo' }),
  },
  {
    // (confirmed) "You gain party experience! (0.769%)"
    id: 'xp-party',
    category: 'xp',
    re: /^You gain party experience! \((\d+(?:\.\d+)?)%\)$/,
    make: (m) => ({ kind: 'xp', percent: Number(m[1]), share: 'party' }),
  },
  {
    // (confirmed) "You have gained a level! Welcome to level 28!"
    //
    // The only line that states a level outright, which makes it the only thing that can
    // anchor the ledger: after it, and only after it, do we know we are standing at 0% of
    // a known level.
    id: 'level-up',
    category: 'xp',
    re: /^You have gained a level! Welcome to level (\d+)!$/,
    make: (m) => ({ kind: 'level', level: Number(m[1]), direction: 'up' }),
  },
  {
    // (unconfirmed) "You LOST a level! You are now level 27!"
    //
    // No death in the sample cost a level, so this is classic wording. It matters more
    // than its rarity suggests: a de-level that went unnoticed would leave the ledger
    // accumulating into a segment labelled with the wrong number.
    id: 'level-lost',
    category: 'xp',
    re: /^You LOST a level! You are now level (\d+)!$/,
    make: (m) => ({ kind: 'level', level: Number(m[1]), direction: 'down' }),
  },
  {
    // (confirmed) "You have gained an ability point!  You now have 1 ability point."
    //
    // DOUBLE space after the exclamation mark, in the real log, same trap as the purchase
    // line. The running total the game states is taken as truth rather than counted here:
    // it is the game's own number and it survives a session that started mid-stream.
    id: 'aa-earned',
    category: 'xp',
    re: /^You have gained an ability point!\s+You now have (\d+) ability points?\.$/,
    make: (m) => ({ kind: 'aa-earned', unspent: Number(m[1]) }),
  },
  {
    // (confirmed) "You have gained the ability "Combat Fury" at a cost of 1 ability points."
    //
    // The spend line, and the reason ability points are worth tracking at all: a window
    // that only said "you earned 6" would be answering half the question.
    id: 'aa-spent',
    category: 'xp',
    re: /^You have gained the ability "(.+?)" at a cost of (\d+) ability points?\.$/,
    make: (m) => ({ kind: 'aa-spent', ability: m[1], cost: Number(m[2]) }),
  },
  {
    // (confirmed) "You have improved Unbound Nature 2 at a cost of 0 ability points."
    //
    // Ranking up an ability already owned. Its own rule because the wording differs and
    // because a zero-cost improvement is real — this server hands some ranks out free, and
    // folding them into `aa-spent` would print a spend list whose costs sum to less than
    // the list implies.
    id: 'aa-improved',
    category: 'xp',
    re: /^You have improved (.+?) at a cost of (\d+) ability points?\.$/,
    make: (m) => ({ kind: 'aa-spent', ability: m[1], cost: Number(m[2]), improved: true }),
  },

  // --------------------------------------------------------------------------- faction
  {
    // (confirmed) "Your faction standing with Frogloks of Guk has been adjusted by -5."
    id: 'faction-adjust',
    category: 'faction',
    re: /^Your faction standing with (.+?) has been adjusted by (-?\d+)\.$/,
    make: (m) => ({ kind: 'faction', faction: m[1], delta: Number(m[2]) }),
  },
  {
    // (confirmed) "Your faction standing with Undead Frogloks of Guk could not possibly get any worse."
    // (confirmed) "Your faction standing with Emerald Warriors could not possibly get any better."
    //
    // Both directions are in the log — the plan expected only the negative one. A cap is
    // not a delta and must not be counted as zero: "capped, still killing them" and "no
    // faction changed hands" are different facts and the pane says which.
    id: 'faction-cap',
    category: 'faction',
    re: /^Your faction standing with (.+?) could not possibly get any (worse|better)\.$/,
    make: (m) => ({ kind: 'faction-cap', faction: m[1], at: m[2] }),
  },

  // ---------------------------------------------------------------------------- skills
  {
    // (confirmed) "You have become better at Athletics! (135)"
    //
    // The number is the new skill value, not the gain, so the session's story about a
    // skill is "from the first value seen to the last" rather than a sum.
    id: 'skill-up',
    category: 'skills',
    re: /^You have become better at (.+?)! \((\d+)\)$/,
    make: (m) => ({ kind: 'skill', skill: m[1], value: Number(m[2]) }),
  },
  {
    // (confirmed) "You have fashioned the items together to create something new: Metal Bits."
    //
    // A successful combine. Filed under `skills` because that is the question it answers —
    // what did this night's crafting produce — and because a tradeskill switch of its own
    // would be an eighth category for one line.
    id: 'tradeskill',
    category: 'skills',
    re: /^You have fashioned the items together to create something new: (.+)\.$/,
    make: (m) => ({ kind: 'tradeskill', item: m[1] }),
  },

  // ----------------------------------------------------------------------------- zones
  {
    // (confirmed) "You have entered The Northern Desert of Ro."
    //
    // The combat parser has this line too, and reads it as "close the encounter". Here it
    // means "start timing a new zone" and closes nothing: a session survives zoning by
    // design, because walking to the next camp is part of the same night.
    //
    // The capital is load-bearing, exactly as it is in the parser's copy of this rule:
    // "You have entered an area where levitation effects do not function." is worded
    // identically and is not a zone. Without the anchor it appears in the travels pane as
    // a place the player went, which is a sentence pretending to be a location.
    id: 'zone',
    category: 'zones',
    re: /^You have entered ([A-Z].*)\.$/,
    make: (m) => ({ kind: 'zone', zone: m[1] }),
  },
];

/** Every id in the table, so a caller can be checked against reality. */
export const SESSION_RULE_IDS = Object.freeze(SESSION_RULES.map((r) => r.id));

/**
 * Run the table over one timestamp-stripped line body.
 *
 * `isOn` gates at RULE EVALUATION rather than at display. A disabled category never runs
 * its regex, never accumulates and never reaches the store — which is what makes "off"
 * genuinely free, instead of the usual arrangement where everything is computed and then
 * hidden. It defaults to "everything on" so the replay script and the tests do not each
 * have to build a category map.
 *
 * @param {string} body
 * @param {(category: string) => boolean} [isOn]
 * @returns {SessionEvent|null} null when no enabled rule matched
 */
export function matchSessionRule(body, isOn = () => true) {
  for (const rule of SESSION_RULES) {
    if (!isOn(rule.category)) continue;
    const m = rule.re.exec(body);
    if (m) {
      const event = rule.make(m);
      event.rule = rule.id;
      event.category = rule.category;
      return event;
    }
  }
  return null;
}
