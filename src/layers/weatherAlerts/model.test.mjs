import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEVERITY_STYLES,
  WEATHER_ALERT_LABEL_LIMIT,
  labelAlerts,
  validateWeatherAlertsSnapshot,
  weatherAlertAnalystRecord,
  weatherAlertCard,
  weatherAlertListItem,
  weatherAlertOverlayEntry,
  weatherAlertPriority,
} from './model.js';
import {
  WEATHER_ALERT_ENTITY_LIMIT,
  createWeatherAlertsRenderer,
} from './rendering.js';
import { createWeatherAlertsSource } from './source.js';

const alert = (id, over = {}) => ({
  id,
  source: 'nws',
  event: 'Tornado Warning',
  severity: 'Severe',
  urgency: 'Immediate',
  certainty: 'Observed',
  headline: 'Tornado Warning issued by NWS Norman OK',
  area: 'Cleveland; Oklahoma',
  onset: '2026-10-17T04:49:00.000Z',
  expires: '2026-10-17T09:00:00.000Z',
  issuer: 'NWS Norman OK',
  url: 'https://api.weather.gov/alerts/urn:oid:1',
  lat: 35.5,
  lon: -96,
  areaDeg2: 4,
  rings: [
    [
      [-97, 35],
      [-95, 35],
      [-95, 37],
      [-97, 37],
    ],
  ],
  ...over,
});
const snapshot = (records) => ({
  schemaVersion: 1,
  stale: false,
  fetchedAt: 1,
  source: 'NWS + ECCC + WMO SWIC',
  attribution: 'x',
  minSeverity: 'Moderate',
  skipped: { noGeometry: 5, filtered: 7, duplicates: 2, truncated: 0 },
  sources: {
    nws: { ok: true, count: records.length },
    eccc: { ok: true, count: 0 },
    wmo: { ok: false, stale: true, count: 0 },
  },
  records,
});

test('snapshot validation keeps good alerts and rejects malformed ones', () => {
  const ok = validateWeatherAlertsSnapshot(
    snapshot([alert('nws:a'), alert('wmo:b', { source: 'wmo' })]),
  );
  assert.equal(ok.records.length, 2);
  assert.equal(ok.skipped.noGeometry, 5);
  assert.equal(ok.minSeverity, 'Moderate');
  assert.equal(ok.sources.wmo.ok, false);
  assert.throws(() => validateWeatherAlertsSnapshot({}), /Malformed/);
  for (const bad of [
    alert('nws:a', { severity: 'Catastrophic' }),
    alert('nws:a', { source: 'bbc' }),
    alert('nws:a', { lat: 120 }),
    alert('nws:a', { rings: [] }),
    alert('nws:a', {
      rings: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    }),
    alert('nws:a', {
      rings: [
        [
          [0, 0],
          [1, 1],
          [500, 2],
        ],
      ],
    }),
    alert('nws:a', {
      rings: Array.from({ length: 5 }, () => alert('x').rings[0]),
    }),
  ])
    assert.throws(
      () => validateWeatherAlertsSnapshot(snapshot([bad])),
      /Malformed/,
    );
  assert.throws(
    () => validateWeatherAlertsSnapshot(snapshot([alert('a'), alert('a')])),
    /Malformed/,
  );
  const clean = validateWeatherAlertsSnapshot(
    snapshot([alert('nws:a', { url: 'http://insecure.example/' })]),
  );
  assert.equal(clean.records[0].url, null, 'only https links survive');
});

test('only a few of the most severe and largest alerts get labels', () => {
  const records = [
    ...Array.from({ length: 15 }, (_, i) =>
      alert(`s${i}`, { areaDeg2: i + 1 }),
    ),
    alert('moderate', { severity: 'Moderate', areaDeg2: 1000 }),
    alert('extreme', { severity: 'Extreme', areaDeg2: 0.1 }),
  ];
  const labelled = labelAlerts(records);
  const names = labelled.filter((r) => r.labelled).map((r) => r.id);
  assert.equal(names.length, WEATHER_ALERT_LABEL_LIMIT);
  assert.ok(names.includes('extreme'), 'extreme beats size');
  assert.ok(!names.includes('moderate'), 'moderate alerts are never labelled');
  assert.ok(names.includes('s14') && !names.includes('s0'));
  const entry = weatherAlertOverlayEntry(
    labelled.find((r) => r.id === 'extreme'),
  );
  assert.equal(entry.variant, 'label');
  assert.equal(entry.accent, SEVERITY_STYLES.Extreme.color);
  assert.equal(entry.interactive, false);
  assert.equal(
    weatherAlertOverlayEntry(labelled.find((r) => r.id === 's0')),
    null,
  );
});

