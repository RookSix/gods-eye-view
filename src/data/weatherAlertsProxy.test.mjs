import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  MAX_TOTAL_VERTICES,
  WMO_CAP_FETCH_PER_REFRESH,
  ecccNextUrl,
  ecccSeverity,
  fitBudget,
  parseCapShape,
  parseEccc,
  parseNws,
  ringCentroid,
  shapeFromGeometry,
  simplifyRing,
  weatherAlertsProxy,
  wmoCandidates,
} from '../../server/providers/weatherAlerts.js';

const square = (lon, lat, size = 2) => [
  [lon, lat],
  [lon + size, lat],
  [lon + size, lat + size],
  [lon, lat + size],
  [lon, lat],
];
/** A circle-ish ring with many vertices, to exercise simplification. */
const dense = (lon, lat, radius, n) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = ((i % n) / n) * 2 * Math.PI;
    return [lon + radius * Math.cos(a), lat + radius * Math.sin(a)];
  });

const nwsFeature = (id, severity, geometry, extra = {}) => ({
  id: `https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.${id}`,
  type: 'Feature',
  geometry,
  properties: {
    '@id': `https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.${id}`,
    id: `urn:oid:2.49.0.1.840.0.${id}`,
    event: 'Tornado Warning',
    severity,
    urgency: 'Immediate',
    certainty: 'Observed',
    headline: 'Tornado Warning issued October 17 by NWS Norman OK',
    areaDesc: 'Cleveland; Oklahoma',
    onset: '2026-10-17T00:49:00-04:00',
    expires: '2026-10-17T04:00:00-04:00',
    ends: '2026-10-17T05:00:00-04:00',
    senderName: 'NWS Norman OK',
    sender: 'w-nws.webmaster@noaa.gov',
    ...extra,
  },
});
const NWS = {
  type: 'FeatureCollection',
  features: [
    nwsFeature('a1', 'Severe', {
      type: 'Polygon',
      coordinates: [square(-97, 35)],
    }),
    nwsFeature('a2', 'Extreme', {
      type: 'MultiPolygon',
      coordinates: [[square(-100, 30, 1)], [square(-90, 30, 4)]],
    }),
    nwsFeature('a3', 'Moderate', null, { event: 'Zone only' }),
    nwsFeature('a4', 'Minor', {
      type: 'Polygon',
      coordinates: [square(-80, 30)],
    }),
    nwsFeature('a1', 'Severe', {
      type: 'Polygon',
      coordinates: [square(-97, 35)],
    }),
    nwsFeature('a5', 'Severe', { type: 'Point', coordinates: [1, 1] }),
  ],
};

const ecccFeature = (
  id,
  props,
  geometry = { type: 'Polygon', coordinates: [square(-60, 53)] },
) => ({
  id,
  type: 'Feature',
  geometry,
  properties: {
    alert_type: 'warning',
    risk_colour_en: 'orange',
    alert_name_en: 'snowfall warning',
    alert_text_en: 'Heavy snow expected.',
    feature_name_en: 'Cartwright to Black Tickle',
    province: 'NL',
    status_en: 'continued',
    validity_datetime: '2026-10-17T09:00:00.000Z',
    event_end_datetime: '2026-10-17T21:00:00.000Z',
    ...props,
  },
});
const ECCC_PAGE1 = {
  features: [
    ecccFeature('e1', {}),
    ecccFeature('e2', {
      risk_colour_en: 'red',
      alert_name_en: 'blizzard warning',
    }),
    ecccFeature('e3', { alert_type: 'advisory', risk_colour_en: 'yellow' }),
    ecccFeature('e4', { status_en: 'ended' }),
    ecccFeature('e5', {}, null),
    ecccFeature('e1', {}),
  ],
  links: [
    { rel: 'self', href: 'https://api.weather.gc.ca/x' },
    {
      rel: 'next',
      href: 'https://api.weather.gc.ca/collections/weather-alerts/items?offset=500',
    },
  ],
};
const ECCC_PAGE2 = {
  features: [ecccFeature('e6', { alert_type: 'watch', risk_colour_en: null })],
  links: [{ rel: 'next', href: 'https://evil.example/items?offset=1000' }],
};

