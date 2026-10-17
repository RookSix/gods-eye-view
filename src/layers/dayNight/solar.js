/**
 * Solar position maths for the day/night terminator. Pure: no Cesium, DOM or
 * network. Accuracy is about 0.01 degrees (the low-precision Astronomical
 * Almanac series), far finer than a terminator drawn on a globe needs.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const UNIX_EPOCH_JD = 2440587.5;
const J2000_JD = 2451545.0;
const MS_PER_DAY = 86_400_000;

const mod = (value, base) => ((value % base) + base) % base;
/** Wrap degrees into [-180, 180). */
const wrap180 = (degrees) => mod(degrees + 180, 360) - 180;

/**
 * Subsolar point: where the sun is at the zenith.
 * @param {Date|number} [when] Date or epoch ms; defaults to now.
 * @returns {{latitude:number, longitude:number}} Degrees; longitude in [-180, 180).
 */
export function subsolarPoint(when = Date.now()) {
  const ms = when instanceof Date ? when.getTime() : Number(when);
  if (!Number.isFinite(ms)) throw new RangeError('A finite time is required');
  const jd = ms / MS_PER_DAY + UNIX_EPOCH_JD;
  const n = jd - J2000_JD;
  const meanLongitude = mod(280.46 + 0.9856474 * n, 360);
  const meanAnomaly = mod(357.528 + 0.9856003 * n, 360) * RAD;
  const eclipticLongitude =
    (meanLongitude +
      1.915 * Math.sin(meanAnomaly) +
      0.02 * Math.sin(2 * meanAnomaly)) *
    RAD;
  const obliquity = (23.439 - 0.0000004 * n) * RAD;
  const declination = Math.asin(
    Math.sin(obliquity) * Math.sin(eclipticLongitude),
  );
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );
  const greenwichSiderealDeg = mod(280.46061837 + 360.98564736629 * n, 360);
  return {
    latitude: declination * DEG,
    longitude: wrap180(rightAscension * DEG - greenwichSiderealDeg),
  };
}

/**
 * Solar altitude (degrees above the horizon) at a place, for a subsolar point.
 * @param {{latitude:number, longitude:number}} sun Subsolar point.
 * @param {number} latitude Degrees.
 * @param {number} longitude Degrees.
 * @returns {number}
 */
export function solarAltitude(sun, latitude, longitude) {
  const phi = latitude * RAD;
  const delta = sun.latitude * RAD;
  const hourAngle = (longitude - sun.longitude) * RAD;
  const sinAlt =
    Math.sin(phi) * Math.sin(delta) +
    Math.cos(phi) * Math.cos(delta) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG;
}

/**
 * Latitude intervals along one meridian where the sun is below `thresholdDeg`.
 * Crossings are linearly interpolated between 1-degree samples.
 * @param {{latitude:number, longitude:number}} sun
 * @param {number} longitude Degrees.
 * @param {number} thresholdDeg Altitude limit: 0 = night, -6 = past civil twilight.
 * @returns {Array<[number, number]>} [south, north] latitude pairs.
 */
export function darkLatitudeRuns(sun, longitude, thresholdDeg) {
  const runs = [];
  let start = null;
  let previousLat = -90;
  let previousValue = solarAltitude(sun, -90, longitude) - thresholdDeg;
  if (previousValue < 0) start = -90;
  for (let lat = -89; lat <= 90; lat++) {
    const value = solarAltitude(sun, lat, longitude) - thresholdDeg;
    if (previousValue < 0 !== value < 0) {
      const crossing =
        previousLat +
        (previousValue / (previousValue - value)) * (lat - previousLat);
      if (value < 0) start = crossing;
      else {
        runs.push([start, crossing]);
        start = null;
      }
    }
    previousLat = lat;
    previousValue = value;
  }
  if (start !== null) runs.push([start, 90]);
  return runs;
}

/**
 * Trapezoid rings (`[lon, lat, ...]` degrees) tiling the region where the sun
 * is below `thresholdDeg`, one meridian strip at a time. Strips are narrow so
 * each polygon stays well inside what a globe polygon renders reliably, even
 * though the night hemisphere as a whole contains a pole.
 * @param {{latitude:number, longitude:number}} sun
 * @param {number} thresholdDeg
 * @param {number} [stepDeg=2] Strip width.
 * @returns {Array<number[]>}
 */
export function darkRegionRings(sun, thresholdDeg, stepDeg = 2) {
  const rings = [];
  for (let lon = -180; lon < 180; lon += stepDeg) {
    const west = darkLatitudeRuns(sun, lon, thresholdDeg);
    const east = darkLatitudeRuns(sun, lon + stepDeg, thresholdDeg);
    const middle =
      west.length === east.length
        ? null
        : darkLatitudeRuns(sun, lon + stepDeg / 2, thresholdDeg);
    const count = middle ? middle.length : west.length;
    for (let i = 0; i < count; i++) {
      const a = middle ? middle[i] : west[i];
      const b = middle ? middle[i] : east[i];
      if (a[1] - a[0] < 1e-6 && b[1] - b[0] < 1e-6) continue;
      rings.push([
        lon,
        a[0],
        lon + stepDeg,
        b[0],
        lon + stepDeg,
        b[1],
        lon,
        a[1],
      ]);
    }
  }
  return rings;
}
