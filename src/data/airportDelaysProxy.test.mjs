import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  airportDelaysProxy,
  classifyProgram,
  indexAirports,
  isLimitedClosure,
  loadAirportIndex,
  parseDurationMinutes,
  parseFaaStatus,
} from '../../server/providers/airportDelays.js';
import { child, parseXml, textOf } from '../../server/providers/common/xml.js';

const AIRPORTS = indexAirports({
  airports: [
    ['LAS', 'KLAS', 36.0834, -115.1518],
    ['BWI', 'KBWI', 39.1754, -76.6683],
    ['MCO', 'KMCO', 28.4294, -81.309],
    ['JAC', 'KJAC', 43.6073, -110.738],
    ['SNA', 'KSNA', 33.6751, -117.8693],
    ['LAX', 'KLAX', 33.9425, -118.408],
    ['EWR', 'KEWR', 40.6894, -74.1705],
  ].map(([iata, icao, lat, lon]) => ({
    iata,
    icao,
    name: `${iata} Airport`,
    lat,
    lon,
  })),
});

const section = (name, list, entries) =>
  `<Delay_type><Name>${name}</Name><${list}>${entries}</${list}></Delay_type>`;
const document = (...blocks) =>
  `<?xml version="1.0"?><AIRPORT_STATUS_INFORMATION><Update_Time>Sat Oct 17 04:54:13 2026 GMT</Update_Time><Dtd_File>http://www.fly.faa.gov/AirportStatus.dtd</Dtd_File>${blocks.join('')}</AIRPORT_STATUS_INFORMATION>`;

const FAA = document(
  section(
    'Ground Delay Programs',
    'Ground_Delay_List',
    '<Ground_Delay><ARPT>LAS</ARPT><Reason>wind</Reason><Avg>1 hour and 20 minutes</Avg><Max>3 hours and 58 minutes</Max></Ground_Delay>',
  ),
  section(
    'General Arrival/Departure Delay Info',
    'Arrival_Departure_Delay_List',
    '<Delay><ARPT>BWI</ARPT><Reason>WX:Thunderstorms</Reason><Arrival_Departure Type="Departure"><Min>1 hour and 16 minutes</Min><Max>1 hour and 30 minutes</Max><Trend>Increasing</Trend></Arrival_Departure></Delay>' +
      '<Delay><ARPT>MCO</ARPT><Reason>RWY:Maintenance</Reason><Arrival_Departure Type="Departure"><Min>16 minutes</Min><Max>30 minutes</Max><Trend>Increasing</Trend></Arrival_Departure></Delay>',
  ),
  section(
    'Ground Stop Programs',
    'Ground_Stop_List',
    '<Program><ARPT>EWR</ARPT><Reason>thunderstorms</Reason><End_Time>5:30 pm EDT</End_Time></Program>',
  ),
  section(
    'Airport Closures',
    'Airport_Closure_List',
    '<Airport><ARPT>JAC</ARPT><Reason>!JAC 10/141 JAC AD AP CLSD EXC 1HR &#xd;PPR 2610170354-2610171200</Reason><Start>Oct 17 at 03:54 UTC.</Start><Reopen>Oct 17 at 12:00 UTC.</Reopen></Airport>' +
      '<Airport><ARPT>SNA</ARPT><Reason>!SNA 10/016 SNA AD AP CLSD DLY 0630-1315</Reason><Start>Oct 13 at 06:30 UTC.</Start><Reopen>Oct 17 at 13:15 UTC.</Reopen></Airport>' +
      '<Airport><ARPT>LAX</ARPT><Reason>!LAX AD AP CLSD TO NON SKED TRANSIENT GA ACFT</Reason></Airport>' +
      '<Airport><ARPT>ZZZ</ARPT><Reason>runway</Reason></Airport>',
  ),
  section(
    'Airspace Flow Programs',
    'Airspace_Flow_List',
    '<Airspace_Flow><CTL_Element>ZNY</CTL_Element><Reason>weather</Reason></Airspace_Flow>',
  ),
);

