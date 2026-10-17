import {
  createCachedJsonRoute,
  fetchUpstream,
} from './common/cachedJsonRoute.js';
import { cleanText, round, validLonLat } from './common/feedText.js';
import {
  readResponseJsonCapped,
  readResponseTextCapped,
} from './common/http.js';
import { childrenNamed, parseXml, textOf } from './common/xml.js';

const NWS_URL = 'https://api.weather.gov/alerts/active?status=actual';
const ECCC_URL =
  'https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=500';
const WMO_URL = 'https://severeweather.wmo.int/json/wmo_all.json';
/** WMO list entries name a CAP document by relative path under this base. */
const WMO_CAP_BASE = 'https://severeweather.wmo.int/v2/cap-alerts/';
const MIB = 1024 * 1024;

export const WEATHER_ALERTS_TTL_MS = 5 * 60_000;
export const SEVERITIES = Object.freeze([
  'Extreme',
  'Severe',
  'Moderate',
  'Minor',
  'Unknown',
]);
/** Alerts below this severity are not drawn (counted as `filtered`). */
export const MIN_SEVERITY = 'Moderate';
export const ECCC_MAX_PAGES = 3;
export const WMO_CAP_FETCH_PER_REFRESH = 30;
export const WMO_CANDIDATES = 80;
const WMO_CAP_CONCURRENCY = 4;
const CAP_TTL_MS = 6 * 3600_000;
const CAP_CACHE_LIMIT = 600;
const MAX_RECORDS = 1500;
/** Whole-response vertex budget: roughly 2 MB of JSON. */
export const MAX_TOTAL_VERTICES = 110_000;
const MAX_RINGS_PER_ALERT = 4;
const MAX_VERTICES_PER_RING = 80;
const SIMPLIFY_DEGREES = 0.015;

export const ATTRIBUTION =
  'US National Weather Service (public domain), Environment and Climate Change Canada (Open Government Licence - Canada), WMO Severe Weather Information Centre (member-issued CAP alerts; terms not verified). Indicative only; follow official warnings.';

const severityRank = (severity) => {
  const at = SEVERITIES.indexOf(severity);
  return at < 0 ? SEVERITIES.length - 1 : at;
};
const passesMinimum = (severity) =>
  severityRank(severity) <= severityRank(MIN_SEVERITY);

/** An ISO-8601 UTC timestamp from a Date-parsable value, or null. */
function isoTime(value, assumeUtc = false) {
  if (typeof value !== 'string' || !value) return null;
  const text =
    assumeUtc && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
  const stamp = Date.parse(text);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

/* -- geometry ------------------------------------------------------------ */

function perpendicularDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + clamped * dx), p[1] - (a[1] + clamped * dy));
}

