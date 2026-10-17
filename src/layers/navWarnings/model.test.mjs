import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NAV_WARNING_KINDS,
  NAV_WARNING_LEGEND,
  cableWarningSummary,
  navWarningAnalystRecord,
  navWarningCard,
  navWarningOverlayEntry,
  navWarningPriority,
  validateNavWarningsSnapshot,
  warningExcerpt,
  warningTitle,
} from './model.js';
import { createNavWarningsSource } from './source.js';
import { createNavWarningsLayer } from './index.js';
import { createCableHealthChannel } from '../submarineCables/healthChannel.js';

const raw = (over = {}) => ({
  id: 'nga:2024:4:127',
  year: 2024,
  number: 127,
  navArea: '4',
  areaName: 'NAVAREA IV',
  subregion: '24,25',
  place: 'CARIBBEAN SEA, ARUBA',
  issued: '2024-01-31T01:00:00.000Z',
  authority: 'NGA NAVSAFETY 0/24 310046Z JAN 24.',
  kind: 'cable',
  cableActivity: 'operations',
  text: 'CARIBBEAN SEA. ARUBA. CABLE OPERATIONS IN PROGRESS UNTIL FURTHER NOTICE BY CABLESHIP PANAM ALONG TRACKLINES JOINING: A. 13-10.34N 069-51.47W, 12-55.78N 069-48.86W.',
  lat: 13.1,
  lon: -69.8,
  points: [
    { lat: 13.17233, lon: -69.85783 },
    { lat: 12.92967, lon: -69.81433 },
  ],
  shapes: [
    {
      kind: 'line',
      points: [
        [-69.85783, 13.17233],
        [-69.81433, 12.92967],
      ],
    },
  ],
  ...over,
});
const snapshot = (records, extra = {}) => ({
  schemaVersion: 1,
  stale: false,
  fetchedAt: 1,
  source: 'NGA Maritime Safety Information',
  attribution: 'x',
  sources: { nga: { ok: true, count: records.length } },
  total: records.length + 2,
  withoutPosition: 2,
  records,
  ...extra,
});

test('snapshot validation keeps shapes and points, bounds text, rejects malformed data', () => {
  const ok = validateNavWarningsSnapshot(snapshot([raw()]));
  assert.equal(ok.records.length, 1);
  assert.equal(ok.withoutPosition, 2);
  assert.deepEqual(ok.records[0].shapes[0].points[0], [-69.85783, 13.17233]);
  assert.equal(ok.records[0].cableActivity, 'operations');
  const odd = validateNavWarningsSnapshot(
    snapshot([raw({ cableActivity: 'bogus', text: 'A <b>B</b>' })]),
  );
  assert.equal(odd.records[0].cableActivity, null);
  assert.ok(!odd.records[0].text.includes('<'));
  assert.throws(() => validateNavWarningsSnapshot({}), /Malformed/);
  assert.throws(
    () => validateNavWarningsSnapshot(snapshot([raw(), raw()])),
    /Malformed/,
  );
  assert.throws(
    () => validateNavWarningsSnapshot(snapshot([raw({ kind: 'nope' })])),
    /Malformed/,
  );
  assert.throws(
    () => validateNavWarningsSnapshot(snapshot([raw({ lat: 95 })])),
    /Malformed/,
  );
  assert.throws(
    () =>
      validateNavWarningsSnapshot(
        snapshot([raw({ shapes: [{ kind: 'line', points: [[1, 1]] }] })]),
      ),
    /Malformed/,
  );
  assert.throws(
    () =>
      validateNavWarningsSnapshot(
        snapshot([raw({ points: [{ lat: 1, lon: 500 }] })]),
      ),
    /Malformed/,
  );
});

test('title and excerpt read like the broadcast names', () => {
  const record = validateNavWarningsSnapshot(snapshot([raw()])).records[0];
  assert.equal(warningTitle(record), 'NAVAREA IV 127/24');
  assert.equal(
    warningTitle({ ...record, areaName: null, navArea: '12' }),
    'NAVAREA 12 127/24',
  );
  assert.ok(warningExcerpt(record, 40).length <= 40);
  assert.ok(warningExcerpt(record, 40).endsWith('…'));
});

