import * as Cesium from 'cesium';
import { NAV_WARNING_KINDS } from './records.js';

/** Ceiling on secondary entities (extra points and shapes) across all warnings. */
export const NAV_WARNING_EXTRA_ENTITY_LIMIT = 4_000;
const SUFFIX = '~';

/**
 * Entity renderer for navigational warnings. Every warning draws one anchor
 * point; its other parsed positions draw as small points and its routes and
 * areas as ground-clamped lines and translucent polygons. All parts pick as
 * the warning. Text never rides on entities: labels belong to the overlay host.
 * @returns {object} Renderer for the feed layer.
 */
export function createNavWarningsRenderer({
  viewer,
  cesium = Cesium,
  layerId,
}) {
  const prefix = `${layerId}:`;
  const dataSource = new cesium.CustomDataSource(layerId);
  dataSource.show = false;
  viewer.dataSources.add(dataSource);
  const anchors = new Map();
  let selectionEntity = null;
  let destroyed = false;

  const color = (record, alpha) =>
    cesium.Color.fromCssColorString(
      NAV_WARNING_KINDS[record.kind].color,
    ).withAlpha(alpha);

  function drawSelection(id) {
    if (selectionEntity) {
      dataSource.entities.remove(selectionEntity);
      selectionEntity = null;
    }
    const at = id === null ? null : anchors.get(id);
    if (!at) return;
    selectionEntity = dataSource.entities.add(
      new cesium.Entity({
        id: `${prefix}__selection:${id}`,
        position: at,
        point: {
          pixelSize: 26,
          color: cesium.Color.TRANSPARENT,
          outlineColor: cesium.Color.WHITE.withAlpha(0.95),
          outlineWidth: 2,
          disableDepthTestDistance: 0,
        },
      }),
    );
  }

  function addShapes(record, extra) {
    record.shapes.forEach((shape, index) => {
      if (extra.count >= NAV_WARNING_EXTRA_ENTITY_LIMIT) return;
      const flat = shape.points.flat();
      const base = `${prefix}${record.id}${SUFFIX}s${index}`;
      if (shape.kind === 'area' && shape.points.length >= 3) {
        extra.list.push(
          new cesium.Entity({
            id: `${base}a`,
            polygon: {
              hierarchy: new cesium.PolygonHierarchy(
                cesium.Cartesian3.fromDegreesArray(flat),
              ),
              material: color(record, 0.14),
              classificationType: cesium.ClassificationType.TERRAIN,
            },
          }),
        );
        extra.count++;
      }
      const loop = shape.kind === 'area' ? [...flat, flat[0], flat[1]] : flat;
      extra.list.push(
        new cesium.Entity({
          id: `${base}l`,
          polyline: {
            positions: cesium.Cartesian3.fromDegreesArray(loop),
            width: record.cableActivity ? 3 : 2,
            clampToGround: true,
            material: color(record, 0.9),
          },
        }),
      );
      extra.count++;
    });
  }

  return {
    setRecords(records, selectedId = null) {
      if (destroyed) return;
      anchors.clear();
      const primary = [];
      const extra = { list: [], count: 0 };
      for (const record of records) {
        const at = cesium.Cartesian3.fromDegrees(record.lon, record.lat);
        anchors.set(record.id, at);
        primary.push(
          new cesium.Entity({
            id: `${prefix}${record.id}`,
            position: at,
            point: {
              pixelSize: record.cableActivity ? 11 : 9,
              color: color(record, 0.95),
              outlineColor: cesium.Color.BLACK.withAlpha(0.7),
              outlineWidth: 1.5,
            },
          }),
        );
        addShapes(record, extra);
        // Other positions: skip the anchor itself and rig-list overload.
        record.points.forEach((point, index) => {
          if (extra.count >= NAV_WARNING_EXTRA_ENTITY_LIMIT) return;
          if (point.lon === record.lon && point.lat === record.lat) return;
          extra.list.push(
            new cesium.Entity({
              id: `${prefix}${record.id}${SUFFIX}p${index}`,
              position: cesium.Cartesian3.fromDegrees(point.lon, point.lat),
              point: {
                pixelSize: 5,
                color: color(record, 0.85),
                outlineColor: cesium.Color.BLACK.withAlpha(0.5),
                outlineWidth: 1,
              },
            }),
          );
          extra.count++;
        });
      }
      selectionEntity = null;
      dataSource.entities.removeAll();
      for (const entity of extra.list) dataSource.entities.add(entity);
      for (const entity of primary) dataSource.entities.add(entity);
      drawSelection(selectedId);
    },
    setSelection(id) {
      if (!destroyed) drawSelection(id);
    },
    /** Warning id behind a `scene.pick` result owned by this layer, else null. */
    recordIdFromPick(picked) {
      const id = picked?.id?.id;
      if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
      const rest = id.slice(prefix.length);
      if (rest.startsWith('__selection:'))
        return rest.slice('__selection:'.length);
      const cut = rest.indexOf(SUFFIX);
      return cut < 0 ? rest : rest.slice(0, cut);
    },
    setVisible(visible) {
      dataSource.show = visible === true;
    },
    clear() {
      anchors.clear();
      selectionEntity = null;
      dataSource.entities.removeAll();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      anchors.clear();
      selectionEntity = null;
      viewer.dataSources.remove(dataSource, true);
    },
    getDiagnostics() {
      return {
        entities: dataSource.entities.values.length,
        dataSources: destroyed ? 0 : 1,
        visible: dataSource.show,
      };
    },
  };
}
