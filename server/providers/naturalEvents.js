import {
  createCachedJsonRoute,
  fetchUpstream,
} from './common/cachedJsonRoute.js';
import { readResponseJsonCapped } from './common/http.js';

const GDACS_URL =
  'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?' +
  'eventlist=EQ;TC;FL;VO;DR;WF&alertlevel=green;orange;red';
const EONET_URL =
  'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30';
const MIB = 1024 * 1024;
const MAX_RECORDS = 1500;
export const NATURAL_EVENTS_TTL_MS = 10 * 60_000;

export const ATTRIBUTION =
  'GDACS (EC JRC / UN OCHA) and NASA EONET; event positions are approximate.';

const GDACS_KINDS = Object.freeze({
  TC: 'storm',
  FL: 'flood',
  VO: 'volcano',
  DR: 'drought',
  WF: 'wildfire',
});
const EONET_KINDS = Object.freeze({
  wildfires: 'wildfire',
  volcanoes: 'volcano',
  floods: 'flood',
  drought: 'drought',
  severeStorms: 'storm',
  seaLakeIce: 'ice',
  dustHaze: 'dust',
  landslides: 'landslide',
  snow: 'snow',
  tempExtremes: 'temperature',
  waterColor: 'other',
  manmade: 'other',
});
const GDACS_LABELS = Object.freeze({
  TC: 'Tropical cyclone',
  FL: 'Flood',
  VO: 'Volcano',
  DR: 'Drought',
  WF: 'Wildfire',
});

/** Printable single-line text; markup and control characters are dropped. */
function text(value, max = 160) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const clean = String(value)
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.slice(0, max) : null;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function coordinate(lon, lat) {
  const x = finite(lon);
  const y = finite(lat);
  if (x === null || y === null || Math.abs(x) > 180 || Math.abs(y) > 90)
    return null;
  return { lon: x, lat: y };
}

