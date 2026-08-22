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
  'smashes', 'smash',   // evil eyes; surfaced by collect-unknown against the live log
  // 2,638 swings in the live log went unparsed for want of this one: 1,374 hits and
  // 1,264 misses across eight different players (Glorb 536, Rhain 416, Syphon 112,
  // Ribbers 100, …). Nothing about it is exotic — it simply was not in the sample.
  'reaves', 'reave',
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

/** Damage-shield verbs that state their element. The rest stay honestly untyped. */
const DS_VERB_TYPE = {
  burned: 'fire',
  singed: 'fire',
  frozen: 'cold',
  shocked: 'magic',
};

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
  '^(.+?) (' +
    'tells (?:you|the group|the guild|the raid|[A-Za-z]+\\d*:\\d+)|' +
    'told (?:you|the group|[A-Za-z]+)|' +
    'says?(?: out of character)?|' +
    'shouts?|' +
    'auctions?|' +
    'whispers?' +
  '),\\s'
);

/**
 * The self forms. "told"/"said" are included because the log really does write
 * "You told Rhain, '...'" (152 occurrences) — without them an outgoing tell reaches
 * the damage rules, where any combat text the player quoted would score.
 */
const SELF_CHAT_RE = /^You (?:tells?|told|says?|said|shouts?|auctions?|whispers?)\b/;

/**
 * Channel forms that PROVE the speaker is a real player.
 *
 * Deliberately narrow, because the cost of a false positive here is the bee bug in
 * reverse — a mob marked a player is friendly forever, and its damage stops counting:
 *   - bare `says,` is out: mobs use it for summon call-outs
 *     ("Bazzzazzt says, 'You will not evade me, Khanvikt!'")
 *   - `tells you` / `told you` are out: that is how a pet reports to its Master
 *   - `shouts` is out: EverQuest mobs shout, and the live log contains no player
 *     shouts at all, so including it would be pure risk for no coverage
 * What is left needs a player client to produce: a group, guild, raid or custom
 * channel line. 917 distinct names arrive this way and not one is a pet or a bee.
 */
const PLAYER_PROOF_CHANNEL_RE = /^(?:tells (?:the group|the guild|the raid|[A-Za-z]+\d*:\d+)|auctions?)$/;

/**
 * The self-originated chat forms the in-game mapping command may ride on.
 *
 * Not tied to one channel on purpose: party chat does not exist when you are solo —
 * which is exactly when you would be mapping your own pet — guild chat needs a guild
 * and raid chat needs a raid. `/echo` and self-tells are both rejected by Legends, so
 * these five (all proven in the live log) are what remains. Only the SELF form is
 * matched: everyone else's chat lands in the same log, and a third-person rule would
 * let anyone in /general reconfigure the overlay by typing the magic words.
 */
const SELF_CHANNEL =
  'You (?:say|tell your party|tell your raid|say to your guild|tell [A-Za-z]+\\d*:\\d+)';

/**
 * The command keyword, spelled the several ways a person actually types it.
 *
 * The command is typed blind — the log is the only place it lands, and a near miss
 * writes nothing and says nothing, so the player is left staring at an unchanged
 * overlay with no idea whether the overlay disagreed or never heard them. That is
 * precisely what happened in the live log: `pets Jonarn = Khanvikt` was typed into
 * party chat and silently ignored because the rule only accepted the singular. The
 * plural is the natural way to say it (the setting is called "Named pets"), so it is
 * the rule that was wrong. Capitalization gets the same treatment for the same reason.
 *
 * Loosening the keyword costs nothing in safety: what keeps ordinary chatter out is
 * the anchor to the ENTIRE quoted message plus the mandatory `=`, neither of which
 * moves here. "pets are expensive" still cannot match — it has no `=`.
 */
const PET_CMD = '[Pp]ets?';

/**
 * A name as the mapping command accepts it: letters, spaces and backticks.
 *
 * Spaces and articles are how charmed pets are spelled — the live log's five failed
 * attempts at `pets a skeletal monk = Rhale` are what this used to reject with a
 * letters-only token, answering each with the very syntax the player was already
 * typing. The backtick admits named mobs like `` Torklar Battlemaster `` and the odd
 * `` Teir`Dal `` spelling. This capture deliberately takes MORE than is valid — which
 * half is the pet, whether the owner is real, whether the direction is backwards — so
 * the handler, which can see the roster, answers every near miss specifically instead
 * of this table silently routing it to the generic malformed toast.
 */
