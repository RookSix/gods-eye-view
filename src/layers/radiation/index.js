import {
  createEntityRendererFactory,
  createFeedOverlayLayer,
} from '../feedOverlay/layer.js';
import {
  RADIATION_CAVEAT,
  RADIATION_LAYER_ID,
  RADIATION_LEGEND,
  radiationAnalystRecord,
  radiationCard,
  radiationEntityOptions,
  radiationListItem,
  radiationPriority,
} from './model.js';

export * from './model.js';
export { createRadiationSource } from './source.js';

const createRenderer = createEntityRendererFactory({
  entityOptions: radiationEntityOptions,
});

/** Safecast and EPA RadNet dose rates as small coloured dots with info cards. */
export function createRadiationLayer({ feed, overlayHost, ...rest } = {}) {
  return createFeedOverlayLayer({
    id: RADIATION_LAYER_ID,
    name: 'Radiation (Safecast / RadNet)',
    icon: '☢',
    source: 'Safecast + EPA RadNet',
    updateInterval: 30 * 60_000,
    feed,
    overlayHost,
    ...rest,
    model: {
      createRenderer,
      // Hundreds of dots: only the selected one earns a card.
      overlayEntry: () => null,
      card: radiationCard,
      listItem: radiationListItem,
      priority: radiationPriority,
      analyst: radiationAnalystRecord,
      legend: RADIATION_LEGEND,
      summary: (snapshot, count) => {
        const radnet = snapshot.records.filter((r) => r.source === 'radnet');
        return `${count} readings (${radnet.length} RadNet stations, ${count - radnet.length} Safecast devices)`;
      },
      caveat: RADIATION_CAVEAT,
      infoTitle:
        'Latest reading per Safecast device from the last 2 days (cpm values are converted to µSv/h with the common 1/334 factor) and the latest valid hourly reading per EPA RadNet station (positions are city-level). Sensors are uncalibrated and community-run; this is not an official alert.',
    },
  });
}
