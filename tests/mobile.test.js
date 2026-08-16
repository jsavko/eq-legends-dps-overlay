import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MobileServer, lanAddresses, generateToken } from '../src/main/mobile.js';

const TOKEN = 'cafe0123beef4567';

/** A throwaway renderer tree with just enough files to prove what static serving does. */
function makeStaticDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eqlmobile-'));
  fs.mkdirSync(path.join(dir, 'mobile'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mobile', 'index.html'), '<!doctype html><title>m</title>');
  fs.writeFileSync(path.join(dir, 'mobile', 'mobile.js'), 'export const x = 1;');
  // A file that must NEVER be reachable: right extension, wrong side of the root.
  fs.writeFileSync(path.join(dir, '..', path.basename(dir) + '-secret.js'), 'nope');
  return dir;
}

const FAKE_HISTORY = {
  characters: () => [{ key: 'Rhale_oggok', character: 'Rhale', server: 'oggok' }],
  list: (key) => (key === 'Rhale_oggok' ? [{ id: '1-2', label: 'froglok king' }] : []),
  get: (key, id) => (key === 'Rhale_oggok' && id === '1-2' ? { id, label: 'froglok king' } : null),
};

/** A live-fight snapshot in the shape buildSnapshot({timeline:true}) produces. */
function fakeSnapshot({ active = true, startTs = 1_000_000, buckets = 3, damage } = {}) {
  const series = damage ?? Array.from({ length: buckets }, (_, i) => (i + 1) * 10);
  return {
    active,
    startTs,
    label: 'froglok king',
    rows: [{
      name: 'Rhale',
      damage: series.reduce((a, v) => a + v, 0),
      timeline: { damage: series, healing: series.map(() => 0), taken: series.map(() => 0) },
    }],
    timeline: { bucketMs: 1000, originTs: startTs, buckets },
  };
}

async function startServer(opts = {}) {
  const staticDir = makeStaticDir();
  const server = new MobileServer({
    staticDir,
    token: TOKEN,
    history: FAKE_HISTORY,
    currentKey: () => 'Rhale_oggok',
    snapshot: () => null,
    ...opts,
  });
  const { port } = await server.start({ host: '127.0.0.1', port: 0 });
  return { server, port, base: `http://127.0.0.1:${port}` };
}

/**
 * A stateful SSE consumer: one reader for the response's whole life (a body reader
 * can only ever be acquired once), handed back frame by frame as tests ask for them.
 */
function sseReader(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // A read that loses its deadline race must be KEPT, not abandoned: it has already
  // claimed the next chunk off the stream, and starting a fresh read beside it would
  // silently discard whatever it eventually delivers.
  let pending = null;
  const TIMEOUT = Symbol('timeout');
  return {
    /** Up to `count` [{event, data}] frames, or fewer if the deadline passes first. */
    async next(count, deadlineMs = 3000) {
      const events = [];
      const deadline = Date.now() + deadlineMs;
      while (events.length < count && Date.now() < deadline) {
        pending ??= reader.read();
        let timer;
        const chunk = await Promise.race([
          pending,
          new Promise((r) => { timer = setTimeout(() => r(TIMEOUT), deadline - Date.now()); }),
        ]);
        clearTimeout(timer);
        if (chunk === TIMEOUT) break;
        pending = null;
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const piece = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = piece.match(/^event: (.+)$/m)?.[1];
          const data = piece.match(/^data: (.+)$/m)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      }
      return events;
    },
  };
}

test('every route requires the token, and the refusal is identical everywhere', async () => {
  const { server, base } = await startServer();
  try {
    for (const route of ['/', '/events', '/api/history', '/api/history/1-2', '/mobile/mobile.js']) {
      const bare = await fetch(`${base}${route}`);
      assert.equal(bare.status, 403, `${route} without a token`);
      const wrong = await fetch(`${base}${route}?t=deadbeef`);
      assert.equal(wrong.status, 403, `${route} with a wrong token`);
    }
  } finally {
    server.stop();
  }
});

test('serves the mobile page and its assets with the token', async () => {
  const { server, base } = await startServer();
  try {
    const page = await fetch(`${base}/?t=${TOKEN}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /<title>m<\/title>/);

    const mod = await fetch(`${base}/mobile/mobile.js?t=${TOKEN}`);
    assert.equal(mod.status, 200);
    assert.match(mod.headers.get('content-type'), /javascript/);
  } finally {
    server.stop();
  }
});

test('the page view sets a cookie that carries its sub-resources — browsers do not copy query strings onto asset requests', async () => {
  const { server, base } = await startServer();
  try {
    const page = await fetch(`${base}/?t=${TOKEN}`);
    const setCookie = page.headers.get('set-cookie');
    assert.match(setCookie, /eqlmobile=/);
    const cookie = setCookie.split(';')[0];

    // The stylesheet request a browser makes: no token in the URL, cookie attached.
    const asset = await fetch(`${base}/mobile/mobile.js`, { headers: { cookie } });
    assert.equal(asset.status, 200);

    // A wrong cookie is exactly a wrong token.
    const bad = await fetch(`${base}/mobile/mobile.js`, { headers: { cookie: 'eqlmobile=wrong' } });
    assert.equal(bad.status, 403);
  } finally {
    server.stop();
  }
});

test('path traversal and non-renderer file types both dead-end', async () => {
  const { server, base } = await startServer();
  try {
    const dirName = path.basename(server.staticDir);
    const escape = await fetch(`${base}/..%2F${dirName}-secret.js?t=${TOKEN}`);
    assert.equal(escape.status, 404);
    const wrongType = await fetch(`${base}/mobile/index.html.bak?t=${TOKEN}`);
    assert.equal(wrongType.status, 404);
  } finally {
    server.stop();
  }
});

test('history routes mirror the history window: list, record, missing record', async () => {
  const { server, base } = await startServer();
  try {
    const list = await (await fetch(`${base}/api/history?t=${TOKEN}`)).json();
    assert.equal(list.selected, 'Rhale_oggok');
    assert.equal(list.encounters.length, 1);
    assert.equal(list.characters[0].character, 'Rhale');

    const rec = await (await fetch(`${base}/api/history/1-2?t=${TOKEN}`)).json();
    assert.equal(rec.label, 'froglok king');

    const missing = await fetch(`${base}/api/history/9-9?t=${TOKEN}`);
    assert.equal(missing.status, 404);
  } finally {
    server.stop();
  }
});

test('SSE: greeting on connect, then only newly closed buckets per broadcast', async () => {
  const { server, base } = await startServer({
    snapshot: ({ timeline }) => (timeline ? fakeSnapshot({ buckets: 3 }) : null),
  });
  const abort = new AbortController();
  try {
    const res = await fetch(`${base}/events?t=${TOKEN}`, { signal: abort.signal });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const sse = sseReader(res);

    // The greeting: a lean snapshot (no timeline riding it) plus the full series so
    // far — buckets 0..1, because bucket 2 is the still-open second of a live fight.
    let events = await sse.next(2);
    assert.equal(events[0].event, 'snapshot');
    assert.equal(events[0].data.rows[0].timeline, undefined);
    assert.equal(events[0].data.timeline, undefined);
    assert.equal(events[1].event, 'timeline');
    assert.deepEqual(events[1].data.rows.Rhale.damage, [10, 20]);
    assert.equal(events[1].data.reset, true);
    assert.equal(events[1].data.from, 0);

    // The fight has grown to 5 buckets: only 2 and 3 travel (4 is still open).
    server.broadcast(fakeSnapshot({ buckets: 5 }));
    events = await sse.next(2);
    assert.equal(events[1].data.reset, false);
    assert.equal(events[1].data.from, 2);
    assert.equal(events[1].data.upTo, 4);
    assert.deepEqual(events[1].data.rows.Rhale.damage, [30, 40]);

    // Nothing new closed: the snapshot travels, the timeline stays quiet.
    server.broadcast(fakeSnapshot({ buckets: 5 }));
    events = await sse.next(2, 800);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'snapshot');

    // The fight closes: its final bucket is final now, and it ships.
    server.broadcast(fakeSnapshot({ buckets: 5, active: false }));
    events = await sse.next(2);
    assert.equal(events[1].event, 'timeline');
    assert.equal(events[1].data.from, 4);
    assert.equal(events[1].data.upTo, 5);
    assert.deepEqual(events[1].data.rows.Rhale.damage, [50]);
  } finally {
    abort.abort();
    server.stop();
  }
});

test('SSE: a new fight resets the cursor rather than continuing the old series', async () => {
  const { server, base } = await startServer({
    snapshot: () => fakeSnapshot({ startTs: 1_000_000, buckets: 3 }),
  });
  const abort = new AbortController();
  try {
    const res = await fetch(`${base}/events?t=${TOKEN}`, { signal: abort.signal });
    const sse = sseReader(res);
    await sse.next(2);

    server.broadcast(fakeSnapshot({ startTs: 2_000_000, buckets: 2 }));
    const events = await sse.next(2);
    assert.equal(events[1].data.reset, true);
    assert.equal(events[1].data.startTs, 2_000_000);
  } finally {
    abort.abort();
    server.stop();
  }
});

test('lanAddresses keeps external IPv4 and drops loopback and IPv6', () => {
  const addrs = lanAddresses({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [
      { address: '192.168.1.20', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
    wifi: [{ address: '10.0.0.5', family: 4, internal: false }],
  });
  assert.deepEqual(addrs, ['192.168.1.20', '10.0.0.5']);
});

test('generateToken is 16 hex chars and never repeats in a small sample', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const t = generateToken();
    assert.match(t, /^[0-9a-f]{16}$/);
    seen.add(t);
  }
  assert.equal(seen.size, 50);
});
