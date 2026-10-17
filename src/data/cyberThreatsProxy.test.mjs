import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  GEO_CACHE_TTL_MS,
  c2Framework,
  countryCentroids,
  createGeoResolver,
  cyberThreatsProxy,
  jitterPoint,
  loadCountryCentroids,
  mergeIndicators,
  parseAbuseIpdb,
  parseC2Intel,
  parseFeodo,
  parseOtx,
  parseUrlhaus,
  placeIndicators,
  publicIp,
} from '../../server/providers/cyberThreats.js';

const FEODO = [
  {
    ip_address: '162.243.103.246',
    port: 8080,
    status: 'offline',
    hostname: null,
    as_number: 14061,
    as_name: 'DIGITALOCEAN-ASN',
    country: 'US',
    first_seen: '2022-06-04 21:24:53',
    last_online: '2026-03-07',
    malware: 'Emotet',
  },
  {
    ip_address: '50.16.16.211',
    port: 443,
    status: 'online',
    hostname: 'ec2-50-16-16-211.compute-1.amazonaws.com',
    as_number: 14618,
    as_name: 'AMAZON-AES',
    country: 'US',
    first_seen: '2025-12-30 13:56:31',
    last_online: '2026-03-12',
    malware: 'QakBot',
  },
  {
    ip_address: '10.0.0.1',
    port: 1,
    status: 'online',
    country: 'US',
    malware: 'Emotet',
  },
  { ip_address: 'not an ip', port: 1, status: 'online', malware: 'x' },
];
const C2INTEL = [
  '#ip,ioc',
  '1.117.74.144,Possible Cobaltstrike C2 IP',
  '50.16.16.211,Possible Cobaltstrike C2 IP',
  '5.6.7.8,Possible Sliver C2 IP',
  '192.168.1.1,Possible Cobaltstrike C2 IP',
  '',
].join('\n');
const URLHAUS = {
  query_status: 'ok',
  urls: [
    {
      url: 'http://9.9.9.9:8081/bad.exe',
      host: '9.9.9.9',
      url_status: 'online',
      threat: 'malware_download',
      tags: ['elf', 'Mozi'],
      date_added: '2026-10-17 01:02:03 UTC',
      urlhaus_reference: 'https://urlhaus.abuse.ch/url/1/',
    },
    {
      url: 'http://evil.example/x',
      host: 'evil.example',
      url_status: 'online',
    },
  ],
};
const OTX = {
  results: [
    {
      indicator: '8.8.4.4',
      type: 'IPv4',
      title: 'Scanner',
      created: '2026-10-16T10:00:00',
    },
    { indicator: '10.1.1.1', type: 'IPv4' },
  ],
};
const ABUSEIPDB = {
  data: [
    {
      ipAddress: '7.7.7.7',
      countryCode: 'DE',
      abuseConfidenceScore: 100,
      lastReportedAt: '2026-10-17T00:00:00+00:00',
    },
    { ipAddress: '127.0.0.1', countryCode: 'DE', abuseConfidenceScore: 100 },
  ],
};
const CENTROIDS = new Map([
  ['US', { lat: 39, lon: -98 }],
  ['DE', { lat: 51, lon: 10 }],
]);
const IPINFO = {
  '50.16.16.211': {
    city: 'Ashburn',
    country: 'US',
    loc: '39.0437,-77.4875',
    org: 'AS14618 Amazon.com, Inc.',
  },
  '1.117.74.144': {
    city: 'Beijing',
    country: 'CN',
    loc: '39.9,116.4',
    org: 'AS4134 China Telecom',
  },
};

