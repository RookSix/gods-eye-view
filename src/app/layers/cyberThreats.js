import { createCyberThreatsLayer } from '../../layers/cyberThreats/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire cyber threat indicators to the application overlay host. */
export function createApplicationCyberThreats(options) {
  return createCyberThreatsLayer({ overlayHost, ...options });
}
