import * as Cesium from 'cesium';
import { SEVERITY_STYLES, severityRank } from './records.js';

/** Ceiling on polygon and outline entities across all alerts. */
export const WEATHER_ALERT_ENTITY_LIMIT = 3_000;
const SUFFIX = '~';

/**
 * Entity renderer for severe weather alerts: each alert draws its outline
 * rings as translucent ground-clamped polygons with a coloured outline, least
 * severe first so serious alerts sit on top. Every part picks as its alert. The
 * selected alert gets a ring at its anchor. Text never rides on entities:
 * labels belong to the overlay host.
 * @returns {object} Renderer for the feed layer.
 */
export function createWeatherAlertsRenderer({
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
      SEVERITY_STYLES[record.severity].color,
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

  function ringEntities(record) {
    const out = [];
    record.rings.forEach((ring, index) => {
      const flat = ring.flat();
      const base = `${prefix}${record.id}${SUFFIX}r${index}`;
      const severe = severityRank(record.severity) <= 1;
      out.push(
        new cesium.Entity({
          id: `${base}a`,
          polygon: {
            hierarchy: new cesium.PolygonHierarchy(
              cesium.Cartesian3.fromDegreesArray(flat),
            ),
            material: color(record, severe ? 0.3 : 0.2),
            classificationType: cesium.ClassificationType.TERRAIN,
          },
        }),
        new cesium.Entity({
          id: `${base}l`,
          polyline: {
            positions: cesium.Cartesian3.fromDegreesArray([
              ...flat,
              flat[0],
              flat[1],
            ]),
            width: severe ? 2 : 1.5,
            clampToGround: true,
            material: color(record, 0.9),
          },
        }),
      );
    });
    return out;
  }

  return {
    setRecords(records, selectedId = null) {
      if (destroyed) return;
      anchors.clear();
      selectionEntity = null;
      dataSource.entities.removeAll();
      // Least severe and largest first, so serious and small alerts sit on top.
      const ordered = [...records].sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) ||
          b.areaDeg2 - a.areaDeg2,
      );
      let count = 0;
      for (const record of ordered) {
        anchors.set(
          record.id,
          cesium.Cartesian3.fromDegrees(record.lon, record.lat),
        );
        if (count + record.rings.length * 2 > WEATHER_ALERT_ENTITY_LIMIT)
          continue;
        for (const entity of ringEntities(record)) {
          dataSource.entities.add(entity);
          count++;
        }
      }
      drawSelection(selectedId);
    },
    setSelection(id) {
      if (!destroyed) drawSelection(id);
    },
    /** Alert id behind a `scene.pick` result owned by this layer, else null. */
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
