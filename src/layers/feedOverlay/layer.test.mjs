import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createNaturalEventsLayer } from '../naturalEvents/index.js';
import { createAircraftEmergenciesLayer } from '../aircraftEmergencies/index.js';
import { createGpsJammingLayer } from '../gpsJamming/index.js';
import { validateNaturalEventsSnapshot } from '../naturalEvents/records.js';
import { validateAircraftEmergenciesSnapshot } from '../aircraftEmergencies/records.js';
import { validateGpsJammingSnapshot } from '../gpsJamming/model.js';

const envelope = { schemaVersion: 1, stale: false, fetchedAt: 1, sources: {} };

function harness(createLayer, feed) {
  const events = [];
  const dataSources = [];
  const handlers = [];
  class FakeHandler {
    constructor() {
      this.actions = new Map();
      this.destroyed = false;
      handlers.push(this);
    }
    setInputAction(fn, type) {
      this.actions.set(type, fn);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const groundPrimitives = [];
  const picked = { value: undefined };
  const viewer = {
    dataSources: {
      add: (value) => dataSources.push(value),
      remove: (value) => dataSources.splice(dataSources.indexOf(value), 1),
    },
    scene: {
      canvas: {},
      pick: () => picked.value,
      groundPrimitives: {
        add: (p) => groundPrimitives.push(p),
        remove: (p) => groundPrimitives.splice(groundPrimitives.indexOf(p), 1),
      },
    },
    camera: { flyToBoundingSphere: (...args) => events.push(['fly', args]) },
  };
  const opened = [];
  const layer = createLayer({
    feed,
    cesium: { ...Cesium, ScreenSpaceEventHandler: FakeHandler },
    overlayHost: {
      setEntries: (...args) => events.push(['entries', ...args]),
      setVisible: (...args) => events.push(['visible', ...args]),
      clearSource: (...args) => events.push(['clear', ...args]),
    },
    openLink: (url) => opened.push(url),
    matchMedia: () => ({ matches: true }),
  });
  layer.init(viewer);
  const lastEntries = () =>
    events.filter(([kind]) => kind === 'entries').at(-1)?.[2] ?? null;
  const click = () =>
    handlers.at(-1).actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)({
      position: { x: 5, y: 5 },
    });
  return {
    layer,
    viewer,
    events,
    dataSources,
    handlers,
    groundPrimitives,
    picked,
    opened,
    lastEntries,
    click,
  };
}

const naturalSnapshot = () =>
  validateNaturalEventsSnapshot({
    ...envelope,
    source: 'GDACS + NASA EONET',
    sources: { gdacs: { ok: true, count: 2 }, eonet: { ok: false } },
    records: [
      {
        id: 'gdacs:TC:2',
        source: 'gdacs',
        kind: 'storm',
        category: 'Tropical cyclone',
        title: 'Tropical Cyclone TRUDY-26',
        lat: 15.2,
        lon: -102.5,
        time: '2026-10-13T00:00:00.000Z',
        endTime: '2026-10-17T00:00:00.000Z',
        alert: 'red',
        severity: 'Category 2, 160 km/h',
        magnitude: null,
        country: 'Mexico',
        url: 'https://www.gdacs.org/report.aspx?eventid=2',
      },
      {
        id: 'gdacs:FL:3',
        source: 'gdacs',
        kind: 'flood',
        category: 'Flood',
        title: 'Flood in Peru',
        lat: -10,
        lon: -70,
        time: null,
        endTime: null,
        alert: 'green',
        severity: null,
        magnitude: null,
        country: 'Peru',
        url: null,
      },
      {
        id: 'eonet:EONET_1',
        source: 'eonet',
        kind: 'wildfire',
        category: 'Wildfires',
        title: 'Canyon Fire',
        lat: 40,
        lon: -120,
        time: '2026-10-16T00:00:00.000Z',
        endTime: null,
        alert: null,
        severity: null,
        magnitude: { value: 1200, unit: 'acres' },
        country: null,
        url: 'https://example.gov/fire',
      },
    ],
  });

test('natural events: points by category, labels only for orange/red, off until enabled', async () => {
  const h = harness(createNaturalEventsLayer, {
    getSnapshot: async () => naturalSnapshot(),
  });
  assert.equal(h.dataSources.length, 1);
  assert.equal(h.dataSources[0].show, false);
  assert.equal(
    await h.layer.update(h.viewer),
    false,
    'disabled layers do not fetch',
  );
  h.layer.enable();
  assert.equal(h.dataSources[0].show, true);
  assert.equal(await h.layer.update(h.viewer), true);
  assert.equal(h.dataSources[0].entities.values.length, 3);
  const entry = h.lastEntries();
  assert.deepEqual(
    entry.map((e) => e.id),
    ['gdacs:TC:2'],
    'only the red alert earns an ambient label',
  );
  assert.equal(entry[0].variant, 'label');
  assert.equal(entry[0].accent, '#ff3b3b');
  const stats = h.layer.getStats();
  assert.equal(stats.count, 3);
  assert.equal(stats.partial, true, 'EONET failed in the snapshot');
  assert.equal(stats.fallback, false);
  assert.match(h.layer.getRowControls().info, /Partial: eonet unavailable/);
  assert.equal(h.layer.id, 'natural-events');
});

test('natural events: click selects, card carries time/severity/source and links upstream', async () => {
  const h = harness(createNaturalEventsLayer, {
    getSnapshot: async () => naturalSnapshot(),
  });
  h.layer.enable();
  await h.layer.update(h.viewer);
  const entity = h.dataSources[0].entities.values.find(
    (e) => e.id === 'natural-events:gdacs:TC:2',
  );
  assert.ok(entity, 'entity ids are layer-prefixed');
  h.picked.value = { id: entity };
  h.click();
  const selected = h.lastEntries().find((e) => e.variant === 'selected');
  assert.equal(selected.title, 'Tropical Cyclone TRUDY-26');
  assert.ok(selected.details.some((line) => line.includes('RED alert')));
  assert.ok(selected.details.some((line) => line.includes('Category 2')));
  const controls = h.layer.getRowControls();
  assert.match(controls.info, /Source: GDACS/);
  assert.deepEqual(
    controls.chips.map((c) => c.id),
    ['open', 'clear'],
  );
  assert.equal(
    controls.list.items[0].id,
    'gdacs:TC:2',
    'red alert sorts first',
  );
  assert.equal(controls.list.items[0].active, true);
  h.layer.setParams({ open: true });
  assert.deepEqual(h.opened, ['https://www.gdacs.org/report.aspx?eventid=2']);
  // The selection ring is one extra entity.
  assert.equal(h.dataSources[0].entities.values.length, 4);
  // Clicking empty globe clears it.
  h.picked.value = undefined;
  h.click();
  assert.equal(
    h.lastEntries().some((e) => e.variant === 'selected'),
    false,
  );
  assert.equal(h.dataSources[0].entities.values.length, 3);
  // Another layer's pick is left alone.
  h.layer.setParams({ recordId: 'eonet:EONET_1' });
  h.picked.value = { id: { id: 'flights:abc' } };
  h.click();
  assert.equal(h.layer.getDiagnostics().selectedId, 'eonet:EONET_1');
});

test('focus params fly the camera through the shell navigation runner', async () => {
  const h = harness(createNaturalEventsLayer, {
    getSnapshot: async () => naturalSnapshot(),
  });
  h.layer.attachShellServices({ runNavigation: (fn) => fn() });
  h.layer.enable();
  await h.layer.update(h.viewer);
  h.layer.setParams({ recordId: 'eonet:EONET_1', focus: true });
  const fly = h.events.find(([kind]) => kind === 'fly');
  assert.ok(fly);
  assert.equal(fly[1][1].duration, 0, 'reduced motion honoured');
  h.layer.setParams({ recordId: 'unknown' });
  assert.equal(h.layer.getDiagnostics().selectedId, 'eonet:EONET_1');
});

test('disable aborts the request, clears the overlay and discards a late snapshot', async () => {
  let resolve, signal;
  const h = harness(createNaturalEventsLayer, {
    getSnapshot: (options) => {
      signal = options.signal;
      return new Promise((done) => (resolve = done));
    },
  });
  h.layer.enable();
  const pending = h.layer.update(h.viewer);
  h.layer.disable();
  assert.equal(signal.aborted, true);
  assert.ok(h.events.some(([kind]) => kind === 'clear'));
  resolve(naturalSnapshot());
  assert.equal(await pending, false);
  assert.equal(h.dataSources[0].entities.values.length, 0);
  assert.equal(h.handlers.at(-1).destroyed, true, 'click handler released');
  h.layer.destroy();
  assert.equal(h.dataSources.length, 0, 'data source removed on destroy');
});

test('a failed refresh keeps the last good snapshot and reports the error', async () => {
  let fail = false;
  const h = harness(createNaturalEventsLayer, {
    getSnapshot: async () => {
      if (fail) throw new Error('Natural events HTTP 502');
      return naturalSnapshot();
    },
  });
  h.layer.enable();
  await h.layer.update(h.viewer);
  fail = true;
  assert.equal(await h.layer.update(h.viewer), false);
  const stats = h.layer.getStats();
  assert.equal(stats.error, 'Natural events HTTP 502');
  assert.equal(stats.count, 3);
  assert.equal(h.dataSources[0].entities.values.length, 3);
});

const emergencySnapshot = (records) =>
  validateAircraftEmergenciesSnapshot({
    ...envelope,
    source: 'adsb.lol',
    sources: { 7700: { ok: true, count: 1 } },
    records,
  });
const emergency = (extra = {}) => ({
  id: '4d225c:7700',
  hex: '4d225c',
  squawk: '7700',
  callsign: 'RYR6789',
  registration: '9H-QDD',
  aircraftType: 'B738',
  lat: 45.4,
  lon: 12.2,
  altitudeFt: 2525,
  onGround: false,
  groundSpeedKt: 165.7,
  trackDeg: 90,
  emergencyStatus: 'GENERAL',
  positionAgeS: 1,
  ...extra,
});

test('aircraft emergencies: heading-aligned marker and always-on overlay cards', async () => {
  const h = harness(createAircraftEmergenciesLayer, {
    getSnapshot: async () =>
      emergencySnapshot([
        emergency(),
        emergency({
          id: '111111:7500',
          hex: '111111',
          squawk: '7500',
          callsign: null,
          registration: null,
        }),
        emergency({
          id: '222222:7600',
          hex: '222222',
          squawk: '7600',
          trackDeg: null,
        }),
      ]),
  });
  h.layer.enable();
  await h.layer.update(h.viewer);
  const entities = h.dataSources[0].entities.values;
  assert.equal(entities.length, 3);
  const plane = entities.find(
    (e) => e.id === 'aircraft-emergencies:4d225c:7700',
  );
  const time = Cesium.JulianDate.now();
  assert.ok(
    Math.abs(plane.billboard.rotation.getValue(time) + Math.PI / 2) < 1e-9,
    'a due-east track rotates the north-up icon 90 degrees clockwise',
  );
  assert.ok(plane.billboard.alignedAxis.getValue(time));
  assert.match(plane.billboard.image.getValue(time), /^data:image\/svg\+xml,/);
  const cards = h.lastEntries();
  assert.deepEqual(
    cards.map((c) => c.title),
    ['7500 HIJACK', '7700 GENERAL EMERGENCY', '7600 RADIO FAILURE'],
    'hijack outranks general emergency, then radio failure',
  );
  assert.deepEqual(cards[1].details, ['RYR6789 · 9H-QDD']);
  assert.deepEqual(
    cards[0].details,
    ['111111'],
    'falls back to the ICAO address',
  );
  assert.ok(cards.every((c) => c.variant === 'card'));
});

test('aircraft emergencies: selected card repeats the not-a-confirmed-incident caveat', async () => {
  const h = harness(createAircraftEmergenciesLayer, {
    getSnapshot: async () => emergencySnapshot([emergency()]),
  });
  h.layer.enable();
  await h.layer.update(h.viewer);
  h.layer.setParams({ recordId: '4d225c:7700' });
  const selected = h.lastEntries().find((c) => c.variant === 'selected');
  assert.equal(selected.title, '7700 GENERAL EMERGENCY');
  const controls = h.layer.getRowControls();
  assert.ok(
    controls.info
      .split('\n')
      .filter((l) => l === 'A squawk is not a confirmed incident.').length >= 1,
  );
  assert.match(controls.info, /2,525 ft · 166 kt · track 90°/);
  assert.match(controls.info, /ICAO 4D225C/);
  h.layer.setParams({ open: true });
  assert.deepEqual(h.opened, ['https://globe.adsb.lol/?icao=4d225c']);
  assert.equal(
    h.layer.getStats().fallback,
    false,
    'adsb.lol is not a degraded fallback here',
  );
  assert.doesNotMatch(h.layer.source, /adsb\.lol/i);
});

test('aircraft emergencies: empty snapshot is stated plainly and cards clear', async () => {
  const h = harness(createAircraftEmergenciesLayer, {
    getSnapshot: async () => emergencySnapshot([]),
  });
  h.layer.enable();
  await h.layer.update(h.viewer);
  assert.equal(h.lastEntries().length, 0);
  assert.match(
    h.layer.getRowControls().info,
    /No aircraft squawking 7500 \/ 7600 \/ 7700/,
  );
});

const gpsSnapshot = () =>
  validateGpsJammingSnapshot({
    ...envelope,
    date: '2026-10-15',
    suspect: false,
    records: [
      { hex: '8401261ffffffff', ratio: 0.333, level: 'high', good: 2, bad: 1 },
      { hex: '8401351ffffffff', ratio: 0.1, level: 'medium', good: 45, bad: 5 },
      { hex: '840135dffffffff', ratio: 0.333, level: 'high', good: 10, bad: 5 },
    ],
  });

test('gps jamming: one batched ground primitive per level, cells are polygons', async () => {
  const h = harness(createGpsJammingLayer, {
    getSnapshot: async () => gpsSnapshot(),
  });
  h.layer.enable();
  await h.layer.update(h.viewer);
  assert.equal(h.groundPrimitives.length, 2);
  assert.deepEqual(
    h.groundPrimitives.map((p) => p.geometryInstances.length).sort(),
    [1, 2],
  );
  assert.ok(h.groundPrimitives.every((p) => p.show === true));
  assert.equal(h.lastEntries().length, 0, 'no text on ambient cells');
  assert.match(
    h.layer.getRowControls().info,
    /3 interference cells \(2 high\) · data day 2026-10-15/,
  );
  h.layer.disable();
  assert.equal(h.groundPrimitives.length, 0);
});

test('gps jamming: picking a cell selects it with an outline and an info card', async () => {
  const h = harness(createGpsJammingLayer, {
    getSnapshot: async () => gpsSnapshot(),
  });
  h.layer.enable();
  await h.layer.update(h.viewer);
  const [primitive] = h.groundPrimitives;
  h.picked.value = { id: primitive.geometryInstances[0].id, primitive };
  h.click();
  const id = h.layer.getDiagnostics().selectedId;
  assert.match(id, /^84/);
  const selected = h.lastEntries().find((e) => e.variant === 'selected');
  assert.match(selected.title, /^GPS interference \d+%$/);
  assert.ok(
    selected.details.some((line) =>
      /aircraft reported degraded navigation/.test(line),
    ),
  );
  assert.equal(h.dataSources[0].entities.values.length, 1, 'selection outline');
  assert.match(h.layer.getRowControls().info, /Source: gpsjam\.org/);
  h.layer.destroy();
  assert.equal(h.dataSources.length, 0);
  assert.equal(h.groundPrimitives.length, 0);
});

test('validators reject malformed snapshots instead of drawing partial data', () => {
  assert.throws(() => validateNaturalEventsSnapshot({}), /Malformed/);
  assert.throws(
    () =>
      validateNaturalEventsSnapshot({
        ...envelope,
        records: [{ id: 'x', source: 'gdacs', kind: 'meteor', lat: 0, lon: 0 }],
      }),
    /Malformed/,
  );
  assert.throws(
    () =>
      validateAircraftEmergenciesSnapshot({
        ...envelope,
        records: [emergency({ squawk: '1200' })],
      }),
    /Malformed/,
  );
  assert.throws(
    () =>
      validateAircraftEmergenciesSnapshot({
        ...envelope,
        records: [emergency({ lat: 91 })],
      }),
    /Malformed/,
  );
  assert.throws(
    () =>
      validateGpsJammingSnapshot({
        ...envelope,
        date: '2026-10-15',
        records: [
          { hex: 'nothex', ratio: 0.5, level: 'high', good: 1, bad: 1 },
        ],
      }),
    /Malformed/,
  );
  assert.throws(
    () => validateGpsJammingSnapshot({ ...envelope, records: [] }),
    /Malformed/,
    'a missing data day is not an empty map',
  );
  const dup = emergency();
  assert.throws(
    () =>
      validateAircraftEmergenciesSnapshot({ ...envelope, records: [dup, dup] }),
    /Malformed/,
  );
});

test('validators strip markup and non-https links', () => {
  const [record] = validateNaturalEventsSnapshot({
    ...envelope,
    records: [
      {
        id: 'eonet:1',
        source: 'eonet',
        kind: 'wildfire',
        title: '<img src=x onerror=alert(1)>Fire',
        lat: 1,
        lon: 2,
        url: 'javascript:alert(1)',
      },
    ],
  }).records;
  assert.doesNotMatch(record.title, /[<>]/);
  assert.equal(record.url, null);
});
