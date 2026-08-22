/**
 * Overlay renderer. A pure view: it holds no parser state, only the last snapshot.
 *
 * Two things here are less obvious than they look:
 *
 * 1. Click-through with hover. The window ignores mouse events so clicks reach the
 *    game, but `forward: true` still delivers mousemove, so pointerenter fires on a
 *    row. That handler asks main for mouse events back, the breakdown opens and is
 *    interactive, and leaving the slab gives them up again.
 *
 * 2. Rows are reused, not rebuilt. At 4 Hz with a bar transition, replacing the DOM
 *    every push would restart every animation and make the bars stutter.
 */

import { abilityAccuracy, abilityColumns, splitShares } from './breakdown.js';
import { METRICS, METRIC_CYCLE, chatReport, formatDuration, rowsForMetric } from './report.js';

const $ = (id) => document.getElementById(id);

const els = {
  body: document.body,
  slab: $('slab'),
  target: $('target'),
  elapsed: $('elapsed'),
  dps: $('dps'),
  rolling: $('rolling'),
  rows: $('rows'),
  detail: $('detail'),
  dName: $('d-name'),
  dTotal: $('d-total'),
  dWho: $('d-who'),
  dSelfBar: $('d-self-bar'),
  dPetBar: $('d-pet-bar'),
  dSelfLabel: $('d-self-label'),
  dPetLabel: $('d-pet-label'),
  dStats: $('d-stats'),
  dSources: $('d-sources'),
  dTypes: $('d-types'),
  dAbilities: $('d-abilities'),
  sessionLine: $('session-line'),
  sessionStats: $('session-stats'),
  sessionElapsed: $('session-elapsed'),
  status: $('status'),
  toast: $('toast'),
};

let snapshot = null;
let selfName = null;
let hoveredName = null;
let toastTimer = null;
/** 'damage', 'healing' or 'taken'. Every snapshot carries all three, so switching is instant. */
let metric = 'damage';
/** Row elements by combatant name, so pushes update in place. */
const rowCache = new Map();
/**
 * Both switches behind the session line, from config.
 *
 * The renderer needs its own copy because a snapshot carrying `session: null` is
 * ambiguous — it means either "tracking is off" or "tracking is on and no session has
 * opened yet", and the line must be absent in both cases but the second one will change
 * on its own. Keeping the config answer here also means turning the line off hides it
 * on the next config push rather than on the next log line, which during a lull can be
 * minutes away.
 */
let sessionLineOn = false;

init();

async function init() {
  const config = await window.api.getConfig();
  applyConfig(config);

  window.api.onSnapshot(render);
  window.api.onStatus(applyStatus);
  window.api.onConfig(applyConfig);
  // Main decides this: only it knows where the window sits on which display.
  window.api.onPanelSide((side) => { els.body.dataset.panel = side; });
  window.api.onToast(({ message, ms }) => showToast(message, ms));
  window.api.onLockChanged(applyLock);

  wireHover();
  wireControls();
}

// ---------------------------------------------------------------- config

function applyConfig(config) {
  if (!config) return;
  document.documentElement.style.setProperty('--opacity', String(config.opacity));
  document.documentElement.style.setProperty('--scale', String(config.scale));
  metric = METRICS[config.metric] ? config.metric : 'damage';
  els.body.dataset.metric = metric;
  // The button names where the cycle goes NEXT, not where it is — the current mode is
  // already told by the unit label and the fill color.
  $('btn-metric').textContent = METRIC_CYCLE[(METRIC_CYCLE.indexOf(metric) + 1) % METRIC_CYCLE.length];
  applyLock(config.locked);
  // Both switches, because both are real: a tracker that was never constructed cannot
  // feed a line, and a player who wanted the Session window has not thereby asked for
  // another line between them and the DPS numbers.
  sessionLineOn = config.session?.enabled === true && config.session?.meterLine === true;
  if (snapshot) render(snapshot);   // repaint in the new metric without waiting for a push
  else renderSessionLine(null);     // so switching it off takes effect during a lull
}

function applyLock(locked) {
  els.body.dataset.locked = String(Boolean(locked));
  if (locked) {
    hideDetail();
    // Locking restores the auto-fit that manual resizing suspended.
    requestAnimationFrame(fitWindow);
  }
}

/**
 * Who we are following, and whether there is a newer version.
 *
 * This slot used to append "log is stale — type /log on", from a check made once when the
 * window was created and never revisited, so the warning outlived the condition and sat
 * over rows of live numbers that contradicted it. What is here now is the opposite kind of
 * claim: main pushes it at the moment it becomes true, it stays true until it is acted on,
 * and nothing else on screen can disagree with it.
 *
 * A standing line rather than only a toast because an update stays available. The toast
 * says it once, twelve seconds later it is gone, and a player who was mid-pull never
 * learns; this is the same news in the one place that can afford to keep saying it.
 */
