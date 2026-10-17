import {
  boundedText,
  validCoordinate,
  validateEnvelope,
} from '../feedOverlay/source.js';

export const RADIATION_LAYER_ID = 'radiation';
export const RADIATION_CAVEAT =
  'Uncalibrated community sensors; not an official alert.';
export const RADIATION_ATTRIBUTION =
  'Safecast (CC0) and US EPA RadNet (public domain). Uncalibrated community sensors; not an official alert.';

export const RADIATION_SOURCES = Object.freeze({
  safecast: {
    label: 'Safecast',
    url: 'https://map.safecast.org/',
  },
  radnet: {
    label: 'EPA RadNet',
    url: 'https://www.epa.gov/radnet',
  },
});

/** Dose-rate bins in µSv/h; each upper bound is exclusive. */
export const DOSE_BINS = Object.freeze([
  { max: 0.2, label: 'Under 0.2 µSv/h', color: '#3ddc84' },
  { max: 0.5, label: '0.2 – 0.5 µSv/h', color: '#ffd23f' },
  { max: 1, label: '0.5 – 1 µSv/h', color: '#ff8a1f' },
  { max: Infinity, label: 'Over 1 µSv/h', color: '#ff3b30' },
]);

export function doseBin(doseUsvh) {
  return DOSE_BINS.find((bin) => doseUsvh < bin.max) || DOSE_BINS.at(-1);
}

/** Validate the `/api/radiation` response before anything is drawn. */
export function validateRadiationSnapshot(payload) {
  const envelope = validateEnvelope(payload, 'radiation');
  if (payload.records.length > 2_500)
    throw new Error('Malformed radiation snapshot');
  const seen = new Set();
  const records = payload.records.map((raw) => {
    if (
      typeof raw?.id !== 'string' ||
      seen.has(raw.id) ||
      !Object.hasOwn(RADIATION_SOURCES, raw.source) ||
      !Number.isFinite(raw.doseUsvh) ||
      raw.doseUsvh < 0
    )
      throw new Error('Malformed radiation snapshot');
    seen.add(raw.id);
    validCoordinate(raw.lon, raw.lat, 'radiation');
    return {
      id: raw.id.slice(0, 80),
      source: raw.source,
      name: boundedText(raw.name, 80) || RADIATION_SOURCES[raw.source].label,
      lat: raw.lat,
      lon: raw.lon,
      doseUsvh: raw.doseUsvh,
      rawValue: Number.isFinite(raw.rawValue) ? raw.rawValue : null,
      rawUnit: boundedText(raw.rawUnit, 12),
      converted: raw.converted === true,
      time: boundedText(raw.time, 32),
      deviceId: Number.isFinite(raw.deviceId) ? raw.deviceId : null,
      status: boundedText(raw.status, 24),
    };
  });
  return {
    ...envelope,
    attribution: RADIATION_ATTRIBUTION,
    conversion: boundedText(payload.conversion, 160),
    records,
  };
}
