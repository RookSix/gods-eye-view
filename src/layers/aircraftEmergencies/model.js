import * as Cesium from 'cesium';
import { EMERGENCY_SQUAWKS } from './records.js';

export * from './records.js';

const PLANE_PATH =
  'M12 2c.8 0 1.4.9 1.4 2v5.6l8.1 4.7v2.2l-8.1-2.3v4.6l2.1 1.6V22L12 20.9 8.5 22v-1.6l2.1-1.6v-4.6l-8.1 2.3v-2.2l8.1-4.7V4c0-1.1.6-2 1.4-2z';
const iconCache = new Map();

/** North-up aircraft silhouette as a data URI, one per squawk colour. */
export function emergencyIconUri(fill) {
  if (!iconCache.has(fill)) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 24 24">` +
      `<path d="${PLANE_PATH}" fill="${fill}" stroke="#ffffff" stroke-width="1.1" stroke-linejoin="round"/></svg>`;
    iconCache.set(fill, `data:image/svg+xml,${encodeURIComponent(svg)}`);
  }
  return iconCache.get(fill);
}

/** Heading-aligned billboard over a translucent halo; both pick as the record. */
export function emergencyEntityOptions(record, cesium = Cesium) {
  const spec = EMERGENCY_SQUAWKS[record.squawk];
  return {
    point: {
      pixelSize: 34,
      color: cesium.Color.fromCssColorString(spec.color).withAlpha(0.22),
      outlineColor: cesium.Color.fromCssColorString(spec.color).withAlpha(0.9),
      outlineWidth: 2,
    },
    billboard: {
      image: emergencyIconUri(spec.color),
      scale: 0.85,
      // Rotation is counter-clockwise from north; a track is clockwise.
      rotation: -cesium.Math.toRadians(record.trackDeg ?? 0),
      alignedAxis: cesium.Cartesian3.UNIT_Z,
      verticalOrigin: cesium.VerticalOrigin.CENTER,
      horizontalOrigin: cesium.HorizontalOrigin.CENTER,
    },
  };
}
