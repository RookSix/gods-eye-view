import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOSE_BINS,
  RADIATION_CAVEAT,
  doseBin,
  radiationAnalystRecord,
  radiationCard,
  radiationEntityOptions,
  radiationPriority,
  validateRadiationSnapshot,
} from './model.js';
import { createRadiationSource } from './source.js';

const safecast = (over = {}) => ({
  id: 'safecast:d279',
  source: 'safecast',
  name: 'Safecast device 279',
  lat: 51.1,
  lon: -0.2,
  doseUsvh: 0.2,
  rawValue: 66.8,
  rawUnit: 'cpm',
  converted: true,
  time: '2026-10-15T11:00:00.000Z',
  deviceId: 279,
  ...over,
});
const radnet = (over = {}) => ({
  id: 'radnet:CA:LOS ANGELES',
  source: 'radnet',
  name: 'Los Angeles, CA',
  lat: 34.05,
  lon: -118.24,
  doseUsvh: 0.074,
  rawValue: 74,
  rawUnit: 'nsv/h',
  converted: false,
  time: '2026-10-16T20:51:00.000Z',
  status: 'APPROVED',
  ...over,
});
const snapshot = (records) => ({
  schemaVersion: 1,
  stale: false,
  fetchedAt: 1,
  source: 'Safecast + EPA RadNet',
  attribution: 'x',
  sources: {
    safecast: { ok: true, count: 1 },
    radnet: { ok: true, count: 1, sites: 132, failed: 3, empty: 0 },
  },
  records,
});

test('dose bins: under 0.2, 0.2-0.5, 0.5-1, over 1 µSv/h', () => {
  assert.equal(doseBin(0.05).color, DOSE_BINS[0].color);
  assert.equal(doseBin(0.2).color, DOSE_BINS[1].color);
  assert.equal(doseBin(0.499).color, DOSE_BINS[1].color);
  assert.equal(doseBin(0.5).color, DOSE_BINS[2].color);
  assert.equal(doseBin(0.999).color, DOSE_BINS[2].color);
  assert.equal(doseBin(1).color, DOSE_BINS[3].color);
  assert.equal(doseBin(250).color, DOSE_BINS[3].color);
});

test('snapshot validation: both sources kept, duplicates and bad rows rejected', () => {
  const ok = validateRadiationSnapshot(snapshot([safecast(), radnet()]));
  assert.equal(ok.records.length, 2);
  assert.match(ok.attribution, /not an official alert/);
  assert.equal(ok.sources.radnet.count, 1);
  assert.throws(() => validateRadiationSnapshot({}), /Malformed/);
  assert.throws(
    () => validateRadiationSnapshot(snapshot([safecast(), safecast()])),
    /Malformed/,
  );
  assert.throws(
    () => validateRadiationSnapshot(snapshot([safecast({ source: 'other' })])),
    /Malformed/,
  );
  assert.throws(
    () => validateRadiationSnapshot(snapshot([safecast({ doseUsvh: -1 })])),
    /Malformed/,
  );
  assert.throws(
    () => validateRadiationSnapshot(snapshot([safecast({ lon: 999 })])),
    /Malformed/,
  );
});

test('RadNet and Safecast dots are visually distinct', () => {
  const sc = radiationEntityOptions(safecast()).point;
  const rn = radiationEntityOptions(radnet()).point;
  assert.ok(rn.pixelSize > sc.pixelSize);
  assert.ok(rn.outlineWidth > sc.outlineWidth);
  assert.notEqual(
    rn.outlineColor.toCssColorString(),
    sc.outlineColor.toCssColorString(),
  );
  assert.equal(radiationEntityOptions(safecast()).label, undefined);
});

test('card: Safecast cpm conversion is stated, RadNet shows nSv/h, caveat always present', () => {
  const sc = radiationCard(safecast());
  assert.equal(sc.title, 'Safecast device 279');
  assert.match(sc.lines[0], /0\.200 µSv\/h · 2026-10-15 11:00 UTC/);
  assert.match(sc.lines[1], /Converted from 66\.8 cpm \(÷ 334/);
  assert.match(sc.lines[2], /Safecast · device 279/);
  assert.equal(sc.lines.at(-1), RADIATION_CAVEAT);
  assert.equal(sc.url, 'https://map.safecast.org/');
  const rn = radiationCard(radnet());
  assert.match(rn.lines[1], /Reported 74 nSv\/h · APPROVED/);
  assert.equal(rn.url, 'https://www.epa.gov/radnet');
  assert.equal(rn.lines.at(-1), RADIATION_CAVEAT);
  const native = radiationCard(safecast({ converted: false, rawUnit: 'usv' }));
  assert.match(native.lines[1], /µSv\/h by the device/);
});

test('priority and analyst record', () => {
  assert.ok(
    radiationPriority(radnet({ doseUsvh: 1 })) >
      radiationPriority(safecast({ doseUsvh: 0.1 })),
  );
  const analyst = radiationAnalystRecord(radnet());
  assert.equal(analyst.timeMs, Date.parse('2026-10-16T20:51:00.000Z'));
  assert.equal(analyst.source, 'radnet');
});

test('source requests the same-origin route', async () => {
  const seen = [];
  const source = createRadiationSource({
    fetchImpl: async (url) => {
      seen.push(url);
      return Response.json(snapshot([radnet()]));
    },
  });
  assert.equal((await source.getSnapshot()).records.length, 1);
  assert.deepEqual(seen, ['/api/radiation']);
});
