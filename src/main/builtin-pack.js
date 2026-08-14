/**
 * The rules this app ships with, described in the shape of a trigger pack.
 *
 * The Triggers window answers one question — "what is allowed to put something on my
 * screen" — and until now that question was answered in two places: a form section for
 * the curated rules, and a window for imported packs. Two places meant the two could
 * disagree in ways nothing surfaced: a pack could be switched on while the surface it
 * draws to was switched off, and the only clue was that nothing ever appeared.
 *
 * So the built-in rules become a pack like any other. This module is the shim that makes
 * that true: it describes them in pack shape and translates a row's switch into the
 * config key that has always backed it. Nothing about the underlying settings changes —
 * `castAlerts`, the six `warn*` keys, `summonAlerts` and `ccAlerts` are read and written
 * exactly as before, so a config from an older version keeps meaning what it meant and
 * the alerts renderer needs no new vocabulary.
 *
 * Every row here draws to the alerts window, and that is not an accident of the current
 * list: the boss timers used to be a row too, and they left because they became a real
 * trigger pack. What is left is the set of rules that a pattern genuinely cannot express
 * on its own — see `matches` below for what each one is, and the info dialog for the
 * part the parser adds that a copy of the pattern will not have.
 *
 * Pure: no Electron, no filesystem of its own. It imports only the config vocabulary,
 * which makes it unit-testable in WSL like everything else that decides behaviour.
 *
 * NOTE ON NUMBERS: this deliberately carries no firing rates. Rates were measured once
 * and quoted in the settings form, but they came from a log that is mostly not raid
 * time, which makes "~7/hr" an average over hours the player was not in the content the
 * number implies. An imported pack's hit count is different and is still shown — it is
 * an absolute count against a stated number of lines, not a rate extrapolated from
 * uneven time.
 */

import { ALERT_PRESETS, WARN_GROUPS, warnKeyFor, warnGroupOn, presetOf } from './config.js';
import { ruleSource } from '../parser/rules.js';
import { SESSION_RULES } from '../session/rules.js';
import { SPELL_PATTERNS, UNKNOWN_GROUP } from '../parser/spellwatch.js';

/**
 * A rule's pattern from the SESSION table, for the one row raised by that table rather
 * than the combat one — quest loot rides the session loot rules. Same live-read
 * contract as `ruleSource`: the window cannot show a pattern the tracker stopped using.
 */
const sessionRuleSource = (id) => SESSION_RULES.find((r) => r.id === id)?.re.source ?? null;

/**
 * The pack id. Prefixed and suffixed so it can never collide with a real pack: pack ids
 * come from `safeId()` over a stranger's chosen NAME, and this is not a shape that
 * survives it.
 */
export const BUILTIN_ID = '__builtin__';

export const BUILTIN_NAME = 'EverQuest Legends';

/**
 * The rows, in the order they read.
 *
 * `key` is the config key the row's switch writes — that is the whole mapping. `kind`
 * separates a heading you can switch (`group`) from the things underneath it (`rule`),
 * and `option` marks a row that is not itself a warning but a modifier on one, which is
 * why the sound row sits with the casts rather than in a settings screen of its own.
 *
 * `catches` is the honest answer to "what does this actually match" — real log wording,
 * lifted from a live session, so a player deciding whether to switch something off can
 * see the lines it would silence. They are also the fixture that keeps the derived
 * patterns honest: `tests/builtin-pack.test.js` runs every row's rules and its recipe
 * against its own catches, so a `rules.js` or `spellwatch.js` edit that stops matching a
 * shipped example fails the suite instead of shipping a screen that lies. (It has caught
 * this once already: every cast example here read "begins to cast X", wording that
 * appears nowhere in 983,000 lines of real log.)
 *
 * `lineRules` names the rules in `rules.js` that raise the row, and `group` names the
 * `spellwatch.js` group that filters it. Between them, `builtinPack` derives the patterns
 * the window shows — nothing regex-shaped is written out by hand anywhere in this file.
 */
