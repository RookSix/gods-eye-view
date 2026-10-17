/** Warning positions within this distance of a cable segment flag the cable. */
export const CABLE_HEALTH_RADIUS_KM = 50;
/** Lines between warning vertices are sampled at least this densely. */
export const CABLE_HEALTH_SAMPLE_KM = 20;
const MAX_SAMPLES_PER_WARNING = 400;
const MAX_MATCHES_PER_CABLE = 3;
const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON_EQUATOR = 111.32;

const toRad = Math.PI / 180;
const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Equirectangular offset (km) of `b` from `a`; fine at tens of km. */
function offsetKm(aLon, aLat, bLon, bLat) {
  const midLat = (aLat + bLat) / 2;
  return [
    wrapDeg(bLon - aLon) * Math.cos(midLat * toRad) * KM_PER_DEG_LON_EQUATOR,
    (bLat - aLat) * KM_PER_DEG_LAT,
  ];
}

/** Distance in km from point P to segment A-B on a local flat projection. */
export function pointToSegmentKm(pLon, pLat, aLon, aLat, bLon, bLat) {
  const [ax, ay] = offsetKm(pLon, pLat, aLon, aLat);
  const [bx, by] = offsetKm(pLon, pLat, bLon, bLat);
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Positions to test for one warning: its points plus samples along its lines. */
export function warningSamples(warning, stepKm = CABLE_HEALTH_SAMPLE_KM) {
  const samples = (warning.points || []).map(([lon, lat]) => [lon, lat]);
  for (const line of warning.lines || []) {
    for (let i = 1; i < line.length; i++) {
      const [aLon, aLat] = line[i - 1];
      const [bLon, bLat] = line[i];
      const [dx, dy] = offsetKm(aLon, aLat, bLon, bLat);
      const steps = Math.min(40, Math.ceil(Math.hypot(dx, dy) / stepKm));
      for (let s = 1; s < steps; s++) {
        samples.push([
          aLon + (wrapDeg(bLon - aLon) * s) / steps,
          aLat + ((bLat - aLat) * s) / steps,
        ]);
      }
    }
  }
  return samples.slice(0, MAX_SAMPLES_PER_WARNING);
}

function linesOf(feature) {
  const geometry = feature?.geometry;
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

const boxCache = new WeakMap();

/** Per-line lat/lon extents, cached per feature object. */
function boxesOf(feature) {
  let boxes = boxCache.get(feature);
  if (boxes) return boxes;
  boxes = linesOf(feature)
    .filter((line) => Array.isArray(line) && line.length >= 2)
    .map((line) => {
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLon = Infinity;
      let maxLon = -Infinity;
      // Unwrapped so an antimeridian crossing is one continuous extent.
      let previousLon = line[0][0];
      let unwrapped = previousLon;
      for (const [lon, lat] of line) {
        unwrapped += wrapDeg(lon - previousLon);
        previousLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (unwrapped < minLon) minLon = unwrapped;
        if (unwrapped > maxLon) maxLon = unwrapped;
      }
      return { line, minLat, maxLat, minLon, maxLon };
    });
  boxCache.set(feature, boxes);
  return boxes;
}

/** Smallest distance (km) from a position to a cable, or Infinity beyond `limitKm`. */
function distanceToCableKm(feature, lon, lat, limitKm) {
  const latPad = limitKm / KM_PER_DEG_LAT;
  const lonPad =
    limitKm / (KM_PER_DEG_LON_EQUATOR * Math.max(0.05, Math.cos(lat * toRad)));
  let best = Infinity;
  for (const box of boxesOf(feature)) {
    if (lat < box.minLat - latPad || lat > box.maxLat + latPad) continue;
    // A cable can be stored across the antimeridian as 170..190 or -190..-170.
    const lonIn = [lon, lon + 360, lon - 360].some(
      (candidate) =>
        candidate >= box.minLon - lonPad && candidate <= box.maxLon + lonPad,
    );
    if (!lonIn) continue;
    const { line } = box;
    for (let i = 1; i < line.length; i++) {
      const d = pointToSegmentKm(
        lon,
        lat,
        line[i - 1][0],
        line[i - 1][1],
        line[i][0],
        line[i][1],
      );
      if (d < best) best = d;
    }
  }
  return best <= limitKm ? best : Infinity;
}

/**
 * Match cable-related warnings to bundled cable geometries.
 * @param {Array<object>} features Cable GeoJSON features, each with a string `id`.
 * @param {Array<object>} warnings Warnings from the cable-health channel.
 * @param {number} [radiusKm]
 * @returns {Map<string, Array<{warningId:string, title:string, issued:?string, activity:string, excerpt:string, distanceKm:number}>>}
 *   Newest warning first, at most three per cable.
 */
export function matchWarningsToCables(
  features,
  warnings,
  radiusKm = CABLE_HEALTH_RADIUS_KM,
) {
  const matches = new Map();
  if (!warnings?.length) return matches;
  const sampled = warnings.map((warning) => ({
    warning,
    samples: warningSamples(warning),
  }));
  for (const feature of features || []) {
    if (!feature?.id) continue;
    for (const { warning, samples } of sampled) {
      let nearest = Infinity;
      for (const [lon, lat] of samples) {
        const d = distanceToCableKm(feature, lon, lat, radiusKm);
        if (d < nearest) nearest = d;
      }
      if (nearest === Infinity) continue;
      const list = matches.get(feature.id) || [];
      list.push({
        warningId: warning.id,
        title: warning.title,
        issued: warning.issued || null,
        activity: warning.activity,
        excerpt: warning.excerpt,
        distanceKm: Math.round(nearest * 10) / 10,
      });
      matches.set(feature.id, list);
    }
  }
  for (const [id, list] of matches) {
    list.sort(
      (a, b) =>
        String(b.issued || '').localeCompare(String(a.issued || '')) ||
        a.distanceKm - b.distanceKm,
    );
    matches.set(id, list.slice(0, MAX_MATCHES_PER_CABLE));
  }
  return matches;
}

export const CABLE_HEALTH_COLOR = '#ff9f1c';
