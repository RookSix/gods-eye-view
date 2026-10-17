import fs from 'node:fs/promises';
import {
  createCachedJsonRoute,
  fetchUpstream,
} from './common/cachedJsonRoute.js';
import { cleanText, round, validLonLat } from './common/feedText.js';
import { readResponseTextCapped } from './common/http.js';
import { child, childrenNamed, parseXml, textOf } from './common/xml.js';

const FAA_URL = 'https://nasstatus.faa.gov/api/airport-status-information';
const MIB = 1024 * 1024;
export const AIRPORT_DELAYS_TTL_MS = 5 * 60_000;
const MAX_RECORDS = 400;
const MAX_UNMATCHED_LISTED = 20;

export const ATTRIBUTION =
  'FAA National Airspace System Status (US government work). Airport positions: OurAirports (public domain).';

const AIRPORTS_FILE = new URL(
  '../../src/data/local_data/airports/us-airports.json',
  import.meta.url,
);

/** Program kinds in display order, each with the severity colour class it draws as. */
export const PROGRAM_KINDS = Object.freeze({
  closure: { level: 'red', rank: 5 },
  'ground-stop': { level: 'red', rank: 4 },
  gdp: { level: 'orange', rank: 3 },
  afp: { level: 'yellow', rank: 2 },
  delay: { level: 'yellow', rank: 2 },
  deicing: { level: 'yellow', rank: 1 },
  other: { level: 'grey', rank: 0 },
});

/** The block name FAA prints, e.g. "Ground Delay Programs", to a program kind. */
export function classifyProgram(name) {
  const text = String(name || '').toLowerCase();
  if (text.includes('closure')) return 'closure';
  if (text.includes('ground stop')) return 'ground-stop';
  if (text.includes('ground delay')) return 'gdp';
  if (text.includes('airspace flow')) return 'afp';
  if (text.includes('de-ic') || text.includes('deic')) return 'deicing';
  if (text.includes('delay')) return 'delay';
  return 'other';
}

/**
 * "1 hour and 20 minutes" / "16 minutes" / "3 hours" to whole minutes.
 * @returns {number|null} null when no duration is recognisable.
 */
export function parseDurationMinutes(value) {
  const text = String(value || '').toLowerCase();
  const hours = /(\d+)\s*h(?:ou)?rs?\b/.exec(text);
  const minutes = /(\d+)\s*min/.exec(text);
  if (!hours && !minutes) return null;
  return (
    (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0)
  );
}

/** Closures that only restrict some traffic or hours (GA only, nightly, PPR). */
export function isLimitedClosure(reason) {
  return /\b(EXC|PPR|DLY|NON SKED|TRANSIENT)\b|\bCLSD TO\b/i.test(
    String(reason || ''),
  );
}

/** IATA/FAA code and ICAO lookup built from the bundled OurAirports extract. */
export function indexAirports(parsed) {
  if (!Array.isArray(parsed?.airports)) throw new Error('invalid_airports');
  const byCode = new Map();
  for (const airport of parsed.airports) {
    const at = validLonLat(airport?.lon, airport?.lat);
    const code = cleanText(airport?.iata, 4)?.toUpperCase();
    if (!at || !code) continue;
    const entry = {
      code,
      name: cleanText(airport.name, 100) || code,
      lat: round(at.lat, 4),
      lon: round(at.lon, 4),
    };
    byCode.set(code, entry);
    const icao = cleanText(airport?.icao, 5)?.toUpperCase();
    if (icao && !byCode.has(icao)) byCode.set(icao, entry);
  }
  return byCode;
}

export async function loadAirportIndex(file = AIRPORTS_FILE) {
  return indexAirports(JSON.parse(await fs.readFile(file, 'utf8')));
}

function lookupAirport(index, code) {
  return index.get(code) || index.get(`K${code}`) || null;
}

function programFrom(kind, entry) {
  const reason = cleanText(textOf(child(entry, 'Reason')), 240);
  const base = {
    kind,
    reason,
    limited: kind === 'closure' ? isLimitedClosure(reason) : false,
    start: cleanText(textOf(child(entry, 'Start')), 60),
    reopen: cleanText(textOf(child(entry, 'Reopen')), 60),
    end: cleanText(textOf(child(entry, 'End_Time')), 60),
  };
  const field = (node, name) => cleanText(textOf(child(node, name)), 60);
  const timing = (node) => {
    const avg = field(node, 'Avg');
    const min = field(node, 'Min');
    const max = field(node, 'Max');
    return {
      avg,
      avgMin: parseDurationMinutes(avg),
      min,
      minMin: parseDurationMinutes(min),
      max,
      maxMin: parseDurationMinutes(max),
      trend: field(node, 'Trend'),
    };
  };
  const directions = childrenNamed(entry, 'Arrival_Departure');
  if (!directions.length)
    return [{ ...base, direction: null, ...timing(entry) }];
  return directions.map((node) => ({
    ...base,
    direction: cleanText(node.attrs.Type, 20),
    ...timing(node),
  }));
}