export const BUILTIN_ROWS = [
  {
    key: 'castAlerts',
    kind: 'group',
    surface: 'chips',
    name: 'Enemy casts',
    sub: 'interrupt calls for what the boss is casting right now',
    why:
      'The log names a spell as the cast begins, which is the only warning EverQuest ' +
      'gives you before it lands. Everything under this row is a way of saying which ' +
      'of those are worth reading mid-pull.',
    lineRules: ['cast-start', 'cast-start-generic'],
    catches: [
      'A ghoul savant begins casting Superior Healing.',
      'A cyclops begins to cast a spell.',
    ],
  },
  {
    key: warnKeyFor('heals'),
    kind: 'rule',
    parent: 'castAlerts',
    surface: 'chips',
    name: 'Heals & gates',
    sub: 'interrupt it or the kill resets',
    why:
      'A boss healing itself undoes the whole pull. This is the group worth a warning ' +
      'even when there is nothing else you can do about it — someone has to interrupt, ' +
      'and the log names the spell before it lands.',
    lineRules: ['cast-start'],
    group: 'heals',
    catches: [
      'A ghoul savant begins casting Superior Healing.',
      'Emalina begins casting Greater Healing V.',
      'Steven begins casting Gate.',
    ],
  },
  {
    key: warnKeyFor('control'),
    kind: 'rule',
    parent: 'castAlerts',
    surface: 'chips',
    name: 'Mez, charm & fear',
    sub: 'the group loses control of itself',
    why:
      'The rarest thing here and the one you drop everything for: a charmed cleric or a ' +
      'feared tank is a wipe in progress, and the window to react is the cast bar.',
    lineRules: ['cast-start'],
    group: 'control',
    catches: [
      'Hoptor Thaggelum begins casting Fear.',
      'Kronkor begins casting Enthrall.',
      'Rhain begins casting Mesmerization VIII.',
    ],
  },
  {
    key: warnKeyFor('bigHits'),
    kind: 'rule',
    parent: 'castAlerts',
    surface: 'chips',
    name: 'Big hits',
    sub: 'Harm Touch and the like — survivable, worth bracing for',
    why:
      'Not something you interrupt, something you brace for. Worth knowing a beat ' +
      'early so a heal is already in the air when it lands.',
    lineRules: ['cast-start'],
    group: 'bigHits',
    catches: ['A ghoul ritualist pet begins casting Harm Touch.'],
  },
  {
    key: warnKeyFor('locks'),
    kind: 'rule',
    parent: 'castAlerts',
    surface: 'chips',
    name: 'Roots, snares & stuns',
    sub: 'you are stuck, not dying',
    why:
      'Frequent, and usually there is nothing to do about one. On by default because ' +
      'being rooted explains why you are not where you meant to be, which is worth a ' +
      'chip even when it is not worth an action.',
    lineRules: ['cast-start'],
    group: 'locks',
    catches: [
      'A deadly black widow begins casting Ensnare.',
      'A tsu ghoul wizard begins casting Instill.',
      'Gann begins casting Root.',
    ],
  },
  {
    key: warnKeyFor('routine'),
    kind: 'rule',
    parent: 'castAlerts',
    surface: 'chips',
    name: 'Routine nukes & lifetaps',
    sub: 'named damage with nothing to do about it',
    why:
      'Off by default. The log names these constantly and the answer is always the ' +
      'same — keep healing — so a chip for each one is a chip that teaches you to stop ' +
      'reading the window.',
    lineRules: ['cast-start'],
    group: 'routine',
    catches: [
      'Orc appentice begins casting Shock of Blades.',
      'A ghoul ritualist pet begins casting Lifespike.',
    ],
  },
  {
    key: warnKeyFor('unknown'),
    kind: 'rule',
    parent: 'castAlerts',
    surface: 'chips',
    name: 'Unrecognized casts',
    sub: 'every other spell the log names — noisy, but it is how a new mob’s tricks get found',
    why:
      'Off by default, and the loudest thing here by a wide margin. Worth switching on ' +
      'deliberately when you are learning a new mob: an unrecognized cast is exactly ' +
      'the one nobody has classified yet.',
    lineRules: ['cast-start'],
    group: 'unknown',
    catches: [
      'Sister of the Spire begins casting Entomb in Ice.',
      'Bazzt Zzzt begins casting Rotting Flesh.',
    ],
  },
  {
    key: 'castAlertSound',
    kind: 'option',
    parent: 'castAlerts',
    surface: 'chips',
    name: 'Play a sound for interrupt-now warnings',
    sub: 'sound is opt-in, always',
    why:
      'A cue only for the warnings that are actually drawn — a beep for something not ' +
      'on screen is a beep with no explanation.',
    lineRules: [],
    catches: [],
  },
  {
    key: 'summonAlerts',
    kind: 'group',
    surface: 'chips',
    name: 'Summons',
    sub: 'who the boss just yanked to it — a fact that already happened, not a call to act',
    why:
      'Past tense by nature: by the time the log says it, you are already standing in ' +
      'the wrong place. It earns a chip because it explains a sudden change in where ' +
      'everyone is.',
    lineRules: ['summon-say', 'summon-self'],
    catches: [
      "A rock golem says, 'You will not evade me, Emalina!'",
      'You have been summoned!',
    ],
  },
  {
    key: 'ccAlerts',
    kind: 'group',
    surface: 'chips',
    name: 'Crowd control on the group',
    sub: 'who is stunned, mezzed or charmed right now',
    why:
      'A standing state rather than an event — the chip is present for as long as the ' +
      'effect is, so it answers "why is the tank not taunting" rather than announcing ' +
      'a moment that has passed.',
    lineRules: ['crowd-control', 'cc-self-stun', 'cc-awakened-by', 'cc-self-end'],
    catches: [
      'a shin ghoul knight has been mesmerized.',
      'You are stunned!',
      'A shin ghoul knight has been awakened by Rhale.',
      'You are no longer stunned.',
    ],
  },
  {
    key: 'charmBreakAlerts',
    kind: 'group',
    surface: 'chips',
    name: 'Charm breaks',
    sub: 'your charm wore off — the freed mob is turning on you',
    why:
      'The one worn-off line that changes what you must do next. The pattern below ' +
      'fires for every fading spell you have running; what a copy of it cannot carry ' +
      'is the judgement that makes this row quiet — the parser raises it only when ' +
      'the fade ends a charm it saw land, so a DoT expiring says nothing.',
    lineRules: ['worn-off'],
    catches: ['Your Charm spell has worn off of a skeletal monk.'],
  },
  {
    key: 'charmBreakSound',
    kind: 'option',
    parent: 'charmBreakAlerts',
    surface: 'chips',
    name: 'Play a sound when your charm breaks',
    sub: 'sound is opt-in, always',
    why:
      'Two falling notes, the mirror of the rising interrupt cue, so your ears can ' +
      'tell them apart with your eyes on the game — which is the whole point: a charm ' +
      'usually breaks while you are looking somewhere else.',
    lineRules: [],
    catches: [],
  },
  {
    key: 'questLootAlerts',
    kind: 'group',
    surface: 'chips',
    name: 'Quest loot',
    sub: 'a looted item matches a Plane of Sky class test',
    why:
      'A moment of recognition at the loot window — the chip names the item and which ' +
      'class test wants it. The patterns below are the four wordings loot arrives in; ' +
      'what a copy cannot carry is the dataset lookup that decides whether the item is ' +
      'quest loot at all. The ledger itself is in the Quests window either way.',
    lineRules: [],
    sessionRules: ['loot', 'loot-stored', 'loot-created', 'loot-sold'],
    catches: [
      "--You have looted a Crude Wooden Flute from The Spiroc Lord's corpse.--",
      "You looted a Wind Rune Lena from a blade storm's corpse and stored it in your currency",
      "You looted an Efreeti War Shield from Noble Dojorn's corpse to create an Efreeti War Shield +1",
    ],
  },
];

