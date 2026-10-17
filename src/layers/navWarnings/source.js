import { createFeedSource } from '../feedOverlay/source.js';
import { validateNavWarningsSnapshot } from './records.js';

/** Same-origin `/api/nav-warnings` (NGA MSI broadcast warnings) source. */
export function createNavWarningsSource(options = {}) {
  return createFeedSource({
    url: '/api/nav-warnings',
    label: 'Navigational warnings',
    validate: validateNavWarningsSnapshot,
    ...options,
  });
}
