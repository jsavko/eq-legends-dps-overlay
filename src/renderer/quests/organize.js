/**
 * The pure half of the Quests window: grouping, progress arithmetic and formatters.
 *
 * Split from quests.js exactly the way `organize.js` is split from history.js and
 * breakdown.js from the overlay — everything here takes plain data and returns plain
 * data, so the window's judgements are unit-tested in WSL while the DOM half stays a
 * dumb painter.
 *
 * The one vocabulary rule worth stating: OWNED is the claim column and LOOTED is the
 * fact column, and none of the arithmetic here ever converts one into the other. A
 * quest's progress fraction counts owned flags because "do I still need this" is a
 * question about claims; the looted counts render beside the items as the log's own
 * testimony, however the two compare.
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
export function splitLine(split, rune = false) {
  const parts = [];
  if (split?.kept) parts.push(`${split.kept} in bags`);
  if (split?.stored) parts.push(`${split.stored} ${rune ? 'in currency' : 'stored'}`);
  if (split?.created) parts.push(`${split.created} upgraded`);
  if (split?.sold) parts.push(`${split.sold} sold`);
  if (!parts.length) return null;
  if (parts.length === 1 && !rune) return null;
  return parts.join(' · ');
}

/**
 * The reward stats, condensed for the pane. The wiki text arrives with a blank line
 * between every stat row; kept verbatim it reads as a page, not a panel.
 */
export function statsText(raw) {
  return String(raw ?? '').replace(/\n{2,}/g, '\n').trim();
}

/** "imported from eqlposky export of Aug 14" — the dated-claim stamp, or null. */
export function importStamp(imp) {
  if (!imp?.exportedAt) return null;
  const date = new Date(imp.exportedAt);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `Imported from eqlposky export of ${day}`;
}
