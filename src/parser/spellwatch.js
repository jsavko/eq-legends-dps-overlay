/**
 * spellwatch — which enemy casts deserve a warning, and how loud.
 *
 * The overlay's cast alerts have to rank a spell the moment its "begins casting" line
 * appears, before the spell has done anything observable. That takes prior knowledge,
 * and this table is that knowledge: category patterns seeded from classic EverQuest
 * spell lines plus every hostile cast confirmed in a live EQ Legends session.
 *
 * Matching is by PATTERN, not by exact name, for the same reason index.js matches
 * charm spells with a word regex: this server ranks its spells ("Mesmerization VIII",
 * "Greater Healing V"), so an exact-name table would silently stop matching at every
 * new rank. A word stem survives ranks, prefixes ("Greater", "Superior") and the
 * possessive forms spell families share.
 *
 * The table only RANKS casts — it never hides one. A spell that matches nothing is
 * still shown by the overlay as an unclassified cast; unknown is not invisible. That
 * is the standing "honest numbers" rule applied to alerts, and it doubles as the
 * discovery mechanism: an unlisted spell that keeps wiping the group is visible on
 * screen by name, ready to be added here.
 *
 * Tiers, highest first:
 *   3 — interrupt NOW or the fight changes shape: crowd control aimed at the group
 *       (charm, mez, fear) and casts that undo the kill (heals, gate).
 *   2 — dangerous but survivable: stuns, roots, snares. Worth a visible warning;
 *       not worth the banner treatment that must stay meaningful.
 *   1 — identified and calm: plain nukes, lifetaps, dispels. Labeled so the player
 *       knows the damage source, never emphasized.
 *  -1 — identified as NOT worth a chip: the self-buff line. Suppressed at every
 *       setting, including "everything". This is deliberately distinct from tier 0's
 *       "not identified at all", and the distinction is what keeps the never-hide-an-
 *       unknown rule above intact: a spell nobody has classified is still shown, and
 *       only a spell POSITIVELY identified as a self-buff is silenced.
 * Unlisted casts carry no tier here; the parser records them as tier 0.
 *
 * ------------------------------------------------------------------ tier vs group
 *
 * Every entry also carries a `group`, and the two fields answer different questions:
 * the TIER decides how loud a chip is (banner / warn line / calm line) and the GROUP
 * decides whether it draws at all, against the player's six switches in settings.
 *
 * The group lives on the ENTRY rather than being derived from the category because
 * `nuke` spans two severities that belong to two different switches — Harm Touch is
 * something you brace for, a plain lightning bolt is something you read afterwards —
 * and a category→group map could not express that.
 */

/** Ordered like rules.js: first match wins, so mez claims "Screaming Terror" before
 *  the fear pattern could read "Terror" as fear — it is the necromancer short mez. */