/**
 * Parse the FAA NAS status document into one record per airport.
 *
 * Every `Delay_type` block is read by shape: its `Name` classifies the
 * program, each list inside it holds entries, and an entry names its airport
 * in `ARPT`. Entries without an airport (e.g. airspace flow programs keyed by
 * a control element) are counted, not placed.
 * @param {string} xml
 * @param {Map<string, object>} airports From {@link indexAirports}.
 */
export function parseFaaStatus(xml, airports) {
  const root = parseXml(xml);
  if (root.name !== 'AIRPORT_STATUS_INFORMATION')
    throw new Error('invalid_faa_status');
  const byAirport = new Map();
  const unmatched = new Set();
  let withoutAirport = 0;
  for (const block of childrenNamed(root, 'Delay_type')) {
    const kind = classifyProgram(textOf(child(block, 'Name')));
    for (const list of block.children) {
      if (list.name === 'Name') continue;
      for (const entry of list.children) {
        const code = cleanText(textOf(child(entry, 'ARPT')), 5)?.toUpperCase();
        if (!code) {
          withoutAirport++;
          continue;
        }
        const airport = lookupAirport(airports, code);
        if (!airport) {
          unmatched.add(code);
          continue;
        }
        const held = byAirport.get(airport.code) || { airport, programs: [] };
        held.programs.push(...programFrom(kind, entry));
        byAirport.set(airport.code, held);
      }
    }
  }
  // A limited (GA-only / nightly / PPR) closure is a notice, not a disruption:
  // it neither outranks a real delay nor draws as a red closure.
  const effective = (program) =>
    program.kind === 'closure' && program.limited
      ? PROGRAM_KINDS.other
      : PROGRAM_KINDS[program.kind];
  const records = [...byAirport.values()]
    .map(({ airport, programs }) => {
      programs.sort(
        (a, b) =>
          effective(b).rank - effective(a).rank ||
          (b.avgMin ?? b.maxMin ?? 0) - (a.avgMin ?? a.maxMin ?? 0),
      );
      const top = programs[0];
      return {
        id: airport.code,
        code: airport.code,
        name: airport.name,
        lat: airport.lat,
        lon: airport.lon,
        level: effective(top).level,
        rank: effective(top).rank,
        topKind: top.kind,
        programs: programs.slice(0, 8),
      };
    })
    .sort((a, b) => b.rank - a.rank || a.code.localeCompare(b.code))
    .slice(0, MAX_RECORDS);
  return {
    updateTime: cleanText(textOf(child(root, 'Update_Time')), 60),
    records,
    unmatched: unmatched.size,
    unmatchedCodes: [...unmatched].sort().slice(0, MAX_UNMATCHED_LISTED),
    withoutAirport,
  };
}

/** FAA NAS status: ground delay programs, ground stops, delays and closures. */
export function airportDelaysProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  ttlMs = AIRPORT_DELAYS_TTL_MS,
  timeoutMs = 20_000,
  airports = null,
} = {}) {
  let index = airports;
  async function load({ signal }) {
    index ??= await loadAirportIndex();
    const response = await fetchUpstream(fetchImpl, FAA_URL, {
      signal,
      accept: 'application/xml,text/xml',
    });
    const parsed = parseFaaStatus(
      await readResponseTextCapped(response, 2 * MIB, signal),
      index,
    );
    return {
      source: 'FAA NAS Status',
      attribution: ATTRIBUTION,
      updateTime: parsed.updateTime,
      sources: { faa: { ok: true, count: parsed.records.length } },
      unmatched: parsed.unmatched,
      unmatchedCodes: parsed.unmatchedCodes,
      withoutAirport: parsed.withoutAirport,
      records: parsed.records,
    };
  }
  return createCachedJsonRoute({
    name: 'airport-delays',
    route: '/api/airport-delays',
    ttlMs,
    timeoutMs,
    maxStaleMs: 30 * 60_000,
    load,
    now,
  });
}