function install(options = {}, preview = false) {
  let handler;
  const plugin = airportDelaysProxy({ airports: AIRPORTS, ...options });
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/airport-delays');
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

test('XML reader: entities, attributes, CDATA, comments and stray closers', () => {
  const root = parseXml(
    '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "boom">]><a x="1 &amp; 2"><!-- skip --><b>t &lt;1&gt; &#65;&#x42;</b><c><![CDATA[<raw>]]></c><d/></e></a>',
  );
  assert.equal(root.name, 'a');
  assert.equal(root.attrs.x, '1 & 2');
  assert.equal(textOf(child(root, 'b')), 't <1> AB');
  assert.equal(textOf(child(root, 'c')), '<raw>');
  assert.ok(child(root, 'd'));
  assert.equal(child(root, 'missing'), null);
  assert.throws(() => parseXml(''), /xml_empty/);
});

test('XML reader bounds node count and depth', () => {
  const wide = `<r>${'<i/>'.repeat(50)}</r>`;
  assert.throws(() => parseXml(wide, { maxNodes: 10 }), /xml_too_many_nodes/);
  const deep = '<a>'.repeat(60) + '</a>'.repeat(60);
  assert.throws(() => parseXml(deep, { maxDepth: 20 }), /xml_too_deep/);
});

test('durations and block names are understood', () => {
  assert.equal(parseDurationMinutes('1 hour and 20 minutes'), 80);
  assert.equal(parseDurationMinutes('3 hours and 58 minutes'), 238);
  assert.equal(parseDurationMinutes('16 minutes'), 16);
  assert.equal(parseDurationMinutes('2 hours'), 120);
  assert.equal(parseDurationMinutes('soon'), null);
  assert.equal(classifyProgram('Ground Delay Programs'), 'gdp');
  assert.equal(classifyProgram('Ground Stops'), 'ground-stop');
  assert.equal(classifyProgram('Airport Closures'), 'closure');
  assert.equal(
    classifyProgram('General Arrival/Departure Delay Info'),
    'delay',
  );
  assert.equal(classifyProgram('Airspace Flow Programs'), 'afp');
  assert.equal(classifyProgram('Deicing'), 'deicing');
  assert.equal(classifyProgram('Something New'), 'other');
  assert.equal(
    isLimitedClosure('!LAX AD AP CLSD TO NON SKED TRANSIENT GA ACFT'),
    true,
  );
  assert.equal(isLimitedClosure('!XYZ AD AP CLSD'), false);
});

test('FAA status: programs grouped per airport, ranked, with unmatched codes counted', () => {
  const parsed = parseFaaStatus(FAA, AIRPORTS);
  assert.equal(parsed.updateTime, 'Sat Oct 17 04:54:13 2026 GMT');
  assert.deepEqual(
    parsed.records.map((r) => [r.code, r.level]),
    [
      ['EWR', 'red'],
      ['LAS', 'orange'],
      ['BWI', 'yellow'],
      ['MCO', 'yellow'],
      ['JAC', 'grey'],
      ['LAX', 'grey'],
      ['SNA', 'grey'],
    ],
  );
  assert.equal(parsed.unmatched, 1);
  assert.deepEqual(parsed.unmatchedCodes, ['ZZZ']);
  assert.equal(
    parsed.withoutAirport,
    1,
    'the airspace flow program names no airport',
  );
  const las = parsed.records.find((r) => r.code === 'LAS');
  assert.equal(las.topKind, 'gdp');
  assert.deepEqual(
    [las.programs[0].avgMin, las.programs[0].maxMin, las.programs[0].reason],
    [80, 238, 'wind'],
  );
  assert.equal(las.lat, 36.0834);
  const bwi = parsed.records.find((r) => r.code === 'BWI');
  assert.equal(bwi.programs[0].direction, 'Departure');
  assert.equal(bwi.programs[0].trend, 'Increasing');
  assert.equal(bwi.programs[0].minMin, 76);
  const jac = parsed.records.find((r) => r.code === 'JAC');
  assert.equal(jac.programs[0].limited, true);
  assert.equal(jac.programs[0].reopen, 'Oct 17 at 12:00 UTC.');
  assert.ok(
    !/[\r\n]/.test(jac.programs[0].reason),
    'control characters are dropped',
  );
});

test('a limited closure never outranks a real delay at the same airport', () => {
  const both = document(
    section(
      'Airport Closures',
      'Airport_Closure_List',
      '<Airport><ARPT>LAS</ARPT><Reason>AD AP CLSD TO NON SKED TRANSIENT GA ACFT</Reason></Airport>',
    ),
    section(
      'Ground Delay Programs',
      'Ground_Delay_List',
      '<Ground_Delay><ARPT>LAS</ARPT><Reason>wind</Reason><Avg>30 minutes</Avg></Ground_Delay>',
    ),
  );
  const [las] = parseFaaStatus(both, AIRPORTS).records;
  assert.equal(las.level, 'orange');
  assert.equal(las.programs.length, 2);
  assert.equal(las.programs[0].kind, 'gdp');
});

test('a document of the wrong shape is rejected', () => {
  assert.throws(
    () => parseFaaStatus('<html><body/></html>', AIRPORTS),
    /invalid_faa_status/,
  );
});

test('the bundled OurAirports extract indexes by IATA and ICAO', async () => {
  const index = await loadAirportIndex();
  assert.ok(index.size > 800);
  assert.equal(index.get('LAS').name, 'Harry Reid International Airport');
  assert.equal(index.get('KLAS'), index.get('LAS'));
  assert.throws(() => indexAirports({}), /invalid_airports/);
});

test('serves a MISS then a HIT inside the TTL and refreshes after it', async () => {
  let at = 1_000_000;
  const calls = [];
  const request = install({
    now: () => at,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(FAA, {
        headers: { 'content-type': 'application/xml' },
      });
    },
  });
  const first = await request();
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['X-Feed-Cache'], 'MISS');
  const body = JSON.parse(first.body);
  assert.equal(body.stale, false);
  assert.deepEqual(body.sources, { faa: { ok: true, count: 7 } });
  assert.equal(body.unmatched, 1);
  assert.equal(body.records.length, 7);
  assert.equal(
    calls[0].url,
    'https://nasstatus.faa.gov/api/airport-status-information',
  );
  assert.match(calls[0].options.headers['User-Agent'], /^GodsEyeView\/0\.2/);
  at += 299_000;
  assert.equal((await request()).headers['X-Feed-Cache'], 'HIT');
  at += 2_000;
  assert.equal((await request()).headers['X-Feed-Cache'], 'MISS');
  assert.equal(calls.length, 2);
});

