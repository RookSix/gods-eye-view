import {
  createEntityRendererFactory,
  createFeedOverlayLayer,
} from '../feedOverlay/layer.js';
import {
  AIRCRAFT_EMERGENCIES_LAYER_ID,
  EMERGENCY_LEGEND,
  SQUAWK_CAVEAT,
  emergencyAnalystRecord,
  emergencyCard,
  emergencyEntityOptions,
  emergencyListItem,
  emergencyOverlayEntry,
  emergencyPriority,
} from './model.js';

export * from './model.js';
export { createAircraftEmergenciesSource } from './source.js';

const createRenderer = createEntityRendererFactory({
  entityOptions: emergencyEntityOptions,
});

/** Aircraft squawking 7500, 7600 or 7700, with heading and overlay cards. */
export function createAircraftEmergenciesLayer({
  feed,
  overlayHost,
  ...rest
} = {}) {
  return createFeedOverlayLayer({
    id: AIRCRAFT_EMERGENCIES_LAYER_ID,
    name: 'Aircraft emergencies (squawk)',
    icon: '✈',
    // Avoid naming adsb.lol here: the row chip reads that as a fallback feed.
    source: 'ADS-B squawk 7500/7600/7700',
    updateInterval: 30_000,
    feed,
    overlayHost,
    ...rest,
    model: {
      createRenderer,
      overlayEntry: emergencyOverlayEntry,
      card: emergencyCard,
      listItem: emergencyListItem,
      priority: emergencyPriority,
      analyst: emergencyAnalystRecord,
      legend: EMERGENCY_LEGEND,
      caveat: SQUAWK_CAVEAT,
      cohortLimit: 48,
      summary: (snapshot, count) =>
        count
          ? `${count} aircraft squawking an emergency code`
          : 'No aircraft squawking 7500 / 7600 / 7700',
      infoTitle:
        'Aircraft transmitting an ICAO emergency squawk, from community ADS-B receivers via adsb.lol. Coverage depends on receivers; a squawk can be set in error or during a drill and is not a confirmed incident.',
    },
  });
}
