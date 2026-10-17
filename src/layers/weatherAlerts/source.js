import { createFeedSource } from '../feedOverlay/source.js';
import { validateWeatherAlertsSnapshot } from './records.js';

/** Same-origin `/api/weather-alerts` (NWS + ECCC + WMO) snapshot source. */
export function createWeatherAlertsSource(options = {}) {
  return createFeedSource({
    url: '/api/weather-alerts',
    label: 'Weather alerts',
    validate: validateWeatherAlertsSnapshot,
    timeoutMs: 60_000,
    ...options,
  });
}
