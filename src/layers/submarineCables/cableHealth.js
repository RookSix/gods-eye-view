import * as Cesium from 'cesium';
import { featureLabel } from './geometry.js';
import { CABLE_HEALTH_COLOR, matchWarningsToCables } from './health.js';
import { CABLE_HEALTH_CARD_SOURCE_ID } from './policy.js';
import { createCableOverlayEntry } from './overlay.js';

const CARD = Object.freeze({
  cardStyle: 'tactical',
  collisionGroup: 'ambient-card',
  edgeFade: 'keyhole',
  horizonCull: true,
  terrainOcclusion: false,
  interactive: false,
  verticalOnly: true,
  viewportMargin: 4,
  maxDistance: Number.POSITIVE_INFINITY,
  variant: 'selected',
  selected: true,
  protected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 22,
  leaderOffsetPx: 14,
});

const utc = (iso) =>
  iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'time unavailable';

/**
 * Cable health: cables near cable-ship navigational warnings get a "possible
 * fault/repair activity" highlight, a flagged map label and, when selected, an
 * info card naming the warning. Inert unless the application supplied the
 * health channel AND the warnings layer is publishing into it.
 */
export function createCableHealth({ state, parts }) {
  let cardShown = false;

  const signatureOf = (matches) =>
    [...matches]
      .map(([id, list]) => `${id}:${list.map((m) => m.warningId).join('+')}`)
      .sort()
      .join('|');

  function recompute() {
    state._healthMatches = state._healthWarnings.length
      ? matchWarningsToCables(state._healthFeatures, state._healthWarnings)
      : new Map();
    state._healthSignature = signatureOf(state._healthMatches);
  }

  function restyle() {
    for (const [id, entity] of state._cableEntityByFeatureId) {
      const feature = state._healthFeatureById.get(id);
      if (feature) parts.rendering.styleCableEntity(entity, feature);
    }
    for (const record of state._referenceRecords) {
      if (record.kind !== 'cable') continue;
      record.healthFlag = state._healthMatches.has(record.featureId);
      record.entry = createCableOverlayEntry(record);
    }
    parts.rendering.resetPublishSignature();
    state._referenceSweepGate.markDirty();
    state._viewer?.scene?.requestRender?.();
  }

  function refreshCard() {
    const id = state._healthCardId;
    if (id && !state._healthMatches.has(id)) clearCard();
    else if (id) showCard(id);
  }

  function onWarnings(warnings) {
    state._healthWarnings = warnings;
    if (!state._enabled || !state._loaded) return;
    const before = state._healthSignature;
    recompute();
    if (state._healthSignature === before) return;
    restyle();
    refreshCard();
  }

  function showCard(featureId) {
    const matches = state._healthMatches.get(featureId);
    const host = state._overlayHost;
    const record = state._referenceRecords.find(
      (r) => r.kind === 'cable' && r.featureId === featureId,
    );
    if (!matches?.length || !host || !record) return false;
    const [newest] = matches;
    const feature = state._healthFeatureById.get(featureId);
    host.setVisible(CABLE_HEALTH_CARD_SOURCE_ID, true);
    host.setEntries(
      CABLE_HEALTH_CARD_SOURCE_ID,
      [
        {
          ...CARD,
          id: `${CABLE_HEALTH_CARD_SOURCE_ID}:${featureId}`,
          position: Cesium.Cartesian3.fromDegrees(
            record.reference.lon,
            record.reference.lat,
            0,
          ),
          title: featureLabel(feature) || 'Submarine cable',
          details: [
            `Possible fault/repair activity · ${newest.title}`,
            `Issued ${utc(newest.issued)} · ${newest.distanceKm} km from the warning position`,
            newest.excerpt,
            matches.length > 1
              ? `+${matches.length - 1} more nearby warning${matches.length > 2 ? 's' : ''} · NGA broadcast warning, not a confirmed fault`
              : 'NGA broadcast warning, not a confirmed fault',
          ],
          accent: CABLE_HEALTH_COLOR,
        },
      ],
      { cohortLimit: 2, collisionCapacity: 1, moving: false },
    );
    cardShown = true;
    state._healthCardId = featureId;
    return true;
  }

  function clearCard() {
    state._healthCardId = null;
    if (!cardShown) return;
    cardShown = false;
    state._overlayHost?.clearSource(CABLE_HEALTH_CARD_SOURCE_ID);
    state._overlayHost?.setVisible(CABLE_HEALTH_CARD_SOURCE_ID, false);
  }

  return {
    /** Called by ingestion once the normalized features of a load are known. */
    setFeatures(features) {
      state._healthFeatures = features;
      state._healthFeatureById = new Map(features.map((f) => [f.id, f]));
      recompute();
    },
    attach() {
      const channel = state._healthChannel;
      if (!channel || state._healthUnsubscribe) return;
      state._healthUnsubscribe = channel.subscribe(onWarnings);
      state._healthWarnings = channel.get();
      if (!state._loaded) return;
      recompute();
      if (state._healthMatches.size) restyle();
    },
    /** Stop listening and return every cable to its default look. */
    detach() {
      state._healthUnsubscribe?.();
      state._healthUnsubscribe = null;
      state._healthWarnings = [];
      state._healthMatches = new Map();
      state._healthSignature = '';
      clearCard();
    },
    /** A click on a cable: show its health card, or drop any card shown. */
    select(featureId) {
      if (featureId && state._healthMatches.has(featureId)) {
        showCard(featureId);
      } else clearCard();
    },
    clearCard,
    flaggedCount: () => state._healthMatches.size,
  };
}
