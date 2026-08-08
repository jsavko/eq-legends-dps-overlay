/**
 * GINA's token model, recovered empirically.
 *
 * GINA's documentation went offline with `eq.gimasoft.com`, so none of this comes from a
 * spec — it was read back out of 114 `{C}` uses, 6 `{S}` uses and the surrounding trigger
 * bodies in the committed fixture corpus. The single most important finding is a
 * NEGATIVE one: `{mob}`, `{player}` and `{dmg}`, which look like tokens, are not. They
 * are ordinary .NET named capture groups, and .NET's named-group syntax is character-for
 * character JavaScript's — so the largest class of pattern in the corpus needs no
 * translation at all and is passed through untouched.
 *
 * | Token      | Where             | Means                                          |
 * |------------|-------------------|------------------------------------------------|
 * | `(?<n>…)`  | pattern           | a .NET named group — already valid JS          |
 * | `${n}`     | output, early end | that group's value, EMPTY when unmatched       |
 * | `${1}`     | output, early end | numbered group, same emptiness rule            |
 * | `{C}`      | pattern + output  | the current character's name                   |
 * | `{S}`      | pattern + output  | a wildcard capture, referenced back as `{S}`   |
 * | `{COUNTER}`| output            | fire count — dropped at import, and reported   |
 *
 * The emptiness rule is not a nicety. `RespawnTimer` names its timers `${2}${3}${4}`
 * across an alternation where exactly one of the three ever matches, so rendering an
 * unmatched group as `undefined` would name every respawn timer "undefinedundefined".
 *
 * Two resolution times, and the difference matters:
 *
 *   - **`{C}` resolves at COMPILE time**, which is why a stored pattern keeps the token
 *     intact. The character can change under a running app — the tailer follows the
 *     player to an alt — and a pattern baked against the old name would quietly stop
 *     matching. The engine recompiles instead.
 *   - **`${…}` in an EARLY ENDER resolves at ARM time**, against the match that started
 *     the timer. `${mob} is no longer slowed` has to become that specific mob's line,
 *     and it cannot be known until a timer exists to be ended.
 */

/** Everything a JS regex treats as special, for escaping literal-mode trigger text. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

export function escapeRegex(text) {
  return String(text).replace(REGEX_SPECIAL, '\\$&');
}

/**
 * The wildcard `{S}` compiles to.
 *
 * Lazy, so `resisted the {S} spell.` stops at the first " spell." rather than swallowing
 * a later one on the same line. Named `S` so the output side can refer back to it with
 * the same token the author wrote.
 */
const S_GROUP = '(?<S>.+?)';

/** A `{S}` after the first cannot repeat the name — JS allows duplicate group names only
 *  across alternatives, and two in sequence is not that. Later ones match without
 *  capturing, which is what GINA's single-value `{S}` means anyway. */
const S_GROUP_REPEAT = '(?:.+?)';

/**
 * Turn a GINA trigger's text into a JavaScript regex TEMPLATE.
 *
 * A template rather than a regex because `{C}` — and, in an early ender, `${…}` — survive
 * into the result to be resolved later. Everything else is settled here.
 *
 * Tokenizing has to happen BEFORE escaping, not after: `{`, `}` and `$` are all regex
 * metacharacters, so escaping a literal pattern first would turn `{S}` into `\{S\}` and
 * `${mob}` into `\$\{mob\}`, and the tokens would be gone.
 *
 * @param {string} text        the raw `TriggerText` / `EarlyEndText`
 * @param {boolean} isRegex    GINA's `EnableRegex`
 * @param {{backreferences?: boolean}} [opts]
 *   `backreferences` marks an EARLY ENDER, where `{S}` and `${name}` refer back to the
 *   match that armed the timer rather than capturing anything of their own.
 * @returns {{template, usesCharacter, usesWildcard, usesMatch}}
 */
