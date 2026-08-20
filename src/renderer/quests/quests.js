/**
 * The Quests window's DOM half. Holds no ledger logic — main owns the store, and every
 * judgement that isn't painting lives in organize.js where WSL can test it.
 *
 * One fetch shape: `api.get()` returns the whole resolved picture (every class, quest
 * and item, data names joined with this character's counts and effective flags — a few
 * tens of KB), refetched whenever main says the ledger moved. No deltas: the failure
 * mode of a delta protocol is a checklist that silently disagrees with the file, and
 * the payload is small enough that correctness costs nothing visible.
 *
 * Three pieces of view state persist across openings, all display-only: the selected
 * quest, which class groups the player has folded, and the rail filter. None of them
 * touch the ledger — closing the window forgets nothing that matters.
 */

import {
  classGroups, doneTotals, questByRef, firstQuestRef, splitLine, importStamp,
  doneCaption, ownedTitle, ownedLabel,
  parseRewardStats, parseSources, railFilter, effectName, effectMeta,
  sharedIndex, sharedWith,
} from './organize.js';
import { bossNeeds } from '../../quests/needs.js';

const $ = (id) => document.getElementById(id);
const ICONS = '../../quests/icons/';

let snapshot = null;
/** The selected quest's ref. Remembered across openings — a reading surface should
 *  reopen on what you were reading. */
let selected = localStorage.getItem('quests.selected') ?? null;
/** Class ids the player has folded shut. The selected quest's class ignores this —
 *  a restored selection must never be hidden by a remembered fold. */
let collapsed = new Set(JSON.parse(localStorage.getItem('quests.collapsed') ?? '[]'));
/** The rail filter: 'all' | 'progress' | 'done'. */
let filter = localStorage.getItem('quests.filter') ?? 'all';

init();

async function init() {
  $('import').addEventListener('click', runImport);
  for (const btn of $('filters').querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      localStorage.setItem('quests.filter', filter);
      render();
    });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePopup(true); });
  document.addEventListener('click', (e) => {
    if (popupPinned && !$('popup').contains(e.target) && e.target !== popupAnchor) hidePopup(true);
  });
  window.api.onChanged(refresh);
  await refresh();
}

async function refresh() {
  snapshot = await window.api.get();
  render();
}

function render() {
  const empty = !snapshot;
  $('quest-empty').hidden = !empty;
  $('quest-body').hidden = empty;
  if (empty) {
    $('quest-empty').replaceChildren(
      text('Waiting for the log to name a character…'), document.createElement('br'),
      text('Log in and the ledger follows along on its own.'),
    );
    $('who').textContent = '';
    $('total').textContent = '';
    $('total-fill').style.width = '0';
    $('quests').replaceChildren();
    $('item-list').replaceChildren();
    $('i-owned').textContent = '';
    return;
  }

  $('who').textContent = snapshot.server
    ? `${snapshot.character} · ${snapshot.server}` : snapshot.character;
  const totals = doneTotals(snapshot);
  $('total').replaceChildren(strong(String(totals.done)), text(` of ${totals.total} tests turned in`));
  const fill = $('total-fill');
  fill.style.width = `${totals.total ? (100 * totals.done) / totals.total : 0}%`;
  fill.classList.toggle('complete', totals.done === totals.total && totals.total > 0);

  if (!questByRef(snapshot, selected)) selected = firstQuestRef(snapshot);
  renderRail();
  renderQuest();
}

// ---------------------------------------------------------------------------- rail