/** Douglas-Peucker on an open polyline (iterative, so deep inputs are safe). */
export function simplifyLine(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let worst = -1;
    let at = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i], points[first], points[last]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolerance) {
      keep[at] = 1;
      stack.push([first, at], [at, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * A closed-ring-free outline with at most `maxVertices` points: simplified
 * with a growing tolerance, then evenly thinned as a last resort. Returns null
 * for a degenerate ring.
 */
export function simplifyRing(ring, maxVertices = MAX_VERTICES_PER_RING) {
  const points = [];
  for (const raw of ring) {
    const at = validLonLat(raw?.[0], raw?.[1]);
    if (at) points.push([at.lon, at.lat]);
  }
  if (
    points.length > 1 &&
    points[0][0] === points.at(-1)[0] &&
    points[0][1] === points.at(-1)[1]
  )
    points.pop();
  if (points.length < 3) return null;
  let tolerance = SIMPLIFY_DEGREES;
  let out = simplifyLine(points, tolerance);
  for (let pass = 0; out.length > maxVertices && pass < 6; pass++) {
    tolerance *= 2;
    out = simplifyLine(points, tolerance);
  }
  if (out.length > maxVertices) {
    const step = out.length / maxVertices;
    out = Array.from(
      { length: maxVertices },
      (_, i) => out[Math.floor(i * step)],
    );
  }
  out = out.map(([lon, lat]) => [round(lon, 3), round(lat, 3)]);
  return out.length >= 3 ? out : null;
}

function ringBox(ring) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [lon, lat] of ring) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return { west, east, south, north, area: (east - west) * (north - south) };
}

/** Area-weighted centroid of the largest ring, falling back to its box centre. */
export function ringCentroid(ring) {
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const cross = x0 * y1 - x1 * y0;
    twiceArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  const box = ringBox(ring);
  if (Math.abs(twiceArea) < 1e-9)
    return { lon: (box.west + box.east) / 2, lat: (box.south + box.north) / 2 };
  const lon = cx / (3 * twiceArea);
  const lat = cy / (3 * twiceArea);
  // A concave ring can put its centroid outside; keep it inside the box.
  return lon >= box.west &&
    lon <= box.east &&
    lat >= box.south &&
    lat <= box.north
    ? { lon, lat }
    : { lon: (box.west + box.east) / 2, lat: (box.south + box.north) / 2 };
}

/**
 * Outer rings of a GeoJSON Polygon/MultiPolygon, simplified, with the anchor
 * and footprint size the layer needs. Holes are dropped (alerts cover the
 * outline). Returns null when nothing drawable remains.
 */
export function shapeFromGeometry(geometry) {
  let outers = [];
  if (geometry?.type === 'Polygon') outers = [geometry.coordinates?.[0]];
  else if (geometry?.type === 'MultiPolygon')
    outers = (geometry.coordinates || []).map((polygon) => polygon?.[0]);
  return shapeFromRings(outers);
}

export function shapeFromRings(outers) {
  const rings = outers
    .filter(Array.isArray)
    .map((ring) => simplifyRing(ring))
    .filter(Boolean)
    .map((ring) => ({ ring, box: ringBox(ring) }))
    .sort((a, b) => b.box.area - a.box.area)
    .slice(0, MAX_RINGS_PER_ALERT);
  if (!rings.length) return null;
  const anchor = ringCentroid(rings[0].ring);
  return {
    rings: rings.map((entry) => entry.ring),
    lon: round(anchor.lon, 3),
    lat: round(anchor.lat, 3),
    areaDeg2: round(
      rings.reduce((sum, entry) => sum + entry.box.area, 0),
      3,
    ),
  };
}

/* -- NWS ----------------------------------------------------------------- */

const safeApiUrl = (value) => {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === 'api.weather.gov'
      ? url.href
      : null;
  } catch {
    return null;
  }
};

/**
 * Slim NWS active alerts. Zone-only alerts (null geometry) are counted, never
 * resolved: zones are not fetched. Alerts below MIN_SEVERITY are counted too.
 */
export function parseNws(json) {
  if (!Array.isArray(json?.features)) throw new Error('invalid_nws');
  const records = [];
  const seen = new Set();
  let noGeometry = 0;
  let filtered = 0;
  for (const feature of json.features) {
    const p = feature?.properties;
    if (!p) continue;
    const severity = SEVERITIES.includes(p.severity) ? p.severity : 'Unknown';
    if (!passesMinimum(severity)) {
      filtered++;
      continue;
    }
    const shape = feature.geometry ? shapeFromGeometry(feature.geometry) : null;
    if (!shape) {
      noGeometry++;
      continue;
    }
    const rawId = String(p.id || feature.id || '');
    const tail = rawId
      .replace(/^.*urn:oid:(?:2\.49\.0\.1\.840\.0\.)?/, '')
      .slice(-48);
    if (!tail || seen.has(tail)) continue;
    seen.add(tail);
    records.push({
      id: `nws:${tail}`,
      source: 'nws',
      event: cleanText(p.event, 80) || 'Weather alert',
      severity,
      urgency: cleanText(p.urgency, 20),
      certainty: cleanText(p.certainty, 20),
      headline: cleanText(p.headline, 200),
      area: cleanText(p.areaDesc, 200),
      onset: isoTime(p.onset) || isoTime(p.effective),
      expires: isoTime(p.ends) || isoTime(p.expires),
      issuer: cleanText(p.senderName, 80) || cleanText(p.sender, 80),
      url: safeApiUrl(p['@id']),
      ...shape,
    });
  }
  return { records, noGeometry, filtered };
}

