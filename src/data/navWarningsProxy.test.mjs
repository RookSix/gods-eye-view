import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  classifyCableActivity,
  classifyWarningKind,
  extractPositions,
  navWarningsProxy,
  parseNgaTime,
  parseNgaWarnings,
  parseWarningGeometry,
} from '../../server/providers/navWarnings.js';

const warning = (over = {}) => ({
  msgYear: 2024,
  msgNumber: 127,
  navArea: '4',
  subregion: '24,25',
  status: 'A',
  issueDate: '310100Z JAN 2024',
  authority: 'NGA NAVSAFETY 0/24 310046Z JAN 24.',
  cancelDate: null,
  text: 'CARIBBEAN SEA.\nARUBA.\nCABLE OPERATIONS IN PROGRESS UNTIL FURTHER NOTICE\nBY CABLESHIP PANAM ALONG TRACKLINES JOINING:\nA. 13-10.34N 069-51.47W, 12-55.78N 069-48.86W,\n   12-43.47N 069-46.66W, 12-39.79N 069-46.00W.\nB. 13-47.75N 069-55.00W, 13-30.00N 069-55.00W.\n',
  ...over,
});

const AREA_TEXT =
  'WESTERN MEDITERRANEAN SEA.\nFRANCE.\nDNC 08.\nUNDERWATER OPERATIONS UNTIL\nFURTHER NOTICE BY CABLESHIP SOPHIE GERMAIN\nIN AREA BOUND BY\n42-50.08N 003-14.74E, 42-50.19N 003-14.58E,\n42-50.48N 003-15.23E.\n';
const SEISMIC_TEXT =
  'IRISH SEA.\nSURVEY OPERATIONS IN PROGRESS UNTIL\nFURTHER NOTICE BY M/V SW AMUNDSEN\nTOWING SEVEN 2200 METER LONG CABLES\nIN AREA BOUND BY\n54-04.00N 003-46.00W, 53-54.00N 003-23.00W,\n53-48.00N 003-23.00W.\n';
const RIGS_TEXT =
  '1. NAVAREA IV MOBILE OFFSHORE DRILLING UNITS\n   A. AGOSTO 12 19-23.0N 092-03.1W.\n   B. ARGOS 27-10.4N 090-22.1W.\n   AC. (NEW POSITION) HELIX Q4000\n       27-27.1N 090-16.1W.\n';

