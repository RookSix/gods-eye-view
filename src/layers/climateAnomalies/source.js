import { createFeedSource } from '../feedOverlay/source.js';
import { validateClimateAnomaliesSnapshot } from './records.js';

/** Same-origin `/api/climate-anomalies` (Open-Meteo ERA5) snapshot source. */
export function createClimateAnomaliesSource(options = {}) {
  return createFeedSource({
    url: '/api/climate-anomalies',
    label: 'Climate anomalies',
    validate: validateClimateAnomaliesSnapshot,
    ...options,
  });
}
