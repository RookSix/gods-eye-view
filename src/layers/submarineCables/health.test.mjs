import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CABLE_HEALTH_RADIUS_KM,
  matchWarningsToCables,
  pointToSegmentKm,
  warningSamples,
} from './health.js';
import { createCableHealthChannel } from './healthChannel.js';
import { createCableHealth } from './cableHealth.js';
import { CABLE_HEALTH_CARD_SOURCE_ID } from './policy.js';

const line = (id, coordinates, type = 'LineString') => ({
  id,
  type: 'Feature',
  properties: { name: `Cable ${id}` },
  geometry: { type, coordinates },
});
const warning = (over = {}) => ({
  id: 'nga:2026:A:1',
  title: 'HYDROLANT 1/26',
  issued: '2026-10-10T00:00:00.000Z',
  activity: 'repair',
  excerpt: 'CABLE REPAIR OPERATIONS',
  points: [],
  lines: [],
  ...over,
});

const NORTH_SOUTH = line('ns', [
  [0, 0],
  [0, 2],
]);
const FAR = line('far', [
  [40, 40],
  [41, 41],
]);

test('point-to-segment distance is about right at tens of km', () => {
  // 0.2 degrees of longitude at the equator is about 22.2 km.
  const d = pointToSegmentKm(0.2, 1, 0, 0, 0, 2);
  assert.ok(Math.abs(d - 22.26) < 0.5, String(d));
  assert.equal(pointToSegmentKm(0, 1, 0, 0, 0, 2), 0);
  // Past the end of the segment the distance is to the end point.
  const beyond = pointToSegmentKm(0, 3, 0, 0, 0, 2);
  assert.ok(Math.abs(beyond - 110.57) < 0.5, String(beyond));
  // Degenerate segment.
  assert.ok(pointToSegmentKm(0.1, 0, 0, 0, 0, 0) > 11);
});

test('samples add points along long lines but stay bounded', () => {
  const samples = warningSamples(
    warning({
      points: [[0, 0]],
      lines: [
        [
          [0, 0],
          [0, 1],
        ],
      ],
    }),
  );
  // ~110 km at 20 km steps: 6 steps, 5 interior samples, plus the point.
  assert.equal(samples.length, 1 + 5);
  const huge = warningSamples(
    warning({
      lines: [Array.from({ length: 300 }, (_, i) => [i * 0.5, (i % 2) * 40])],
    }),
  );
  assert.ok(huge.length <= 400);
});

test('a warning point within 50 km flags the cable; one beyond does not', () => {
  const near = matchWarningsToCables(
    [NORTH_SOUTH, FAR],
    [warning({ points: [[0.2, 1]] })],
  );
  assert.deepEqual([...near.keys()], ['ns']);
  assert.equal(near.get('ns')[0].warningId, 'nga:2026:A:1');
  assert.ok(near.get('ns')[0].distanceKm < CABLE_HEALTH_RADIUS_KM);
  const away = matchWarningsToCables(
    [NORTH_SOUTH],
    [warning({ points: [[0.6, 1]] })],
  );
  assert.equal(away.size, 0);
  assert.equal(matchWarningsToCables([NORTH_SOUTH], []).size, 0);
  assert.equal(matchWarningsToCables([NORTH_SOUTH], null).size, 0);
});

test('a warning route crossing a cable between its vertices still matches', () => {
  const crossing = warning({
    points: [
      [-1, 1],
      [1, 1],
    ],
    lines: [
      [
        [-1, 1],
        [1, 1],
      ],
    ],
  });
  // The vertices are ~111 km from the cable; the line itself crosses it.
  const matches = matchWarningsToCables([NORTH_SOUTH], [crossing]);
  assert.equal(matches.get('ns')[0].distanceKm < 5, true);
  const pointsOnly = matchWarningsToCables(
    [NORTH_SOUTH],
    [warning({ points: crossing.points })],
  );
  assert.equal(pointsOnly.size, 0);
});

