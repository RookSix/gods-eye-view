import fs from 'node:fs/promises';
import path from 'node:path';
import {
  GEV_USER_AGENT,
  createCachedJsonRoute,
} from './common/cachedJsonRoute.js';
import { cleanText, finiteNumber, round } from './common/feedText.js';
import {
  readResponseJsonCapped,
  readResponseTextCapped,
} from './common/http.js';

const FEODO_URL = 'https://feodotracker.abuse.ch/downloads/ipblocklist.json';
const C2INTEL_URL =
  'https://raw.githubusercontent.com/drb-ra/C2IntelFeeds/master/feeds/IPC2s-30day.csv';
const URLHAUS_URL = 'https://urlhaus-api.abuse.ch/v1/urls/recent/limit/100/';
const OTX_URL = 'https://otx.alienvault.com/api/v1/indicators/export';
const ABUSEIPDB_URL =
  'https://api.abuseipdb.com/api/v2/blacklist?confidenceMinimum=90&limit=500';
const IPINFO_URL = (ip) => `https://ipinfo.io/${ip}/json`;

const MIB = 1024 * 1024;
const HOUR_MS = 3600_000;
export const CYBER_THREATS_TTL_MS = HOUR_MS;
export const GEO_CACHE_TTL_MS = 7 * 24 * HOUR_MS;
/** Hard ceiling on new ipinfo lookups in one refresh. */
export const GEO_LOOKUPS_PER_REFRESH = 150;
/** Wall-clock ceiling on the lookups, so a refresh answers in bounded time. */
export const GEO_LOOKUP_BUDGET_MS = 20_000;
export const GEO_LOOKUP_DELAY_MS = 120;
const GEO_CACHE_LIMIT = 20_000;
const MAX_RECORDS = 2_500;
const OTX_LIMIT = 300;

export const ATTRIBUTION =
  'abuse.ch Feodo Tracker (CC0), C2IntelFeeds (community, terms not verified), optional abuse.ch URLhaus, AlienVault OTX and AbuseIPDB with the operator’s own keys. IP geolocation: ipinfo.io. Locations show hosting infrastructure, not the actor.';
export const CAVEAT = 'IP geolocation shows hosting location, not the actor.';

const COUNTRIES_FILE = new URL(
  '../../src/data/local_data/natural_earth/countries.json',
  import.meta.url,
);

/** Optional sources: env key, request cadence floor and how the key is sent. */
export const OPTIONAL_SOURCES = Object.freeze({
  urlhaus: { env: 'URLHAUS_AUTH_KEY', minIntervalMs: HOUR_MS },
  otx: { env: 'OTX_API_KEY', minIntervalMs: HOUR_MS },
  // The free AbuseIPDB blacklist allows very few requests per day.
  abuseipdb: { env: 'ABUSEIPDB_API_KEY', minIntervalMs: 6 * HOUR_MS },
});

/* -- indicators ---------------------------------------------------------- */

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;

