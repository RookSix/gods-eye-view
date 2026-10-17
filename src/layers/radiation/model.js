import * as Cesium from 'cesium';
import {
  DOSE_BINS,
  RADIATION_CAVEAT,
  RADIATION_SOURCES,
  doseBin,
} from './records.js';

export * from './records.js';

const utc = (iso) =>
  iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'time unavailable';

const formatDose = (value) =>
  value >= 10
    ? value.toFixed(1)
    : value >= 1
      ? value.toFixed(2)
      : value.toFixed(3);

/** Small dots by dose bin; RadNet stations get a larger dot with a white ring. */
export function radiationEntityOptions(record, cesium = Cesium) {
  const color = cesium.Color.fromCssColorString(
    doseBin(record.doseUsvh).color,
  ).withAlpha(0.92);
  return record.source === 'radnet'
    ? {
        point: {
          pixelSize: 11,
          color,
          outlineColor: cesium.Color.WHITE.withAlpha(0.95),
          outlineWidth: 2.5,
        },
      }
    : {
        point: {
          pixelSize: 6,
          color,
          outlineColor: cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
        },
      };
}

export function radiationPriority(record) {
  return record.doseUsvh + (record.source === 'radnet' ? 0.001 : 0);
}

export function radiationCard(record) {
  const spec = RADIATION_SOURCES[record.source];
  const lines = [
    `${formatDose(record.doseUsvh)} µSv/h · ${utc(record.time)}`,
    record.converted
      ? `Converted from ${record.rawValue} ${record.rawUnit} (÷ 334; bGeigie / LND-7317 factor)`
      : record.source === 'radnet'
        ? `Reported ${record.rawValue} nSv/h${record.status ? ` · ${record.status}` : ''}`
        : `Reported in µSv/h by the device`,
    `Source: ${spec.label}${record.deviceId !== null ? ` · device ${record.deviceId}` : ''}`,
    RADIATION_CAVEAT,
  ];
  return {
    title: record.name,
    lines,
    url: spec.url,
    accent: doseBin(record.doseUsvh).color,
  };
}

export function radiationListItem(record) {
  return {
    lead: `${formatDose(record.doseUsvh)}`,
    text: `${record.name} · ${RADIATION_SOURCES[record.source].label}`,
  };
}

export const RADIATION_LEGEND = Object.freeze([
  ...DOSE_BINS.map(({ label, color }) => ({ label, color })),
  { label: 'White ring: EPA RadNet station', color: '#ffffff' },
  { label: 'No ring: Safecast device', color: '#8a94a3' },
]);

/** Analyst record: plain JSON, no Cesium types. */
export function radiationAnalystRecord(record) {
  return {
    id: record.id,
    name: record.name,
    source: record.source,
    doseUsvh: record.doseUsvh,
    lat: record.lat,
    lon: record.lon,
    timeMs: record.time ? Date.parse(record.time) : null,
  };
}
