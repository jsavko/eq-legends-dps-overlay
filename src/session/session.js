/**
 * The session aggregator: what a night of play earned.
 *
 * A play session is a completely different unit of time from an encounter, which is why
 * this does not live in `encounter.js`. An encounter is seconds to minutes and closes the
 * moment the fighting stops; a session is hours, survives zoning, survives walking to the
 * bank, survives a long AFK, and closes only when the player has genuinely stopped
 * playing. Jamming those two lifetimes into one class is how you get the bug that
 * `encounter.js`'s "heals never extend a fight" rule exists to prevent, in a new costume.
 *
 * Pure Node, no Electron — the same construction rule as its two neighbours, so the whole
 * thing replays offline against a real log.
 *
 * ## The experience honesty rule
 *
 * EverQuest prints experience as A PERCENTAGE OF THE CURRENT LEVEL and nothing else.
 * There is no absolute number in the log, anywhere. So:
 *
 *   - `%/hr` is real and useful *within* a level.
 *   - Summing percentages ACROSS a level boundary is meaningless. 12% at level 28 and 12%
 *     at level 51 are wildly different amounts of experience and adding them produces a
 *     number that describes nothing.
 *   - "Time to level" is honest — but only from a segment that began at a KNOWN 0%, which
 *     means only after a level-up line has been seen. A session that started mid-level
 *     knows how much was gained and not how far in it began, so it cannot say when the
 *     next level lands, and says so rather than guessing.
 *
 * That is why experience is stored as a ledger of per-level SEGMENTS rather than a total,
 * and why `anchored` is a field. This is the same rule as "ambiguous attribution goes to
 * Unknown" and "damage with no stated type stays untyped": the number we cannot honestly
 * compute is the number we do not print.
 */

import { parseTimestamp } from '../parser/timestamp.js';
import { resolveEntity } from '../parser/entities.js';
import { CHAT_RULE_IDS } from '../parser/rules.js';
import { matchSessionRule, SESSION_CATEGORIES, COPPER_PER } from './rules.js';

/**
 * Parser outcomes that mean "this line was somebody talking".
 *
 * By RULE ID, because the parser's chat rule emits two kinds — `chat`, and
 * `player-proof` when the channel proves the speaker is a real player — so guarding on
 * the kind alone would let every guild, group, raid and auction line straight through.
 * That is not hypothetical: it is what the first draft of this module did, and a quoted
 * kill line in guild chat scored.
 */
const SPEECH = new Set(CHAT_RULE_IDS);

/** The record schema version, bumped if the shape ever changes incompatibly. */
export const SESSION_VERSION = 1;

/**
 * How long a session tolerates silence before it is over.
 *
 * An hour, which is EQBuddy's boundary and matches how a play night actually breaks: a
 * meal, a bio break and a long corpse run are all well under it, and anything past it was
 * a different sitting. Deliberately measured from the last TRACKED event rather than the
 * last log line — a client left open in the Bazaar writes chat all night and none of it
 * is play.
 */
export const IDLE_MS = 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/** Per-hour rate, or null when there is not yet enough elapsed time to mean anything. */
function perHour(value, elapsedMs) {
  if (!(elapsedMs > 0)) return null;
  return (value * HOUR_MS) / elapsedMs;
}

/** Add one coin parse into a running purse, denominations and copper total alike. */
function addCoin(purse, coin) {
  for (const d of Object.keys(COPPER_PER)) purse[d] += coin[d] ?? 0;
  purse.copperTotal += coin.copperTotal ?? 0;
  return purse;
}

function emptyPurse() {
  return { platinum: 0, gold: 0, silver: 0, copper: 0, copperTotal: 0 };
}

/** Map -> array of `{name, count}`, biggest first, then alphabetical so ties are stable. */
function counted(map) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * One session in flight.
 *
 * Kept as its own class rather than a bag of fields on the tracker so that "what is a
 * session" has one answer that can be read top to bottom, and so the tracker's job stays
 * the small one: decide when a session begins and ends.
 */
