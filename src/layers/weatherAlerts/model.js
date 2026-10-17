import {
  ALERT_SOURCES,
  SEVERITIES,
  SEVERITY_STYLES,
  severityRank,
} from './records.js';

export * from './records.js';

/** At most this many alerts get an ambient name label, most severe and largest first. */
export const WEATHER_ALERT_LABEL_LIMIT = 10;

const utc = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : null);

/** Importance for list order, label choice and collisions. */
export function weatherAlertPriority(record) {
  return (
    (SEVERITIES.length - severityRank(record.severity)) * 1e6 + record.areaDeg2
  );
}

/**
 * Mark the few alerts worth a map label: Severe or Extreme only, largest first,
 * so a continent of advisories never turns into a wall of text.
 */
export function labelAlerts(records, limit = WEATHER_ALERT_LABEL_LIMIT) {
  const chosen = new Set(
    records
      .filter((record) => severityRank(record.severity) <= 1)
      .sort((a, b) => weatherAlertPriority(b) - weatherAlertPriority(a))
      .slice(0, limit)
      .map((record) => record.id),
  );
  return records.map((record) => ({
    ...record,
    labelled: chosen.has(record.id),
  }));
}

/** Ambient label for the few chosen alerts. */
export function weatherAlertOverlayEntry(record) {
  if (!record.labelled) return null;
  const title =
    record.event.length > 30 ? `${record.event.slice(0, 29)}…` : record.event;
  return {
    variant: 'label',
    title,
    accent: SEVERITY_STYLES[record.severity].color,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 10,
    verticalOnly: true,
    placement: 'above',
  };
}

export function weatherAlertCard(record) {
  const traits = [
    SEVERITY_STYLES[record.severity].label,
    record.urgency && `${record.urgency} urgency`,
    record.certainty && `${record.certainty} certainty`,
  ].filter(Boolean);
  const times = [
    record.onset && `From ${utc(record.onset)}`,
    record.expires && `until ${utc(record.expires)}`,
  ].filter(Boolean);
  const lines = [traits.join(' · ')];
  if (record.area) lines.push(record.area);
  if (times.length) lines.push(times.join(' '));
  if (record.headline && record.headline !== record.event)
    lines.push(record.headline);
  lines.push(
    `Source: ${ALERT_SOURCES[record.source].label}${record.issuer ? ` · ${record.issuer}` : ''}`,
  );
  return {
    title: record.event,
    lines,
    url: record.url,
    accent: SEVERITY_STYLES[record.severity].color,
  };
}

export function weatherAlertListItem(record) {
  return {
    lead: record.severity.toUpperCase(),
    text: `${record.event}${record.area ? ` · ${record.area.slice(0, 60)}` : ''}`,
  };
}

export const WEATHER_ALERT_LEGEND = Object.freeze([
  { label: 'Extreme', color: SEVERITY_STYLES.Extreme.color },
  { label: 'Severe', color: SEVERITY_STYLES.Severe.color },
  { label: 'Moderate', color: SEVERITY_STYLES.Moderate.color },
  { label: 'Minor / unknown', color: SEVERITY_STYLES.Minor.color },
]);

/** Analyst record: plain JSON, no Cesium types, no outlines. */
export function weatherAlertAnalystRecord(record) {
  return {
    id: record.id,
    event: record.event,
    severity: record.severity,
    source: record.source,
    area: record.area,
    lat: record.lat,
    lon: record.lon,
    timeMs: record.onset ? Date.parse(record.onset) : null,
  };
}