function renderRail() {
  for (const btn of $('filters').querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.filter === filter));
  }

  // "By boss" is not a quest filter but the rail's second arrangement — the same
  // ledger inverted. It branches here rather than teaching railFilter about it,
  // because railFilter filters quests and boss mode has no quests to filter.
  if (filter === 'boss') {
    renderBossRail();
    return;
  }

  const selectedClass = selected?.split(':')[0] ?? null;
  const list = $('quests');
  list.replaceChildren();
  for (const cls of railFilter(classGroups(snapshot), filter)) {
    // The selected quest's class force-expands: a fold must never hide the selection.
    const folded = collapsed.has(cls.id) && cls.id !== selectedClass;

    const head = document.createElement('li');
    head.className = `chead${folded ? ' folded' : ''}`;
    const row = span('crow', '');
    row.append(span('chev', folded ? '▸' : '▾'), span('cname', cls.name));
    // The ready badge renders on folded headers too — "which tests can I go hand in"
    // is answered at a glance, without unfolding anything. Gold, never balm: balm
    // stays reserved for done.
    if (cls.readyCount) row.append(span('ready', `${cls.readyCount} ready`));
    row.append(span('n', `${cls.doneCount} / ${cls.total} done`));
    const bar = span('bar', '');
    const barFill = document.createElement('i');
    barFill.style.width = `${cls.total ? (100 * cls.doneCount) / cls.total : 0}%`;
    if (cls.doneCount === cls.total && cls.total > 0) barFill.className = 'complete';
    bar.append(barFill);
    head.append(row, bar);
    head.addEventListener('click', () => {
      // Toggling records the player's intent even for the force-expanded class, so
      // selecting elsewhere later leaves it the way the player last set it.
      if (collapsed.has(cls.id)) collapsed.delete(cls.id);
      else collapsed.add(cls.id);
      localStorage.setItem('quests.collapsed', JSON.stringify([...collapsed]));
      render();
    });
    list.append(head);

    if (folded) continue;
    for (const q of cls.quests) {
      const li = document.createElement('li');
      li.className = `qrow${q.done ? ' done' : ''}`;
      li.setAttribute('aria-selected', String(q.ref === selected));
      // A ready quest trades its owned count for the pill — "4/4" made the reader do
      // the arithmetic that READY states outright.
      const st = q.done ? span('st', '✓')
        : q.ready ? span('st ready', 'READY')
          : span('st', `${q.ownedCount}/${q.itemCount}`);
      const top = span('qtop', '');
      top.append(span('name', q.reward), st);
      li.append(top);
      // The flag line: where the missing pieces drop, under the name so the whole rail
      // answers "we're pulling X — which of my quests care?" without a click. It
      // exists only while something is missing, so done and ready rows keep their
      // one-line density and a finishing character's rail converges back to it.
      // Alternatives within one item are joined with "or" — three bosses on one flag
      // group is one item that any of them drops, not three errands.
      if (q.sources.length) {
        const flags = span('flags', '');
        for (const group of q.sources) {
          group.forEach((chip, i) => {
            if (i) flags.append(span('or', 'or'));
            const f = span(`mobflag${chip.zoneWide ? ' zone' : ''}`, '');
            if (chip.zoneWide) f.append(strong('ZONE-WIDE'));
            else if (chip.island) f.append(strong(`ISL ${chip.island}`), text(` ${chip.mob}`));
            else f.append(text(chip.mob));
            flags.append(f);
          });
        }
        li.append(flags);
      }
      li.addEventListener('click', () => {
        selected = q.ref;
        localStorage.setItem('quests.selected', selected);
        render();
      });
      // The rail does not show the reward card, so hovering is where it earns its
      // keep: the full parsed card floats beside the row. No pin — a click selects.
      bindPopup(li, () => railPreview(q.ref), { pinOnClick: false, side: 'right' });
      list.append(li);
    }
  }
}

/**
 * The rail's other arrangement: Boss → Item → class flags, strictly still-needed.
 *
 * The hunt list read before a raid — islands ascend in pull order, each boss lists
 * what it still owes, and each item flies the classes it is owed to. Everything here
 * comes from `bossNeeds`, the same inversion the engaged-drops popup paints, so the
 * two can never disagree about what a boss owes. Clicking a class flag selects that
 * class's quest, so the quest and items panes follow exactly as they do from a quest
 * row; hovering one previews the reward the errand is for. The list empties as the
 * ledger completes, and the empty state says so in a sentence rather than showing a
 * blank pane.
 */