function install(options = {}) {
  let handler;
  navWarningsProxy(options).configureServer({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/nav-warnings');
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

test('positions: decimal minutes, whole minutes, seconds, 2-digit longitudes, hemispheres', () => {
  const read = (text) => extractPositions(text).map((p) => [p.lat, p.lon]);
  assert.deepEqual(read('AT 12-34.5N 045-12.3E.'), [[12.575, 45.205]]);
  assert.deepEqual(read('22-00N 019-00W'), [[22, -19]]);
  assert.deepEqual(read('20-03-44N 072-58-02W'), [[20.06222, -72.96722]]);
  assert.deepEqual(read('02-43.93S 080-13.40W'), [[-2.73217, -80.22333]]);
  assert.deepEqual(read('22-06.90N 91-23.90W'), [[22.115, -91.39833]]);
  assert.deepEqual(read('14-51.78N\n   061-18.18W'), [[14.863, -61.303]]);
  assert.deepEqual(read('37-00.00N 012-00.00E'), [[37, 12]]);
});

test('positions: impossible minutes or ranges are rejected, not clamped', () => {
  assert.deepEqual(extractPositions('10-52.0N 154-84.0W'), []);
  assert.deepEqual(extractPositions('95-10.0N 010-00.0E'), []);
  assert.deepEqual(extractPositions('10-10.0N 190-00.0E'), []);
  assert.deepEqual(extractPositions('NO POSITION HERE 12 8000 METER'), []);
  assert.deepEqual(extractPositions('112-34.5N 045-12.3E'), []);
});

test('geometry: lettered trackline groups become separate lines', () => {
  const g = parseWarningGeometry(warning().text);
  assert.equal(g.points.length, 6);
  assert.deepEqual(
    g.shapes.map((s) => [s.kind, s.points.length]),
    [
      ['line', 4],
      ['line', 2],
    ],
  );
  assert.deepEqual(g.shapes[0].points[0], [-69.85783, 13.17233]);
  assert.deepEqual(g.anchor, { lat: 12.7245, lon: -69.77767 });
});

test('geometry: "area bound by" with 3+ positions is a polygon with a centre anchor', () => {
  const g = parseWarningGeometry(AREA_TEXT);
  assert.equal(g.shapes.length, 1);
  assert.equal(g.shapes[0].kind, 'area');
  assert.equal(g.shapes[0].points.length, 3);
  assert.ok(Math.abs(g.anchor.lat - 42.8) < 0.05);
  assert.ok(Math.abs(g.anchor.lon - 3.25) < 0.05);
});

test('geometry: separately named positions stay plain points', () => {
  const g = parseWarningGeometry(RIGS_TEXT);
  assert.equal(g.points.length, 3);
  assert.deepEqual(g.shapes, []);
  assert.deepEqual(g.anchor, { lat: 19.38333, lon: -92.05167 });
  assert.deepEqual(parseWarningGeometry('NO COORDINATES').anchor, null);
});

test('geometry: points and shapes are capped', () => {
  const many = Array.from(
    { length: 200 },
    (_, i) =>
      `${String((i % 80) + 1).padStart(2, '0')}-00.${String(i % 100).padStart(2, '0')}N 010-00.00E`,
  ).join(', ');
  const g = parseWarningGeometry(`IN AREA BOUND BY ${many}.`);
  assert.equal(g.points.length, 60);
  assert.equal(g.shapes[0].points.length, 60);
});

test('cable classification: ships, repair, laying; seismic streamers are not cables', () => {
  assert.equal(classifyCableActivity(warning().text), 'operations');
  assert.equal(classifyCableActivity(AREA_TEXT), 'operations');
  assert.equal(classifyCableActivity(SEISMIC_TEXT), null);
  assert.equal(
    classifyCableActivity(
      'MAN OVERBOARD FROM CABLESHIP RUI NING 21 IN VICINITY 30-49.5S 037-35.6E.',
    ),
    null,
  );
  assert.equal(
    classifyCableActivity('CABLE REPAIR OPERATIONS BY C/S X'),
    'repair',
  );
  assert.equal(classifyCableActivity('CABLE LAYING IN PROGRESS'), 'laying');
  assert.equal(
    classifyCableActivity('SUBMARINE CABLE WORK NEAR PORT'),
    'operations',
  );
  assert.equal(
    classifyCableActivity(
      'GUARD ZONE ESTABLISHED.',
      'C/S PIERRE DE FERMAT 0/24',
    ),
    'operations',
  );
  assert.equal(classifyCableActivity(RIGS_TEXT), null);
});

test('kind classification prefers cable, then topic keywords', () => {
  assert.equal(classifyWarningKind('X', 'repair'), 'cable');
  assert.equal(
    classifyWarningKind('MISSILE FIRING EXERCISES', null),
    'military',
  );
  assert.equal(classifyWarningKind('DERELICT VESSEL ADRIFT', null), 'hazard');
  assert.equal(classifyWarningKind('LIGHT UNLIT', null), 'hazard');
  assert.equal(classifyWarningKind('BUOY OFF STATION', null), 'aids');
  assert.equal(classifyWarningKind('NOTHING SPECIAL', null), 'other');
});

test('issue time parses DDHHMMZ MON YYYY', () => {
  assert.equal(parseNgaTime('310100Z JAN 2024'), '2024-01-31T01:00:00.000Z');
  assert.equal(parseNgaTime('081653Z MAY 2024'), '2024-05-08T16:53:00.000Z');
  assert.equal(parseNgaTime('999999Z MAY 2024'), null);
  assert.equal(parseNgaTime('nonsense'), null);
  assert.equal(parseNgaTime(null), null);
});

test('records: positioned warnings only, area names, de-duplication, text cleaned', () => {
  const payload = {
    'broadcast-warn': [
      warning(),
      warning({ msgNumber: 128, text: 'NO POSITIONS IN THIS ONE.' }),
      warning(),
      warning({ msgNumber: 129, navArea: 'A', text: RIGS_TEXT }),
      warning({ msgNumber: 130, cancelDate: '011200Z FEB 2024' }),
      warning({ msgNumber: 131, status: 'C' }),
      { msgYear: 'x' },
    ],
  };
  const parsed = parseNgaWarnings(payload);
  assert.equal(parsed.total, 7);
  assert.equal(parsed.withoutPosition, 1);
  assert.deepEqual(parsed.records.map((r) => r.id).sort(), [
    'nga:2024:4:127',
    'nga:2024:A:129',
  ]);
  const cable = parsed.records.find((r) => r.number === 127);
  assert.equal(cable.areaName, 'NAVAREA IV');
  assert.equal(cable.place, 'CARIBBEAN SEA, ARUBA');
  assert.equal(cable.kind, 'cable');
  assert.equal(cable.cableActivity, 'operations');
  assert.equal(cable.issued, '2024-01-31T01:00:00.000Z');
  assert.ok(!cable.text.includes('\n'));
  const rigs = parsed.records.find((r) => r.number === 129);
  assert.equal(rigs.areaName, 'HYDROLANT');
  assert.equal(rigs.cableActivity, null);
  assert.throws(() => parseNgaWarnings({}), /invalid_nga_warnings/);
});

test('route: MISS then HIT inside the 30 minute TTL, then refresh', async () => {
  let at = 5_000_000;
  const calls = [];
  const request = install({
    now: () => at,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json({ 'broadcast-warn': [warning()] });
    },
  });
  const first = await request();
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['X-Feed-Cache'], 'MISS');
  const body = JSON.parse(first.body);
  assert.equal(body.records.length, 1);
  assert.deepEqual(body.sources, { nga: { ok: true, count: 1 } });
  assert.match(calls[0].url, /^https:\/\/msi\.nga\.mil\/api\/publications\//);
  assert.match(calls[0].url, /status=A/);
  assert.match(calls[0].options.headers['User-Agent'], /^GodsEyeView\/0\.2/);
  at += 29 * 60_000;
  assert.equal((await request()).headers['X-Feed-Cache'], 'HIT');
  at += 2 * 60_000;
  assert.equal((await request()).headers['X-Feed-Cache'], 'MISS');
  assert.equal(calls.length, 2);
});

test('route: upstream failure serves STALE, or 502 when nothing is cached', async () => {
  let at = 0;
  let fail = false;
  const request = install({
    now: () => at,
    fetchImpl: async () =>
      fail
        ? new Response('x', { status: 503 })
        : Response.json({ 'broadcast-warn': [warning()] }),
  });
  fail = true;
  assert.equal((await request()).statusCode, 502);
  at += 60_000;
  fail = false;
  assert.equal((await request()).statusCode, 200);
  at += 31 * 60_000;
  fail = true;
  const stale = await request();
  assert.equal(stale.headers['X-Feed-Cache'], 'STALE');
  assert.equal(JSON.parse(stale.body).stale, true);
});

test('route: query strings and non-GET are rejected before any fetch', async () => {
  const calls = [];
  const request = install({
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json({ 'broadcast-warn': [] });
    },
  });
  assert.equal((await request('/?url=http://evil.example')).statusCode, 400);
  assert.equal((await request('/', 'POST')).statusCode, 405);
  assert.equal(calls.length, 0);
});
