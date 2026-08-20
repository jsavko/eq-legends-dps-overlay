/**
 * The engaged-drops popup. Holds no ledger and no matcher — just the last `{ phase,
 * groups }` main pushed, painted whole.
 *
 * Everything with a judgement in it happened before the payload arrived: the
 * inversion and the boss matching live in src/quests/needs.js (shared with the
 * Quests window's "By boss" rail, so the two can never disagree), and the lifetime —
 * engaged, lingering while the corpse is looted, gone — is decided by main's tick
 * against the same module's pure state machine. A push replaces the whole panel;
 * there are no transitions to preserve and pushes only arrive when something
 * actually changed, so the dumbest possible painter is the right one.
 */

const panel = document.getElementById('panel');
const rows = document.getElementById('rows');

let cfg = null;

init();

async function init() {
  applyConfig(await window.api.getConfig());

  window.api.onConfig(applyConfig);
  window.api.onLockChanged((locked) => {
    document.body.dataset.locked = String(locked);
  });
  window.api.onDrops(render);
}

function applyConfig(config) {
  cfg = config;
  document.documentElement.style.setProperty('--scale', config.scale ?? 1);

  // Switching the popup off clears it HERE, on the config push, rather than waiting
  // for the next drops push — which only arrives when the drops themselves change
  // and can be minutes away. Main closes this window on the same key, but the order
  // of the two messages is not ours to assume.
  if (cfg?.dropsOverlay === false) render(null);
}

function render(payload) {
  // Nothing owed means GONE — not an empty frame, not a header with no rows. The
  // window stays alive and click-through, so getting it back costs no gesture.
  if (!payload || !payload.groups?.length || cfg?.dropsOverlay === false) {
    rows.replaceChildren();
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const frag = document.createDocumentFragment();
  for (const group of payload.groups) {
    const head = div('bhead');
    if (group.island) head.append(span('btag', `ISL ${group.island}`));
    head.append(span('bmob', group.mob));
    // The state rides on every boss line so the panel says WHY it is still up:
    // "engaged" while the fight runs, the looting note through the linger.
    head.append(span('bstate', payload.phase === 'linger' ? 'slain — while you loot' : 'engaged'));
    frag.append(head);

    for (const item of group.items) {
      const row = div(`need${item.rune ? ' rune' : ''}`);
      row.append(span('iname', item.name));
      const who = span('who', '');
      for (const c of item.classes) who.append(span('cls', c.className));
      row.append(who);
      frag.append(row);
    }
  }
  rows.replaceChildren(frag);
}

function div(className) {
  const el = document.createElement('div');
  el.className = className;
  return el;
}
function span(className, text) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}