class Session {
  constructor({ startTs, character, server }) {
    this.startTs = startTs;
    /** The last TRACKED event — what the idle timeout measures from, and the true end. */
    this.lastTs = startTs;
    this.character = character;
    this.server = server;

    /** Kills whose killing blow was ours; `others` is everything else the zone did. */
    this.killsMine = 0;
    this.killsOurs = 0;
    this.killsOthers = 0;
    this.byCreature = new Map();
    this.byKiller = new Map();
    this.deaths = [];

    this.loot = new Map();
    this.lootTotal = 0;

    this.coinBySource = new Map();
    this.coinEarned = emptyPurse();
    this.coinSpent = emptyPurse();
    this.purchases = [];

    /** @type {Array<{level: number|null, anchored: boolean, percent: number, solo: number, party: number, ticks: number, startTs: number, endTs: number|null}>} */
    this.xpSegments = [];
    this.levelUps = [];
    this.levelsGained = 0;
    this.levelsLost = 0;

    this.aaEarned = 0;
    this.aaSpent = 0;
    /** The game's own running total of unspent points; null until it states one. */
    this.aaUnspent = null;
    this.aaAbilities = [];

    this.factions = new Map();

    this.skills = new Map();
    this.tradeskills = new Map();

    /** @type {Array<{zone: string, enterTs: number, exitTs: number|null}>} */
    this.zones = [];

    /**
     * Tracked events that were not merely walking.
     *
     * Zone lines are excluded on purpose: a "session" consisting of nothing but zone
     * transitions is somebody running to the bank, and writing it to the store would fill
     * the rail with nights that contain no night. Everything else counts, so a session
     * that earned one copper is still a session.
     */
    this.eventCount = 0;
  }

  /** The segment experience is currently landing in, opening one if none is live. */
  currentSegment(ts) {
    const last = this.xpSegments[this.xpSegments.length - 1];
    if (last && last.endTs === null) return last;
    // The first segment of a session began at an unknown point inside an unknown level:
    // we joined mid-stream and the log will not say where. `anchored: false` is what
    // stops the UI offering a time-to-level it cannot compute.
    const seg = {
      level: null, anchored: false, percent: 0, solo: 0, party: 0, ticks: 0,
      startTs: ts, endTs: null,
    };
    this.xpSegments.push(seg);
    return seg;
  }
}

/**
 * Feeds lines in, hands finished sessions out.
 *
 * @param {Object} [options]
 * @param {Object} [options.categories]  `{kills: true, coin: false, ...}`; absent means on
 * @param {number} [options.idleMs]      silence that ends a session
 * @param {string} [options.character]
 * @param {string} [options.server]
 * @param {(name: string) => boolean} [options.isOurs]  roster predicate, see below
 * @param {(record: Object) => void} [options.onSessionEnd]
 */
export class SessionTracker {
  constructor(options = {}) {
    this.categories = options.categories ?? null;
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.character = options.character ?? null;
    this.server = options.server ?? null;
    this.onSessionEnd = options.onSessionEnd ?? null;

    /**
     * Is this killer one of ours?
     *
     * Injected because the answer lives in `roster.js`, which belongs to the combat
     * parser — and reaching into the parser for it would make this module depend on the
     * one thing it was built beside rather than inside. `main.js` and the replay script
     * both have a parser and both pass its roster in.
     *
     * The default is deliberately the CONSERVATIVE one: without a roster the only killer
     * we can be sure of is the logging character and their pets, so a grouped session
     * undercounts rather than crediting a passing stranger's kills to the night. Every
     * real caller injects; this is what a bare unit test gets.
     */
    this.isOurs = options.isOurs ?? null;

    /**
     * Events at or before this instant are already recorded and are skipped.
     *
     * This exists because of how the tailer starts: it seeks back 64 KB from the end of
     * the log so a fight already underway is not missed, which means every launch re-reads
     * lines the previous launch already counted. For the combat parser that is harmless —
     * it rebuilds an encounter that has since closed. For a session store it is
     * double-counting, and restarting the overlay mid-camp would quietly add the last few
     * minutes of kills, coin and faction to the night a second time.
     *
     * The floor is the last event already on disk for this character, so the boundary is
     * a fact rather than a guess. It is INCLUSIVE: EQ timestamps have one-second
     * resolution, so an inclusive test can drop a handful of events that happened to land
     * in the same second as the previous session's last one, while an exclusive test would
     * re-count that second. Losing a little beats inflating — the same trade this codebase
     * makes everywhere it cannot be sure.
     */
    this.minTs = options.minTs ?? null;

    /** @type {Session|null} */
    this.session = null;
    /** Bumped whenever anything a viewer would see changes; the push loop reads it. */
    this.revision = 0;
  }

