import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIMATE_LEGEND,
  anomalyColor,
  anomalySize,
  climateAnalystRecord,
  climateCard,
  climateEntityOptions,
  climateLabel,
  climateOverlayEntry,
  validateClimateAnomaliesSnapshot,
} from './model.js';
import { createClimateAnomaliesSource } from './source.js';

const raw = (over = {}) => ({
  id: 'climate:siberia',
  name: 'Siberia',
  lat: 55.03,
  lon: 82.92,
  tempAnomalyC: -3.4,
  tempRecentC: 1.2,
  tempBaselineC: 4.6,
  precipAnomalyPct: 25,
  precipRecentMm: 12.5,
  precipBaselineMm: 10,
  recentStart: '2026-10-05',
  recentEnd: '2026-10-11',
  baselineStart: '2026-09-05',
  baselineEnd: '2026-10-04',
  ...over,
});
const snapshot = (records, over = {}) => ({
  schemaVersion: 1,
  stale: false,
  fetchedAt: 1,
  source: 'Open-Meteo ERA5',
  attribution: 'ignored',
  method: 'Last 7 days vs 30 before',
  sources: { 'open-meteo': { ok: true, count: records.length } },
  records,
  ...over,
});

test('colour scale: blue cold, near-white neutral, red warm, clamped at the span', () => {
  assert.equal(anomalyColor(-6), '#1f5fff');
  assert.equal(anomalyColor(0), '#e8ecf2');
  assert.equal(anomalyColor(6), '#ff2d2d');
  assert.equal(anomalyColor(-40), anomalyColor(-6));
  assert.equal(anomalyColor(40), anomalyColor(6));
  const [r1] = [anomalyColor(-1), anomalyColor(1)];
  assert.match(r1, /^#[0-9a-f]{6}$/);
});

test('size grows with magnitude and is bounded', () => {
  assert.equal(anomalySize(0), 14);
  assert.ok(anomalySize(-3) === anomalySize(3));
  assert.ok(anomalySize(5) > anomalySize(1));
  assert.equal(anomalySize(100), 38);
});

test('labels carry signed temperature and precipitation values', () => {
  assert.equal(climateLabel(raw({ tempAnomalyC: 2.14 })), '+2.1°C · +25%');
  assert.equal(
    climateLabel(raw({ tempAnomalyC: -0.8, precipAnomalyPct: -40 })),
    '−0.8°C · −40%',
  );
  assert.equal(climateLabel(raw({ precipAnomalyPct: null })), '−3.4°C');
});

test('snapshot validation keeps records, fixes attribution, rejects malformed data', () => {
  const ok = validateClimateAnomaliesSnapshot(snapshot([raw()]));
  assert.equal(ok.records.length, 1);
  assert.equal(ok.attribution, 'Open-Meteo.com (ERA5, CC BY 4.0)');
  assert.equal(ok.records[0].precipAnomalyPct, 25);
  assert.throws(() => validateClimateAnomaliesSnapshot({}), /Malformed/);
  assert.throws(
    () => validateClimateAnomaliesSnapshot(snapshot([raw({ lat: 200 })])),
    /Malformed/,
  );
  assert.throws(
    () => validateClimateAnomaliesSnapshot(snapshot([raw(), raw()])),
    /Malformed/,
  );
  assert.throws(
    () =>
      validateClimateAnomaliesSnapshot(
        snapshot([raw({ tempAnomalyC: 'hot' })]),
      ),
    /Malformed/,
  );
});

test('card documents the method, values, window and attribution', () => {
  const record = validateClimateAnomaliesSnapshot(snapshot([raw()])).records[0];
  const card = climateCard(record);
  assert.equal(card.title, 'Siberia');
  assert.match(card.lines[0], /−3\.4°C \(1\.2°C vs 4\.6°C\)/);
  assert.match(card.lines[1], /\+25%/);
  assert.match(card.lines[2], /Last 7 days 2026-10-05 to 2026-10-11/);
  assert.match(card.lines[2], /30 days 2026-09-05 to 2026-10-04/);
  assert.match(card.lines[3], /Open-Meteo\.com \(ERA5, CC BY 4\.0\)/);
  assert.equal(card.url, 'https://open-meteo.com/');
  const dry = climateCard({ ...record, precipAnomalyPct: null });
  assert.match(dry.lines[1], /too dry/);
});

test('overlay entry is a non-interactive host label; analyst record is plain JSON', () => {
  const record = validateClimateAnomaliesSnapshot(snapshot([raw()])).records[0];
  const entry = climateOverlayEntry(record);
  assert.equal(entry.variant, 'label');
  assert.equal(entry.interactive, false);
  assert.equal(entry.title, '−3.4°C · +25%');
  assert.deepEqual(Object.keys(climateAnalystRecord(record)).sort(), [
    'id',
    'lat',
    'lon',
    'name',
    'precipAnomalyPct',
    'recentEnd',
    'tempAnomalyC',
  ]);
  assert.equal(CLIMATE_LEGEND.length, 3);
});

test('entity options draw a coloured point and never a native label', () => {
  const record = validateClimateAnomaliesSnapshot(snapshot([raw()])).records[0];
  const options = climateEntityOptions(record);
  assert.ok(options.point);
  assert.equal(options.label, undefined);
  assert.equal(options.point.pixelSize, anomalySize(record.tempAnomalyC));
});

test('source asks the same-origin route and validates the body', async () => {
  const seen = [];
  const source = createClimateAnomaliesSource({
    fetchImpl: async (url) => {
      seen.push(url);
      return Response.json(snapshot([raw()]));
    },
  });
  const result = await source.getSnapshot();
  assert.deepEqual(seen, ['/api/climate-anomalies']);
  assert.equal(result.records.length, 1);
});
