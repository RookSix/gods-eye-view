import * as Cesium from 'cesium';
import { GDACS_ALERT_COLORS, NATURAL_EVENT_KINDS } from './records.js';

export * from './records.js';

const color = (css, alpha = 1, cesium = Cesium) =>
  cesium.Color.fromCssColorString(css).withAlpha(alpha);

/** Point graphics: fill by category, ring by GDACS alert level. */
export function naturalEventEntityOptions(record, cesium = Cesium) {
  const kind = NATURAL_EVENT_KINDS[record.kind];
  const ring = record.alert
    ? color(GDACS_ALERT_COLORS[record.alert], 1, cesium)
    : cesium.Color.BLACK.withAlpha(0.7);
  return {
    point: {
      pixelSize:
        record.alert === 'red' ? 15 : record.alert === 'orange' ? 13 : 10,
      color: color(kind.color, 0.95, cesium),
      outlineColor: ring,
      outlineWidth: record.alert ? 3 : 1.5,
    },
  };
}
