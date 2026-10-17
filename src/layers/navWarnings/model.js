import {
  CABLE_ACTIVITIES,
  NAV_WARNINGS_URL,
  NAV_WARNING_KINDS,
  warningExcerpt,
  warningTitle,
} from './records.js';

export * from './records.js';

const utc = (iso) =>
  iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'time unavailable';

/** Cable warnings first, then newest. */
export function navWarningPriority(record) {
  return (
    (record.cableActivity ? 1e13 : 0) +
    (record.issued ? Date.parse(record.issued) / 1000 : 0)
  );
}

/** Ambient label only for cable work, the layer's reason to exist on the globe. */
export function navWarningOverlayEntry(record) {
  if (!record.cableActivity) return null;
  return {
    variant: 'label',
    title: warningTitle(record),
    accent: NAV_WARNING_KINDS.cable.color,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/** The host shows the first four lines, so the key facts come first. */
export function navWarningCard(record) {
  const kind = NAV_WARNING_KINDS[record.kind];
  const topic = record.cableActivity
    ? `${CABLE_ACTIVITIES[record.cableActivity]} · possible fault/repair activity`
    : kind.label;
  const lines = [
    `${topic}${record.place ? ` · ${record.place}` : ''}`,
    `Issued ${utc(record.issued)}`,
    warningExcerpt(record, 220),
    `Source: NGA MSI${record.authority ? ` · ${record.authority}` : ''}`,
  ];
  return {
    title: warningTitle(record),
    lines,
    url: NAV_WARNINGS_URL,
    accent: kind.color,
  };
}

export function navWarningListItem(record) {
  return {
    lead: record.cableActivity ? 'CABLE' : record.kind.toUpperCase(),
    text: `${warningTitle(record)}${record.place ? ` · ${record.place}` : ''}`,
  };
}

export const NAV_WARNING_LEGEND = Object.freeze(
  Object.values(NAV_WARNING_KINDS).map(({ label, color }) => ({
    label,
    color,
  })),
);

/** Analyst record: plain JSON, no Cesium types. */
export function navWarningAnalystRecord(record) {
  return {
    id: record.id,
    title: warningTitle(record),
    kind: record.kind,
    cableActivity: record.cableActivity,
    place: record.place,
    lat: record.lat,
    lon: record.lon,
    timeMs: record.issued ? Date.parse(record.issued) : null,
  };
}

/**
 * What the submarine-cables layer needs from a cable-related warning: its id,
 * a readable title/excerpt and every position that could sit near a cable.
 * Lines are kept as ordered vertices so the matcher can walk the segments.
 * @param {object} record A validated warning record.
 */
export function cableWarningSummary(record) {
  return {
    id: record.id,
    title: warningTitle(record),
    issued: record.issued,
    activity: record.cableActivity,
    excerpt: warningExcerpt(record, 160),
    points: record.points.map((p) => [p.lon, p.lat]),
    lines: record.shapes.map((shape) =>
      shape.kind === 'area' ? [...shape.points, shape.points[0]] : shape.points,
    ),
  };
}
