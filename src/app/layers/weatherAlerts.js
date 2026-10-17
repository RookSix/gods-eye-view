import { createWeatherAlertsLayer } from '../../layers/weatherAlerts/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire severe weather alert areas to the application overlay host. */
export function createApplicationWeatherAlerts(options) {
  return createWeatherAlertsLayer({ overlayHost, ...options });
}