function install(options = {}, preview = false) {
  let handler;
  const plugin = cyberThreatsProxy({
    centroids: CENTROIDS,
    env: {},
    ...options,
  });
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/cyber-threats');
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

function fetcher(plan = {}, calls = []) {
  return async (url, options = {}) => {
    const href = String(url);
    calls.push({ url: href, options });
    let key;
    if (href.includes('feodotracker')) key = 'feodo';
    else if (href.includes('C2IntelFeeds')) key = 'c2intel';
    else if (href.includes('urlhaus')) key = 'urlhaus';
    else if (href.includes('otx.alienvault')) key = 'otx';
    else if (href.includes('abuseipdb')) key = 'abuseipdb';
    else if (href.includes('ipinfo.io')) key = 'ipinfo';
    else key = 'unknown';
    if (key === 'ipinfo') {
      const ip = href.split('/')[3];
      const step = plan.ipinfo;
      if (step instanceof Error) throw step;
      if (typeof step === 'number') return new Response('x', { status: step });
      const hit = (step || IPINFO)[ip];
      return hit
        ? Response.json({ ip, ...hit })
        : Response.json({ ip, bogon: true });
    }
    const step = Object.hasOwn(plan, key)
      ? plan[key]
      : { feodo: FEODO, c2intel: C2INTEL }[key];
    if (step instanceof Error) throw step;
    if (typeof step === 'number') return new Response('x', { status: step });
    if (typeof step === 'string') return new Response(step);
    if (step === undefined) return new Response('x', { status: 404 });
    return Response.json(step);
  };
}

const memoryDisk = (entries = {}) => ({
  entries,
  writes: 0,
  async read() {
    return this.entries;
  },
  async write(next) {
    this.writes++;
    this.entries = next;
  },
});

test('public IPs only: private, reserved, loopback and junk are rejected', () => {
  assert.equal(publicIp('50.16.16.211'), '50.16.16.211');
  for (const bad of [
    '10.0.0.1',
    '127.0.0.1',
    '192.168.0.9',
    '172.20.1.1',
    '169.254.1.1',
    '100.64.0.1',
    '0.1.2.3',
    '224.0.0.1',
    '256.1.1.1',
    'a.b.c.d',
    '',
    null,
    '1.2.3',
  ])
    assert.equal(publicIp(bad), null, String(bad));
  assert.equal(publicIp('2001:DB8::1'), '2001:db8::1');
  assert.equal(publicIp('::1'), null);
  assert.equal(publicIp('fd00::1'), null);
});

test('Feodo: rows become botnet C2 indicators; private and invalid addresses skipped', () => {
  const records = parseFeodo(FEODO);
  assert.deepEqual(
    records.map((r) => r.ip),
    ['162.243.103.246', '50.16.16.211'],
  );
  const [offline, online] = records;
  assert.equal(offline.status, 'offline');
  assert.equal(offline.family, 'Emotet');
  assert.equal(offline.asn, 'AS14061');
  assert.equal(offline.country, 'US');
  assert.equal(online.hostname, 'ec2-50-16-16-211.compute-1.amazonaws.com');
  assert.equal(online.category, 'botnet-c2');
  assert.throws(() => parseFeodo({}), /invalid_feodo/);
});

test('C2IntelFeeds: header skipped, framework named from the description', () => {
  const records = parseC2Intel(C2INTEL);
  assert.deepEqual(
    records.map((r) => [r.ip, r.family]),
    [
      ['1.117.74.144', 'Cobalt Strike'],
      ['50.16.16.211', 'Cobalt Strike'],
      ['5.6.7.8', 'Sliver'],
    ],
  );
  assert.equal(c2Framework('Possible Mystery Tool C2 IP'), 'Mystery Tool');
  assert.equal(c2Framework(''), 'C2 server');
});

test('optional feeds parse to the same indicator shape', () => {
  const [haus] = parseUrlhaus(URLHAUS);
  assert.equal(
    parseUrlhaus(URLHAUS).length,
    1,
    'only bare-IP hosts are usable',
  );
  assert.deepEqual(
    [haus.ip, haus.port, haus.family, haus.status],
    ['9.9.9.9', 8081, 'elf', 'online'],
  );
  assert.equal(haus.url, 'https://urlhaus.abuse.ch/url/1/');
  const otx = parseOtx(OTX);
  assert.deepEqual(
    otx.map((r) => [r.ip, r.family]),
    [['8.8.4.4', 'Scanner']],
  );
  const abuse = parseAbuseIpdb(ABUSEIPDB);
  assert.deepEqual(
    abuse.map((r) => [r.ip, r.country, r.family]),
    [['7.7.7.7', 'DE', 'Abuse score 100']],
  );
  assert.throws(() => parseUrlhaus({}), /invalid_urlhaus/);
  assert.throws(() => parseOtx({}), /invalid_otx/);
  assert.throws(() => parseAbuseIpdb({}), /invalid_abuseipdb/);
});

test('merging keeps one record per address from the richest source and remembers all sources', () => {
  const merged = mergeIndicators([parseC2Intel(C2INTEL), parseFeodo(FEODO)]);
  const shared = merged.find((r) => r.ip === '50.16.16.211');
  assert.equal(shared.source, 'feodo');
  assert.equal(shared.family, 'QakBot');
  assert.deepEqual(shared.sources.sort(), ['c2intel', 'feodo']);
  assert.equal(merged.length, 4);
  // The weaker source's country survives when the richer one lacks it.
  const withCountry = mergeIndicators([
    parseAbuseIpdb(ABUSEIPDB),
    parseC2Intel('7.7.7.7,Possible Havoc C2 IP'),
  ]);
  assert.equal(withCountry[0].country, 'DE');
});

test('country centroids come from the bundled Natural Earth pack', async () => {
  const centroids = await loadCountryCentroids();
  const us = centroids.get('US');
  assert.ok(
    us.lat > 30 && us.lat < 50 && us.lon > -125 && us.lon < -65,
    JSON.stringify(us),
  );
  const de = centroids.get('DE');
  assert.ok(de.lat > 47 && de.lat < 55 && de.lon > 5 && de.lon < 16);
  assert.ok(centroids.size > 150);
  assert.throws(() => countryCentroids({}), /invalid_countries/);
});

test('jitter is deterministic, bounded and keeps co-located points apart', () => {
  const a = jitterPoint('1.2.3.4', 39, -98, 2);
  assert.deepEqual(a, jitterPoint('1.2.3.4', 39, -98, 2));
  const b = jitterPoint('1.2.3.5', 39, -98, 2);
  assert.notDeepEqual(a, b);
  for (const p of [a, b]) {
    assert.ok(Math.abs(p.lat - 39) <= 2.0001);
    assert.ok(
      Math.abs(p.lon - -98) <= 2 / Math.cos((39 * Math.PI) / 180) + 0.001,
    );
  }
  const pole = jitterPoint('9.9.9.9', 89, 179.9, 5);
  assert.ok(pole.lat <= 85 && Math.abs(pole.lon) <= 180);
});

test('placement: IP location, else country centroid, else dropped and counted', () => {
  const indicators = mergeIndicators([
    parseFeodo(FEODO),
    parseC2Intel(C2INTEL),
  ]);
  const geo = new Map([
    [
      '1.117.74.144',
      {
        lat: 39.9,
        lon: 116.4,
        country: 'CN',
        city: 'Beijing',
        org: 'AS4134 China Telecom',
      },
    ],
  ]);
  const { placed, precise, countryOnly, dropped } = placeIndicators(
    indicators,
    geo,
    CENTROIDS,
  );
  assert.equal(precise, 1);
  assert.equal(
    countryOnly,
    2,
    'the two Feodo rows fall back to the US centroid',
  );
  assert.equal(
    dropped,
    1,
    'a country-less C2Intel row with no lookup has no position',
  );
  const beijing = placed.find((r) => r.ip === '1.117.74.144');
  assert.equal(beijing.precision, 'ip');
  assert.equal(beijing.country, 'CN');
  assert.ok(Math.abs(beijing.lat - 39.9) < 0.07);
  const fallback = placed.find((r) => r.ip === '162.243.103.246');
  assert.equal(fallback.precision, 'country');
  assert.equal(placed[0].status, 'online', 'online indicators sort first');
});

test('geo resolver: caps new lookups, caches for seven days, mirrors to disk', async () => {
  let at = 1_000_000;
  const calls = [];
  const disk = memoryDisk();
  const resolver = createGeoResolver({
    now: () => at,
    diskCache: disk,
    maxLookups: 2,
    delayMs: 0,
    fetchImpl: async (url) => {
      calls.push(String(url));
      const ip = String(url).split('/')[3];
      return Response.json({
        ip,
        loc: '10.5,20.5',
        country: 'ZA',
        city: 'X',
        org: 'AS1 Y',
      });
    },
  });
  const ips = ['1.1.1.1', '2.2.2.2', '3.3.3.3'];
  const first = await resolver.resolve(ips);
  assert.equal(first.lookups, 2);
  assert.equal(first.capped, true);
  assert.equal(first.geo.size, 2);
  assert.equal(disk.writes, 1);
  assert.deepEqual(calls, [
    'https://ipinfo.io/1.1.1.1/json',
    'https://ipinfo.io/2.2.2.2/json',
  ]);
  const second = await resolver.resolve(ips);
  assert.equal(
    second.lookups,
    1,
    'cached addresses are free; the remainder continues',
  );
  assert.equal(second.capped, false);
  assert.equal(second.geo.size, 3);
  at += GEO_CACHE_TTL_MS + 1;
  const expired = await resolver.resolve(['1.1.1.1']);
  assert.equal(expired.lookups, 1, 'entries expire after seven days');

  // A restart reloads the disk cache instead of asking again.
  const restarted = createGeoResolver({
    now: () => at,
    diskCache: disk,
    delayMs: 0,
    fetchImpl: async () => {
      throw new Error('should not be called');
    },
  });
  const warm = await restarted.resolve(['1.1.1.1']);
  assert.equal(warm.geo.size, 1);
  assert.equal(warm.lookups, 0);
});

test('geo resolver: a 429 ends lookups, failures are not retried at once, bogons dropped', async () => {
  let mode = 'limit';
  let calls = 0;
  const resolver = createGeoResolver({
    diskCache: null,
    delayMs: 0,
    fetchImpl: async (url) => {
      calls++;
      if (mode === 'limit') return new Response('slow down', { status: 429 });
      if (mode === 'error') throw new Error('network down');
      const ip = String(url).split('/')[3];
      return Response.json({ ip, bogon: true });
    },
  });
  const limited = await resolver.resolve(['1.1.1.1', '2.2.2.2']);
  assert.equal(limited.rateLimited, true);
  assert.equal(calls, 1, 'no further requests after a rate limit');
  mode = 'error';
  await resolver.resolve(['3.3.3.3']);
  const before = calls;
  await resolver.resolve(['3.3.3.3']);
  assert.equal(calls, before, 'a failed address waits before another try');
  mode = 'bogon';
  const bogon = await resolver.resolve(['4.4.4.4']);
  assert.equal(bogon.geo.size, 0);
});

test('geo resolver respects its wall-clock budget', async () => {
  let at = 0;
  const resolver = createGeoResolver({
    now: () => at,
    diskCache: null,
    delayMs: 0,
    budgetMs: 1_000,
    fetchImpl: async (url) => {
      at += 600;
      return Response.json({ ip: String(url), loc: '1,1', country: 'US' });
    },
  });
  const result = await resolver.resolve([
    '1.1.1.1',
    '2.2.2.2',
    '3.3.3.3',
    '4.4.4.4',
  ]);
  assert.equal(result.lookups, 2);
  assert.equal(result.capped, true);
});

test('keyless route: optional feeds are skipped with no request, positions fall back by country', async () => {
  const calls = [];
  const geo = createGeoResolver({
    diskCache: null,
    delayMs: 0,
    fetchImpl: fetcher({ ipinfo: 503 }, calls),
  });
  const request = install({ geo, fetchImpl: fetcher({ ipinfo: 503 }, calls) });
  const res = await request();
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-Feed-Cache'], 'MISS');
  const body = JSON.parse(res.body);
  assert.equal(body.sources.feodo.ok, true);
  assert.equal(body.sources.c2intel.count, 3);
  for (const id of ['urlhaus', 'otx', 'abuseipdb'])
    assert.deepEqual(body.sources[id], {
      ok: true,
      count: 0,
      skipped: 'no key',
    });
  assert.ok(
    !calls.some((c) => /urlhaus|otx\.alienvault|abuseipdb/.test(c.url)),
    'no request is made without a key',
  );
  assert.match(body.caveat, /hosting location, not the actor/);
  assert.equal(body.geo.countryCentroid, 2);
  assert.equal(
    body.geo.dropped,
    2,
    'C2Intel addresses with no country and no lookup',
  );
  assert.equal(body.records.length, 2);
  assert.equal(body.records[0].precision, 'country');
  assert.equal(body.records[0].ip, '50.16.16.211', 'online first');
  assert.deepEqual(body.records[0].sources.sort(), ['c2intel', 'feodo']);
});

test('ipinfo lookups improve positions and are cached across refreshes', async () => {
  let at = 0;
  const calls = [];
  const request = install({
    now: () => at,
    ttlMs: 1_000,
    geo: createGeoResolver({
      now: () => at,
      diskCache: null,
      delayMs: 0,
      fetchImpl: fetcher({}, calls),
    }),
    fetchImpl: fetcher({}, calls),
  });
  const body = JSON.parse((await request()).body);
  assert.equal(body.geo.ipLocated, 2);
  const ashburn = body.records.find((r) => r.ip === '50.16.16.211');
  assert.equal(ashburn.precision, 'ip');
  assert.equal(ashburn.city, 'Ashburn');
  assert.equal(ashburn.org, 'AS14618 Amazon.com, Inc.');
  assert.ok(Math.abs(ashburn.lat - 39.0437) < 0.07);
  const lookups = calls.filter((c) => c.url.includes('ipinfo.io')).length;
  at += 2_000;
  await request();
  assert.equal(
    calls.filter((c) => c.url.includes('ipinfo.io')).length,
    lookups,
    'cached for seven days',
  );
});

test('with keys set, optional feeds are requested with their headers', async () => {
  const calls = [];
  const plan = { urlhaus: URLHAUS, otx: OTX, abuseipdb: ABUSEIPDB, ipinfo: {} };
  const request = install({
    env: {
      URLHAUS_AUTH_KEY: 'secret-urlhaus',
      OTX_API_KEY: 'secret-otx',
      ABUSEIPDB_API_KEY: 'secret-abuseipdb',
    },
    geo: createGeoResolver({
      diskCache: null,
      delayMs: 0,
      fetchImpl: fetcher(plan, calls),
    }),
    fetchImpl: fetcher(plan, calls),
  });
  const body = JSON.parse((await request()).body);
  const haus = calls.find((c) => c.url.includes('urlhaus-api.abuse.ch'));
  assert.equal(haus.options.method, 'POST');
  assert.equal(haus.options.headers['Auth-Key'], 'secret-urlhaus');
  assert.equal(
    haus.url,
    'https://urlhaus-api.abuse.ch/v1/urls/recent/limit/100/',
  );
  const otx = calls.find((c) => c.url.includes('otx.alienvault.com'));
  assert.equal(otx.options.headers['X-OTX-API-KEY'], 'secret-otx');
  assert.match(otx.url, /types=IPv4&modified_since=/);
  const abuse = calls.find((c) => c.url.includes('abuseipdb'));
  assert.equal(abuse.options.headers.Key, 'secret-abuseipdb');
  assert.equal(
    abuse.url,
    'https://api.abuseipdb.com/api/v2/blacklist?confidenceMinimum=90&limit=500',
  );
  assert.deepEqual(
    [
      body.sources.urlhaus.count,
      body.sources.otx.count,
      body.sources.abuseipdb.count,
    ],
    [1, 1, 1],
  );
  assert.ok(
    !JSON.stringify(body).includes('secret-'),
    'keys never reach the response',
  );
});

test('AbuseIPDB is requested at most once per six hours', async () => {
  let at = 0;
  const calls = [];
  const plan = { abuseipdb: ABUSEIPDB, ipinfo: {} };
  const request = install({
    now: () => at,
    ttlMs: 1_000,
    env: { ABUSEIPDB_API_KEY: 'secret-abuseipdb' },
    geo: createGeoResolver({
      now: () => at,
      diskCache: null,
      delayMs: 0,
      fetchImpl: fetcher(plan, calls),
    }),
    fetchImpl: fetcher(plan, calls),
  });
  const abuseCalls = () =>
    calls.filter((c) => c.url.includes('abuseipdb')).length;
  await request();
  at += 3_600_000;
  const again = JSON.parse((await request()).body);
  assert.equal(abuseCalls(), 1);
  assert.equal(again.sources.abuseipdb.count, 1, 'the held result is reused');
  at += 6 * 3_600_000;
  await request();
  assert.equal(abuseCalls(), 2);
});

test('a failed source keeps its last good records; total failure serves STALE or a 502', async () => {
  let at = 0;
  const plan = { ipinfo: {} };
  const geo = () =>
    createGeoResolver({
      now: () => at,
      diskCache: null,
      delayMs: 0,
      fetchImpl: fetcher(plan),
    });
  const request = install({
    now: () => at,
    ttlMs: 1_000,
    geo: geo(),
    fetchImpl: fetcher(plan),
  });
  await request();
  plan.feodo = 500;
  at += 2_000;
  const partial = JSON.parse((await request()).body);
  assert.equal(partial.sources.feodo.ok, false);
  assert.equal(partial.sources.feodo.stale, true);
  assert.equal(partial.sources.feodo.count, 2);
  assert.ok(partial.records.some((r) => r.source === 'feodo'));

  plan.c2intel = new Error('network down');
  at += 2_000;
  const stillUp = await request();
  assert.equal(stillUp.statusCode, 200);

  const cold = install({
    fetchImpl: fetcher({ feodo: 500, c2intel: 500 }),
    geo: geo(),
  });
  const res = await cold();
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'cyber-threats_unavailable',
  });
});

test('query strings and non-GET methods are rejected; hooks return nothing', async () => {
  const calls = [];
  const request = install({ fetchImpl: fetcher({}, calls) });
  assert.equal((await request('/?ip=1.1.1.1')).statusCode, 400);
  assert.equal((await request('/', 'POST')).statusCode, 405);
  assert.equal(calls.length, 0);
  const plugin = cyberThreatsProxy();
  const server = { middlewares: { use: () => () => {} } };
  assert.equal(plugin.configureServer(server), undefined);
  assert.equal(plugin.configurePreviewServer(server), undefined);
  const preview = install(
    {
      fetchImpl: fetcher({ ipinfo: {} }),
      geo: createGeoResolver({
        diskCache: null,
        delayMs: 0,
        fetchImpl: fetcher({ ipinfo: {} }),
      }),
    },
    true,
  );
  assert.equal((await preview()).statusCode, 200);
});
