import { createTerminatorRendering } from './terminator.js';
import { subsolarPoint } from './solar.js';

export { subsolarPoint, solarAltitude } from './solar.js';
export { createTerminatorRendering } from './terminator.js';

export const DAY_NIGHT_LAYER_ID = 'day-night';
const REFRESH_MS = 60_000;

const degrees = (value, positive, negative) =>
  `${Math.abs(value).toFixed(1)}°${value >= 0 ? positive : negative}`;

/**
 * Night hemisphere and civil-twilight band from the clock alone; no feed, no
 * server route. The layer manager's own update cadence (60 s) moves the
 * terminator, so the layer owns no timer.
 */
export function createDayNightLayer({
  now = () => Date.now(),
  createRendering = createTerminatorRendering,
  cesium,
} = {}) {
  let viewer = null,
    rendering = null,
    enabled = false,
    destroyed = false,
    sun = null,
    lastUpdate = null,
    listener = null;

  function refresh() {
    if (!enabled || destroyed || !rendering) return false;
    const stamp = now();
    sun = subsolarPoint(stamp);
    rendering.setSun(sun);
    lastUpdate = stamp;
    listener?.();
    return true;
  }

  const layer = {
    id: DAY_NIGHT_LAYER_ID,
    name: 'Day / night terminator',
    icon: '◐',
    source: 'Computed from UTC · no feed',
    updateInterval: REFRESH_MS,
    init(nextViewer) {
      if (viewer) throw new Error('Day/night layer is already initialized');
      viewer = nextViewer;
      rendering = createRendering({ viewer, ...(cesium ? { cesium } : {}) });
    },
    enable() {
      if (destroyed || enabled) return;
      enabled = true;
      rendering?.setVisible(true);
      refresh();
    },
    disable() {
      enabled = false;
      sun = null;
      rendering?.setVisible(false);
      rendering?.clear();
      listener?.();
    },
    async update() {
      return refresh();
    },
    getRowControls() {
      return {
        legend: [
          { label: 'Night (sun below horizon)', color: '#06102e' },
          { label: 'Past civil twilight (6° below)', color: '#02061a' },
        ],
        info: sun
          ? `Sun overhead at ${degrees(sun.latitude, 'N', 'S')} ${degrees(sun.longitude, 'E', 'W')}\nUpdated ${new Date(lastUpdate).toISOString().slice(11, 19)} UTC · refreshes every 60 s`
          : '',
        infoTitle:
          'The terminator is computed in the browser from the current UTC time (solar declination and sidereal time), accurate to well under a degree. It shades the surface only and does not change the globe lighting used by other layers.',
      };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      return {
        count: sun ? 1 : 0,
        lastUpdate,
        loading: false,
        error: null,
        stale: false,
        fallback: false,
        source: 'Computed from UTC · no feed',
        subsolar: sun ? { ...sun } : null,
      };
    },
    getDiagnostics() {
      return {
        ...rendering?.getDiagnostics(),
        enabled,
        timerActive: false,
      };
    },
    destroy() {
      if (destroyed) return;
      layer.disable();
      destroyed = true;
      rendering?.destroy();
      rendering = null;
      viewer = null;
      listener = null;
    },
  };
  return layer;
}
