import { createFeedSource } from '../feedOverlay/source.js';
import { validateRadiationSnapshot } from './records.js';

/** Same-origin `/api/radiation` (Safecast + EPA RadNet) snapshot source. */
export function createRadiationSource(options = {}) {
  return createFeedSource({
    url: '/api/radiation',
    label: 'Radiation',
    validate: validateRadiationSnapshot,
    timeoutMs: 60_000,
    ...options,
  });
}