/* -- ECCC ---------------------------------------------------------------- */

/** Environment Canada alert type + risk colour on the common four-step scale. */
export function ecccSeverity(type, colour) {
  const kind = String(type || '').toLowerCase();
  const risk = String(colour || '').toLowerCase();
  if (kind === 'warning')
    return risk === 'red'
      ? 'Extreme'
      : risk === 'yellow'
        ? 'Moderate'
        : 'Severe';
  if (kind === 'watch') return 'Moderate';
  if (kind === 'advisory' || kind === 'statement') return 'Minor';
  return 'Unknown';
}

export function parseEccc(json) {
  if (!Array.isArray(json?.features)) throw new Error('invalid_eccc');
  const records = [];
  const seen = new Set();
  let noGeometry = 0;
  let filtered = 0;
  for (const feature of json.features) {
    const p = feature?.properties;
    if (!p) continue;
    if (/ended|cancel/i.test(String(p.status_en || ''))) continue;
    const severity = ecccSeverity(p.alert_type, p.risk_colour_en);
    if (!passesMinimum(severity)) {
      filtered++;
      continue;
    }
    const shape = feature.geometry ? shapeFromGeometry(feature.geometry) : null;
    if (!shape) {
      noGeometry++;
      continue;
    }
    const id = cleanText(feature.id, 80);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = cleanText(p.alert_name_en, 80) || 'Weather alert';
    const place = cleanText(p.feature_name_en, 100);
    records.push({
      id: `eccc:${id}`,
      source: 'eccc',
      event: name.charAt(0).toUpperCase() + name.slice(1),
      severity,
      urgency: null,
      certainty: null,
      headline: cleanText(p.alert_text_en, 200),
      area:
        [place, cleanText(p.province, 4)].filter(Boolean).join(', ') || null,
      onset: isoTime(p.validity_datetime) || isoTime(p.publication_datetime),
      expires: isoTime(p.event_end_datetime) || isoTime(p.expiration_datetime),
      issuer: 'Environment and Climate Change Canada',
      url: 'https://weather.gc.ca/warnings/index_e.html',
      ...shape,
    });
  }
  return { records, noGeometry, filtered };
}

