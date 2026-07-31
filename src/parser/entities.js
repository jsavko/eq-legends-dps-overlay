/**
 * Entity naming: normalizing "You", resolving pets to their owner, and guessing
 * whether a name is a player or an NPC.
 *
 * The pet rule is the single biggest simplification available in EQ Legends logs:
 * pets are always written `<Owner>`s <pettype>` with a BACKTICK, e.g.
 *   Rhale`s warder      Fuaim`s warder      Someone`s pet
 * so ownership is a string split — no pet-name tracking table is needed.
 * We match the backtick generically rather than enumerating warder/pet/familiar/ward.
 */

/** Backtick-possessive, e.g. "Rhale`s warder" -> owner "Rhale". */
const PET_RE = /^(.+?)`s\s+(.+)$/;

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
 * @returns {{ name: string, owner: string|null, isPet: boolean, display: string }}
 *   `name`  — canonical key: for a pet this is the OWNER, so damage folds into them
 *   `owner` — owner name when this is a pet, else null
 *   `display` — human-readable label for the original entity
 */
export function resolveEntity(raw, selfName) {
  const trimmed = String(raw).trim();

  if (isSelfToken(trimmed)) {
    return { name: selfName, owner: null, isPet: false, display: selfName };
  }

  const pet = PET_RE.exec(trimmed);
  if (pet) {
    const ownerRaw = pet[1].trim();
    // "You`s pet" never occurs, but "Yourself`s" style forms are cheap to guard.
    const owner = isSelfToken(ownerRaw) ? selfName : ownerRaw;
    return { name: owner, owner, isPet: true, display: trimmed };
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
