import { createFeedSource } from '../feedOverlay/source.js';
import { validateGpsJammingSnapshot } from './model.js';

/** Same-origin `/api/gps-jamming` (gpsjam.org daily H3 cells) source. */
export function createGpsJammingSource(options = {}) {
  return createFeedSource({
    url: '/api/gps-jamming',
    label: 'GPS jamming',
    validate: validateGpsJammingSnapshot,
    timeoutMs: 60_000,
    ...options,
  });
}
