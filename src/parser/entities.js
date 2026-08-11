/**
 * Entity naming: normalizing "You", resolving pets to their owner, and guessing
 * whether a name is a player or an NPC.
 *
 * Pets are written `<Owner>`s <pettype>` with a BACKTICK — Rhale`s warder,
 * Fuaim`s warder, Someone`s pet — so ownership is usually a string split and no
 * pet-name tracking table is needed. That split used to be unconditional, and
 * that was a real bug rather than a simplification: EQ writes proper names with
 * the same punctuation, so `Innoruuk`s Chosen` folded into a combatant called
 * "Innoruuk", which is a single capitalized token, which looksLikePlayerName
 * calls a player, which made an entire Plane of Hate boss FRIENDLY. Every line in
 * either direction then read as friendly fire and was silently dropped — 409,749
 * outgoing damage, 95,983 incoming and 105 hostile casts across the live log,
 * scored and warned nothing at all.
 *
 * So the split is now two-tier, and the tiers use the game's own distinction:
 *
 *   lowercase noun  ->  a generic possession, i.e. a pet     (`Rhale`s warder`)
 *   Capitalized     ->  part of a proper name, kept whole    (`Innoruuk`s Chosen`)
 *
 * Capitalization is a shape rule and shape rules are what produced the bug, so the
 * attempted split is REPORTED rather than discarded: `properPossessive` hands the
 * owner and noun to the parser, which — unlike this file — can see the roster and
 * fold `Rhale`s Warder` into Rhale on the strength of Rhale's proven standing.
 * Shape lives here, evidence lives there.
 */

/** Backtick-possessive of any kind, e.g. "Rhale`s warder", "Innoruuk`s Chosen". */
const POSSESSIVE_RE = /^(.+?)`s\s+(.+)$/;

/** Leading article marks a generic NPC: "a froglok shin knight", "The Ancient One". */
const ARTICLE_RE = /^(a|an|the)\s+/i;

const SELF_TOKENS = new Set(['you', 'your', 'yourself', 'yourselves']);

/**
 * Strip a leading article. EQ capitalizes it at the start of a sentence
 * ("A froglok shin knight hits...") and lowercases it mid-sentence
 * ("You crush a froglok shin knight..."), so the same mob arrives spelled two
 * ways and must collapse to one key.
 */
export function stripArticle(name) {
  return name.replace(ARTICLE_RE, '');
}

/** True when the raw token refers to the logging character. */
export function isSelfToken(name) {
  return SELF_TOKENS.has(String(name).trim().toLowerCase());
}

/**
 * Resolve a raw log name into a canonical entity.
 *
 * @param {string} raw          name exactly as it appeared in the log
 * @param {string} selfName     the logging character, from the log filename
 * @returns {{ name: string, owner: string|null, isPet: boolean, display: string,
 *             properPossessive?: {owner: string, noun: string} }}
 *   `name`  — canonical key: for a pet this is the OWNER, so damage folds into them
 *   `owner` — owner name when this is a pet, else null
 *   `display` — human-readable label for the original entity
 *   `properPossessive` — the split we DECLINED to make, on a capitalized noun; the
 *     parser may still act on it if the roster proves the owner is a real player
 */
export function resolveEntity(raw, selfName) {
  const trimmed = String(raw).trim();

  if (isSelfToken(trimmed)) {
    return { name: selfName, owner: null, isPet: false, display: selfName };
  }

  const possessive = POSSESSIVE_RE.exec(trimmed);
  if (possessive) {
    const ownerRaw = possessive[1].trim();
    const noun = possessive[2].trim();
    // "You`s pet" never occurs, but "Yourself`s" style forms are cheap to guard.
    const owner = isSelfToken(ownerRaw) ? selfName : ownerRaw;

    // A generic noun is a possession; a proper one is part of a name. Every real pet
    // in the live log is lowercase and every non-pet — mob or item — is capitalized.
    if (/^[a-z]/.test(noun)) {
      return { name: owner, owner, isPet: true, display: trimmed };
    }
    return {
      name: trimmed,
      owner: null,
      isPet: false,
      display: trimmed,
      properPossessive: { owner, noun },
    };
  }

  const bare = stripArticle(trimmed);
  return { name: bare, owner: null, isPet: false, display: bare };
}

/**
 * Heuristic player-name test, used only when the roster has no opinion.
 *
 * EQ player names are a single capitalized token with no article and no spaces.
 * Generic mobs carry an article; named mobs are usually multi-word
 * ("Quartermaster Zevrex"). This misclassifies single-token named mobs, which is
 * why roster membership always takes precedence over the heuristic.
 */
export function looksLikePlayerName(name) {
  const trimmed = String(name).trim();
  if (!trimmed) return false;
  if (ARTICLE_RE.test(trimmed)) return false;
  if (/\s/.test(trimmed)) return false;
  if (trimmed.includes('`')) return false;
  return /^[A-Z][a-z]+$/.test(trimmed);
}

