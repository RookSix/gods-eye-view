import {
  boundedText,
  validCoordinate,
  validateEnvelope,
} from '../feedOverlay/source.js';

export const AIRPORT_DELAYS_LAYER_ID = 'airport-delays';
export const AIRPORT_DELAYS_URL = 'https://nasstatus.faa.gov/';
export const AIRPORT_DELAYS_ATTRIBUTION =
  'FAA National Airspace System Status (US government work). Airport positions: OurAirports (public domain).';
export const AIRPORT_DELAYS_CAVEAT =
  'FAA NAS status for US airports only; check the airline for your flight.';

/** Severity classes: closure/ground stop red, ground delay orange, delay yellow. */
export const LEVEL_COLORS = Object.freeze({
  red: '#ff3b30',
  orange: '#ff8a1f',
  yellow: '#ffd23f',
  grey: '#8a94a3',
});

export const PROGRAM_KINDS = Object.freeze({
  closure: { label: 'Airport closure', short: 'closure' },
  'ground-stop': { label: 'Ground stop', short: 'ground stop' },
  gdp: { label: 'Ground delay program', short: 'GDP' },
  afp: { label: 'Airspace flow program', short: 'AFP' },
  delay: { label: 'Arrival/departure delay', short: 'delay' },
  deicing: { label: 'De-icing', short: 'de-icing' },
  other: { label: 'Other restriction', short: 'restriction' },
});

const MAX_RECORDS = 400;

const minutes = (value) =>
  Number.isFinite(value) && value >= 0 && value < 100_000 ? value : null;

function validateProgram(raw) {
  if (!Object.hasOwn(PROGRAM_KINDS, raw?.kind))
    throw new Error('Malformed airport-delays snapshot');
  return {
    kind: raw.kind,
    reason: boundedText(raw.reason, 240),
    limited: raw.limited === true,
    direction: boundedText(raw.direction, 20),
    avg: boundedText(raw.avg, 60),
    avgMin: minutes(raw.avgMin),
    min: boundedText(raw.min, 60),
    minMin: minutes(raw.minMin),
    max: boundedText(raw.max, 60),
    maxMin: minutes(raw.maxMin),
    trend: boundedText(raw.trend, 40),
    start: boundedText(raw.start, 60),
    reopen: boundedText(raw.reopen, 60),
    end: boundedText(raw.end, 60),
  };
}

/** Validate the `/api/airport-delays` response before anything is drawn. */
export function validateAirportDelaysSnapshot(payload) {
  const envelope = validateEnvelope(payload, 'airport-delays');
  if (payload.records.length > MAX_RECORDS)
    throw new Error('Malformed airport-delays snapshot');
  const seen = new Set();
  const records = payload.records.map((raw) => {
    if (
      typeof raw?.id !== 'string' ||
      seen.has(raw.id) ||
      !Object.hasOwn(LEVEL_COLORS, raw.level) ||
      !Object.hasOwn(PROGRAM_KINDS, raw.topKind) ||
      !Array.isArray(raw.programs) ||
      raw.programs.length === 0 ||
      raw.programs.length > 12
    )
      throw new Error('Malformed airport-delays snapshot');
    seen.add(raw.id);
    validCoordinate(raw.lon, raw.lat, 'airport-delays');
    return {
      id: raw.id.slice(0, 8),
      code: boundedText(raw.code, 5) || raw.id.slice(0, 5),
      name: boundedText(raw.name, 100) || raw.id,
      lat: raw.lat,
      lon: raw.lon,
      level: raw.level,
      rank: Number.isFinite(raw.rank) ? raw.rank : 0,
      topKind: raw.topKind,
      programs: raw.programs.map(validateProgram),
    };
  });
  return {
    ...envelope,
    attribution: AIRPORT_DELAYS_ATTRIBUTION,
    updateTime: boundedText(payload.updateTime, 60),
    unmatched: Number.isFinite(payload.unmatched) ? payload.unmatched : 0,
    withoutAirport: Number.isFinite(payload.withoutAirport)
      ? payload.withoutAirport
      : 0,
    records,
  };
}
