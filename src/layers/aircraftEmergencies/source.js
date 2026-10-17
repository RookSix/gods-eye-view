import { createFeedSource } from '../feedOverlay/source.js';
import { validateAircraftEmergenciesSnapshot } from './records.js';

/** Same-origin `/api/aircraft-emergencies` (squawk 7500/7600/7700) source. */
export function createAircraftEmergenciesSource(options = {}) {
  return createFeedSource({
    url: '/api/aircraft-emergencies',
    label: 'Aircraft emergencies',
    validate: validateAircraftEmergenciesSnapshot,
    timeoutMs: 15_000,
    ...options,
  });
}
