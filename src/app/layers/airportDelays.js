import { createAirportDelaysLayer } from '../../layers/airportDelays/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire FAA airport delay records to the application overlay host. */
export function createApplicationAirportDelays(options) {
  return createAirportDelaysLayer({ overlayHost, ...options });
}