  /** Category gate, honouring "absent means on" so a partial config is not silence. */
  isOn = (category) => {
    if (!this.categories) return true;
    return this.categories[category] !== false;
  };

  /** True when at least one category can produce anything at all. */
  get anyCategoryOn() {
    return SESSION_CATEGORIES.some((c) => this.isOn(c));
  }

  /** The session in flight, or null. */
  get current() {
    return this.session;
  }

  /**
   * Feed one raw log line, plus what the combat parser made of it.
   *
   * The second argument is the entire chat guard. `src/parser/rules.js` classifies chat
   * FIRST by design, so a player quoting "You have slain a froglok shin knight!" in
   * /general arrives here already labelled — one condition, and the "chat first" rule
   * goes on living in exactly one place instead of being copied into a second table that
   * would drift.
   *
   * @param {string} line              the raw log line, timestamp and all
   * @param {Object|null} parserEvent  what `LogParser.feed` returned for it
   * @returns {Object|null} the session event, or null when nothing was tracked
   */
  feed(line, parserEvent) {
    if (parserEvent && SPEECH.has(parserEvent.rule)) return null;

    const parsed = parseTimestamp(line);
    if (!parsed) return null;

    const event = matchSessionRule(parsed.body, this.isOn);
    if (!event) return null;
    event.ts = parsed.ts;
    if (this.minTs !== null && event.ts <= this.minTs) return null;

    // Advance to this line's time BEFORE applying it, so a session that went stale during
    // a quiet stretch is closed at the moment it actually stopped and this event opens a
    // fresh one, rather than being appended to a sitting that ended hours ago.
    this.tick(event.ts);
    this.apply(event);
    return event;
  }

