import * as Cesium from 'cesium';
import { GPS_JAMMING_LEVELS, cellRingDegrees } from './model.js';

/**
 * Translucent ground fills for H3 res-4 interference cells: one batched
 * GroundPrimitive per severity level, plus one clamped outline entity for the
 * selected cell. Cells are polygons from `h3-js`, never text.
 * @returns {object} Renderer for the feed layer.
 */
export function createGpsJammingRenderer({ viewer, cesium = Cesium, layerId }) {
  const outline = new cesium.CustomDataSource(`${layerId}-selection`);
  outline.show = false;
  viewer.dataSources.add(outline);
  let primitives = [];
  let rings = new Map();
  let visible = false;
  let destroyed = false;

  function removePrimitives() {
    for (const primitive of primitives) {
      viewer.scene.groundPrimitives.remove(primitive);
    }
    primitives = [];
  }

  function drawSelection(id) {
    outline.entities.removeAll();
    const ring = id === null ? null : rings.get(id);
    if (!ring) return;
    const closed = [...ring, ring[0], ring[1]];
    outline.entities.add({
      id: `${layerId}:__selection:${id}`,
      polyline: {
        positions: cesium.Cartesian3.fromDegreesArray(closed),
        width: 3,
        clampToGround: true,
        material: cesium.Color.WHITE.withAlpha(0.95),
      },
    });
  }

  return {
    setRecords(records, selectedId = null) {
      if (destroyed) return;
      removePrimitives();
      rings = new Map();
      const byLevel = new Map(
        Object.keys(GPS_JAMMING_LEVELS).map((level) => [level, []]),
      );
      for (const record of records) {
        const ring = cellRingDegrees(record.hex);
        rings.set(record.id, ring);
        byLevel.get(record.level).push(
          new cesium.GeometryInstance({
            id: record.id,
            geometry: new cesium.PolygonGeometry({
              polygonHierarchy: new cesium.PolygonHierarchy(
                cesium.Cartesian3.fromDegreesArray(ring),
              ),
            }),
            attributes: {
              color: cesium.ColorGeometryInstanceAttribute.fromColor(
                cesium.Color.fromCssColorString(
                  GPS_JAMMING_LEVELS[record.level].color,
                ).withAlpha(GPS_JAMMING_LEVELS[record.level].alpha),
              ),
            },
          }),
        );
      }
      for (const instances of byLevel.values()) {
        if (!instances.length) continue;
        const primitive = new cesium.GroundPrimitive({
          geometryInstances: instances,
          asynchronous: true,
        });
        primitive.show = visible;
        viewer.scene.groundPrimitives.add(primitive);
        primitives.push(primitive);
      }
      drawSelection(selectedId);
    },
    setSelection(id) {
      if (!destroyed) drawSelection(id);
    },
    /** Cell id behind a `scene.pick` result owned by this layer, else null. */
    recordIdFromPick(picked) {
      return typeof picked?.id === 'string' &&
        rings.has(picked.id) &&
        primitives.includes(picked.primitive)
        ? picked.id
        : null;
    },
    setVisible(next) {
      visible = next === true;
      for (const primitive of primitives) primitive.show = visible;
      outline.show = visible;
    },
    clear() {
      removePrimitives();
      rings = new Map();
      outline.entities.removeAll();
    },
    destroy() {
      if (destroyed) return;
      this.clear();
      destroyed = true;
      viewer.dataSources.remove(outline, true);
    },
    getDiagnostics() {
      return {
        primitives: primitives.length,
        cells: rings.size,
        dataSources: destroyed ? 0 : 1,
        visible,
      };
    },
  };
}