const wmoItem = (id, path, s, extra = {}) => ({
  id,
  event: 'Heavy Rain',
  headline: `Heavy rain ${id}`,
  sent: '2026-10-17 04:41:00',
  effective: '2026-10-17 04:54:00',
  expires: '2026-10-17 06:54:00',
  areaDesc: 'Gorontalo',
  mid: '043',
  s,
  capURL: path,
  ...extra,
});
const WMO = {
  items: [
    wmoItem('w1', 'id-inatews-id/2026/10/17/04/41/00-aaa.xml', 3),
    wmoItem('w2', 'us-noaa-nws-en/2026/10/17/04/44/00-bbb.xml', 3),
    wmoItem('w3', 'ca-msc-xx/2026/10/17/04/44/00-ccc.xml', 4),
    wmoItem('w4', 'in-imd-en/2026/10/17/04/00/00-ddd.xml', 1),
    wmoItem('w5', 'jp-jma-en/../../etc/passwd', 4),
    wmoItem('w6', 'cn-cma-xx/2026/10/17/04/38/33-eee.xml', 2, {
      capURL: undefined,
      url: 'cn-cma-xx/2026/10/17/04/38/33-eee.xml',
    }),
    wmoItem('w7', 'au-bom-en/2026/10/17/03/00/00-fff.xml', 4),
  ],
};
const CAP_POLYGON =
  '<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><info><area><polygon>0.5,123.0 0.5,123.5 1.0,123.5 1.0,123.0 0.5,123.0</polygon></area></info></alert>';
const CAP_CIRCLE =
  '<alert><info><area><circle>-10.5,120.25 50</circle></area></info></alert>';
const CAP_TEXT_ONLY =
  '<alert><info><area><areaDesc>Somewhere</areaDesc></area></info></alert>';

