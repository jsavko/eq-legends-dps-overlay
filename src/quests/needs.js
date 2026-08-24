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
 *
 * THE TWO SURFACES DIVERGE HERE, ON PURPOSE. The window's "By boss" rail is
 * `bossNeeds` and stays the dataset's own islands and bosses, because the rail
 * answers "where do I go next" and thirty-seven trash mobs is noise in that
 * question. The popup is `dropGroups`, which unions that with the shipped family
 * member lists and with what this character's own log has PROVED a mob drops, because
 * it answers "is this corpse worth looting" and those same thirty-seven are the whole
 * point. Both read one outstanding-items walk, so they can differ about grouping and
 * never about what is owed — which was the original reason this module is in the pure
 * layer.
 *
 * Nothing here imports the dataset. `src/quests/index.js` reads `posky.json` off
 * disk with `fs`, and this module is loaded by the Quests window's renderer — so the
 * learned index arrives already resolved to dataset item names on the snapshot, and
 * `stripArticle` is taken from the parser's `entities.js`, which is pure.
 */

import { stripArticle } from '../parser/entities.js';

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
 * One creature name, folded to the key every matcher on both sides compares.
 *
 * The article strip is not a loosening — it is the SAME fold the two other halves
 * have already applied by the time a name reaches here. The combat parser's
 * `resolveEntity` strips it from every `engagedNpcs` key, and the session loot rule's
 * `creatureKey` strips it from every corpse name the drop index learns. Only the
 * dataset's own source strings still carry one, and two of the eighteen do: the live
 * log writes "the Hand of Veeshan" 5,405 times and "a greater sphinx" 18,790 times
 * and never once without the article, so under bare lowercase equality those two
 * bosses could not fire the popup at all. Folding is what makes all three vocabularies
 * one; it resurrects no family blob, because "spiroc mobs" has no article to lose.
 */
const mobKey = (name) => stripArticle(String(name ?? '').trim()).toLowerCase();

/**
 * Every item this character still owes, merged by name across the sixteen classes —
 * the one walk `bossNeeds` and `dropGroups` share, so the rail and the popup can
 * disagree about grouping and never about what is outstanding.
 *
 * Merging on plain name equality is the window's sharedIndex rule, pinned by its
 * property test: every shared name in the dataset is spelled identically. A class
 * flags an item once even when two of its undone quests want it (first undone quest
 * wins), and class order is dataset class order, which is part of the data's meaning.
 *
 * `chips` accumulates the union of the item's source chips across every class that
 * wants it, deduped by group key. Every class spells a shared item's source the same
 * way today, so the union is the one set either occurrence would have produced; taking
 * it rather than the first-seen one means a future dataset that ever spelled them
 * differently would place the item under BOTH, which is the failure direction that
 * costs a listing rather than hiding one.
 *
 * @returns {Map<string, {name: string, rune: boolean, chips: Array, classes: Array}>}
 *   in first-walked order, which is what gives both consumers a stable group order.
 */
function outstanding(snapshot) {
  const items = new Map();
  for (const cls of snapshot?.classes ?? []) {
    for (const quest of cls.quests) {
      if (quest.done) continue;
      for (const item of quest.items) {
        if (item.owned) continue;
        let entry = items.get(item.name);
        if (!entry) {
          entry = { name: item.name, rune: Boolean(item.rune), chips: [], chipKeys: new Set(), classes: [] };
          items.set(item.name, entry);
        }
        for (const chip of parseSources(item.source)) {
          const key = groupKey(chip);
          if (entry.chipKeys.has(key)) continue;
          entry.chipKeys.add(key);
          entry.chips.push(chip);
        }
        if (!entry.classes.some((c) => c.classId === cls.id)) {
          entry.classes.push({ classId: cls.id, className: cls.name, ref: quest.ref, reward: quest.reward });
        }
      }
    }
  }
  return items;
}

