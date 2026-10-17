/** Printable single-line text; markup and control characters are dropped. */
export function cleanText(value, max = 160) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const clean = String(value)
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.slice(0, max) : null;
}

/** A finite number, or null for blanks, NaN and non-numeric strings. */
export function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A WGS84 point, or null when either axis is missing or out of range. */
export function validLonLat(lon, lat) {
  const x = finiteNumber(lon);
  const y = finiteNumber(lat);
  if (x === null || y === null || Math.abs(x) > 180 || Math.abs(y) > 90)
    return null;
  return { lon: x, lat: y };
}

/** Rounded to `places` decimals so payloads stay small. */
export function round(value, places = 4) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
