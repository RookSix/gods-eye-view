import * as Cesium from 'cesium';
import { AIRPORT_DELAYS_URL, LEVEL_COLORS, PROGRAM_KINDS } from './records.js';

export * from './records.js';

/** 80 -> "1h20", 120 -> "2h", 45 -> "45m". */
export function formatMinutes(total) {
  if (!Number.isFinite(total)) return null;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, '0')}`;
}

const timing = (program) => {
  const avg = formatMinutes(program.avgMin);
  if (avg) return `avg ${avg}`;
  const low = formatMinutes(program.minMin);
  const high = formatMinutes(program.maxMin);
  if (low && high && low !== high) return `${low}-${high}`;
  return high || low || null;
};

/** The lead program is the first one the server ranked, so it is the headline. */
const leadProgram = (record) => record.programs[0];

/** Map label such as "LAS GDP avg 1h20" or "SNA closure". */
export function airportLabelText(record) {
  const lead = leadProgram(record);
  const spec = PROGRAM_KINDS[lead.kind];
  const parts = [record.code, spec.short];
  if (lead.kind === 'closure' && lead.limited) parts.push('(limited)');
  const when = timing(lead);
  if (when) parts.push(when);
  const text = parts.join(' ');
  return record.programs.length > 1
    ? `${text} +${record.programs.length - 1}`
    : text;
}

const utcText = (text) => (text ? text.replace(/\.$/, '') : null);

/** One readable line per program: kind, reason, delay figures, trend and times. */
export function programLine(program) {
  const spec = PROGRAM_KINDS[program.kind];
  const parts = [
    program.direction ? `${spec.label} (${program.direction})` : spec.label,
  ];
  if (program.reason) parts.push(program.reason);
  if (program.avg) parts.push(`avg ${program.avg}`);
  if (program.min) parts.push(`min ${program.min}`);
  if (program.max) parts.push(`max ${program.max}`);
  if (program.trend) parts.push(program.trend.toLowerCase());
  if (program.start) parts.push(`from ${utcText(program.start)}`);
  if (program.reopen) parts.push(`reopens ${utcText(program.reopen)}`);
  if (program.end) parts.push(`until ${utcText(program.end)}`);
  if (program.limited) parts.push('limited closure');
  return parts.join(' · ');
}

/** Importance for list order, label cohorts and collisions. */
export function airportDelayPriority(record) {
  const lead = leadProgram(record);
  return (
    record.rank * 1000 +
    Math.min(999, lead.avgMin ?? lead.maxMin ?? lead.minMin ?? 0) / 10
  );
}

/** Point sized and coloured by severity class. */
export function airportDelayEntityOptions(record, cesium = Cesium) {
  const size = { red: 14, orange: 12, yellow: 10, grey: 7 }[record.level];
  return {
    point: {
      pixelSize: size,
      color: cesium.Color.fromCssColorString(
        LEVEL_COLORS[record.level],
      ).withAlpha(0.95),
      outlineColor: cesium.Color.BLACK.withAlpha(0.7),
      outlineWidth: 1.5,
    },
  };
}

/** Ambient label for every airport with a real restriction. */
export function airportDelayOverlayEntry(record) {
  if (record.level === 'grey') return null;
  return {
    variant: 'label',
    title: airportLabelText(record),
    accent: LEVEL_COLORS[record.level],
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

/** The host shows the first four lines, so the headline and worst programs lead. */
export function airportDelayCard(record) {
  const count = record.programs.length;
  return {
    title: `${record.code} · ${record.name}`,
    lines: [
      `${count} active program${count === 1 ? '' : 's'}`,
      ...record.programs.map(programLine),
      'Source: FAA NAS Status',
    ],
    url: AIRPORT_DELAYS_URL,
    accent: LEVEL_COLORS[record.level],
  };
}

export function airportDelayListItem(record) {
  return {
    lead: PROGRAM_KINDS[leadProgram(record).kind].short.toUpperCase(),
    text: `${record.code} · ${record.name}`,
  };
}

export const AIRPORT_DELAY_LEGEND = Object.freeze([
  { label: 'Closure / ground stop', color: LEVEL_COLORS.red },
  { label: 'Ground delay program', color: LEVEL_COLORS.orange },
  { label: 'General delay', color: LEVEL_COLORS.yellow },
  { label: 'Limited closure / notice', color: LEVEL_COLORS.grey },
]);

/** Analyst record: plain JSON, no Cesium types. */
export function airportDelayAnalystRecord(record) {
  const lead = leadProgram(record);
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    kind: lead.kind,
    level: record.level,
    avgDelayMin: lead.avgMin,
    maxDelayMin: lead.maxMin,
    lat: record.lat,
    lon: record.lon,
  };
}
