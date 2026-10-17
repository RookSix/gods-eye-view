import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  naturalEventsProxy,
  parseEonet,
  parseGdacs,
  polygonCentroid,
} from '../../server/providers/naturalEvents.js';

const gdacsFeature = (type, id, extra = {}, coordinates = [10, 20]) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties: {
    eventtype: type,
    eventid: id,
    name: `${type} event ${id}`,
    alertlevel: 'Orange',
    country: 'Fijiland',
    fromdate: '2026-10-16T04:19:05',
    todate: '2026-10-17T04:19:05',
    severitydata: {
      severity: 4.8,
      severitytext: 'Magnitude 4.8M, Depth:439km',
      severityunit: 'M',
    },
    url: {
      report: `https://www.gdacs.org/report.aspx?eventid=${id}&eventtype=${type}`,
      details: 'https://evil.example/details',
    },
    ...extra,
  },
});
const GDACS = {
  type: 'FeatureCollection',
  features: [
    gdacsFeature('EQ', 1),
    gdacsFeature('TC', 2),
    gdacsFeature('FL', 3, { url: { report: 'https://evil.example/x' } }),
    gdacsFeature('TC', 2),
    gdacsFeature('VO', 4, {}, [999, 20]),
    { type: 'Feature', geometry: { type: 'Polygon' }, properties: {} },
  ],
};
const EONET = {
  events: [
    {
      id: 'EONET_1',
      title: 'Typhoon <b>Champi</b>',
      link: 'https://eonet.gsfc.nasa.gov/api/v3/events/EONET_1',
      closed: null,
      categories: [{ id: 'severeStorms', title: 'Severe Storms' }],
      sources: [{ id: 'JTWC', url: 'http://insecure.example/a' }],
      geometry: [
        {
          date: '2026-10-15T12:00:00Z',
          type: 'Point',
          coordinates: [157.4, 11],
          magnitudeValue: 35,
          magnitudeUnit: 'kts',
        },
        {
          date: '2026-10-16T12:00:00Z',
          type: 'Point',
          coordinates: [156.1, 12.5],
          magnitudeValue: 45,
          magnitudeUnit: 'kts',
        },
      ],
    },
    {
      id: 'EONET_2',
      title: 'Wildfire block',
      categories: [{ id: 'wildfires', title: 'Wildfires' }],
      sources: [{ id: 'IRWIN', url: 'https://example.gov/fire' }],
      geometry: [
        {
          date: '2026-10-16T00:00:00Z',
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [4, 0],
              [4, 4],
              [0, 4],
              [0, 0],
            ],
          ],
        },
      ],
    },
    {
      id: 'EONET_3',
      title: 'Quake',
      categories: [{ id: 'earthquakes', title: 'Earthquakes' }],
      geometry: [
        { date: '2026-10-16T00:00:00Z', type: 'Point', coordinates: [1, 1] },
      ],
    },
    { id: 'EONET_4', title: 'No geometry', categories: [], geometry: [] },
  ],
};

function install(options = {}, preview = false) {
  let handler;
  const plugin = naturalEventsProxy(options);
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/natural-events');
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

/** Per-source fetch stub: each entry is a payload, a status number, or a throw. */
function fetcher(plan, calls = []) {
  return async (url, options) => {
    const key = String(url).includes('gdacs') ? 'gdacs' : 'eonet';
    calls.push({ key, url: String(url), options });
    const step = plan[key];
    const value = typeof step === 'function' ? step() : step;
    if (value instanceof Error) throw value;
    if (typeof value === 'number') return new Response('x', { status: value });
    return Response.json(value);
  };
}

test('GDACS: earthquakes dropped, UTC times, https report links only, bad rows skipped', () => {
  const records = parseGdacs(GDACS);
  assert.deepEqual(
    records.map((r) => r.id),
    ['gdacs:TC:2', 'gdacs:FL:3'],
  );
  const [cyclone, flood] = records;
  assert.equal(cyclone.kind, 'storm');
  assert.equal(cyclone.alert, 'orange');
  assert.equal(cyclone.time, '2026-10-16T04:19:05.000Z');
  assert.equal(cyclone.country, 'Fijiland');
  assert.match(cyclone.url, /^https:\/\/www\.gdacs\.org\/report\.aspx/);
  assert.equal(cyclone.severity, 'Magnitude 4.8M, Depth:439km');
  assert.equal(flood.url, null, 'foreign origins are not linked');
  assert.throws(() => parseGdacs({}), /invalid_gdacs/);
});

test('EONET: latest geometry wins, polygons use their centroid, quakes dropped, text sanitised', () => {
  const records = parseEonet(EONET);
  assert.deepEqual(
    records.map((r) => r.id),
    ['eonet:EONET_1', 'eonet:EONET_2'],
  );
  const [storm, fire] = records;
  assert.deepEqual([storm.lon, storm.lat], [156.1, 12.5]);
  assert.deepEqual(storm.magnitude, { value: 45, unit: 'kts' });
  assert.equal(storm.title, 'Typhoon b Champi /b', 'markup characters dropped');
  assert.equal(
    storm.url,
    'https://eonet.gsfc.nasa.gov/api/v3/events/EONET_1',
    'a non-https source link falls back to the EONET event link',
  );
  assert.equal(storm.kind, 'storm');
  assert.equal(fire.kind, 'wildfire');
  assert.deepEqual([fire.lon, fire.lat], [2, 2]);
  assert.equal(fire.url, 'https://example.gov/fire');
  assert.throws(() => parseEonet({ events: 'x' }), /invalid_eonet/);
});

test('polygon centroid unwraps the antimeridian and rejects degenerate rings', () => {
  const centroid = polygonCentroid([
    [
      [179, 10],
      [-179, 10],
      [-179, 12],
      [179, 12],
      [179, 10],
    ],
  ]);
  assert.ok(Math.abs(Math.abs(centroid.lon) - 180) < 1e-9);
  assert.equal(centroid.lat, 11);
  assert.equal(polygonCentroid([[[0, 0]]]), null);
  assert.equal(polygonCentroid([]), null);
});

test('serves a MISS then a HIT inside the TTL and refreshes after it', async () => {
  let at = 1_000_000;
  const calls = [];
  const request = install({
    now: () => at,
    ttlMs: 600_000,
    fetchImpl: fetcher({ gdacs: GDACS, eonet: EONET }, calls),
  });
  const first = await request();
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['X-Feed-Cache'], 'MISS');
  const body = JSON.parse(first.body);
  assert.equal(body.stale, false);
  assert.deepEqual(body.sources, {
    gdacs: { ok: true, count: 2 },
    eonet: { ok: true, count: 2 },
  });
  assert.equal(body.records.length, 4);
  assert.equal(calls.length, 2);
  assert.match(calls[0].options.headers['User-Agent'], /^GodsEyeView\/0\.2/);
  assert.equal(calls[0].options.redirect, 'error');
  at += 599_000;
  assert.equal((await request()).headers['X-Feed-Cache'], 'HIT');
  assert.equal(calls.length, 2);
  at += 2_000;
  assert.equal((await request()).headers['X-Feed-Cache'], 'MISS');
  assert.equal(calls.length, 4);
});