function renderBossRail() {
  const list = $('quests');
  list.replaceChildren();
  const groups = bossNeeds(snapshot);

  if (!groups.length) {
    const li = document.createElement('li');
    li.className = 'bossempty';
    li.textContent = 'Nothing left to hunt — every unfinished quest’s items are in hand.';
    list.append(li);
    return;
  }

  for (const group of groups) {
    const head = document.createElement('li');
    head.className = 'bosshead';
    if (group.zoneWide) {
      head.append(span('btag', 'ZONE-WIDE'), span('bnote', 'any Sky mob — runes'));
    } else if (group.island) {
      head.append(span('btag', `ISL ${group.island}`), span('bmob', group.mob));
    } else {
      // A source shape parseSources could not place rides through verbatim — flagged,
      // never dropped, the contract every reader of that function keeps.
      head.append(span('bmob', group.mob));
    }
    head.append(span('bcount', `${group.items.length} item${group.items.length === 1 ? '' : 's'}`));
    list.append(head);

    for (const item of group.items) {
      const li = document.createElement('li');
      li.className = `need${item.rune ? ' rune' : ''}`;
      li.append(span('iname', item.name));

      const flags = span('nflags', '');
      for (const c of item.classes) {
        const f = document.createElement('button');
        f.type = 'button';
        f.className = 'clsflag';
        f.textContent = c.className;
        f.setAttribute('aria-pressed', String(c.ref === selected));
        f.title = `${c.reward} — open the ${c.className} quest`;
        f.addEventListener('click', () => {
          selected = c.ref;
          localStorage.setItem('quests.selected', selected);
          render();
        });
        bindPopup(f, () => railPreview(c.ref), { pinOnClick: false, side: 'right' });
        flags.append(f);
      }
      // Where else this item drops: you fight differently over a drop you can get
      // elsewhere, so the alternatives ride on the row rather than hiding in a hover.
      if (item.alsoFrom.length) {
        flags.append(span('also',
          `also ${item.alsoFrom.map((a) => (a.island ? `ISL ${a.island}` : a.mob)).join(' · ')}`));
      }
      li.append(flags);
      list.append(li);
    }
  }
}

/** The floating reward preview for one rail row: the same cards the quest pane shows. */
function railPreview(ref) {
  const found = questByRef(snapshot, ref);
  const box = document.createElement('div');
  if (!found) return box;
  for (const card of parseRewardStats(found.quest.rewardStats)) {
    box.append(buildCard(card, found.quest, { tooltips: false }));
  }
  return box;
}

// ---------------------------------------------------------------------- quest pane

function renderQuest() {
  const found = questByRef(snapshot, selected);
  if (!found) return;
  const { cls, quest } = found;

  $('q-reward').textContent = quest.reward;
  $('q-npc').replaceChildren(text('hand in to '), strong(cls.npc));

  const done = $('q-done');
  done.setAttribute('aria-pressed', String(quest.done));
  // The caption names the source that decided the checkmark — the receipt for every
  // box the app ticked on the player's behalf. Rendered in every state (the hint is
  // always in flow), so toggling never shifts the cards below.
  done.querySelector('.hint').textContent = doneCaption(quest);
  done.onclick = async () => {
    await window.api.setDone(quest.ref, !quest.done);
    await refresh();
  };

  const cards = $('q-cards');
  cards.replaceChildren();
  for (const card of parseRewardStats(quest.rewardStats)) {
    cards.append(buildCard(card, quest, { tooltips: true }));
  }

  const stamp = importStamp(snapshot.import);
  $('q-stamp').textContent = stamp
    ? `${stamp} — it only fills in what predates your log; every mark stays editable.`
    : 'Turn-ins are read from your log; run /outputfile inventory in game to prove pre-log '
      + 'history. An import is the last resort, and every mark stays editable.';

  renderItems(cls, quest);
}

/**
 * One parsed reward card: icon, name, flag chips, weapon/meta line, stat pairs, save
 * pairs, effect lines, the verbatim fallback, and the WT/size/class footer. Shared by
 * the quest pane (tooltips live) and the rail preview popup (tooltips off — a popup
 * inside a popup helps nobody).
 */
