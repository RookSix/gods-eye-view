import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  aircraftEmergenciesProxy,
  parseSquawkResponse,
} from '../../server/providers/aircraftEmergencies.js';
import { adsbLolCooldownMs } from '../../server/providers/aircraft/adsb-lol.js';

const ac = (extra = {}) => ({
  hex: '4d225c',
  type: 'adsb_icao',
  flight: 'RYR6789 ',
  r: '9H-QDD',
  t: 'B738',
  alt_baro: 2525,
  gs: 165.7,
  track: 42.06,
  squawk: '7700',
  emergency: 'general',
  lat: 45.395233,
  lon: 12.211173,
  seen_pos: 0.311,
  ...extra,
});
const response = (rows) => ({ ac: rows, msg: 'No error', total: rows.length });

function install(options = {}) {
  let handler;
  aircraftEmergenciesProxy(options).configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/aircraft-emergencies');
        handler = callback;
      },
    },
  });
  return async (url = '/', method = 'GET') => {
    const res = new EventEmitter();
    res.writeHead = (code, headers) => {
      res.statusCode = code;
      res.headers = headers;
    };
    res.end = (text) => {
      res.body = text;
    };
    await handler({ url, method }, res);
    return res;
  };
}

/** Stub keyed by squawk; records call order and any overlapping requests. */
function fetcher(plan, calls = []) {
  let active = 0;
  return async (url, options) => {
    const squawk = String(url).split('/').pop();
    calls.push({ squawk, url: String(url), options, overlapped: active > 0 });
    active++;
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const step = plan[squawk];
      const value = typeof step === 'function' ? step() : step;
      if (value instanceof Error) throw value;
      if (value instanceof Response) return value;
      return Response.json(value);
    } finally {
      active--;
    }
  };
}

test('parser keeps only positioned aircraft squawking the queried code', () => {
  const rows = parseSquawkResponse(
    response([
      ac(),
      ac({ hex: 'aaaaaa', squawk: '7600' }),
      ac({ hex: 'bbbbbb', lat: undefined }),
      ac({ hex: 'cccccc', seen_pos: 900 }),
      ac({ hex: 'zzzz' }),
      ac({ hex: 'dddddd', alt_baro: 'ground', track: -90 }),
    ]),
    '7700',
  );
  assert.deepEqual(
    rows.map((r) => r.hex),
    ['4d225c', 'dddddd'],
  );
  const [air, ground] = rows;
  assert.equal(air.callsign, 'RYR6789');
  assert.equal(air.registration, '9H-QDD');
  assert.equal(air.meaning, 'GENERAL EMERGENCY');
  assert.equal(air.altitudeFt, 2525);
  assert.equal(air.emergencyStatus, 'GENERAL');
  assert.equal(ground.onGround, true);
  assert.equal(ground.altitudeFt, null);
  assert.equal(ground.trackDeg, 270, 'tracks normalise to [0, 360)');
  assert.throws(() => parseSquawkResponse({}, '7700'), /invalid_adsb/);
});

test('queries the three exact-squawk routes one after another', async () => {
  const calls = [];
  const request = install({
    fetchImpl: fetcher(
      { 7500: response([]), 7600: response([]), 7700: response([ac()]) },
      calls,
    ),
  });
  const res = await request();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      'https://api.adsb.lol/v2/sqk/7500',
      'https://api.adsb.lol/v2/sqk/7600',
      'https://api.adsb.lol/v2/sqk/7700',
    ],
  );
  assert.ok(
    calls.every((c) => !c.overlapped),
    'never a parallel burst',
  );
  assert.match(calls[0].options.headers['User-Agent'], /^GodsEyeView\/0\.2/);
  const body = JSON.parse(res.body);
  assert.equal(body.records.length, 1);
  assert.equal(body.caveat, 'A squawk is not a confirmed incident.');
  assert.deepEqual(Object.keys(body.sources), ['7500', '7600', '7700']);
});

test('caches for the 30 s TTL, then refreshes', async () => {
  let at = 0;
  const calls = [];
  const request = install({
    now: () => at,
    fetchImpl: fetcher(
      { 7500: response([]), 7600: response([]), 7700: response([ac()]) },
      calls,
    ),
  });
  await request();
  at += 29_000;
  assert.equal((await request()).headers['X-Feed-Cache'], 'HIT');
  assert.equal(calls.length, 3);
  at += 2_000;
  assert.equal((await request()).headers['X-Feed-Cache'], 'MISS');
  assert.equal(calls.length, 6);
});

test('a 429 stops the remaining queries, honours Retry-After and serves STALE', async () => {
  let at = 0;
  const calls = [];
  const plan = {
    7500: response([]),
    7600: response([]),
    7700: response([ac()]),
  };
  const request = install({ now: () => at, fetchImpl: fetcher(plan, calls) });
  await request();
  plan[7500] = response([]);
  plan[7600] = new Response('slow down', {
    status: 429,
    headers: { 'Retry-After': '60' },
  });
  at += 31_000;
  const res = await request();
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.sources[7600].ok, false);
  assert.equal(body.sources[7700].skipped, 'rate limited');
  assert.equal(body.sources[7700].stale, true);
  assert.equal(body.records.length, 1, 'the earlier 7700 sighting is kept');
  const attempted = calls.length;
  assert.equal(attempted, 5, 'the 7700 query was not sent');
  at += 31_000;
  const during = await request();
  assert.equal(during.headers['X-Feed-Cache'], 'STALE');
  assert.equal(
    calls.length,
    attempted,
    'no upstream traffic while cooling down',
  );
  at += 31_000;
  plan[7600] = response([]);
  assert.equal((await request()).headers['X-Feed-Cache'], 'MISS');
});

test('total failure with nothing cached is a 502; query and method are validated', async () => {
  const calls = [];
  const request = install({
    fetchImpl: fetcher(
      {
        7500: new Response('x', { status: 503 }),
        7600: response([]),
        7700: response([]),
      },
      calls,
    ),
  });
  assert.equal((await request('/?squawk=1200')).statusCode, 400);
  assert.equal((await request('/', 'DELETE')).statusCode, 405);
  assert.equal(calls.length, 0);
  const res = await request();
  assert.equal(res.statusCode, 502);
  assert.equal(calls.length, 1, 'a 5xx on the first query ends the burst');
});

test('shared cooldown helper clamps Retry-After and defaults by status', () => {
  const upstream = (status, retry) => ({
    status,
    headers: { get: () => retry ?? null },
  });
  assert.equal(adsbLolCooldownMs(upstream(429, '60'), 0), 60_000);
  assert.equal(adsbLolCooldownMs(upstream(429, '1'), 0), 5_000);
  assert.equal(adsbLolCooldownMs(upstream(429, '9999'), 0), 120_000);
  assert.equal(adsbLolCooldownMs(upstream(429), 0), 30_000);
  assert.equal(adsbLolCooldownMs(upstream(503), 0), 15_000);
});
