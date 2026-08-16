/**
 * The second-screen server: a phone on the same LAN pointed at this becomes a live
 * meter and a history browser, with nothing installed and nothing leaving the machine.
 *
 * Built on Node's own `http` — no WebSocket dependency, deliberately. The phone is a
 * DISPLAY: data flows one way at the push loop's cadence, which is exactly what
 * Server-Sent Events are, and SSE reconnects by itself when the phone's screen sleeps
 * and wakes. The one runtime dependency this project allows (`electron-updater`)
 * stays the only one.
 *
 * Pure Node on the parser's construction rules: no Electron import anywhere, every
 * collaborator injected (the history store, the snapshot provider, the static root),
 * so the whole server starts on 127.0.0.1 under `node --test` in WSL and is exercised
 * with plain `fetch`.
 *
 * Security posture: everything — pages, stream, history — requires the pairing token,
 * which rides in the URL the QR code carries (`?t=...`). LAN-only by nature, but the
 * token means a port scan alone shows nothing; anyone WITH the full URL can watch
 * combat numbers, which is an acceptable stake for a DPS meter.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * The default port. Nothing common squats here (registered to nothing anyone runs at
 * home), and a stable default matters: the Windows Firewall allow-rule and the QR code
 * on the fridge both name it, and a port that wandered would invalidate both.
 */
export const DEFAULT_MOBILE_PORT = 8321;

/** A fresh pairing token: 16 hex chars, generated once and kept in config. */
export function generateToken() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * The machine's LAN IPv4 addresses — what a phone can actually reach. Interfaces are
 * injectable so the filter is testable without caring what hardware the test runs on.
 */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces)) {
    for (const iface of list ?? []) {
      if (iface.internal) continue;
      if (iface.family !== 'IPv4' && iface.family !== 4) continue;
      out.push(iface.address);
    }
  }
  return out;
}

/** What the static route will serve, and nothing else. */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** One SSE frame. Named events so the page can grow new kinds without re-parsing. */
function frame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Keep-alive comment cadence — routers drop silent connections well past this. */
const HEARTBEAT_MS = 25_000;

export class MobileServer {
  /**
   * @param {Object} opts
   * @param {string} opts.staticDir   the renderer root; the mobile page imports the
   *                                  shared pure modules (`history/timeline.js`,
   *                                  `overlay/breakdown.js`) by relative path, so the
   *                                  whole renderer tree is the unit that gets served
   * @param {string} opts.token       pairing token; every route requires it
   * @param {Object} opts.history     EncounterStore (characters/list/get)
   * @param {() => (string|null)} [opts.currentKey]  whose history to open by default
   * @param {(opts: {timeline: boolean}) => (Object|null)} [opts.snapshot]
   *        fresh snapshot on demand, for a client that connects during a lull — the
   *        push loop skips unchanged frames, so without this a phone opening the page
   *        between pulls would stare at nothing until the next damage line
   */
  constructor({ staticDir, token, history, currentKey = () => null, snapshot = () => null }) {
    if (!token) throw new Error('MobileServer requires a pairing token');
    this.staticDir = path.resolve(staticDir);
    this.token = token;
    this.history = history;
    this.currentKey = currentKey;
    this.snapshotProvider = snapshot;

    this.server = null;
    this.port = null;
    /** @type {Set<{res: import('node:http').ServerResponse, tlKey: string|null, tlSent: number}>} */
    this.clients = new Set();
    /** @type {Set<import('node:net').Socket>} */
    this.sockets = new Set();
    this.heartbeat = null;
  }

  get clientCount() {
    return this.clients.size;
  }

