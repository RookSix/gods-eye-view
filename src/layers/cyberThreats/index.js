import {
  createEntityRendererFactory,
  createFeedOverlayLayer,
} from '../feedOverlay/layer.js';
import {
  CYBER_LEGEND,
  CYBER_THREATS_CAVEAT,
  CYBER_THREATS_LAYER_ID,
  cyberThreatAnalystRecord,
  cyberThreatCard,
  cyberThreatEntityOptions,
  cyberThreatListItem,
  cyberThreatPriority,
} from './model.js';

export * from './model.js';
export { createCyberThreatsSource } from './source.js';

const createRenderer = createEntityRendererFactory({
  entityOptions: cyberThreatEntityOptions,
});

/** Botnet and C2 server indicators as small family-coloured dots with cards. */
export function createCyberThreatsLayer({ feed, overlayHost, ...rest } = {}) {
  return createFeedOverlayLayer({
    id: CYBER_THREATS_LAYER_ID,
    name: 'Cyber threats (C2 servers)',
    icon: '☠',
    source: 'Feodo Tracker + C2IntelFeeds',
    updateInterval: 60 * 60_000,
    feed,
    overlayHost,
    ...rest,
    model: {
      createRenderer,
      // Hundreds of dots: only the selected one earns a card.
      overlayEntry: () => null,
      card: cyberThreatCard,
      listItem: cyberThreatListItem,
      priority: cyberThreatPriority,
      analyst: cyberThreatAnalystRecord,
      legend: CYBER_LEGEND,
      summary: (snapshot, count) => {
        const { ipLocated, countryCentroid, dropped } = snapshot.geo;
        const skipped = Object.entries(snapshot.sources)
          .filter(([, entry]) => entry.skipped)
          .map(([key]) => key);
        return `${count} indicators (${ipLocated} at IP location, ${countryCentroid} at country level${dropped ? `, ${dropped} unplaced` : ''})${skipped.length ? ` · no key: ${skipped.join(', ')}` : ''}`;
      },
      caveat: CYBER_THREATS_CAVEAT,
      infoTitle:
        'Known botnet command-and-control servers from abuse.ch Feodo Tracker and C2IntelFeeds, plus URLhaus, AlienVault OTX and AbuseIPDB when their keys are set on the server. Positions come from server-side IP geolocation (cached for seven days) or, failing that, the country centroid; points are spread slightly so they stay separate. Hosting location is not the location of the attacker.',
    },
  });
}
