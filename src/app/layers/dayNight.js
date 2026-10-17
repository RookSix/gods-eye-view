import { createDayNightLayer } from '../../layers/dayNight/index.js';
/** Day/night is pure client computation; there is no source or overlay host. */
export function createApplicationDayNight(options) {
  return createDayNightLayer(options);
}