/** Every config key the built-in pack owns, for callers that need to watch them. */
export const BUILTIN_KEYS = BUILTIN_ROWS.map((r) => r.key);

/** The six that answer to `warnGroupOn` rather than to the plain absent-means-on rule. */
const WARN_KEY_SET = new Set(WARN_GROUPS.map(warnKeyFor));

/**
 * Is one row switched on?
 *
 * The six warning groups answer to `warnGroupOn`, which reads a missing key as its
 * DEFAULT rather than as on — that distinction is load-bearing and documented in
 * config.js, so it is delegated rather than re-implemented here. Everything else follows
 * the older rule that absent means on, so a config predating a key does not silently
 * lose the surface it draws.
 */
export function builtinRowOn(cfg, key) {
  if (WARN_KEY_SET.has(key)) return warnGroupOn(cfg, key);
  return cfg?.[key] !== false;
}

// ------------------------------------------------------------------ what it matches

/**
 * The real patterns behind one row, read live from the parser.
 *
 * `lines` is what `rules.js` matches to raise the row at all; `spells` is the
 * `spellwatch.js` entries that decide which of those casts belong to this row's group.
 * Both come from exported accessors rather than from strings kept here, so the window
 * cannot show a pattern the parser has since stopped using.
 *
 * The unrecognized-casts row has no spell patterns on purpose, and that is not an
 * omission to fill in later: it is the group a cast lands in when NOTHING above claimed
 * it, so there is no pattern to show. Its `why` says so.
 */
