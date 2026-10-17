import * as Cesium from 'cesium';
import {
  CYBER_CATEGORIES,
  CYBER_SOURCES,
  CYBER_THREATS_CAVEAT,
  familyColor,
} from './records.js';

export * from './records.js';

const day = (text) => (text ? text.slice(0, 10) : null);

/** Online indicators first, then the ones seen most recently. */
export function cyberThreatPriority(record) {
  const seen = Date.parse(record.lastSeen || record.firstSeen || '');
  return (
    (record.status === 'online' ? 1e13 : 0) +
    (Number.isFinite(seen) ? seen / 1000 : 0)
  );
}

/** Small dot in the family colour; offline indicators are dimmer. */
export function cyberThreatEntityOptions(record, cesium = Cesium) {
  const online = record.status === 'online';
  return {
    point: {
      pixelSize: online ? 7 : 6,
      color: cesium.Color.fromCssColorString(
        familyColor(record.family),
      ).withAlpha(online || record.status === null ? 0.95 : 0.6),
      outlineColor: online
        ? cesium.Color.WHITE.withAlpha(0.85)
        : cesium.Color.BLACK.withAlpha(0.6),
      outlineWidth: online ? 1.5 : 1,
    },
  };
}

/** The host shows the first four lines, so the caveat sits among them. */
export function cyberThreatCard(record) {
  const sources = record.sources.map((key) => CYBER_SOURCES[key].label);
  const place = [record.city, record.country].filter(Boolean).join(', ');
  const network = [record.asn, record.asName || record.org]
    .filter(Boolean)
    .join(' ');
  const seen = [
    record.firstSeen && `first seen ${day(record.firstSeen)}`,
    record.lastSeen && `last seen ${day(record.lastSeen)}`,
  ].filter(Boolean);
  const lines = [
    `${CYBER_CATEGORIES[record.category]} · ${sources.join(' + ')}${record.status ? ` · ${record.status}` : ''}`,
    `${record.ip}${record.port ? `:${record.port}` : ''}${network ? ` · ${network}` : ''}`,
    [place, ...seen].filter(Boolean).join(' · ') || 'No location details',
    CYBER_THREATS_CAVEAT,
    record.precision === 'country'
      ? 'Position: country centroid (approximate, spread to keep points separate)'
      : 'Position: IP geolocation (city level, lightly spread)',
  ];
  if (record.hostname) lines.push(`Hostname: ${record.hostname}`);
  return {
    title: `${record.family} · ${record.ip}`,
    lines,
    url: record.url || CYBER_SOURCES[record.source].url,
    accent: familyColor(record.family),
  };
}

export function cyberThreatListItem(record) {
  return {
    lead:
      record.status === 'online'
        ? 'ONLINE'
        : record.category === 'botnet-c2'
          ? 'C2'
          : 'IOC',
    text: `${record.family} · ${record.ip}${record.country ? ` · ${record.country}` : ''}`,
  };
}

/** Recognised families; any other family gets a stable colour from its name. */
export const CYBER_LEGEND = Object.freeze([
  ...[
    'Cobalt Strike',
    'Emotet',
    'QakBot',
    'Dridex',
    'TrickBot',
    'BazarLoader',
  ].map((family) => ({ label: family, color: familyColor(family) })),
  { label: 'Other families: colour by name', color: familyColor('other') },
  { label: 'White ring: online', color: '#ffffff' },
]);

/** Analyst record: plain JSON, no Cesium types. */
export function cyberThreatAnalystRecord(record) {
  return {
    id: record.id,
    ip: record.ip,
    family: record.family,
    category: record.category,
    source: record.source,
    status: record.status,
    country: record.country,
    lat: record.lat,
    lon: record.lon,
    timeMs: record.lastSeen ? Date.parse(record.lastSeen) || null : null,
  };
}