/** A routable unicast address string (v4 or v6), else null. */
export function publicIp(value) {
  const ip = typeof value === 'string' ? value.trim() : '';
  if (IPV4.test(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
      return null;
    return ip;
  }
  if (IPV6.test(ip) && ip.includes(':') && ip.split(':').length <= 8) {
    const lower = ip.toLowerCase();
    if (
      lower === '::' ||
      lower === '::1' ||
      /^f[cdef][0-9a-f]{0,2}:/.test(lower) ||
      lower.startsWith('ff')
    )
      return null;
    return lower;
  }
  return null;
}

const country = (value) => {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{2}$/.test(code) ? code : null;
};

/** A short date/time string the client can parse, or null. */
const dateText = (value) => {
  const text = cleanText(value, 32);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
};

/** abuse.ch Feodo Tracker blocklist (JSON array). */
export function parseFeodo(json) {
  const list = Array.isArray(json) ? json : json?.blocklist;
  if (!Array.isArray(list)) throw new Error('invalid_feodo');
  const records = [];
  for (const row of list) {
    const ip = publicIp(row?.ip_address);
    if (!ip) continue;
    const asn = finiteNumber(row.as_number);
    records.push({
      ip,
      source: 'feodo',
      category: 'botnet-c2',
      family: cleanText(row.malware, 40) || 'Botnet C2',
      port: Number.isInteger(row.port) ? row.port : null,
      status: row.status === 'online' ? 'online' : 'offline',
      hostname: cleanText(row.hostname, 120),
      asn: asn === null ? null : `AS${asn}`,
      asName: cleanText(row.as_name, 80),
      country: country(row.country),
      firstSeen: dateText(row.first_seen),
      lastSeen: dateText(row.last_online),
      url: 'https://feodotracker.abuse.ch/browse/',
    });
  }
  return records;
}

const FRAMEWORK_NAMES = Object.freeze({
  cobaltstrike: 'Cobalt Strike',
  metasploit: 'Metasploit',
  sliver: 'Sliver',
  havoc: 'Havoc',
  brute: 'Brute Ratel',
  bruteratel: 'Brute Ratel',
  mythic: 'Mythic',
});

/** "Possible Cobaltstrike C2 IP" to a display framework name. */
export function c2Framework(description) {
  const base = String(description || '')
    .replace(/^possible\s+/i, '')
    .replace(/\s*c2(?:\s+ip)?\s*$/i, '')
    .trim();
  const key = base.toLowerCase().replace(/[^a-z]/g, '');
  return FRAMEWORK_NAMES[key] || cleanText(base, 40) || 'C2 server';
}

/** C2IntelFeeds `ip,ioc` rows; `#` lines are the header and comments. */
export function parseC2Intel(csv) {
  const records = [];
  for (const line of String(csv).split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const comma = line.indexOf(',');
    const ip = publicIp(comma < 0 ? line : line.slice(0, comma));
    if (!ip) continue;
    records.push({
      ip,
      source: 'c2intel',
      category: 'c2-framework',
      family: c2Framework(comma < 0 ? '' : line.slice(comma + 1)),
      port: null,
      status: null,
      hostname: null,
      asn: null,
      asName: null,
      country: null,
      firstSeen: null,
      lastSeen: null,
      url: 'https://github.com/drb-ra/C2IntelFeeds',
    });
  }
  return records;
}

/** abuse.ch URLhaus recent URLs, keeping only those hosted on a bare IP. */
export function parseUrlhaus(json) {
  if (!Array.isArray(json?.urls)) throw new Error('invalid_urlhaus');
  const records = [];
  for (const row of json.urls) {
    let port = null;
    let host = row?.host;
    try {
      const parsed = new URL(String(row?.url));
      host = host || parsed.hostname.replace(/^\[|\]$/g, '');
      port = parsed.port ? Number(parsed.port) : null;
    } catch {
      /* keep the host field */
    }
    const ip = publicIp(host);
    if (!ip) continue;
    const reference = String(row.urlhaus_reference || '');
    records.push({
      ip,
      source: 'urlhaus',
      category: 'malware-url',
      family:
        cleanText(Array.isArray(row.tags) ? row.tags[0] : null, 40) ||
        cleanText(row.threat, 40) ||
        'Malware URL',
      port,
      status: row.url_status === 'online' ? 'online' : 'offline',
      hostname: null,
      asn: null,
      asName: null,
      country: null,
      firstSeen: dateText(row.date_added),
      lastSeen: dateText(row.date_added),
      url: reference.startsWith('https://urlhaus.abuse.ch/')
        ? reference
        : 'https://urlhaus.abuse.ch/',
    });
  }
  return records;
}

/** AlienVault OTX IPv4 export; tolerant of `results` or `indicators` lists. */
export function parseOtx(json) {
  const list = Array.isArray(json)
    ? json
    : json?.results || json?.indicators || null;
  if (!Array.isArray(list)) throw new Error('invalid_otx');
  const records = [];
  for (const row of list) {
    const ip = publicIp(row?.indicator);
    if (!ip) continue;
    records.push({
      ip,
      source: 'otx',
      category: 'otx',
      family:
        cleanText(row.title, 60) ||
        cleanText(row.description, 60) ||
        'OTX indicator',
      port: null,
      status: null,
      hostname: null,
      asn: null,
      asName: null,
      country: null,
      firstSeen: dateText(row.created),
      lastSeen: dateText(row.modified) || dateText(row.created),
      url: `https://otx.alienvault.com/indicator/ip/${encodeURIComponent(ip)}`,
    });
    if (records.length >= OTX_LIMIT) break;
  }
  return records;
}

/** AbuseIPDB blacklist (`data[]`). */
export function parseAbuseIpdb(json) {
  if (!Array.isArray(json?.data)) throw new Error('invalid_abuseipdb');
  const records = [];
  for (const row of json.data) {
    const ip = publicIp(row?.ipAddress);
    if (!ip) continue;
    const score = finiteNumber(row.abuseConfidenceScore);
    records.push({
      ip,
      source: 'abuseipdb',
      category: 'abuse',
      family: score === null ? 'Reported abuse' : `Abuse score ${score}`,
      port: null,
      status: null,
      hostname: null,
      asn: null,
      asName: null,
      country: country(row.countryCode),
      firstSeen: null,
      lastSeen: dateText(row.lastReportedAt),
      url: `https://www.abuseipdb.com/check/${encodeURIComponent(ip)}`,
    });
  }
  return records;
}

/* -- geography ----------------------------------------------------------- */

/**
 * Country centroids from the bundled Natural Earth admin-0 pack: the centre of
 * each country's largest part. Rings are delta-encoded integers.
 * @param {object} pack Parsed `countries.json`.
 * @returns {Map<string, {lat:number, lon:number}>} Keyed by ISO 3166-1 alpha-2.
 */
export function countryCentroids(pack) {
  if (!Array.isArray(pack?.features)) throw new Error('invalid_countries');
  const factor = 10 ** (pack.meta?.decimals ?? 3);
  const decode = (encoded) => {
    const ring = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i + 1 < encoded.length; i += 2) {
      x += encoded[i];
      y += encoded[i + 1];
      ring.push([x / factor, y / factor]);
    }
    return ring;
  };
  const centroids = new Map();
  for (const feature of pack.features) {
    const code = country(feature?.iso2);
    if (!code || centroids.has(code) || !Array.isArray(feature.polygons))
      continue;
    let best = null;
    for (const polygon of feature.polygons) {
      const ring = Array.isArray(polygon?.[0]) ? decode(polygon[0]) : [];
      if (ring.length < 3) continue;
      const lons = ring.map((p) => p[0]);
      const lats = ring.map((p) => p[1]);
      const west = Math.min(...lons);
      const east = Math.max(...lons);
      const south = Math.min(...lats);
      const north = Math.max(...lats);
      const area = (east - west) * (north - south);
      if (!best || area > best.area)
        best = {
          area,
          lon: (west + east) / 2,
          lat: (south + north) / 2,
        };
    }
    if (best)
      centroids.set(code, { lat: round(best.lat, 3), lon: round(best.lon, 3) });
  }
  return centroids;
}

