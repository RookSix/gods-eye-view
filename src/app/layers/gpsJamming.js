import { createGpsJammingLayer } from '../../layers/gpsJamming/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire gpsjam.org interference cells to the application overlay host. */
export function createApplicationGpsJamming(options) {
  return createGpsJammingLayer({ overlayHost, ...options });
}
