import {
  createEntityRendererFactory,
  createFeedOverlayLayer,
} from '../feedOverlay/layer.js';
import {
  CLIMATE_ANOMALIES_LAYER_ID,
  CLIMATE_ATTRIBUTION,
  CLIMATE_LEGEND,
  climateAnalystRecord,
  climateCard,
  climateEntityOptions,
  climateListItem,
  climateOverlayEntry,
  climatePriority,
} from './model.js';

export * from './model.js';
export { createClimateAnomaliesSource } from './source.js';

const createRenderer = createEntityRendererFactory({
  entityOptions: climateEntityOptions,
});

/** ERA5 temperature and precipitation anomalies for representative regions. */
export function createClimateAnomaliesLayer({
  feed,
  overlayHost,
  ...rest
} = {}) {
  return createFeedOverlayLayer({
    id: CLIMATE_ANOMALIES_LAYER_ID,
    name: 'Climate anomalies (ERA5)',
    icon: '◐',
    source: 'Open-Meteo ERA5',
    updateInterval: 6 * 3600_000,
    feed,
    overlayHost,
    ...rest,
    model: {
      createRenderer,
      overlayEntry: climateOverlayEntry,
      card: climateCard,
      listItem: climateListItem,
      priority: climatePriority,
      analyst: climateAnalystRecord,
      legend: CLIMATE_LEGEND,
      cohortLimit: 32,
      summary: (snapshot, count) =>
        `${count} regions · ${snapshot.records[0]?.recentStart ?? '?'} to ${snapshot.records[0]?.recentEnd ?? '?'}`,
      caveat: CLIMATE_ATTRIBUTION,
      infoTitle:
        'Representative regions only, not a global grid. Each circle compares the last 7 complete days (ERA5 lags real time by about 5 days) with the 30 days before them: temperature in °C, precipitation as a percentage change of the daily average. This is a short-term comparison, not a 1991-2020 climatology.',
    },
  });
}