  /** Feed a whole blob of text. Only used by replay; the tailer feeds line by line. */
  feedChunk(text, parserEvents = null) {
    const out = [];
    let i = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const e = this.feed(line, parserEvents?.[i] ?? null);
      i += 1;
      if (e) out.push(e);
    }
    return out;
  }

  /**
   * Advance the clock without a line to advance it.
   *
   * Called from the push loop for the same reason the parser's is: during a lull no lines
   * arrive, and a session that stopped an hour ago has to be able to close and be written
   * without waiting for the player to come back and produce a line.
   */
  tick(now = Date.now()) {
    if (!this.session) return;
    if (now - this.session.lastTs >= this.idleMs) this.close('idle');
  }

  /**
   * Follow the player to a different character.
   *
   * A different character is a different session by definition — different level,
   * different faction standing, different purse — so the open one closes and is written
   * rather than being silently continued under the new name.
   */
  setCharacter(character, server = this.server) {
    if (character === this.character && server === this.server) return;
    if (this.session) this.close('character');
    this.character = character ?? null;
    this.server = server ?? null;
  }

  /** Update the category switches; an open session keeps whatever it already counted. */
  setCategories(categories) {
    this.categories = categories ?? null;
    this.revision += 1;
  }

  /**
   * Close the session in flight and hand it to `onSessionEnd`.
   *
   * The end time is the last TRACKED event, never "now" — a session that stopped at
   * 23:10 and was noticed at 00:10 lasted until 23:10, and stamping the discovery time
   * would inflate every duration by up to the idle timeout and quietly deflate every
   * per-hour rate that divides by it.
   *
   * @returns {Object|null} the finished record, or null when nothing was open
   */
  close(reason = 'manual') {
    const session = this.session;
    if (!session) return null;
    this.session = null;
    this.revision += 1;
    // Everything up to here has now been accounted for, whether or not the record turns
    // out to be worth keeping — so the floor moves even for a session that is discarded.
    this.minTs = Math.max(this.minTs ?? -Infinity, session.lastTs);

    const record = this.record(session, session.lastTs, reason);
    // A session with nothing in it is a phantom open, not a night anyone would review.
    if (record.events === 0) return null;
    try {
      this.onSessionEnd?.(record);
    } catch {
      // The callback writes to disk. A full disk must not take the tracker down with it —
      // the same rule history.js's caller follows, for the same reason.
    }
    return record;
  }

  // -------------------------------------------------------------------------- applying

  apply(event) {
    if (!this.session) {
      this.session = new Session({
        startTs: event.ts, character: this.character, server: this.server,
      });
    }
    const s = this.session;
    s.lastTs = event.ts;
    if (event.kind !== 'zone') s.eventCount += 1;
    this.revision += 1;

    switch (event.kind) {
      case 'kill':        this.applyKill(s, event); break;
      case 'death':       s.deaths.push({ ts: event.ts, killer: event.killer }); break;
      case 'loot':
        s.loot.set(event.item, (s.loot.get(event.item) ?? 0) + 1);
        s.lootTotal += 1;
        break;
      case 'coin': {
        addCoin(s.coinEarned, event.coin);
        const purse = s.coinBySource.get(event.source)
          ?? setDefault(s.coinBySource, event.source, emptyPurse());
        addCoin(purse, event.coin);
        break;
      }
      case 'spend':
        addCoin(s.coinSpent, event.coin);
        s.purchases.push({
          ts: event.ts, item: event.item, qty: event.qty,
          merchant: event.merchant, copper: event.coin.copperTotal,
        });
        break;
      case 'xp':          this.applyXp(s, event); break;
      case 'level':       this.applyLevel(s, event); break;
      case 'aa-earned':
        s.aaEarned += 1;
        s.aaUnspent = event.unspent;
        break;
      case 'aa-spent':
        s.aaSpent += event.cost;
        s.aaAbilities.push({ name: event.ability, cost: event.cost, improved: event.improved === true });
        break;
      case 'faction':     this.applyFaction(s, event); break;
      case 'faction-cap': this.applyFactionCap(s, event); break;
      case 'skill':       this.applySkill(s, event); break;
      case 'tradeskill':
        s.tradeskills.set(event.item, (s.tradeskills.get(event.item) ?? 0) + 1);
        break;
      case 'zone':        this.applyZone(s, event); break;
      default:            break;
    }
  }

  applyKill(s, event) {
    // The killer arrives raw, backtick pet form and all. Folding a pet into its owner is
    // exactly what the combat parser does with damage, and for the same reason: a warder's
    // kill is its owner's kill and nobody wants two rows for one person.
    const entity = resolveEntity(event.killer, s.character ?? 'You');
    const self = s.character ?? 'You';
    const mine = entity.name === self || event.killer === 'You';
    const ours = mine || (this.isOurs ? this.isOurs(entity.name) === true : false);

    if (!ours) {
      // Somebody else's kill in a shared zone. Counted so the pane can say the camp was
      // contested, never added to the night's total — a stranger's froglok is not ours.
      s.killsOthers += 1;
      return;
    }

    s.killsOurs += 1;
    if (mine) s.killsMine += 1;
    s.byCreature.set(event.victim, (s.byCreature.get(event.victim) ?? 0) + 1);
    s.byKiller.set(entity.name, (s.byKiller.get(entity.name) ?? 0) + 1);
  }

  applyXp(s, event) {
    const seg = s.currentSegment(event.ts);
    seg.percent += event.percent;
    seg.ticks += 1;
    if (event.share === 'party') seg.party += event.percent;
    else seg.solo += event.percent;
  }

  applyLevel(s, event) {
    const seg = s.currentSegment(event.ts);
    seg.endTs = event.ts;

    if (event.direction === 'up') {
      s.levelsGained += 1;
      // The level we were standing in is now known by subtraction — gaining level 28 says
      // the segment that just closed was level 27. That is read off the log, not guessed,
      // so an unnamed first segment gets its name the moment the boundary is crossed.
      if (seg.level === null) seg.level = event.level - 1;
      s.levelUps.push({ ts: event.ts, level: event.level });
      // Anchored: a level-up puts you at a KNOWN 0% of a known level, which is the only
      // state from which time-to-level can be computed honestly.
      s.xpSegments.push({
        level: event.level, anchored: true, percent: 0, solo: 0, party: 0, ticks: 0,
        startTs: event.ts, endTs: null,
      });
    } else {
      s.levelsLost += 1;
      if (seg.level === null) seg.level = event.level + 1;
      // A de-level drops you somewhere inside the level below, and the log does not say
      // where — so the new segment is emphatically not anchored.
      s.xpSegments.push({
        level: event.level, anchored: false, percent: 0, solo: 0, party: 0, ticks: 0,
        startTs: event.ts, endTs: null,
      });
    }
  }

  applyFaction(s, event) {
    const f = s.factions.get(event.faction)
      ?? setDefault(s.factions, event.faction, { delta: 0, hits: 0, cappedAt: null });
    f.delta += event.delta;
    f.hits += 1;
  }

  applyFactionCap(s, event) {
    const f = s.factions.get(event.faction)
      ?? setDefault(s.factions, event.faction, { delta: 0, hits: 0, cappedAt: null });
    // A cap is not a delta and must not read as zero: "capped and still killing them" and
    // "no faction changed hands" are different facts, and only the flag distinguishes them.
    f.cappedAt = event.at;
    f.hits += 1;
  }

  applySkill(s, event) {
    const k = s.skills.get(event.skill)
      ?? setDefault(s.skills, event.skill, { from: event.value, to: event.value, ups: 0 });
    // The number EQ prints is the NEW value, not the gain — so the session's story about a
    // skill is "from the first value seen to the last", never a sum of the printed numbers.
    k.to = event.value;
    k.ups += 1;
  }

  applyZone(s, event) {
    const open = s.zones[s.zones.length - 1];
    if (open && open.exitTs === null) {
      if (open.zone === event.zone) return;   // a zone line for where we already are
      open.exitTs = event.ts;
    }
    s.zones.push({ zone: event.zone, enterTs: event.ts, exitTs: null });
  }

  // ------------------------------------------------------------------------- reporting

  /**
   * The compact shape the snapshot carries — what the meter line needs and no more.
   *
   * Deliberately small: this crosses the IPC boundary four times a second, and the full
   * record is a browse-time thing the Session window asks for by name.
   */
  summary(now = Date.now()) {
    const s = this.session;
    if (!s) return null;
    const elapsedMs = Math.max(0, now - s.startTs);
    const seg = s.xpSegments[s.xpSegments.length - 1] ?? null;
    return {
      active: true,
      startTs: s.startTs,
      lastTs: s.lastTs,
      elapsedMs,
      kills: s.killsOurs,
      deaths: s.deaths.length,
      loot: s.lootTotal,
      copper: s.coinEarned.copperTotal - s.coinSpent.copperTotal,
      copperEarned: s.coinEarned.copperTotal,
      aa: s.aaEarned,
      /**
       * Levels GAINED, gross, never a net of gained-minus-lost.
       *
       * `railSummary` and `progressDetail` both already print the gross count, and one
       * number that means different things in two windows is worse than one that means a
       * slightly narrower thing everywhere. A de-level is rare and the Session window
       * states both halves; `levelsLost` rides along here so a future caller can say so
       * without a second round trip, though nothing renders it yet.
       *
       * Distinct from `xpLevel` below, which is the level you are STANDING IN. Those are
       * different facts and the line shows both.
       */
      levels: s.levelsGained,
      levelsLost: s.levelsLost,
      xpPercent: seg?.percent ?? 0,
      xpLevel: seg?.level ?? null,
      killsPerHour: perHour(s.killsOurs, elapsedMs),
      copperPerHour: perHour(s.coinEarned.copperTotal, elapsedMs),
      xpPercentPerHour: seg ? perHour(seg.percent, Math.max(0, now - seg.startTs)) : null,
    };
  }

  /** The full record for the session in flight — what the checkpoint file holds. */
  checkpoint(now = Date.now()) {
    if (!this.session) return null;
    return this.record(this.session, Math.max(now, this.session.lastTs), 'open');
  }

  /**
   * Freeze a session into the record shape the store and the window both read.
   *
   * Everything derived is derived HERE rather than in the renderer, so a record on disk
   * and a record on screen can never disagree about what a night contained.
   */
  record(s, endTs, closeReason) {
    const durationMs = Math.max(0, endTs - s.startTs);
    const zones = s.zones.map((z) => ({
      zone: z.zone,
      enterTs: z.enterTs,
      exitTs: z.exitTs,
      ms: Math.max(0, (z.exitTs ?? endTs) - z.enterTs),
    }));
    const segments = s.xpSegments.map((seg) => {
      const segEnd = seg.endTs ?? endTs;
      const segMs = Math.max(0, segEnd - seg.startTs);
      const rate = perHour(seg.percent, segMs);
      return {
        level: seg.level,
        anchored: seg.anchored,
        percent: seg.percent,
        solo: seg.solo,
        party: seg.party,
        ticks: seg.ticks,
        startTs: seg.startTs,
        endTs: seg.endTs,
        ms: segMs,
        percentPerHour: rate,
        /**
         * How long until the next level — offered under two conditions, both necessary.
         *
         * ANCHORED: the segment began with a level-up and therefore at a known 0%.
         * Without that we know how much was gained and not how far in we began, so there
         * is no honest "remaining" to compute.
         *
         * STILL OPEN (`endTs === null`): a segment that already ended did so BY levelling,
         * so a countdown to a level that has already happened is not a prediction, it is
         * a rounding artefact — the live log produces "0:01 to 12" on a level the player
         * finished half an hour ago.
         */
        timeToLevelMs: seg.anchored && seg.endTs === null && rate > 0 && seg.percent < 100
          ? ((100 - seg.percent) / rate) * HOUR_MS
          : null,
      };
    });

    return {
      v: SESSION_VERSION,
      id: `${s.startTs}`,
      character: s.character,
      server: s.server,
      startTs: s.startTs,
      endTs,
      durationMs,
      closeReason,
      events: s.eventCount,
      kills: {
        total: s.killsOurs,
        mine: s.killsMine,
        others: s.killsOthers,
        perHour: perHour(s.killsOurs, durationMs),
        byCreature: counted(s.byCreature),
        byKiller: counted(s.byKiller),
      },
      deaths: s.deaths.slice(),
      loot: {
        total: s.lootTotal,
        perHour: perHour(s.lootTotal, durationMs),
        items: counted(s.loot),
      },
      coin: {
        earned: { ...s.coinEarned },
        spent: { ...s.coinSpent },
        netCopper: s.coinEarned.copperTotal - s.coinSpent.copperTotal,
        copperPerHour: perHour(s.coinEarned.copperTotal, durationMs),
        bySource: [...s.coinBySource.entries()]
          .map(([source, purse]) => ({ source, ...purse }))
          .sort((a, b) => b.copperTotal - a.copperTotal),
        purchases: s.purchases.slice(),
      },
      xp: {
        segments,
        levelsGained: s.levelsGained,
        levelsLost: s.levelsLost,
        levelUps: s.levelUps.slice(),
        // No session-wide total, deliberately and permanently. See the header comment: if
        // this object ever grows one summed percentage, the honesty rule has been lost.
      },
      aa: {
        earned: s.aaEarned,
        spent: s.aaSpent,
        unspent: s.aaUnspent,
        perHour: perHour(s.aaEarned, durationMs),
        abilities: s.aaAbilities.slice(),
      },
      faction: [...s.factions.entries()]
        .map(([name, f]) => ({ name, ...f }))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name)),
      skills: {
        ups: [...s.skills.entries()]
          .map(([skill, k]) => ({ skill, ...k }))
          .sort((a, b) => b.ups - a.ups || a.skill.localeCompare(b.skill)),
        tradeskills: counted(s.tradeskills),
      },
      zones,
    };
  }
}

/** Map.set-and-return, so a default can be installed inline without a second lookup. */
function setDefault(map, key, value) {
  map.set(key, value);
  return value;
}