export async function loadCountryCentroids(file = COUNTRIES_FILE) {
  return countryCentroids(JSON.parse(await fs.readFile(file, 'utf8')));
}

/** Stable 0..1 values from an address, for deterministic spreading. */
function hashUnit(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = (h >>> 0) / 4294967296;
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  return [a, (h >>> 0) / 4294967296];
}

/**
 * Spread co-located points on a deterministic disc around their anchor so
 * many indicators at one place stay individually visible and pickable.
 * @param {number} radiusDeg Maximum offset in degrees.
 */
export function jitterPoint(ip, lat, lon, radiusDeg) {
  const [u, v] = hashUnit(ip);
  const r = radiusDeg * Math.sqrt(u);
  const angle = v * 2 * Math.PI;
  const outLat = Math.max(-85, Math.min(85, lat + r * Math.sin(angle)));
  const cos = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  let outLon = lon + (r * Math.cos(angle)) / cos;
  if (outLon > 180) outLon -= 360;
  if (outLon < -180) outLon += 360;
  return { lat: round(outLat, 3), lon: round(outLon, 3) };
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** On-disk IP geolocation cache (7 days), best effort. */
export function createGeoDiskCache({
  file = path.join(process.cwd(), '.gev-cache', 'cyber-geo.json'),
} = {}) {
  return {
    async read() {
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        return parsed && typeof parsed.entries === 'object'
          ? parsed.entries
          : {};
      } catch {
        return {};
      }
    },
    async write(entries) {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify({ entries }));
      } catch {
        /* the cache is an optimisation only */
      }
    },
  };
}