test('MultiLineString cables and antimeridian crossings are handled', () => {
  const multi = line(
    'multi',
    [
      [
        [10, 10],
        [10, 11],
      ],
      [
        [20, 20],
        [20, 21],
      ],
    ],
    'MultiLineString',
  );
  assert.deepEqual(
    [
      ...matchWarningsToCables(
        [multi],
        [warning({ points: [[20.1, 20.5]] })],
      ).keys(),
    ],
    ['multi'],
  );
  const pacific = line('pacific', [
    [179.5, 0],
    [-179.5, 0],
  ]);
  assert.deepEqual(
    [
      ...matchWarningsToCables(
        [pacific],
        [warning({ points: [[180, 0.2]] })],
      ).keys(),
    ],
    ['pacific'],
  );
  assert.deepEqual(
    [
      ...matchWarningsToCables(
        [pacific],
        [warning({ points: [[-179.8, 0.1]] })],
      ).keys(),
    ],
    ['pacific'],
  );
});

test('matches keep the newest three warnings per cable, newest first', () => {
  const warnings = ['03', '01', '04', '02'].map((day) =>
    warning({
      id: `w${day}`,
      issued: `2026-10-${day}T00:00:00.000Z`,
      points: [[0.05, 1]],
    }),
  );
  const list = matchWarningsToCables([NORTH_SOUTH], warnings).get('ns');
  assert.deepEqual(
    list.map((m) => m.warningId),
    ['w04', 'w03', 'w02'],
  );
});

test('bundled TeleGeography geometry: a warning on a real cable matches it, quickly', async () => {
  const json = JSON.parse(
    await readFile(
      new URL(
        '../../data/local_data/telegeography_submarine_cables/cable-geo.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const features = json.features.map((f, i) => ({
    ...f,
    id: String(f.properties?.id ?? `cable-${i}`),
  }));
  const target = features.find((f) => f.geometry?.type === 'MultiLineString');
  const [lon, lat] = target.geometry.coordinates[0][0];
  // 20 warnings with many samples each: the realistic worst case.
  const warnings = Array.from({ length: 20 }, (_, i) =>
    warning({
      id: `w${i}`,
      points: Array.from({ length: 40 }, (_, k) => [lon + k * 0.01, lat]),
    }),
  );
  const started = performance.now();
  const matches = matchWarningsToCables(features, warnings);
  assert.ok(matches.has(target.id));
  assert.ok(performance.now() - started < 3000, 'matching stays fast');
  assert.ok(matches.size < features.length / 2, 'only nearby cables flagged');
});

test('channel: publish, subscribe, clear, unsubscribe, bounded', () => {
  const channel = createCableHealthChannel();
  const seen = [];
  const off = channel.subscribe((w) => seen.push(w.length));
  channel.publish([warning(), warning({ id: 'b' })]);
  channel.clear();
  channel.clear();
  off();
  channel.publish([warning()]);
  assert.deepEqual(seen, [2, 0]);
  assert.equal(channel.get().length, 1);
  channel.publish(Array.from({ length: 500 }, () => warning()));
  assert.equal(channel.get().length, 200);
  channel.publish('nope');
  assert.deepEqual(channel.get(), []);
  assert.throws(() => channel.get().push(1));
});

/** A cable-health part over plain state, with a recording overlay host. */
function harness() {
  const channel = createCableHealthChannel();
  const hostCalls = [];
  const restyled = [];
  const state = {
    _enabled: true,
    _loaded: true,
    _viewer: null,
    _healthChannel: channel,
    _overlayHost: {
      setVisible: (...args) => hostCalls.push(['visible', ...args]),
      setEntries: (...args) => hostCalls.push(['entries', ...args]),
      clearSource: (...args) => hostCalls.push(['clear', ...args]),
    },
    _healthUnsubscribe: null,
    _healthWarnings: [],
    _healthFeatures: [],
    _healthFeatureById: new Map(),
    _cableEntityByFeatureId: new Map([['ns', { id: 'entity-ns' }]]),
    _healthMatches: new Map(),
    _healthSignature: '',
    _healthCardId: null,
    _referenceRecords: [
      {
        kind: 'cable',
        featureId: 'ns',
        label: 'Cable ns',
        tip: {},
        reference: { lon: 0, lat: 1 },
      },
      {
        kind: 'cable',
        featureId: 'far',
        label: 'Cable far',
        tip: {},
        reference: { lon: 40, lat: 40 },
      },
    ],
    _referenceSweepGate: { markDirty() {} },
  };
  const parts = {
    rendering: {
      styleCableEntity: (entity, feature) =>
        restyled.push([
          entity.id,
          feature.id,
          state._healthMatches.has(feature.id),
        ]),
      resetPublishSignature() {},
    },
  };
  const health = createCableHealth({ state, parts });
  health.setFeatures([NORTH_SOUTH, FAR]);
  return { channel, state, health, hostCalls, restyled };
}