export function patternTemplate(text, isRegex, opts = {}) {
  const raw = String(text ?? '');
  const backrefs = opts.backreferences === true;
  let usesCharacter = false;
  let usesWildcard = false;
  let usesMatch = false;
  let out = '';

  for (const part of splitTokens(raw)) {
    if (part.kind === 'ref') {
      // Passed through verbatim in BOTH modes: this is a placeholder for a value, and
      // escaping it here would leave a literal `\$\{mob\}` that matches nothing.
      usesMatch = true;
      out += part.text;
    } else if (part.name === 'C') {
      // Left as a token; compileTemplate escapes the substituted name, so a character
      // called `O'Rourke` cannot break the regex.
      usesCharacter = true;
      out += '{C}';
    } else if (part.name === 'S') {
      if (backrefs) {
        usesMatch = true;
        out += '${S}';
      } else {
        out += usesWildcard ? S_GROUP_REPEAT : S_GROUP;
        usesWildcard = true;
      }
    } else if (part.kind === 'token') {
      // `{COUNTER}` and anything else brace-shaped in a PATTERN is not something GINA
      // matches on — treat it as the literal text it appears to be.
      out += isRegex ? `\\{${part.name}\\}` : escapeRegex(part.text);
    } else {
      out += isRegex ? part.text : escapeRegex(part.text);
    }
  }

  return { template: out, usesCharacter, usesWildcard, usesMatch };
}

/**
 * Resolve `{C}` and compile.
 *
 * Returns null rather than throwing when the pattern will not compile: a stranger's pack
 * may hold a .NET-only construct (balancing groups, `(?#comment)`, conditionals), and one
 * bad regex must cost that trigger and nothing else. The caller reports it by name — a
 * dropped trigger the player can see beats an import that dies whole.
 *
 * @returns {{regex: RegExp, error: null}|{regex: null, error: string}}
 */
export function compileTemplate(template, character) {
  const source = String(template ?? '').replaceAll('{C}', escapeRegex(character ?? ''));
  try {
    return { regex: new RegExp(source), error: null };
  } catch (err) {
    return { regex: null, error: err.message };
  }
}

/**
 * Resolve an early ender's `${…}` against the match that armed its timer.
 *
 * The substituted values are regex-escaped in BOTH literal and regex mode, because a
 * captured mob name is DATA and never pattern: `a Mistmoore guard (summoned)` would
 * otherwise open a group that never closes and take the whole early ender down with it.
 */
export function renderPattern(template, match) {
  const raw = String(template ?? '');
  let out = '';
  for (const part of splitTokens(raw)) {
    if (part.kind === 'ref') out += escapeRegex(groupValue(part.name, match));
    else out += part.text;
  }
  return out;
}

/**
 * Render an output template (`DisplayText`, `TimerName`, the ending notice) against a
 * match.
 *
 * Every unresolved token renders EMPTY, never `undefined` and never the token itself —
 * see the header for the `${2}${3}${4}` case that makes this load-bearing.
 *
 * @param {string} template
 * @param {RegExpExecArray|null} match
 * @param {string|null} character
 */
export function renderTemplate(template, match, character) {
  const raw = String(template ?? '');
  let out = '';

  for (const part of splitTokens(raw)) {
    if (part.kind === 'ref') out += groupValue(part.name, match);
    else if (part.name === 'C') out += character ?? '';
    else if (part.name === 'S') out += match?.groups?.S ?? '';
    else if (part.name === 'COUNTER') out += '';   // dropped at import; never rendered
    else out += part.text;
  }
  return out;
}

function groupValue(ref, match) {
  if (!match) return '';
  if (/^\d+$/.test(ref)) return match[Number(ref)] ?? '';
  return match.groups?.[ref] ?? '';
}

/**
 * Split text into literal runs, `{TOKEN}` markers and `${ref}` group references.
 *
 * Only ALL-CAPS single-word braces count as tokens, which is what keeps this from eating
 * a regex quantifier: `a{2,3}` and `\d{4}` stay literal text, while `{C}`, `{S}` and
 * `{COUNTER}` are recognized.
 */
function splitTokens(text) {
  const parts = [];
  const re = /\$\{([A-Za-z_]\w*|\d+)\}|\{([A-Z][A-Z0-9_]*)\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', text: text.slice(last, m.index), name: null });
    if (m[1] !== undefined) parts.push({ kind: 'ref', text: m[0], name: m[1] });
    else parts.push({ kind: 'token', text: m[0], name: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last), name: null });
  return parts;
}

/** Does this template mention something only a match can fill in? */
export function needsMatch(template) {
  return splitTokens(String(template ?? '')).some((p) => p.kind === 'ref' || p.name === 'S');
}