/**
 * Server-side IP geolocation: a 7-day cache (memory, mirrored to disk), then
 * sequential ipinfo.io lookups capped per refresh and by wall-clock budget.
 * The browser never calls ipinfo. A rate limit (429) ends lookups for the
 * refresh; an address that fails is not retried for an hour.
 */
export function createGeoResolver({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  diskCache = createGeoDiskCache(),
  maxLookups = GEO_LOOKUPS_PER_REFRESH,
  budgetMs = GEO_LOOKUP_BUDGET_MS,
  delayMs = GEO_LOOKUP_DELAY_MS,
} = {}) {
  /** @type {Map<string, object>} */
  const cache = new Map();
  const failed = new Map();
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const saved = diskCache ? await diskCache.read() : {};
    for (const [ip, entry] of Object.entries(saved)) {
      if (
        publicIp(ip) &&
        Number.isFinite(entry?.lat) &&
        Number.isFinite(entry?.lon) &&
        now() - entry.at < GEO_CACHE_TTL_MS
      )
        cache.set(ip, entry);
    }
  }

  const fresh = (ip) => {
    const entry = cache.get(ip);
    return entry && now() - entry.at < GEO_CACHE_TTL_MS ? entry : null;
  };

  async function lookup(ip, signal) {
    const response = await fetchImpl(IPINFO_URL(ip), {
      signal,
      redirect: 'error',
      headers: { Accept: 'application/json', 'User-Agent': GEV_USER_AGENT },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`ipinfo_http_${response.status}`), {
        status: response.status,
      });
    }
    const json = await readResponseJsonCapped(response, 64 * 1024, signal);
    if (json?.bogon) return null;
    const [lat, lon] = String(json?.loc || '')
      .split(',')
      .map(Number);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      return null;
    return {
      lat: round(lat, 3),
      lon: round(lon, 3),
      country: country(json.country),
      city: cleanText(json.city, 60),
      org: cleanText(json.org, 80),
      at: now(),
    };
  }

  return {
    /**
     * @param {string[]} ips Addresses in priority order.
     * @returns {Promise<{geo:Map<string, object>, lookups:number, capped:boolean, rateLimited:boolean}>}
     */
    async resolve(ips, signal) {
      await ensureLoaded();
      const geo = new Map();
      const pending = [];
      for (const ip of ips) {
        const hit = fresh(ip);
        if (hit) geo.set(ip, hit);
        else if (!(failed.get(ip) > now())) pending.push(ip);
      }
      const started = now();
      let lookups = 0;
      let rateLimited = false;
      for (const ip of pending) {
        if (lookups >= maxLookups || now() - started >= budgetMs) break;
        if (lookups > 0) await sleep(delayMs, signal);
        lookups++;
        try {
          const entry = await lookup(ip, signal);
          if (entry) {
            cache.set(ip, entry);
            geo.set(ip, entry);
          } else failed.set(ip, now() + 24 * HOUR_MS);
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error?.status === 429) {
            rateLimited = true;
            break;
          }
          failed.set(ip, now() + HOUR_MS);
        }
      }
      if (lookups > 0 && diskCache) {
        while (cache.size > GEO_CACHE_LIMIT)
          cache.delete(cache.keys().next().value);
        await diskCache.write(Object.fromEntries(cache));
      }
      return {
        geo,
        lookups,
        capped: pending.length > lookups,
        rateLimited,
      };
    },
  };
}