const PET_NAME = "([A-Za-z][A-Za-z `]{0,47}?)";

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

  // ------------------------------------------------------- summons, before chat
  {
    // (confirmed) "Master Yael says, 'You will not evade me, Emalina!'"
    //
    // The summon call-out — a boss yanking a player to itself, named victim and all.
    // It arrives as an ordinary say-line, so it must precede the chat rule that would
    // otherwise swallow it: the same placement precedent as pet-reports-to-master.
    // The rule emits whoever SAID it verbatim; deciding whether that sayer is actually
    // hostile is the parser's job — a player typing this sentence in /say must parse
    // as a summon here and then fail the hostility guard there, never alert.
    id: 'summon-say',
    re: /^(.+?) says, 'You will not evade me, (.+?)!'$/,
    make: (m) => ({ kind: 'summon', attacker: m[1], victim: m[2] }),
  },
  {
    // (confirmed) "You have been summoned!"
    //
    // The game's own confirmation on the victim's client. It is the fallback for a
    // mob that words its say-line differently — and when a say-line naming You just
    // fired, the parser folds this into that warning rather than stacking a second.
    id: 'summon-self',
    re: /^You have been summoned!$/,
    make: () => ({ kind: 'summon', attacker: null, victim: 'You' }),
  },

  // --------------------------------------------------- the mapping command, before chat
  {
    // (confirmed forms) "You say, 'pet ?'"
    //
    // The parser's only input is the log, so anything the client writes to the log can
    // be a control channel. This is the list form; see SELF_CHANNEL for why it is not
    // tied to one chat command. Must precede the chat rules, which would swallow it —
    // the same placement precedent as pet-reports-to-master and summon-say.
    id: 'pet-command-list',
    re: new RegExp('^' + SELF_CHANNEL + ", '" + PET_CMD + " *\\? *'$"),
    make: () => ({ kind: 'pet-command', action: 'list' }),
  },
  {
    // (confirmed forms) "You tell your party, 'pet Kibektik = Khanvikt'"
    //                   "You say, 'pet Kibektik = none'"
    //                   "You tell your party, 'pets Jonarn = Khanvikt'"
    //                   "You tell your party, 'pets a skeletal monk = Rhale'"
    //
    // Anchored to the ENTIRE quoted message, not a substring, so chatter that merely
    // contains the words is ignored — "pet needs heals" cannot match. No `eqlo` prefix:
    // the anchor plus the self form is what provides safety, and a prefix would only
    // make the command harder to type. Names follow PET_NAME — loose on purpose, so a
    // charmed mob's article-and-spaces spelling parses and every judgement about what
    // the names ARE lives in the handler.
    //
    // Whitespace is forgiving on every seam a typist can get wrong — a doubled space
    // after the keyword, a stray trailing space before the closing quote — because none
    // of it changes what was meant and all of it used to mean silence.
    id: 'pet-command-set',
    re: new RegExp(
      '^' + SELF_CHANNEL + ", '" + PET_CMD + ' +' + PET_NAME + ' *= *' + PET_NAME + " *'$"
    ),
    make: (m) => (/^none$/i.test(m[2])
      ? { kind: 'pet-command', action: 'clear', pet: m[1] }
      : { kind: 'pet-command', action: 'set', pet: m[1], owner: m[2] }),
  },
  {
    // Last of the three, so a well-formed command never reaches it: whatever lands here
    // opened with the keyword, contains an `=`, and still failed to parse.
    //
    // Its whole job is to break the silence. The command is typed into the game with no
    // completion, no echo and no error, so before this rule the only difference between
    // "the overlay disagreed" and "the overlay never heard you" was an overlay that did
    // not change — and a player who reasonably concludes the feature is broken. Now a
    // near miss says so and reprints the syntax.
    //
    // The `=` is what keeps this off ordinary conversation: talking ABOUT pets is common
    // ("pet weapon - jk lol", "pet heals don't trigger divine invo"), and none of it
    // carries an equals sign. The self-channel anchor still applies, so at worst the
    // player sees one stray toast about something they themselves typed.
    id: 'pet-command-malformed',
    re: new RegExp('^' + SELF_CHANNEL + ", '" + PET_CMD + "\\b[^']*=[^']*'$"),
    make: () => ({ kind: 'pet-command', action: 'malformed' }),
  },

  // ---------------------------------------------------------------- chat next
  {
    // The speaker and the channel are captured, not discarded: talking on a group,
    // guild, raid or custom channel is something only a player client can do, which
    // makes those forms the cleanest player proof in the log (see roster.js).
    id: 'chat',
    re: CHAT_RE,
    make: (m) => (PLAYER_PROOF_CHANNEL_RE.test(m[2])
      ? { kind: 'player-proof', who: m[1] }
      : { kind: 'chat' }),
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
    //
    // The VERB is the log stating the shield's element — "burned by" is fire, "frozen
    // by" is cold — so it is captured and mapped, which is reading the line, not
    // guessing. "pierced"/"struck" name no element and map to nothing.
    // "tormented" joins the list on the same evidence as the rest: 225 lines in the live
    // log ("A fire giant warrior is tormented by Kadomony's frost for 12 points of
    // non-melee damage."). It names no element — "frost" is the shield's own name, not a
    // damage type the line states — so it maps to nothing and stays honestly untyped.
    id: 'damage-shield',
    re: /^(.+?) (?:is|are) (pierced|burned|frozen|struck|singed|shocked|tormented) by (.+?) for (\d+) points? of non-melee damage[.!]$/,
    make: (m) => ({
      kind: 'damage',
      source: 'ds',
      attacker: possessiveOwner(m[3]),
      target: m[1],
      amount: Number(m[4]),
      ability: 'Damage Shield',
      damageType: DS_VERB_TYPE[m[2]] ?? null,
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
    // "You have been slain by a froglok king!" — second person, so the generic
    // "has been slain" rule above can never match it. Classic EverQuest wording;
    // collect-unknown.js will flag it if this server phrases the player's own death
    // differently.
    id: 'death-self',
    re: /^You have been slain by (.+?)!$/,
    make: (m) => ({ kind: 'death', target: 'You', attacker: m[1] }),
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
  {
    // (confirmed) "a tal ghoul wizard's Instill spell is interrupted."
    // (confirmed) "Emalina's Renewing Echo spell is interrupted."
    //
    // The one wording covers everyone — the live log has no bare "Your spell is
    // interrupted." variant. Spell names containing an apostrophe ("Tishan's Clash")
    // still split correctly because the caster group is non-greedy: it stops at the
    // FIRST "'s", which is the caster's possessive.
    //
    // An interrupted cast can no longer explain stray damage or a charm landing, and
    // it is what clears a hostile-cast warning — the whole point of calling for the
    // interrupt is seeing it confirmed.
    id: 'cast-interrupted',
    re: /^(.+?)'s (.+?) spell is interrupted\.$/,
    make: (m) => ({ kind: 'interrupt', attacker: m[1], ability: m[2] }),
  },
  {
    // (confirmed) "You resist a zol ghoul knight's Ghoul Root!"
    //
    // A resist is proof the spell FIRED, which for an innate breath AE can be the only
    // proof there is: the volley prints no cast line, and a group that shrugs it off
    // leaves no damage line either. That is why the shipped boss timers for Lava Breath
    // and Frost Breath match this line as well as the damage (see mine-rhythms.js), and
    // why the parser counts it as a cast resolving.
    id: 'resist-self',
    re: /^You resist (.+?)'s (.+?)!$/,
    make: (m) => ({ kind: 'resist', target: 'You', attacker: m[1], ability: m[2] }),
  },
  {
    // (confirmed) "Master Yael resisted your Ykesha!"
    // Must precede the possessive form: "resisted your Tishan's Clash!" contains an
    // apostrophe-s that would mis-split the caster there.
    id: 'resist-your',
    re: /^(.+?) resisted your (.+?)!$/,
    make: (m) => ({ kind: 'resist', target: m[1], attacker: 'You', ability: m[2] }),
  },
  {
    // (confirmed) "Lord Nagafen resisted Rhale`s warder's Sicken!" — the non-greedy
    // caster stops at the first apostrophe-s, and a pet's backtick never confuses it.
    id: 'resist',
    re: /^(.+?) resisted (.+?)'s (.+?)!$/,
    make: (m) => ({ kind: 'resist', target: m[1], attacker: m[2], ability: m[3] }),
  },

  // ------------------------------------------------------------------- pet summons
  // A summoned pet gets a GENERATED name — "Kibektik", "Gann" — with none of the
  // backtick possessive that makes `` Rhale`s warder `` self-describing, and the log
  // never says whose it is. These flavour lines are the one place the owner is stated
  // outright, so they are what ties the two together (see roster.js's pendingSummon).
  //
  // None of them assumes the summoner is friendly: the very same wording arrives from
  // "a shadowknight", "a necro acolyte" and "a froglok sentry" in the live log. The
  // friendly guard belongs in index.js, where the roster is.
  {
    // (confirmed) "Khanvikt animates an undead servant." — necromancer and shadowknight,
    // 20 occurrences, 18 of them from friendlies.
    id: 'pet-summon-undead',
    re: /^(.+?) animates an undead servant\.$/,
    make: (m) => ({ kind: 'pet-summon', owner: m[1] }),
  },
  {
    // (confirmed) "Venun summons a frenzied spirit." / "Brewgore summons a guardian
    // spirit." / "Tormax summons a companion spirit." — shaman and beastlord.
    id: 'pet-summon-spirit',
    re: /^(.+?) summons an? (?:frenzied|guardian|companion) spirit\.$/,
    make: (m) => ({ kind: 'pet-summon', owner: m[1] }),
  },
  {
    // (confirmed) "Crusader summons forth a minor familiar." — the magician familiar.
    // The magician's ANIMATION has no flavour line at all, which is why index.js also
    // treats a bare cast as weak evidence a pet is about to appear.
    id: 'pet-summon-familiar',
    re: /^(.+?) summons forth a minor familiar\.$/,
    make: (m) => ({ kind: 'pet-summon', owner: m[1] }),
  },
  {
    // (confirmed) "Kibektik's eyes gleam with madness." — Augment Death landing.
    // (confirmed) "Rhale`s warder's eyes gleam with madness." — a provable pet, which
    // is what establishes the line is pet-only: every one of the 60-odd names it names
    // in the live log is either a backtick pet or a generated pet name.
    //
    // Paired with the CAST that produced it, this is the tighter binding: "Khanvikt
    // begins casting Augment Death IV." five seconds before "Kibektik's eyes gleam with
    // madness." is what proves Kibektik is Khanvikt's, and it corrects a mis-bind the
    // temporal path may have made.
    id: 'pet-buff-gleam',
    re: /^(.+?)'s eyes gleam with madness\.$/,
    make: (m) => ({ kind: 'pet-buff', who: m[1] }),
  },
  {
    // (confirmed) "Kibektik shrinks." — Tiny Companion landing.
    //
    // NOT pet-only on its own: "Khanvikt shrinks." follows "Khanvikt begins casting
    // Shrink." and Khanvikt is a player. Only the pairing with a pet-only spell name
    // makes it evidence, exactly as charm attribution matches on the spell rather than
    // on whoever happened to be casting (see index.js).
    id: 'pet-buff-shrink',
    re: /^(.+?) shrinks\.$/,
    make: (m) => ({ kind: 'pet-buff', who: m[1] }),
  },

  // ----------------------------------------------------------------- crowd control
  {
    // (confirmed) "a tal ghoul wizard has been charmed."
    //
    // A charmed mob fights FOR the group, and its damage is logged
    // ("A tal ghoul wizard slashes a ghoul savant for 40 points of damage."), so it is
    // real group damage belonging to whoever charmed it. This is the only charm signal
    // for OTHER people's charms; your own gets an explicit break line too (the worn-off
    // rule below), and everyone else's end has to be inferred (see index.js).
    id: 'charm',
    re: /^(.+?) has been charmed\.$/,
    make: (m) => ({ kind: 'charm', who: m[1] }),
  },
  {
    // (confirmed) "Your Charm spell has worn off of a skeletal monk."
    // (confirmed) "Your Drifting Death spell has worn off of Master Yael."
    //
    // The generic fade line for YOUR spells, target and all — the one place the log
    // states a charm ending outright rather than leaving it to be inferred from the
    // freed mob's first swing at its ex-master. Emitted for every spell; whether this
    // particular fade matters (a charm ending does, a DoT ending does not) is the
    // parser's judgement, not this table's. The pet-buff variant ("Your pet's Inner
    // Fire spell has worn off.") carries no "of" and stays unmatched noise.
    id: 'worn-off',
    re: /^Your (.+?) spell has worn off of (.+?)\.$/,
    make: (m) => ({ kind: 'worn-off', ability: m[1], target: m[2] }),
  },
  {
    // (confirmed) "a shin ghoul knight has been mesmerized."
    // Mez is NOT charm: a mezzed mob is asleep, not fighting for you. Typed separately
    // so it can never be mistaken for one.
    //
    // The same wording covers CC landing on US — "Emalina has been mesmerized.",
    // "You have been entranced." (both confirmed live) — which is why entranced and
    // captivated join the alternation: they are the enchanter mez family as this
    // server words it when the target is a person rather than a mob.
    id: 'crowd-control',
    re: /^(.+?) ha(?:s|ve) been (mesmerized|entranced|captivated|awakened|poisoned|stunned|rooted)\.$/,
    make: (m) => ({ kind: 'effect', who: m[1], effect: m[2] }),
  },
  {
    // (confirmed) "A wan ghoul knight has been awakened by Rhain."
    //
    // The mez end-line always names the waker on this server — the bare classic
    // "has been awakened." never occurs in the live log — so the rule above can
    // never catch it and the by-form needs its own entry.
    id: 'cc-awakened-by',
    re: /^(.+?) has been awakened by (.+?)\.$/,
    make: (m) => ({ kind: 'effect', who: m[1], effect: 'awakened', by: m[2] }),
  },
  {
    // (confirmed) "You are stunned!" — 691 occurrences in the live log. The second
    // person uses "are", so the has-been form above can never reach it.
    id: 'cc-self-stun',
    re: /^You are stunned!$/,
    make: () => ({ kind: 'effect', who: 'You', effect: 'stunned' }),
  },
  {
    // (confirmed) "You are no longer stunned." / "captivated" / "entranced" — the
    // explicit end-lines for CC that landed on the logging character. The alternation
    // is deliberately ONLY the effects the parser tracks as member states: ensnared,
    // hidden, poisoned and the rest of the "no longer" family stay unmatched noise.
    id: 'cc-self-end',
    re: /^You are no longer (stunned|captivated|entranced)\.$/,
    make: (m) => ({ kind: 'effect-end', who: 'You', effect: m[1] }),
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
  {
    // (confirmed) "You healed Rhale for 92 hit points."
    // (confirmed) "Rhazendude healed Vaezerk for 67 hit points."
    // (confirmed) "You healed Rhale`s warder for 69 hit points."
    //
    // The same line as above with the "by <Spell>" clause absent — 4,715 of them in the
    // live log, matching no rule and scored nowhere, which is a healer's contribution
    // quietly reading low. What produced them is not stated and is not guessable from
    // the line, so the ability is labelled the way unattributed damage already is
    // rather than credited to whatever the healer last cast.
    //
    // Cannot swallow the rule above it: that one ends "hit points by Bravery." and this
    // one requires the period immediately after "hit points".
    id: 'heal-no-spell',
    re: new RegExp(
      '^(.+?) healed (.+?)( over time)? for (\\d+)(?: \\((\\d+)\\))? hit points\\.' + MODS + '$'
    ),
    make: (m) => ({
      kind: 'heal',
      attacker: m[1],
      target: m[2],
      overTime: Boolean(m[3]),
      effective: Number(m[4]),
      potential: m[5] === undefined ? Number(m[4]) : Number(m[5]),
      ability: 'Unknown',
      mods: parseMods(m[6]),
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
    //
    // The zone name must start with a CAPITAL, because the game words one of its flavour
    // messages exactly like a zone line:
    //   "You have entered an area where levitation effects do not function."
    // Without the anchor that reads as zoning, and zoning closes the encounter — so
    // stepping into a no-levitate room ended the fight you were in the middle of. It is
    // in the live log 8 times. Zone names are proper nouns and are always capitalized;
    // the flavour messages are sentences and are not.
    id: 'zone-entered',
    re: /^You have entered ([A-Z].*?)\.$/,
    make: (m) => ({ kind: 'zone', phase: 'entered', zone: m[1] }),
  },

  // ----------------------------------------------------------------- group state
  // (confirmed) All four wordings are verified against the live log — 21 third-person
  // join/leave lines ("Kadomony has joined the group.", "Khanvikt has left the group.")
  // and 16 self forms ("You have joined the group." ×10, "You have been removed from
  // the group." ×6). They were carried as unverified classic-EverQuest guesses for a
  // long time and turn out to have been right all along.
  //
  // This matters more than membership alone: explicit membership outranks every
  // heuristic below it, so wiring these up shrinks the blast radius of any single
  // misclassification — and a join/leave line is also proof the name is a real player.
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
    // (confirmed) "[29 PAL/DRU/BST] Rhale (Dwarf)  ZONE: The Greater Faydark (gfaydark)  "
    //
    // EverQuest Legends gives a character up to THREE classes at once and prints them
    // slash-joined inside one bracket. The pattern this replaces was the classic
    // single-class shape — its class group was `[A-Za-z' ]+?`, with no slash in it — so
    // it could never match a line this server writes. Measured against the live log:
    // 633 /who result lines, zero matches. The roster's /who tier has been fed nothing
    // for the entire life of the app, which is worth knowing quite apart from what the
    // reading is now used for.
    //
    // Everything after the race varies and none of it is read: an optional guild tag in
    // angle brackets, a "ZONE: <long name> (<short>)" tail, sometimes a trailing " LFG",
    // and always two trailing spaces. The pattern stops caring once the race is in hand,
    // so a tail this log happens not to contain cannot break the entry.
    //
    // Classes are exactly three uppercase letters each — the sixteen codes in the live
    // log are BER BRD BST CLR DRU ENC MAG MNK NEC PAL RNG ROG SHD SHM WAR WIZ — and
    // spelling that out is what stops the bracket from swallowing some other bracketed
    // line that happens to start with a number.
    //
    // The optional "AFK " prefix is 14 lines in the live log and is exactly the gap this
    // rule exists to close: a group member who happened to be away when somebody typed
    // /who would otherwise be the one person with no reading, silently. It comes with a
    // leading space the plain entry does not have — EQ writes "]  AFK [13 WAR/...", two
    // spaces after the timestamp — which is why the anchor tolerates leading whitespace.
    // Note what is NOT
    // accepted — "* RIP *[44 MNK/SHM/NEC] Sisco's corpse (Dark Elf) ZONE: …", which /who
    // also prints. That entry names a corpse, not a combatant, and reading it would file
    // a sighting under "Sisco's corpse", a key no row will ever carry.
    id: 'who-entry',
    re: /^\s*(?:AFK\s+)?\[(\d+)\s+([A-Z]{3}(?:\/[A-Z]{3})*)\]\s+([A-Za-z]+)\s+\(([^)]+)\)(?:\s*<([^>]+)>)?/,
    make: (m) => ({
      kind: 'who',
      who: m[3],
      level: Number(m[1]),
      // However many the character has — three, two, or one. Kept as a list rather than
      // a joined string so the rule states what it read and the renderers decide how it
      // reads; `className` is gone because nothing ever consumed it.
      classes: m[2].split('/'),
      race: m[4],
      // Parsed and carried, never displayed: guild names run long enough
      // ("Four Inches Is Fine", "Heroes of Mithril Halls") that neither the overlay
      // panel nor the History head line has the width for one. It is in the record if
      // it is ever wanted.
      guild: m[5] ?? null,
    }),
  },
  {
    // (confirmed) "[ANONYMOUS] Raplah " — 6 lines in the live log.
    //
    // Matched for the one thing it does prove: the name belongs to a real player. It
    // carries no level, no classes and no race, and says so with `anonymous` rather
    // than with absent fields, so the roster can tell "went anonymous" apart from a
    // reading that failed to parse — the first must not erase what /who said earlier.
    //
    // Same optional "AFK " prefix as the entry above ("AFK [ANONYMOUS] Rumgruk ", twice
    // in the live log): being away changes nothing about what the line proves.
    id: 'who-anonymous',
    re: /^\s*(?:AFK\s+)?\[ANONYMOUS\]\s+([A-Za-z]+)/,
    make: (m) => ({ kind: 'who', who: m[1], anonymous: true }),
  },

  // ----------------------------------------------------------------- proc flavour
  {
    // (confirmed) "A spiroc guardian has been struck by the force of Ykesha."
    //
    // The flavour half of a weapon proc. It carries NO damage and must never be
    // scored: the damage arrives on its own `spell-damage` line
    // ("Rhale`s warder hit a spiroc guardian for 75 points of magic damage by Ykesha."),
    // and the pairing is exactly 1:1 — 746 flavour lines, 746 damage lines across the
    // whole log. Matching it as a typed no-op keeps collect-unknown.js quiet without
    // letting a single point of Ykesha damage count twice.
    id: 'proc-flavor',
    re: /^(.+?) has been struck by the force of (.+?)\.$/,
    make: (m) => ({ kind: 'proc-flavor', target: m[1], ability: m[2] }),
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
 * One rule's pattern, as a string, by id.
 *
 * The Triggers window shows what a built-in rule actually matches instead of a sentence
 * about it, and this is the door it reads through. A door rather than the table itself,
 * for two reasons: the ORDER of `RULES` is load-bearing and nothing outside this file
 * should be in a position to depend on it, and a `RegExp` handed out carries a mutable
 * `lastIndex` that a careless consumer could leave mid-string in the parser's own copy.
 *
 * Reading the live source is the whole point. A pattern quoted by hand somewhere else is
 * one that goes stale the first time this one is corrected, and the failure shows up as a
 * screen quietly telling the player something untrue.
 *
 * @param {string} id
 * @returns {string|null} null for an id no rule answers to
 */
export function ruleSource(id) {
  return RULES.find((rule) => rule.id === id)?.re.source ?? null;
}

/** Every id `ruleSource` answers for, so a caller can be checked against reality. */
export const RULE_IDS = Object.freeze(RULES.map((rule) => rule.id).filter(Boolean));

/**
 * The rules that consume somebody TALKING.
 *
 * Named by rule id rather than inferred from the event kind, because the chat rule emits
 * TWO kinds: `chat` normally, and `player-proof` when the channel itself proves the
 * speaker is a real player. So "kind === 'chat'" is a strictly narrower question than
 * "was this line speech", and anything relying on the former silently lets guild, group,
 * raid and auction lines through.
 *
 * `src/session/` asks exactly this question — it is the entire chat guard that keeps a
 * player quoting "You have slain a froglok shin knight!" in /general out of the night's
 * kill count. Asking it by id means a future chat form cannot reopen the hole by
 * inventing a third kind.
 */
export const CHAT_RULE_IDS = Object.freeze(['chat', 'chat-self']);

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
 * Strip a spell's rank suffix: "Frost Storm VIII" -> "Frost Storm".
 *
 * This server ranks spells with a trailing roman numeral, and it prints that rank on
 * the CAST line but NOT on the damage line:
 *
 *   Syphon begins casting Frost Storm VIII.
 *   Syphon hit a spiroc guardian for 428 points of cold damage by Frost Storm.
 *
 * Anything that pairs the two has to collapse them first. Proc detection is the
 * obvious case — without this, every ranked spell in the game reads as an ability that
 * deals damage and is never cast, which is exactly the definition of a proc and
 * exactly the wrong answer (163k of Syphon's Frost Storm damage labelled a proc when
 * he cast it 454 times).
 */
export function spellStem(name) {
  return String(name ?? '').trim().replace(/\s+[IVXLC]+$/, '');
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