/** The `next` page link, only when it stays on the ECCC API host over https. */
export function ecccNextUrl(json) {
  const href = json?.links?.find?.((link) => link?.rel === 'next')?.href;
  try {
    const url = new URL(String(href));
    return url.protocol === 'https:' && url.hostname === 'api.weather.gc.ca'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/* -- WMO SWIC ------------------------------------------------------------ */

const WMO_SEVERITY = Object.freeze({
  4: 'Extreme',
  3: 'Severe',
  2: 'Moderate',
  1: 'Minor',
});
const WMO_CAP_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

/** US and Canadian members are already drawn from NWS and ECCC. */
const DUPLICATE_ISSUER = /^(us|ca)-/;

/**
 * Candidates from the WMO list: Moderate or worse, not from a member we already
 * read directly, with a usable CAP path. Highest severity and newest first.
 */
export function wmoCandidates(json, limit = WMO_CANDIDATES) {
  if (!Array.isArray(json?.items)) throw new Error('invalid_wmo');
  let duplicates = 0;
  let filtered = 0;
  const picked = [];
  for (const item of json.items) {
    const severity = WMO_SEVERITY[item?.s] || 'Unknown';
    if (!passesMinimum(severity)) {
      filtered++;
      continue;
    }
    const path = [item.capURL, item.url].find(
      (value) =>
        typeof value === 'string' &&
        WMO_CAP_PATH.test(value) &&
        !value.includes('..'),
    );
    if (!path) continue;
    if (DUPLICATE_ISSUER.test(path)) {
      duplicates++;
      continue;
    }
    picked.push({ item, severity, path });
  }
  picked.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      String(b.item.effective || '').localeCompare(
        String(a.item.effective || ''),
      ),
  );
  return { candidates: picked.slice(0, limit), duplicates, filtered };
}

/** CAP circle `lat,lon radiusKm` to a 16-sided outline. */
function circleRing(text) {
  const m = /^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s+([\d.]+)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  const radius = Math.min(Number(m[3]), 1500);
  if (!validLonLat(lon, lat) || !(radius > 0)) return null;
  const dLat = radius / 111.32;
  const dLon =
    radius / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return Array.from({ length: 16 }, (_, i) => {
    const angle = (i / 16) * 2 * Math.PI;
    return [lon + dLon * Math.cos(angle), lat + dLat * Math.sin(angle)];
  });
}

/**
 * Drawable outline from a CAP document: `<polygon>` (lat,lon pairs) and
 * `<circle>` areas. Returns null when the alert names only text areas.
 */
export function parseCapShape(xml) {
  const root = parseXml(xml);
  const rings = [];
  for (const info of childrenNamed(root, 'info'))
    for (const area of childrenNamed(info, 'area')) {
      for (const polygon of childrenNamed(area, 'polygon')) {
        const ring = textOf(polygon)
          .split(/\s+/)
          .map((pair) => pair.split(',').map(Number))
          .filter((pair) => pair.length === 2 && pair.every(Number.isFinite))
          .map(([lat, lon]) => [lon, lat]);
        if (ring.length >= 3) rings.push(ring);
      }
      for (const circle of childrenNamed(area, 'circle')) {
        const ring = circleRing(textOf(circle));
        if (ring) rings.push(ring);
      }
    }
  return shapeFromRings(rings);
}

export function wmoRecord(candidate, shape) {
  const { item, severity } = candidate;
  return {
    // "~" separates an alert id from its parts when the renderer resolves a pick.
    id: `wmo:${(cleanText(item.id, 80) || 'unknown').replaceAll('~', '-')}`,
    source: 'wmo',
    event: cleanText(item.event, 80) || 'Weather alert',
    severity,
    urgency: null,
    certainty: null,
    headline: cleanText(item.headline, 200),
    area: cleanText(item.areaDesc, 200),
    onset: isoTime(item.effective, true) || isoTime(item.sent, true),
    expires: isoTime(item.expires, true),
    issuer: `WMO member ${cleanText(item.mid, 8) || 'unknown'}`,
    url: 'https://severeweather.wmo.int/v2/',
    ...shape,
  };
}

/* -- assembly ------------------------------------------------------------ */

/**
 * Most severe and largest alerts first, cut to the vertex and record budgets.
 * @returns {{records:Array<object>, truncated:number}}
 */
export function fitBudget(records, maxVertices = MAX_TOTAL_VERTICES) {
  const ordered = [...records].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.areaDeg2 - a.areaDeg2 ||
      a.id.localeCompare(b.id),
  );
  const kept = [];
  let vertices = 0;
  for (const record of ordered) {
    const cost = record.rings.reduce((sum, ring) => sum + ring.length, 0);
    if (kept.length >= MAX_RECORDS || vertices + cost > maxVertices) continue;
    vertices += cost;
    kept.push(record);
  }
  return { records: kept, truncated: records.length - kept.length };
}

async function fetchJson(fetchImpl, url, { signal, accept, cap }) {
  const response = await fetchUpstream(fetchImpl, url, { signal, accept });
  return readResponseJsonCapped(response, cap, signal);
}

/**
 * NWS + Environment Canada + WMO SWIC severe weather alerts. Each source fails
 * independently and keeps its previous records; the route only fails when no
 * source has ever produced data.
 */
