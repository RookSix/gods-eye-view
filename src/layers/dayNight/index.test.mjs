import test from 'node:test';
import assert from 'node:assert/strict';
import { createDayNightLayer } from './index.js';
import { DAY_NIGHT_TIERS, createTerminatorRendering } from './terminator.js';

const NOW = Date.UTC(2026, 9, 16, 22, 30);

function fakeScene() {
  const added = [];
  const removed = [];
  const listeners = new Set();
  const renders = { count: 0 };
  return {
    added,
    removed,
    listeners,
    renders,
    scene: {
      groundPrimitives: {
        add: (p) => added.push(p),
        remove: (p) => removed.push(p),
      },
      postRender: {
        addEventListener: (fn) => listeners.add(fn),
        removeEventListener: (fn) => listeners.delete(fn),
      },
      requestRender: () => renders.count++,
    },
  };
}

test('terminator draws one ground primitive per tier, hidden until shown', () => {
  const fake = fakeScene();
  const rendering = createTerminatorRendering({
    viewer: { scene: fake.scene },
  });
  rendering.setSun({ latitude: -10, longitude: 40 });
  assert.equal(fake.added.length, DAY_NIGHT_TIERS.length);
  assert.ok(fake.added.every((p) => p.show === false));
  rendering.setVisible(true);
  assert.ok(fake.added.every((p) => p.show === true));
  assert.ok(
    fake.renders.count >= 2,
    'requests a frame for request-render mode',
  );
  assert.equal(rendering.getDiagnostics().primitives, 2);
});

test('replacement keeps the old primitive until the new one can paint', () => {
  const fake = fakeScene();
  const rendering = createTerminatorRendering({
    viewer: { scene: fake.scene },
  });
  rendering.setVisible(true);
  rendering.setSun({ latitude: 10, longitude: 0 });
  const first = [...fake.added];
  rendering.setSun({ latitude: 11, longitude: 15 });
  assert.equal(fake.added.length, 4);
  assert.deepEqual(fake.removed, [], 'old primitives still painting');
  assert.equal(fake.listeners.size, 2);
  // The new primitives become ready on a later frame.
  for (const next of fake.added.slice(2))
    Object.defineProperty(next, 'ready', { value: true });
  for (const check of [...fake.listeners]) check();
  assert.deepEqual(new Set(fake.removed), new Set(first));
  assert.equal(fake.listeners.size, 0);
});

test('clear and destroy release every primitive and listener, including pending swaps', () => {
  const fake = fakeScene();
  const rendering = createTerminatorRendering({
    viewer: { scene: fake.scene },
  });
  rendering.setSun({ latitude: 10, longitude: 0 });
  rendering.setSun({ latitude: 12, longitude: 30 });
  rendering.destroy();
  assert.equal(new Set(fake.removed).size, 4, 'old and current both removed');
  assert.equal(fake.listeners.size, 0);
  rendering.setSun({ latitude: 0, longitude: 0 });
  assert.equal(
    fake.added.length,
    4,
    'a destroyed rendering ignores later suns',
  );
});

function layerHarness() {
  let at = NOW;
  const calls = [];
  const rendering = {
    setSun: (sun) => calls.push(['sun', sun]),
    setVisible: (v) => calls.push(['visible', v]),
    clear: () => calls.push(['clear']),
    destroy: () => calls.push(['destroy']),
    getDiagnostics: () => ({ primitives: 2 }),
  };
  const layer = createDayNightLayer({
    now: () => at,
    createRendering: () => rendering,
  });
  return { layer, calls, advance: (ms) => (at += ms) };
}

test('layer is a clock-driven overlay: no source, off until enabled, 60 s cadence', async () => {
  const { layer, calls, advance } = layerHarness();
  assert.equal(layer.id, 'day-night');
  assert.equal(layer.updateInterval, 60_000);
  layer.init({});
  assert.deepEqual(calls, [], 'nothing drawn before enable');
  assert.equal(await layer.update(), false, 'disabled layer does not compute');
  layer.enable();
  assert.deepEqual(
    calls.map(([name]) => name),
    ['visible', 'sun'],
  );
  assert.equal(layer.getStats().count, 1);
  const first = layer.getStats().subsolar;
  advance(3_600_000);
  assert.equal(await layer.update(), true);
  const second = layer.getStats().subsolar;
  assert.ok(
    second.longitude < first.longitude - 14,
    'terminator moved with time',
  );
  assert.equal(layer.getDiagnostics().timerActive, false);
});

test('row readout reports the subsolar point and the UTC refresh time', () => {
  const { layer } = layerHarness();
  layer.init({});
  assert.equal(layer.getRowControls().info, '');
  layer.enable();
  const controls = layer.getRowControls();
  assert.match(controls.info, /Sun overhead at \d+\.\d°[NS] \d+\.\d°[EW]/);
  assert.match(controls.info, /Updated 22:30:00 UTC/);
  assert.equal(controls.legend.length, 2);
});

test('disable clears the drawing; destroy is final and double-init is rejected', async () => {
  const { layer, calls } = layerHarness();
  layer.init({});
  assert.throws(() => layer.init({}), /already initialized/);
  layer.enable();
  layer.disable();
  assert.deepEqual(calls.slice(-2), [['visible', false], ['clear']]);
  assert.equal(layer.getStats().count, 0);
  assert.equal(await layer.update(), false);
  layer.destroy();
  layer.destroy();
  assert.equal(calls.filter(([name]) => name === 'destroy').length, 1);
  layer.enable();
  assert.equal(
    calls.filter(([name]) => name === 'sun').length,
    1,
    'destroyed layer stays off',
  );
});