function applyStatus(status) {
  if (!status) return;
  selfName = null;   // re-derived from the snapshot's `self` field

  const update = status.update ?? null;
  els.body.dataset.update = String(Boolean(update));
  els.status.textContent = update
    ? `${status.character} · ${updateLine(update)}`
    : status.character;
  // The tooltip is the one place with room for the whole path, so the update note goes
  // beside it rather than replacing it — which log is being read stays answerable.
  els.status.title = update
    ? `${status.logPath}\n${updateTooltip(update)}`
    : status.logPath;
}

/**
 * What the footer says about a newer version, which depends on what this copy will DO.
 *
 * Three states, and the distinction between them is the point. An installed copy handles
 * it: the update is downloading now and goes in on quit, and the player's only job is to
 * eventually quit. A portable or unpacked copy cannot replace itself, so the same news is
 * a job for them. Wording both as a bare "v0.9.0 available" made the installed case look
 * as helpless as the other, and left a player waiting for an instruction that was never
 * coming while the app was in fact already dealing with it.
 *
 * "installs on quit" is the part that must survive: the footer clips with an ellipsis at
 * narrow overlay widths, so the promise comes before the progress word rather than after
 * it, where it would be the first thing cut.
 */
function updateLine(update) {
  if (!update.auto) return `v${update.version} available`;
  return update.ready
    ? `v${update.version} installs on quit`
    : `v${update.version} installs on quit, downloading`;
}

/** The same thing with room to breathe, including what to do about it. */
function updateTooltip(update) {
  if (!update.auto) {
    return `Version ${update.version} is out. This copy cannot update itself — ` +
      'tray → Check for updates for the download page.';
  }
  return update.ready
    ? `Version ${update.version} is downloaded and installs the next time you quit.`
    : `Version ${update.version} is downloading now and installs the next time you quit.`;
}

// ---------------------------------------------------------------- rendering

function render(snap) {
  snapshot = snap;
  selfName = snap.self;
  const m = METRICS[metric];

  els.body.dataset.state = snap.active ? 'live' : 'idle';

  // Which rows this metric shows, and their order, live in report.js — the COPY button
  // reads the same function, so the line it puts on the clipboard is the list on screen
  // by construction rather than by two filters being kept in step.
  const rows = rowsForMetric(snap, metric);

  els.body.dataset.hasRows = String(rows.length > 0);

  els.target.textContent = snap.idle ? 'No combat' : (snap.label ?? 'Combat');
  els.elapsed.textContent = formatDuration(snap.durationMs);
  els.dps.textContent = formatNumber(snap[m.group] ?? 0);
  $('dps-unit').textContent = m.unit;

  const topRolling = rows.reduce((a, r) => a + r[m.rolling], 0);
  els.rolling.textContent = formatNumber(topRolling);

  renderRows(rows, m);
  renderSessionLine(snap.session ?? null);

  // The pace tick marks the share an even group would each have.
  if (rows.length >= 2) {
    els.rows.dataset.pace = '';
    els.rows.style.setProperty('--pace', String(1 / rows.length));
  } else {
    delete els.rows.dataset.pace;
  }

  if (hoveredName) {
    const row = rows.find((r) => r.name === hoveredName);
    if (row) renderDetail(row);
    else hideDetail();
  }

  fitWindow();
}

/**
 * The running session, in one line.
 *
 * Renders NOTHING — not an empty row, not a zeroed one — when the line is switched off or
 * no session is open. The overlay pays for every pixel it takes from the game, and a
 * placeholder for a night that has not started yet is a pixel nobody asked for. `hidden`
 * rather than `display: none` because `measureContentHeight` skips hidden children, so an
 * absent line costs the window exactly zero height.
 *
 * The stat order is the priority order, and it is not alphabetical or arbitrary: kills is
 * what a camp is measured in, coin is what it is for, experience is why you are there at
 * all, then the two things that almost never happen — a level, then an ability point —
 * and loot is the long tail. When the window is too narrow to hold them all, the ones at
 * the end go, so position IS priority; see dropOverflowingStats. Levels sits ahead of
 * ability points because it is the rarer and the larger of the two events, and therefore
 * the one worth keeping longest on a narrow overlay.
 *
 * Levels and the experience percentage are adjacent and must not be read as the same
 * number. The xp stat's unit is a POSITION — the prefixed `L28`, the level you are
 * standing in — and the levels stat is a GAIN, a plain count with a suffixed `lvl`. The
 * prefix/suffix split is the whole of what keeps them apart at this font size.
 */
function renderSessionLine(session) {
  if (!sessionLineOn || !session) {
    els.sessionLine.hidden = true;
    return;
  }
  els.sessionLine.hidden = false;
  els.sessionElapsed.textContent = formatDuration(session.elapsedMs);

  // Counts, not rates: `formatNumber` exists for DPS and renders 88 as "88.0", which on a
  // tally of looted items is a decimal place that cannot mean anything.
  const stats = [
    ['kills', formatTally(session.kills), 'kills'],
    ['coin', formatCoin(session.copperEarned), ''],
    ['xp', `${session.xpPercent.toFixed(1)}%`, session.xpLevel === null ? 'xp' : `L${session.xpLevel}`],
    ['levels', formatTally(session.levels), 'lvl'],
    ['aa', String(session.aa), 'aa'],
    ['loot', formatTally(session.loot), 'loot'],
  ];

  els.sessionStats.replaceChildren(...stats.map(([kind, value, unit]) => {
    const wrap = document.createElement('span');
    wrap.className = 's-stat';
    wrap.dataset.kind = kind;

    const v = document.createElement('span');
    v.className = 's-value';
    v.textContent = value;
    wrap.append(v);

    if (unit) {
      const u = document.createElement('span');
      u.className = 's-unit';
      u.textContent = unit;
      wrap.append(u);
    }
    return wrap;
  }));

  dropOverflowingStats();
}

