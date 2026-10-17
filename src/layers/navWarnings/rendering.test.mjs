import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NAV_WARNING_EXTRA_ENTITY_LIMIT,
  createNavWarningsRenderer,
} from './rendering.js';

const record = (id, over = {}) => ({
  id,
  kind: 'cable',
  cableActivity: 'operations',
  lat: 13.1,
  lon: -69.8,
  points: [
    { lat: 13.1, lon: -69.8 },
    { lat: 12.9, lon: -69.7 },
    { lat: 12.8, lon: -69.6 },
  ],
  shapes: [
    {
      kind: 'line',
      points: [
        [-69.8, 13.1],
        [-69.7, 12.9],
      ],
    },
    {
      kind: 'area',
      points: [
        [-69.8, 13.1],
        [-69.7, 12.9],
        [-69.6, 12.8],
      ],
    },
  ],
  ...over,
});

function fixture() {
  const sources = [];
  const viewer = {
    dataSources: {
      add: (source) => sources.push(source),
      remove: (source) => sources.splice(sources.indexOf(source), 1),
    },
  };
  const renderer = createNavWarningsRenderer({
    viewer,
    layerId: 'nav-warnings',
  });
  return { renderer, sources };
}

test('every part of a warning picks as that warning, never as another', () => {
  const { renderer, sources } = fixture();
  renderer.setRecords([record('nga:2024:4:1')]);
  const [source] = sources;
  const ids = source.entities.values.map((e) => e.id);
  // anchor + 2 extra points + line + polygon + loop + line = 7 parts, all owned.
  assert.ok(ids.length >= 6);
  for (const id of ids) {
    assert.equal(renderer.recordIdFromPick({ id: { id } }), 'nga:2024:4:1', id);
  }
  assert.equal(renderer.recordIdFromPick({ id: { id: 'other:thing' } }), null);
  assert.equal(renderer.recordIdFromPick(undefined), null);
  assert.equal(
    renderer.recordIdFromPick({
      id: { id: 'nav-warnings:__selection:nga:2024:4:1' },
    }),
    'nga:2024:4:1',
  );
});

test('selection draws one ring, moves with selection and clears', () => {
  const { renderer, sources } = fixture();
  renderer.setRecords([record('a'), record('b')], 'a');
  const count = () =>
    sources[0].entities.values.filter((e) => e.id.includes('__selection'))
      .length;
  assert.equal(count(), 1);
  renderer.setSelection('b');
  assert.equal(count(), 1);
  assert.match(
    sources[0].entities.values.find((e) => e.id.includes('__selection')).id,
    /__selection:b$/,
  );
  renderer.setSelection(null);
  assert.equal(count(), 0);
});

test('no entity carries a native label', () => {
  const { renderer, sources } = fixture();
  renderer.setRecords([record('a')]);
  assert.ok(sources[0].entities.values.every((e) => !e.label));
});

test('secondary entities are capped across all warnings', () => {
  const { renderer, sources } = fixture();
  const many = Array.from({ length: 3000 }, (_, i) => record(`w${i}`));
  renderer.setRecords(many);
  const total = sources[0].entities.values.length;
  assert.ok(
    total <= many.length + NAV_WARNING_EXTRA_ENTITY_LIMIT + 5,
    String(total),
  );
  // Every warning still has its anchor.
  assert.ok(sources[0].entities.getById('nav-warnings:w2999'));
});

test('visibility, clear and destroy release the data source', () => {
  const { renderer, sources } = fixture();
  assert.equal(renderer.getDiagnostics().visible, false);
  renderer.setRecords([record('a')]);
  renderer.setVisible(true);
  assert.equal(renderer.getDiagnostics().visible, true);
  renderer.clear();
  assert.equal(renderer.getDiagnostics().entities, 0);
  renderer.destroy();
  assert.equal(sources.length, 0);
  assert.equal(renderer.getDiagnostics().dataSources, 0);
  renderer.destroy();
});
