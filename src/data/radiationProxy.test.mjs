import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  CPM_PER_USVH,
  loadRadnetSites,
  mapWithConcurrency,
  parseRadnetCsv,
  parseRadnetTime,
  parseSafecast,
  radiationProxy,
} from '../../server/providers/radiation.js';

const NOW = Date.UTC(2026, 9, 16, 12);

const measurement = (over = {}) => ({
  id: 1,
  value: 33.4,
  unit: 'cpm',
  location_name: null,
  device_id: 279,
  captured_at: '2026-10-15T10:00:00.000Z',
  latitude: 51.108658,
  longitude: -0.218624,
  ...over,
});

const SAFECAST = [
  measurement(),
  measurement({ id: 2, value: 66.8, captured_at: '2026-10-15T11:00:00.000Z' }),
  measurement({
    id: 3,
    value: 0.12,
    unit: 'usv',
    device_id: 232,
    latitude: 53.85,
    longitude: 10.69,
  }),
  measurement({ id: 4, value: 5, unit: 'status', device_id: 900 }),
  measurement({
    id: 5,
    value: 20,
    device_id: null,
    latitude: 35.1234,
    longitude: 139.5,
    location_name: 'Roof <b>tokyo</b>',
  }),
  measurement({ id: 6, value: -3, device_id: 7 }),
  measurement({ id: 7, device_id: 8, latitude: 95 }),
  measurement({ id: 8, value: 9e9, device_id: 9 }),
  measurement({ id: 9, device_id: 10, captured_at: 'not a date' }),
];

const CSV_HEADER =
  'LOCATION_NAME,SAMPLE COLLECTION TIME,DOSE EQUIVALENT RATE (nSv/h),GAMMA COUNT RATE R02 (CPM),GAMMA COUNT RATE R03 (CPM),STATUS';
const csv = (...rows) => [CSV_HEADER, ...rows].join('\n');
const SITE = { state: 'CA', city: 'LOS ANGELES', lat: 34.05, lon: -118.24 };

function install(options = {}) {
  let handler;
  radiationProxy(options).configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/radiation');
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

const SITES = [
  { state: 'CA', city: 'LOS ANGELES', lat: 34.05, lon: -118.24 },
  { state: 'NY', city: 'NYC (EML)', lat: 40.71, lon: -74.0 },
  { state: 'MN', city: 'ST. PAUL', lat: 44.95, lon: -93.09 },
];

/** Stub: Safecast answers `safecast`, each RadNet site its own CSV or status. */
function fetcher({ safecast = SAFECAST, radnet = {}, calls = [] } = {}) {
  let active = 0;
  let peak = 0;
  const fn = async (url, options) => {
    const href = String(url);
    calls.push({ url: href, options });
    if (href.includes('api.safecast.org')) {
      if (typeof safecast === 'number')
        return new Response('x', { status: safecast });
      return Response.json(safecast);
    }
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    const city = decodeURIComponent(href.split('/').at(-1));
    const step = radnet[city];
    if (typeof step === 'number') return new Response('x', { status: step });
    if (step instanceof Error) throw step;
    return new Response(
      step ?? csv(`CA: ${city},10/16/2026 09:00:00,70.00,1,2,APPROVED`),
    );
  };
  fn.peak = () => peak;
  return fn;
}

test('safecast: cpm converted by 1/334, usv kept, latest reading per device, bad rows dropped', () => {
  const records = parseSafecast(SAFECAST);
  const byId = Object.fromEntries(records.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), [
    'safecast:d232',
    'safecast:d279',
    'safecast:p35.123,139.500',
  ]);
  assert.equal(
    byId['safecast:d279'].doseUsvh,
    Math.round((66.8 / CPM_PER_USVH) * 1e4) / 1e4,
  );
  assert.equal(byId['safecast:d279'].converted, true);
  assert.equal(byId['safecast:d279'].rawValue, 66.8);
  assert.equal(byId['safecast:d279'].time, '2026-10-15T11:00:00.000Z');
  assert.equal(byId['safecast:d232'].doseUsvh, 0.12);
  assert.equal(byId['safecast:d232'].converted, false);
  assert.equal(byId['safecast:p35.123,139.500'].name, 'Roof b tokyo /b');
  assert.throws(() => parseSafecast({}), /invalid_safecast/);
  assert.deepEqual(parseSafecast([]), []);
});

