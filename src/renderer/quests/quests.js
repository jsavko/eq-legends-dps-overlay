/**
 * The Quests window's DOM half. Holds no ledger logic — main owns the store, and every
 * judgement that isn't painting lives in organize.js where WSL can test it.
 *
 * One fetch shape: `api.get()` returns the whole resolved picture (every class, quest
 * and item, data names joined with this character's counts and flags — a few tens of
 * KB), refetched whenever main says the ledger moved. No deltas: the failure mode of a
 * delta protocol is a checklist that silently disagrees with the file, and the payload
 * is small enough that correctness costs nothing visible.
 */

import {
  classGroups, doneTotals, questByRef, firstQuestRef, splitLine, statsText, importStamp,
} from './organize.js';

const $ = (id) => document.getElementById(id);

let snapshot = null;
/** The selected quest's ref. Remembered across openings — a reading surface should
 *  reopen on what you were reading. */
let selected = localStorage.getItem('quests.selected') ?? null;

init();

async function init() {
  $('import').addEventListener('click', runImport);
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
    $('quest-empty').textContent = 'Waiting for the log to name a character…';
    $('who').textContent = '';
    $('total').textContent = '';
    $('quests').replaceChildren();
    $('item-list').replaceChildren();
    $('i-owned').textContent = '';
    return;
  }

  $('who').textContent = snapshot.server
    ? `${snapshot.character} · ${snapshot.server}` : snapshot.character;
  const totals = doneTotals(snapshot);
  $('total').replaceChildren(strong(String(totals.done)), text(` of ${totals.total} tests turned in`));

  if (!questByRef(snapshot, selected)) selected = firstQuestRef(snapshot);
  renderRail();
  renderQuest();
}

function renderRail() {
  const list = $('quests');
  list.replaceChildren();
  for (const cls of classGroups(snapshot)) {
    const head = document.createElement('li');
    head.className = 'chead';
    head.append(text(cls.name), span('n', `${cls.doneCount} / ${cls.total} done`));
    list.append(head);

    for (const q of cls.quests) {
      const li = document.createElement('li');
      li.className = `qrow${q.done ? ' done' : ''}`;
      li.setAttribute('aria-selected', String(q.ref === selected));
      li.append(span('name', q.reward), span('st', q.done ? '✓' : `${q.ownedCount}/${q.itemCount}`));
      li.addEventListener('click', () => {
        selected = q.ref;
        localStorage.setItem('quests.selected', selected);
        render();
      });
      list.append(li);
    }
  }
}

function renderQuest() {
  const found = questByRef(snapshot, selected);
  if (!found) return;
  const { cls, quest } = found;

  $('q-reward').textContent = quest.reward;
  $('q-npc').replaceChildren(text('hand in to '), strong(cls.npc));

  const done = $('q-done');
  done.setAttribute('aria-pressed', String(quest.done));
  done.onclick = async () => {
    await window.api.setDone(quest.ref, !quest.done);
    await refresh();
  };

  $('q-stats-text').textContent = statsText(quest.rewardStats);
  // Always in flow: the stamp holds its space empty so toggling an import cannot
  // shift the stats pane — the History window's no-reflow contract.
  const stamp = importStamp(snapshot.import);
  $('q-stamp').textContent = stamp
    ? `${stamp} · an export is a snapshot: the log keeps counting past it, and every checkbox stays editable.`
    : '';

  renderItems(quest);
}

function renderItems(quest) {
  $('i-owned').textContent =
    `${quest.items.filter((i) => i.owned).length} of ${quest.items.length} owned`;

  const list = $('item-list');
  list.replaceChildren();
  for (const item of quest.items) {
    const li = document.createElement('li');
    li.className = `item${item.owned ? ' owned' : ''}${item.rune ? ' rune' : ''}`;

    const own = document.createElement('button');
    own.className = 'own';
    own.setAttribute('aria-pressed', String(item.owned));
    own.title = item.owned ? 'Owned — click to clear your claim' : 'Mark as owned';
    own.addEventListener('click', async () => {
      await window.api.setOwned(item.ref, !item.owned);
      await refresh();
    });

    const count = span('count', '');
    count.append(span('cap', 'looted'));
    const big = span(`big${item.looted ? '' : ' zero'}`, String(item.looted));
    count.append(big);
    const split = splitLine(item.split, item.rune);
    if (split) count.append(span('split', split));

    li.append(
      own,
      span('name', item.name),
      span('src', item.rune ? `${item.source} — any Sky mob` : item.source),
      count,
    );
    list.append(li);
  }
}

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