/**
 * One outstanding item as a row under one place. `alsoFrom` is every OTHER named place
 * the item can come from — you fight differently over a drop you can get elsewhere, and
 * hiding that would be data invisible on scan. A learned row passes the mob's own key,
 * so its dataset chips all list as alternatives, which is exactly right: the dataset
 * genuinely never said this mob drops it.
 *
 * `boss` rides only on a row the dataset did NOT place under this mob — a family
 * member's row, or one this character's log learned — and names the boss the dataset
 * DOES associate with the item. It is what a row that would otherwise read `Adamantium
 * Earring · from "bee" mobs` says instead: blob prose names nothing the player can act
 * on, and the boss's name does. Absent on a row the dataset placed outright, so the
 * qualifier stays the exception it is.
 *
 * There is deliberately no drop COUNT on a row any more. The popup lists what is still
 * needed, and "seen 4×" beside a needed item reads as four already in the bag — the one
 * number on the panel that could be mistaken for progress, on a panel whose entire
 * subject is what is missing.
 */
function itemRow(entry, hereKey, { boss = null } = {}) {
  const row = {
    name: entry.name,
    rune: entry.rune,
    alsoFrom: entry.chips
      .filter((other) => !other.zoneWide && groupKey(other) !== hereKey)
      .map((other) => ({ island: other.island, mob: other.mob })),
    classes: entry.classes,
  };
  if (boss) row.boss = boss;
  return row;
}

/**
 * The one boss the dataset associates with an item, or null when it names none or more
 * than one.
 *
 * Used for the rows a family or the learned index placed, where the dataset never said
 * this mob drops it and the player still wants a name they recognise. Silent on an
 * ambiguity rather than picking: `Efreeti Standard` comes off three different bosses,
 * and printing one of the three would be a guess in a slot the player will read as a
 * fact. Silent on the zone-wide rune bucket too — "anywhere" is not a boss.
 */
