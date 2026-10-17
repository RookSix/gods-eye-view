import { createFeedOverlayLayer } from '../feedOverlay/layer.js';
import { createWeatherAlertsRenderer } from './rendering.js';
import {
  WEATHER_ALERTS_CAVEAT,
  WEATHER_ALERTS_LAYER_ID,
  WEATHER_ALERT_LEGEND,
  labelAlerts,
  weatherAlertAnalystRecord,
  weatherAlertCard,
  weatherAlertListItem,
  weatherAlertOverlayEntry,
  weatherAlertPriority,
} from './model.js';

export * from './model.js';
export { createWeatherAlertsSource } from './source.js';

/** NWS, Environment Canada and WMO severe weather alerts as outlined areas. */
export function createWeatherAlertsLayer({ feed, overlayHost, ...rest } = {}) {
  return createFeedOverlayLayer({
    id: WEATHER_ALERTS_LAYER_ID,
    name: 'Severe weather alerts',
    icon: '⛈',
    source: 'NWS + Environment Canada + WMO',
    updateInterval: 5 * 60_000,
    feed,
    overlayHost,
    ...rest,
    model: {
      createRenderer: createWeatherAlertsRenderer,
      records: (snapshot) => labelAlerts(snapshot.records),
      overlayEntry: weatherAlertOverlayEntry,
      card: weatherAlertCard,
      listItem: weatherAlertListItem,
      priority: weatherAlertPriority,
      analyst: weatherAlertAnalystRecord,
      legend: WEATHER_ALERT_LEGEND,
      cohortLimit: 12,
      summary: (snapshot, count) => {
        const { noGeometry, truncated } = snapshot.skipped;
        const extras = [
          noGeometry ? `${noGeometry} zone-only alerts not drawn` : null,
          truncated ? `${truncated} omitted for size` : null,
        ].filter(Boolean);
        return `${count} ${snapshot.minSeverity}-or-worse alerts with an area${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
      },
      caveat: WEATHER_ALERTS_CAVEAT,
      infoTitle:
        'Active severe weather alerts of Moderate severity or worse: US National Weather Service, Environment and Climate Change Canada, and WMO Severe Weather Information Centre members (US and Canadian WMO duplicates are dropped). Outlines are simplified. US alerts that only name forecast zones carry no outline and are not drawn. Only the most severe, largest alerts are labelled.',
    },
  });
}
