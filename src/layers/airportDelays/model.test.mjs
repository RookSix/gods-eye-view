import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVEL_COLORS,
  airportDelayAnalystRecord,
  airportDelayCard,
  airportDelayEntityOptions,
  airportDelayListItem,
  airportDelayOverlayEntry,
  airportDelayPriority,
  airportLabelText,
  formatMinutes,
  programLine,
  validateAirportDelaysSnapshot,
} from './model.js';
import { createAirportDelaysSource } from './source.js';

const program = (over = {}) => ({
  kind: 'gdp',
  reason: 'wind',
  limited: false,
  direction: null,
  avg: '1 hour and 20 minutes',
  avgMin: 80,
  min: null,
  minMin: null,
  max: '3 hours and 58 minutes',
  maxMin: 238,
  trend: null,
  start: null,
  reopen: null,
  end: null,
  ...over,
});
const airport = (over = {}) => ({
  id: 'LAS',
  code: 'LAS',
  name: 'Harry Reid International Airport',
  lat: 36.0834,
  lon: -115.1518,
  level: 'orange',
  rank: 3,
  topKind: 'gdp',
  programs: [program()],
  ...over,
});
const snapshot = (records) => ({
  schemaVersion: 1,
  stale: false,
  fetchedAt: 1,
  source: 'FAA NAS Status',
  attribution: 'x',
  updateTime: 'Sat Oct 17 04:54:13 2026 GMT',
  unmatched: 2,
  sources: { faa: { ok: true, count: records.length } },
  records,
});

test('minutes read as 1h20, 2h or 45m', () => {
  assert.equal(formatMinutes(80), '1h20');
  assert.equal(formatMinutes(120), '2h');
  assert.equal(formatMinutes(45), '45m');
  assert.equal(formatMinutes(null), null);
});

test('labels name the airport, program and delay', () => {
  assert.equal(airportLabelText(airport()), 'LAS GDP avg 1h20');
  assert.equal(
    airportLabelText(
      airport({
        topKind: 'delay',
        programs: [
          program({
            kind: 'delay',
            avg: null,
            avgMin: null,
            minMin: 76,
            maxMin: 90,
            direction: 'Departure',
          }),
          program({ kind: 'deicing' }),
        ],
      }),
    ),
    'LAS delay 1h16-1h30 +1',
  );
  assert.equal(
    airportLabelText(
      airport({
        level: 'red',
        topKind: 'closure',
        programs: [
          program({
            kind: 'closure',
            avg: null,
            avgMin: null,
            max: null,
            maxMin: null,
          }),
        ],
      }),
    ),
    'LAS closure',
  );
  assert.equal(
    airportLabelText(
      airport({
        programs: [
          program({
            kind: 'closure',
            limited: true,
            avgMin: null,
            maxMin: null,
          }),
        ],
      }),
    ),
    'LAS closure (limited)',
  );
});

test('snapshot validation accepts a good snapshot and rejects malformed rows', () => {
  const ok = validateAirportDelaysSnapshot(snapshot([airport()]));
  assert.equal(ok.records.length, 1);
  assert.equal(ok.unmatched, 2);
  assert.equal(ok.records[0].programs[0].avgMin, 80);
  assert.match(ok.attribution, /FAA/);
  assert.throws(() => validateAirportDelaysSnapshot({}), /Malformed/);
  assert.throws(
    () => validateAirportDelaysSnapshot(snapshot([airport(), airport()])),
    /Malformed/,
  );
  assert.throws(
    () =>
      validateAirportDelaysSnapshot(snapshot([airport({ level: 'purple' })])),
    /Malformed/,
  );
  assert.throws(
    () => validateAirportDelaysSnapshot(snapshot([airport({ programs: [] })])),
    /Malformed/,
  );
  assert.throws(
    () =>
      validateAirportDelaysSnapshot(
        snapshot([airport({ programs: [program({ kind: 'mystery' })] })]),
      ),
    /Malformed/,
  );
  assert.throws(
    () => validateAirportDelaysSnapshot(snapshot([airport({ lon: 400 })])),
    /Malformed/,
  );
  const dirty = validateAirportDelaysSnapshot(
    snapshot([airport({ programs: [program({ reason: '<b>x</b>' })] })]),
  );
  assert.equal(
    dirty.records[0].programs[0].reason,
    'b x /b',
    'markup characters dropped',
  );
});

