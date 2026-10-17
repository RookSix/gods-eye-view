import {
  createCachedJsonRoute,
  fetchUpstream,
} from './common/cachedJsonRoute.js';
import { finiteNumber, round } from './common/feedText.js';
import { readResponseJsonCapped } from './common/http.js';

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
export const CLIMATE_ANOMALIES_TTL_MS = 6 * 3600_000;
/** ERA5 trails real time by about five days. */
export const ERA5_LAG_DAYS = 5;
export const RECENT_DAYS = 7;
export const BASELINE_DAYS = 30;
/** Baselines drier than this (mm/day) make a precipitation percentage noise. */
export const MIN_BASELINE_MM_PER_DAY = 0.3;
const MIN_RECENT_VALUES = 5;
const MIN_BASELINE_VALUES = 20;
const DAY_MS = 86_400_000;

export const ATTRIBUTION =
  'Open-Meteo.com (ERA5, CC BY 4.0): https://open-meteo.com/';

export const METHOD =
  'Last 7 complete days (ERA5 trails real time by about 5 days) compared with the 30 days just before them: temperature difference in °C of daily means, precipitation as the percentage change of the daily average. A short-term recent-vs-preceding comparison, not a 1991-2020 climatology.';

/** Representative regions chosen across every inhabited continent. */
export const CLIMATE_REGIONS = Object.freeze([
  {
    id: 'pacific-northwest',
    name: 'Pacific Northwest',
    lat: 47.61,
    lon: -122.33,
  },
  { id: 'us-southwest', name: 'US Southwest', lat: 33.45, lon: -112.07 },
  { id: 'us-midwest', name: 'US Midwest', lat: 41.88, lon: -87.63 },
  { id: 'central-mexico', name: 'Central Mexico', lat: 19.43, lon: -99.13 },
  {
    id: 'canadian-prairies',
    name: 'Canadian Prairies',
    lat: 49.9,
    lon: -97.14,
  },
  { id: 'amazon-basin', name: 'Amazon basin', lat: -3.12, lon: -60.02 },
  { id: 'pampas', name: 'Argentine Pampas', lat: -34.6, lon: -58.38 },
  { id: 'western-europe', name: 'Western Europe', lat: 48.86, lon: 2.35 },
  { id: 'mediterranean', name: 'Mediterranean', lat: 41.9, lon: 12.5 },
  { id: 'scandinavia', name: 'Scandinavia', lat: 59.33, lon: 18.07 },
  { id: 'sahel', name: 'Sahel', lat: 13.51, lon: 2.11 },
  { id: 'east-africa', name: 'East Africa', lat: -1.29, lon: 36.82 },
  { id: 'southern-africa', name: 'Southern Africa', lat: -26.2, lon: 28.05 },
  {
    id: 'arabian-peninsula',
    name: 'Arabian Peninsula',
    lat: 24.71,
    lon: 46.68,
  },
  { id: 'central-asia', name: 'Central Asia', lat: 41.3, lon: 69.24 },
  { id: 'south-asia', name: 'South Asia', lat: 28.61, lon: 77.21 },
  { id: 'southeast-asia', name: 'Southeast Asia', lat: 13.76, lon: 100.5 },
  { id: 'east-asia', name: 'East Asia', lat: 39.9, lon: 116.4 },
  { id: 'siberia', name: 'Siberia', lat: 55.03, lon: 82.92 },
  { id: 'australia', name: 'Eastern Australia', lat: -33.87, lon: 151.21 },
]);

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The calendar windows for a given moment: `recent` is the last 7 complete
 * ERA5 days, `baseline` the 30 days before it.
 * @param {number} nowMs
 */
export function climateWindows(nowMs) {
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const end = today - ERA5_LAG_DAYS * DAY_MS;
  const recentStart = end - (RECENT_DAYS - 1) * DAY_MS;
  const baselineStart = recentStart - BASELINE_DAYS * DAY_MS;
  return {
    start: isoDay(baselineStart),
    end: isoDay(end),
    recentStart: isoDay(recentStart),
    baselineEnd: isoDay(recentStart - DAY_MS),
  };
}

export function archiveUrl(windows, regions = CLIMATE_REGIONS) {
  // Every value is a number, a date or a fixed token, so nothing needs escaping.
  return (
    `${ARCHIVE_URL}?latitude=${regions.map((r) => r.lat).join(',')}` +
    `&longitude=${regions.map((r) => r.lon).join(',')}` +
    `&start_date=${windows.start}&end_date=${windows.end}` +
    '&daily=temperature_2m_mean,precipitation_sum&timezone=UTC'
  );
}

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Compare a recent window with its baseline for one location.
 * @param {{time:string[], temperature_2m_mean:Array<?number>, precipitation_sum:Array<?number>}} daily
 * @param {{recentStart:string, baselineEnd:string}} windows
 * @returns {?{tempAnomalyC:number, tempRecentC:number, tempBaselineC:number, precipAnomalyPct:?number, precipRecentMm:number, precipBaselineMm:number, days:number}}
 */
