import {
  createEntityRendererFactory,
  createFeedOverlayLayer,
} from '../feedOverlay/layer.js';
import {
  NATURAL_EVENTS_LAYER_ID,
  NATURAL_EVENT_LEGEND,
  naturalEventAnalystRecord,
  naturalEventCard,
  naturalEventEntityOptions,
  naturalEventListItem,
  naturalEventOverlayEntry,
  naturalEventPriority,
} from './model.js';

export * from './model.js';
export { createNaturalEventsSource } from './source.js';

const createRenderer = createEntityRendererFactory({
  entityOptions: naturalEventEntityOptions,
});

/** GDACS and NASA EONET events as category-styled points with info cards. */
export function createNaturalEventsLayer({ feed, overlayHost, ...rest } = {}) {
  return createFeedOverlayLayer({
    id: NATURAL_EVENTS_LAYER_ID,
    name: 'Natural events (GDACS / EONET)',
    icon: '⚠',
    source: 'GDACS + NASA EONET',
    updateInterval: 600_000,
    feed,
    overlayHost,
    ...rest,
    model: {
      createRenderer,
      overlayEntry: naturalEventOverlayEntry,
      card: naturalEventCard,
      listItem: naturalEventListItem,
      priority: naturalEventPriority,
      analyst: naturalEventAnalystRecord,
      legend: NATURAL_EVENT_LEGEND,
      cohortLimit: 32,
      summary: (snapshot, count) =>
        `${count} open event${count === 1 ? '' : 's'} · earthquakes are on the USGS layer`,
      infoTitle:
        'GDACS alerts (EC JRC / UN OCHA) and NASA EONET open events from the last 30 days. Positions are event centroids, not impact footprints. GDACS earthquakes are omitted because the Earthquakes layer covers them. Tropical cyclones appear here from GDACS and EONET (JTWC), worldwide, separate from the NHC/CPHC cyclone layer.',
    },
  });
}
