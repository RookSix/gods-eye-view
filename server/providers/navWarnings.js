import {
  createCachedJsonRoute,
  fetchUpstream,
} from './common/cachedJsonRoute.js';
import { cleanText, round } from './common/feedText.js';
import { readResponseJsonCapped } from './common/http.js';

const NGA_URL =
  'https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A';
const MIB = 1024 * 1024;
const MAX_RECORDS = 1500;
const MAX_POINTS = 60;
const MAX_SHAPES = 8;
const TEXT_LIMIT = 1400;
export const NAV_WARNINGS_TTL_MS = 30 * 60_000;

export const ATTRIBUTION =
  'NGA Maritime Safety Information broadcast warnings (US public domain); positions are parsed from free text.';

const MONTHS = Object.freeze({
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
});

const ROMAN = Object.freeze([
  '',
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
  'IX',
  'X',
  'XI',
  'XII',
  'XIII',
  'XIV',
  'XV',
  'XVI',
  'XVII',
  'XVIII',
  'XIX',
  'XX',
  'XXI',
]);

/** NGA's lettered areas are the Hydro* broadcasts; numbers are NAVAREAs. */
const HYDRO_AREAS = Object.freeze({
  A: 'HYDROLANT',
  P: 'HYDROPAC',
  C: 'HYDROARC',
});

const LAT_PART = String.raw`(\d{1,2})-(\d{2})(?:\.(\d+)|-(\d{2})(?:\.(\d+))?)?([NS])`;
const LON_PART = String.raw`(\d{1,3})-(\d{2})(?:\.(\d+)|-(\d{2})(?:\.(\d+))?)?([EW])`;

function hemisphereValue(deg, min, minFraction, sec, secFraction, hemi, limit) {
  const degrees = Number(deg);
  const minutes = Number(minFraction ? `${min}.${minFraction}` : min);
  const seconds =
    sec === undefined ? 0 : Number(secFraction ? `${sec}.${secFraction}` : sec);
  if (degrees > limit || minutes >= 60 || seconds >= 60) return null;
  const value = degrees + minutes / 60 + seconds / 3600;
  if (value > limit) return null;
  return hemi === 'S' || hemi === 'W' ? -value : value;
}

/**
 * Find every `DD-MM.mmN DDD-MM.mmE` style position in free text, in order.
 * Understands decimal minutes (`12-34.5N 045-12.3E`), whole minutes
 * (`22-00N 019-00W`) and seconds (`20-03-44N 072-58-02W`), with 1-3 digit
 * longitudes. Positions with minutes or seconds of 60 or more, or out of
 * range, are rejected rather than clamped.
 * @param {string} text
 * @returns {Array<{lat:number, lon:number, start:number, end:number}>}
 */