test('priority orders by severity, then footprint', () => {
  assert.ok(
    weatherAlertPriority(alert('a', { severity: 'Extreme', areaDeg2: 1 })) >
      weatherAlertPriority(alert('b', { severity: 'Severe', areaDeg2: 900 })),
  );
  assert.ok(
    weatherAlertPriority(alert('a', { areaDeg2: 9 })) >
      weatherAlertPriority(alert('b', { areaDeg2: 1 })),
  );
});

test('card shows severity, area, times, headline and source', () => {
  const card = weatherAlertCard(alert('nws:a'));
  assert.equal(card.title, 'Tornado Warning');
  assert.equal(
    card.lines[0],
    'Severe · Immediate urgency · Observed certainty',
  );
  assert.equal(card.lines[1], 'Cleveland; Oklahoma');
  assert.equal(
    card.lines[2],
    'From 2026-10-17 04:49 UTC until 2026-10-17 09:00 UTC',
  );
  assert.match(card.lines.at(-1), /Source: US NWS · NWS Norman OK/);
  assert.equal(card.url, 'https://api.weather.gov/alerts/urn:oid:1');
  assert.equal(card.accent, SEVERITY_STYLES.Severe.color);
  assert.equal(weatherAlertListItem(alert('a')).lead, 'SEVERE');
  const record = weatherAlertAnalystRecord(alert('a'));
  assert.equal(record.severity, 'Severe');
  assert.ok(!('rings' in record), 'outlines stay out of analyst records');
});

function fixture() {
  const sources = [];
  const viewer = {
    dataSources: {
      add: (source) => sources.push(source),
      remove: (source) => sources.splice(sources.indexOf(source), 1),
    },
  };
  return {
    renderer: createWeatherAlertsRenderer({
      viewer,
      layerId: 'weather-alerts',
    }),
    sources,
  };
}

test('every part of an alert picks as that alert; no native labels', () => {
  const { renderer, sources } = fixture();
  renderer.setRecords([alert('nws:a'), alert('eccc:b', { source: 'eccc' })]);
  const entities = sources[0].entities.values;
  assert.equal(entities.length, 4, 'a polygon and an outline per ring');
  for (const entity of entities) {
    assert.match(
      renderer.recordIdFromPick({ id: { id: entity.id } }),
      /^(nws:a|eccc:b)$/,
    );
    assert.ok(!entity.label);
  }
  assert.equal(renderer.recordIdFromPick({ id: { id: 'other:x' } }), null);
  assert.equal(
    renderer.recordIdFromPick({
      id: { id: 'weather-alerts:__selection:nws:a' },
    }),
    'nws:a',
  );
});

test('selection draws one ring that moves and clears', () => {
  const { renderer, sources } = fixture();
  renderer.setRecords([alert('a'), alert('b')], 'a');
  const count = () =>
    sources[0].entities.values.filter((e) => e.id.includes('__selection'))
      .length;
  assert.equal(count(), 1);
  renderer.setSelection('b');
  assert.equal(count(), 1);
  renderer.setSelection(null);
  assert.equal(count(), 0);
});

test('entities are capped and the data source is released on destroy', () => {
  const { renderer, sources } = fixture();
  const many = Array.from({ length: 2_000 }, (_, i) => alert(`w${i}`));
  renderer.setRecords(many);
  assert.ok(sources[0].entities.values.length <= WEATHER_ALERT_ENTITY_LIMIT);
  renderer.setVisible(true);
  assert.equal(renderer.getDiagnostics().visible, true);
  renderer.clear();
  assert.equal(renderer.getDiagnostics().entities, 0);
  renderer.destroy();
  assert.equal(sources.length, 0);
  renderer.destroy();
});

test('the source reads the same-origin route and validates its payload', async () => {
  const urls = [];
  const source = createWeatherAlertsSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json(snapshot([alert('nws:a')]));
    },
  });
  assert.equal((await source.getSnapshot()).records.length, 1);
  assert.deepEqual(urls, ['/api/weather-alerts']);
  const bad = createWeatherAlertsSource({
    fetchImpl: async () => Response.json({}),
  });
  await assert.rejects(() => bad.getSnapshot(), /Malformed/);
});
