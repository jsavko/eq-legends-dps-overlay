/**
 * The boss timers this app ships with — a real trigger pack, not a hidden estimator.
 *
 * This is what replaced `rhythm.js`. The old design watched a boss recast something,
 * computed a median of the gaps live at 4 Hz, and painted the answer with a `~` in front
 * of it. It worked, in the sense that the arithmetic was right. It failed at everything
 * else: the player could not see how the number was arrived at, could not correct it when
 * it was wrong for their server, and could not hand it to anybody. So the measurement
 * moved to authoring time — `scripts/mine-rhythms.js` runs the same median-of-gaps over a
 * whole log — and the answer is written down here as an ordinary pack.
 *
 * What that buys, beyond legibility: these rows arm on the boss's FIRST cast, where the
 * learner needed three agreeing gaps (or a stored prior from a previous week) before it
 * would show anything at all. The replacement is faster, not just clearer.
 *
 * What it costs, stated plainly because the pack's own description says it too: a written
 * duration does not adapt to a server that retunes a boss. The answer is that the player
 * can now SEE the number is wrong and change it, which the learner never allowed, and can
 * re-measure from their own log whenever they like.
 *
 * Every row here was measured on oggok from one character's logs and then reviewed by
 * hand. Sixteen is a floor, not a ceiling: the pack is exportable, so a guild can grow it
 * collectively, which is the entire reason GINA compatibility exists.
 *
 * ------------------------------------------------------------------ the shapes used
 *
 * Each trigger is a `countdown` with `restart: 'new'`, so every observed cast restarts
 * its slot in place rather than stacking a second row — a second row for the same label
 * is exactly what the timers panel's never-move rule forbids. A `repeating` timer would
 * be wrong for a different reason: it would go on re-arming itself after the boss was
 * dead.
 *
 * Death is not special-cased anywhere. Each trigger carries an `earlyEnders` pattern on
 * its own caster's death line, which is the engine's ordinary mechanism — so the
 * CLAUDE.md invariant that a slain caster's rows leave at once is now visible IN the
 * pack, where a player can read it, instead of buried in a tracker's `dropCaster`.
 *
 * Two patterns shapes appear, and which one a row uses says what evidence it was measured
 * from. Most bosses announce themselves ("Lord Nagafen begins casting Shadow Vortex.").
 * An innate breath weapon prints no cast line at all, so its clock is the damage it did
 * plus the resists — see `landedPattern` in `mine-rhythms.js`.
 */

import { normalize } from './pack.js';

/** Stable, so an upgrade replaces this pack rather than adding a second copy. */
export const SEED_PACK_ID = 'eql-boss-timers';