function soleBoss(entry) {
  const named = entry.chips.filter((chip) => !chip.zoneWide);
  return named.length === 1 ? named[0].mob : null;
}

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
  for (const entry of outstanding(snapshot).values()) {
    for (const chip of entry.chips) {
      const key = groupKey(chip);
      let group = groups.get(key);
      if (!group) {
        group = { island: chip.island, mob: chip.mob, zoneWide: chip.zoneWide, items: new Map() };
        groups.set(key, group);
      }
      if (!group.items.has(entry.name)) group.items.set(entry.name, itemRow(entry, key));
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
 * The POPUP's inversion: every place that still owes this character something. Three
 * sources unioned, in descending order of how strongly the dataset stands behind them.
 *
 * 1. **The dataset's named chips** — `bossNeeds`, unchanged. What makes a fresh
 *    character useful before it has looted anything.
 * 2. **The shipped family lists** — the six source strings that describe a family
 *    rather than a name (`Island 6: "bee" mobs`) resolved to member mobs by
 *    `families.json`.
 * 3. **What this character's own log has proved** — the learned drop index.
 *
 * A row from either of the last two carries `boss`: the name the dataset does put the
 * item under, so the panel can qualify the row with something the player recognises
 * rather than with blob prose or a drop count.
 *
 * WHY ALL THREE, and specifically why the family table was added after the learned
 * index shipped alone. A drop index learned from your own loot cannot answer "what does
 * this corpse owe me", because owing means not-yet-looted:
 *
 *     You only learn that a mob drops X by looting X. The popup exists to tell you
 *     about the X you have NOT looted. The index is blind by construction to exactly
 *     the items the popup is for.
 *
 * That is structural, not bad luck — measured on the live ledger, 0 of 16 outstanding
 * items had a learned source and all 267 learned pairs resolved to items already owned.
 * The index is kept and demoted rather than removed: it costs nothing, every entry is
 * something the character watched happen, and it still catches the second-copy case and
 * a need reopened by a hand-in. It just stops being the only answer to a question it
 * cannot answer. Do not rebuild it as the primary one.
 *
 * The families half is a shipped table, which this file previously argued against by
 * citing CLAUDE.md's spell-duration rule. That argument does not transfer and the
 * reversal is deliberate — see the long note on `FAMILIES` in `src/quests/index.js` for
 * why, including the measured alternative (composing the learned index with the
 * dataset) and the two ways it failed.
 *
 * Precedence between the three: whoever gets there first keeps the row. An item the
 * dataset already places under a mob is never re-added by a family or by the index, so
 * a row can never claim to have been inferred when it was shipped outright. A family
 * group carries the family's own island, because the dataset's string states it; a
 * purely learned mob gets `island: null`, because inferring one from the item's chips
 * would be a guess wearing a label's clothes, and the renderer simply omits the tag.
 *
 * @param {Object} snapshot  QuestProgress#snapshot(), including `drops` and `families`
 * @param {{anyMob?: boolean}} [options]  `anyMob: false` is exactly the shipped
 *   named-boss-only behaviour — the dataset half alone, byte for byte `bossNeeds`.
 */
export function dropGroups(snapshot, { anyMob = true } = {}) {
  const groups = bossNeeds(snapshot);
  if (!anyMob) return groups;

  const entries = outstanding(snapshot);
  const byMob = new Map(groups.filter((g) => !g.zoneWide).map((g) => [mobKey(g.mob), g]));

  /** Find or open the group for one mob name, keeping the dataset's row order. */
  const groupFor = (mob, island) => {
    const key = mobKey(mob);
    let group = byMob.get(key);
    if (!group) {
      group = { island, mob, zoneWide: false, items: [] };
      byMob.set(key, group);
      groups.push(group);
    }
    return group;
  };

  // ---- the families, before the learned index so a mob in both keeps its island
  for (const family of snapshot?.families ?? []) {
    const key = groupKey({ island: family.island ?? null, mob: family.mob, zoneWide: false });
    // What this family still owes: every outstanding item whose source chips include
    // this exact chip. Equality on the chip's own key, not on its words — the family
    // is a member list for one statement the dataset made, not a description to match.
    const owed = [...entries.values()].filter((entry) => entry.chipKeys.has(key));
    if (!owed.length) continue;
    for (const member of family.members ?? []) {
      if (!mobKey(member.name)) continue;
      const group = groupFor(member.name, family.island ?? null);
      for (const entry of owed) {
        if (group.items.some((i) => i.name === entry.name)) continue;
        group.items.push(itemRow(entry, key, { boss: family.boss ?? soleBoss(entry) }));
      }
    }
  }

  // ---- what this character has watched drop
  for (const [mob, items] of Object.entries(snapshot?.drops ?? {})) {
    const key = mobKey(mob);
    if (!key) continue;
    for (const name of Object.keys(items)) {
      const entry = entries.get(name);
      // Nothing outstanding under that name: turned in, owned, or a name this copy of
      // the dataset no longer knows. The still-needed filter is the whole popup.
      if (!entry) continue;
      if (byMob.get(key)?.items.some((i) => i.name === name)) continue;
      groupFor(mob, null).items.push(itemRow(entry, `learned|${key}`, { boss: soleBoss(entry) }));
    }
  }
  return groups;
}

/**
 * The groups the current pull is about: engaged NPC names matched against group mobs
 * by equality on the shared creature key, nothing looser.
 *
 * Equality is still the whole rule — "spiroc mobs" and "drake/sphinx/spirit mobs" are
 * descriptions, not names the log will ever write, so they can never match here, and
 * guessing their membership from substrings is exactly what this project does not do.
 * By the time groups reach this function those blobs have already been RESOLVED into
 * named member groups by `dropGroups`, from a reviewed table rather than from their
 * words; a blob that no family covers simply never matches, which is the honest
 * outcome and the one `scripts/mine-families.js` exists to report on.
 * `mobKey`'s article fold is not a loosening of that: it is the same strip the parser
 * has already applied to every name in `engagedNames`, and without it the two dataset
 * bosses the log only ever writes with an article could never match either.
 *
 * Zone-wide is excluded outright: the popup answers "what does THIS mob owe", and
 * "anything in the zone" is not a fact about this mob.
 */
export function engagedNeeds(groups, engagedNames) {
  const engaged = new Set((engagedNames ?? []).map(mobKey));
  if (!engaged.size) return [];
  return (groups ?? []).filter((g) => !g.zoneWide && engaged.has(mobKey(g.mob)));
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
    (groups ?? []).filter((g) => !g.zoneWide).map((g) => [mobKey(g.mob), g]),
  );
  return state.mobs
    .map((mob) => byMob.get(mobKey(mob)))
    .filter((g) => g && g.items.length > 0);
}
