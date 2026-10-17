import { createFeedSource } from '../feedOverlay/source.js';
import { validateCyberThreatsSnapshot } from './records.js';

/** Same-origin `/api/cyber-threats` (Feodo + C2Intel + optional feeds) snapshot source. */
export function createCyberThreatsSource(options = {}) {
  return createFeedSource({
    url: '/api/cyber-threats',
    label: 'Cyber threats',
    validate: validateCyberThreatsSnapshot,
    // The first refresh may spend its time budget on server-side geolocation.
    timeoutMs: 60_000,
    ...options,
  });
}