function buildCard(card, quest, { tooltips }) {
  const el = document.createElement('div');
  el.className = 'card';

  const head = span('chead-row', '');
  const iconFile = (card.name && quest.cardIcons?.[card.name]) || quest.icon;
  if (iconFile) {
    const img = document.createElement('img');
    img.className = 'icon';
    img.alt = '';
    img.src = ICONS + iconFile;
    // A missing file renders as no icon at all rather than a broken-image glyph.
    img.addEventListener('error', () => img.remove());
    head.append(img);
  }
  head.append(span('iname', card.name ?? quest.reward));
  for (const flag of card.flags) head.append(span('flag', flag));
  el.append(head);

  const meta = [
    card.slot,
    card.skill,
    card.delay !== null ? `delay ${card.delay}` : null,
    card.dmg !== null ? `DMG ${card.dmg}` : null,
    card.instrument ? `${card.instrument.kind} ${card.instrument.value}` : null,
    card.ac !== null ? `AC ${card.ac}` : null,
    card.haste !== null ? `Haste ${card.haste}` : null,
    card.charges !== null ? `Charges ${card.charges}` : null,
    card.range !== null ? `Range ${card.range}` : null,
  ].filter(Boolean);
  if (meta.length) el.append(span('meta', meta.join(' · ')));

  for (const rows of [card.stats, card.saves]) {
    if (!rows.length) continue;
    const grid = span('stats', '');
    for (const { k, v } of rows) {
      const pair = span('pair', '');
      pair.append(span('k', `${k} `), span('v', v));
      grid.append(pair);
    }
    el.append(grid);
  }

  for (const effect of card.effects) {
    const line = document.createElement('div');
    line.className = 'effect';
    const name = effectName(effect.text);
    const ename = span('ename', name ?? effect.text);
    const entry = name ? snapshot.effects?.effects?.[name] : null;
    if (tooltips) {
      // Every effect answers the hover, entry or not. The old rule — no entry, no
      // underline, no popup — was honest per effect and a lie per class: the P99
      // wiki is classic-era and has no beastlord, so on a beastlord's own quest
      // pages the feature was 100% silent and indistinguishable from broken.
      // Nothing is guessed even now; an entry-less effect pops a card that says
      // exactly why it has no description.
      ename.classList.add('tip');
      ename.tabIndex = 0;
      bindPopup(ename, () => effectTip(name ?? effect.text, entry, effect));
    }
    line.append(ename);
    const detail = [effectMeta(effect.text), ...effect.details.map((d) => d.toLowerCase())]
      .filter(Boolean).join(' · ');
    if (detail) line.append(span('emeta', detail));
    el.append(line);
  }

  // The verbatim fallback: lines the parser has not met render styled but unparsed —
  // muted, whole, and never dropped. Today the corpus has none; a wiki refresh may.
  for (const line of card.other) el.append(divOf('odd', line));

  const foot = [
    card.wt !== null ? `WT ${card.wt}` : null,
    card.size,
    card.classes,
    card.races && card.races !== 'ALL' ? card.races : null,
  ].filter(Boolean);
  if (foot.length) el.append(divOf('foot', foot.join(' · ')));

  return el;
}

/**
 * The effect tooltip: the spell's own source lines, never a summary written here.
 * An entry-less effect still answers — with why it has nothing — because a hover
 * that silently does nothing is indistinguishable from a broken feature. The footer
 * names the entry's OWN source: the P99 snapshot and the hand-transcribed Legends
 * supplement are different claims, and the popup says which one it is making.
 */
function effectTip(name, entry, effect) {
  const box = document.createElement('div');
  box.append(divOf('pname', name));
  if (entry) {
    for (const line of entry.lines ?? []) box.append(divOf('pline', line));
  } else {
    box.append(divOf('pnone',
      'No description — the classic-era P99 wiki has no page for this spell, and no '
      + 'other source has been transcribed for it yet. Nothing is guessed here.'));
  }
  const meta = effectMeta(effect.text);
  if (meta) box.append(divOf('pmeta', meta));
  if (entry) box.append(divOf('pfoot', `${entry.source ?? 'P99 wiki'} snapshot`));
  return box;
}

// ---------------------------------------------------------------------- items pane

