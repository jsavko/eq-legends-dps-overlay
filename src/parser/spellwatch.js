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
 * Unlisted casts carry no tier here; the parser records them as tier 0.
 */

/** Ordered like rules.js: first match wins, so mez claims "Screaming Terror" before
 *  the fear pattern could read "Terror" as fear — it is the necromancer short mez. */
const TABLE = [
  {
    category: 'charm',
    tier: 3,
    re: /\b(?:charm|beguile|allure|cajol\w*|dominate|enslave|subjugate|dictate)\b/i,
  },
  {
    category: 'mez',
    tier: 3,
    re: /\b(?:mesmeriz\w+|enthrall|entrance|dazzle|fascinat\w+|rapture|slumber|screaming terror)\b/i,
  },
  {
    category: 'fear',
    tier: 3,
    re: /\b(?:fear|panic|dread)\b/i,
  },
  {
    // "heal(ing)" covers the whole family seen from NPCs — Healing, Light/Greater/
    // Superior Healing, Complete Healing, Word of Healing — plus druid regrowth lines.
    category: 'heal',
    tier: 3,
    re: /\bheal(?:ing|s)?\b|\bchloroplast\b|\brenew\w*\b/i,
  },
  {
    category: 'gate',
    tier: 3,
    re: /\b(?:gate|succor|evacuate)\b/i,
  },
  {
    category: 'stun',
    tier: 2,
    re: /\b(?:stun|tishan|markar|color (?:flux|shift|skew|slant))\b/i,
  },
  {
    // Instill and Ensnaring Roots are the two confirmed in the live log; the rest is
    // the classic root line. Roots outrank snares in the order because "Ensnaring
    // Roots" contains both words and is a root.
    category: 'root',
    tier: 2,
    re: /\b(?:roots?|instill|enstill|fetter|immobiliz\w+|paralyzing earth|grasping)\b/i,
  },
  {
    category: 'snare',
    tier: 2,
    re: /\b(?:snare|ensnar\w+|bonds of force|(?:clinging|engulfing|dooming|cascading) darkness)\b/i,
  },
  {
    // Harm Touch is the shadow knight's signature burst — the one nuke big enough to
    // rank above the calm tier. This server gives it a cast time ("a wan ghoul knight
    // pet begins casting Harm Touch", live log), so the warning is actionable.
    category: 'nuke',
    tier: 2,
    re: /\bharm touch\b/i,
  },
  {
    category: 'lifetap',
    tier: 1,
    re: /\b(?:lifetap|lifespike|lifedraw|life leech|siphon life|drain soul|spirit tap|deflux)\b/i,
  },
  {
    category: 'dispel',
    tier: 1,
    re: /\b(?:cancel magic|nullify magic|annul magic|strip enchantment)\b/i,
  },
  {
    // Confirmed NPC nukes from the live log plus the classic elemental line shapes.
    // Deliberately loose about which nukes are "big": ranking damage size would be
    // guessing, so every recognized nuke sits at the same calm tier.
    category: 'nuke',
    tier: 1,
    re: /\b(?:lightning bolt|wrath|searing arrow|burst of|blast of|shock of|bolt of|draught of|column of|pillar of|lure of|project lightning)\b/i,
  },
];

/**
 * Classify a spell name.
 *
 * @param {string|null} spellName as it appeared in the "begins casting" line; null
 *   for the anonymous classic-EQ "begins to cast a spell." form
 * @returns {{category: string, tier: number}|null} null when the spell is unlisted —
 *   the caller shows it anyway, just without a category label
 */
export function classify(spellName) {
  if (!spellName) return null;
  for (const entry of TABLE) {
    if (entry.re.test(spellName)) return { category: entry.category, tier: entry.tier };
  }
  return null;
}
