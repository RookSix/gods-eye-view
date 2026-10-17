import {
  boundedText,
  validCoordinate,
  validateEnvelope,
} from '../feedOverlay/source.js';

export const NAV_WARNINGS_LAYER_ID = 'nav-warnings';
export const NAV_WARNINGS_ATTRIBUTION =
  'NGA Maritime Safety Information broadcast warnings (US public domain); positions are parsed from free text.';
export const NAV_WARNINGS_URL = 'https://msi.nga.mil/NavWarnings';

export const NAV_WARNING_KINDS = Object.freeze({
  cable: { label: 'Cable operations', color: '#ff9f1c' },
  security: { label: 'Security', color: '#ff3b30' },
  military: { label: 'Military / firing', color: '#ff6f91' },
  hazard: { label: 'Hazard to navigation', color: '#ffd23f' },
  space: { label: 'Space launch / debris', color: '#b388ff' },
  operations: { label: 'Survey / offshore operations', color: '#4cc9f0' },
  aids: { label: 'Aids to navigation', color: '#9be564' },
  other: { label: 'Other', color: '#b0b8c4' },
});

export const CABLE_ACTIVITIES = Object.freeze({
  repair: 'Cable repair',
  laying: 'Cable laying / burial',
  operations: 'Cable operations',
});

const MAX_RECORDS = 2_000;
const MAX_POINTS = 60;
const MAX_SHAPES = 8;

const malformed = () => new Error('Malformed nav-warnings snapshot');

function lonLat(pair) {
  if (!Array.isArray(pair) || pair.length < 2) throw malformed();
  validCoordinate(pair[0], pair[1], 'nav-warnings');
  return [pair[0], pair[1]];
}

/** Validate the `/api/nav-warnings` response before anything is drawn. */
export function validateNavWarningsSnapshot(payload) {
  const envelope = validateEnvelope(payload, 'nav-warnings');
  if (payload.records.length > MAX_RECORDS) throw malformed();
  const seen = new Set();
  const records = payload.records.map((raw) => {
    if (
      typeof raw?.id !== 'string' ||
      seen.has(raw.id) ||
      !Object.hasOwn(NAV_WARNING_KINDS, raw.kind) ||
      !Number.isInteger(raw.number) ||
      !Number.isInteger(raw.year) ||
      !Array.isArray(raw.points) ||
      raw.points.length > MAX_POINTS ||
      !Array.isArray(raw.shapes) ||
      raw.shapes.length > MAX_SHAPES
    )
      throw malformed();
    seen.add(raw.id);
    validCoordinate(raw.lon, raw.lat, 'nav-warnings');
    const shapes = raw.shapes.map((shape) => {
      if (
        (shape?.kind !== 'line' && shape?.kind !== 'area') ||
        !Array.isArray(shape.points) ||
        shape.points.length < 2 ||
        shape.points.length > MAX_POINTS
      )
        throw malformed();
      return { kind: shape.kind, points: shape.points.map(lonLat) };
    });
    return {
      id: raw.id.slice(0, 60),
      year: raw.year,
      number: raw.number,
      navArea: boundedText(raw.navArea, 4),
      areaName: boundedText(raw.areaName, 24),
      subregion: boundedText(raw.subregion, 40),
      place: boundedText(raw.place, 120),
      issued: boundedText(raw.issued, 32),
      authority: boundedText(raw.authority, 120),
      kind: raw.kind,
      cableActivity: Object.hasOwn(CABLE_ACTIVITIES, raw.cableActivity)
        ? raw.cableActivity
        : null,
      text: boundedText(raw.text, 1_400) || '',
      lat: raw.lat,
      lon: raw.lon,
      points: raw.points.map((p) => {
        const [lon, lat] = lonLat([p?.lon, p?.lat]);
        return { lon, lat };
      }),
      shapes,
    };
  });
  return {
    ...envelope,
    attribution: NAV_WARNINGS_ATTRIBUTION,
    total: Number.isFinite(payload.total) ? payload.total : records.length,
    withoutPosition: Number.isFinite(payload.withoutPosition)
      ? payload.withoutPosition
      : 0,
    records,
  };
}

/** `HYDROLANT 928/24`: the name warnings are known by. */
export function warningTitle(record) {
  const area = record.areaName || `NAVAREA ${record.navArea || '?'}`;
  return `${area} ${record.number}/${String(record.year).slice(-2)}`;
}

/** Text excerpt for cards; the first sentence-ish chunk, bounded. */
export function warningExcerpt(record, max = 200) {
  const text = record.text || '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