function renderItems(cls, quest) {
  $('i-owned').textContent =
    `${quest.items.filter((i) => i.owned).length} of ${quest.items.length} owned`;

  // The competition index, rebuilt per render from the same snapshot the rows come
  // from — cheap (one pass over ~190 dataset items) and impossible to disagree with
  // what's on screen.
  const shared = sharedIndex(snapshot);

  const list = $('item-list');
  list.replaceChildren();
  for (const item of quest.items) {
    const li = document.createElement('li');
    li.className = `item${item.owned ? ' owned' : ''}${item.rune ? ' rune' : ''}`;

    const own = document.createElement('button');
    own.className = 'own';
    own.setAttribute('aria-pressed', String(item.owned));
    own.title = ownedTitle(item);
    own.addEventListener('click', async () => {
      await window.api.setOwned(item.ref, !item.owned);
      await refresh();
    });

    const name = span('name', item.name);
    // The claim's receipt, visible: "owned — seen in the log" beside the name says
    // why the box is ticked without a hover.
    const label = ownedLabel(item);
    if (label) name.append(span('why', label));

    const src = span('src', '');
    for (const chip of parseSources(item.source)) {
      const c = span('chip', '');
      if (chip.zoneWide) c.append(strong('ZONE-WIDE'), text(' any Sky mob'));
      else if (chip.island) c.append(strong(`ISL ${chip.island}`), text(` ${chip.mob}`));
      else c.append(text(chip.mob));
      src.append(c);
    }

    const count = span('count', '');
    count.append(span('cap', 'looted'));
    count.append(span(`big${item.looted ? '' : ' zero'}`, String(item.looted)));
    const split = splitLine(item.split, item.rune, item.offered);
    if (split) count.append(span('split', split));

    li.append(own, name, src, count);

    // The competition footer: which OTHER classes want this item, each with its state
    // in the wording — the decision aid for who gets the drop, and for the shared-rune
    // case where one surviving rune makes several quests read READY at once. Absent
    // entirely on a single-class item; this window says nothing it doesn't know.
    const others = sharedWith(shared, item.name, cls.id);
    if (others.length) {
      const row = span('shared', '');
      row.append(span('lead', 'also wanted by'));
      for (const o of others) {
        const chip = span(`schip${o.done ? ' covered' : ''}`, '');
        chip.append(span('who', o.className), span('state', o.done ? '✓ turned in' : 'still needs it'));
        row.append(chip);
      }
      li.append(row);
    }

    list.append(li);
  }
}

// -------------------------------------------------------------------------- import

async function runImport() {
  const result = await window.api.importExport();
  if (result?.canceled) return;
  // The stamp line is the durable record; this is just the moment's acknowledgement.
  $('import').textContent = result?.ok
    ? `Imported — ${result.applied.owned} owned, ${result.applied.done} turned in`
    : `Import failed: ${result?.error ?? 'unreadable file'}`;
  setTimeout(() => { $('import').textContent = 'Import eqlposky export…'; }, 4000);
  await refresh();
}

// -------------------------------------------------------------------------- popup

/**
 * The one floating popup, the eqlposky grammar exactly: mouseenter shows, mouseleave
 * hides, click pins until Escape or a click away, focus/blur mirror enter/leave for
 * the keyboard. This window takes real mouse input, so no polling machinery — plain
 * DOM events, one element, repositioned per anchor and clamped to the viewport.
 */
let popupPinned = false;
let popupAnchor = null;

function showPopup(anchor, build) {
  if (popupPinned) return;
  const popup = $('popup');
  popup.replaceChildren(build());
  popup.hidden = false;
  positionPopup(anchor);
  popupAnchor = anchor;
}

function positionPopup(anchor) {
  const popup = $('popup');
  const r = anchor.getBoundingClientRect();
  popup.style.left = '0px';
  popup.style.top = '0px';
  const pw = popup.offsetWidth;
  const ph = popup.offsetHeight;
  let left;
  let top;
  if (anchor.dataset.popside === 'right') {
    left = Math.min(r.right + 10, window.innerWidth - pw - 12);
    top = Math.min(r.top, window.innerHeight - ph - 12);
  } else {
    left = Math.min(r.left, window.innerWidth - pw - 12);
    top = r.bottom + 8;
    if (top + ph > window.innerHeight - 8) top = r.top - ph - 8;
  }
  popup.style.left = `${Math.max(8, left)}px`;
  popup.style.top = `${Math.max(8, top)}px`;
}

function hidePopup(force = false) {
  if (popupPinned && !force) return;
  popupPinned = false;
  const popup = $('popup');
  popup.classList.remove('pinned');
  popup.hidden = true;
  popupAnchor = null;
}

function bindPopup(el, build, { pinOnClick = true, side = null } = {}) {
  if (side) el.dataset.popside = side;
  el.addEventListener('mouseenter', () => showPopup(el, build));
  el.addEventListener('mouseleave', () => hidePopup());
  el.addEventListener('focus', () => showPopup(el, build));
  el.addEventListener('blur', () => hidePopup());
  if (pinOnClick) {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (popupPinned && popupAnchor === el) { hidePopup(true); return; }
      hidePopup(true);
      showPopup(el, build);
      popupPinned = true;
      $('popup').classList.add('pinned');
      popupAnchor = el;
    });
  }
}

// ------------------------------------------------------------------------- helpers

function text(value) { return document.createTextNode(value); }
function strong(value) {
  const b = document.createElement('b');
  b.textContent = value;
  return b;
}
function span(className, value) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = value;
  return el;
}
function divOf(className, value) {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = value;
  return el;
}
