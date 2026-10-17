import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  CLIMATE_REGIONS,
  archiveUrl,
  climateAnomaliesProxy,
  climateWindows,
  computeAnomaly,
  parseClimateAnomalies,
} from '../../server/providers/climateAnomalies.js';

const NOW = Date.UTC(2026, 9, 16, 12);

/** Daily series over the window: 30 baseline days then 7 recent days. */
function series(windows, { baseT, recentT, baseP, recentP, gaps = 0 }) {
  const time = [];
  const temp = [];
  const rain = [];
  const start = Date.parse(`${windows.start}T00:00:00Z`);
  const recentStart = Date.parse(`${windows.recentStart}T00:00:00Z`);
  for (let t = start; t <= Date.parse(`${windows.end}T00:00:00Z`); t += 864e5) {
    time.push(new Date(t).toISOString().slice(0, 10));
    const recent = t >= recentStart;
    temp.push(recent ? recentT : baseT);
    rain.push(recent ? recentP : baseP);
  }
  for (let i = 0; i < gaps; i++) {
    temp[i] = null;
    rain[i] = null;
  }
  return { time, temperature_2m_mean: temp, precipitation_sum: rain };
}

const windows = climateWindows(NOW);

function payloadFor(regions, shape) {
  return regions.map((region, i) => ({
    latitude: region.lat,
    longitude: region.lon,
    daily: series(windows, shape(i)),
  }));
}

function install(options = {}) {
  let handler;
  climateAnomaliesProxy(options).configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/climate-anomalies');
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

test('windows: end is today minus 5 days, 7 recent days, 30 baseline days before', () => {
  assert.deepEqual(windows, {
    start: '2026-09-05',
    end: '2026-10-11',
    recentStart: '2026-10-05',
    baselineEnd: '2026-10-04',
  });
});

test('request is one URL carrying every region with the documented parameters', () => {
  const url = new URL(archiveUrl(windows));
  assert.equal(url.origin, 'https://archive-api.open-meteo.com');
  assert.equal(url.pathname, '/v1/archive');
  assert.equal(
    url.searchParams.get('latitude').split(',').length,
    CLIMATE_REGIONS.length,
  );
  assert.equal(
    url.searchParams.get('longitude').split(',').length,
    CLIMATE_REGIONS.length,
  );
  assert.equal(url.searchParams.get('start_date'), '2026-09-05');
  assert.equal(url.searchParams.get('end_date'), '2026-10-11');
  assert.equal(
    url.searchParams.get('daily'),
    'temperature_2m_mean,precipitation_sum',
  );
  assert.equal(url.searchParams.get('timezone'), 'UTC');
  assert.ok(CLIMATE_REGIONS.length >= 15 && CLIMATE_REGIONS.length <= 20);
  for (const r of CLIMATE_REGIONS) {
    assert.ok(Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180);
  }
});

test('anomaly: temperature difference and precipitation percentage', () => {
  const anomaly = computeAnomaly(
    series(windows, { baseT: 10, recentT: 12.5, baseP: 2, recentP: 3 }),
    windows,
  );
  assert.equal(anomaly.tempAnomalyC, 2.5);
  assert.equal(anomaly.tempRecentC, 12.5);
  assert.equal(anomaly.tempBaselineC, 10);
  assert.equal(anomaly.precipAnomalyPct, 50);
  assert.equal(anomaly.precipRecentMm, 21);
  assert.equal(anomaly.precipBaselineMm, 14);
  assert.equal(anomaly.days, 7);
});

test('anomaly: a near-dry baseline gives no precipitation percentage', () => {
  const anomaly = computeAnomaly(
    series(windows, { baseT: 20, recentT: 19, baseP: 0.05, recentP: 4 }),
    windows,
  );
  assert.equal(anomaly.precipAnomalyPct, null);
  assert.equal(anomaly.tempAnomalyC, -1);
});

test('anomaly: too many gaps or a malformed series is skipped', () => {
  assert.equal(
    computeAnomaly(
      series(windows, { baseT: 1, recentT: 1, baseP: 1, recentP: 1, gaps: 20 }),
      windows,
    ),
    null,
  );
  assert.equal(computeAnomaly({ time: 'x' }, windows), null);
  assert.equal(computeAnomaly(null, windows), null);
});

test('parse: records per region, order kept, bad locations skipped, bad shapes rejected', () => {
  const regions = CLIMATE_REGIONS.slice(0, 3);
  const payload = payloadFor(regions, (i) => ({
    baseT: 10,
    recentT: 10 + i,
    baseP: 1,
    recentP: 1,
  }));
  payload[1] = { error: true, reason: 'bad' };
  const records = parseClimateAnomalies(payload, windows, regions);
  assert.deepEqual(
    records.map((r) => r.id),
    [`climate:${regions[0].id}`, `climate:${regions[2].id}`],
  );
  assert.equal(records[1].tempAnomalyC, 2);
  assert.equal(records[0].recentEnd, '2026-10-11');
  assert.throws(
    () => parseClimateAnomalies([], windows, regions),
    /invalid_open_meteo/,
  );
  assert.throws(
    () => parseClimateAnomalies({ latitude: 1 }, windows, regions),
    /invalid_open_meteo/,
  );
});

test('route: one upstream request, MISS then HIT for 6 hours, then refresh', async () => {
  let at = NOW;
  const calls = [];
  const request = install({
    now: () => at,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json(
        payloadFor(CLIMATE_REGIONS, () => ({
          baseT: 5,
          recentT: 8,
          baseP: 1,
          recentP: 0.5,
        })),
      );
    },
  });
  const first = await request();
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['X-Feed-Cache'], 'MISS');
  const body = JSON.parse(first.body);
  assert.equal(body.records.length, CLIMATE_REGIONS.length);
  assert.equal(body.records[0].tempAnomalyC, 3);
  assert.equal(body.records[0].precipAnomalyPct, -50);
  assert.match(body.attribution, /^Open-Meteo\.com \(ERA5, CC BY 4\.0\)/);
  assert.match(body.method, /preceding|before them/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].options.headers['User-Agent'], /^GodsEyeView\/0\.2/);
  at += 5.9 * 3600_000;
  assert.equal((await request()).headers['X-Feed-Cache'], 'HIT');
  at += 0.2 * 3600_000;
  assert.equal((await request()).headers['X-Feed-Cache'], 'MISS');
  assert.equal(calls.length, 2);
});

test('route: failure is STALE once cached and 502 before, and rejects odd queries', async () => {
  let at = NOW;
  let fail = true;
  const request = install({
    now: () => at,
    fetchImpl: async () =>
      fail
        ? new Response('limit', { status: 429 })
        : Response.json(
            payloadFor(CLIMATE_REGIONS, () => ({
              baseT: 5,
              recentT: 5,
              baseP: 1,
              recentP: 1,
            })),
          ),
  });
  assert.equal((await request()).statusCode, 502);
  at += 60_000;
  fail = false;
  assert.equal((await request()).statusCode, 200);
  at += 7 * 3600_000;
  fail = true;
  const stale = await request();
  assert.equal(stale.headers['X-Feed-Cache'], 'STALE');
  assert.equal(JSON.parse(stale.body).stale, true);
  assert.equal((await request('/?lat=1')).statusCode, 400);
  assert.equal((await request('/', 'POST')).statusCode, 405);
});
