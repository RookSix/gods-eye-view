import {
  createEntityRendererFactory,
  createFeedOverlayLayer,
} from '../feedOverlay/layer.js';
import {
  AIRPORT_DELAYS_CAVEAT,
  AIRPORT_DELAYS_LAYER_ID,
  AIRPORT_DELAY_LEGEND,
  airportDelayAnalystRecord,
  airportDelayCard,
  airportDelayEntityOptions,
  airportDelayListItem,
  airportDelayOverlayEntry,
  airportDelayPriority,
} from './model.js';

export * from './model.js';
export { createAirportDelaysSource } from './source.js';

const createRenderer = createEntityRendererFactory({
  entityOptions: airportDelayEntityOptions,
});

/** FAA airport delays, ground stops and closures as severity-coloured points. */
export function createAirportDelaysLayer({ feed, overlayHost, ...rest } = {}) {
  return createFeedOverlayLayer({
    id: AIRPORT_DELAYS_LAYER_ID,
    name: 'Airport delays (FAA)',
    icon: '✈',
    source: 'FAA NAS Status',
    updateInterval: 5 * 60_000,
    feed,
    overlayHost,
    ...rest,
    model: {
      createRenderer,
      overlayEntry: airportDelayOverlayEntry,
      card: airportDelayCard,
      listItem: airportDelayListItem,
      priority: airportDelayPriority,
      analyst: airportDelayAnalystRecord,
      legend: AIRPORT_DELAY_LEGEND,
      cohortLimit: 40,
      summary: (snapshot, count) =>
        `${count} US airport${count === 1 ? '' : 's'} with delays or restrictions${snapshot.unmatched ? ` · ${snapshot.unmatched} not on the map` : ''}`,
      caveat: AIRPORT_DELAYS_CAVEAT,
      infoTitle:
        'FAA National Airspace System status: ground delay programs, ground stops, arrival/departure delays and airport closures. Limited closures (general aviation only, nightly or prior-permission) show grey. Only US airports in the bundled OurAirports list can be placed.',
    },
  });
}