/** Does this template mention `{COUNTER}`? Import reports it; nothing renders it. */
export function usesCounter(template) {
  return splitTokens(String(template ?? '')).some((p) => p.name === 'COUNTER');
}

// --------------------------------------------------------------------- prefilter

/**
 * Literal substrings a line MUST contain for a pattern to have any chance of matching.
 *
 * This is the engine's cheap precondition: `String.includes` before `RegExp.exec`. A raid
 * pushes hundreds of lines a second past what may be hundreds of patterns, and measured
 * over 948,677 real log lines the prefilter is what takes 31 patterns from unusable to
 * 365,000 lines/second — three orders of magnitude above the live rate.
 *
 * **Soundness is the entire contract.** A prefilter that rejects a line the regex would
 * have matched loses a trigger silently, which is the one failure mode a warning surface
 * cannot survive. So this walks the pattern properly rather than grabbing the longest run
 * of ordinary characters, which is unsound twice over:
 *
 *   - `(abc|def)ghi` — `abc` is the longest run and is not required at all.
 *   - `(You have slain (?<mob>.*)!)|((?<mob>.*) has been slain by .*!)` — the corpus's
 *     single most common pattern. Neither half's literal is required on its own; the
 *     line must contain ONE OF them, which is why the answer here is a SET.
 *
 * The rules, all conservative — when in doubt, contribute nothing:
 *   - a sequence requires any one of its parts, so the most discriminating is chosen;
 *   - an alternation requires a literal only if EVERY branch has one, and then it is the
 *     union of their choices;
 *   - `?` and `*` and `{0,n}` make their atom optional, so it contributes nothing;
 *   - character classes, `.`, escapes, anchors and lookarounds contribute nothing.
 *
 * @returns {string[]|null} null means "no useful precondition — always run the regex"
 */
export function literalPrefilter(source) {
  const text = String(source ?? '');
  try {
    const { branches } = scanAlternation(text, 0, 0);
    return chooseAcross(branches);
  } catch {
    // A pattern this scanner cannot follow is a pattern with no prefilter, not an error.
    return null;
  }
}

/** Above this the `includes` sweep costs more than the regex it is meant to avoid. */
const MAX_PREFILTER_SET = 6;
/** Below this a "literal" matches nearly every line and buys nothing. */
const MIN_PREFILTER_LEN = 3;
/** A guard against a pathological pattern turning the scan into the slow path itself. */
const MAX_DEPTH = 20;

/**
 * Parse one alternation, returning each branch's list of required literal-sets.
 *
 * @returns {{branches: Array<Array<string[]>>, next: number}}
 *   `next` is the index of the `)` that closed this group, or the end of the text.
 */
function scanAlternation(text, start, depth) {
  if (depth > MAX_DEPTH) throw new Error('too deep');

  const branches = [];
  /** Required literal-sets found so far in the current branch. */
  let atoms = [];
  /** The literal run being accumulated. */
  let run = '';
  let i = start;

  const flushRun = () => {
    if (run.length >= MIN_PREFILTER_LEN) atoms.push([run]);
    run = '';
  };
  const endBranch = () => {
    flushRun();
    branches.push(atoms);
    atoms = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === '|') { endBranch(); i++; continue; }
    if (ch === ')') { endBranch(); return { branches, next: i }; }

    if (ch === '\\') {
      // An escaped metacharacter IS a literal, but decoding the full escape grammar
      // (\d, \b, \u{…}, \p{…}) to find out which is not worth it. Drop the run.
      flushRun();
      i += 2;
      i = skipQuantifier(text, i).next;
      continue;
    }

    if (ch === '[') {
      flushRun();
      i = skipClass(text, i);
      i = skipQuantifier(text, i).next;
      continue;
    }

    if (ch === '(') {
      flushRun();
      const prefix = groupPrefix(text, i);
      const inner = scanAlternation(text, prefix.next, depth + 1);
      i = inner.next < text.length ? inner.next + 1 : inner.next;   // step past ')'
      const q = skipQuantifier(text, i);
      i = q.next;
      // A lookaround's content is not text this line has to contain in that position,
      // and a negative one demands the opposite — neither can be a precondition.
      if (prefix.lookaround || q.optional) continue;
      const chosen = chooseAcross(inner.branches);
      if (chosen) atoms.push(chosen);
      continue;
    }

    if (ch === '.' || ch === '^' || ch === '$') { flushRun(); i++; i = skipQuantifier(text, i).next; continue; }

    if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      const q = skipQuantifier(text, i);
      if (q.next > i) {
        // The quantifier binds the character just before it. `+` keeps it (still
        // required once); `?`, `*` and `{0,n}` make it optional, so it leaves the run.
        if (q.optional) run = run.slice(0, -1);
        flushRun();
        i = q.next;
        continue;
      }
      // A brace that is not a quantifier — `a{foo}` — is ordinary text.
      run += ch;
      i++;
      continue;
    }

    run += ch;
    i++;
  }

  endBranch();
  return { branches, next: i };
}

