import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell } from 'h3-js';
import { createFeedSource, httpsUrl, boundedText } from './source.js';
import { createNaturalEventsSource } from '../naturalEvents/source.js';
import { createAircraftEmergenciesSource } from '../aircraftEmergencies/source.js';
import { createGpsJammingSource } from '../gpsJamming/source.js';
import { cellRingDegrees } from '../gpsJamming/model.js';

test('feed source: same-origin fetch, no-store, redirects refused, validated result', async () => {
  const seen = [];
  const source = createFeedSource({
    url: '/api/x',
    label: 'X',
    validate: (payload) => ({ ok: payload.value }),
    fetchImpl: async (url, options) => {
      seen.push([url, options]);
      return Response.json({ value: 7 });
    },
  });
  assert.deepEqual(await source.getSnapshot(), { ok: 7 });
  assert.equal(seen[0][0], '/api/x');
  assert.equal(seen[0][1].cache, 'no-store');
  assert.equal(seen[0][1].redirect, 'error');
});

test('feed source: HTTP errors, malformed JSON and oversize bodies reject', async () => {
  const make = (response, limit) =>
    createFeedSource({
      url: '/api/x',
      label: 'X',
      validate: (payload) => payload,
      limit,
      fetchImpl: async () => response(),
    });
  await assert.rejects(
    make(() => new Response('nope', { status: 502 })).getSnapshot(),
    /X HTTP 502/,
  );
  await assert.rejects(
    make(() => new Response('{')).getSnapshot(),
    SyntaxError,
  );
  await assert.rejects(
    make(
      () => new Response(JSON.stringify({ pad: 'x'.repeat(100) })),
      20,
    ).getSnapshot(),
    /too large/,
  );
});

test('feed source: caller abort and the deadline both cancel the request', async () => {
  let aborted = null;
  const hang = (url, { signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => {
        aborted = signal.reason;
        reject(signal.reason);
      }),
    );
  const slow = createFeedSource({
    url: '/x',
    label: 'Slow',
    validate: (p) => p,
    timeoutMs: 10,
    fetchImpl: hang,
  });
  await assert.rejects(slow.getSnapshot(), /Slow request timed out/);
  const controller = new AbortController();
  const waiting = createFeedSource({
    url: '/x',
    label: 'W',
    validate: (p) => p,
    fetchImpl: hang,
  }).getSnapshot({ signal: controller.signal });
  controller.abort(new Error('caller'));
  await assert.rejects(waiting, /caller/);
  assert.equal(aborted.message, 'caller');
  const gone = new AbortController();
  gone.abort(new Error('already'));
  await assert.rejects(
    createFeedSource({
      url: '/x',
      label: 'W',
      validate: (p) => p,
      fetchImpl: hang,
    }).getSnapshot({ signal: gone.signal }),
    /already/,
  );
});

test('each layer source targets its own fixed route', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return Response.json({});
  };
  for (const create of [
    createNaturalEventsSource,
    createAircraftEmergenciesSource,
    createGpsJammingSource,
  ])
    await assert.rejects(create({ fetchImpl }).getSnapshot(), /Malformed/);
  assert.deepEqual(urls, [
    '/api/natural-events',
    '/api/aircraft-emergencies',
    '/api/gps-jamming',
  ]);
});

test('text and link helpers', () => {
  assert.equal(
    httpsUrl('https://example.gov/a?b=1'),
    'https://example.gov/a?b=1',
  );
  for (const bad of [
    'http://x.test',
    'javascript:alert(1)',
    'https://u:p@x.test',
    42,
    'https://' + 'a'.repeat(500),
  ])
    assert.equal(httpsUrl(bad), null);
  assert.equal(boundedText('  a\u0000b <c>  ', 10), 'a b  c');
  assert.equal(boundedText('', 5), null);
  assert.equal(boundedText('abcdefgh', 3), 'abc');
});

test('H3 cells become closed-form hexagon rings, continuous across the antimeridian', () => {
  const ordinary = cellRingDegrees('8401261ffffffff');
  assert.ok(
    ordinary.length === 12 || ordinary.length === 10,
    'hexagon or pentagon',
  );
  for (const [lat, lon] of [
    [10, 179.99],
    [10, -179.99],
    [-30, 180],
  ]) {
    const ring = cellRingDegrees(latLngToCell(lat, lon, 4));
    for (let i = 2; i < ring.length; i += 2)
      assert.ok(
        Math.abs(ring[i] - ring[i - 2]) < 20,
        'no 360-degree jump between vertices',
      );
  }
});