export function builtinMatches(row) {
  return {
    lines: [
      ...(row.lineRules ?? []).map((id) => ({ id, source: ruleSource(id) })),
      ...(row.sessionRules ?? []).map((id) => ({ id, source: sessionRuleSource(id) })),
    ].filter((r) => r.source),
    spells: row.group
      ? SPELL_PATTERNS.filter((p) => p.group === row.group)
        .map(({ category, source }) => ({ category, source }))
      : [],
  };
}

/**
 * The one pattern a row shows under its name in the list.
 *
 * Under the name, in the same `.row-pattern` treatment an imported trigger's pattern gets
 * — because that is the point: an imported trigger has always shown its pattern there and
 * a built-in rule showed prose, which is what made the shipped rules feel like a black box
 * beside a stranger's pack.
 *
 * Which pattern is the useful one depends on the row. For a warning group it is the spell
 * filter, because every one of those rows reads the SAME log line and the filter is the
 * whole difference between them. For a row that has no group — the parent, the summons,
 * the CC states — the log line is the difference, so that is what shows. The list has one
 * ellipsized line per row; the dialog has the lot.
 */
export function builtinRowPattern(row) {
  const { lines, spells } = builtinMatches(row);
  if (spells.length) return spells.map((s) => s.source).join('  |  ');
  // "Unrecognized" is the absence of every other pattern, so the honest one-liner names
  // them and says so, rather than claiming a pattern of its own that does not exist.
  if (row.group === UNKNOWN_GROUP) return `not:  ${SPELL_PATTERNS.map((s) => s.source).join('  |  ')}`;
  return lines.map((l) => l.source).join('  |  ');
}

/**
 * A row, written out as the trigger a player would have to write themselves.
 *
 * This is what "Start a trigger from this" hands the editor: the same field names
 * `openEditor()`'s draft already uses, so the dialog needs no translation layer. Pure —
 * it composes strings and touches nothing.
 *
 * It is a STARTING POINT and never an equivalent, which the info dialog says out loud.
 * What a copy cannot carry is everything the parser knows around the pattern: whether the
 * caster is hostile (a player typing "Lord Nagafen begins casting Complete Heal." into
 * /general must not warn), what tier the cast is, whether an interrupt has since cleared
 * it, and whether the effect is a standing state or a moment that passed. A regex has no
 * opinion on any of that.
 *
 * Returns null for a row that is a modifier rather than a rule — the sound switch has no
 * pattern to copy because it is not a thing that matches.
 */