test('radnet time: MM/DD/YYYY HH:MM[:SS], assumed UTC', () => {
  assert.equal(
    parseRadnetTime('10/16/2026 20:51:00'),
    Date.UTC(2026, 9, 16, 20, 51),
  );
  assert.equal(parseRadnetTime('13/16/2026 20:51:00') > 0, true);
  assert.equal(parseRadnetTime('garbage'), null);
  assert.equal(parseRadnetTime(undefined), null);
});

test('radnet csv: latest valid row, nSv/h to µSv/h, rejected and bad rows skipped', () => {
  const record = parseRadnetCsv(
    csv(
      'CA: LOS ANGELES,10/14/2026 17:11:00,71.00,1,2,APPROVED',
      'CA: LOS ANGELES,10/16/2026 18:14:00,72.00,1,2,APPROVED',
      'CA: LOS ANGELES,10/16/2026 20:51:00,74.00,1,2,APPROVED',
      'CA: LOS ANGELES,10/16/2026 21:51:00,9999.00,1,2,REJECTED',
      'CA: LOS ANGELES,10/16/2026 22:51:00,,1,2,APPROVED',
      'CA: LOS ANGELES,not a time,80.00,1,2,APPROVED',
      'CA: LOS ANGELES,12/16/2030 22:51:00,80.00,1,2,APPROVED',
    ),
    SITE,
    NOW,
  );
  assert.equal(record.id, 'radnet:CA:LOS ANGELES');
  assert.equal(record.name, 'Los Angeles, CA');
  assert.equal(record.doseUsvh, 0.074);
  assert.equal(record.rawValue, 74);
  assert.equal(record.time, '2026-10-16T20:51:00.000Z');
  assert.equal(record.source, 'radnet');
  assert.equal(parseRadnetCsv(csv(), SITE, NOW), null);
  assert.throws(
    () => parseRadnetCsv('<html>nope</html>', SITE, NOW),
    /invalid_radnet_csv/,
  );
});

test('bundled site list loads and every site has coordinates', async () => {
  const sites = await loadRadnetSites();
  assert.ok(sites.length > 100);
  assert.ok(sites.every((s) => s.state && s.city && Math.abs(s.lat) <= 90));
  assert.ok(sites.some((s) => s.city === 'NYC (EML)'));
});

test('concurrency helper never exceeds its limit and keeps result order', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3 && peak > 1);
});

test('route: merges both sources, encodes city URLs, bounded concurrency, source counts', async () => {
  const calls = [];
  const fetchImpl = fetcher({ calls });
  const request = install({
    now: () => NOW,
    fetchImpl,
    loadSites: async () => SITES,
    concurrency: 2,
  });
  const res = await request();
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-Feed-Cache'], 'MISS');
  const body = JSON.parse(res.body);
  assert.equal(body.records.filter((r) => r.source === 'radnet').length, 3);
  assert.equal(body.records.filter((r) => r.source === 'safecast').length, 3);
  assert.deepEqual(body.sources.radnet, {
    ok: true,
    count: 3,
    sites: 3,
    failed: 0,
    empty: 0,
  });
  assert.equal(body.sources.safecast.ok, true);
  assert.equal(body.sources.safecast.pages, 1);
  assert.match(body.attribution, /not an official alert/);
  const urls = calls.map((c) => c.url);
  assert.ok(
    urls.includes(
      'https://radnet.epa.gov/cdx-radnet-rest/api/rest/csv/2026/fixed/NY/NYC%20(EML)',
    ),
  );
  assert.ok(urls.some((u) => u.endsWith('/fixed/MN/ST.%20PAUL')));
  const safecastCall = urls.find((u) => u.includes('api.safecast.org'));
  assert.match(safecastCall, /captured_after=2026-10-14&per_page=200&page=1/);
  assert.ok(fetchImpl.peak() <= 2);
  assert.match(calls[0].options.headers['User-Agent'], /^GodsEyeView\/0\.2/);
});

