import {
  boundedText,
  httpsUrl,
  validCoordinate,
  validateEnvelope,
} from '../feedOverlay/source.js';

export const NATURAL_EVENTS_LAYER_ID = 'natural-events';

/** Category styling. GDACS tropical cyclones and EONET storms share `storm`. */
export const NATURAL_EVENT_KINDS = Object.freeze({
  wildfire: { label: 'Wildfire', color: '#ff7a1a' },
  volcano: { label: 'Volcano', color: '#ff4d6d' },
  flood: { label: 'Flood', color: '#3da5ff' },
  drought: { label: 'Drought', color: '#d4a24c' },
  storm: { label: 'Storm', color: '#7fe6ed' },
  ice: { label: 'Sea & lake ice', color: '#bfe9ff' },
  dust: { label: 'Dust & haze', color: '#c9a77a' },
  landslide: { label: 'Landslide', color: '#a3764d' },
  snow: { label: 'Snow', color: '#e8f1ff' },
  temperature: { label: 'Temperature extreme', color: '#ff9ec7' },
  other: { label: 'Other event', color: '#b0b8c4' },
});

/** GDACS alert colours; EONET events carry no alert level. */
export const GDACS_ALERT_COLORS = Object.freeze({
  green: '#3ddc84',
  orange: '#ffa63d',
  red: '#ff3b3b',
});
const ALERT_RANK = Object.freeze({ red: 3, orange: 2, green: 1 });
const SOURCE_NAMES = Object.freeze({ gdacs: 'GDACS', eonet: 'NASA EONET' });

const utc = (iso) =>
  iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'time unavailable';

/** Importance for list order, label cohorts and collisions. */
export function naturalEventPriority(record) {
  const alert = ALERT_RANK[record.alert] || 0;
  const recency = record.time ? Date.parse(record.time) / 1e12 : 0;
  return alert * 1000 + (record.source === 'gdacs' ? 100 : 0) + recency;
}

/** Validate the `/api/natural-events` response before anything is drawn. */
export function validateNaturalEventsSnapshot(payload) {
  const envelope = validateEnvelope(payload, 'natural-events');
  if (payload.records.length > 3_000)
    throw new Error('Malformed natural-events snapshot');
  const seen = new Set();
  const records = payload.records.map((raw) => {
    if (
      typeof raw?.id !== 'string' ||
      seen.has(raw.id) ||
      !Object.hasOwn(SOURCE_NAMES, raw.source) ||
      !Object.hasOwn(NATURAL_EVENT_KINDS, raw.kind)
    )
      throw new Error('Malformed natural-events snapshot');
    seen.add(raw.id);
    validCoordinate(raw.lon, raw.lat, 'natural-events');
    return {
      id: raw.id.slice(0, 80),
      source: raw.source,
      kind: raw.kind,
      category:
        boundedText(raw.category, 60) || NATURAL_EVENT_KINDS[raw.kind].label,
      title: boundedText(raw.title, 160) || 'Natural event',
      lat: raw.lat,
      lon: raw.lon,
      time: boundedText(raw.time, 32),
      endTime: boundedText(raw.endTime, 32),
      alert: Object.hasOwn(GDACS_ALERT_COLORS, raw.alert) ? raw.alert : null,
      severity: boundedText(raw.severity, 200),
      magnitude: Number.isFinite(raw.magnitude?.value)
        ? {
            value: raw.magnitude.value,
            unit: boundedText(raw.magnitude.unit, 16),
          }
        : null,
      country: boundedText(raw.country, 120),
      url: httpsUrl(raw.url),
    };
  });
  return { ...envelope, records };
}

/** Ambient name label, only for orange/red GDACS alerts. */
export function naturalEventOverlayEntry(record) {
  if (record.alert !== 'red' && record.alert !== 'orange') return null;
  return {
    variant: 'label',
    title:
      record.title.length > 34 ? `${record.title.slice(0, 33)}…` : record.title,
    accent: GDACS_ALERT_COLORS[record.alert],
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Info card text for one event. */
export function naturalEventCard(record) {
  const kind = NATURAL_EVENT_KINDS[record.kind];
  const lines = [
    `${record.category}${record.alert ? ` · ${record.alert.toUpperCase()} alert` : ''}`,
    `${record.endTime && record.endTime !== record.time ? 'Since' : 'Reported'} ${utc(record.time)}`,
  ];
  if (record.severity) lines.push(record.severity);
  else if (record.magnitude)
    lines.push(
      `Magnitude ${record.magnitude.value}${record.magnitude.unit ? ` ${record.magnitude.unit}` : ''}`,
    );
  if (record.country) lines.push(record.country);
  lines.push(`Source: ${SOURCE_NAMES[record.source]}`);
  return {
    title: record.title,
    lines,
    url: record.url,
    accent: record.alert ? GDACS_ALERT_COLORS[record.alert] : kind.color,
  };
}

export function naturalEventListItem(record) {
  return {
    lead: record.alert ? record.alert.toUpperCase() : record.kind.toUpperCase(),
    text: `${record.title} · ${NATURAL_EVENT_KINDS[record.kind].label}`,
  };
}

export const NATURAL_EVENT_LEGEND = Object.freeze([
  ...Object.entries(NATURAL_EVENT_KINDS)
    .filter(([key]) => key !== 'other')
    .map(([, { label, color: swatch }]) => ({ label, color: swatch })),
  { label: 'Alert: red', color: GDACS_ALERT_COLORS.red },
  { label: 'orange', color: GDACS_ALERT_COLORS.orange },
  { label: 'green', color: GDACS_ALERT_COLORS.green },
]);

/** Analyst record: plain JSON, no Cesium types. */
export function naturalEventAnalystRecord(record) {
  return {
    id: record.id,
    title: record.title,
    category: record.category,
    alert: record.alert,
    source: record.source,
    lat: record.lat,
    lon: record.lon,
    timeMs: record.time ? Date.parse(record.time) : null,
    country: record.country,
  };
}
