import { createFeedSource } from '../feedOverlay/source.js';
import { validateNaturalEventsSnapshot } from './records.js';

/** Same-origin `/api/natural-events` (GDACS + NASA EONET) snapshot source. */
export function createNaturalEventsSource(options = {}) {
  return createFeedSource({
    url: '/api/natural-events',
    label: 'Natural events',
    validate: validateNaturalEventsSnapshot,
    ...options,
  });
}