const PACK = {
  id: "eql-boss-timers",
  name: "Boss timers (measured on oggok)",
  comments:
    "16 countdowns measured by scripts/mine-rhythms.js from 983,057 lines of one character's own " +
    "logs on oggok, 2026-07-31 to 2026-08-08. Every duration is the median of the gaps actually " +
    "observed — nobody read these off a spell table. Reviewed by hand afterwards: self-buffs, " +
    "generic mobs and anything under six seconds were dropped, because a countdown for a mob " +
    "rebuffing itself is a row you have to learn to ignore. Exact about this server; possibly " +
    "wrong about yours, and every row is yours to correct.",
  modified: "2026-08-08",
  origin: 'native',
  shipped: true,
  enabled: true,
  groups: [
    { id: "g1", name: "Lord Nagafen", path: ["Lord Nagafen"], enabled: true },
    { id: "g2", name: "Lady Vox", path: ["Lady Vox"], enabled: true },
    { id: "g3", name: "Hoptor Thaggelum", path: ["Hoptor Thaggelum"], enabled: true },
    { id: "g4", name: "King Tranix", path: ["King Tranix"], enabled: true },
    { id: "g5", name: "Quag Maelstrom", path: ["Quag Maelstrom"], enabled: true },
    { id: "g6", name: "Warlord Skarlon pet", path: ["Warlord Skarlon pet"], enabled: true },
    { id: "g7", name: "Baron Telyx V`Zher", path: ["Baron Telyx V`Zher"], enabled: true },
    { id: "g8", name: "Sister of the Spire", path: ["Sister of the Spire"], enabled: true },
    { id: "g9", name: "Bazzt Zzzt", path: ["Bazzt Zzzt"], enabled: true },
    { id: "g10", name: "Overseer of Air", path: ["Overseer of Air"], enabled: true },
    { id: "g11", name: "Noble Dojorn", path: ["Noble Dojorn"], enabled: true },
    { id: "g12", name: "Asaka L`Rei", path: ["Asaka L`Rei"], enabled: true },
    { id: "g13", name: "Cleric of Innoruuk", path: ["Cleric of Innoruuk"], enabled: true },
  ],
  triggers: [
    {
      id: "t1",
      name: "Lord Nagafen — Lava Breath",
      groupId: "g1",
      enabled: true,
      comments:
        "14.0s ±1.5 over 173 gaps in 8 fights, measured from its landing lines — this one prints " +
        "no cast.",
      pattern: "^(?:Lord Nagafen hit .+? for \\d+ points? of \\w+ damage by Lava Breath\\.|You resist Lord Nagafen's Lava Breath!)",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "Lord Nagafen — Lava Breath",
        durationMs: 14000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:Lord Nagafen has been slain by .+!|You have slain Lord Nagafen!|Lord Nagafen died\\.)$" }],
      },
      provenance: 'authored',
    },
    {
      id: "t2",
      name: "Lord Nagafen — Shadow Vortex",
      groupId: "g1",
      enabled: true,
      comments:
        "62.0s ±5.9 over 6 gaps in 1 fight, measured from its cast lines.",
      pattern: "^Lord Nagafen beg(?:ins|in) casting Shadow Vortex\\.$",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "Lord Nagafen — Shadow Vortex",
        durationMs: 62000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:Lord Nagafen has been slain by .+!|You have slain Lord Nagafen!|Lord Nagafen died\\.)$" }],
      },
      provenance: 'authored',
    },
    {
      id: "t3",
      name: "Lady Vox — Frost Breath",
      groupId: "g2",
      enabled: true,
      comments:
        "14.0s ±1.5 over 41 gaps in 2 fights, measured from its landing lines — this one prints " +
        "no cast.",
      pattern: "^(?:Lady Vox hit .+? for \\d+ points? of \\w+ damage by Frost Breath\\.|You resist Lady Vox's Frost Breath!)",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "Lady Vox — Frost Breath",
        durationMs: 14000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:Lady Vox has been slain by .+!|You have slain Lady Vox!|Lady Vox died\\.)$" }],
      },
      provenance: 'authored',
    },
    {
      id: "t4",
      name: "Hoptor Thaggelum — Superior Healing",
      groupId: "g3",
      enabled: true,
      comments:
        "8.0s ±0.5 over 6 gaps in 1 fight, measured from its cast lines.",
      pattern: "^Hoptor Thaggelum beg(?:ins|in) casting Superior Healing\\.$",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "Hoptor Thaggelum — Superior Healing",
        durationMs: 8000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:Hoptor Thaggelum has been slain by .+!|You have slain Hoptor Thaggelum!|Hoptor Thaggelum died\\.)$" }],
      },
      provenance: 'authored',
    },
    {
      id: "t5",
      name: "Hoptor Thaggelum — Life Leech",
      groupId: "g3",
      enabled: true,
      comments:
        "24.0s ±5.9 over 6 gaps in 2 fights, measured from its cast lines.",
      pattern: "^Hoptor Thaggelum beg(?:ins|in) casting Life Leech\\.$",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "Hoptor Thaggelum — Life Leech",
        durationMs: 24000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:Hoptor Thaggelum has been slain by .+!|You have slain Hoptor Thaggelum!|Hoptor Thaggelum died\\.)$" }],
      },
      provenance: 'authored',
    },
    {
      id: "t6",
      name: "King Tranix — Life Leech",
      groupId: "g4",
      enabled: true,
      comments:
        "18.0s ±3.0 over 16 gaps in 7 fights, measured from its cast lines.",
      pattern: "^King Tranix beg(?:ins|in) casting Life Leech\\.$",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "King Tranix — Life Leech",
        durationMs: 18000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:King Tranix has been slain by .+!|You have slain King Tranix!|King Tranix died\\.)$" }],
      },
      provenance: 'authored',
    },
    {
      id: "t7",
      name: "Quag Maelstrom — Mana Drain",
      groupId: "g5",
      enabled: true,
      comments:
        "19.0s ±1.5 over 5 gaps in 1 fight, measured from its cast lines.",
      pattern: "^Quag Maelstrom beg(?:ins|in) casting Mana Drain\\.$",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "Quag Maelstrom — Mana Drain",
        durationMs: 19000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:Quag Maelstrom has been slain by .+!|You have slain Quag Maelstrom!|Quag Maelstrom died\\.)$" }],
      },
      provenance: 'authored',
    },
    {
      id: "t8",
      name: "Warlord Skarlon pet — Ice Spear",
      groupId: "g6",
      enabled: true,
      comments:
        "21.0s ±1.5 over 5 gaps in 2 fights, measured from its cast lines.",
      pattern: "^Warlord Skarlon pet beg(?:ins|in) casting Ice Spear\\.$",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "Warlord Skarlon pet — Ice Spear",
        durationMs: 21000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:Warlord Skarlon pet has been slain by .+!|You have slain Warlord Skarlon pet!|Warlord Skarlon pet died\\.)$" }],
      },
      provenance: 'authored',
    },
    {
      id: "t9",
      name: "Baron Telyx V`Zher — Furor",
      groupId: "g7",
      enabled: true,
      comments:
        "8.0s ±0.5 over 7 gaps in 1 fight, measured from its cast lines.",
      pattern: "^Baron Telyx V`Zher beg(?:ins|in) casting Furor\\.$",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "Baron Telyx V`Zher — Furor",
        durationMs: 8000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:Baron Telyx V`Zher has been slain by .+!|You have slain Baron Telyx V`Zher!|Baron Telyx V`Zher died\\.)$" }],
      },
      provenance: 'authored',
    },
    {
      id: "t10",
      name: "Baron Telyx V`Zher — Searing Arrow",
      groupId: "g7",
      enabled: true,
      comments:
        "16.0s ±0.5 over 3 gaps in 2 fights, measured from its cast lines.",
      pattern: "^Baron Telyx V`Zher beg(?:ins|in) casting Searing Arrow\\.$",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "Baron Telyx V`Zher — Searing Arrow",
        durationMs: 16000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:Baron Telyx V`Zher has been slain by .+!|You have slain Baron Telyx V`Zher!|Baron Telyx V`Zher died\\.)$" }],
      },
      provenance: 'authored',
    },
    {
      id: "t11",
      name: "Sister of the Spire — Entomb in Ice",
      groupId: "g8",
      enabled: true,
      comments:
        "19.0s ±1.5 over 16 gaps in 3 fights, measured from its cast lines.",
      pattern: "^Sister of the Spire beg(?:ins|in) casting Entomb in Ice\\.$",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "Sister of the Spire — Entomb in Ice",
        durationMs: 19000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:Sister of the Spire has been slain by .+!|You have slain Sister of the Spire!|Sister of the Spire died\\.)$" }],
      },
      provenance: 'authored',
    },
    {
      id: "t12",
      name: "Bazzt Zzzt — Rotting Flesh",
      groupId: "g9",
      enabled: true,
      comments:
        "36.0s ±0.5 over 6 gaps in 4 fights, measured from its cast lines.",
      pattern: "^Bazzt Zzzt beg(?:ins|in) casting Rotting Flesh\\.$",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "Bazzt Zzzt — Rotting Flesh",
        durationMs: 36000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:Bazzt Zzzt has been slain by .+!|You have slain Bazzt Zzzt!|Bazzt Zzzt died\\.)$" }],
      },
      provenance: 'authored',
    },
    {
      id: "t13",
      name: "Overseer of Air — Efreeti Fire",
      groupId: "g10",
      enabled: true,
      comments:
        "25.0s ±0.7 over 8 gaps in 3 fights, measured from its cast lines.",
      pattern: "^Overseer of Air beg(?:ins|in) casting Efreeti Fire\\.$",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "Overseer of Air — Efreeti Fire",
        durationMs: 25000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:Overseer of Air has been slain by .+!|You have slain Overseer of Air!|Overseer of Air died\\.)$" }],
      },
      provenance: 'authored',
    },
    {
      id: "t14",
      name: "Noble Dojorn — Efreeti Fire",
      groupId: "g11",
      enabled: true,
      comments:
        "25.0s ±1.5 over 9 gaps in 2 fights, measured from its cast lines.",
      pattern: "^Noble Dojorn beg(?:ins|in) casting Efreeti Fire\\.$",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "Noble Dojorn — Efreeti Fire",
        durationMs: 25000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:Noble Dojorn has been slain by .+!|You have slain Noble Dojorn!|Noble Dojorn died\\.)$" }],
      },
      provenance: 'authored',
    },
    {
      id: "t15",
      name: "Asaka L`Rei — Disease Cloud",
      groupId: "g12",
      enabled: true,
      comments:
        "16.0s ±0.5 over 3 gaps in 3 fights, measured from its cast lines.",
      pattern: "^Asaka L`Rei beg(?:ins|in) casting Disease Cloud\\.$",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "Asaka L`Rei — Disease Cloud",
        durationMs: 16000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:Asaka L`Rei has been slain by .+!|You have slain Asaka L`Rei!|Asaka L`Rei died\\.)$" }],
      },
      provenance: 'authored',
    },
    {
      id: "t16",
      name: "Cleric of Innoruuk — Instill",
      groupId: "g13",
      enabled: true,
      comments:
        "21.0s ±3.0 over 4 gaps in 6 fights, measured from its cast lines.",
      pattern: "^Cleric of Innoruuk beg(?:ins|in) casting Instill\\.$",
      fastCheck: true,
      timer: {
        kind: 'countdown',
        name: "Cleric of Innoruuk — Instill",
        durationMs: 21000,
        restart: 'new',
        restartByName: true,
        earlyEnders: [{ pattern: "^(?:Cleric of Innoruuk has been slain by .+!|You have slain Cleric of Innoruuk!|Cleric of Innoruuk died\\.)$" }],
      },
      provenance: 'authored',
    },
  ],
};

/**
 * The real log line each pattern was measured against, kept as a fixture.
 *
 * `tests/seed-pack.test.js` asserts every pattern still matches its own sample, which
 * is what makes a later edit to one of these — a tightened anchor, a corrected mob
 * name — fail the suite instead of shipping a trigger that quietly matches nothing.
 */
export const SEED_SAMPLES = {
  "t1": "You resist Lord Nagafen's Lava Breath!",
  "t2": "Lord Nagafen begins casting Shadow Vortex.",
  "t3": "Lady Vox hit Khanvikt for 420 points of cold damage by Frost Breath.",
  "t4": "Hoptor Thaggelum begins casting Superior Healing.",
  "t5": "Hoptor Thaggelum begins casting Life Leech.",
  "t6": "King Tranix begins casting Life Leech.",
  "t7": "Quag Maelstrom begins casting Mana Drain.",
  "t8": "Warlord Skarlon pet begins casting Ice Spear.",
  "t9": "Baron Telyx V`Zher begins casting Furor.",
  "t10": "Baron Telyx V`Zher begins casting Searing Arrow.",
  "t11": "Sister of the Spire begins casting Entomb in Ice.",
  "t12": "Bazzt Zzzt begins casting Rotting Flesh.",
  "t13": "Overseer of Air begins casting Efreeti Fire.",
  "t14": "Noble Dojorn begins casting Efreeti Fire.",
  "t15": "Asaka L`Rei begins casting Disease Cloud.",
  "t16": "Cleric of Innoruuk begins casting Instill.",
};