/**
 * Drop stats from the right until the line fits.
 *
 * This window cannot scroll — it ignores mouse input so the game keeps every click, so
 * the wheel never reaches it and anything past the edge is content silently gone. The
 * usual CSS answers are all worse here: `overflow: hidden` clips a number mid-digit,
 * `text-overflow: ellipsis` turns "1038p" into "10…", and either one leaves a figure on
 * screen that reads as a smaller number than it is. Removing the whole stat is the only
 * option that cannot mislead.
 *
 * The label and the elapsed time are never dropped: without the first the line has no
 * name, and without the second every rate on it is unreadable.
 */
function dropOverflowingStats() {
  const line = els.sessionLine;
  // A dozen iterations at worst, five in practice, and only while the line is on.
  while (els.sessionStats.children.length > 0 && line.scrollWidth > line.clientWidth) {
    els.sessionStats.lastElementChild.remove();
  }
}

/** A whole-number tally: 142 kills is 142, never 142.0, and 1240 is "1.2k". */
function formatTally(n) {
  const v = Math.round(Number(n) || 0);
  return v >= 10_000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

/**
 * Copper as the game says it — "178p 8g", not "178886".
 *
 * Two denominations, which is a deliberate truncation and the only one on this line: at
 * this width the difference between 178p 8g and 178p 8g 8s 6c is four characters that
 * nobody reads mid-pull, and the exact purse is one click away in the Session window.
 * Everything else on the line is the whole number or absent.
 */
function formatCoin(copper) {
  const n = Math.max(0, Math.round(copper));
  if (n === 0) return '0c';
  const parts = [];
  let rest = n;
  for (const [suffix, per] of [['p', 1000], ['g', 100], ['s', 10], ['c', 1]]) {
    const q = Math.floor(rest / per);
    rest -= q * per;
    if (q > 0) parts.push(`${q}${suffix}`);
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

/**
 * Size the window to exactly its content.
 *
 * A fixed-height overlay spends most of a session as a mostly-empty translucent slab,
 * because a group of four needs a quarter of the height a raid does.
 *
 * This runs in BOTH lock states, and it reports MEASUREMENTS, not bounds: the height the
 * content wants, and how many pixels the breakdown's name columns are short of showing
 * every name whole. Main owns the resting bounds and the clamps, so it alone decides
 * where the window goes — the renderer asking for absolute bounds is how a fitted size
 * would end up persisted as the player's own choice.
 *
 * While the breakdown is open the window grows in BOTH dimensions — every ability with
 * its name in full — and main gives both back when it closes.
 */
let lastSentPanelOpen = false;

function fitWindow() {
  const height = measureContentHeight();
  const panelOpen = !els.detail.hidden;
  const extraWidth = panelOpen ? measureWidthShortfall() : 0;

  // A dead band stops a 1px rounding difference from starting a resize feedback loop.
  // A panel-state flip is always sent regardless: the close message is what tells main
  // to give the borrowed width and height back.
  if (
    panelOpen === lastSentPanelOpen &&
    extraWidth === 0 &&
    Math.abs(height - window.innerHeight) < 3
  ) return;

  lastSentPanelOpen = panelOpen;
  window.api.fitWindow({ height, extraWidth, panelOpen });
}

function measureContentHeight() {
  let height = 2;   // the slab's top and bottom border
  for (const child of els.slab.children) {
    if (child.hidden) continue;   // the breakdown counts when open, so the window grows for it
    if (child === els.rows) {
      // NOT scrollHeight: #rows is a flex-grow scroller, and scrollHeight never
      // reports less than the stretched client height, so it would just measure the
      // window back to itself and the fit would never shrink. Sum the rows instead.
      const style = getComputedStyle(child);
      height += parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      for (const row of child.children) height += row.offsetHeight;
    } else {
      height += child.offsetHeight;
    }
  }
  return Math.ceil(height);
}

/**
 * How many pixels of window width the ability list is missing.
 *
 * `.a-name` is the one elastic column, clipped with an ellipsis when the track is
 * narrow — `scrollWidth` still reports the full text, so the worst shortfall says
 * exactly how much wider the window must be for every name to fit. The extra width a
 * resize brings is split evenly among the columns' `1fr` name tracks, so the shortfall
 * is multiplied by the column count; the +2 covers scrollWidth/clientWidth integer
 * rounding leaving a permanent one-pixel clip.
 *
 * Measured against the CURRENT width: once the window has grown, this reads zero and
 * the 4 Hz repaint stops asking. Main never shrinks while the panel stays open — width
 * comes back when it closes — so moving between members cannot make the window flap.
 */
function measureWidthShortfall() {
  let deficit = 0;
  for (const el of els.dAbilities.querySelectorAll('.a-name')) {
    deficit = Math.max(deficit, el.scrollWidth - el.clientWidth);
  }
  if (deficit === 0) return 0;
  const cols = Number(els.dAbilities.dataset.cols || '1');
  return (deficit + 2) * cols;
}

function renderRows(rows, m) {
  const seen = new Set();

  rows.forEach((row, index) => {
    seen.add(row.name);
    let el = rowCache.get(row.name);

    if (!el) {
      el = buildRow(row.name);
      rowCache.set(row.name, el);
    }

    // Order changes as the fight develops; re-appending is cheap and keeps the
    // element (and therefore its running bar transition) alive.
    if (els.rows.children[index] !== el) {
      els.rows.insertBefore(el, els.rows.children[index] ?? null);
    }

    el.dataset.self = String(row.name === selfName);
    el.dataset.unknown = String(row.name === 'Unknown');

    const total = row[m.total];
    const petTotal = metric === 'healing' ? row.petHealing
      : metric === 'taken' ? row.petDamageTaken
      : row.petDamage;
    const petFraction = total > 0 ? petTotal / total : 0;

    el.refs.fill.style.width = `${(row[m.share] * 100).toFixed(2)}%`;
    el.refs.pet.style.width = `${(petFraction * 100).toFixed(2)}%`;
    el.refs.pet.hidden = petTotal === 0;

    el.refs.name.textContent = row.name;
    el.refs.dps.textContent = formatNumber(row[m.rate]);
    el.refs.share.textContent = `${Math.round(row[m.share] * 100)}%`;
  });

  for (const [name, el] of rowCache) {
    if (!seen.has(name)) {
      el.remove();
      rowCache.delete(name);
    }
  }
}

function buildRow(name) {
  const li = document.createElement('li');
  li.className = 'row';

  const fill = document.createElement('span');
  fill.className = 'fill';
  const pet = document.createElement('span');
  pet.className = 'fill-pet';
  fill.append(pet);

  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  const dpsEl = document.createElement('span');
  dpsEl.className = 'dps tabular';
  const shareEl = document.createElement('span');
  shareEl.className = 'share tabular';

  li.append(fill, nameEl, dpsEl, shareEl);
  li.refs = { fill, pet, name: nameEl, dps: dpsEl, share: shareEl };
  // Read back by the mousemove hit-test, which works under click-through.
  li.dataset.name = name;

  return li;
}

// ---------------------------------------------------------------- breakdown

function renderDetail(row) {
  els.detail.hidden = false;
  els.dName.textContent = row.name;
  setWho(row.who);

  // The type row belongs to the taken view alone; renderTakenDetail un-hides it.
  els.dTypes.hidden = true;

  if (metric === 'healing') renderHealDetail(row);
  else if (metric === 'taken') renderTakenDetail(row);
  else renderDamageDetail(row);

  layoutAbilityColumns();

  // Re-fit now rather than waiting for the next 4 Hz push. Also covers moving between
  // rows, where the panel changes height because members have different ability counts.
  fitWindow();
}

/**
 * What `/who` last said about this member: "29 PAL/DRU/BST · Dwarf · 14m ago".
 *
 * The age is not decoration and is never dropped. EverQuest Legends lets a player swap
 * classes at will, so there is no durable "Emalina is a cleric" fact to show — only a
 * reading with a time on it, and a trio read six hours ago is weaker evidence than one
 * read a minute ago. Saying which is what keeps the line honest.
 *
 * Hidden rather than blanked when there is no reading, because the panel auto-fits: an
 * empty line would still take its height. The History window makes the opposite call
 * for the opposite reason — it must never reflow, so there the line is always drawn.
 */
function setWho(who) {
  if (!who || !(who.classes?.length > 0)) {
    els.dWho.hidden = true;
    els.dWho.textContent = '';
    return;
  }
  const bits = [`${who.level} ${who.classes.join('/')}`];
  if (who.race) bits.push(who.race);
  bits.push(formatAge(who.seenAgoMs));
  els.dWho.textContent = bits.join(' · ');
  els.dWho.hidden = false;
}

/**
 * How old a /who reading is, in one glance-sized phrase.
 *
 * Whole phrase rather than a bare number, so "just now" does not have to be followed by
 * an "ago" that reads as broken English. Rounded hard: the difference between 13 and 14
 * minutes changes nothing about how much the reading is worth.
 */
function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 45_000) return 'just now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function renderDamageDetail(row) {
  els.dTotal.textContent = `${row.damage.toLocaleString()} dmg · ${formatNumber(row.dps)} dps`;

  setSplit(row.playerDamage, row.petDamage);

  setStats(els.dStats, [
    ['hits', row.hits],
    ['misses', row.misses],
    ['crits', row.crits],
    ['accuracy', `${Math.round(row.accuracy * 100)}%`],
    ['max hit', row.maxHit.toLocaleString()],
    ['share', `${Math.round(row.share * 100)}%`],
  ]);

  const sources = Object.entries(row.bySource)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  // The procs chip renders ALWAYS, including as a zero. Showing it only when there are
  // procs would move every chip after it — and, on a member whose chips wrap to a
  // second line, shove the whole ability list down — the moment a weapon happened to
  // fire. The overlay cannot scroll, so a row pushed off the bottom is a row gone.
  setChips([
    ...sources.map(([kind, value]) => [SOURCE_LABEL[kind] ?? kind, value.toLocaleString()]),
    ['procs', (row.procDamage ?? 0).toLocaleString()],
  ]);

  // EVERY ability, never a top-N slice. The parser was credited with the damage; a
  // breakdown that hides the bottom of the list reads as damage gone missing — DoTs
  // sort low per-tick and were exactly what vanished.
  //
  // Accuracy and the hit count both earn a column because they answer different
  // questions: which attack is dragging the member-level accuracy down, and how much
  // that attack actually swung. The old `2/3` cell answered neither on its own.
  setAbilities(row.abilities, {
    value: (a) => a.damage,
    columns: [
      // Of this member's own total, pet included — so the full list sums to 100% for them.
      { label: '%dmg', className: 'a-pct', cell: (a) => formatShare(row.damage > 0 ? a.damage / row.damage : 0) },
      { label: 'dmg', className: 'a-dmg', cell: (a) => a.damage.toLocaleString() },
      { label: 'acc', className: 'a-acc', cell: (a) => formatAccuracy(abilityAccuracy(a.hits, a.misses)) },
      { label: 'hits', className: 'a-hits', cell: (a) => String(a.hits) },
    ],
  });
}

/**
 * The healing view answers a different question from the damage view, so it shows
 * different things: overhealing and efficiency (was the heal needed?) instead of crits
 * and accuracy, and who was healed instead of damage source types.
 */
function renderHealDetail(row) {
  els.dTotal.textContent = `${row.healing.toLocaleString()} healed · ${formatNumber(row.hps)} hps`;

  setSplit(row.playerHealing, row.petHealing);

  setStats(els.dStats, [
    ['heals', row.heals],
    ['overheal', row.overhealing.toLocaleString()],
    ['landed', `${Math.round(row.healEfficiency * 100)}%`],
    ['max heal', row.maxHeal.toLocaleString()],
    ['share', `${Math.round(row.healShare * 100)}%`],
    ['rolling', formatNumber(row.rollingHps)],
  ]);

  setChips(row.healTargets.map((t) => [t.name, t.healing.toLocaleString()]));

  // No accuracy column here: heals do not miss. The spare column goes to overhealing,
  // which was a rider on the cast count and is a fact in its own right — the whole
  // question this view asks is whether the heal was needed.
  setAbilities(row.healAbilities, {
    value: (a) => a.healing,
    columns: [
      // Of what LANDED, matching the hps figure above it. A healer whose every point was
      // overheal divides by zero here and gets a dash, which is the honest reading.
      { label: '%heal', className: 'a-pct', cell: (a) => formatShare(row.healing > 0 ? a.healing / row.healing : 0) },
      { label: 'healed', className: 'a-dmg', cell: (a) => a.healing.toLocaleString() },
      { label: 'overheal', className: 'a-over', cell: (a) => a.overhealing.toLocaleString() },
      { label: 'casts', className: 'a-hits', cell: (a) => String(a.casts) },
    ],
  });
}

/**
 * The taken view answers "what is killing me": the chips are the attackers (worst
 * first), the ability list is what they hit with, and deaths sit in the stats where
 * they cannot be missed. Same layout as the other two views, so nothing new to learn.
 */
function renderTakenDetail(row) {
  els.dTotal.textContent = `${row.damageTaken.toLocaleString()} taken · ${formatNumber(row.dtps)} dtps`;

  setSplit(row.playerDamageTaken, row.petDamageTaken);

  setStats(els.dStats, [
    ['hits taken', row.hitsTaken],
    ['max hit', row.maxHitTaken.toLocaleString()],
    ['avoided', row.avoidsTaken],
    ['deaths', row.petDeaths > 0 ? `${row.deaths} +${row.petDeaths} pet` : row.deaths],
    ['share', `${Math.round(row.takenShare * 100)}%`],
    ['rolling', formatNumber(row.rollingDtps)],
  ]);

  setChips(row.attackers.map((a) => [a.name, a.damage.toLocaleString()]));
  setTypeChips(row.takenByType ?? {});

  // Incoming abilities carry no swing count of their own — misses are recorded against
  // the member, not against the thing that swung — so there is no accuracy to show. The
  // column goes to the resist instead, which answers "what would have helped" right on
  // the ability that hurt, and which used to ride inside the hits cell as "17 · FR".
  setAbilities(row.takenAbilities, {
    value: (a) => a.damage,
    columns: [
      { label: '%taken', className: 'a-pct', cell: (a) => formatShare(row.damageTaken > 0 ? a.damage / row.damageTaken : 0) },
      { label: 'taken', className: 'a-dmg', cell: (a) => a.damage.toLocaleString() },
      { label: 'hits', className: 'a-hits', cell: (a) => String(a.hits) },
      { label: 'resist', className: 'a-resist', cell: (a) => resistCell(a.type) },
    ],
  });
}

/**
 * What resists this, as a cell. Melee is mitigated by armor rather than by a resist, and
 * an unstated type gets a dash — the log did not say, so neither do we. Same wording as
 * the History window's resist column, because the two describe the same fight.
 */
function resistCell(type) {
  if (RESIST[type]) return RESIST[type];
  return type === 'melee' ? 'armor' : '—';
}

/**
 * Which resist mitigates which stated damage type. Melee is armor, not a resist, and
 * an unstated type gets no tag — the log did not say, so neither do we.
 */
const RESIST = {
  fire: 'FR',
  cold: 'CR',
  magic: 'MR',
  poison: 'PR',
  disease: 'DR',
  corruption: 'Corr',
};

/** "fire 3,231 FR · melee 10,929 · untyped 712" — damage per stated type. */
function setTypeChips(byType) {
  const entries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  els.dTypes.hidden = entries.length === 0;
  els.dTypes.replaceChildren(
    ...entries.map(([type, value]) => {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = value.toLocaleString();
      li.append(document.createTextNode(`${type} `), b);
      if (RESIST[type]) {
        const tag = document.createElement('span');
        tag.className = 'resist';
        tag.textContent = ` ${RESIST[type]}`;
        li.append(tag);
      }
      return li;
    })
  );
}

/**
 * The player/pet split line: bar widths plus the legend labels, from raw values.
 * All three metric views want the identical line, so the wording lives here. The
 * percentages come from splitShares (complementary rounding, so the pair sums to
 * 100); when it returns null there is nothing to divide and the labels stay plain
 * totals — `player 0 · 100%` on a death-only row would be a made-up number.
 */
function setSplit(playerValue, petValue) {
  const shares = splitShares(playerValue, petValue);
  const petPct = shares ? shares.petPct : 0;
  els.dSelfBar.style.width = `${100 - petPct}%`;
  els.dPetBar.style.width = `${petPct}%`;
  els.dSelfLabel.textContent = shares
    ? `player ${playerValue.toLocaleString()} · ${shares.playerPct}%`
    : `player ${playerValue.toLocaleString()}`;
  els.dPetLabel.textContent = shares
    ? `pet ${petValue.toLocaleString()} · ${shares.petPct}%`
    : `pet ${petValue.toLocaleString()}`;
}

function setChips(pairs) {
  els.dSources.replaceChildren(
    ...pairs.map(([label, value]) => {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = value;
      li.append(document.createTextNode(`${label} `), b);
      return li;
    })
  );
}

/**
 * The ability list: a name and FOUR labelled numbers, headed by a caption row.
 *
 * Every column carries exactly one fact, and that is the whole design. The fourth cell
 * used to be a compound "detail" whose meaning moved per view and per row — `2/3` here,
 * `3 · 120 over` there, `17 · FR` in the taken view — which is precisely why the table
 * could not be headed: no single word captions "hits, sometimes over swings, sometimes
 * with an overheal". A player was left to infer what the third number meant, and the
 * sibling History window, showing the same fight, had captions all along.
 *
 * `value` still stands apart from the columns because it is not a column: it feeds the
 * background bar, normalized to the member's LARGEST ability so the list ranks at a
 * glance even when the top ability is a fifth of their output. The share of the total is
 * a column of its own.
 *
 * No header over an empty list — a caption above nothing is noise, and the overlay pays
 * for every pixel it takes from the game.
 */
function setAbilities(list, { value, columns }) {
  if (list.length === 0) {
    els.dAbilities.replaceChildren();
    return;
  }

  const head = document.createElement('li');
  head.className = 'cols';
  head.append(headerCell('ability', 'c-name'), ...columns.map((c) => headerCell(c.label)));

  const best = value(list[0]) || 1;
  els.dAbilities.replaceChildren(
    head,
    ...list.map((a) => {
      const li = document.createElement('li');
      li.dataset.pet = String(Boolean(a.pet));   // taken abilities carry no pet flag
      // A proc is a fact about the ability, not a column of its own: the label already
      // says "(pet proc)", and this only tints it so the group reads at a glance.
      if (a.proc) li.dataset.proc = '';
      else delete li.dataset.proc;
      li.style.setProperty('--w', `${(value(a) / best) * 100}%`);

      const n = document.createElement('span');
      n.className = 'a-name';
      n.textContent = a.name;

      li.append(n, ...columns.map((c) => {
        const s = document.createElement('span');
        s.className = c.className;
        s.textContent = c.cell(a);
        return s;
      }));
      return li;
    })
  );
}

/**
 * One caption cell. Deliberately NOT `.a-name` on the first one: `measureWidthShortfall`
 * queries `.a-name` to decide how much wider the window must be for every ability name to
 * fit, and the word "ability" is not a name anybody needs read in full.
 */
function headerCell(label, className = '') {
  const s = document.createElement('span');
  if (className) s.className = className;
  s.textContent = label;
  return s;
}

/**
 * How many grid tracks one rendered column of the ability list takes: the elastic name
 * plus its four labelled values. Multi-column mode repeats the whole group, so this is
 * also the stride between one column's first track and the next's. It MUST stay in step
 * with the `repeat(n, 1fr auto auto auto auto)` rules in overlay.css — a mismatch there
 * places rows into tracks that do not exist and the list silently loses its right edge.
 */
const ABILITY_TRACKS = 5;

/**
 * Flow the ability list into as many columns as the screen forces, never fewer rows.
 *
 * The list always holds every ability; when one column would be taller than the work
 * area allows, it flows into two, then three. Column-major, so the damage ranking reads
 * down each column the way the single-column list always has.
 *
 * Placement must be EXPLICIT per item: the stylesheet's `li { grid-column: 1 / -1 }`
 * spans the whole grid, which in a multi-column template would stack every item back
 * into one full-width column regardless of `data-cols`. Inline styles override it.
 *
 * The caption row is repeated per rendered column rather than drawn once. A single header
 * over a three-column list would caption the first column and leave the other two bare —
 * worse than no header at all, because it reads as applying to all of them.
 */
function layoutAbilityColumns() {
  const list = els.dAbilities;

  // Reset to a single column first — both the measurement baseline and the usual case.
  // The cloned headers from the last layout go; the first one is the real one, built by
  // setAbilities, and survives.
  for (const clone of list.querySelectorAll('li.cols[data-clone]')) clone.remove();
  const header = list.querySelector('li.cols');
  const items = [...list.children].filter((li) => li !== header);

  list.dataset.cols = '1';
  for (const li of [header, ...items]) {
    if (!li) continue;
    li.style.gridRow = '';
    li.style.gridColumn = '';
    delete li.dataset.col;
  }
  if (items.length < 2) return;

  const rowHeight = items[0].offsetHeight + 1;         // +1: the grid's row-gap
  const headHeight = header ? header.offsetHeight + 1 : 0;
  // The vertical budget is the whole work area — screen.availHeight, no IPC needed —
  // minus everything on screen that is not an ability row. The caption is one of those
  // things: it sits on grid row 1 of every rendered column, so it costs its height once
  // no matter how many columns the list ends up in, and the rows get what is left.
  const nonList = measureContentHeight() - items.length * rowHeight - headHeight;
  const cols = abilityColumns({
    count: items.length,
    rowHeight,
    available: screen.availHeight - nonList - headHeight,
  });
  if (cols === 1) return;

  const rows = Math.ceil(items.length / cols);
  items.forEach((li, i) => {
    const col = Math.floor(i / rows);
    li.dataset.col = String(col);
    // Row 1 is the caption; the abilities start beneath it.
    li.style.gridRow = String((i % rows) + 2);
    li.style.gridColumn = `${col * ABILITY_TRACKS + 1} / span ${ABILITY_TRACKS}`;
  });

  if (header) {
    for (let col = 0; col < cols; col++) {
      // Column 0 keeps the original node so nothing depends on clone order; the rest are
      // copies, marked so the next layout can clear them.
      const el = col === 0 ? header : header.cloneNode(true);
      if (col > 0) {
        el.dataset.clone = '';
        list.append(el);
      }
      el.dataset.col = String(col);   // also picked up by the inter-column margin rule
      el.style.gridRow = '1';
      el.style.gridColumn = `${col * ABILITY_TRACKS + 1} / span ${ABILITY_TRACKS}`;
    }
  }

  list.dataset.cols = String(cols);
}

const SOURCE_LABEL = {
  melee: 'melee',
  spell: 'spell',
  dot: 'dot',
  ds: 'shield',
  nonmelee: 'unknown',
};

function setStats(dl, pairs) {
  dl.replaceChildren(
    ...pairs.map(([label, value]) => {
      const wrap = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = String(value);
      wrap.append(dt, dd);
      return wrap;
    })
  );
}

function hideDetail() {
  const wasOpen = !els.detail.hidden;
  hoveredName = null;
  els.detail.hidden = true;
  if (wasOpen) fitWindow();   // give back the width and height the panel borrowed
}

// ------------------------------------------------------- mouse pass-through

/**
 * Hover handling under click-through.
 *
 * MOUSE events, not pointer events. While the window ignores mouse input,
 * `forward: true` forwards the raw move messages to Chromium, which documents that as
 * enabling "mouse related events such as mouseleave and mouseover" — the Pointer Events
 * API is not part of that guarantee, and `pointerenter` never fires, which silently
 * killed the whole feature in locked mode.
 *
 * Hit-testing with elementFromPoint rather than relying on event.target keeps this
 * correct regardless of how the forwarded event is retargeted.
 */
/**
 * Resolve a point inside the window to a member row, and open its breakdown.
 * @param {number|null} x window-relative CSS pixels, or null when the cursor is outside
 */
function hoverAt(x, y) {
  if (x === null) {
    hideDetail();
    return;
  }
  const el = document.elementFromPoint(x, y);
  if (!el) {
    hideDetail();
    return;
  }
  // Sitting inside the open panel keeps the current row selected.
  if (el.closest('#detail')) return;

  const row = el.closest('.row');
  if (!row) {
    hideDetail();
    return;
  }
  const name = row.dataset.name;
  if (name === hoveredName) return;

  hoveredName = name;
  const data = snapshot?.rows.find((r) => r.name === name);
  if (data) renderDetail(data);
}

/**
 * Hover under click-through.
 *
 * `setIgnoreMouseEvents(true, { forward: true })` is the documented way to keep receiving
 * mouse moves while clicks pass through — but it delivered nothing here (verified: a
 * mousemove counter wired to the overlay never incremented), so the breakdown was
 * unreachable in the locked state it is normally used in.
 *
 * Instead the main process polls the cursor and sends window-relative coordinates. That
 * has a real advantage over the forwarding approach: the window never has to take mouse
 * events back to show the panel, so the game keeps every click even while the breakdown
 * is open.
 *
 * DOM mousemove is still wired up for the unlocked state, where the window is a normal
 * interactive window and events arrive the ordinary way.
 */
function wireHover() {
  window.api.onHover((pos) => hoverAt(pos ? pos.x : null, pos ? pos.y : 0));

  document.addEventListener('mousemove', (e) => hoverAt(e.clientX, e.clientY));
  document.addEventListener('mouseleave', () => hideDetail());
}

function wireControls() {
  $('btn-copy').addEventListener('click', copyReport);
  // The hotkey's half of the same button, wired beside it so the two triggers of the one
  // action read as a pair. The button is only on screen while unlocked — which is the
  // state the overlay is not in during a pull — so this is how the line is normally taken.
  window.api.onCopyRequest(copyReport);
  $('btn-metric').addEventListener('click', () => window.api.toggleMetric());
  $('btn-reset').addEventListener('click', () => window.api.resetEncounter());
  $('btn-settings').addEventListener('click', () => window.api.openSettings());
  $('btn-lock').addEventListener('click', () => window.api.toggleLock());
  $('btn-close').addEventListener('click', () => window.api.close());
}

/**
 * The meter, as one line, on the clipboard.
 *
 * Copies whatever metric is on screen — the healing view copies hps, the taken view
 * copies dtps — so the button's meaning is always the meter directly above it.
 *
 * The write happens in main (`clipboard.writeText`), not here. The Async Clipboard API
 * needs a focused document and a user-gesture context, and this is a transparent,
 * always-on-top window that spends its life unfocused and ignoring mouse input; the case
 * where it fails is the case we ship, and it fails as a rejected promise, so the button
 * would look like it had worked. `invoke` rather than a send for the same reason the
 * toast comes after the await: announcing an outcome we did not observe is the thing to
 * avoid here.
 *
 * With nothing to copy the clipboard is left untouched. Wiping whatever the player had
 * copied, to replace it with an empty meter, is the worst thing a button labelled COPY
 * could do.
 */
async function copyReport() {
  const report = chatReport(snapshot, metric);
  if (!report.text) {
    showToast('Nothing to copy yet');
    return;
  }

  const result = await window.api.copyText(report.text);
  if (!result?.ok) {
    showToast('Copy failed');
    return;
  }

  // Dropping members is the one outcome the player must hear about out loud — the
  // alternative is finding out from whoever they pasted it to.
  if (report.shown < report.total) showToast(`Copied — ${report.shown} of ${report.total} fit`);
  else if (report.stage > 0) showToast('Copied — shortened to fit chat');
  else showToast(`Copied — ${report.total} in group`);
}

function showToast(message, ms = 2600) {
  els.toast.textContent = message;
  els.toast.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.dataset.show = 'false'; }, ms);
  // A long hint can be wider than the status text beside it; give it the room.
  els.toast.dataset.wide = String(ms > 4000);
}

// ---------------------------------------------------------------- formatting

/**
 * An ability's share of its owner's total, as a column.
 *
 * Rounding is deliberate but has a floor: an ability worth 0.4% of a member's damage would
 * round to a bare "0%" beside a four-digit number, which reads as a bug rather than as
 * "negligible". Sub-1% shares print "<1%" instead, and a zero denominator prints an em dash
 * rather than "NaN%" — the real case being a healer whose every point was overheal.
 */
function formatShare(fraction) {
  if (!Number.isFinite(fraction)) return '—';
  const pct = fraction * 100;
  if (pct <= 0) return '—';
  if (pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

/**
 * An ability's accuracy, as a column.
 *
 * Deliberately NOT `formatShare`, which dashes out anything at or below zero: an ability
 * that swung and never landed is a real 0% and the most worth-reading row in the list,
 * while an ability that never swung at all has nothing to divide and gets the dash. The
 * two look identical to a share formatter and could not be more different to a player.
 */
function formatAccuracy(fraction) {
  if (fraction === null || !Number.isFinite(fraction)) return '—';
  return `${Math.round(fraction * 100)}%`;
}

/** DPS needs three glances-worth of precision, not six digits. */
function formatNumber(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(1);
}