test('upstream failure serves the last good body as STALE, and with nothing cached is a 502', async () => {
  let at = 0;
  let fail = false;
  const request = install({
    now: () => at,
    fetchImpl: async () =>
      fail ? new Response('down', { status: 503 }) : new Response(FAA),
  });
  await request();
  fail = true;
  at += 400_000;
  const stale = await request();
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.headers['X-Feed-Cache'], 'STALE');
  assert.equal(JSON.parse(stale.body).stale, true);

  const cold = install({
    fetchImpl: async () => new Response('down', { status: 500 }),
  });
  const res = await cold();
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'airport-delays_unavailable',
  });
});

test('concurrent requests share one upstream refresh', async () => {
  let calls = 0;
  const request = install({
    fetchImpl: async () => {
      calls++;
      return new Response(FAA);
    },
  });
  await Promise.all([request(), request(), request()]);
  assert.equal(calls, 1);
});

test('query strings and non-GET methods are rejected before any fetch', async () => {
  let calls = 0;
  const request = install({
    fetchImpl: async () => {
      calls++;
      return new Response(FAA);
    },
  });
  assert.equal((await request('/?url=http://evil.example')).statusCode, 400);
  assert.equal((await request('/', 'POST')).statusCode, 405);
  assert.equal(calls, 0);
});

test('server hooks return nothing and the preview server serves the route', async () => {
  const plugin = airportDelaysProxy();
  const server = { middlewares: { use: () => () => {} } };
  assert.equal(plugin.configureServer(server), undefined);
  assert.equal(plugin.configurePreviewServer(server), undefined);
  const request = install({ fetchImpl: async () => new Response(FAA) }, true);
  assert.equal((await request()).statusCode, 200);
});
