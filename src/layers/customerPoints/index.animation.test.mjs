import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CustomerPointLayer } from './index.js';

function installAnimationClock() {
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const previousPerformance = globalThis.performance;
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  globalThis.performance = { now: () => now };
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextId++;
    pending.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => pending.delete(id);
  return {
    step(ms) {
      now += ms;
      const callbacks = [...pending.entries()];
      pending.clear();
      for (const [, callback] of callbacks) callback(now);
    },
    pendingCount() { return pending.size; },
    restore() {
      if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = previousRaf;
      if (previousCancel === undefined) delete globalThis.cancelAnimationFrame;
      else globalThis.cancelAnimationFrame = previousCancel;
      globalThis.performance = previousPerformance;
    },
  };
}

function fakeViewer() {
  const values = [];
  return {
    values,
    dataSources: {
      add(source) { return source; },
      remove() {},
    },
    flyTo() { return Promise.resolve(); },
    isDestroyed() { return false; },
  };
}

const CSV = [
  'initials,latitude,longitude,date_of_first_contact',
  'AA,45,-122,2024-01-01',
  'BB,46,-123,2024-01-02',
  'CC,47,-124,2024-01-02',
].join('\n');

test('newly visible customer dots drop from transient height to exact final coordinates', () => {
  const clock = installAnimationClock();
  const renderReasons = [];
  try {
    const layer = new CustomerPointLayer(fakeViewer(), { requestRender: (reason) => renderReasons.push(reason) });
    layer.importText(CSV, 'synthetic.csv');
    const second = layer.entities[1];
    const third = layer.entities[2];
    const finalSecond = second.position.getValue();

    layer.seek(Date.UTC(2024, 0, 2));
    const startSecond = second.position.getValue();
    const startThird = third.position.getValue();
    assert.equal(second.show, true);
    assert.notDeepEqual(startSecond, finalSecond, 'animated dot starts above final position');
    assert(startThird.z > finalSecond.z, 'same-date dot also starts above the globe');
    assert.equal(clock.pendingCount(), 1, 'animation frame is scheduled while timeline is paused');

    clock.step(260);
    const midSecond = second.position.getValue();
    assert.notDeepEqual(midSecond, startSecond, 'dot progresses during animation frame');
    assert.notDeepEqual(midSecond, finalSecond, 'dot has not landed halfway through');

    clock.step(900);
    assert.deepEqual(second.position.getValue(), finalSecond, 'dot lands exactly at original lat/lon/height cartesian');
    assert.equal(second.point.pixelSize.getValue(), 8, 'pulse returns to base size');
    assert.equal(clock.pendingCount(), 0, 'no RAF sticks after all drops land');
    assert(renderReasons.includes('private-customer-points:drop'), 'drop animation asks render governor for frames');
  } finally {
    clock.restore();
  }
});

test('clear/reset/backward seek cancel active customer dot-drop frames', () => {
  const clock = installAnimationClock();
  try {
    const layer = new CustomerPointLayer(fakeViewer(), { requestRender: () => {} });
    layer.importText(CSV, 'synthetic.csv');
    layer.seek(Date.UTC(2024, 0, 2));
    assert.equal(clock.pendingCount(), 1);
    layer.seek(Date.UTC(2024, 0, 1));
    assert.equal(clock.pendingCount(), 0, 'backward seek cancels pending animation RAF');

    layer.seek(Date.UTC(2024, 0, 2));
    assert.equal(clock.pendingCount(), 1);
    layer.clear();
    assert.equal(clock.pendingCount(), 0, 'clear cancels pending animation RAF');
  } finally {
    clock.restore();
  }
});
