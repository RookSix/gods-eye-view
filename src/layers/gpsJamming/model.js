import { cellToBoundary, cellToLatLng, isValidCell } from 'h3-js';
import { validateEnvelope } from '../feedOverlay/source.js';

export const GPS_JAMMING_LAYER_ID = 'gps-jamming';
export const GPS_JAMMING_ATTRIBUTION =
  'gpsjam.org (data from ADS-B Exchange / adsb.lol etc.)';

/** gpsjam.org colouring: 2-10% medium, over 10% high. */
export const GPS_JAMMING_LEVELS = Object.freeze({
  medium: { label: 'Medium (2-10% degraded)', color: '#ffd23f', alpha: 0.32 },
  high: { label: 'High (over 10% degraded)', color: '#ff3b30', alpha: 0.45 },
});

/**
 * Outer ring of an H3 cell as flat `[lon, lat, ...]` degrees. Longitudes are
 * unwrapped to stay continuous, so a cell straddling the antimeridian draws as
 * one polygon rather than a sliver across the whole globe.
 * @param {string} hex H3 cell index.
 * @returns {number[]}
 */
export function cellRingDegrees(hex) {
  const boundary = cellToBoundary(hex); // [lat, lng] pairs
  const flat = [];
  let previous = null;
  for (const [lat, lng] of boundary) {
    let lon = lng;
    if (previous !== null) {
      while (lon - previous > 180) lon -= 360;
      while (lon - previous < -180) lon += 360;
    }
    previous = lon;
    flat.push(lon, lat);
  }
  return flat;
}

/** Validate `/api/gps-jamming` and attach each cell's centre. */
export function validateGpsJammingSnapshot(payload) {
  const envelope = validateEnvelope(payload, 'gps-jamming');
  if (
    typeof payload.date !== 'string' ||
    !/^\d{4}-\d\d-\d\d$/.test(payload.date) ||
    payload.records.length > 30_000
  )
    throw new Error('Malformed gps-jamming snapshot');
  const seen = new Set();
  const records = payload.records.map((raw) => {
    if (
      typeof raw?.hex !== 'string' ||
      seen.has(raw.hex) ||
      !isValidCell(raw.hex) ||
      !Object.hasOwn(GPS_JAMMING_LEVELS, raw.level) ||
      !Number.isFinite(raw.ratio) ||
      raw.ratio < 0 ||
      raw.ratio > 1 ||
      !Number.isInteger(raw.good) ||
      !Number.isInteger(raw.bad)
    )
      throw new Error('Malformed gps-jamming snapshot');
    seen.add(raw.hex);
    const [lat, lon] = cellToLatLng(raw.hex);
    return {
      id: raw.hex,
      hex: raw.hex,
      lat,
      lon,
      ratio: raw.ratio,
      level: raw.level,
      good: raw.good,
      bad: raw.bad,
      date: payload.date,
    };
  });
  return {
    ...envelope,
    attribution: GPS_JAMMING_ATTRIBUTION,
    date: payload.date,
    suspect: payload.suspect === true,
    records,
  };
}

const pct = (ratio) => `${Math.round(ratio * 100)}%`;

export function gpsJammingCard(record) {
  const spec = GPS_JAMMING_LEVELS[record.level];
  return {
    title: `GPS interference ${pct(record.ratio)}`,
    lines: [
      `${record.level === 'high' ? 'High' : 'Medium'} · ${record.bad} of ${record.good + record.bad} aircraft reported degraded navigation`,
      `Data day ${record.date} (UTC) · H3 cell ${record.hex}`,
      'Source: gpsjam.org',
    ],
    url: 'https://gpsjam.org/',
    accent: spec.color,
  };
}

export const GPS_JAMMING_LEGEND = Object.freeze(
  Object.values(GPS_JAMMING_LEVELS).map(({ label, color }) => ({
    label,
    color,
  })),
);

export function gpsJammingPriority(record) {
  return record.ratio * 1000 + record.bad;
}

/** Analyst record: plain JSON, no Cesium types. */
export function gpsJammingAnalystRecord(record) {
  return {
    id: record.hex,
    level: record.level,
    ratio: record.ratio,
    badAircraft: record.bad,
    totalAircraft: record.good + record.bad,
    lat: record.lat,
    lon: record.lon,
    date: record.date,
  };
}
