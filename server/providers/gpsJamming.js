import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createCachedJsonRoute,
  fetchUpstream,
} from './common/cachedJsonRoute.js';
import { readResponseTextCapped } from './common/http.js';

const MANIFEST_URL = 'https://gpsjam.org/data/manifest.csv';
const dayUrl = (date) => `https://gpsjam.org/data/${date}-h3_4.csv`;
const MIB = 1024 * 1024;
export const GPS_JAMMING_TTL_MS = 6 * 3600_000;
/** Cells with fewer aircraft than this are noise, not evidence. */
export const MIN_AIRCRAFT = 3;
/** gpsjam.org colouring: under 2% none, 2-10% medium, over 10% high. */
export const MEDIUM_RATIO = 0.02;
export const HIGH_RATIO = 0.1;
const MAX_CELLS = 20_000;

export const ATTRIBUTION =
  'gpsjam.org (data from ADS-B Exchange / adsb.lol etc.)';

const DATE = /^\d{4}-\d\d-\d\d$/;
/** H3 mode-1, resolution-4 index: 0x84, five cell digits, unused 0xf digits. */
const H3_RES4 = /^84[0-9a-f]{5}f{8}$/;

/**
 * Choose the newest non-suspect day from the manifest, else the newest day.
 * @param {string} csv `date,suspect,num_bad_aircraft_hexes,source` rows.
 * @returns {{date:string, suspect:boolean}}
 */
export function pickManifestDate(csv) {
  const rows = String(csv)
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(','))
    .filter((cols) => DATE.test(cols[0] || ''))
    .map((cols) => ({ date: cols[0], suspect: cols[1]?.trim() !== 'false' }));
  if (!rows.length) throw new Error('invalid_gpsjam_manifest');
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return rows.find((row) => !row.suspect) || rows[0];
}

/**
 * Reduce one day's `hex,count_good_aircraft,count_bad_aircraft` file to the
 * cells worth drawing. The ratio is bad / (good + bad).
 * @param {string} csv Day file text.
 * @returns {{cells:Array<object>, total:number}}
 */
export function parseGpsJamDay(csv) {
  const lines = String(csv).split(/\r?\n/);
  if (!/^hex,count_good_aircraft,count_bad_aircraft/.test(lines[0] || ''))
    throw new Error('invalid_gpsjam_day');
  const cells = [];
  let total = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 3) continue;
    const hex = cols[0].trim().toLowerCase();
    const good = Number(cols[1]);
    const bad = Number(cols[2]);
    if (
      !H3_RES4.test(hex) ||
      !Number.isInteger(good) ||
      !Number.isInteger(bad) ||
      good < 0 ||
      bad < 0
    )
      continue;
    total++;
    const aircraft = good + bad;
    if (aircraft < MIN_AIRCRAFT) continue;
    const ratio = bad / aircraft;
    if (ratio <= MEDIUM_RATIO) continue;
    cells.push({
      hex,
      ratio: Math.round(ratio * 1000) / 1000,
      level: ratio > HIGH_RATIO ? 'high' : 'medium',
      good,
      bad,
    });
  }
  if (!total) throw new Error('invalid_gpsjam_day');
  cells.sort((a, b) => b.ratio - a.ratio || b.bad - a.bad);
  return { cells: cells.slice(0, MAX_CELLS), total };
}

/** Disk cache for the daily file: survives dev-server restarts. */
export function createGpsJamDiskCache({
  file = path.join(process.cwd(), '.gev-cache', 'gps-jamming.json'),
} = {}) {
  return {
    async read() {
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        return Array.isArray(parsed?.value?.records) &&
          Number.isFinite(parsed.at)
          ? parsed
          : null;
      } catch {
        return null;
      }
    },
    async write(entry) {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(entry));
      } catch {
        /* the cache is an optimisation only */
      }
    },
  };
}

/** gpsjam.org daily H3 res-4 interference cells. */
export function gpsJammingProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  ttlMs = GPS_JAMMING_TTL_MS,
  timeoutMs = 45_000,
  diskCache = createGpsJamDiskCache(),
} = {}) {
  let diskChecked = false;
  async function text(url, cap, signal) {
    const response = await fetchUpstream(fetchImpl, url, {
      signal,
      accept: 'text/csv,text/plain,*/*',
    });
    return readResponseTextCapped(response, cap, signal);
  }
  async function load({ signal, previous }) {
    if (!previous && !diskChecked && diskCache) {
      diskChecked = true;
      const saved = await diskCache.read();
      if (saved && now() - saved.at < ttlMs) return saved.value;
    }
    const picked = pickManifestDate(await text(MANIFEST_URL, MIB, signal));
    const day = parseGpsJamDay(
      await text(dayUrl(picked.date), 8 * MIB, signal),
    );
    const value = {
      source: 'gpsjam.org',
      attribution: ATTRIBUTION,
      date: picked.date,
      suspect: picked.suspect,
      resolution: 4,
      minAircraft: MIN_AIRCRAFT,
      thresholds: { medium: MEDIUM_RATIO, high: HIGH_RATIO },
      cellCount: day.total,
      records: day.cells,
    };
    await diskCache?.write({ at: now(), value });
    return value;
  }
  return createCachedJsonRoute({
    name: 'gps-jamming',
    route: '/api/gps-jamming',
    ttlMs,
    timeoutMs,
    failureCooldownMs: 10 * 60_000,
    maxStaleMs: 3 * 24 * 3600_000,
    load,
    now,
  });
}