export function weatherAlertsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  ttlMs = WEATHER_ALERTS_TTL_MS,
  timeoutMs = 45_000,
} = {}) {
  /** WMO CAP shapes by alert id; `shape: null` remembers alerts with no geometry. */
  const capCache = new Map();

  async function loadNws({ signal }) {
    const json = await fetchJson(fetchImpl, NWS_URL, {
      signal,
      accept: 'application/geo+json',
      cap: 16 * MIB,
    });
    return parseNws(json);
  }

  async function loadEccc({ signal }) {
    const records = [];
    let noGeometry = 0;
    let filtered = 0;
    let url = ECCC_URL;
    for (let page = 0; url && page < ECCC_MAX_PAGES; page++) {
      const json = await fetchJson(fetchImpl, url, {
        signal,
        accept: 'application/geo+json,application/json',
        cap: 12 * MIB,
      });
      const parsed = parseEccc(json);
      records.push(...parsed.records);
      noGeometry += parsed.noGeometry;
      filtered += parsed.filtered;
      url = ecccNextUrl(json);
    }
    return { records, noGeometry, filtered };
  }

  async function capShape(candidate, { signal }) {
    const cached = capCache.get(candidate.path);
    if (cached && now() - cached.at < CAP_TTL_MS) return cached.shape;
    try {
      const response = await fetchUpstream(
        fetchImpl,
        `${WMO_CAP_BASE}${candidate.path}`,
        { signal, accept: 'application/xml,text/xml' },
      );
      const shape = parseCapShape(
        await readResponseTextCapped(response, MIB / 2, signal),
      );
      remember(candidate.path, shape);
      return shape;
    } catch (error) {
      if (signal?.aborted) throw error;
      remember(candidate.path, null);
      return null;
    }
  }

  function remember(path, shape) {
    capCache.delete(path);
    capCache.set(path, { shape, at: now() });
    while (capCache.size > CAP_CACHE_LIMIT)
      capCache.delete(capCache.keys().next().value);
  }

  async function loadWmo({ signal: outer }) {
    // The slowest source must not eat the whole refresh budget of the others.
    const signal = AbortSignal.any([outer, AbortSignal.timeout(30_000)]);
    const json = await fetchJson(fetchImpl, WMO_URL, {
      signal,
      accept: 'application/json',
      cap: 12 * MIB,
    });
    const { candidates, duplicates, filtered } = wmoCandidates(json);
    const fresh = (candidate) => {
      const cached = capCache.get(candidate.path);
      return !cached || now() - cached.at >= CAP_TTL_MS;
    };
    // Bounded CAP fetches per refresh; the rest are picked up on later ones.
    const toFetch = candidates
      .filter(fresh)
      .slice(0, WMO_CAP_FETCH_PER_REFRESH);
    for (let i = 0; i < toFetch.length; i += WMO_CAP_CONCURRENCY)
      await Promise.all(
        toFetch
          .slice(i, i + WMO_CAP_CONCURRENCY)
          .map((candidate) => capShape(candidate, { signal })),
      );
    const records = [];
    let noGeometry = 0;
    for (const candidate of candidates) {
      const shape = capCache.get(candidate.path)?.shape;
      if (shape) records.push(wmoRecord(candidate, shape));
      else noGeometry++;
    }
    return { records, noGeometry, filtered, duplicates };
  }

  const sources = [
    { id: 'nws', load: loadNws },
    { id: 'eccc', load: loadEccc },
    { id: 'wmo', load: loadWmo },
  ];

  async function load({ signal, previous }) {
    const settled = await Promise.allSettled(
      sources.map((source) => source.load({ signal })),
    );
    const status = {};
    const merged = [];
    const totals = { noGeometry: 0, filtered: 0, duplicates: 0 };
    settled.forEach((result, index) => {
      const { id } = sources[index];
      if (result.status === 'fulfilled') {
        const value = result.value;
        status[id] = { ok: true, count: value.records.length };
        merged.push(...value.records);
        totals.noGeometry += value.noGeometry || 0;
        totals.filtered += value.filtered || 0;
        totals.duplicates += value.duplicates || 0;
        return;
      }
      const kept = (previous?.records || []).filter((r) => r.source === id);
      status[id] = {
        ok: false,
        stale: kept.length > 0,
        count: kept.length,
        error: String(result.reason?.message || 'unavailable').slice(0, 80),
      };
      merged.push(...kept);
    });
    if (settled.every((r) => r.status === 'rejected'))
      throw new Error('weather_alerts_unavailable');
    const fitted = fitBudget(merged);
    return {
      source: 'NWS + ECCC + WMO SWIC',
      attribution: ATTRIBUTION,
      minSeverity: MIN_SEVERITY,
      sources: status,
      skipped: { ...totals, truncated: fitted.truncated },
      records: fitted.records,
    };
  }

  return createCachedJsonRoute({
    name: 'weather-alerts',
    route: '/api/weather-alerts',
    ttlMs,
    timeoutMs,
    maxStaleMs: 60 * 60_000,
    load,
    now,
  });
}
