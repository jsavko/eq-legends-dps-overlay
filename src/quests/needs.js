/**
 * The boss-first inversion of the quest ledger, and the two consumers' shared half.
 *
 * The Quests window's rail flags answer "which of my quests care about this boss?"
 * quest by quest; this module answers the same index read the other way — boss by
 * boss — for the window's "By boss" screen and for the little drops popup that
 * appears when a Sky boss is engaged. It lives HERE, in the pure `src/quests/`
 * layer, because both a renderer and the main process need it: the window imports
 * it for the rail mode, main imports it to feed the popup, and one function serving
 * both is what makes it impossible for the two surfaces to disagree about what a
 * boss still owes.
 *
 * `parseSources` moved in from the window's organize.js for the same reason — it is
 * the vocabulary every source-string reader must share, and a renderer module is the
 * wrong home for something main has to import. organize.js re-exports it, so the
 * window's own imports read exactly as they always did.
 */

/**
 * "Island 1.5: Noble Dojorn / Island 4: Overseer of Air" → one chip per mob.
 *
 * Split on " / " (space-slash-space) ONLY: "drake/sphinx/spirit mobs" is one mob
 * blob, not three chips. A segment with no "Island N:" head of its own continues the
 * previous island ("Island 5: spiroc mobs / The Spiroc Lord" is two chips on island
 * 5). The rune's zone-wide form is flagged distinctly, and a shape this function has
 * never seen becomes a single verbatim chip — never a dropped one.
 *
 * @returns {Array<{island: string|null, mob: string, zoneWide: boolean}>}
 */
export function parseSources(source) {
  const text = String(source ?? '').trim();
  if (!text) return [];
  if (/zone-wide/i.test(text)) return [{ island: null, mob: text, zoneWide: true }];
  const chips = [];
  let island = null;
  for (const segment of text.split(' / ')) {
    const m = /^Island ([\d.]+): *(.+)$/.exec(segment.trim());
    if (m) {
      island = m[1];
      chips.push({ island, mob: m[2], zoneWide: false });
    } else {
      chips.push({ island, mob: segment.trim(), zoneWide: false });
    }
  }
  return chips;
}

/** One group key per place, the same island+mob key the rail flags dedupe on. */
const groupKey = (chip) => (chip.zoneWide ? 'zone' : `${chip.island ?? ''}|${chip.mob}`);

/**
 * The whole ledger inverted: every place that still owes something, in pull order,
 * each with the items it owes and the classes those items are owed to.
 *
 * Strictly still-needed — done quests and owned items contribute nothing, so the
 * result empties as the ledger completes; a finished character gets `[]` and both
 * surfaces built on this simply have nothing to draw. An item whose source names
 * alternative bosses appears under EACH of them, carrying the others as `alsoFrom`:
 * you fight differently over a drop you can get elsewhere, and hiding that would be
 * data invisible on scan.
 *
 * Items merge across classes on plain name equality — the same justification as the
 * window's sharedIndex (every shared name in the dataset is spelled identically,
 * pinned by its property test) — and a class flags an item once even if two of its
 * undone quests want it (the first undone quest wins the flag, the sharedIndex
 * precedent). Class order inside an item is dataset class order, which is part of
 * the data's meaning.
 *
 * Order: numbered islands ascending (1.5 before 2 — pull order), then any verbatim
 * shape `parseSources` could not place (ridden through, never dropped), then the one
 * zone-wide group last — "anything in the zone" is not a trip.
 *
 * @returns {Array<{island: string|null, mob: string, zoneWide: boolean,
 *   items: Array<{name: string, rune: boolean,
 *     alsoFrom: Array<{island: string|null, mob: string}>,
 *     classes: Array<{classId: string, className: string, ref: string, reward: string}>}>}>}
 */
export function bossNeeds(snapshot) {
  const groups = new Map();
  for (const cls of snapshot?.classes ?? []) {
    for (const quest of cls.quests) {
      if (quest.done) continue;
      for (const item of quest.items) {
        if (item.owned) continue;
        const chips = parseSources(item.source);
        for (const chip of chips) {
          const key = groupKey(chip);
          let group = groups.get(key);
          if (!group) {
            group = { island: chip.island, mob: chip.mob, zoneWide: chip.zoneWide, items: new Map() };
            groups.set(key, group);
          }
          let entry = group.items.get(item.name);
          if (!entry) {
            entry = {
              name: item.name,
              rune: Boolean(item.rune),
              // The item's OTHER places, deduped by the same key so a source string
              // repeated across classes cannot double a note.
              alsoFrom: chips
                .filter((other) => !other.zoneWide && groupKey(other) !== key)
                .map((other) => ({ island: other.island, mob: other.mob })),
              classes: [],
            };
            group.items.set(item.name, entry);
          }
          if (!entry.classes.some((c) => c.classId === cls.id)) {
            entry.classes.push({ classId: cls.id, className: cls.name, ref: quest.ref, reward: quest.reward });
          }
        }
      }
    }
  }

  const rank = (g) => {
    if (g.zoneWide) return 2;
    if (g.island === null) return 1;
    return 0;
  };
  return [...groups.values()]
    .sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? Number(a.island) - Number(b.island) : 0))
    .map((g) => ({ ...g, items: [...g.items.values()] }));
}