test('card: key facts in the first four lines, cable work flagged as possible fault/repair', () => {
  const record = validateNavWarningsSnapshot(snapshot([raw()])).records[0];
  const card = navWarningCard(record);
  assert.equal(card.title, 'NAVAREA IV 127/24');
  assert.equal(card.lines.length, 4);
  assert.match(
    card.lines[0],
    /possible fault\/repair activity · CARIBBEAN SEA, ARUBA/,
  );
  assert.match(card.lines[1], /Issued 2024-01-31 01:00 UTC/);
  assert.match(card.lines[2], /CABLE OPERATIONS/);
  assert.match(card.lines[3], /Source: NGA MSI/);
  assert.equal(card.url, 'https://msi.nga.mil/NavWarnings');
  const plain = navWarningCard({
    ...record,
    cableActivity: null,
    kind: 'hazard',
  });
  assert.match(plain.lines[0], /^Hazard to navigation/);
});

test('only cable warnings get an ambient host label; priority puts them first', () => {
  const cable = validateNavWarningsSnapshot(snapshot([raw()])).records[0];
  const other = {
    ...cable,
    cableActivity: null,
    kind: 'other',
    issued: '2030-01-01T00:00:00.000Z',
  };
  assert.equal(navWarningOverlayEntry(cable).title, 'NAVAREA IV 127/24');
  assert.equal(navWarningOverlayEntry(cable).interactive, false);
  assert.equal(navWarningOverlayEntry(other), null);
  assert.ok(navWarningPriority(cable) > navWarningPriority(other));
  assert.equal(
    NAV_WARNING_LEGEND.length,
    Object.keys(NAV_WARNING_KINDS).length,
  );
  assert.equal(navWarningAnalystRecord(cable).timeMs, Date.parse(cable.issued));
});

test('cable summary carries positions and closes areas for matching', () => {
  const record = validateNavWarningsSnapshot(
    snapshot([
      raw({
        shapes: [
          {
            kind: 'area',
            points: [
              [1, 1],
              [2, 1],
              [2, 2],
            ],
          },
        ],
      }),
    ]),
  ).records[0];
  const summary = cableWarningSummary(record);
  assert.equal(summary.id, 'nga:2024:4:127');
  assert.equal(summary.activity, 'operations');
  assert.deepEqual(summary.points[0], [-69.85783, 13.17233]);
  assert.deepEqual(summary.lines[0].at(0), summary.lines[0].at(-1));
});

test('source asks the same-origin route', async () => {
  const seen = [];
  const source = createNavWarningsSource({
    fetchImpl: async (url) => {
      seen.push(url);
      return Response.json(snapshot([raw()]));
    },
  });
  assert.equal((await source.getSnapshot()).records.length, 1);
  assert.deepEqual(seen, ['/api/nav-warnings']);
});

test('layer publishes cable warnings to the channel and empties it when turned off', async () => {
  const channel = createCableHealthChannel();
  const host = {
    setVisible() {},
    setEntries() {},
    clearSource() {},
  };
  const layer = createNavWarningsLayer({
    overlayHost: host,
    cableHealth: channel,
    feed: {
      getSnapshot: async () =>
        validateNavWarningsSnapshot(
          snapshot([
            raw(),
            raw({
              id: 'nga:2024:4:128',
              number: 128,
              cableActivity: null,
              kind: 'hazard',
            }),
          ]),
        ),
    },
  });
  const entities = [];
  layer.init({
    dataSources: { add: (ds) => entities.push(ds), remove() {} },
    scene: {},
  });
  layer.enable();
  assert.equal(await layer.update(null), true);
  assert.deepEqual(
    channel.get().map((w) => w.id),
    ['nga:2024:4:127'],
  );
  layer.disable();
  assert.deepEqual(channel.get(), []);
  assert.equal(layer.id, 'nav-warnings');
  assert.match(layer.getStats().source, /NGA/);
  layer.destroy();
});
