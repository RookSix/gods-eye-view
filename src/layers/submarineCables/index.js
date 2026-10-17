import { createState } from './state.js';
import { createLifecycle } from './lifecycle.js';
import { defaultSweepClock } from './policy.js';
import { createRendering } from './rendering.js';
import { createIngestion } from './ingestion.js';
import { createInteraction } from './interaction.js';
import { createCableHealth } from './cableHealth.js';
/**
 * @param {object} options
 * @param {object} [options.cableHealth] Optional channel from
 *   `createCableHealthChannel()`. Cable health (a highlight, a flagged label and
 *   a card for cables near cable-ship warnings) activates only while that
 *   channel carries warnings, so the layer is unchanged by default.
 */
export function createSubmarineCableLayer({
  source,
  overlayHost,
  screenSpaceEventHandlerFactory,
  mapStackEventTarget = null,
  sweepClock = defaultSweepClock,
  cableHealth = null,
}) {
  if (!source?.fetch || !source.label)
    throw new TypeError(
      'A cable source with a label and fetch(signal) is required',
    );
  const state = createState({ overlayHost, sweepClock, cableHealth });
  const parts = {};
  const context = {
    state,
    parts,
    source,
    screenSpaceEventHandlerFactory,
    mapStackEventTarget,
  };
  parts.rendering = createRendering(context);
  parts.health = createCableHealth(context);
  parts.ingestion = createIngestion(context);
  parts.interaction = createInteraction(context);
  return createLifecycle(context);
}
export { createCableHealthChannel } from './healthChannel.js';
export {
  selectCableReferenceLabelWinners,
  cableReferencePriority,
  createCableOverlayEntry,
  createCableOverlayPublisher,
  createCableReferenceSweepGate,
  updateCableReferenceStem,
} from './overlay.js';
export {
  cableClassificationTypeForStack,
  cableClassificationTypeForScene,
  applyTranslucentMarkerBlend,
} from './surface.js';
export {
  CABLE_REFERENCE_LABEL_WINNER_CAP,
  CABLE_OVERLAY_SOURCE_ID,
  CABLE_OVERLAY_COLLISION_CAPACITY,
  CABLE_STEM_TIP_EPSILON_M,
  CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS,
  CABLE_SWEEP_MOTION_EPSILON_M,
  CABLE_LABEL_DEPTH_DECISION,
} from './policy.js';