test('concurrent requests share one upstream refresh', async () => {
  const calls = [];
  const request = install({
    fetchImpl: fetcher({ gdacs: GDACS, eonet: EONET }, calls),
  });
  await Promise.all([request(), request(), request()]);
  assert.equal(calls.length, 2);
});

test('each source fails independently and keeps its last good records', async () => {
  let at = 0;
  const plan = { gdacs: 500, eonet: EONET };
  const request = install({
    now: () => at,
    ttlMs: 1_000,
    fetchImpl: fetcher(plan),
  });
  const partial = JSON.parse((await request()).body);
  assert.equal(partial.sources.gdacs.ok, false);
  assert.equal(partial.sources.gdacs.stale, false);
  assert.equal(partial.sources.eonet.ok, true);
  assert.deepEqual(
    partial.records.map((r) => r.source),
    ['eonet', 'eonet'],
  );
  plan.gdacs = GDACS;
  at += 2_000;
  assert.equal(JSON.parse((await request()).body).records.length, 4);
  plan.gdacs = new Error('network down');
  at += 2_000;
  const kept = JSON.parse((await request()).body);
  assert.equal(kept.sources.gdacs.ok, false);
  assert.equal(kept.sources.gdacs.stale, true);
  assert.equal(kept.records.filter((r) => r.source === 'gdacs').length, 2);
});

test('total failure serves the last good body as STALE and backs off', async () => {
  let at = 0;
  const calls = [];
  const plan = { gdacs: GDACS, eonet: EONET };
  const request = install({
    now: () => at,
    ttlMs: 1_000,
    fetchImpl: fetcher(plan, calls),
  });
  await request();
  plan.gdacs = 503;
  plan.eonet = new Error('timeout');
  at += 5_000;
  const stale = await request();
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.headers['X-Feed-Cache'], 'STALE');
  const body = JSON.parse(stale.body);
  assert.equal(body.stale, true);
  assert.equal(body.records.length, 4);
  const attempted = calls.length;
  at += 1_000;
  assert.equal((await request()).headers['X-Feed-Cache'], 'STALE');
  assert.equal(calls.length, attempted, 'cooldown: no upstream hammering');
});

test('with nothing cached a total failure is a 502, never an empty snapshot', async () => {
  const request = install({
    fetchImpl: fetcher({ gdacs: 500, eonet: 500 }),
  });
  const res = await request();
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'natural-events_unavailable',
  });
});

test('query strings and non-GET methods are rejected before any fetch', async () => {
  const calls = [];
  const request = install({
    fetchImpl: fetcher({ gdacs: GDACS, eonet: EONET }, calls),
  });
  assert.equal((await request('/?url=http://evil.example')).statusCode, 400);
  assert.equal((await request('/x')).statusCode, 400);
  assert.equal((await request('/', 'POST')).statusCode, 405);
  assert.equal(calls.length, 0);
});

test('server hooks return nothing: Vite would run a returned function as a post hook', () => {
  const plugin = naturalEventsProxy();
  const server = { middlewares: { use: () => () => {} } };
  assert.equal(plugin.configureServer(server), undefined);
  assert.equal(plugin.configurePreviewServer(server), undefined);
});

test('preview registration serves the same route', async () => {
  const request = install(
    { fetchImpl: fetcher({ gdacs: GDACS, eonet: EONET }) },
    true,
  );
  assert.equal((await request()).statusCode, 200);
});
