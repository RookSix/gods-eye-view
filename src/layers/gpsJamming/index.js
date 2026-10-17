import { createFeedOverlayLayer } from '../feedOverlay/layer.js';
import { createGpsJammingRenderer } from './rendering.js';
import {
  GPS_JAMMING_LAYER_ID,
  GPS_JAMMING_LEGEND,
  gpsJammingAnalystRecord,
  gpsJammingCard,
  gpsJammingPriority,
} from './model.js';

export * from './model.js';
export { createGpsJammingSource } from './source.js';

/** gpsjam.org daily interference as translucent H3 cells with info cards. */
export function createGpsJammingLayer({ feed, overlayHost, ...rest } = {}) {
  return createFeedOverlayLayer({
    id: GPS_JAMMING_LAYER_ID,
    name: 'GPS jamming (gpsjam.org)',
    icon: '⌖',
    source: 'gpsjam.org · daily',
    updateInterval: 6 * 3600_000,
    feed,
    overlayHost,
    ...rest,
    model: {
      createRenderer: createGpsJammingRenderer,
      // Cells are fills; only the selected cell earns a card.
      overlayEntry: () => null,
      card: gpsJammingCard,
      priority: gpsJammingPriority,
      analyst: gpsJammingAnalystRecord,
      legend: GPS_JAMMING_LEGEND,
      summary: (snapshot, count) => {
        const high = snapshot.records.filter((r) => r.level === 'high').length;
        return `${count} interference cells (${high} high) · data day ${snapshot.date}${snapshot.suspect ? ' · flagged suspect' : ''}`;
      },
      infoTitle:
        'gpsjam.org derives interference from ADS-B position-quality reports: the share of aircraft in each ~25 km cell that reported degraded navigation accuracy that day. It indicates possible GNSS interference, not a confirmed jamming source. Cells with fewer than 3 aircraft or under 2% degraded are hidden.',
    },
  });
}