test('route: failed RadNet sites are skipped and counted, others still served', async () => {
  const request = install({
    now: () => NOW,
    fetchImpl: fetcher({
      radnet: {
        'NYC (EML)': 500,
        'ST. PAUL': csv(),
      },
    }),
    loadSites: async () => SITES,
  });
  const body = JSON.parse((await request()).body);
  assert.deepEqual(body.sources.radnet, {
    ok: true,
    count: 1,
    sites: 3,
    failed: 1,
    empty: 1,
  });
});

test('route: safecast paging stops at a short page; an ordering rejection falls back', async () => {
  const full = Array.from({ length: 200 }, (_, i) =>
    measurement({ id: i, device_id: 1000 + i, latitude: 10 + (i % 50) * 0.1 }),
  );
  const calls = [];
  const fetchImpl = async (url, options) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('api.safecast.org')) {
      if (href.includes('order=')) return new Response('bad', { status: 422 });
      const page = Number(/&page=(\d+)/.exec(href)[1]);
      return Response.json(page < 3 ? full : [measurement()]);
    }
    return new Response(csv('CA: X,10/16/2026 09:00:00,70.00,1,2,APPROVED'));
  };
  const request = install({
    now: () => NOW,
    fetchImpl,
    loadSites: async () => [SITES[0]],
  });
  const body = JSON.parse((await request()).body);
  assert.equal(body.sources.safecast.pages, 3);
  assert.equal(body.sources.safecast.count, 201);
  const safecast = calls.filter((u) => u.includes('api.safecast.org'));
  assert.equal(safecast.length, 4, 'one rejected ordered try plus three pages');
  assert.ok(safecast[0].includes('order=captured_at+desc'));
  assert.ok(safecast.slice(1).every((u) => !u.includes('order=')));
});

test('route: one source failing keeps its previous records; both failing is STALE then 502', async () => {
  let at = NOW;
  const plan = { safecast: SAFECAST };
  const radnetFail = { on: false };
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes('api.safecast.org')) {
      return typeof plan.safecast === 'number'
        ? new Response('x', { status: plan.safecast })
        : Response.json(plan.safecast);
    }
    return radnetFail.on
      ? new Response('x', { status: 503 })
      : new Response(csv('CA: X,10/16/2026 09:00:00,70.00,1,2,APPROVED'));
  };
  const request = install({
    now: () => at,
    ttlMs: 1_000,
    fetchImpl,
    loadSites: async () => [SITES[0]],
  });
  assert.equal(JSON.parse((await request()).body).records.length, 4);
  plan.safecast = 503;
  at += 2_000;
  const partial = JSON.parse((await request()).body);
  assert.equal(partial.sources.safecast.ok, false);
  assert.equal(partial.sources.safecast.stale, true);
  assert.equal(
    partial.records.filter((r) => r.source === 'safecast').length,
    3,
  );
  radnetFail.on = true;
  at += 2_000;
  const stale = await request();
  assert.equal(stale.headers['X-Feed-Cache'], 'STALE');
  assert.equal(JSON.parse(stale.body).stale, true);
});

test('route: nothing cached and everything failing is a 502; odd queries rejected', async () => {
  const request = install({
    now: () => NOW,
    fetchImpl: async () => new Response('x', { status: 500 }),
    loadSites: async () => SITES,
  });
  assert.equal((await request()).statusCode, 502);
  assert.equal((await request('/?x=1')).statusCode, 400);
  assert.equal((await request('/', 'POST')).statusCode, 405);
});