/** https links only, optionally pinned to one origin. */
function link(value, origin = null) {
  if (typeof value !== 'string' || value.length > 400) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (origin && url.origin !== origin)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/** GDACS dates carry no zone; they are UTC. */
function gdacsTime(value) {
  if (typeof value !== 'string') return null;
  const stamp = Date.parse(
    /Z|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`,
  );
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

function isoTime(value) {
  if (typeof value !== 'string') return null;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

/**
 * Normalise a GDACS event list. Earthquakes are dropped: the USGS earthquakes
 * layer already covers them with better coverage and latency. Tropical cyclones
 * are kept, labelled by source, because the cyclone layer is NHC/CPHC only.
 * @param {object} payload GDACS GeoJSON FeatureCollection.
 * @returns {Array<object>}
 */
export function parseGdacs(payload) {
  if (!Array.isArray(payload?.features)) throw new Error('invalid_gdacs');
  const seen = new Set();
  const records = [];
  for (const feature of payload.features) {
    const p = feature?.properties;
    const type = typeof p?.eventtype === 'string' ? p.eventtype : null;
    if (!type || !Object.hasOwn(GDACS_KINDS, type)) continue;
    if (feature.geometry?.type !== 'Point') continue;
    const at = coordinate(
      feature.geometry.coordinates?.[0],
      feature.geometry.coordinates?.[1],
    );
    const eventId = finite(p.eventid);
    if (!at || eventId === null) continue;
    const id = `gdacs:${type}:${eventId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const alert = String(p.alertlevel || '').toLowerCase();
    const label = GDACS_LABELS[type];
    records.push({
      id,
      source: 'gdacs',
      kind: GDACS_KINDS[type],
      category: label,
      title: text(p.name) || text(p.description) || text(p.eventname) || label,
      lat: at.lat,
      lon: at.lon,
      time: gdacsTime(p.fromdate),
      endTime: gdacsTime(p.todate),
      alert: ['green', 'orange', 'red'].includes(alert) ? alert : null,
      severity: text(p.severitydata?.severitytext, 200),
      magnitude:
        finite(p.severitydata?.severity) === null
          ? null
          : {
              value: finite(p.severitydata.severity),
              unit: text(p.severitydata.severityunit, 16),
            },
      country: text(p.country, 120),
      url:
        link(p.url?.report, 'https://www.gdacs.org') ||
        link(p.url?.details, 'https://www.gdacs.org'),
    });
    if (records.length >= MAX_RECORDS) break;
  }
  return records;
}

/** Mean of a polygon's exterior ring, unwrapped across the antimeridian. */
export function polygonCentroid(rings) {
  const ring = Array.isArray(rings?.[0]) ? rings[0] : null;
  if (!ring || ring.length < 3) return null;
  const points = ring.slice(
    0,
    ring[0]?.[0] === ring.at(-1)?.[0] ? -1 : ring.length,
  );
  let lonSum = 0;
  let latSum = 0;
  let count = 0;
  const base = finite(points[0]?.[0]);
  if (base === null) return null;
  for (const point of points) {
    let lon = finite(point?.[0]);
    const lat = finite(point?.[1]);
    if (lon === null || lat === null) return null;
    while (lon - base > 180) lon -= 360;
    while (lon - base < -180) lon += 360;
    lonSum += lon;
    latSum += lat;
    count++;
  }
  if (!count) return null;
  let lon = lonSum / count;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return coordinate(lon, latSum / count);
}

function latestGeometry(geometry) {
  if (!Array.isArray(geometry)) return null;
  let best = null;
  let bestAt = -Infinity;
  for (const item of geometry) {
    const stamp = Date.parse(item?.date);
    const at =
      item?.type === 'Point'
        ? coordinate(item.coordinates?.[0], item.coordinates?.[1])
        : item?.type === 'Polygon'
          ? polygonCentroid(item.coordinates)
          : null;
    if (!at) continue;
    const order = Number.isFinite(stamp) ? stamp : -Infinity;
    // Equal or missing dates keep the later list entry; EONET lists oldest first.
    if (order >= bestAt) {
      bestAt = order;
      best = { at, item, stamp: Number.isFinite(stamp) ? stamp : null };
    }
  }
  return best;
}

/**
 * Normalise EONET v3 open events to one record each at their latest position.
 * Earthquake events are dropped (USGS layer); severe storms stay and are
 * styled as storms, distinct from the NHC cyclone layer.
 * @param {object} payload EONET v3 /events response.
 * @returns {Array<object>}
 */
export function parseEonet(payload) {
  if (!Array.isArray(payload?.events)) throw new Error('invalid_eonet');
  const seen = new Set();
  const records = [];
  for (const event of payload.events) {
    const eventId = text(event?.id, 40);
    if (!eventId || seen.has(eventId)) continue;
    const category = Array.isArray(event.categories)
      ? event.categories[0]
      : null;
    const categoryId = text(category?.id, 40);
    if (categoryId === 'earthquakes') continue;
    const latest = latestGeometry(event.geometry);
    if (!latest) continue;
    seen.add(eventId);
    const magnitude = finite(latest.item.magnitudeValue);
    records.push({
      id: `eonet:${eventId}`,
      source: 'eonet',
      kind: Object.hasOwn(EONET_KINDS, categoryId)
        ? EONET_KINDS[categoryId]
        : 'other',
      category: text(category?.title, 60) || 'Natural event',
      title: text(event.title) || 'Natural event',
      lat: latest.at.lat,
      lon: latest.at.lon,
      time: latest.stamp === null ? null : new Date(latest.stamp).toISOString(),
      endTime: isoTime(event.closed),
      alert: null,
      severity: null,
      magnitude:
        magnitude === null
          ? null
          : { value: magnitude, unit: text(latest.item.magnitudeUnit, 16) },
      country: null,
      url:
        link(event.sources?.[0]?.url) ||
        link(event.link, 'https://eonet.gsfc.nasa.gov'),
    });
    if (records.length >= MAX_RECORDS) break;
  }
  return records;
}

/**
 * GDACS + EONET natural-event feed. Each source fails independently: a failed
 * source keeps its previous records (marked stale in `sources`), and the route
 * only fails when neither source has ever produced data.
 */
export function naturalEventsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  ttlMs = NATURAL_EVENTS_TTL_MS,
  timeoutMs = 25_000,
} = {}) {
  const sources = [
    {
      id: 'gdacs',
      url: GDACS_URL,
      cap: 6 * MIB,
      accept: 'application/geo+json,application/json',
      parse: parseGdacs,
    },
    {
      id: 'eonet',
      url: EONET_URL,
      cap: 12 * MIB,
      accept: 'application/json',
      parse: parseEonet,
    },
  ];
  async function load({ signal, previous }) {
    const settled = await Promise.allSettled(
      sources.map(async (source) => {
        const response = await fetchUpstream(fetchImpl, source.url, {
          signal,
          accept: source.accept,
        });
        const json = await readResponseJsonCapped(response, source.cap, signal);
        return source.parse(json);
      }),
    );
    const status = {};
    const records = [];
    settled.forEach((result, index) => {
      const { id } = sources[index];
      if (result.status === 'fulfilled') {
        status[id] = { ok: true, count: result.value.length };
        records.push(...result.value);
        return;
      }
      const kept = (previous?.records || []).filter((r) => r.source === id);
      status[id] = {
        ok: false,
        stale: kept.length > 0,
        count: kept.length,
        error: String(result.reason?.message || 'unavailable').slice(0, 80),
      };
      records.push(...kept);
    });
    // Nothing fresh from either source: let the route serve its last good body.
    if (settled.every((r) => r.status === 'rejected'))
      throw new Error('natural_events_unavailable');
    return {
      source: 'GDACS + NASA EONET',
      attribution: ATTRIBUTION,
      sources: status,
      records,
    };
  }
  return createCachedJsonRoute({
    name: 'natural-events',
    route: '/api/natural-events',
    ttlMs,
    timeoutMs,
    load,
    now,
  });
}