/**
 * True for the generic-possession form — `` Rhale`s warder ``, `` Beebee`s pet `` — the
 * spelling this file reads as a pet rather than as part of a proper name.
 *
 * Same two-tier test `resolveEntity` applies, exported because the roster needs to ask
 * the question about a bare name with no resolution attached: `` Innoruuk`s Chosen ``
 * carries the same punctuation and is a Plane of Hate boss, so the lowercase noun is
 * the whole distinction and it must not be restated anywhere else.
 */
export function looksLikePetName(name) {
  const m = POSSESSIVE_RE.exec(String(name ?? '').trim());
  return Boolean(m) && /^[a-z]/.test(m[2].trim());
}

/**
 * True for a name only a mob has: an article, a space, or backtick punctuation that is
 * not the generic-possession form — "a froglok shin knight", "Cleric of Innoruuk",
 * "Innoruuk`s Chosen", "skeleton L`rodd".
 *
 * The complement of the two tests above and, unlike them, safe to act on. A name this
 * rejects is NOT thereby a player: "Bzzazzt" is a Plane of Sky bee spelled exactly like
 * a player name, and reading that shape as friendly is what once made a whole raid zone
 * score nothing. So this says "certainly a mob" and never "certainly a player" — the
 * bare capitalized token is left unanswered, for the fight itself to place.
 */
export function looksLikeMobName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return false;
  return !looksLikePlayerName(trimmed) && !looksLikePetName(trimmed);
}

/** Edit distance, capped: anything past `max` is reported as `max + 1` and stops early. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // Two rolling rows rather than the full matrix — these are EQ names, but the shape
  // is the same either way and this keeps the allocation to nothing.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;   // every path through this row is already too long
    prev = row;
  }
  return prev[b.length];
}

/**
 * The one name in `candidates` that `typed` was probably meant to be, or null.
 *
 * Exists because a mistyped name in the pet-mapping command is invisible: map a pet to
 * "Kodomony" when the player is "Kadomony" and the overlay dutifully builds a second,
 * phantom row — one letter of difference, two rows where there is one person. The log
 * cannot catch that, because a name it has never seen is exactly what a not-yet-active
 * group member also looks like. Comparing against who is actually here can.
 *
 * Case is ignored on the way in and the candidate's own spelling is what comes back:
 * EQ capitalizes every name, so a lowercase `kadomony` is a typing slip and nothing else.
 *
 * Deliberately returns null when two candidates tie at the same distance. A suggestion
 * is only worth making when it is obvious — offering a coin flip would invite the player
 * to accept the wrong one, which is the very failure this is here to prevent.
 */
export function nearestName(typed, candidates, { maxDistance = 2 } = {}) {
  const needle = String(typed).trim().toLowerCase();
  // Short names are all within two edits of each other, so a suggestion there is noise.
  if (needle.length < 4) return null;

  let best = null;
  let bestDistance = maxDistance + 1;
  let tied = false;

  for (const candidate of candidates) {
    const other = String(candidate).trim();
    if (!other || other.toLowerCase() === needle) return other;   // exact but for case

    const d = editDistance(needle, other.toLowerCase(), maxDistance);
    if (d > maxDistance) continue;
    if (d < bestDistance) {
      bestDistance = d;
      best = other;
      tied = false;
    } else if (d === bestDistance) {
      tied = true;
    }
  }

  return tied ? null : best;
}