function install(options = {}, preview = false) {
  let handler;
  const plugin = weatherAlertsProxy(options);
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/weather-alerts');
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

/** Fetch stub routed by URL; a plan value is a payload, text, a status or an Error. */
function fetcher(plan, calls = []) {
  return async (url, options) => {
    const href = String(url);
    calls.push({ url: href, options });
    let key;
    if (href.includes('api.weather.gov')) key = 'nws';
    else if (href.includes('offset=500')) key = 'eccc2';
    else if (href.includes('api.weather.gc.ca')) key = 'eccc';
    else if (href.includes('wmo_all')) key = 'wmo';
    else
      key = `cap:${href.replace('https://severeweather.wmo.int/v2/cap-alerts/', '')}`;
    const step = plan[key];
    const value = typeof step === 'function' ? step() : step;
    if (value instanceof Error) throw value;
    if (typeof value === 'number') return new Response('x', { status: value });
    if (typeof value === 'string') return new Response(value);
    if (value === undefined) return new Response('x', { status: 404 });
    return Response.json(value);
  };
}
const fullPlan = () => ({
  nws: NWS,
  eccc: ECCC_PAGE1,
  eccc2: ECCC_PAGE2,
  wmo: WMO,
  'cap:id-inatews-id/2026/10/17/04/41/00-aaa.xml': CAP_POLYGON,
  'cap:cn-cma-xx/2026/10/17/04/38/33-eee.xml': CAP_CIRCLE,
  'cap:au-bom-en/2026/10/17/03/00/00-fff.xml': CAP_TEXT_ONLY,
});

test('ring simplification keeps outlines closed-free, bounded and rounded', () => {
  const ring = simplifyRing(dense(10, 20, 1, 2_000), 60);
  assert.ok(ring.length <= 60 && ring.length >= 3);
  assert.notDeepEqual(ring[0], ring.at(-1), 'the closing duplicate is dropped');
  for (const [lon, lat] of ring) {
    assert.equal(lon, Math.round(lon * 1000) / 1000);
    assert.equal(lat, Math.round(lat * 1000) / 1000);
  }
  assert.equal(
    simplifyRing([
      [0, 0],
      [1, 1],
    ]),
    null,
  );
  assert.equal(
    simplifyRing([
      [0, 0],
      [999, 1],
      [2, 2],
    ]),
    null,
    'invalid points are dropped',
  );
});

test('shapes pick the largest outer rings and an anchor inside them', () => {
  const shape = shapeFromGeometry({
    type: 'MultiPolygon',
    coordinates: [[square(-100, 30, 1)], [square(-90, 30, 4)]],
  });
  assert.equal(shape.rings.length, 2);
  assert.deepEqual([shape.lon, shape.lat], [-88, 32]);
  assert.equal(shape.areaDeg2, 17);
  assert.equal(shapeFromGeometry({ type: 'Point', coordinates: [1, 1] }), null);
  assert.equal(shapeFromGeometry(null), null);
  const l = ringCentroid([
    [0, 0],
    [4, 0],
    [4, 1],
    [1, 1],
    [1, 4],
    [0, 4],
  ]);
  assert.ok(l.lon >= 0 && l.lon <= 4 && l.lat >= 0 && l.lat <= 4);
});

test('NWS: slim records, zone-only and minor alerts counted, duplicates dropped', () => {
  const { records, noGeometry, filtered } = parseNws(NWS);
  assert.deepEqual(
    records.map((r) => r.id),
    ['nws:a1', 'nws:a2'],
  );
  assert.equal(noGeometry, 2, 'the zone-only alert and the point geometry');
  assert.equal(filtered, 1, 'Minor is below the default threshold');
  const [tornado] = records;
  assert.equal(tornado.severity, 'Severe');
  assert.equal(tornado.event, 'Tornado Warning');
  assert.equal(tornado.onset, '2026-10-17T04:49:00.000Z');
  assert.equal(
    tornado.expires,
    '2026-10-17T09:00:00.000Z',
    'ends wins over expires',
  );
  assert.equal(tornado.issuer, 'NWS Norman OK');
  assert.match(tornado.url, /^https:\/\/api\.weather\.gov\/alerts\//);
  assert.ok(!('geocode' in tornado) && !('description' in tornado));
  assert.throws(() => parseNws({}), /invalid_nws/);
});

test('ECCC: type and colour map to severity, ended and minor alerts dropped', () => {
  assert.equal(ecccSeverity('warning', 'red'), 'Extreme');
  assert.equal(ecccSeverity('warning', 'orange'), 'Severe');
  assert.equal(ecccSeverity('warning', 'yellow'), 'Moderate');
  assert.equal(ecccSeverity('warning', null), 'Severe');
  assert.equal(ecccSeverity('watch', null), 'Moderate');
  assert.equal(ecccSeverity('statement', null), 'Minor');
  const { records, noGeometry, filtered } = parseEccc(ECCC_PAGE1);
  assert.deepEqual(
    records.map((r) => r.id),
    ['eccc:e1', 'eccc:e2'],
  );
  assert.deepEqual([noGeometry, filtered], [1, 1]);
  assert.equal(records[0].event, 'Snowfall warning');
  assert.equal(records[0].area, 'Cartwright to Black Tickle, NL');
  assert.equal(records[0].issuer, 'Environment and Climate Change Canada');
  assert.throws(() => parseEccc({}), /invalid_eccc/);
});

test('ECCC paging follows only same-host https next links', () => {
  assert.equal(
    ecccNextUrl(ECCC_PAGE1),
    'https://api.weather.gc.ca/collections/weather-alerts/items?offset=500',
  );
  assert.equal(ecccNextUrl(ECCC_PAGE2), null);
  assert.equal(
    ecccNextUrl({
      links: [{ rel: 'next', href: 'http://api.weather.gc.ca/x' }],
    }),
    null,
  );
  assert.equal(ecccNextUrl({}), null);
});

test('WMO: duplicates of US and Canadian members, minor and hostile paths are not candidates', () => {
  const { candidates, duplicates, filtered } = wmoCandidates(WMO);
  assert.deepEqual(
    candidates.map((c) => c.item.id),
    ['w7', 'w1', 'w6'],
    'most severe first',
  );
  assert.equal(duplicates, 2);
  assert.equal(filtered, 1);
  assert.equal(
    candidates.find((c) => c.item.id === 'w6').path,
    'cn-cma-xx/2026/10/17/04/38/33-eee.xml',
  );
  assert.throws(() => wmoCandidates({}), /invalid_wmo/);
});

test('CAP shapes: polygon lat,lon pairs, circles, and text-only areas', () => {
  const polygon = parseCapShape(CAP_POLYGON);
  assert.deepEqual(polygon.rings[0][0], [123, 0.5]);
  assert.equal(polygon.rings[0].length, 4);
  const circle = parseCapShape(CAP_CIRCLE);
  assert.ok(circle.rings[0].length >= 8 && circle.rings[0].length <= 16);
  assert.ok(
    Math.abs(circle.lat + 10.5) < 0.1 && Math.abs(circle.lon - 120.25) < 0.1,
  );
  assert.equal(parseCapShape(CAP_TEXT_ONLY), null);
});

test('the vertex budget keeps the most severe and largest alerts', () => {
  const make = (id, severity, size) => ({
    id,
    severity,
    areaDeg2: size,
    rings: [dense(0, 0, 1, 40).slice(0, 40)],
  });
  const records = [
    make('minor-big', 'Moderate', 900),
    make('extreme-small', 'Extreme', 1),
    make('severe-big', 'Severe', 500),
  ];
  const fitted = fitBudget(records, 85);
  assert.deepEqual(
    fitted.records.map((r) => r.id),
    ['extreme-small', 'severe-big'],
  );
  assert.equal(fitted.truncated, 1);
  assert.ok(MAX_TOTAL_VERTICES > 50_000);
});

test('serves merged sources, then a HIT, then refreshes after the TTL', async () => {
  let at = 1_000_000;
  const calls = [];
  const request = install({
    now: () => at,
    fetchImpl: fetcher(fullPlan(), calls),
  });
  const first = await request();
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['X-Feed-Cache'], 'MISS');
  const body = JSON.parse(first.body);
  assert.deepEqual(body.sources, {
    nws: { ok: true, count: 2 },
    eccc: { ok: true, count: 3 },
    wmo: { ok: true, count: 2 },
  });
  assert.equal(body.minSeverity, 'Moderate');
  assert.equal(body.skipped.noGeometry, 2 + 1 + 1);
  assert.equal(body.skipped.duplicates, 2);
  const ids = body.records.map((r) => r.id);
  assert.ok(ids.includes('wmo:w1') && ids.includes('wmo:w6'));
  assert.ok(
    !ids.includes('wmo:w7'),
    'a text-only WMO alert has nothing to draw',
  );
  assert.ok(!ids.includes('wmo:w2') && !ids.includes('wmo:w3'));
  assert.deepEqual(
    body.records.map((r) => r.severity),
    [...body.records.map((r) => r.severity)].sort(
      (a, b) =>
        ['Extreme', 'Severe', 'Moderate'].indexOf(a) -
        ['Extreme', 'Severe', 'Moderate'].indexOf(b),
    ),
    'most severe first',
  );
  assert.ok(
    calls.every((c) =>
      /^GodsEyeView\/0\.2/.test(c.options.headers['User-Agent']),
    ),
  );
  assert.ok(
    !calls.some((c) => c.url.includes('evil.example')),
    'a foreign next link is never requested',
  );
  at += 299_000;
  assert.equal((await request()).headers['X-Feed-Cache'], 'HIT');
});

test('CAP documents are fetched in bounded numbers and remembered between refreshes', async () => {
  let at = 0;
  const calls = [];
  const many = {
    items: Array.from({ length: 60 }, (_, i) =>
      wmoItem(
        `m${i}`,
        `xx-test-en/2026/10/17/${String(i).padStart(2, '0')}.xml`,
        3,
      ),
    ),
  };
  const plan = { ...fullPlan(), wmo: many };
  for (let i = 0; i < 60; i++)
    plan[`cap:xx-test-en/2026/10/17/${String(i).padStart(2, '0')}.xml`] =
      CAP_POLYGON;
  const request = install({
    now: () => at,
    ttlMs: 1_000,
    fetchImpl: fetcher(plan, calls),
  });
  const capCalls = () =>
    calls.filter((c) => c.url.includes('/v2/cap-alerts/')).length;
  const first = JSON.parse((await request()).body);
  assert.equal(capCalls(), WMO_CAP_FETCH_PER_REFRESH);
  assert.equal(first.sources.wmo.count, WMO_CAP_FETCH_PER_REFRESH);
  at += 2_000;
  const second = JSON.parse((await request()).body);
  assert.equal(
    capCalls(),
    60,
    'the rest are fetched next time, never refetched',
  );
  assert.equal(second.sources.wmo.count, 60);
});

test('each source fails independently and keeps its last good records', async () => {
  let at = 0;
  const plan = fullPlan();
  const request = install({
    now: () => at,
    ttlMs: 1_000,
    fetchImpl: fetcher(plan),
  });
  await request();
  plan.nws = 500;
  plan.eccc = new Error('network down');
  at += 2_000;
  const body = JSON.parse((await request()).body);
  assert.equal(body.sources.nws.ok, false);
  assert.equal(body.sources.nws.stale, true);
  assert.equal(body.sources.nws.count, 2);
  assert.equal(body.sources.eccc.ok, false);
  assert.equal(body.sources.wmo.ok, true);
  assert.equal(body.records.filter((r) => r.source === 'nws').length, 2);
  assert.equal(body.records.filter((r) => r.source === 'eccc').length, 3);
});

test('total failure serves STALE and backs off; with nothing cached it is a 502', async () => {
  let at = 0;
  const calls = [];
  const plan = fullPlan();
  const request = install({
    now: () => at,
    ttlMs: 1_000,
    fetchImpl: fetcher(plan, calls),
  });
  await request();
  plan.nws = 503;
  plan.eccc = 503;
  plan.wmo = 503;
  at += 5_000;
  const stale = await request();
  assert.equal(stale.headers['X-Feed-Cache'], 'STALE');
  assert.equal(JSON.parse(stale.body).stale, true);
  const attempted = calls.length;
  at += 1_000;
  assert.equal((await request()).headers['X-Feed-Cache'], 'STALE');
  assert.equal(calls.length, attempted, 'cooldown: no upstream hammering');

  const cold = install({
    fetchImpl: fetcher({ nws: 500, eccc: 500, wmo: 500 }),
  });
  const res = await cold();
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'weather-alerts_unavailable',
  });
});

test('query strings and non-GET methods are rejected; hooks return nothing', async () => {
  const calls = [];
  const request = install({ fetchImpl: fetcher(fullPlan(), calls) });
  assert.equal((await request('/?x=1')).statusCode, 400);
  assert.equal((await request('/', 'POST')).statusCode, 405);
  assert.equal(calls.length, 0);
  const plugin = weatherAlertsProxy();
  const server = { middlewares: { use: () => () => {} } };
  assert.equal(plugin.configureServer(server), undefined);
  assert.equal(plugin.configurePreviewServer(server), undefined);
  const preview = install({ fetchImpl: fetcher(fullPlan()) }, true);
  assert.equal((await preview()).statusCode, 200);
});
