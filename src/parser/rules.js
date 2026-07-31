/**
 * Ordered rule table: a log body (timestamp already stripped) in, a typed event out.
 *
 * Order matters. Chat lines are matched FIRST so that a player quoting
 * "he hits me for 100 points of damage" in /general never becomes a damage event.
 * After that, more specific damage forms precede more general ones.
 *
 * Rules emit RAW names exactly as they appeared. Turning "You" or "Rhale`s warder"
 * into a canonical combatant is index.js's job (via entities.js), which keeps this
 * table free of any notion of who is logged in.
 *
 * Wording below marked (confirmed) was verified against tests/fixtures/combat-sample.log
 * from a live EverQuest Legends session; the rest follows classic EverQuest wording and
 * is flagged by scripts/collect-unknown.js if this server words it differently.
 */

/**
 * Attack verbs, both base ("You crush") and third-person ("Rhain crushes") forms.
 * A whitelist is required: target names contain spaces, so without one the melee
 * pattern could not tell attacker from target.
 * Multi-word phrases must precede their prefixes in the alternation ("frenzies on"
 * before "frenzies"), which sortByLength below guarantees.
 */
export const ATTACK_VERBS = [
  // confirmed in the sample log
  'hits', 'hit',
  'crushes', 'crush',
  'slashes', 'slash',
  'pierces', 'pierce',
  'kicks', 'kick',
  'bashes', 'bash',
  'cleaves', 'cleave',
  'smites', 'smite',
  'punches', 'punch',
  'frenzies on', 'frenzy on',
  'backstabs', 'backstab',
  // standard EverQuest attack verbs not present in the sample
  'bites', 'bite',
  'claws', 'claw',
  'mauls', 'maul',
  'gores', 'gore',
  'slices', 'slice',
  'strikes', 'strike',
  'rends', 'rend',
  'stings', 'sting',
  'slams', 'slam',
  'sweeps', 'sweep',
  'shoots', 'shoot',
  'burns', 'burn',
  'freezes', 'freeze',
  'lashes', 'lash',
];

const sortByLength = (a, b) => b.length - a.length;
const alt = (words) => words.slice().sort(sortByLength).map(escapeRe).join('|');

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const VERB_ALT = alt(ATTACK_VERBS);

/** Trailing modifiers EQ appends: " (Critical)", " (Flurry)", " (Critical) (Lucky)". */
const MODS = '((?: \\([^)]*\\))*)';

/** Parse the trailing "(Critical) (Flurry)" blob into a lowercase string array. */
export function parseMods(raw) {
  if (!raw) return [];
  const out = [];
  const re = /\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(raw)) !== null) out.push(m[1].trim().toLowerCase());
  return out;
}

/**
 * Chat and channel lines. Matched before everything else so quoted combat text
 * cannot be mistaken for combat. Kept as a typed event (not dropped) so that
 * collect-unknown.js reports a genuinely unrecognised line rather than chat noise.
 */
const CHAT_RE = new RegExp(
  '^(.+?) (?:' +
    'tells (?:you|the group|the guild|the raid|[A-Za-z]+:\\d+)|' +
    'told (?:you|the group)|' +
    'says?(?: out of character)?|' +
    'shouts?|' +
    'auctions?|' +
    'whispers?' +
  '),\\s'
);

const SELF_CHAT_RE = /^You (?:tell|say|shout|auction|whisper)\b/;

/**
 * @typedef {Object} LogEvent
 * @property {string} kind         event discriminator
 * @property {string} [attacker]   raw attacker name
 * @property {string} [target]     raw target name
 * @property {number} [amount]     damage or heal amount
 * @property {string} [ability]    spell/skill name, or the melee verb
 * @property {string} [source]     'melee' | 'spell' | 'dot' | 'ds' | 'nonmelee'
 * @property {string[]} [mods]     ['critical'], ['flurry'], ...
 */

