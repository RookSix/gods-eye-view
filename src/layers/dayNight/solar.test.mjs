import test from 'node:test';
import assert from 'node:assert/strict';
import {
  darkLatitudeRuns,
  darkRegionRings,
  solarAltitude,
  subsolarPoint,
} from './solar.js';

const utc = (...parts) => Date.UTC(...parts);
const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not within ${tolerance} of ${expected}`,
  );

test('equinoxes put the sun over the equator', () => {
  // March equinox 2026: 14:46 UTC. September equinox 2026: 00:05 UTC on the 23rd.
  near(subsolarPoint(utc(2026, 2, 20, 14, 46)).latitude, 0, 1, 'March');
  near(subsolarPoint(utc(2026, 8, 23, 0, 5)).latitude, 0, 1, 'September');
});

test('solstices put the sun over the tropics', () => {
  near(subsolarPoint(utc(2026, 5, 21, 8, 24)).latitude, 23.44, 1, 'June');
  near(
    subsolarPoint(utc(2026, 11, 21, 15, 50)).latitude,
    -23.44,
    1,
    'December',
  );
});

test('declination follows the year: positive in northern summer, negative in winter', () => {
  assert.ok(subsolarPoint(utc(2026, 6, 15, 12)).latitude > 20);
  assert.ok(subsolarPoint(utc(2026, 0, 15, 12)).latitude < -15);
});

test('the equation of time shifts noon longitude by its known extremes', () => {
  // 11 Feb: sun 14.2 min slow, so it has not reached Greenwich at 12:00 UTC.
  near(subsolarPoint(utc(2026, 1, 11, 12)).longitude, 3.55, 1, 'February');
  // 3 Nov: sun 16.4 min fast.
  near(subsolarPoint(utc(2026, 10, 3, 12)).longitude, -4.1, 1, 'November');
});

test('longitude runs westward at 15 degrees per hour', () => {
  const noon = subsolarPoint(utc(2026, 3, 1, 12)).longitude;
  const one = subsolarPoint(utc(2026, 3, 1, 13)).longitude;
  near(one - noon, -15, 0.2, 'one hour');
  const midnight = subsolarPoint(utc(2026, 3, 1, 0)).longitude;
  near(Math.abs(midnight - noon), 180, 1, 'twelve hours');
});

test('accepts Date or epoch ms, wraps longitude and rejects non-finite time', () => {
  const stamp = utc(2026, 9, 16, 22, 30);
  assert.deepEqual(subsolarPoint(new Date(stamp)), subsolarPoint(stamp));
  for (let hour = 0; hour < 24; hour++) {
    const { longitude } = subsolarPoint(utc(2026, 9, 16, hour));
    assert.ok(longitude >= -180 && longitude < 180);
  }
  assert.throws(() => subsolarPoint(Number.NaN), RangeError);
  assert.throws(() => subsolarPoint(new Date('nope')), RangeError);
});

test('solar altitude is 90 under the sun, -90 opposite it and 0 on the horizon circle', () => {
  const sun = { latitude: 20, longitude: 40 };
  near(solarAltitude(sun, 20, 40), 90, 1e-9, 'zenith');
  near(solarAltitude(sun, -20, -140), -90, 1e-9, 'antipode');
  near(solarAltitude(sun, 20 - 90, 40), 0, 1e-9, 'a quarter turn south');
});

test('dark runs: equinox meridians and a winter pole', () => {
  const equinox = { latitude: 0, longitude: 0 };
  assert.deepEqual(darkLatitudeRuns(equinox, 0, 0), [], 'sun meridian is lit');
  assert.deepEqual(darkLatitudeRuns(equinox, 180, 0), [[-90, 90]]);
  const winter = { latitude: -23.44, longitude: 0 };
  const [run] = darkLatitudeRuns(winter, 0, 0);
  assert.equal(darkLatitudeRuns(winter, 0, 0).length, 1);
  near(run[0], 66.56, 0.6, 'polar night starts');
  assert.equal(run[1], 90);
});

test('night covers half the globe and the twilight limit shrinks it as a spherical cap', () => {
  const sun = subsolarPoint(utc(2026, 9, 16, 22, 30));
  const fraction = (threshold) => {
    let total = 0;
    let count = 0;
    for (let lon = -179; lon < 180; lon += 2) {
      for (const [south, north] of darkLatitudeRuns(sun, lon, threshold))
        total +=
          (Math.sin((north * Math.PI) / 180) -
            Math.sin((south * Math.PI) / 180)) /
          2;
      count++;
    }
    return total / count;
  };
  near(fraction(0), 0.5, 0.01, 'night hemisphere');
  // Sun more than 6 degrees below the horizon: a cap of radius 84 degrees.
  near(
    fraction(-6),
    (1 - Math.cos((84 * Math.PI) / 180)) / 2,
    0.01,
    'deep night',
  );
});

test('region rings are valid trapezoids inside the lon/lat bounds', () => {
  const rings = darkRegionRings({ latitude: 0, longitude: 0 }, 0);
  assert.ok(rings.length >= 88 && rings.length <= 92, `${rings.length} rings`);
  for (const ring of rings) {
    assert.equal(ring.length, 8);
    for (let i = 0; i < 8; i += 2) {
      assert.ok(ring[i] >= -180 && ring[i] <= 180);
      assert.ok(ring[i + 1] >= -90 && ring[i + 1] <= 90);
    }
  }
  assert.deepEqual(
    darkRegionRings({ latitude: 0, longitude: 0 }, -95),
    [],
    'no point is 95 degrees below the horizon',
  );
});