/* -- assembly ------------------------------------------------------------ */

const SOURCE_RANK = Object.freeze({
  feodo: 0,
  urlhaus: 1,
  c2intel: 2,
  otx: 3,
  abuseipdb: 4,
});

/** One record per address; the richest source supplies the fields. */
export function mergeIndicators(lists) {
  const byIp = new Map();
  for (const record of lists.flat()) {
    const held = byIp.get(record.ip);
    if (!held) {
      byIp.set(record.ip, { ...record, sources: [record.source] });
      continue;
    }
    if (!held.sources.includes(record.source)) held.sources.push(record.source);
    if (SOURCE_RANK[record.source] < SOURCE_RANK[held.source]) {
      const sources = held.sources;
      Object.assign(held, record, {
        country: record.country || held.country,
        sources,
      });
    } else {
      held.country ||= record.country;
    }
  }
  return [...byIp.values()];
}

const priorityOf = (record) =>
  (record.status === 'online' ? 0 : 2) + SOURCE_RANK[record.source] / 10;

/**
 * Attach a position to each indicator: an ipinfo location when known, else its
 * country centroid; indicators with neither are dropped and counted.
 */
export function placeIndicators(indicators, geo, centroids) {
  const placed = [];
  let precise = 0;
  let countryOnly = 0;
  let dropped = 0;
  for (const record of indicators) {
    const hit = geo.get(record.ip);
    let at = null;
    let precision = null;
    let code = record.country;
    if (hit) {
      at = jitterPoint(record.ip, hit.lat, hit.lon, 0.06);
      precision = 'ip';
      code = code || hit.country;
      precise++;
    } else if (code && centroids.has(code)) {
      const c = centroids.get(code);
      at = jitterPoint(record.ip, c.lat, c.lon, 2.2);
      precision = 'country';
      countryOnly++;
    } else {
      dropped++;
      continue;
    }
    placed.push({
      id: `ip:${record.ip}`,
      ...record,
      country: code,
      city: hit?.city ?? null,
      org: hit?.org ?? null,
      lat: at.lat,
      lon: at.lon,
      precision,
    });
  }
  placed.sort(
    (a, b) => priorityOf(a) - priorityOf(b) || a.ip.localeCompare(b.ip),
  );
  return {
    placed: placed.slice(0, MAX_RECORDS),
    precise,
    countryOnly,
    dropped,
  };
}

async function textOf(
  fetchImpl,
  url,
  { signal, accept, cap, headers = {}, method = 'GET' },
) {
  signal?.throwIfAborted();
  const response = await fetchImpl(url, {
    method,
    signal,
    redirect: 'error',
    headers: { Accept: accept, 'User-Agent': GEV_USER_AGENT, ...headers },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error(`upstream_http_${response.status}`), {
      status: response.status,
    });
  }
  return readResponseTextCapped(response, cap, signal);
}

/**
 * Feodo Tracker and C2IntelFeeds C2 indicators (keyless), plus URLhaus, OTX
 * and AbuseIPDB when their API keys are present in the environment. A source
 * without a key is reported `skipped: 'no key'` and never requested.
 */
