import * as Cesium from 'cesium';

/**
 * Entity-backed renderer for point-like feed records. Every record becomes one
 * Cesium entity in a layer-owned data source; one extra entity rings the
 * selected record. Text never rides on entities: labels belong to the
 * world-overlay host.
 *
 * @param {object} options
 * @param {(record:object, cesium:object)=>object} options.entityOptions
 *   Graphics for one record (`point`, `billboard`, ...), without `id`/`position`.
 * @param {(record:object, cesium:object)=>object} [options.position]
 *   Cartesian anchor; defaults to the record's lon/lat on the ellipsoid.
 * @returns {Function} Renderer factory for the feed layer.
 */
export function createEntityRendererFactory({ entityOptions, position }) {
  return function createRenderer({ viewer, cesium = Cesium, layerId }) {
    const prefix = `${layerId}:`;
    const anchor =
      position ||
      ((record) => cesium.Cartesian3.fromDegrees(record.lon, record.lat));
    const dataSource = new cesium.CustomDataSource(layerId);
    dataSource.show = false;
    viewer.dataSources.add(dataSource);
    const anchors = new Map();
    let selectionEntity = null;
    let destroyed = false;

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

    return {
      setRecords(records, selectedId = null) {
        if (destroyed) return;
        const next = [];
        anchors.clear();
        for (const record of records) {
          const at = anchor(record, cesium);
          anchors.set(record.id, at);
          next.push(
            new cesium.Entity({
              id: `${prefix}${record.id}`,
              position: at,
              ...entityOptions(record, cesium),
            }),
          );
        }
        selectionEntity = null;
        dataSource.entities.removeAll();
        for (const entity of next) dataSource.entities.add(entity);
        drawSelection(selectedId);
      },
      setSelection(id) {
        if (!destroyed) drawSelection(id);
      },
      /** Record id behind a `scene.pick` result owned by this layer, else null. */
      recordIdFromPick(picked) {
        const id = picked?.id?.id;
        if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
        const rest = id.slice(prefix.length);
        return rest.startsWith('__selection:')
          ? rest.slice('__selection:'.length)
          : rest;
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
  };
}