export function builtinRecipe(row) {
  if (!row || row.kind === 'option' || !row.lineRules?.length) return null;
  const base = ruleSource(row.lineRules[0]);
  if (!base) return null;

  const spec = RECIPES[row.key];
  if (!spec) return null;

  const guard = spellGuard(row);
  const pattern = nameCaptures(base, spec.captures, guard ? { [spec.captures[1]]: guard } : {});
  // Every recipe must end up with the captures its SHOW text references; a `rules.js`
  // edit that changed a group's shape would otherwise ship a trigger rendering blanks.
  if (spec.captures.some((name) => !pattern.includes(`(?<${name}>`))) return null;

  return {
    name: row.name,
    pattern,
    literal: false,
    warnText: spec.warnText,
    timerKind: 'none',
    durationSec: 60,
  };
}

/**
 * How each row's recipe is assembled: which captures the rule's groups become, in order,
 * and what the chip then says. Names only — the pattern itself comes from `rules.js`.
 */
const RECIPES = {
  castAlerts: { captures: ['mob', 'spell'], warnText: '${mob} — ${spell}' },
  summonAlerts: { captures: ['mob', 'victim'], warnText: '${mob} summoned ${victim}' },
  ccAlerts: { captures: ['who', 'effect'], warnText: '${who} — ${effect}' },
  ...Object.fromEntries(WARN_GROUPS.map((group) => [
    warnKeyFor(group), { captures: ['mob', 'spell'], warnText: '${mob} — ${spell}' },
  ])),
};

/**
 * The assertion that narrows a cast recipe to one warning group.
 *
 * Two shapes, because the six groups are not all the same kind of thing. Five of them are
 * "this spell is one of these", which is a positive lookahead over that group's patterns.
 * The sixth, `unknown`, is defined entirely by the others — it is where a cast lands when
 * NOTHING claimed it — so the only honest pattern for it is a negative lookahead over the
 * whole table. That is long, and long is the right answer: it is what the row actually
 * means, and a player who wants a shorter one now has something to cut down.
 *
 * A row with no group at all (the parent "Enemy casts") gets no guard, which is correct:
 * it really is every cast the log names.
 */
function spellGuard(row) {
  if (!row.group) return '';
  const source = (list) => list.map((p) => titleCaseTolerant(p.source)).join('|');
  if (row.group === UNKNOWN_GROUP) return `(?![^.]*(?:${source(SPELL_PATTERNS)}))`;
  const mine = SPELL_PATTERNS.filter((p) => p.group === row.group);
  // The lookahead sits at the head of the spell capture rather than rewriting its body:
  // an assertion composes with whatever `rules.js` has that group matching, where a
  // rewrite would have to assume its shape.
  return mine.length ? `(?=[^.]*(?:${source(mine)}))` : '';
}

/**
 * Name a pattern's capture groups, in the order they open.
 *
 * `rules.js` writes plain `(…)` groups because the parser reads them by index. A recipe
 * has to hand the player something whose SHOW text can say `${mob}`, so the groups are
 * named on the way out. Walking the source rather than replacing a literal `(.+?)` means
 * this keeps working if a rule's group body is ever changed.
 *
 * @param {string} source
 * @param {string[]} names   one per capturing group, in order; extras are ignored
 * @param {Record<string, string>} [prefix]  text to insert at the head of a named group
 */
