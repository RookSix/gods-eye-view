import * as Cesium from 'cesium';
import { darkRegionRings } from './solar.js';

/** Night is anywhere the sun is below the horizon; the core is past civil twilight. */
export const DAY_NIGHT_TIERS = Object.freeze([
  { id: 'night', thresholdDeg: 0, color: '#06102e', alpha: 0.3 },
  { id: 'deep', thresholdDeg: -6, color: '#02061a', alpha: 0.3 },
]);

/**
 * Translucent ground polygons for the night hemisphere, in two stacked tiers
 * so the civil-twilight band (sun 0 to 6 degrees below the horizon) reads
 * lighter than full night. The scene's lighting, globe shading and every other
 * layer are untouched: this only adds ground primitives.
 * @returns {{setSun:Function, setVisible:Function, clear:Function, destroy:Function, getDiagnostics:Function}}
 */
export function createTerminatorRendering({ viewer, cesium = Cesium }) {
  const scene = viewer.scene;
  const current = new Map();
  let visible = false;
  let destroyed = false;
  /** Retire listeners mapped to the primitive each one will remove. */
  const pending = new Map();

  function build(tier, sun) {
    const instances = darkRegionRings(sun, tier.thresholdDeg).map(
      (ring) =>
        new cesium.GeometryInstance({
          geometry: new cesium.PolygonGeometry({
            polygonHierarchy: new cesium.PolygonHierarchy(
              cesium.Cartesian3.fromDegreesArray(ring),
            ),
          }),
          attributes: {
            color: cesium.ColorGeometryInstanceAttribute.fromColor(
              cesium.Color.fromCssColorString(tier.color).withAlpha(tier.alpha),
            ),
          },
        }),
    );
    if (!instances.length) return null;
    const primitive = new cesium.GroundPrimitive({
      geometryInstances: instances,
      asynchronous: true,
    });
    primitive.show = visible;
    return primitive;
  }

  function discard(primitive) {
    if (primitive && !primitive.isDestroyed?.())
      scene.groundPrimitives.remove(primitive);
  }

  /** Drop the old primitive only once its replacement can paint: no flicker. */
  function retireWhenReady(old, next) {
    if (!old) return;
    if (!next || next.ready || !scene.postRender?.addEventListener) {
      discard(old);
      return;
    }
    const check = () => {
      if (!destroyed && !next.ready && !next.isDestroyed?.()) return;
      scene.postRender.removeEventListener(check);
      pending.delete(check);
      discard(old);
    };
    pending.set(check, old);
    scene.postRender.addEventListener(check);
  }

  return {
    /** Replace both tiers for the given subsolar point. */
    setSun(sun) {
      if (destroyed) return;
      for (const tier of DAY_NIGHT_TIERS) {
        const old = current.get(tier.id) || null;
        const next = build(tier, sun);
        if (next) scene.groundPrimitives.add(next);
        current.set(tier.id, next);
        retireWhenReady(old, next);
      }
      scene.requestRender?.();
    },
    setVisible(next) {
      visible = next === true;
      for (const primitive of current.values())
        if (primitive) primitive.show = visible;
      scene.requestRender?.();
    },
    clear() {
      for (const [check, old] of pending) {
        scene.postRender?.removeEventListener(check);
        discard(old);
      }
      pending.clear();
      for (const primitive of current.values()) discard(primitive);
      current.clear();
      scene.requestRender?.();
    },
    destroy() {
      if (destroyed) return;
      this.clear();
      destroyed = true;
    },
    getDiagnostics() {
      return {
        primitives: [...current.values()].filter(Boolean).length,
        visible,
      };
    },
  };
}
