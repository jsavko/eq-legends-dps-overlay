/**
 * Mining a GINA corpus for spell knowledge.
 *
 * The pure half of `scripts/mine-gina.js`: packs in, candidate spell names out. Kept
 * separate from the script so it unit-tests in WSL like the rest of `src/triggers/`,
 * and so the thing that decides what counts as agreement is not buried in argv parsing.
 *
 * The premise: one pack is one author's opinion, and the same spell named across many
 * INDEPENDENT packs is a fact about the game. Facts about spells belong in
 * `src/parser/spellwatch.js` — but they get there by review, never by a script writing
 * to the table.
 */

/**
 * The pattern shapes that NAME a spell.
 *
 * Only these are mined, and the limitation is the point. A real corpus is dominated by
 * emote-keyed patterns — `(?<mob>.*) yawns` — which are the ones most likely to survive
 * a port between servers precisely BECAUSE they never say a spell's name. They are
 * therefore worth the most to a player and nothing at all to spellwatch, which keys on
 * the name and only the name.
 *
 * The character class excludes regex metacharacters so a capture group inside the match
 * cannot be mistaken for part of a spell's name.
 */
export const NAME_PATTERNS = [
  /begins? (?:to )?cast(?:ing)? (?:a )?(?<spell>[A-Z][^.\\$^(){}[\]|?*+]{2,40}?)\s*[.\\$]/,
  /You begin casting (?<spell>[A-Z][^.\\$^(){}[\]|?*+]{2,40}?)\s*[.\\$]/,
  /resisted the (?<spell>[A-Z][^.\\$^(){}[\]|?*+]{2,40}?) spell/,
  /Your (?<spell>[A-Z][^.\\$^(){}[\]|?*+]{2,40}?) spell (?:has worn off|is interrupted|fizzles)/,
];

/**
 * Strip what stops two writings of the same spell from agreeing.
 *
 * Rank suffixes are the big one and the reason this is needed at all: EQ Legends renamed
 * "Mesmerization" to "Mesmerization VIII", so a corpus written against another server
 * spells the same spell a dozen ways. GINA tokens come off too — a `{S}` wildcard is a
 * placeholder for a name, not a name.
 */
export function normalizeSpellName(raw) {
  return String(raw ?? '')
    .replace(/\{[CS]\}/g, '')
    .replace(/\$\{\w+\}/g, '')
    .replace(/\s+Rk\.?\s*[IVX]+$/i, '')
    .replace(/\s+(?:[IVXLC]{1,6}|\d{1,2})$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull every spell name a single string names, normalized and deduplicated.
 *
 * Deduplicated because the shapes above deliberately overlap — "You begin casting X."
 * matches both the general cast pattern and its own more specific one — and a name
 * counted twice from one string would look like two authors agreeing.
 */
export function spellNamesIn(source) {
  const out = new Set();
  if (!source) return [];
  for (const re of NAME_PATTERNS) {
    const m = re.exec(source);
    if (!m?.groups?.spell) continue;
    const spell = normalizeSpellName(m.groups.spell);
    if (spell.length >= 3) out.add(spell);
  }
  return [...out];
}

/**
 * Count how many independent packs name each spell.
 *
 * @param {Array<{name: string, triggers: Array<object>}>} packs
 * @param {{minPacks?: number, classify?: (name: string) => object|null}} [opts]
 * @returns {{candidates: Array<object>}}
 */
export function mineSpellNames(packs, opts = {}) {
  const minPacks = opts.minPacks ?? 2;
  const classify = opts.classify ?? (() => null);

  /** @type {Map<string, {packs: Set<string>, triggers: Set<string>, samples: Set<string>}>} */
  const found = new Map();

  for (const pack of packs) {
    // A pack votes ONCE per spell however many of its triggers mention it. The real
    // corpus contains a pack that is 34 copies of one pattern; without this it would
    // outvote 34 independent authors on its own.
    const seenHere = new Set();
    for (const trigger of pack.triggers ?? []) {
      for (const source of [trigger.pattern, trigger.warn?.text, trigger.timer?.name]) {
        for (const spell of spellNamesIn(source)) {
          if (!found.has(spell)) {
            found.set(spell, { packs: new Set(), triggers: new Set(), samples: new Set() });
          }
          const entry = found.get(spell);
          if (!seenHere.has(spell)) { entry.packs.add(pack.name); seenHere.add(spell); }
          entry.triggers.add(trigger.name);
          if (entry.samples.size < 2) entry.samples.add(source);
        }
      }
    }
  }

  const candidates = [...found.entries()]
    .map(([spell, e]) => ({
      spell,
      packs: e.packs.size,
      packNames: [...e.packs],
      triggers: e.triggers.size,
      samples: [...e.samples],
      /** What the curated table already says. A hit is not a candidate — it is the
       *  corpus agreeing with the table, which is worth reporting on its own. */
      known: classify(spell),
    }))
    .filter((c) => c.packs >= minPacks)
    .sort((a, b) => b.packs - a.packs || a.spell.localeCompare(b.spell));

  return { candidates };
}
