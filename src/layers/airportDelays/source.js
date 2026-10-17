import { createFeedSource } from '../feedOverlay/source.js';
import { validateAirportDelaysSnapshot } from './records.js';

/** Same-origin `/api/airport-delays` (FAA NAS status) snapshot source. */
export function createAirportDelaysSource(options = {}) {
  return createFeedSource({
    url: '/api/airport-delays',
    label: 'Airport delays',
    validate: validateAirportDelaysSnapshot,
    ...options,
  });
}
