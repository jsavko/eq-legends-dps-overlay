/**
 * The pure half of the Quests window: grouping, progress arithmetic and formatters.
 *
 * Split from quests.js exactly the way `organize.js` is split from history.js and
 * breakdown.js from the overlay — everything here takes plain data and returns plain
 * data, so the window's judgements are unit-tested in WSL while the DOM half stays a
 * dumb painter.
 *
 * The one vocabulary rule worth stating: OWNED and DONE arrive from the store already
 * DECIDED — explicit claims first, then derivation from the log, the inventory dump
 * and the import, in the store's precedence — and nothing here re-litigates them.
 * What this half adds is the captions: every checkmark names the source that decided
 * it, because a checkbox the app ticked on the player's behalf owes them the receipt.
 */

/**
 * The rail model: every class with its done count, every quest with its owned count.
 * Classes stay in dataset order — the order is part of the data's meaning (positional
 * import refs), and the window remembers a selection rather than reordering anything.
 */
export function classGroups(snapshot) {
  return (snapshot?.classes ?? []).map((cls) => ({
    id: cls.id,
    name: cls.name,
    doneCount: cls.quests.filter((q) => q.done).length,
    total: cls.quests.length,
    quests: cls.quests.map((q) => ({
      ref: q.ref,
      reward: q.reward,
      done: q.done,
      ownedCount: q.items.filter((i) => i.owned).length,
      itemCount: q.items.length,
    })),
  }));
}

/** The titlebar's one number: tests turned in, out of all of them. */
export function doneTotals(snapshot) {
  const all = (snapshot?.classes ?? []).flatMap((c) => c.quests);
  return { done: all.filter((q) => q.done).length, total: all.length };
}

/** Find one quest (and its class) by ref, for selection lookups. */
export function questByRef(snapshot, ref) {
  for (const cls of snapshot?.classes ?? []) {
    const quest = cls.quests.find((q) => q.ref === ref);
    if (quest) return { cls, quest };
  }
  return null;
}

/** The first quest in the dataset — the selection of last resort. */
export function firstQuestRef(snapshot) {
  return snapshot?.classes?.[0]?.quests?.[0]?.ref ?? null;
}

/**
 * The per-disposition split under a looted count, or null when the plain number says
 * everything. Renders for a rune always — where an auto-stored rune actually sits is
 * the detail that explains "why is my bag empty when the count says seven" — and for
 * anything else only once a second disposition exists to distinguish.
 */
export function splitLine(split, rune = false, offered = 0) {
  const parts = [];
  if (split?.kept) parts.push(`${split.kept} in bags`);
  if (split?.stored) parts.push(`${split.stored} ${rune ? 'in currency' : 'stored'}`);
  if (split?.created) parts.push(`${split.created} upgraded`);
  if (split?.sold) parts.push(`${split.sold} sold`);
  // A hand-in always renders, even alone: it is the line that explains why a looted
  // count sits beside an empty bag — and for a turn-in from before any loot was
  // logged, it is the only evidence there is.
  if (offered) parts.push(`${offered} handed in`);
  if (!parts.length) return null;
  if (parts.length === 1 && !rune && !offered) return null;
  return parts.join(' · ');
}