/** The shipped pack, normalized like any other. */
export function seedPack() {
  return normalize(PACK);
}

/**
 * Put the shipped pack in the store, unless the player has made it theirs.
 *
 * Three outcomes, and the middle one is the whole point of the `edited` mark:
 *
 *   - absent      → installed, so a fresh install has boss timers on its first pull.
 *   - edited here → left exactly alone. A player who corrected a duration for their own
 *                   server must not have that correction overwritten by the next release,
 *                   and there is no merge that could be attempted honestly.
 *   - untouched   → replaced when the build ships a newer revision, which is how a
 *                   re-measured or extended pack ever reaches an existing install.
 *
 * `modified` carries the revision rather than a version field of its own: it is already
 * in the format, it is already what "when did this pack last change" means, and a second
 * number that could disagree with it would be one more thing to keep in step.
 *
 * @param {{get: (id: string) => object|null, save: (pack: object) => object}} store
 * @returns {{installed: boolean, reason: 'new'|'upgraded'|'edited'|'current'}}
 */
export function installSeedPack(store) {
  const pack = seedPack();
  const existing = store.get(SEED_PACK_ID);
  if (!existing) {
    store.save(pack);
    return { installed: true, reason: 'new' };
  }
  if (existing.edited) return { installed: false, reason: 'edited' };
  if (existing.modified === pack.modified) return { installed: false, reason: 'current' };
  // The player's switches are not an edit, and losing them to an upgrade would be a
  // silent change to what warns them. Carried across; everything else is replaced.
  store.save({ ...pack, enabled: existing.enabled });
  return { installed: true, reason: 'upgraded' };
}
