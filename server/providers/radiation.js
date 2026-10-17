import fs from 'node:fs/promises';
import {
  createCachedJsonRoute,
  fetchUpstream,
} from './common/cachedJsonRoute.js';
import {
  cleanText,
  finiteNumber,
  round,
  validLonLat,
} from './common/feedText.js';
import {
  readResponseJsonCapped,
  readResponseTextCapped,
} from './common/http.js';

const SAFECAST_URL = 'https://api.safecast.org/measurements.json';
const RADNET_URL = 'https://radnet.epa.gov/cdx-radnet-rest/api/rest/csv';
const MIB = 1024 * 1024;
const DAY_MS = 86_400_000;
export const RADIATION_TTL_MS = 30 * 60_000;
export const SAFECAST_PAGE_SIZE = 200;
export const SAFECAST_MAX_PAGES = 3;
export const RADNET_CONCURRENCY = 4;
const RADNET_SITE_TIMEOUT_MS = 30_000;
const MAX_SAFECAST_DEVICES = 800;
/** Common bGeigie / LND-7317 conversion: about 334 counts per minute per µSv/h. */
export const CPM_PER_USVH = 334;
/** Anything above this is a sensor fault, not a dose rate (µSv/h). */
const MAX_PLAUSIBLE_USVH = 10_000;

export const ATTRIBUTION =
  'Safecast (CC0 community measurements) and US EPA RadNet (public domain). Uncalibrated community sensors; not an official alert.';

const SITES_FILE = new URL(
  '../../src/data/local_data/radnet/radnet-sites.json',
  import.meta.url,
);

export async function loadRadnetSites(file = SITES_FILE) {
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(parsed?.sites)) throw new Error('invalid_radnet_sites');
  return parsed.sites
    .map((site) => ({
      state: cleanText(site?.state, 4),
      city: cleanText(site?.city, 60),
      ...validLonLat(site?.lon, site?.lat),
    }))
    .filter(
      (site) =>
        site.state &&
        site.city &&
        Number.isFinite(site.lat) &&
        Number.isFinite(site.lon),
    );
}

/**
 * Normalise Safecast measurements to one latest reading per device. cpm values
 * are converted with the common 1/334 factor; `usv` values are taken as µSv/h;
 * any other unit (e.g. `status`) is ignored.
 * @param {Array<object>} measurements
 * @returns {Array<object>}
 */
export function parseSafecast(measurements) {
  if (!Array.isArray(measurements)) throw new Error('invalid_safecast');
  const latest = new Map();
  for (const m of measurements) {
    const unit = typeof m?.unit === 'string' ? m.unit.toLowerCase() : '';
    if (unit !== 'cpm' && unit !== 'usv') continue;
    const value = finiteNumber(m.value);
    const at = validLonLat(m.longitude, m.latitude);
    const stamp = Date.parse(m.captured_at);
    if (value === null || value < 0 || !at || !Number.isFinite(stamp)) continue;
    const dose = unit === 'cpm' ? value / CPM_PER_USVH : value;
    if (dose > MAX_PLAUSIBLE_USVH) continue;
    const deviceId = finiteNumber(m.device_id);
    const key =
      deviceId !== null
        ? `d${deviceId}`
        : `p${at.lat.toFixed(3)},${at.lon.toFixed(3)}`;
    const held = latest.get(key);
    if (held && held.stamp >= stamp) continue;
    latest.set(key, {
      stamp,
      record: {
        id: `safecast:${key}`,
        source: 'safecast',
        name:
          cleanText(m.location_name, 80) ||
          (deviceId !== null
            ? `Safecast device ${deviceId}`
            : 'Safecast sensor'),
        lat: round(at.lat, 5),
        lon: round(at.lon, 5),
        doseUsvh: round(dose, 4),
        rawValue: value,
        rawUnit: unit,
        converted: unit === 'cpm',
        time: new Date(stamp).toISOString(),
        deviceId,
      },
    });
  }
  return [...latest.values()]
    .sort((a, b) => b.stamp - a.stamp)
    .slice(0, MAX_SAFECAST_DEVICES)
    .map((entry) => entry.record);
}

/** RadNet times are `MM/DD/YYYY HH:MM:SS`; the page does not name a zone, so UTC is assumed. */
export function parseRadnetTime(value) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    String(value || '').trim(),
  );
  if (!m) return null;
  const stamp = Date.UTC(
    Number(m[3]),
    Number(m[1]) - 1,
    Number(m[2]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] || 0),
  );
  return Number.isFinite(stamp) ? stamp : null;
}

const REJECTED_STATUS = /REJECT|INVALID|ERROR|FAIL|BAD/i;

/**
 * Latest valid row of a RadNet per-site CSV, or null. Valid means a finite,
 * positive dose-equivalent rate and a status that is not a rejection.
 * @param {string} csv
 * @param {{state:string, city:string, lat:number, lon:number}} site
 * @param {number} [nowMs] Rows more than two days in the future are ignored.
 */
