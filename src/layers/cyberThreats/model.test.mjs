import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CYBER_LEGEND,
  CYBER_THREATS_CAVEAT,
  cyberThreatAnalystRecord,
  cyberThreatCard,
  cyberThreatEntityOptions,
  cyberThreatListItem,
  cyberThreatPriority,
  familyColor,
  validateCyberThreatsSnapshot,
} from './model.js';
import { createCyberThreatsSource } from './source.js';

const indicator = (id, over = {}) => ({
  id,
  ip: '50.16.16.211',
  source: 'feodo',
  sources: ['feodo', 'c2intel'],
  category: 'botnet-c2',
  family: 'QakBot',
  port: 443,
  status: 'online',
  hostname: 'ec2-50-16-16-211.compute-1.amazonaws.com',
  asn: 'AS14618',
  asName: 'AMAZON-AES',
  org: 'AS14618 Amazon.com, Inc.',
  country: 'US',
  city: 'Ashburn',
  firstSeen: '2025-12-30 13:56:31',
  lastSeen: '2026-03-12',
  url: 'https://feodotracker.abuse.ch/browse/',
  lat: 39.04,
  lon: -77.49,
  precision: 'ip',
  ...over,
});
const snapshot = (records) => ({
  schemaVersion: 1,
  stale: false,
  fetchedAt: 1,
  source: 'Feodo Tracker + C2IntelFeeds',
  attribution: 'x',
  sources: {
    feodo: { ok: true, count: 1 },
    urlhaus: { ok: true, count: 0, skipped: 'no key' },
  },
  geo: { ipLocated: 1, countryCentroid: 0, dropped: 3, lookupsCapped: true },
  records,
});

test('snapshot validation keeps good indicators and rejects malformed ones', () => {
  const ok = validateCyberThreatsSnapshot(snapshot([indicator('ip:1')]));
  assert.equal(ok.records.length, 1);
  assert.equal(ok.geo.dropped, 3);
  assert.equal(ok.geo.lookupsCapped, true);
  assert.equal(ok.sources.urlhaus.skipped, 'no key');
  assert.throws(() => validateCyberThreatsSnapshot({}), /Malformed/);
  for (const bad of [
    indicator('ip:1', { source: 'shodan' }),
    indicator('ip:1', { category: 'mystery' }),
    indicator('ip:1', { precision: 'street' }),
    indicator('ip:1', { lon: -300 }),
    indicator('ip:1', { ip: '' }),
  ])
    assert.throws(
      () => validateCyberThreatsSnapshot(snapshot([bad])),
      /Malformed/,
    );
  assert.throws(
    () =>
      validateCyberThreatsSnapshot(
        snapshot([indicator('ip:1'), indicator('ip:1')]),
      ),
    /Malformed/,
  );
  const sloppy = validateCyberThreatsSnapshot(
    snapshot([
      indicator('ip:1', {
        port: 99999,
        status: 'zombie',
        url: 'http://x.example/',
        sources: ['feodo', 'nope'],
      }),
    ]),
  );
  assert.equal(sloppy.records[0].port, null);
  assert.equal(sloppy.records[0].status, null);
  assert.equal(sloppy.records[0].url, null);
  assert.deepEqual(sloppy.records[0].sources, ['feodo']);
});

test('colour: known families fixed, others stable by name', () => {
  assert.equal(familyColor('Cobalt Strike'), familyColor('cobalt strike'));
  assert.notEqual(familyColor('Cobalt Strike'), familyColor('Emotet'));
  assert.equal(familyColor('Zloader'), familyColor('Zloader'));
  assert.match(familyColor('Whatever'), /^#[0-9a-f]{6}$/i);
  assert.ok(CYBER_LEGEND.some((entry) => entry.label === 'Cobalt Strike'));
});

test('dots are family coloured, online ones ringed in white and brighter', () => {
  const online = cyberThreatEntityOptions(indicator('a')).point;
  const offline = cyberThreatEntityOptions(
    indicator('b', { status: 'offline' }),
  ).point;
  assert.equal(
    online.color.toCssColorString().slice(0, 12),
    offline.color.toCssColorString().slice(0, 12),
    'same family, same hue',
  );
  assert.ok(online.color.alpha > offline.color.alpha);
  assert.ok(online.outlineWidth > offline.outlineWidth);
});

test('card carries ip, port, family, network, dates, source and the caveat', () => {
  const card = cyberThreatCard(indicator('a'));
  assert.equal(card.title, 'QakBot · 50.16.16.211');
  assert.equal(
    card.lines[0],
    'Botnet C2 · Feodo Tracker + C2IntelFeeds · online',
  );
  assert.equal(card.lines[1], '50.16.16.211:443 · AS14618 AMAZON-AES');
  assert.equal(
    card.lines[2],
    'Ashburn, US · first seen 2025-12-30 · last seen 2026-03-12',
  );
  assert.equal(card.lines[3], CYBER_THREATS_CAVEAT);
  assert.match(CYBER_THREATS_CAVEAT, /hosting location, not the actor/);
  assert.match(card.lines[4], /IP geolocation/);
  assert.match(card.lines[5], /Hostname: ec2-50/);
  assert.equal(card.url, 'https://feodotracker.abuse.ch/browse/');
  const approx = cyberThreatCard(
    indicator('b', {
      precision: 'country',
      city: null,
      status: null,
      port: null,
      hostname: null,
      asn: null,
      asName: null,
      org: null,
    }),
  );
  assert.match(approx.lines[4], /country centroid/);
  assert.equal(approx.lines[1], '50.16.16.211');
});

test('priority and list items put online indicators first', () => {
  assert.ok(
    cyberThreatPriority(indicator('a')) >
      cyberThreatPriority(
        indicator('b', { status: 'offline', lastSeen: '2026-10-01' }),
      ),
  );
  assert.equal(cyberThreatListItem(indicator('a')).lead, 'ONLINE');
  assert.equal(
    cyberThreatListItem(indicator('a', { status: 'offline' })).lead,
    'C2',
  );
  const record = cyberThreatAnalystRecord(indicator('a'));
  assert.equal(record.family, 'QakBot');
  assert.equal(typeof record.timeMs, 'number');
});

test('the source reads the same-origin route and validates its payload', async () => {
  const urls = [];
  const source = createCyberThreatsSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json(snapshot([indicator('ip:1')]));
    },
  });
  assert.equal((await source.getSnapshot()).records[0].ip, '50.16.16.211');
  assert.deepEqual(urls, ['/api/cyber-threats']);
  const bad = createCyberThreatsSource({
    fetchImpl: async () => Response.json({}),
  });
  await assert.rejects(() => bad.getSnapshot(), /Malformed/);
});