function nameCaptures(source, names, prefix = {}) {
  let out = '';
  let next = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') { out += ch + (source[i + 1] ?? ''); i++; continue; }
    if (ch === '[') { const end = classEnd(source, i); out += source.slice(i, end); i = end - 1; continue; }
    if (ch === '(' && source[i + 1] !== '?' && next < names.length) {
      const name = names[next++];
      out += `(?<${name}>${prefix[name] ?? ''}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The same pattern, matching however EverQuest capitalized it.
 *
 * `spellwatch.js` matches case-insensitively, and a recipe cannot: the trigger format
 * stores a pattern string with no flags, and JavaScript has no inline `(?i)`. So every
 * word-initial letter becomes a two-case class, which is enough — EQ writes spell names
 * in Title Case ("Complete Heal", "Superior Healing") and the rest of each word is
 * already lowercase in both.
 *
 * "Enough" rather than "equivalent" is a claim that has to be checked, which is what
 * `tests/builtin-pack.test.js` does: every row's recipe is run against every one of that
 * row's `catches`, so a future pattern this transform mangles fails the suite.
 */
function titleCaseTolerant(source) {
  let out = '';
  let afterLetter = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') { out += ch + (source[i + 1] ?? ''); i++; afterLetter = false; continue; }
    if (ch === '[') { const end = classEnd(source, i); out += source.slice(i, end); i = end - 1; afterLetter = false; continue; }
    if (!afterLetter && ch >= 'a' && ch <= 'z') out += `[${ch}${ch.toUpperCase()}]`;
    else out += ch;
    afterLetter = /[a-zA-Z]/.test(ch);
  }
  return out;
}

/** The index just past the `]` closing a character class opened at `i`. */
function classEnd(source, i) {
  let j = i + 1;
  if (source[j] === '^') j++;
  if (source[j] === ']') j++;
  while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, source.length);
}

/**
 * The built-in pack, in the shape the Triggers window renders.
 *
 * Deliberately the same field names an imported pack uses where they mean the same
 * thing (`id`, `name`, `origin`, `enabled`), so the renderer's rail needs one branch and
 * not two. `rows` replaces `triggers`/`groups` because these are neither: there is no
 * group tree to walk, only a flat ordered list with one level of nesting expressed by
 * `parent`. There ARE patterns, and each row carries its own.
 */
export function builtinPack(cfg) {
  const rows = BUILTIN_ROWS.map((row) => ({
    ...row,
    enabled: builtinRowOn(cfg, row.key),
    /** A child row is inert while its parent is off — the renderer greys it rather than
     *  hiding it, so the dependency is visible instead of only discovered. */
    inert: Boolean(row.parent) && !builtinRowOn(cfg, row.parent),
    matches: builtinMatches(row),
    pattern: builtinRowPattern(row),
    recipe: builtinRecipe(row),
  }));

  const switchable = rows.filter((r) => r.kind !== 'option');
  return {
    id: BUILTIN_ID,
    name: BUILTIN_NAME,
    origin: 'builtin',
    /** Never removable and never exportable — there is no pattern file behind it. */
    removable: false,
    exportable: false,
    /** The pack switch is derived: it is on while anything under it is. */
    enabled: switchable.some((r) => r.enabled),
    rows,
    preset: presetOf(cfg),
    stats: { rules: switchable.length, on: switchable.filter((r) => r.enabled).length },
  };
}

/**
 * The config patch for flipping one row.
 *
 * Returns null for an unknown key rather than writing something arbitrary — the id
 * arrives from a renderer, and a typo must not be able to set a config key that happens
 * to share its name.
 */
export function builtinPatch(key, enabled) {
  if (!BUILTIN_KEYS.includes(key)) return null;
  return { [key]: Boolean(enabled) };
}

/**
 * The config patch for a preset button.
 *
 * Delegates wholesale to `ALERT_PRESETS`, which states all six switches by design — a
 * preset that only listed what it turns on would leave "Everything" half-applied when
 * the player then clicked "Essential".
 */
export function builtinPresetPatch(name) {
  const preset = ALERT_PRESETS[name];
  return preset ? { ...preset } : null;
}
