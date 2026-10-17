import { createClimateAnomaliesLayer } from '../../layers/climateAnomalies/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire climate-anomaly records to the application overlay host. */
export function createApplicationClimateAnomalies(options) {
  return createClimateAnomaliesLayer({ overlayHost, ...options });
}
