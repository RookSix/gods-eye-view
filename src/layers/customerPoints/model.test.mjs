import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCustomerCsv, parseCsv, parseFirstContactDate, visibleCountAt } from './model.js';

test('parseCsv handles quoted multiline fields', () => {
  assert.deepEqual(parseCsv('a,b\n"one\nline",two\n'), [
    ['a', 'b'],
    ['one\nline', 'two'],
  ]);
});

test('normalizeCustomerCsv validates, deduplicates, and never invents coordinates', () => {
  const csv = [
    'contact_id,initials,latitude,longitude,date_of_first_contact,address',
    '1,AA,45.5,-122.6,2024-01-02,"private, ignored"',
    '1,AA,45.500000,-122.600000,2024-01-02,duplicate',
    '2,BB,0,0,2024-01-03,zero island',
    '3,CC,91,-122,2024-01-04,bad latitude',
    '4,DD,46,-123,not a date,bad date',
    '5,EE,46,-123,01/05/2024,ok',
  ].join('\n');
  const result = normalizeCustomerCsv(csv, { fileName: 'synthetic.csv' });
  assert.equal(result.stats.totalRows, 6);
  assert.equal(result.stats.plotted, 2);
  assert.equal(result.stats.duplicates, 1);
  assert.equal(result.stats.unresolved, 3);
  assert.equal(result.stats.zeroZero, 1);
  assert.equal(result.stats.outOfBounds, 1);
  assert.deepEqual(result.points.map((point) => [point.label, point.lat, point.lon, point.date]), [
    ['AA', 45.5, -122.6, '2024-01-02'],
    ['EE', 46, -123, '2024-01-05'],
  ]);
  assert.equal(result.source.dateColumn, 'date_of_first_contact');
});

test('parseFirstContactDate is deterministic UTC calendar parsing', () => {
  assert.deepEqual(parseFirstContactDate('2024-02-29T23:00:00-08:00'), {
    time: Date.UTC(2024, 1, 29),
    iso: '2024-02-29',
    label: '2024-02-29',
  });
  assert.equal(parseFirstContactDate('2024-02-30'), null);
});

test('visibleCountAt supports nonmonotonic timeline seek', () => {
  const points = [
    { time: Date.UTC(2024, 0, 1) },
    { time: Date.UTC(2024, 0, 3) },
    { time: Date.UTC(2024, 0, 5) },
  ];
  assert.equal(visibleCountAt(points, Date.UTC(2024, 0, 4)), 2);
  assert.equal(visibleCountAt(points, Date.UTC(2023, 11, 31)), 0);
  assert.equal(visibleCountAt(points, Date.UTC(2024, 0, 6)), 3);
  assert.equal(visibleCountAt(points, Date.UTC(2024, 0, 2)), 1);
});

test('different clients at the same location and date are not merged', () => {
  const result = normalizeCustomerCsv('contact_id,latitude,longitude,date_of_first_contact,first_contact_source\nA,47,-122,2024-01-01,lead\nB,47,-122,2024-01-01,created\n');
  assert.equal(result.stats.plotted, 2);
  assert.equal(result.stats.duplicates, 0);
  assert.equal(result.source.dateSources.lead, 1);
  assert.equal(result.source.dateSources.created, 1);
  assert.match(result.source.provenance, /not independently verified/);
  assert.ok(result.points.every(point => !('contact_id' in point)));
});

test('a missing coordinate is not parsed as zero latitude', () => {
  const result = normalizeCustomerCsv('latitude,longitude,date_of_first_contact\n,-122,2024-01-01\n47,,2024-01-01\n');
  assert.equal(result.stats.plotted, 0);
  assert.equal(result.stats.unresolved, 2);
});