export function parseRadnetCsv(csv, site, nowMs = Date.now()) {
  const lines = String(csv).split(/\r?\n/);
  const header = (lines[0] || '').split(',').map((cell) => cell.trim());
  const timeCol = header.indexOf('SAMPLE COLLECTION TIME');
  const doseCol = header.findIndex((cell) =>
    /^DOSE EQUIVALENT RATE \(nSv\/h\)$/i.test(cell),
  );
  const statusCol = header.indexOf('STATUS');
  if (timeCol < 0 || doseCol < 0) throw new Error('invalid_radnet_csv');
  let best = null;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cells = lines[i].split(',');
    const nsv = finiteNumber(cells[doseCol]);
    const stamp = parseRadnetTime(cells[timeCol]);
    const status = statusCol >= 0 ? (cells[statusCol] || '').trim() : '';
    if (
      nsv === null ||
      nsv <= 0 ||
      stamp === null ||
      stamp > nowMs + 2 * DAY_MS ||
      REJECTED_STATUS.test(status)
    )
      continue;
    if (!best || stamp > best.stamp) best = { stamp, nsv, status };
  }
  if (!best) return null;
  return {
    id: `radnet:${site.state}:${site.city}`,
    source: 'radnet',
    name: `${site.city
      .toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase())}, ${site.state}`,
    lat: site.lat,
    lon: site.lon,
    doseUsvh: round(best.nsv / 1000, 4),
    rawValue: best.nsv,
    rawUnit: 'nsv/h',
    converted: false,
    time: new Date(best.stamp).toISOString(),
    status: cleanText(best.status, 24),
  };
}

/** Run `task` over `items` with at most `limit` in flight; results keep order. */
export async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Safecast + EPA RadNet dose-rate feed. Each source fails independently: a
 * failed source keeps its previous records (marked stale in `sources`), and the
 * route only fails when neither source produced data.
 */
export function radiationProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  ttlMs = RADIATION_TTL_MS,
  timeoutMs = 240_000,
  loadSites = loadRadnetSites,
  concurrency = RADNET_CONCURRENCY,
} = {}) {
  let sitesPromise = null;

  function safecastUrl(page, ordered) {
    const after = new Date(now() - 2 * DAY_MS).toISOString().slice(0, 10);
    return (
      `${SAFECAST_URL}?captured_after=${after}` +
      `&per_page=${SAFECAST_PAGE_SIZE}&page=${page}` +
      (ordered ? '&order=captured_at+desc' : '')
    );
  }

  async function safecastPage(page, ordered, signal) {
    const response = await fetchUpstream(
      fetchImpl,
      safecastUrl(page, ordered),
      {
        signal,
        accept: 'application/json',
      },
    );
    return readResponseJsonCapped(response, 4 * MIB, signal);
  }

  async function loadSafecast(signal) {
    const all = [];
    // Newest-first is requested; if the API rejects the ordering parameter the
    // plain query still answers (oldest of the window first).
    let ordered = true;
    let pages = 0;
    for (let page = 1; page <= SAFECAST_MAX_PAGES; page++) {
      let rows;
      try {
        rows = await safecastPage(page, ordered, signal);
      } catch (error) {
        if (
          page === 1 &&
          ordered &&
          error?.status >= 400 &&
          error.status < 500
        ) {
          ordered = false;
          rows = await safecastPage(page, ordered, signal);
        } else if (pages > 0) break;
        else throw error;
      }
      if (!Array.isArray(rows)) throw new Error('invalid_safecast');
      pages++;
      all.push(...rows);
      if (rows.length < SAFECAST_PAGE_SIZE) break;
    }
    const records = parseSafecast(all);
    return { records, status: { ok: true, count: records.length, pages } };
  }

  async function loadRadnet(signal) {
    sitesPromise ||= loadSites().catch((error) => {
      sitesPromise = null;
      throw error;
    });
    const sites = await sitesPromise;
    const nowMs = now();
    const year = new Date(nowMs).getUTCFullYear();
    // Right after New Year the current file may not hold a row yet.
    const years =
      new Date(nowMs).getUTCMonth() === 0 ? [year, year - 1] : [year];
    let failed = 0;
    let empty = 0;
    const results = await mapWithConcurrency(
      sites,
      concurrency,
      async (site) => {
        const siteSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(RADNET_SITE_TIMEOUT_MS),
        ]);
        let errored = false;
        for (const y of years) {
          try {
            const url = `${RADNET_URL}/${y}/fixed/${encodeURIComponent(site.state)}/${encodeURIComponent(site.city)}`;
            const response = await fetchUpstream(fetchImpl, url, {
              signal: siteSignal,
              accept: 'text/csv,text/plain,*/*',
            });
            const record = parseRadnetCsv(
              await readResponseTextCapped(response, 3 * MIB, siteSignal),
              site,
              nowMs,
            );
            if (record) return record;
            errored = false;
          } catch {
            signal.throwIfAborted();
            errored = true;
          }
        }
        if (errored) failed++;
        else empty++;
        return null;
      },
    );
    const records = results.filter(Boolean);
    if (!records.length) throw new Error('radnet_no_data');
    return {
      records,
      status: {
        ok: true,
        count: records.length,
        sites: sites.length,
        failed,
        empty,
      },
    };
  }

  async function load({ signal, previous }) {
    const sources = [
      ['safecast', loadSafecast],
      ['radnet', loadRadnet],
    ];
    const settled = await Promise.allSettled(
      sources.map(([, run]) => run(signal)),
    );
    const status = {};
    const records = [];
    settled.forEach((result, index) => {
      const id = sources[index][0];
      if (result.status === 'fulfilled') {
        status[id] = result.value.status;
        records.push(...result.value.records);
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
    if (settled.every((r) => r.status === 'rejected'))
      throw new Error('radiation_unavailable');
    return {
      source: 'Safecast + EPA RadNet',
      attribution: ATTRIBUTION,
      sources: status,
      conversion: `Safecast cpm values are converted to µSv/h by dividing by ${CPM_PER_USVH}`,
      records,
    };
  }

  return createCachedJsonRoute({
    name: 'radiation',
    route: '/api/radiation',
    ttlMs,
    timeoutMs,
    load,
    now,
  });
}