  /**
   * Start listening. `host` defaults to every interface because the phone is the
   * point; tests pass 127.0.0.1 so a suite run never trips a firewall prompt.
   */
  start({ host = '0.0.0.0', port = DEFAULT_MOBILE_PORT } = {}) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.route(req, res));
      // Sockets are tracked so stop() can be immediate: an SSE response never ends on
      // its own, and server.close() alone would wait on it forever.
      this.server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
      });
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.port = this.server.address().port;
        this.heartbeat = setInterval(() => {
          for (const c of this.clients) c.res.write(': hb\n\n');
        }, HEARTBEAT_MS);
        resolve({ port: this.port });
      });
    });
  }

  stop() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const c of this.clients) c.res.end();
    this.clients.clear();
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.server?.close();
    this.server = null;
    this.port = null;
  }

  /** Constant-time comparison — a check that leaks length or prefix would let the
   *  LAN brute the token a byte at a time. Hashing first makes the lengths equal by
   *  construction, which is what timingSafeEqual demands. */
  tokenMatches(presented) {
    const a = crypto.createHash('sha256').update(presented ?? '').digest();
    const b = crypto.createHash('sha256').update(this.token).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * The token authorizes a request from the URL (`?t=` — what the QR carries) or
   * from the cookie the first authorized page view sets. The cookie is the half
   * that makes static assets work at all: the page's stylesheet, its module imports
   * and the shared pure modules are requested by the BROWSER, which does not copy
   * query strings onto sub-resources — only cookies ride along by themselves.
   */
  authorized(url, req) {
    if (this.tokenMatches(url.searchParams.get('t'))) return true;
    const cookie = /(?:^|;\s*)eqlmobile=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
    return cookie !== undefined && this.tokenMatches(decodeURIComponent(cookie));
  }

  route(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      res.writeHead(400).end();
      return;
    }

    if (!this.authorized(url, req)) {
      // One flat answer for every unauthorized path: a scanner learns the port is
      // open and nothing else — not which routes exist, not what serves here.
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
      return;
    }

    // Re-stamped on every authorized request rather than only on '/': whichever URL
    // the phone arrived by, its next sub-resource request is covered. HttpOnly,
    // because no script ever needs to read it — the page already holds the token
    // from its own URL.
    res.setHeader('set-cookie',
      `eqlmobile=${encodeURIComponent(this.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);

    if (url.pathname === '/events') return this.serveEvents(res);
    if (url.pathname === '/api/history') return this.serveHistoryList(url, res);
    if (url.pathname.startsWith('/api/history/')) return this.serveHistoryRecord(url, res);
    return this.serveStatic(url.pathname, res);
  }

  serveEvents(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');

    const client = { res, tlKey: null, tlSent: 0 };
    this.clients.add(client);
    res.on('close', () => this.clients.delete(client));

    // The connection greeting: whatever is true right now, timeline and all. The push
    // loop only speaks when something changed, so a phone arriving mid-lull would
    // otherwise wait minutes for its first frame.
    const snap = this.snapshotProvider({ timeline: true });
    if (snap) this.send(client, snap, frame('snapshot', stripTimeline(snap)));
  }

  /**
   * Push one snapshot to every connected phone. Called from the main push loop with a
   * timeline-laden snapshot; each client gets the lean frame plus only the timeline
   * buckets it has not seen — never the full series at 4 Hz, which on a long fight
   * would be hundreds of KB a frame (the payload discipline the plan pins).
   */
  broadcast(snapshot) {
    if (this.clients.size === 0) return;
    const lean = frame('snapshot', stripTimeline(snapshot));
    for (const client of this.clients) this.send(client, snapshot, lean);
  }

  /** One client's frames for one snapshot: the lean push, then any timeline catch-up. */
  send(client, snapshot, leanFrame) {
    client.res.write(leanFrame);

    const tl = snapshot.timeline;
    if (!tl) {
      // No encounter to have a timeline (idle). Forget the cursor so the next fight
      // arrives as a reset rather than as a delta against a fight that is gone.
      client.tlKey = null;
      client.tlSent = 0;
      return;
    }

    // Only CLOSED buckets travel; the still-open second changes under the clock and
    // would have to be retransmitted every push. A closed fight has no open bucket,
    // so its final partial second ships the moment it closes.
    const upTo = snapshot.active ? Math.max(0, tl.buckets - 1) : tl.buckets;
    // The cursor is valid only against the same fight at the same resolution: a new
    // pull restarts the series, and a coarsening reindexes every bucket underneath it.
    const key = `${snapshot.startTs}:${tl.bucketMs}`;

    let from;
    if (client.tlKey !== key) {
      from = 0;
      client.tlKey = key;
    } else if (upTo > client.tlSent) {
      from = client.tlSent;
    } else {
      return;
    }

    const rows = {};
    for (const r of snapshot.rows) {
      if (!r.timeline) continue;
      rows[r.name] = {
        damage: r.timeline.damage.slice(from, upTo),
        healing: r.timeline.healing.slice(from, upTo),
        taken: r.timeline.taken.slice(from, upTo),
      };
    }
    client.res.write(frame('timeline', {
      reset: from === 0,
      startTs: snapshot.startTs,
      originTs: tl.originTs,
      bucketMs: tl.bucketMs,
      from,
      upTo,
      rows,
    }));
    client.tlSent = upTo;
  }

  /** Same answer HISTORY_LIST gives the history window, over HTTP. */
  serveHistoryList(url, res) {
    const current = this.currentKey();
    const characters = this.history.characters();
    const asked = url.searchParams.get('key');
    const selected = asked ??
      (characters.some((c) => c.key === current) ? current : characters[0]?.key);
    json(res, {
      characters,
      selected: selected ?? null,
      encounters: selected ? this.history.list(selected) : [],
    });
  }

  serveHistoryRecord(url, res) {
    const id = decodeURIComponent(url.pathname.slice('/api/history/'.length));
    const key = url.searchParams.get('key') ?? this.currentKey();
    const record = key ? this.history.get(key, id) : null;
    if (!record) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    json(res, record);
  }

  serveStatic(pathname, res) {
    const rel = pathname === '/' ? 'mobile/index.html' : decodeURIComponent(pathname.slice(1));
    const file = path.normalize(path.join(this.staticDir, rel));
    const type = CONTENT_TYPES[path.extname(file)];
    // Two gates: the resolved path must still be inside the renderer tree (`..` in a
    // URL must not walk to config.json), and only renderer file types are served at
    // all — this is a meter, not a file server.
    if (!file.startsWith(this.staticDir + path.sep) || !type) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': type }).end(data);
    });
  }
}

function json(res, payload) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    .end(JSON.stringify(payload));
}

/**
 * The snapshot without any timeline field, for the 4 Hz frame. The series travel in
 * their own event with their own cursor; re-sending them inside every snapshot would
 * defeat that entirely.
 */
function stripTimeline(snapshot) {
  if (!snapshot.timeline) return snapshot;
  const { timeline, rows, ...rest } = snapshot;
  return {
    ...rest,
    rows: rows.map(({ timeline: _tl, ...row }) => row),
  };
}
