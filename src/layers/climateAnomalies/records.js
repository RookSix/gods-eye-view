import {
  boundedText,
  validCoordinate,
  validateEnvelope,
} from '../feedOverlay/source.js';

export const CLIMATE_ANOMALIES_LAYER_ID = 'climate-anomalies';
export const CLIMATE_ATTRIBUTION = 'Open-Meteo.com (ERA5, CC BY 4.0)';
export const CLIMATE_SOURCE_URL = 'https://open-meteo.com/';
export const CLIMATE_METHOD =
  'Last 7 complete days vs the 30 days before them (ERA5 trails real time by about 5 days). Not a 1991-2020 climatology.';

/** Temperature anomaly (°C) at which the diverging colour scale saturates. */
export const CLIMATE_COLOR_SPAN_C = 6;

const STOPS = Object.freeze([
  [-6, [31, 95, 255]],
  [-2, [127, 178, 255]],
  [0, [232, 236, 242]],
  [2, [255, 178, 122]],
  [6, [255, 45, 45]],
]);

/** Diverging blue-white-red colour for a temperature anomaly, as `#rrggbb`. */
export function anomalyColor(tempAnomalyC) {
  const t = Math.max(
    -CLIMATE_COLOR_SPAN_C,
    Math.min(CLIMATE_COLOR_SPAN_C, tempAnomalyC),
  );
  let upper = STOPS.findIndex(([at]) => t <= at);
  if (upper <= 0) upper = 1;
  const [t0, c0] = STOPS[upper - 1];
  const [t1, c1] = STOPS[upper];
  const k = (t - t0) / (t1 - t0);
  return `#${c0
    .map((v, i) =>
      Math.round(v + (c1[i] - v) * k)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** Circle diameter in pixels: larger anomalies read larger. */
export function anomalySize(tempAnomalyC) {
  return 14 + 4 * Math.min(Math.abs(tempAnomalyC), CLIMATE_COLOR_SPAN_C);
}

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

/** Validate the `/api/climate-anomalies` response before anything is drawn. */
export function validateClimateAnomaliesSnapshot(payload) {
  const envelope = validateEnvelope(payload, 'climate-anomalies');
  if (payload.records.length > 64)
    throw new Error('Malformed climate-anomalies snapshot');
  const seen = new Set();
  const records = payload.records.map((raw) => {
    if (
      typeof raw?.id !== 'string' ||
      seen.has(raw.id) ||
      !Number.isFinite(raw.tempAnomalyC) ||
      Math.abs(raw.tempAnomalyC) > 80
    )
      throw new Error('Malformed climate-anomalies snapshot');
    seen.add(raw.id);
    validCoordinate(raw.lon, raw.lat, 'climate-anomalies');
    return {
      id: raw.id.slice(0, 60),
      name: boundedText(raw.name, 60) || 'Region',
      lat: raw.lat,
      lon: raw.lon,
      tempAnomalyC: raw.tempAnomalyC,
      tempRecentC: finiteOrNull(raw.tempRecentC),
      tempBaselineC: finiteOrNull(raw.tempBaselineC),
      precipAnomalyPct: finiteOrNull(raw.precipAnomalyPct),
      precipRecentMm: finiteOrNull(raw.precipRecentMm),
      precipBaselineMm: finiteOrNull(raw.precipBaselineMm),
      recentStart: boundedText(raw.recentStart, 10),
      recentEnd: boundedText(raw.recentEnd, 10),
      baselineStart: boundedText(raw.baselineStart, 10),
      baselineEnd: boundedText(raw.baselineEnd, 10),
    };
  });
  return {
    ...envelope,
    attribution: CLIMATE_ATTRIBUTION,
    method: boundedText(payload.method, 400) || CLIMATE_METHOD,
    records,
  };
}

const signed = (value, digits = 1) =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}`;

/** Short value label for the world overlay, e.g. `+2.1°C · −40%`. */
export function climateLabel(record) {
  const temp = `${signed(record.tempAnomalyC)}°C`;
  return record.precipAnomalyPct === null
    ? temp
    : `${temp} · ${signed(record.precipAnomalyPct, 0)}%`;
}
