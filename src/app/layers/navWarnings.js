import { createNavWarningsLayer } from '../../layers/navWarnings/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire navigational-warning records to the application overlay host. */
export function createApplicationNavWarnings(options) {
  return createNavWarningsLayer({ overlayHost, ...options });
}