/** "Aug 6" from a millisecond timestamp, or null for anything unusable. */
export function shortDate(ts) {
  if (!ts) return null;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * The donebox caption: what the checkmark's state rests on. Tri-state claims exist so
 * the window can SAY "seen in the log" instead of asking the player to re-state what
 * the log already proved — this line is where that saying happens, and it renders in
 * every state so toggling never reflows the pane.
 */
export function doneCaption(quest) {
  if (!quest.done) {
    if (quest.doneSource === 'manual') return 'not turned in — your call, and no evidence will overrule it';
    // Partial progress is worth a caption of its own: "2 of 4 handed in" is the line
    // that tells the player which quests are mid-turn-in without opening each one.
    const total = (quest.items ?? []).length;
    const offered = (quest.items ?? []).filter((i) => (i.offered ?? 0) > 0).length;
    return offered
      ? `${offered} of ${total} handed in per the log`
      : 'checks itself when the log sees every item handed in';
  }
  switch (quest.doneSource) {
    case 'log': {
      const when = shortDate(Math.max(0, ...(quest.items ?? []).map((i) => i.lastOffered ?? 0)));
      return when ? `every item handed in per the log · ${when}` : 'every item handed in per the log';
    }
    case 'inventory': return 'proven — the reward is in your inventory dump';
    case 'import': return 'per your eqlposky import';
    default: return 'your claim';
  }
}

/** The owned toggle's hover text: the claim, its source, and what a click would do. */
export function ownedTitle(item) {
  if (!item.owned) {
    return item.ownedSource === 'manual'
      ? 'Not owned — your call, and no evidence will overrule it. Click to claim.'
      : 'Mark as owned';
  }
  const dumped = item.inventoryAsOf ? ` of ${shortDate(item.inventoryAsOf)}` : '';
  const base = {
    manual: 'Owned — your claim',
    inventory: `Owned — in your inventory dump${dumped}`,
    log: 'Owned — looted in the log and not yet handed in',
    import: 'Owned — per your eqlposky import',
  }[item.ownedSource] ?? 'Owned';
  return `${base}. Click to overrule.`;
}

/** "imported from eqlposky export of Aug 14" — the dated-claim stamp, or null. */
export function importStamp(imp) {
  if (!imp?.exportedAt) return null;
  const date = new Date(imp.exportedAt);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `Imported from eqlposky export of ${day}`;
}

// ---------------------------------------------------------------------------
// The reward card parser
// ---------------------------------------------------------------------------

/** Flag rows are a closed vocabulary; anything else pretending to be one is not one. */
const FLAG_WORDS = new Set([
  'MAGIC ITEM', 'LORE ITEM', 'NO DROP', 'NO TRADE', 'TEMPORARY',
  'QUEST', 'QUEST ITEM', 'LORE EQUIPPED', 'EXPENDABLE', 'ARTIFACT',
]);

/** Bare slot-name lines exist ("Wrist", no key) — a closed vocabulary tells them apart. */
const SLOT_WORDS = new Set([
  'PRIMARY', 'SECONDARY', 'RANGE', 'AMMO', 'HEAD', 'FACE', 'EAR', 'NECK', 'SHOULDERS',
  'ARMS', 'WRIST', 'HANDS', 'FINGER', 'CHEST', 'LEGS', 'FEET', 'WAIST', 'BACK',
]);

/** The effect family, one label each: Effect / Click Effect / Combat Effect / … */
const EFFECT_RE = /^(Effect|Click Effect|Combat Effect|Focus Effect|Worn Effect): *(.+)$/;
/** Lines that detail the effect above them rather than standing alone. */
const EFFECT_DETAIL_RE = /^(Cast Time|Casting Time|Required Level|Cooldown): *(.+)$/;
/** One "KEY: +8"-style pair; a line made entirely of these is a stat row. */
const PAIR_RE = /([A-Za-z][A-Za-z ]*?): *([+\-]?\d+(?:\.\d+)?%?)(?=\s|$|,)/g;
const PAIR_LINE_RE = /^(?:[A-Za-z][A-Za-z ]*?: *[+\-]?\d+(?:\.\d+)?%?[,\s]*)+$/;

function emptyCard(name = null) {
  return {
    name, flags: [], slot: null, skill: null, delay: null, dmg: null, range: null,
    instrument: null, ac: null, haste: null, charges: null,
    stats: [], saves: [], effects: [], wt: null, size: null,
    classes: null, races: null, other: [],
  };
}

/**
 * Parse one reward's wiki stats text into card models — usually one, two when the
 * reward is genuinely two items ("Windhowl:" / "Spirit Render:" heads, beastlord).
 *
 * The honesty contract, enforced structurally: EVERY non-empty line lands somewhere.
 * A line either fills an empty field, appends to a list, or drops verbatim into
 * `other` — including the case where a single-value field is already occupied, so a
 * second "Slot:" line can never silently overwrite (or be eaten by) the first. The
 * property test in quests-organize runs all 95 rewards through this and pins the
 * exact set of lines that fall through, so a shape that stops parsing shows up as a
 * diff in the fallback set, never as text quietly missing from a card.
 */
export function parseRewardStats(raw) {
  const items = [emptyCard()];
  const card = () => items[items.length - 1];
  // Fill a single-value field, or preserve the line verbatim when it is taken.
  const fill = (field, value, line) => {
    if (card()[field] === null) card()[field] = value;
    else card().other.push(line);
  };

  for (const rawLine of String(raw ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const c = card();

    // A bare "<Name>:" head starts the next item of a multi-item reward. The first
    // head names the opening card if nothing has landed on it yet.
    const head = /^([^:]+):$/.exec(line);
    if (head && !EFFECT_RE.test(line) && !PAIR_LINE_RE.test(line)) {
      if (c.name === null && c.other.length === 0 && c.flags.length === 0 && c.slot === null) {
        c.name = head[1];
      } else {
        items.push(emptyCard(head[1]));
      }
      continue;
    }

    // Flag rows: every comma- or gap-separated token must be in the vocabulary.
    const flagTokens = line.split(/,\s*|\s{2,}/).map((t) => t.trim()).filter(Boolean);
    if (flagTokens.length && flagTokens.every((t) => FLAG_WORDS.has(t.toUpperCase()))) {
      c.flags.push(...flagTokens.map((t) => t.toUpperCase()));
      continue;
    }

    let m;
    if ((m = /^Slot: *(.+)$/i.exec(line))) { fill('slot', m[1], line); continue; }
    if (SLOT_WORDS.has(line.toUpperCase())) { fill('slot', line, line); continue; }
    if ((m = /^Skill: *(.+?)\s+Atk Delay: *(\d+)$/i.exec(line))) {
      fill('skill', m[1], line);
      if (c.delay === null) c.delay = Number(m[2]);
      continue;
    }
    if ((m = /^Skill: *(.+)$/i.exec(line))) { fill('skill', m[1], line); continue; }
    if ((m = EFFECT_RE.exec(line))) {
      c.effects.push({ label: m[1], text: m[2].trim(), details: [] });
      continue;
    }
    if ((m = EFFECT_DETAIL_RE.exec(line))) {
      // "Cast Time: Instant" under a Click Effect belongs to that effect; the same
      // shape with no effect above it has nothing to attach to and stays verbatim.
      if (c.effects.length) c.effects[c.effects.length - 1].details.push(line);
      else c.other.push(line);
      continue;
    }
    if ((m = /^WT: *([\d.]+)(?:\s+Range: *(\d+))?(?:\s+Size: *(.+))?$/i.exec(line))) {
      fill('wt', m[1], line);
      if (m[2] && c.range === null) c.range = Number(m[2]);
      if (m[3] && c.size === null) c.size = m[3];
      continue;
    }
    if ((m = /^Size: *(.+)$/i.exec(line))) { fill('size', m[1], line); continue; }
    // "Charges: Unlimited" is live alongside the numeric form.
    if ((m = /^Charges: *(.+)$/i.exec(line))) {
      fill('charges', /^\d+$/.test(m[1]) ? Number(m[1]) : m[1], line);
      continue;
    }
    if ((m = /^Class: *(.+)$/i.exec(line))) { fill('classes', m[1], line); continue; }
    if ((m = /^Race: *(.+)$/i.exec(line))) { fill('races', m[1], line); continue; }

    if (PAIR_LINE_RE.test(line)) {
      for (const [, key, value] of line.matchAll(PAIR_RE)) {
        const k = key.trim().toUpperCase();
        if (k.startsWith('SV ')) c.saves.push({ k: key.trim(), v: value });
        else if (k === 'AC' && c.ac === null) c.ac = value;
        else if (k === 'DMG' && c.dmg === null) c.dmg = Number(value);
        else if (k === 'ATK DELAY' && c.delay === null) c.delay = Number(value);
        else if (k === 'CHARGES' && c.charges === null) c.charges = Number(value);
        else if (k === 'HASTE' && c.haste === null) c.haste = value;
        else if ((k.endsWith('INSTRUMENT') || k === 'SINGING') && c.instrument === null) {
          c.instrument = { kind: key.trim(), value: Number(value) };
        } else c.stats.push({ k: key.trim(), v: value });
      }
      continue;
    }

    c.other.push(line);
  }
  return items;
}

/**
 * The visible claim label beside an owned item's name, or null for an unowned one —
 * the compressed twin of `ownedTitle` for where a full sentence would crowd the card.
 */
export function ownedLabel(item) {
  if (!item.owned) return null;
  switch (item.ownedSource) {
    case 'log': return 'owned — seen in the log';
    case 'inventory': return 'owned — in your inventory dump';
    case 'import': return 'owned — per the import';
    default: return 'owned — your claim';
  }
}

/**
 * The bare spell name out of an effect's text: "Fury (Must Equip, Casting Time:
 * Instant) at Level 45" → "Fury". This is the key into the effects data — the fetch
 * script and the tooltip lookup must agree on it, which is why it lives here once.
 */
export function effectName(text) {
  const m = /^ *([^(]+?) *(?:\(| - |$)/.exec(String(text ?? ''));
  return m?.[1].trim() || null;
}

/**
 * The rest of an effect's text, condensed for a card line: "(Must Equip, Casting
 * Time: Instant) at Level 45" → "must equip · instant · at level 45". Pure reshaping
 * of the wiki's own words — lowercased, the "Casting Time:" label dropped where the
 * value speaks for itself — never a summary of what the spell does.
 */
export function effectMeta(text) {
  const m = /\(([^)]*)\)\s*(.*)$/.exec(String(text ?? ''));
  if (!m) return null;
  const parts = m[1].split(/, */)
    .map((p) => p.trim().replace(/^Cast(?:ing)? Time: */i, ''))
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  const tail = m[2].replace(/^[-–] */, '');
  if (tail) parts.push(...tail.split(/, */).map((p) => p.trim().toLowerCase()).filter(Boolean));
  return parts.length ? parts.join(' · ') : null;
}

// ---------------------------------------------------------------------------
// Source chips
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// The rail filter
// ---------------------------------------------------------------------------

/** The three rail modes, in display order. */
export const RAIL_FILTERS = ['all', 'progress', 'done'];

/**
 * Filter the rail's quests without touching its classes: every class header stays
 * (its progress bar is the summary the rail exists for), showing only the quests the
 * mode asks about. Counts are left as the full totals on purpose — "3 / 6 done" is a
 * statement about the class, not about the current view.
 */
export function railFilter(groups, mode) {
  if (mode !== 'progress' && mode !== 'done') return groups;
  return groups.map((cls) => ({
    ...cls,
    quests: cls.quests.filter((q) => (mode === 'done' ? q.done : !q.done)),
  }));
}