/** The ordered rule table. First match wins. */
export const RULES = [
  // ------------------------------------------------- pet ownership, before chat
  {
    // (confirmed) "Rhale`s warder told you, 'Attacking a froglok shin knight Master.'"
    // (confirmed) "Rhale`s warder told you, 'I am unable to wake a shin ghoul knight, Master.'"
    //
    // A pet addressing you as Master proves it is YOUR pet — which is the only way to
    // learn the owner of a *named* pet (one without the `s possessive) from the log.
    // Must precede the chat rule, which would otherwise swallow it as a tell.
    id: 'pet-reports-to-master',
    re: /^(.+?) (?:tells|told) you, '.*\bMaster[.,]?'$/,
    make: (m) => ({ kind: 'pet-owner', pet: m[1], owner: 'You' }),
  },
  {
    // (confirmed) "Targeted (Player): Emalina" / "Targeted (NPC): Gann"
    //
    // The game states outright whether a name is a player or an NPC. Summoned pets
    // are NPCs, so this is what tells "Gann" (Rhain's animation) apart from a real
    // player — the name shape alone cannot, since both are one capitalized word.
    id: 'targeted',
    re: /^Targeted \((Player|NPC|Corpse)\): (.+)$/,
    make: (m) => ({ kind: 'targeted', targetKind: m[1].toLowerCase(), who: m[2] }),
  },

  // ---------------------------------------------------------------- chat next
  {
    id: 'chat',
    re: CHAT_RE,
    make: () => ({ kind: 'chat' }),
  },
  {
    id: 'chat-self',
    re: SELF_CHAT_RE,
    make: () => ({ kind: 'chat' }),
  },

  // ------------------------------------------------------------- damage dealt
  {
    // (confirmed) "Rhain hit a froglok shin knight for 109 points of magic damage by Smiting Strike."
    // (confirmed) "Rhale`s warder hit a froglok shin knight for 71 points of cold damage by Blast of Frost."
    // (confirmed) "You hit a froglok shin knight for 126 points of magic damage by Smiting Strike."
    // EQ Legends uses the bare form "hit" here for every person, and — unlike classic
    // EverQuest's unattributed non-melee line — it names the caster. That makes spell,
    // proc and skill damage fully attributable, which removes most of the risk flagged
    // in the plan's Notes.
    id: 'spell-damage',
    re: new RegExp(
      '^(.+?) hit (.+?) for (\\d+) points? of ([a-z]+) damage by (.+?)\\.' + MODS + '$'
    ),
    make: (m) => ({
      kind: 'damage',
      source: 'spell',
      attacker: m[1],
      target: m[2],
      amount: Number(m[3]),
      damageType: m[4],
      ability: m[5],
      mods: parseMods(m[6]),
    }),
  },
  {
    // (confirmed) "Rhain smites a froglok shin knight for 11 points of damage."
    // (confirmed) "You crush a froglok shin knight for 34 points of damage. (Critical)"
    // (confirmed) "Rhale`s warder bashes a froglok shin knight for 4 points of damage."
    // Note "1 point of damage" (singular) also occurs — hence "points?".
    id: 'melee-hit',
    re: new RegExp(
      '^(.+?) (' + VERB_ALT + ') (.+?) for (\\d+) points? of damage\\.' + MODS + '$'
    ),
    make: (m) => ({
      kind: 'damage',
      source: 'melee',
      attacker: m[1],
      target: m[3],
      amount: Number(m[4]),
      ability: normalizeVerb(m[2]),
      mods: parseMods(m[5]),
    }),
  },
  {
    // (confirmed) "A ghoul scribe has taken 98 damage from your Immolate. (Critical)"
    // "You have taken 29 damage from Searing Arrow by a ghoul savant."
    // Both "has" and "have" occur — the second person uses "have".
    id: 'dot-tick',
    re: new RegExp('^(.+?) ha(?:s|ve) taken (\\d+) damage from (.+?) by (.+?)\\.' + MODS + '$'),
    make: (m) => ({
      kind: 'damage',
      source: 'dot',
      attacker: m[4],
      target: m[1],
      amount: Number(m[2]),
      ability: m[3],
      mods: parseMods(m[5]),
    }),
  },
  {
    // (confirmed) "A ghoul scribe has taken 98 damage from your Immolate. (Critical)"
    id: 'dot-tick-self',
    re: new RegExp('^(.+?) ha(?:s|ve) taken (\\d+) damage from your (.+?)\\.' + MODS + '$', 'i'),
    make: (m) => ({
      kind: 'damage',
      source: 'dot',
      attacker: 'You',
      target: m[1],
      amount: Number(m[2]),
      ability: m[3],
      mods: parseMods(m[4]),
    }),
  },
  {
    // (confirmed) "Gann has taken 10 damage by Poison." — no caster named.
    id: 'dot-tick-unattributed',
    re: new RegExp('^(.+?) ha(?:s|ve) taken (\\d+) damage by (.+?)\\.' + MODS + '$'),
    make: (m) => ({
      kind: 'nonmelee-unattributed',
      source: 'dot',
      target: m[1],
      amount: Number(m[2]),
      ability: m[3],
      mods: parseMods(m[4]),
    }),
  },
  {
    // (confirmed, outgoing) "A wan ghoul knight is pierced by Emalina's thorns for 1 point of non-melee damage."
    // (confirmed, incoming) "Rhain is pierced by a wan ghoul knight's thorns for 8 points of non-melee damage."
    // (confirmed, incoming) "YOU are pierced by a wan ghoul knight's thorns for 8 points of non-melee damage!"
    //
    // Both directions share this wording, so which one it is falls out of who the
    // attacker resolves to — the shield's OWNER, after stripping the "'s thorns"
    // possessive. Without that strip the attacker reads as "Emalina's thorns", matches
    // no combatant, and several hundred points of real damage per fight are dropped.
    // Note the self form ends in "!" rather than ".".
    id: 'damage-shield',
    re: /^(.+?) (?:is|are) (?:pierced|burned|frozen|struck|singed|shocked) by (.+?) for (\d+) points? of non-melee damage[.!]$/,
    make: (m) => ({
      kind: 'damage',
      source: 'ds',
      attacker: possessiveOwner(m[2]),
      target: m[1],
      amount: Number(m[3]),
      ability: 'Damage Shield',
      mods: [],
    }),
  },
  {
    // (confirmed) "You were hit by non-melee for 6 damage."
    // No attacker is named. In the sample every one of these is fall damage — the very
    // next line reads "YOU were injured by falling." — so this is emitted as its own kind
    // and is NOT credited to anyone. index.js pairs it with a recent cast when it can and
    // otherwise buckets it under "Unknown" rather than guessing (see plan Notes).
    id: 'non-melee-unattributed',
    re: /^(.+?) (?:was|were) hit by non-melee for (\d+) damage\.$/,
    make: (m) => ({
      kind: 'nonmelee-unattributed',
      source: 'nonmelee',
      target: m[1],
      amount: Number(m[2]),
      ability: 'Unknown',
      mods: [],
    }),
  },
  {
    // (confirmed) "YOU were injured by falling." — environmental, never a combatant's doing.
    id: 'environmental',
    re: /^(.+?) (?:was|were) injured by (falling|drowning|lava|trap)\.$/i,
    make: (m) => ({ kind: 'environmental', target: m[1], cause: m[2].toLowerCase() }),
  },

  // -------------------------------------------------------------------- misses
  {
    // (confirmed) "Rhain tries to slash a froglok shin knight, but a froglok shin knight dodges!"
    // (confirmed) "You try to crush a froglok shin knight, but a froglok shin knight parries!"
    id: 'melee-avoided',
    re: new RegExp(
      '^(.+?) tr(?:ies|y) to (' + VERB_ALT + ') (.+?), but (.+?) ' +
      '(dodges?|parries|parry|blocks?|ripostes?|absorbs?)!' + MODS + '$'
    ),
    make: (m) => ({
      kind: 'miss',
      attacker: m[1],
      target: m[3],
      ability: normalizeVerb(m[2]),
      avoidance: normalizeAvoidance(m[5]),
      mods: parseMods(m[6]),
    }),
  },
  {
    // (confirmed) "Rhain tries to frenzy on a froglok shin knight, but misses!"
    // (confirmed) "You try to kick a froglok shin knight, but miss!"
    // (confirmed) "Rhale`s warder tries to slash a froglok shin knight, but misses! (Flurry)"
    id: 'melee-miss',
    re: new RegExp(
      '^(.+?) tr(?:ies|y) to (' + VERB_ALT + ') (.+?), but miss(?:es)?!' + MODS + '$'
    ),
    make: (m) => ({
      kind: 'miss',
      attacker: m[1],
      target: m[3],
      ability: normalizeVerb(m[2]),
      avoidance: 'miss',
      mods: parseMods(m[4]),
    }),
  },
  {
    // "You try to crush a golem, but a golem is INVULNERABLE!"
    id: 'melee-invulnerable',
    re: new RegExp(
      '^(.+?) tr(?:ies|y) to (' + VERB_ALT + ') (.+?), but (.+?) is INVULNERABLE!$'
    ),
    make: (m) => ({
      kind: 'miss',
      attacker: m[1],
      target: m[3],
      ability: normalizeVerb(m[2]),
      avoidance: 'invulnerable',
      mods: [],
    }),
  },
  {
    // "You try to crush a shade, but a shade's magical skin absorbs the blow!"
    id: 'melee-rune',
    re: new RegExp(
      '^(.+?) tr(?:ies|y) to (' + VERB_ALT + ') (.+?), but (.+?) magical skin absorbs the blow!$'
    ),
    make: (m) => ({
      kind: 'miss',
      attacker: m[1],
      target: m[3],
      ability: normalizeVerb(m[2]),
      avoidance: 'rune',
      mods: [],
    }),
  },

  // --------------------------------------------------------------------- deaths
  {
    // (confirmed) "A froglok shin knight has been slain by Rhain!"
    id: 'death',
    re: /^(.+?) has been slain by (.+?)!$/,
    make: (m) => ({ kind: 'death', target: m[1], attacker: m[2] }),
  },
  {
    id: 'death-self-kill',
    re: /^You have slain (.+?)!$/,
    make: (m) => ({ kind: 'death', target: m[1], attacker: 'You' }),
  },
  {
    id: 'death-plain',
    re: /^(.+?) died\.$/,
    make: (m) => ({ kind: 'death', target: m[1], attacker: null }),
  },

  // -------------------------------------------------------------------- casting
  {
    // (confirmed) "Rhale`s warder begins casting Blast of Frost."
    // (confirmed) "You begin casting Feral Spirit."
    // Feeds the short-lived cast table used to attribute unattributed non-melee damage.
    id: 'cast-start',
    re: /^(.+?) beg(?:ins|in) casting (.+?)\.$/,
    make: (m) => ({ kind: 'cast', attacker: m[1], ability: m[2] }),
  },
  {
    id: 'cast-start-generic',
    re: /^(.+?) beg(?:ins|in) to cast a spell\.$/,
    make: (m) => ({ kind: 'cast', attacker: m[1], ability: null }),
  },

  // ---------------------------------------------------------------------- heals
  {
    // (confirmed) "Emalina healed Rhain for 119 (139) hit points by Bravery."
    // (confirmed) "You healed Emalina over time for 60 (68) hit points by Flowering Heal."
    // (confirmed) "Gann healed himself for 57 hit points by Center."
    // (confirmed) "Emalina healed herself for 0 (2) hit points by Blessing of the Squire."
    //
    // The two numbers are "effective (potential)": the first is what actually landed,
    // the second what the spell would have healed at full strength. The 0 (2) form on a
    // target already at full health is what proves the order. EQ prints the parenthetical
    // ONLY when the two differ, so a single number means nothing was wasted and
    // overhealing is exact rather than estimated.
    // (confirmed) "Emalina healed herself for 457 hit points by Renewing Echo. (Critical)"
    // Heals crit too, so the modifier suffix is required here — without it a 457-point
    // critical heal parses as nothing at all.
    id: 'heal',
    re: new RegExp(
      '^(.+?) healed (.+?)( over time)? for (\\d+)(?: \\((\\d+)\\))? hit points by (.+?)\\.' + MODS + '$'
    ),
    make: (m) => ({
      kind: 'heal',
      attacker: m[1],
      target: m[2],
      overTime: Boolean(m[3]),
      effective: Number(m[4]),
      potential: m[5] === undefined ? Number(m[4]) : Number(m[5]),
      ability: m[6],
      mods: parseMods(m[7]),
    }),
  },

  // ---------------------------------------------------------------------- zoning
  {
    // (confirmed) "LOADING, PLEASE WAIT..."
    id: 'zone-loading',
    re: /^LOADING, PLEASE WAIT\.\.\.$/,
    make: () => ({ kind: 'zone', phase: 'loading', zone: null }),
  },
  {
    // (confirmed) "You have entered The Ruins of Old Guk 2 (Adaptive)."
    id: 'zone-entered',
    re: /^You have entered (.+?)\.$/,
    make: (m) => ({ kind: 'zone', phase: 'entered', zone: m[1] }),
  },

  // ----------------------------------------------------------------- group state
  // Not present in the sample session; wording follows classic EverQuest. The roster
  // also learns membership implicitly from combat, so the overlay works even if this
  // server words these differently (see roster.js).
  {
    id: 'group-joined',
    re: /^(.+?) has joined the group\.$/,
    make: (m) => ({ kind: 'group', action: 'join', who: m[1] }),
  },
  {
    id: 'group-left',
    re: /^(.+?) has left the group\.$/,
    make: (m) => ({ kind: 'group', action: 'leave', who: m[1] }),
  },
  {
    id: 'group-joined-self',
    re: /^You have joined the group\.$/,
    make: () => ({ kind: 'group', action: 'join', who: 'You' }),
  },
  {
    id: 'group-disbanded',
    re: /^Your group has been disbanded\.$/,
    make: () => ({ kind: 'group', action: 'disband', who: null }),
  },
  {
    id: 'group-removed-self',
    re: /^You have been removed from the group\.$/,
    make: () => ({ kind: 'group', action: 'disband', who: null }),
  },
  {
    // "[Level Class] Name (Race)" — /who and /who group output.
    id: 'who-entry',
    re: /^\[(\d+)\s+([A-Za-z' ]+?)\]\s+([A-Za-z]+)\s+\((.+?)\)/,
    make: (m) => ({
      kind: 'who',
      who: m[3],
      level: Number(m[1]),
      className: m[2].trim(),
      race: m[4],
    }),
  },

  // ------------------------------------------------------------------- logging on
  {
    // (confirmed) "Logging to 'eqlog.txt' is now *ON*."
    id: 'logging-state',
    re: /^Logging to '(.+?)' is now \*(ON|OFF)\*\.$/,
    make: (m) => ({ kind: 'logging', file: m[1], on: m[2] === 'ON' }),
  },
];

/**
 * "frenzies on" -> "Frenzy", "crushes" -> "Crush", "crush" -> "Crush".
 * Collapses the second- and third-person spellings of the same swing onto one
 * ability bucket, so "You crush" and "Rhain crushes" do not become two rows in
 * the hover breakdown.
 */
export function normalizeVerb(verb) {
  const base = verb.toLowerCase().replace(/ on$/, '');
  let stem;
  if (base.endsWith('ies')) {
    stem = base.slice(0, -3) + 'y';            // frenzies -> frenzy
  } else if (/(?:sh|ch|ss)es$/.test(base)) {
    stem = base.slice(0, -2);                  // crushes -> crush, punches -> punch
  } else if (base.endsWith('s') && !base.endsWith('ss')) {
    stem = base.slice(0, -1);                  // kicks -> kick, freezes -> freeze
  } else {
    stem = base;                               // already the base form
  }
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

/**
 * Strip an apostrophe-possessive to get the owner: "Emalina's thorns" -> "Emalina".
 *
 * Distinct from the pet form in entities.js, which uses a BACKTICK (`` Rhale`s warder ``).
 * Damage shields use a plain apostrophe, so they need their own unwrapping.
 */
function possessiveOwner(raw) {
  const m = /^(.+?)'s\s+\S+$/.exec(raw);
  if (!m) return /^your\b/i.test(raw) ? 'You' : raw;
  return /^your$/i.test(m[1]) ? 'You' : m[1];
}

/** "dodges" -> "dodge", "parries" -> "parry". */
function normalizeAvoidance(word) {
  const w = word.toLowerCase();
  if (w.startsWith('parr')) return 'parry';
  if (w.startsWith('ripost')) return 'riposte';
  return w.replace(/s$/, '');
}

/**
 * Run the rule table over one timestamp-stripped line body.
 * @param {string} body
 * @returns {LogEvent|null} null when no rule matched
 */
export function matchRule(body) {
  for (const rule of RULES) {
    const m = rule.re.exec(body);
    if (m) {
      const event = rule.make(m);
      event.rule = rule.id;
      return event;
    }
  }
  return null;
}