const TABLE = [
  {
    /**
     * The self-buff line, silenced everywhere. FIRST so a buff named like something
     * else cannot be claimed by a later pattern.
     *
     * Every name here was verified against 149 hours of live log, and the check was
     * worth running: the obvious test — "this spell has never once been observed
     * harming anybody" — misfiles six of these as harmless AND misfiles every NPC
     * heal, which is the single most valuable warning the window draws. What actually
     * separates them is what the heal line MEANS. The classic EverQuest HP/AC buff
     * line (Center, Inner Fire, Courage, Valor, Resolution, Bravery, Skin like Rock,
     * the Symbol series) prints a one-time heal for the hit points it GRANTS —
     * measured at 20 for Inner Fire, 55 for Center, 44-57 for Skin like Rock, 1-62 for
     * Bravery — against mob pools in the thousands. That is the buff landing, not a
     * wounded mob topping itself up, and interrupting one changes nothing.
     *
     * Contrast the three names that look like they belong here and do not:
     *   - Tashania is a magic-resistance debuff cast ON the group ("Glorb is cured of
     *     Tashania"), not a self-buff. It stays unlisted.
     *   - Chaotic Feedback deals real magic damage to the group, so no `feedback`
     *     pattern appears here at all.
     *   - The Echo family (Celestial, Sacred, Renewing) is a genuine heal-over-time,
     *     161-330 hit points a tick, and is listed with the heals below.
     */
    category: 'buff',
    tier: -1,
    group: 'buff',
    re: /\b(?:spirit of wolf|wolf form|quickness|alacrity|haste|shield of \w+|barrier of \w+|skin like|inner fire|center|courage|valor|resolution|bravery|symbol of \w+|spirit armor|auspice)\b/i,
  },
  {
    category: 'charm',
    tier: 3,
    group: 'control',
    re: /\b(?:charm|beguile|allure|cajol\w*|dominate|enslave|subjugate|dictate)\b/i,
  },
  {
    category: 'mez',
    tier: 3,
    group: 'control',
    re: /\b(?:mesmeriz\w+|enthrall|entrance|dazzle|fascinat\w+|rapture|slumber|screaming terror)\b/i,
  },
  {
    category: 'fear',
    tier: 3,
    group: 'control',
    re: /\b(?:fear|panic|dread)\b/i,
  },
  {
    // "heal(ing)" covers the whole family seen from NPCs — Healing, Light/Greater/
    // Superior Healing, Complete Healing, Word of Healing — plus druid regrowth lines.
    //
    // The Echo family is named explicitly because it carries no "heal" in it and was
    // therefore falling through to unlisted: measured in the live log as a real
    // heal-over-time ("Emalina healed herself over time for 163 hit points by
    // Celestial Echo"), 161-330 a tick. `\becho\b` alone would be too greedy for a
    // word that could name anything.
    category: 'heal',
    tier: 3,
    group: 'heals',
    // `regrowth` is spelled out because the comment above has always claimed the druid
    // regrowth line was covered and the pattern never actually matched it — `renew\w*`
    // catches Renewal, not Regrowth. A heal falling through to unlisted is the one
    // misfile this table cannot afford.
    re: /\bheal(?:ing|s)?\b|\bchloroplast\b|\brenew\w*\b|\bregrowth\b|\b(?:celestial|sacred|renewing) echo\b/i,
  },
  {
    category: 'gate',
    tier: 3,
    group: 'heals',
    re: /\b(?:gate|succor|evacuate)\b/i,
  },
  {
    category: 'stun',
    tier: 2,
    group: 'locks',
    re: /\b(?:stun|tishan|markar|color (?:flux|shift|skew|slant))\b/i,
  },
  {
    // Instill and Ensnaring Roots are the two confirmed in the live log; the rest is
    // the classic root line. Roots outrank snares in the order because "Ensnaring
    // Roots" contains both words and is a root.
    category: 'root',
    tier: 2,
    group: 'locks',
    re: /\b(?:roots?|instill|enstill|fetter|immobiliz\w+|paralyzing earth|grasping)\b/i,
  },
  {
    category: 'snare',
    tier: 2,
    group: 'locks',
    re: /\b(?:snare|ensnar\w+|bonds of force|(?:clinging|engulfing|dooming|cascading) darkness)\b/i,
  },
  {
    // Harm Touch is the shadow knight's signature burst — the one nuke big enough to
    // rank above the calm tier. This server gives it a cast time ("a wan ghoul knight
    // pet begins casting Harm Touch", live log), so the warning is actionable.
    category: 'nuke',
    tier: 2,
    group: 'bigHits',
    re: /\bharm touch\b/i,
  },
  {
    category: 'lifetap',
    tier: 1,
    group: 'routine',
    re: /\b(?:lifetap|lifespike|lifedraw|life leech|siphon life|drain soul|spirit tap|deflux)\b/i,
  },
  {
    category: 'dispel',
    tier: 1,
    group: 'routine',
    re: /\b(?:cancel magic|nullify magic|annul magic|strip enchantment)\b/i,
  },
  {
    // Confirmed NPC nukes from the live log plus the classic elemental line shapes.
    // Deliberately loose about which nukes are "big": ranking damage size would be
    // guessing, so every recognized nuke sits at the same calm tier.
    category: 'nuke',
    tier: 1,
    group: 'routine',
    re: /\b(?:lightning bolt|wrath|searing arrow|burst of|blast of|shock of|bolt of|draught of|column of|pillar of|lure of|project lightning)\b/i,
  },
];

/**
 * The table, as data a display layer can read.
 *
 * The Triggers window shows a built-in rule's real patterns rather than a paraphrase of
 * them, and this is what it reads. Frozen copies, and the `RegExp` objects themselves are
 * deliberately NOT handed out: a regex carries mutable `lastIndex`, and a consumer that
 * ran one with `/g` would leave the parser's own copy mid-string. The source string is
 * what the window wants anyway.
 *
 * Derived from `TABLE` rather than typed out beside it, which is the whole point — a
 * pattern quoted by hand in another file is a pattern that drifts the first time this one
 * is corrected, and the drift shows up as a screen that lies rather than as a test that
 * fails.
 */
export const SPELL_PATTERNS = Object.freeze(TABLE.map((entry) => Object.freeze({
  category: entry.category,
  tier: entry.tier,
  group: entry.group,
  source: entry.re.source,
})));

/** The visibility group an unlisted cast falls into — the "unrecognized casts" switch. */
export const UNKNOWN_GROUP = 'unknown';

/** Every group a classified spell can land in, for tests that guard the table. */
export const GROUPS = ['heals', 'control', 'bigHits', 'locks', 'routine', 'buff'];

/**
 * Classify a spell name.
 *
 * @param {string|null} spellName as it appeared in the "begins casting" line; null
 *   for the anonymous classic-EQ "begins to cast a spell." form
 * @returns {{category: string, tier: number, group: string}|null} null when the spell
 *   is unlisted — the caller shows it anyway, just without a category label
 */
export function classify(spellName) {
  if (!spellName) return null;
  for (const entry of TABLE) {
    if (entry.re.test(spellName)) {
      return { category: entry.category, tier: entry.tier, group: entry.group };
    }
  }
  return null;
}
