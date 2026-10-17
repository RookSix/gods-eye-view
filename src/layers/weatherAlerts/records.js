import {
  boundedText,
  httpsUrl,
  validCoordinate,
  validateEnvelope,
} from '../feedOverlay/source.js';

export const WEATHER_ALERTS_LAYER_ID = 'weather-alerts';
export const WEATHER_ALERTS_CAVEAT =
  'Indicative only: follow official warnings from your national weather service.';
export const WEATHER_ALERTS_ATTRIBUTION =
  'US National Weather Service (public domain), Environment and Climate Change Canada, WMO Severe Weather Information Centre. Indicative only; follow official warnings.';

/** Most to least severe; Minor and Unknown share the grey style. */
export const SEVERITIES = Object.freeze([
  'Extreme',
  'Severe',
  'Moderate',
  'Minor',
  'Unknown',
]);

export const SEVERITY_STYLES = Object.freeze({
  Extreme: { color: '#b84dff', label: 'Extreme' },
  Severe: { color: '#ff8a1f', label: 'Severe' },
  Moderate: { color: '#ffd23f', label: 'Moderate' },
  Minor: { color: '#8a94a3', label: 'Minor' },
  Unknown: { color: '#8a94a3', label: 'Unknown' },
});

export const ALERT_SOURCES = Object.freeze({
  nws: { label: 'US NWS' },
  eccc: { label: 'Environment Canada' },
  wmo: { label: 'WMO SWIC' },
});

const MAX_RECORDS = 1_600;
const MAX_RINGS = 4;
const MAX_RING_VERTICES = 200;
const MAX_TOTAL_VERTICES = 140_000;

export const severityRank = (severity) => {
  const at = SEVERITIES.indexOf(severity);
  return at < 0 ? SEVERITIES.length - 1 : at;
};

function validateRings(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RINGS)
    throw new Error('Malformed weather-alerts snapshot');
  return raw.map((ring) => {
    if (
      !Array.isArray(ring) ||
      ring.length < 3 ||
      ring.length > MAX_RING_VERTICES
    )
      throw new Error('Malformed weather-alerts snapshot');
    return ring.map((point) => {
      if (!Array.isArray(point))
        throw new Error('Malformed weather-alerts snapshot');
      validCoordinate(point[0], point[1], 'weather-alerts');
      return [point[0], point[1]];
    });
  });
}

/** Validate the `/api/weather-alerts` response before anything is drawn. */
export function validateWeatherAlertsSnapshot(payload) {
  const envelope = validateEnvelope(payload, 'weather-alerts');
  if (payload.records.length > MAX_RECORDS)
    throw new Error('Malformed weather-alerts snapshot');
  const seen = new Set();
  let vertices = 0;
  const records = payload.records.map((raw) => {
    if (
      typeof raw?.id !== 'string' ||
      seen.has(raw.id) ||
      !Object.hasOwn(ALERT_SOURCES, raw.source) ||
      !Object.hasOwn(SEVERITY_STYLES, raw.severity)
    )
      throw new Error('Malformed weather-alerts snapshot');
    seen.add(raw.id);
    validCoordinate(raw.lon, raw.lat, 'weather-alerts');
    const rings = validateRings(raw.rings);
    vertices += rings.reduce((sum, ring) => sum + ring.length, 0);
    if (vertices > MAX_TOTAL_VERTICES)
      throw new Error('Malformed weather-alerts snapshot');
    return {
      id: raw.id.slice(0, 80),
      source: raw.source,
      event: boundedText(raw.event, 80) || 'Weather alert',
      severity: raw.severity,
      urgency: boundedText(raw.urgency, 20),
      certainty: boundedText(raw.certainty, 20),
      headline: boundedText(raw.headline, 200),
      area: boundedText(raw.area, 200),
      onset: boundedText(raw.onset, 32),
      expires: boundedText(raw.expires, 32),
      issuer: boundedText(raw.issuer, 100),
      url: httpsUrl(raw.url),
      lat: raw.lat,
      lon: raw.lon,
      areaDeg2: Number.isFinite(raw.areaDeg2) ? raw.areaDeg2 : 0,
      rings,
    };
  });
  const skipped =
    payload.skipped && typeof payload.skipped === 'object'
      ? payload.skipped
      : {};
  const count = (value) => (Number.isFinite(value) ? value : 0);
  return {
    ...envelope,
    attribution: WEATHER_ALERTS_ATTRIBUTION,
    minSeverity: SEVERITIES.includes(payload.minSeverity)
      ? payload.minSeverity
      : 'Moderate',
    skipped: {
      noGeometry: count(skipped.noGeometry),
      filtered: count(skipped.filtered),
      duplicates: count(skipped.duplicates),
      truncated: count(skipped.truncated),
    },
    records,
  };
}