export function computeAnomaly(daily, windows) {
  const time = daily?.time;
  if (!Array.isArray(time)) return null;
  const temp = daily.temperature_2m_mean;
  const rain = daily.precipitation_sum;
  if (!Array.isArray(temp) || !Array.isArray(rain)) return null;
  const recent = { temp: [], rain: [] };
  const baseline = { temp: [], rain: [] };
  time.forEach((day, i) => {
    const bucket =
      day >= windows.recentStart
        ? recent
        : day <= windows.baselineEnd
          ? baseline
          : null;
    if (!bucket) return;
    const t = finiteNumber(temp[i]);
    const r = finiteNumber(rain[i]);
    if (t !== null) bucket.temp.push(t);
    if (r !== null) bucket.rain.push(r);
  });
  if (
    recent.temp.length < MIN_RECENT_VALUES ||
    baseline.temp.length < MIN_BASELINE_VALUES
  )
    return null;
  const tempRecent = mean(recent.temp);
  const tempBaseline = mean(baseline.temp);
  const rainEnough =
    recent.rain.length >= MIN_RECENT_VALUES &&
    baseline.rain.length >= MIN_BASELINE_VALUES;
  const rainRecent = rainEnough ? mean(recent.rain) : null;
  const rainBaseline = rainEnough ? mean(baseline.rain) : null;
  return {
    tempAnomalyC: round(tempRecent - tempBaseline, 2),
    tempRecentC: round(tempRecent, 2),
    tempBaselineC: round(tempBaseline, 2),
    precipAnomalyPct:
      rainEnough && rainBaseline >= MIN_BASELINE_MM_PER_DAY
        ? Math.round(((rainRecent - rainBaseline) / rainBaseline) * 100)
        : null,
    precipRecentMm: rainEnough ? round(rainRecent * RECENT_DAYS, 1) : null,
    precipBaselineMm: rainEnough ? round(rainBaseline * RECENT_DAYS, 1) : null,
    days: recent.temp.length,
  };
}

/**
 * Turn the (possibly single-location) Open-Meteo response into region records.
 * Locations Open-Meteo could not serve, or with too many gaps, are skipped.
 * @param {object|Array<object>} payload
 * @param {{start:string, end:string, recentStart:string, baselineEnd:string}} windows
 * @param {typeof CLIMATE_REGIONS} [regions]
 */
export function parseClimateAnomalies(
  payload,
  windows,
  regions = CLIMATE_REGIONS,
) {
  const list = Array.isArray(payload) ? payload : [payload];
  if (
    list.length !== regions.length ||
    list.some((item) => typeof item !== 'object' || !item)
  )
    throw new Error('invalid_open_meteo');
  const records = [];
  regions.forEach((region, index) => {
    const item = list[index];
    const anomaly = item ? computeAnomaly(item.daily, windows) : null;
    if (!anomaly) return;
    records.push({
      id: `climate:${region.id}`,
      name: region.name,
      lat: region.lat,
      lon: region.lon,
      ...anomaly,
      recentStart: windows.recentStart,
      recentEnd: windows.end,
      baselineStart: windows.start,
      baselineEnd: windows.baselineEnd,
    });
  });
  return records;
}

/** Open-Meteo ERA5 archive: recent week versus the preceding 30 days. */
export function climateAnomaliesProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  ttlMs = CLIMATE_ANOMALIES_TTL_MS,
  timeoutMs = 30_000,
} = {}) {
  async function load({ signal }) {
    const windows = climateWindows(now());
    const response = await fetchUpstream(fetchImpl, archiveUrl(windows), {
      signal,
      accept: 'application/json',
    });
    const payload = await readResponseJsonCapped(
      response,
      4 * 1024 * 1024,
      signal,
    );
    const records = parseClimateAnomalies(payload, windows);
    if (!records.length) throw new Error('climate_anomalies_empty');
    return {
      source: 'Open-Meteo ERA5',
      attribution: ATTRIBUTION,
      sources: { 'open-meteo': { ok: true, count: records.length } },
      method: METHOD,
      window: windows,
      regionCount: CLIMATE_REGIONS.length,
      records,
    };
  }
  return createCachedJsonRoute({
    name: 'climate-anomalies',
    route: '/api/climate-anomalies',
    ttlMs,
    timeoutMs,
    load,
    now,
  });
}