test('card lists every program with reason, figures, trend and reopen time', () => {
  const record = airport({
    level: 'red',
    topKind: 'closure',
    programs: [
      program({
        kind: 'closure',
        reason: '!JAC AD AP CLSD',
        avg: null,
        max: null,
        reopen: 'Oct 17 at 12:00 UTC.',
        start: 'Oct 17 at 03:54 UTC.',
      }),
      program({
        kind: 'delay',
        direction: 'Departure',
        avg: null,
        min: '16 minutes',
        max: '30 minutes',
        trend: 'Increasing',
      }),
    ],
  });
  const card = airportDelayCard(record);
  assert.equal(card.title, 'LAS · Harry Reid International Airport');
  assert.equal(card.lines[0], '2 active programs');
  assert.match(
    card.lines[1],
    /Airport closure · !JAC AD AP CLSD · from Oct 17 at 03:54 UTC · reopens Oct 17 at 12:00 UTC/,
  );
  assert.match(
    card.lines[2],
    /Arrival\/departure delay \(Departure\) · .*min 16 minutes · max 30 minutes · increasing/,
  );
  assert.equal(card.url, 'https://nasstatus.faa.gov/');
  assert.equal(card.accent, LEVEL_COLORS.red);
  assert.match(
    programLine(program()),
    /Ground delay program · wind · avg 1 hour and 20 minutes · max 3 hours/,
  );
});

test('colour classes: red closure/stop, orange GDP, yellow delay, grey notice', () => {
  const colors = ['red', 'orange', 'yellow', 'grey'].map((level) =>
    airportDelayEntityOptions(
      airport({ level }),
    ).point.color.toCssColorString(),
  );
  assert.equal(new Set(colors).size, 4);
  const red = airportDelayEntityOptions(airport({ level: 'red' })).point;
  const grey = airportDelayEntityOptions(airport({ level: 'grey' })).point;
  assert.ok(red.pixelSize > grey.pixelSize);
});

test('ambient labels go through overlay entries, and grey notices get none', () => {
  const entry = airportDelayOverlayEntry(airport());
  assert.equal(entry.variant, 'label');
  assert.equal(entry.title, 'LAS GDP avg 1h20');
  assert.equal(entry.accent, LEVEL_COLORS.orange);
  assert.equal(entry.interactive, false);
  assert.equal(airportDelayOverlayEntry(airport({ level: 'grey' })), null);
});

test('priority puts closures and stops ahead of delays, longer delays first', () => {
  const stop = airport({
    rank: 4,
    level: 'red',
    topKind: 'ground-stop',
    programs: [program({ kind: 'ground-stop', avgMin: null, maxMin: null })],
  });
  const gdp = airport();
  const longer = airport({ programs: [program({ avgMin: 200 })] });
  assert.ok(airportDelayPriority(stop) > airportDelayPriority(longer));
  assert.ok(airportDelayPriority(longer) > airportDelayPriority(gdp));
  assert.equal(airportDelayListItem(gdp).lead, 'GDP');
  assert.deepEqual(airportDelayAnalystRecord(gdp).avgDelayMin, 80);
});

test('the source reads the same-origin route and validates its payload', async () => {
  const urls = [];
  const source = createAirportDelaysSource({
    fetchImpl: async (url, options) => {
      urls.push([url, options.redirect]);
      return Response.json(snapshot([airport()]));
    },
  });
  const result = await source.getSnapshot();
  assert.deepEqual(urls, [['/api/airport-delays', 'error']]);
  assert.equal(result.records[0].code, 'LAS');
  const bad = createAirportDelaysSource({
    fetchImpl: async () => Response.json({ nonsense: true }),
  });
  await assert.rejects(() => bad.getSnapshot(), /Malformed/);
});