export function extractPositions(text) {
  const pattern = new RegExp(
    String.raw`(?<![\d.\-])${LAT_PART}[\s,/]+${LON_PART}(?![A-Za-z0-9])`,
    'g',
  );
  const found = [];
  for (const m of String(text).matchAll(pattern)) {
    const lat = hemisphereValue(m[1], m[2], m[3], m[4], m[5], m[6], 90);
    const lon = hemisphereValue(m[7], m[8], m[9], m[10], m[11], m[12], 180);
    if (lat === null || lon === null) continue;
    found.push({
      lat: round(lat, 5),
      lon: round(lon, 5),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return found;
}

const JOIN_GAP = /^[\s,;]*(?:(?:AND|THENCE|THEN|TO)[\s,;]*)?$/;
const AREA_CUE =
  /BOUND(?:ED)?\s+BY|ENCLOS(?:ED|ING)|WITHIN\s+(?:THE\s+|AN?\s+)?(?:FOLLOWING\s+)?(?:AREA|POSITIONS?|COORDINATES)|AREA\s+(?:BOUND|DEFINED|ENCLOSED|DELIMITED)|POLYGON|BOX\s+(?:BOUND|FORMED)/;
const LINE_CUE =
  /JOINING|TRACK\s?LINES?|ROUTE|ALONG|BETWEEN|CENTRELINE|CENTERLINE|PIPELINE|COURSE|TRANSIT|FROM\b/;

function centre(points) {
  const base = points[0].lon;
  let lon = 0;
  let lat = 0;
  for (const p of points) {
    let l = p.lon;
    while (l - base > 180) l -= 360;
    while (l - base < -180) l += 360;
    lon += l;
    lat += p.lat;
  }
  lon /= points.length;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return { lat: round(lat / points.length, 5), lon: round(lon, 5) };
}

/**
 * Turn the positions in a warning into points, plus a line or polygon where
 * consecutive positions are joined by commas/"AND"/"TO" and the words just
 * before them describe a route ("TRACKLINE JOINING") or an area ("IN AREA
 * BOUND BY"). Separately labelled positions ("A. ... B. ...") stay points.
 * @param {string} text
 * @returns {{points:Array<{lat:number,lon:number}>, shapes:Array<{kind:'line'|'area', points:Array<[number,number]>}>, anchor:?{lat:number,lon:number}}}
 */
export function parseWarningGeometry(text) {
  const source = String(text);
  const positions = extractPositions(source);
  const groups = [];
  for (const position of positions) {
    const last = groups.at(-1);
    if (last && JOIN_GAP.test(source.slice(last.at(-1).end, position.start)))
      last.push(position);
    else groups.push([position]);
  }
  const points = [];
  const shapes = [];
  let anchor = null;
  let previousEnd = 0;
  let previousKind = null;
  for (const group of groups) {
    const lead = source
      .slice(Math.max(previousEnd, group[0].start - 200), group[0].start)
      .toUpperCase();
    previousEnd = group.at(-1).end;
    const lonLat = group.map((p) => ({ lat: p.lat, lon: p.lon }));
    for (const p of lonLat) {
      const prev = points.at(-1);
      if (!prev || prev.lat !== p.lat || prev.lon !== p.lon) points.push(p);
    }
    let kind = null;
    if (group.length >= 3 && AREA_CUE.test(lead)) kind = 'area';
    else if (group.length >= 2 && (LINE_CUE.test(lead) || AREA_CUE.test(lead)))
      kind = 'line';
    else if (group.length >= 3 && /\bCABLE|\bROUTE/.test(lead)) kind = 'line';
    // "B. 13-47N ..." right after "A. ..." continues the same description.
    else if (
      group.length >= 2 &&
      previousKind &&
      /^[\s.,;]*(?:[A-Z]{1,3}|\d{1,2})?[.)]?\s*$/.test(lead)
    )
      kind =
        previousKind === 'area' && group.length < 3 ? 'line' : previousKind;
    previousKind = kind || previousKind;
    if (kind && shapes.length < MAX_SHAPES)
      shapes.push({
        kind,
        points: lonLat.slice(0, MAX_POINTS).map((p) => [p.lon, p.lat]),
      });
    if (!anchor) {
      anchor =
        kind === 'area'
          ? centre(lonLat)
          : kind === 'line'
            ? lonLat[Math.floor(lonLat.length / 2)]
            : lonLat[0];
    }
  }
  return { points: points.slice(0, MAX_POINTS), shapes, anchor };
}

// Seismic streamers and a man overboard from a cable ship are not cable work.
const CABLE_SCRUB =
  /TOWING[^.]{0,120}?CABLES?|LONG\s+CABLES?|STREAMERS?|MAN\s+OVERBOARD[^.]{0,60}/g;
const CABLE_REPAIR =
  /CABLE[\s-]*(?:REPAIRS?|FAULT)|REPAIR(?:ING|S)?[^.]{0,40}CABLE|FAULTY\s+CABLE/;
const CABLE_LAYING =
  /CABLE[\s-]*(?:LAY(?:ING)?|INSTALLATION|BURIAL|PLOUGH(?:ING)?|PLOWING|RECOVERY)|LAY(?:ING)?\s[^.]{0,30}CABLE/;
const CABLE_GENERAL =
  /CABLE[\s-]*SHIP|\bC\/S\b|CABLE\s+OPERATIONS?|(?:SUBMARINE|SUBSEA|UNDERSEA|TELECOM\w*|FIBER|FIBRE|OPTIC\w*|COMMUNICATIONS?)\s+CABLES?|CABLE\s+(?:ROUTE|SURVEY|MAINTENANCE|WORK|ACTIVITIES)/;

/**
 * Does a warning describe telecom/submarine cable work? Seismic streamers
 * ("TOWING TEN 8100 METER LONG CABLES") are survey gear, not seabed cables, and
 * are scrubbed first.
 * @param {string} text Warning text.
 * @param {?string} [authority] Issuing authority line (a "C/S ..." cable ship).
 * @returns {?('repair'|'laying'|'operations')}
 */
export function classifyCableActivity(text, authority = null) {
  const scrubbed = `${String(text)} ${authority || ''}`
    .toUpperCase()
    .replace(CABLE_SCRUB, ' ');
  if (CABLE_REPAIR.test(scrubbed)) return 'repair';
  if (CABLE_LAYING.test(scrubbed)) return 'laying';
  if (CABLE_GENERAL.test(scrubbed)) return 'operations';
  return null;
}

const KIND_RULES = Object.freeze([
  [
    'space',
    /ROCKET\s+(?:LAUNCH|DEBRIS|BOOSTER)|LAUNCH\s+(?:VEHICLE|DEBRIS|OPERATIONS)|SPACE(?:CRAFT|\s+DEBRIS)|RE-?ENTRY|SPLASHDOWN|FALLING\s+DEBRIS/,
  ],
  [
    'security',
    /PIRAC|ARMED\s+ROBBERY|HIJACK|HOSTILE|HOUTHI|\bATTACKS?\b|THREAT|\bWAR\b|CONFLICT|SUSPICIOUS/,
  ],
  [
    'military',
    /FIRING|GUNNERY|MISSILE|EXERCISES?|LIVE\s+FIRE|TORPEDO|BOMBING|WEAPONS?|PROJECTILE|NAVAL|HAZARDOUS\s+OPERATIONS/,
  ],
  [
    'hazard',
    /DERELICT|WRECK|ADRIFT|DRIFTING|DEBRIS|CONTAINERS?\s+(?:LOST|ADRIFT|OVERBOARD)|UNLIT|OBSTRUCTION|SHOAL|AGROUND|SUBMERGED|UNEXPLODED|\bUXO\b|CASUALTY|OVERDUE|FLOATING|VOLCAN|TSUNAMI/,
  ],
  [
    'aids',
    /\bLIGHTS?\b|BUOY|\bAIS\b|RACON|BEACON|FOG\s+SIGNAL|DISCREPANC|OUT\s+OF\s+SERVICE|UNRELIABLE|EXTINGUISHED|OFF\s+STATION|NAVTEX|\bGNSS\b|\bGPS\b/,
  ],
  [
    'operations',
    /SURVEY|DRILLING|OFFSHORE|\bRIGS?\b|SEISMIC|TOWING|DREDG|PIPELINE|CONSTRUCTION|PLATFORM|OPERATIONS|DIVING|BERTH\s+REQUESTED|UNDERWATER/,
  ],
]);

/** Coarse topic for styling; `cable` wins whenever the cable test passes. */
export function classifyWarningKind(text, cable) {
  if (cable) return 'cable';
  const upper = String(text).toUpperCase();
  for (const [kind, rule] of KIND_RULES) if (rule.test(upper)) return kind;
  return 'other';
}

/** `DDHHMMZ MON YYYY` to ISO 8601, else null. */
export function parseNgaTime(value) {
  const m = /^(\d{2})(\d{2})(\d{2})Z\s+([A-Z]{3})\s+(\d{4})$/.exec(
    String(value || '').trim(),
  );
  if (!m || !Object.hasOwn(MONTHS, m[4])) return null;
  const [day, hour, minute] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const stamp = Date.UTC(Number(m[5]), MONTHS[m[4]], day, hour, minute);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

function areaName(navArea) {
  const key = String(navArea ?? '').toUpperCase();
  if (Object.hasOwn(HYDRO_AREAS, key)) return HYDRO_AREAS[key];
  const n = Number(key);
  return Number.isInteger(n) && ROMAN[n] ? `NAVAREA ${ROMAN[n]}` : null;
}

/** Leading all-caps place lines ("CARIBBEAN SEA. ARUBA.") of a warning. */
function placeOf(lines) {
  const place = [];
  for (const line of lines) {
    if (
      place.length < 3 &&
      /^[A-Z][A-Z .,'()/-]*\.$/.test(line) &&
      !/^DNC\b/.test(line)
    )
      place.push(line.replace(/\.$/, ''));
    else break;
  }
  return place.length ? place.join(', ').slice(0, 120) : null;
}

/**
 * Normalise the NGA broadcast-warning list. Warnings without a parseable
 * position cannot be drawn and are dropped (counted in the return value).
 * @param {object} payload `{ "broadcast-warn": [...] }`.
 * @returns {{records:Array<object>, total:number, withoutPosition:number}}
 */
export function parseNgaWarnings(payload) {
  const list = payload?.['broadcast-warn'];
  if (!Array.isArray(list)) throw new Error('invalid_nga_warnings');
  const seen = new Set();
  const records = [];
  let withoutPosition = 0;
  for (const raw of list) {
    const year = Number(raw?.msgYear);
    const number = Number(raw?.msgNumber);
    const navArea = cleanText(raw?.navArea, 4);
    if (
      !Number.isInteger(year) ||
      !Number.isInteger(number) ||
      !navArea ||
      typeof raw.text !== 'string' ||
      (raw.status && raw.status !== 'A') ||
      raw.cancelDate
    )
      continue;
    const id = `nga:${year}:${navArea}:${number}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const geometry = parseWarningGeometry(raw.text);
    if (!geometry.anchor) {
      withoutPosition++;
      continue;
    }
    const authority = cleanText(raw.authority, 120);
    const cable = classifyCableActivity(raw.text, authority);
    const lines = raw.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    records.push({
      id,
      year,
      number,
      navArea,
      areaName: areaName(navArea),
      subregion: cleanText(raw.subregion, 40),
      place: placeOf(lines),
      issued: parseNgaTime(raw.issueDate),
      authority,
      kind: classifyWarningKind(raw.text, cable),
      cableActivity: cable,
      text: cleanText(raw.text, TEXT_LIMIT),
      lat: geometry.anchor.lat,
      lon: geometry.anchor.lon,
      points: geometry.points,
      shapes: geometry.shapes,
    });
  }
  records.sort(
    (a, b) =>
      String(b.issued || '').localeCompare(String(a.issued || '')) ||
      a.id.localeCompare(b.id),
  );
  return {
    records: records.slice(0, MAX_RECORDS),
    total: list.length,
    withoutPosition,
  };
}

/** NGA MSI active broadcast warnings with positions parsed from the text. */
export function navWarningsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  ttlMs = NAV_WARNINGS_TTL_MS,
  timeoutMs = 30_000,
} = {}) {
  async function load({ signal }) {
    const response = await fetchUpstream(fetchImpl, NGA_URL, {
      signal,
      accept: 'application/json',
    });
    const parsed = parseNgaWarnings(
      await readResponseJsonCapped(response, 16 * MIB, signal),
    );
    return {
      source: 'NGA Maritime Safety Information',
      attribution: ATTRIBUTION,
      sources: { nga: { ok: true, count: parsed.records.length } },
      total: parsed.total,
      withoutPosition: parsed.withoutPosition,
      records: parsed.records,
    };
  }
  return createCachedJsonRoute({
    name: 'nav-warnings',
    route: '/api/nav-warnings',
    ttlMs,
    timeoutMs,
    load,
    now,
  });
}
