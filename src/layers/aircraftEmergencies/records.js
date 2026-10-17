import {
  boundedText,
  validCoordinate,
  validateEnvelope,
} from '../feedOverlay/source.js';

export const AIRCRAFT_EMERGENCIES_LAYER_ID = 'aircraft-emergencies';
export const SQUAWK_CAVEAT = 'A squawk is not a confirmed incident.';

/** The three ICAO emergency transponder codes. */
export const EMERGENCY_SQUAWKS = Object.freeze({
  7500: { meaning: 'HIJACK', color: '#ff2bd6', rank: 3 },
  7700: { meaning: 'GENERAL EMERGENCY', color: '#ff2d2d', rank: 2 },
  7600: { meaning: 'RADIO FAILURE', color: '#ffb02e', rank: 1 },
});

/** "7700 GENERAL EMERGENCY" etc. */
export const emergencyHeadline = (record) =>
  `${record.squawk} ${EMERGENCY_SQUAWKS[record.squawk].meaning}`;

const identity = (record) =>
  [record.callsign, record.registration].filter(Boolean).join(' · ') ||
  record.hex.toUpperCase();

export function emergencyPriority(record) {
  return EMERGENCY_SQUAWKS[record.squawk].rank * 1000;
}

/** Validate the `/api/aircraft-emergencies` response. */
export function validateAircraftEmergenciesSnapshot(payload) {
  const envelope = validateEnvelope(payload, 'aircraft-emergencies');
  if (payload.records.length > 500)
    throw new Error('Malformed aircraft-emergencies snapshot');
  const seen = new Set();
  const finiteOrNull = (v) => (Number.isFinite(v) ? v : null);
  const records = payload.records.map((raw) => {
    if (
      typeof raw?.id !== 'string' ||
      seen.has(raw.id) ||
      !Object.hasOwn(EMERGENCY_SQUAWKS, raw.squawk) ||
      !/^[0-9a-f]{6}$/.test(raw.hex)
    )
      throw new Error('Malformed aircraft-emergencies snapshot');
    seen.add(raw.id);
    validCoordinate(raw.lon, raw.lat, 'aircraft-emergencies');
    return {
      id: raw.id.slice(0, 32),
      hex: raw.hex,
      squawk: raw.squawk,
      callsign: boundedText(raw.callsign, 10),
      registration: boundedText(raw.registration, 12),
      aircraftType: boundedText(raw.aircraftType, 8),
      lat: raw.lat,
      lon: raw.lon,
      altitudeFt: finiteOrNull(raw.altitudeFt),
      onGround: raw.onGround === true,
      groundSpeedKt: finiteOrNull(raw.groundSpeedKt),
      trackDeg: finiteOrNull(raw.trackDeg),
      emergencyStatus: boundedText(raw.emergencyStatus, 24),
      positionAgeS: finiteOrNull(raw.positionAgeS),
    };
  });
  return { ...envelope, caveat: SQUAWK_CAVEAT, records };
}

/** Always-on card above each emergency aircraft: code meaning, then identity. */
export function emergencyOverlayEntry(record) {
  const spec = EMERGENCY_SQUAWKS[record.squawk];
  return {
    variant: 'card',
    title: emergencyHeadline(record),
    details: [identity(record)],
    accent: spec.color,
    cardStyle: 'tactical',
    collisionGroup: 'ambient-card',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    interactive: false,
    gapPx: 26,
    leaderOffsetPx: 18,
    verticalOnly: true,
    viewportMargin: 4,
    maxDistance: Number.POSITIVE_INFINITY,
  };
}

const feet = (value) =>
  value === null ? null : `${Math.round(value).toLocaleString('en-US')} ft`;

/** Info card for the selected aircraft. */
export function emergencyCard(record) {
  const spec = EMERGENCY_SQUAWKS[record.squawk];
  const kinematics = [
    record.onGround ? 'On ground' : feet(record.altitudeFt),
    record.groundSpeedKt === null
      ? null
      : `${Math.round(record.groundSpeedKt)} kt`,
    record.trackDeg === null ? null : `track ${Math.round(record.trackDeg)}°`,
  ].filter(Boolean);
  const lines = [
    identity(record) + (record.aircraftType ? ` · ${record.aircraftType}` : ''),
  ];
  if (kinematics.length) lines.push(kinematics.join(' · '));
  lines.push(
    `Squawk ${record.squawk}${record.emergencyStatus && record.emergencyStatus !== 'NONE' ? ` · ${record.emergencyStatus.toLowerCase()}` : ''} · ICAO ${record.hex.toUpperCase()}`,
  );
  if (record.positionAgeS !== null)
    lines.push(`Position ${record.positionAgeS}s old · Source: adsb.lol`);
  lines.push(SQUAWK_CAVEAT);
  return {
    title: emergencyHeadline(record),
    lines,
    url: `https://globe.adsb.lol/?icao=${record.hex}`,
    accent: spec.color,
  };
}

export function emergencyListItem(record) {
  return { lead: record.squawk, text: identity(record) };
}

export const EMERGENCY_LEGEND = Object.freeze(
  Object.entries(EMERGENCY_SQUAWKS).map(([code, { meaning, color }]) => ({
    label: `${code} ${meaning}`,
    color,
  })),
);

/** Analyst record: plain JSON, no Cesium types. */
export function emergencyAnalystRecord(record) {
  return {
    id: record.hex,
    squawk: record.squawk,
    meaning: EMERGENCY_SQUAWKS[record.squawk].meaning,
    callsign: record.callsign,
    registration: record.registration,
    lat: record.lat,
    lon: record.lon,
    altitudeFt: record.altitudeFt,
    groundSpeedKt: record.groundSpeedKt,
  };
}