/**
 * The groups the current pull is about: engaged NPC names matched against group mobs
 * by case-insensitive equality, nothing looser.
 *
 * Equality IS the "named bosses only" rule — "spiroc mobs" and "drake/sphinx/spirit
 * mobs" are descriptions, not names the log will ever write, so they can never
 * match, and guessing their membership from substrings is exactly what this project
 * does not do. Zone-wide is excluded outright: the popup answers "what does THIS mob
 * owe", and "anything in the zone" is not a fact about this mob.
 */
export function engagedNeeds(groups, engagedNames) {
  const engaged = new Set((engagedNames ?? []).map((n) => String(n).toLowerCase()));
  if (!engaged.size) return [];
  return (groups ?? []).filter((g) => !g.zoneWide && engaged.has(g.mob.toLowerCase()));
}

/** How long the popup outlives the encounter — the loot window opens after the kill. */
export const DROPS_LINGER_MS = 90_000;

/**
 * One tick of the popup's lifetime, pure so the linger rule is WSL-tested and main
 * just calls it on each push.
 *
 * The state names the MOBS being shown, not their items — the items are re-read from
 * the current inversion at paint time, which is how a drop looted mid-linger leaves
 * the list without any extra plumbing. Semantics:
 *
 * - A new encounter (its `startTs` differs) starts from that pull's matches — and a
 *   new pull that matches nothing CLEARS a lingering list, because the player has
 *   moved on.
 * - Within one encounter mobs accumulate (adds join the pull) and never leave: the
 *   parser drops an NPC from `engagedNames` when it goes silent or dies, and a slain
 *   boss is exactly the one whose drops are about to be on a corpse.
 * - When the encounter closes with something showing, the list lingers `DROPS_LINGER_MS`
 *   — then nothing, until a pull matches again.
 *
 * @param {null|{phase: 'engaged'|'linger', mobs: string[], startTs: number, until: number|null}} prev
 * @param {{active: boolean, startTs: number|null, matchedMobs: string[], now: number}} tick
 * @returns {null|{phase: 'engaged'|'linger', mobs: string[], startTs: number, until: number|null}}
 */
export function nextDropsState(prev, { active, startTs, matchedMobs, now }) {
  if (active) {
    const sameEncounter = prev?.startTs === startTs;
    const mobs = sameEncounter && prev.phase === 'engaged'
      ? [...new Set([...prev.mobs, ...matchedMobs])]
      : [...new Set(matchedMobs)];
    if (!mobs.length) {
      // A pull with no matched boss leaves a lingering list alone until its deadline:
      // the common shape is a stray trash aggro while the boss corpse is being
      // looted, and wiping the loot list for that would defeat the linger's whole
      // purpose. Only a matched pull replaces the list early.
      if (prev?.phase === 'linger' && now < prev.until) return prev;
      return null;
    }
    return { phase: 'engaged', mobs, startTs, until: null };
  }
  if (prev?.phase === 'engaged') {
    return { phase: 'linger', mobs: prev.mobs, startTs: prev.startTs, until: now + DROPS_LINGER_MS };
  }
  if (prev?.phase === 'linger' && now < prev.until) return prev;
  return null;
}

/**
 * What the popup should paint for a state: the state's mobs re-joined to the CURRENT
 * inversion, in the state's own first-engaged order. A mob whose items have all been
 * looted since simply drops out; when every mob has, the popup has nothing and the
 * window goes empty — honesty by construction, nothing cached.
 */
export function dropsDisplay(state, groups) {
  if (!state) return [];
  const byMob = new Map(
    (groups ?? []).filter((g) => !g.zoneWide).map((g) => [g.mob.toLowerCase(), g]),
  );
  return state.mobs
    .map((mob) => byMob.get(mob.toLowerCase()))
    .filter((g) => g && g.items.length > 0);
}
