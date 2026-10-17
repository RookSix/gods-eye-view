import { createAircraftEmergenciesLayer } from '../../layers/aircraftEmergencies/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire emergency-squawk aircraft to the application overlay host. */
export function createApplicationAircraftEmergencies(options) {
  return createAircraftEmergenciesLayer({ overlayHost, ...options });
}
