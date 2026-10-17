import { createNaturalEventsLayer } from '../../layers/naturalEvents/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire natural-event records to the application overlay host. */
export function createApplicationNaturalEvents(options) {
  return createNaturalEventsLayer({ overlayHost, ...options });
}
