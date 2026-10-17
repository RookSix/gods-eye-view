import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  gpsJammingProxy,
  parseGpsJamDay,
  pickManifestDate,
} from '../../server/providers/gpsJamming.js';

const MANIFEST = [
  'date,suspect,num_bad_aircraft_hexes,source',
  '2026-10-13,false,500,merged',
  '2026-10-15,false,517,merged',
  '2026-10-16,true,653,merged',
  '2022-02-14,true,89,adsbexchange',
].join('\n');
const DAY = [
  'hex,count_good_aircraft,count_bad_aircraft',
  '8401261ffffffff,2,1', // 3 aircraft, 33%: high
  '840135dffffffff,10,5', // 15 aircraft, 33%: high
  '8401355ffffffff,98,2', // 100 aircraft, 2%: not above the floor
  '8401351ffffffff,45,5', // 50 aircraft, 10%: medium (not over 10%)
  '8403257ffffffff,0,1', // 1 aircraft: too few
  '840324dffffffff,1,1', // 2 aircraft: too few
  '8403259ffffffff,0,0',
  'not-a-hex,5,5',
  '84032ffffffffff,x,5',
  '',
].join('\n');

function install(options = {}) {
  let handler;
  gpsJammingProxy({ diskCache: null, ...options }).configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/gps-jamming');
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

function fetcher(plan, calls = []) {
  return async (url, options) => {
    calls.push({ url: String(url), options });
    const step = plan[String(url)];
    const value = typeof step === 'function' ? step() : step;
    if (value instanceof Error) throw value;
    if (typeof value === 'number') return new Response('x', { status: value });
    return new Response(value, { headers: { 'Content-Type': 'text/csv' } });
  };
}
const MANIFEST_URL = 'https://gpsjam.org/data/manifest.csv';
const dayUrl = (date) => `https://gpsjam.org/data/${date}-h3_4.csv`;

test('manifest: newest non-suspect day, else the newest day', () => {
  assert.deepEqual(pickManifestDate(MANIFEST), {
    date: '2026-10-15',
    suspect: false,
  });
  assert.deepEqual(
    pickManifestDate(
      'date,suspect,num_bad_aircraft_hexes,source\n2026-01-01,true,1,x\n2026-01-02,true,1,x',
    ),
    { date: '2026-01-02', suspect: true },
  );
  assert.throws(() => pickManifestDate('date,suspect\nnonsense'), /manifest/);
});

test('day file: ratio bands, aircraft floor and malformed rows', () => {
  const { cells, total } = parseGpsJamDay(DAY);
  assert.equal(total, 7, 'well-formed rows count towards the day total');
  assert.deepEqual(
    cells.map((c) => [c.hex, c.level]),
    [
      ['840135dffffffff', 'high'], // equal ratio: more bad aircraft first
      ['8401261ffffffff', 'high'],
      ['8401351ffffffff', 'medium'],
    ],
  );
  assert.deepEqual(cells[1], {
    hex: '8401261ffffffff',
    ratio: 0.333,
    level: 'high',
    good: 2,
    bad: 1,
  });
  assert.throws(
    () => parseGpsJamDay('<html>nope</html>'),
    /invalid_gpsjam_day/,
  );
  assert.throws(
    () => parseGpsJamDay('hex,count_good_aircraft,count_bad_aircraft\n'),
    /invalid_gpsjam_day/,
  );
});

test('serves compact records, caches for six hours and reuses the day file', async () => {
  let at = 0;
  const calls = [];
  const request = install({
    now: () => at,
    fetchImpl: fetcher(
      { [MANIFEST_URL]: MANIFEST, [dayUrl('2026-10-15')]: DAY },
      calls,
    ),
  });
  const res = await request();
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.date, '2026-10-15');
  assert.equal(body.suspect, false);
  assert.equal(body.resolution, 4);
  assert.equal(body.records.length, 3);
  assert.equal(
    body.attribution,
    'gpsjam.org (data from ADS-B Exchange / adsb.lol etc.)',
  );
  assert.deepEqual(
    calls.map((c) => c.url),
    [MANIFEST_URL, dayUrl('2026-10-15')],
  );
  at += 6 * 3600_000 - 1;
  assert.equal((await request()).headers['X-Feed-Cache'], 'HIT');
  assert.equal(calls.length, 2);
  at += 2;
  assert.equal((await request()).headers['X-Feed-Cache'], 'MISS');
  assert.equal(calls.length, 4);
});

test('upstream failure serves the previous day as STALE with a long backoff', async () => {
  let at = 0;
  const calls = [];
  const plan = { [MANIFEST_URL]: MANIFEST, [dayUrl('2026-10-15')]: DAY };
  const request = install({ now: () => at, fetchImpl: fetcher(plan, calls) });
  await request();
  plan[MANIFEST_URL] = 503;
  at += 7 * 3600_000;
  const stale = await request();
  assert.equal(stale.headers['X-Feed-Cache'], 'STALE');
  assert.equal(JSON.parse(stale.body).stale, true);
  const attempted = calls.length;
  at += 60_000;
  await request();
  assert.equal(calls.length, attempted, 'no retry inside the cooldown');
});

test('a missing day file is an error, not an empty map; query and method validated', async () => {
  const request = install({
    fetchImpl: fetcher({
      [MANIFEST_URL]: MANIFEST,
      [dayUrl('2026-10-15')]: 404,
    }),
  });
  assert.equal((await request('/?date=2026-10-01')).statusCode, 400);
  assert.equal((await request('/', 'PUT')).statusCode, 405);
  assert.equal((await request()).statusCode, 502);
});

test('disk cache short-circuits upstream while fresh and is written after a fetch', async () => {
  let at = 10_000;
  const saved = [];
  const value = { source: 'gpsjam.org', date: '2026-10-14', records: [] };
  const calls = [];
  const fresh = install({
    now: () => at,
    fetchImpl: fetcher({}, calls),
    diskCache: {
      read: async () => ({ at: at - 1_000, value }),
      write: async (entry) => saved.push(entry),
    },
  });
  const res = await fresh();
  assert.equal(JSON.parse(res.body).date, '2026-10-14');
  assert.equal(calls.length, 0);
  assert.equal(saved.length, 0);

  const cold = install({
    now: () => at,
    fetchImpl: fetcher(
      { [MANIFEST_URL]: MANIFEST, [dayUrl('2026-10-15')]: DAY },
      calls,
    ),
    diskCache: {
      read: async () => ({ at: at - 7 * 3600_000, value }),
      write: async (entry) => saved.push(entry),
    },
  });
  assert.equal(JSON.parse((await cold()).body).date, '2026-10-15');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].value.records.length, 3);
});