export function cyberThreatsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
  ttlMs = CYBER_THREATS_TTL_MS,
  timeoutMs = 60_000,
  geo = null,
  centroids = null,
} = {}) {
  let geoResolver = geo;
  let centroidMap = centroids;
  /** Raw indicators per source, kept across refreshes for fallbacks and cadence. */
  const held = new Map();

  const sources = [
    {
      id: 'feodo',
      async fetch(signal) {
        return parseFeodo(
          JSON.parse(
            await textOf(fetchImpl, FEODO_URL, {
              signal,
              accept: 'application/json',
              cap: 4 * MIB,
            }),
          ),
        );
      },
    },
    {
      id: 'c2intel',
      async fetch(signal) {
        return parseC2Intel(
          await textOf(fetchImpl, C2INTEL_URL, {
            signal,
            accept: 'text/csv,text/plain',
            cap: 4 * MIB,
          }),
        );
      },
    },
    {
      id: 'urlhaus',
      async fetch(signal, key) {
        return parseUrlhaus(
          JSON.parse(
            await textOf(fetchImpl, URLHAUS_URL, {
              signal,
              accept: 'application/json',
              cap: 2 * MIB,
              method: 'POST',
              headers: { 'Auth-Key': key },
            }),
          ),
        );
      },
    },
    {
      id: 'otx',
      async fetch(signal, key) {
        const since = new Date(now() - 24 * HOUR_MS).toISOString();
        const url = `${OTX_URL}?types=IPv4&modified_since=${encodeURIComponent(since)}`;
        return parseOtx(
          JSON.parse(
            await textOf(fetchImpl, url, {
              signal,
              accept: 'application/json',
              cap: 4 * MIB,
              headers: { 'X-OTX-API-KEY': key },
            }),
          ),
        );
      },
    },
    {
      id: 'abuseipdb',
      async fetch(signal, key) {
        return parseAbuseIpdb(
          JSON.parse(
            await textOf(fetchImpl, ABUSEIPDB_URL, {
              signal,
              accept: 'application/json',
              cap: 4 * MIB,
              headers: { Key: key },
            }),
          ),
        );
      },
    },
  ];

  async function load({ signal }) {
    geoResolver ??= createGeoResolver({ fetchImpl, now });
    centroidMap ??= await loadCountryCentroids().catch(() => new Map());
    const status = {};
    const lists = [];
    let keylessOk = false;
    for (const source of sources) {
      const optional = OPTIONAL_SOURCES[source.id];
      const key = optional ? String(env[optional.env] || '').trim() : null;
      if (optional && !key) {
        status[source.id] = { ok: true, count: 0, skipped: 'no key' };
        continue;
      }
      const prior = held.get(source.id);
      if (optional && prior && now() - prior.at < optional.minIntervalMs) {
        status[source.id] = { ok: true, count: prior.records.length };
        lists.push(prior.records);
        continue;
      }
      try {
        const records = await source.fetch(signal, key);
        held.set(source.id, { records, at: now() });
        status[source.id] = { ok: true, count: records.length };
        lists.push(records);
        if (!optional) keylessOk = true;
      } catch (error) {
        if (signal?.aborted) throw error;
        const kept = prior?.records || [];
        status[source.id] = {
          ok: false,
          stale: kept.length > 0,
          count: kept.length,
          error: String(error?.message || 'unavailable').slice(0, 60),
        };
        lists.push(kept);
        // A rate limit on the optional AbuseIPDB-style feeds is not retried early.
        if (optional && error?.status === 429)
          held.set(source.id, { records: kept, at: now() });
      }
    }
    if (!keylessOk && !lists.some((list) => list.length))
      throw new Error('cyber_threats_unavailable');

    const indicators = mergeIndicators(lists).sort(
      (a, b) => priorityOf(a) - priorityOf(b) || a.ip.localeCompare(b.ip),
    );
    const resolved = await geoResolver.resolve(
      indicators.map((record) => record.ip),
      signal,
    );
    const { placed, precise, countryOnly, dropped } = placeIndicators(
      indicators,
      resolved.geo,
      centroidMap,
    );
    return {
      source: 'Feodo Tracker + C2IntelFeeds',
      attribution: ATTRIBUTION,
      caveat: CAVEAT,
      sources: status,
      geo: {
        ipLocated: precise,
        countryCentroid: countryOnly,
        dropped,
        lookups: resolved.lookups,
        lookupsCapped: resolved.capped,
        rateLimited: resolved.rateLimited,
      },
      records: placed,
    };
  }

  return createCachedJsonRoute({
    name: 'cyber-threats',
    route: '/api/cyber-threats',
    ttlMs,
    timeoutMs,
    maxStaleMs: 6 * HOUR_MS,
    load,
    now,
  });
}
