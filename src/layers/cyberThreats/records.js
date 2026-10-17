import {
  boundedText,
  httpsUrl,
  validCoordinate,
  validateEnvelope,
} from '../feedOverlay/source.js';

export const CYBER_THREATS_LAYER_ID = 'cyber-threats';
export const CYBER_THREATS_CAVEAT =
  'IP geolocation shows hosting location, not the actor.';
export const CYBER_THREATS_ATTRIBUTION =
  'abuse.ch Feodo Tracker (CC0), C2IntelFeeds, and optional URLhaus / AlienVault OTX / AbuseIPDB. IP geolocation shows hosting location, not the actor.';

export const CYBER_SOURCES = Object.freeze({
  feodo: {
    label: 'Feodo Tracker',
    url: 'https://feodotracker.abuse.ch/browse/',
  },
  c2intel: {
    label: 'C2IntelFeeds',
    url: 'https://github.com/drb-ra/C2IntelFeeds',
  },
  urlhaus: { label: 'URLhaus', url: 'https://urlhaus.abuse.ch/' },
  otx: { label: 'AlienVault OTX', url: 'https://otx.alienvault.com/' },
  abuseipdb: { label: 'AbuseIPDB', url: 'https://www.abuseipdb.com/' },
});

export const CYBER_CATEGORIES = Object.freeze({
  'botnet-c2': 'Botnet C2',
  'c2-framework': 'C2 framework server',
  'malware-url': 'Malware URL host',
  otx: 'OTX indicator',
  abuse: 'Reported abuse',
});

/** Fixed colours for the families worth recognising at a glance. */
const KNOWN_FAMILY_COLORS = Object.freeze({
  'cobalt strike': '#ff3b5c',
  emotet: '#ffb020',
  qakbot: '#3da5ff',
  dridex: '#c77dff',
  trickbot: '#2fd6c4',
  bazarloader: '#ff7a1a',
  pikabot: '#e8f1ff',
  metasploit: '#7fe66d',
  sliver: '#e0b3ff',
  havoc: '#ff9ec7',
});
const FALLBACK_PALETTE = Object.freeze([
  '#4dd0e1',
  '#f6e05e',
  '#ff8f6b',
  '#9ccc65',
  '#b39ddb',
  '#f48fb1',
  '#80cbc4',
  '#ffd54f',
]);

/** Stable colour for a malware or framework family. */
export function familyColor(family) {
  const key = String(family || '').toLowerCase();
  if (Object.hasOwn(KNOWN_FAMILY_COLORS, key)) return KNOWN_FAMILY_COLORS[key];
  let hash = 0;
  for (let i = 0; i < key.length; i++)
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}

const MAX_RECORDS = 2_600;

/** Validate the `/api/cyber-threats` response before anything is drawn. */
export function validateCyberThreatsSnapshot(payload) {
  const envelope = validateEnvelope(payload, 'cyber-threats');
  if (payload.records.length > MAX_RECORDS)
    throw new Error('Malformed cyber-threats snapshot');
  const seen = new Set();
  const records = payload.records.map((raw) => {
    if (
      typeof raw?.id !== 'string' ||
      seen.has(raw.id) ||
      !Object.hasOwn(CYBER_SOURCES, raw.source) ||
      !Object.hasOwn(CYBER_CATEGORIES, raw.category) ||
      (raw.precision !== 'ip' && raw.precision !== 'country')
    )
      throw new Error('Malformed cyber-threats snapshot');
    seen.add(raw.id);
    validCoordinate(raw.lon, raw.lat, 'cyber-threats');
    const ip = boundedText(raw.ip, 45);
    if (!ip) throw new Error('Malformed cyber-threats snapshot');
    return {
      id: raw.id.slice(0, 60),
      ip,
      source: raw.source,
      sources: (Array.isArray(raw.sources) ? raw.sources : [raw.source])
        .filter((key) => Object.hasOwn(CYBER_SOURCES, key))
        .slice(0, 5),
      category: raw.category,
      family: boundedText(raw.family, 60) || CYBER_CATEGORIES[raw.category],
      port:
        Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536
          ? raw.port
          : null,
      status:
        raw.status === 'online' || raw.status === 'offline' ? raw.status : null,
      hostname: boundedText(raw.hostname, 120),
      asn: boundedText(raw.asn, 16),
      asName: boundedText(raw.asName, 80),
      org: boundedText(raw.org, 80),
      country: boundedText(raw.country, 2),
      city: boundedText(raw.city, 60),
      firstSeen: boundedText(raw.firstSeen, 32),
      lastSeen: boundedText(raw.lastSeen, 32),
      url: httpsUrl(raw.url),
      lat: raw.lat,
      lon: raw.lon,
      precision: raw.precision,
    };
  });
  const geo = payload.geo && typeof payload.geo === 'object' ? payload.geo : {};
  const count = (value) => (Number.isFinite(value) ? value : 0);
  return {
    ...envelope,
    attribution: CYBER_THREATS_ATTRIBUTION,
    geo: {
      ipLocated: count(geo.ipLocated),
      countryCentroid: count(geo.countryCentroid),
      dropped: count(geo.dropped),
      lookupsCapped: geo.lookupsCapped === true,
    },
    records,
  };
}
