import { createFeedOverlayLayer } from '../feedOverlay/layer.js';
import { createNavWarningsRenderer } from './rendering.js';
import {
  NAV_WARNINGS_LAYER_ID,
  NAV_WARNING_LEGEND,
  cableWarningSummary,
  navWarningAnalystRecord,
  navWarningCard,
  navWarningListItem,
  navWarningOverlayEntry,
  navWarningPriority,
} from './model.js';

export * from './model.js';
export { createNavWarningsSource } from './source.js';

/**
 * NGA broadcast warnings as points, routes and areas with info cards.
 *
 * `cableHealth` is the optional channel shared with the submarine-cables
 * layer: while this layer is on it receives the cable-related warnings, and it
 * is emptied the moment this layer turns off, so cable highlighting can only
 * ever appear alongside the warnings that justify it.
 */
export function createNavWarningsLayer({
  feed,
  overlayHost,
  cableHealth = null,
  ...rest
} = {}) {
  const layer = createFeedOverlayLayer({
    id: NAV_WARNINGS_LAYER_ID,
    name: 'Navigational warnings (NGA)',
    icon: '⚓',
    source: 'NGA MSI broadcast warnings',
    updateInterval: 30 * 60_000,
    feed,
    overlayHost,
    ...rest,
    model: {
      createRenderer: createNavWarningsRenderer,
      records: (snapshot) => {
        cableHealth?.publish(
          snapshot.records
            .filter((r) => r.cableActivity)
            .map(cableWarningSummary),
        );
        return snapshot.records;
      },
      overlayEntry: navWarningOverlayEntry,
      card: navWarningCard,
      listItem: navWarningListItem,
      priority: navWarningPriority,
      analyst: navWarningAnalystRecord,
      legend: NAV_WARNING_LEGEND,
      cohortLimit: 24,
      summary: (snapshot, count) => {
        const cable = snapshot.records.filter((r) => r.cableActivity).length;
        return `${count} active warnings with positions (${cable} cable-related)${snapshot.withoutPosition ? ` · ${snapshot.withoutPosition} without a parseable position` : ''}`;
      },
      infoTitle:
        'Active NGA Maritime Safety Information broadcast warnings. Positions are parsed from the free text, so they are approximate and some warnings cannot be placed. A route or area is drawn only where the text clearly describes one. Not for navigation: use the official broadcast. With the Submarine Cables layer also on, cables near cable-ship warnings are highlighted as possible repair activity.',
    },
  });
  if (cableHealth) {
    const { disable, destroy } = layer;
    layer.disable = () => {
      disable();
      cableHealth.clear();
    };
    layer.destroy = () => {
      destroy();
      cableHealth.clear();
    };
  }
  return layer;
}
