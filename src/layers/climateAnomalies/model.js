import * as Cesium from 'cesium';
import {
  CLIMATE_ATTRIBUTION,
  CLIMATE_COLOR_SPAN_C,
  CLIMATE_SOURCE_URL,
  anomalyColor,
  anomalySize,
  climateLabel,
} from './records.js';

export * from './records.js';

const signed = (value, digits = 1, unit = '') =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}${unit}`;

/** Circle sized and coloured by temperature anomaly. */
export function climateEntityOptions(record, cesium = Cesium) {
  return {
    point: {
      pixelSize: anomalySize(record.tempAnomalyC),
      color: cesium.Color.fromCssColorString(
        anomalyColor(record.tempAnomalyC),
      ).withAlpha(0.82),
      outlineColor: cesium.Color.WHITE.withAlpha(0.85),
      outlineWidth: 1.5,
    },
  };
}

export function climatePriority(record) {
  return Math.abs(record.tempAnomalyC);
}

/** Value label under the circle through the world-overlay host. */
export function climateOverlayEntry(record) {
  return {
    variant: 'label',
    title: climateLabel(record),
    accent: anomalyColor(record.tempAnomalyC),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 12,
    verticalOnly: true,
    placement: 'above',
  };
}

const range = (from, to) => (from && to ? `${from} to ${to}` : 'dates n/a');

export function climateCard(record) {
  const lines = [
    `Temperature ${signed(record.tempAnomalyC, 1, '°C')} (${record.tempRecentC?.toFixed(1)}°C vs ${record.tempBaselineC?.toFixed(1)}°C)`,
    record.precipAnomalyPct === null
      ? 'Precipitation: baseline too dry for a percentage'
      : `Precipitation ${signed(record.precipAnomalyPct, 0, '%')} (${record.precipRecentMm} mm vs ${record.precipBaselineMm} mm per 7 days)`,
    `Last 7 days ${range(record.recentStart, record.recentEnd)}; baseline: the 30 days ${range(record.baselineStart, record.baselineEnd)}`,
    `${CLIMATE_ATTRIBUTION}`,
  ];
  return {
    title: record.name,
    lines,
    url: CLIMATE_SOURCE_URL,
    accent: anomalyColor(record.tempAnomalyC),
  };
}

export function climateListItem(record) {
  return { lead: climateLabel(record), text: record.name };
}

export const CLIMATE_LEGEND = Object.freeze([
  {
    label: `Cooler than baseline (to −${CLIMATE_COLOR_SPAN_C}°C)`,
    color: anomalyColor(-CLIMATE_COLOR_SPAN_C),
  },
  { label: 'Near baseline', color: anomalyColor(0) },
  {
    label: `Warmer than baseline (to +${CLIMATE_COLOR_SPAN_C}°C)`,
    color: anomalyColor(CLIMATE_COLOR_SPAN_C),
  },
]);

/** Analyst record: plain JSON, no Cesium types. */
export function climateAnalystRecord(record) {
  return {
    id: record.id,
    name: record.name,
    lat: record.lat,
    lon: record.lon,
    tempAnomalyC: record.tempAnomalyC,
    precipAnomalyPct: record.precipAnomalyPct,
    recentEnd: record.recentEnd,
  };
}