test('health is inert until the channel carries warnings (default look unchanged)', () => {
  const { state, health, restyled, hostCalls } = harness();
  health.attach();
  assert.equal(state._healthMatches.size, 0);
  assert.equal(health.flaggedCount(), 0);
  assert.deepEqual(restyled, []);
  health.select('ns');
  assert.deepEqual(hostCalls, []);
});

test('published warnings flag a nearby cable live and clearing restores it', () => {
  const { channel, state, health, restyled } = harness();
  health.attach();
  channel.publish([warning({ points: [[0.1, 1]] })]);
  assert.deepEqual([...state._healthMatches.keys()], ['ns']);
  assert.deepEqual(restyled.at(-1), ['entity-ns', 'ns', true]);
  assert.equal(
    state._referenceRecords[0].entry.title,
    '⚠ Cable ns',
    'the map label is flagged',
  );
  assert.equal(state._referenceRecords[1].healthFlag, false);
  assert.equal(health.flaggedCount(), 1);
  channel.clear();
  assert.equal(state._healthMatches.size, 0);
  assert.deepEqual(restyled.at(-1), ['entity-ns', 'ns', false]);
  assert.equal(state._referenceRecords[0].entry.title, 'Cable ns');
});

test('clicking a flagged cable shows a card with the warning; another click clears it', () => {
  const { channel, state, health, hostCalls } = harness();
  health.attach();
  channel.publish([warning({ points: [[0.1, 1]] })]);
  health.select('ns');
  const entries = hostCalls.find((c) => c[0] === 'entries');
  assert.equal(entries[1], CABLE_HEALTH_CARD_SOURCE_ID);
  const [card] = entries[2];
  assert.equal(card.title, 'Cable ns');
  assert.equal(card.selected, true);
  assert.equal(card.details.length, 4);
  assert.match(
    card.details[0],
    /Possible fault\/repair activity · HYDROLANT 1\/26/,
  );
  assert.match(card.details[1], /Issued 2026-10-10 00:00 UTC · \d+(\.\d)? km/);
  assert.match(card.details[2], /CABLE REPAIR OPERATIONS/);
  assert.equal(state._healthCardId, 'ns');
  health.select('far');
  assert.deepEqual(hostCalls.at(-2), ['clear', CABLE_HEALTH_CARD_SOURCE_ID]);
  assert.equal(state._healthCardId, null);
});

test('detach unsubscribes, drops matches and the card', () => {
  const { channel, state, health, hostCalls } = harness();
  health.attach();
  channel.publish([warning({ points: [[0.1, 1]] })]);
  health.select('ns');
  health.detach();
  assert.equal(state._healthMatches.size, 0);
  assert.equal(state._healthCardId, null);
  assert.ok(hostCalls.some((c) => c[0] === 'clear'));
  channel.publish([warning({ id: 'later', points: [[0.1, 1]] })]);
  assert.equal(state._healthMatches.size, 0, 'no longer listening');
});

test('cables first enabled after the warnings already exist are flagged at load', () => {
  const { channel, state, health, restyled } = harness();
  channel.publish([warning({ points: [[0.1, 1]] })]);
  health.attach();
  health.setFeatures([NORTH_SOUTH, FAR]);
  assert.deepEqual([...state._healthMatches.keys()], ['ns']);
  assert.ok(restyled.length >= 0);
});
