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

/**
 * Tell main how big this window needs to be.
 *
 * Measurements only — main owns the bounds and the anchor, and re-anchors the window
 * around the fixed point it grows from. This window used to be sized for its worst
 * realistic content and left that size forever, which is fine while it is click-through
 * and blocking the moment it is not: an invisible rectangle swallows every click that
 * lands in the empty part of it, including clicks meant for the window behind it. The
 * player cannot see the rectangle, so the symptom is a window that ignores the mouse in
 * a region with nothing in it.
 *
 * The union of every visible top-level element rather than one known root: these
 * documents have a panel AND an unlocked-only placeholder, and measuring either alone
 * would clip the other. A `ResizeObserver` rather than a call at the end of each render
 * path, because there are several of those and a new one would silently not report.
 */
let lastFit = { width: -1, height: -1 };

function reportFit() {
  // The EXTENT of the content, not its distance from the origin. This document is a
  // full-height flex column that bottom-anchors its panel, so measuring `rect.bottom`
  // reported the whole viewport height and the window never shrank at all — the exact
  // symptom being fixed. Min/max on both axes gives the box the content actually
  // occupies, wherever in the viewport it happens to sit.
  let left = Infinity;
  let top = Infinity;
  let right = 0;
  let bottom = 0;
  for (const el of document.body.children) {
    if (el.hidden || el.offsetParent === null) continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  const width = Number.isFinite(left) ? Math.ceil(right - left) : 0;
  const height = Number.isFinite(top) ? Math.ceil(bottom - top) : 0;
  // Unchanged is only skippable while the window is ON screen. Main HIDES a window that
  // reports nothing, so a panel that goes empty and comes back at exactly the size it
  // had before would be skipped here and stay hidden forever — the popup would work
  // once and never again.
  const wasEmpty = !lastFit.width || !lastFit.height;
  const isEmpty = !width || !height;
  if (!wasEmpty && !isEmpty && width === lastFit.width && height === lastFit.height) return;
  lastFit = { width, height };
  window.api.fit({ width, height });
}

const fitObserver = new ResizeObserver(() => reportFit());
fitObserver.observe(document.body);
for (const el of document.body.children) fitObserver.observe(el);
// The observer does not fire for a child that is merely un-hidden at the same size, so
// the mutation of `hidden` is watched too.
new MutationObserver(() => reportFit())
  .observe(document.body, { attributes: true, childList: true, subtree: true, attributeFilter: ['hidden', 'class', 'style'] });
if (document.fonts?.ready) document.fonts.ready.then(reportFit);
reportFit();