/**
 * One literal-set standing for a whole alternation.
 *
 * Every branch must offer something, or the alternation offers nothing: a line matching
 * the branch with no literal would be rejected by any set built from the others.
 */
function chooseAcross(branches) {
  if (!branches.length) return null;
  const set = new Set();
  for (const atoms of branches) {
    const chosen = chooseWithin(atoms);
    if (!chosen) return null;
    for (const literal of chosen) set.add(literal);
    if (set.size > MAX_PREFILTER_SET) return null;
  }
  return set.size ? [...set] : null;
}

/**
 * The most discriminating of a sequence's required sets.
 *
 * A sequence requires all of its atoms, so any one is a sound precondition — and the
 * best one is the set whose WEAKEST member is longest, since a set is only as selective
 * as the shortest string in it. Ties go to the SMALLER set, because every extra member
 * is another `String.includes` over every line: given `(abcdef|ghijkl)mnopqr`, both
 * answers are sound and the single `mnopqr` costs half as much per line as the pair.
 */
function chooseWithin(atoms) {
  let best = null;
  let bestLength = 0;
  for (const set of atoms) {
    const length = Math.min(...set.map((s) => s.length));
    if (length < bestLength) continue;
    if (length > bestLength || set.length < best.length) { best = set; bestLength = length; }
  }
  return bestLength >= MIN_PREFILTER_LEN ? best : null;
}

/** Skip `(?:`, `(?<name>`, `(?'name'`, `(?=`, `(?!`, `(?<=`, `(?<!` or a bare `(`. */
function groupPrefix(text, i) {
  if (text[i + 1] !== '?') return { next: i + 1, lookaround: false };
  const two = text.slice(i + 2, i + 4);
  if (two === '<=' || two === '<!') return { next: i + 4, lookaround: true };
  const one = text[i + 2];
  if (one === '=' || one === '!') return { next: i + 3, lookaround: true };
  if (one === ':') return { next: i + 3, lookaround: false };
  if (one === '<') {
    const close = text.indexOf('>', i + 3);
    if (close === -1) throw new Error('unterminated group name');
    return { next: close + 1, lookaround: false };
  }
  if (one === "'") {
    const close = text.indexOf("'", i + 3);
    if (close === -1) throw new Error('unterminated group name');
    return { next: close + 1, lookaround: false };
  }
  // Inline flags `(?i)` and anything else exotic: skip to the delimiter and treat the
  // remainder as an ordinary group rather than guessing at its meaning.
  throw new Error('unsupported group prefix');
}

function skipClass(text, i) {
  let j = i + 1;
  if (text[j] === '^') j++;
  if (text[j] === ']') j++;          // a `]` first is a literal member
  while (j < text.length && text[j] !== ']') j += text[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, text.length);
}

/** @returns {{next: number, optional: boolean}} `next === i` when there is no quantifier. */
function skipQuantifier(text, i) {
  const ch = text[i];
  if (ch === '*' || ch === '?') return { next: lazy(text, i + 1), optional: true };
  if (ch === '+') return { next: lazy(text, i + 1), optional: false };
  if (ch === '{') {
    const close = text.indexOf('}', i);
    if (close === -1) return { next: i, optional: false };
    const body = text.slice(i + 1, close);
    if (!/^\d*(,\d*)?$/.test(body) || body === '' || body === ',') return { next: i, optional: false };
    const min = Number.parseInt(body, 10);
    return { next: lazy(text, close + 1), optional: !(min >= 1) };
  }
  return { next: i, optional: false };
}

/** A trailing `?` after a quantifier only makes it lazy; it changes nothing here. */
function lazy(text, i) {
  return text[i] === '?' ? i + 1 : i;
}
