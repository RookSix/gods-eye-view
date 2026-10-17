import {
  createCachedJsonRoute,
  fetchUpstream,
} from './common/cachedJsonRoute.js';
import { readResponseJsonCapped } from './common/http.js';
import { adsbLolCooldownMs } from './aircraft/adsb-lol.js';

const BASE_URL = 'https://api.adsb.lol/v2/sqk';
const CAP = 2 * 1024 * 1024;
const MAX_POSITION_AGE_S = 300;
export const AIRCRAFT_EMERGENCIES_TTL_MS = 30_000;

/** Integer-like keys iterate ascending: that is the sequential query order. */
export const EMERGENCY_SQUAWKS = Object.freeze({
  7500: 'HIJACK',
  7700: 'GENERAL EMERGENCY',
  7600: 'RADIO FAILURE',
});

export const ATTRIBUTION = 'adsb.lol (ODbL); community ADS-B feeders';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function label(value, max) {
  const clean = String(value ?? '')
    .replace(/[^0-9A-Za-z -]/g, '')
    .trim()
    .toUpperCase();
  return clean ? clean.slice(0, max) : null;
}

/**
 * Normalise one adsb.lol `/v2/sqk/<code>` response. Rows without a valid
 * position, the queried squawk, or a recent position fix are dropped.
 * @param {object} payload adsb.lol v2 response (`ac[]`).
 * @param {string} squawk The squawk that was queried.
 * @returns {Array<object>}
 */
export function parseSquawkResponse(payload, squawk) {
  if (!Array.isArray(payload?.ac)) throw new Error('invalid_adsb_response');
  const records = [];
  for (const raw of payload.ac) {
    const hex = String(raw?.hex ?? '')
      .trim()
      .toLowerCase();
    const lat = finite(raw?.lat);
    const lon = finite(raw?.lon);
    if (
      !/^[0-9a-f]{6}$/.test(hex) ||
      String(raw?.squawk ?? '') !== squawk ||
      lat === null ||
      lon === null ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      continue;
    const seenPos = finite(raw.seen_pos) ?? finite(raw.seen) ?? 0;
    if (seenPos > MAX_POSITION_AGE_S) continue;
    const onGround = raw.alt_baro === 'ground';
    const track = finite(raw.track);
    records.push({
      id: `${hex}:${squawk}`,
      hex,
      squawk,
      meaning: EMERGENCY_SQUAWKS[squawk],
      callsign: label(raw.flight, 10),
      registration: label(raw.r, 12),
      aircraftType: label(raw.t, 8),
      lat,
      lon,
      altitudeFt: onGround ? null : finite(raw.alt_baro),
      onGround,
      groundSpeedKt: finite(raw.gs),
      trackDeg: track === null ? null : ((track % 360) + 360) % 360,
      emergencyStatus: label(raw.emergency, 24),
      positionAgeS: Math.max(0, Math.round(seenPos)),
    });
  }
  return records;
}

/**
 * Aircraft squawking 7500/7600/7700 from adsb.lol exact-squawk queries.
 * Queries run sequentially (never a parallel burst); a 429/5xx stops the
 * remaining queries and starts the shared adsb.lol Retry-After cooldown.
 */
export function aircraftEmergenciesProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  ttlMs = AIRCRAFT_EMERGENCIES_TTL_MS,
  timeoutMs = 20_000,
} = {}) {
  let coolingUntil = 0;
  async function load({ signal, previous }) {
    if (now() < coolingUntil)
      throw Object.assign(new Error('adsb_lol_cooling_down'), {
        cooldownMs: coolingUntil - now(),
      });
    const status = {};
    const bySquawk = new Map();
    let blocked = null;
    for (const squawk of Object.keys(EMERGENCY_SQUAWKS)) {
      const kept = (previous?.records || []).filter((r) => r.squawk === squawk);
      if (blocked) {
        bySquawk.set(squawk, kept);
        status[squawk] = {
          ok: false,
          stale: kept.length > 0,
          skipped: 'rate limited',
        };
        continue;
      }
      try {
        const response = await fetchUpstream(
          fetchImpl,
          `${BASE_URL}/${squawk}`,
          { signal, accept: 'application/json' },
        );
        const records = parseSquawkResponse(
          await readResponseJsonCapped(response, CAP, signal),
          squawk,
        );
        bySquawk.set(squawk, records);
        status[squawk] = { ok: true, count: records.length };
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error?.status === 429 || error?.status >= 500) {
          blocked = adsbLolCooldownMs(error.response, now());
          coolingUntil = now() + blocked;
        }
        bySquawk.set(squawk, kept);
        status[squawk] = {
          ok: false,
          stale: kept.length > 0,
          error: String(error?.message || 'unavailable').slice(0, 60),
        };
      }
    }
    if (Object.values(status).every((entry) => !entry.ok))
      throw Object.assign(new Error('aircraft_emergencies_unavailable'), {
        ...(blocked ? { cooldownMs: blocked } : {}),
      });
    const seen = new Set();
    const records = [];
    for (const squawk of Object.keys(EMERGENCY_SQUAWKS)) {
      for (const record of bySquawk.get(squawk) || []) {
        if (seen.has(record.hex)) continue;
        seen.add(record.hex);
        records.push(record);
      }
    }
    return {
      source: 'adsb.lol',
      attribution: ATTRIBUTION,
      caveat: 'A squawk is not a confirmed incident.',
      sources: status,
      records,
    };
  }
  return createCachedJsonRoute({
    name: 'aircraft-emergencies',
    route: '/api/aircraft-emergencies',
    ttlMs,
    timeoutMs,
    // Backoff is owned by load(): Retry-After when adsb.lol sends one.
    failureCooldownMs: 5_000,
    maxStaleMs: 10 * 60_000,
    load,
    now,
  });
}
