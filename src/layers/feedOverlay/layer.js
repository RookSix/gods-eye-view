import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { createEntityRendererFactory } from './entityRenderer.js';

export { createEntityRendererFactory };

/** Ambient ceiling for the cards one feed layer publishes to the host. */
export const FEED_OVERLAY_COHORT_LIMIT = 64;
const LIST_LIMIT = 12;

const SELECTED_CARD = Object.freeze({
  cardStyle: 'tactical',
  collisionGroup: 'ambient-card',
  edgeFade: 'keyhole',
  horizonCull: true,
  terrainOcclusion: false,
  interactive: false,
  verticalOnly: true,
  viewportMargin: 4,
  maxDistance: Number.POSITIVE_INFINITY,
});

/**
 * One click-selectable feed layer: acquire a snapshot, draw its records through
 * a supplied renderer, publish ambient labels and the selected card through the
 * world-overlay host, and describe the selection in the layer row.
 *
 * The model owns everything that is specific to a feed (record shape, graphics,
 * card text); this owner keeps lifecycle, cancellation and selection.
 *
 * @param {object} options
 * @param {string} options.id Layer id.
 * @param {string} options.name Layer row name.
 * @param {string} options.icon Layer row icon.
 * @param {string} options.source Source text for the row meta line.
 * @param {number} options.updateInterval Refresh cadence (ms).
 * @param {{getSnapshot:Function}} options.feed Snapshot source.
 * @param {object} options.overlayHost World-overlay host.
 * @param {object} options.model Feed-specific behaviour (see below).
 * @param {Function} options.model.createRenderer `({viewer, cesium, layerId})`.
 * @param {(record:object, selected:boolean)=>?object} [options.model.overlayEntry]
 *   Ambient label/card fields (no id/position) or null for no label.
 * @param {(record:object)=>{title:string, lines:string[], url?:?string, accent?:string}} options.model.card
 * @param {(record:object)=>{text:string, lead?:string}} [options.model.listItem]
 * @param {Array<{label:string, color:string}>} [options.model.legend]
 * @param {(snapshot:object, count:number)=>string} [options.model.summary]
 * @param {(record:object)=>number} [options.model.priority]
 * @param {(record:object, index:number)=>object} [options.model.analyst]
 * @param {number} [options.model.cohortLimit] Ambient label ceiling.
 * @param {string} [options.model.caveat] Line appended to every row readout.
 * @param {string} [options.model.infoTitle] Row readout tooltip.
 * @returns {object} Layer instance.
 */
export function createFeedOverlayLayer({
  id,
  name,
  icon,
  source,
  updateInterval,
  feed,
  overlayHost,
  cesium = Cesium,
  model,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  openLink = (url) => globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError(`${name} requires a snapshot source`);
  if (!overlayHost) throw new TypeError(`${name} requires an overlay host`);
  const priority = model.priority || (() => 0);
  let viewer = null,
    renderer = null,
    snapshot = null,
    request = null,
    listener = null,
    clickHandler = null,
    runNavigation = null,
    selectedId = null,
    navigationGeneration = 0;
  let enabled = false,
    loading = false,
    destroyed = false,
    error = null,
    lastUpdate = null;
  let records = [];
  let byId = new Map();
  const notify = () => listener?.();
  const selected = () => (selectedId ? byId.get(selectedId) || null : null);
  const anchor = (record) =>
    cesium.Cartesian3.fromDegrees(record.lon, record.lat, record.heightM || 0);

  function publishOverlay() {
    if (!enabled || destroyed) return;
    const entries = [];
    for (const record of records) {
      const isSelected = record.id === selectedId;
      if (isSelected) {
        const card = model.card(record);
        entries.push({
          ...SELECTED_CARD,
          id: record.id,
          position: anchor(record),
          variant: 'selected',
          title: card.title,
          details: card.lines.slice(0, 4),
          accent: card.accent || '#ffe19a',
          selected: true,
          protected: true,
          priority: Number.MAX_SAFE_INTEGER,
          gapPx: 22,
          leaderOffsetPx: 14,
        });
        continue;
      }
      const partial = model.overlayEntry?.(record, false);
      if (!partial) continue;
      entries.push({
        id: record.id,
        position: anchor(record),
        priority: priority(record),
        ...partial,
      });
    }
    entries.sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    );
    const limit = model.cohortLimit || FEED_OVERLAY_COHORT_LIMIT;
    const capped = [];
    let ambient = 0;
    for (const entry of entries) {
      if (entry.protected) capped.push(entry);
      else if (ambient < limit) {
        ambient++;
        capped.push(entry);
      }
    }
    overlayHost.setVisible(id, true);
    overlayHost.setEntries(id, capped, {
      cohortLimit: limit + 1,
      collisionCapacity: Math.min(limit, ambient),
      moving: false,
    });
  }

  function clearOverlay() {
    overlayHost.clearSource(id);
    overlayHost.setVisible(id, false);
  }

  function select(next) {
    if (selectedId !== next) ++navigationGeneration;
    selectedId = next;
    renderer?.setSelection(next);
    publishOverlay();
  }

  function installSelection() {
    if (
      clickHandler ||
      !viewer?.scene?.canvas ||
      typeof cesium.ScreenSpaceEventHandler !== 'function'
    )
      return;
    const owner = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler = owner;
    owner.setInputAction((click) => {
      // Ambient selection yields to draw tools and Director.
      if (
        !enabled ||
        destroyed ||
        clickHandler !== owner ||
        !isPointerFree() ||
        !click?.position
      )
        return;
      const picked = viewer.scene.pick(click.position);
      const recordId = renderer?.recordIdFromPick?.(picked) ?? null;
      if (recordId && byId.has(recordId)) {
        layer.setParams({ recordId });
        return;
      }
      // Another layer's pick is not empty map; leave the selection alone.
      if (
        picked &&
        (picked.id !== undefined || picked.primitive?.id !== undefined)
      )
        return;
      if (selectedId !== null) layer.setParams({ clear: true });
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeSelection() {
    const owner = clickHandler;
    clickHandler = null;
    if (owner && !owner.isDestroyed?.()) owner.destroy();
  }

  function apply(next) {
    snapshot = next;
    records = model.records ? model.records(next) : next.records;
    byId = new Map(records.map((record) => [record.id, record]));
    if (selectedId && !byId.has(selectedId)) {
      selectedId = null;
      ++navigationGeneration;
    }
    renderer.setRecords(records, selectedId);
    publishOverlay();
  }

  function failedSources() {
    return Object.entries(snapshot?.sources || {})
      .filter(([, entry]) => entry.ok === false)
      .map(([key]) => key);
  }

  const layer = {
    id,
    name,
    icon,
    source,
    updateInterval,
    init(nextViewer) {
      if (viewer) throw new Error(`${name} is already initialized`);
      viewer = nextViewer;
      renderer = model.createRenderer({ viewer, cesium, layerId: id });
      overlayHost.setVisible(id, false);
    },
    attachShellServices(services) {
      runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
    },
    enable() {
      if (destroyed || enabled) return;
      enabled = true;
      renderer?.setVisible(true);
      installSelection();
      publishOverlay();
    },
    disable() {
      enabled = false;
      removeSelection();
      request?.abort();
      request = null;
      loading = false;
      error = null;
      snapshot = null;
      records = [];
      byId = new Map();
      selectedId = null;
      ++navigationGeneration;
      renderer?.setVisible(false);
      renderer?.clear();
      clearOverlay();
      notify();
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled || destroyed || !renderer) return false;
      request?.abort();
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      request = controller;
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      loading = true;
      notify();
      try {
        signal?.throwIfAborted();
        const next = await feed.getSnapshot({ signal: controller.signal });
        if (!enabled || controller.signal.aborted || request !== controller)
          return false;
        apply(next);
        error = null;
        lastUpdate = Date.now();
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        // The last good snapshot stays on screen; the row reports the failure.
        error = cause?.message || `${name} unavailable`;
        return false;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = false;
          notify();
        }
      }
    },
    setParams(params = {}) {
      if (!enabled || destroyed) return;
      if (params.clear === true || params.recordId === null) {
        select(null);
        notify();
      } else if (
        typeof params.recordId === 'string' &&
        byId.has(params.recordId)
      ) {
        select(params.recordId);
        notify();
      }
      const record = selected();
      if (params.focus === true && record && runNavigation && viewer) {
        const generation = ++navigationGeneration;
        const sphere = new cesium.BoundingSphere(anchor(record), 300_000);
        runNavigation(() => {
          if (
            !enabled ||
            destroyed ||
            generation !== navigationGeneration ||
            selectedId !== record.id
          )
            return;
          return viewer.camera.flyToBoundingSphere(sphere, {
            duration: matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
              ? 0
              : 1.4,
          });
        });
      }
      if (params.open === true) {
        const url = record ? model.card(record).url : null;
        if (url) openLink(url);
      }
    },
    getRowControls() {
      const record = selected();
      const card = record ? model.card(record) : null;
      const failed = failedSources();
      const status =
        error ||
        (snapshot?.stale ? 'Cached data · upstream unavailable' : null) ||
        (failed.length ? `Partial: ${failed.join(', ')} unavailable` : null) ||
        (loading && !snapshot ? 'Loading…' : null);
      const summary = snapshot
        ? model.summary?.(snapshot, records.length) ||
          `${records.length} record${records.length === 1 ? '' : 's'}`
        : loading
          ? 'Loading…'
          : 'No data yet';
      const chips = [];
      if (card?.url)
        chips.push({
          id: 'open',
          label: 'Source ↗',
          onClick: () => layer.setParams({ open: true }),
        });
      if (record)
        chips.push({
          id: 'clear',
          label: 'Clear',
          params: { clear: true },
        });
      const lines = card ? [card.title, ...card.lines] : [summary];
      if (status) lines.push(status);
      if (model.caveat) lines.push(model.caveat);
      const items = model.listItem
        ? [...records]
            .sort(
              (a, b) => priority(b) - priority(a) || a.id.localeCompare(b.id),
            )
            .slice(0, LIST_LIMIT)
            .map((item, index) => ({
              id: item.id,
              ordinal: index + 1,
              ...model.listItem(item),
              active: item.id === selectedId,
              params: { recordId: item.id, focus: true },
            }))
        : [];
      return {
        chips,
        legend: model.legend || [],
        list: items.length
          ? { ariaLabel: `${name} records`, items }
          : undefined,
        info: lines.join('\n'),
        infoTitle: model.infoTitle || '',
      };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    /**
     * Plain JSON-safe records for the analyst query engine, on demand only.
     * @param {number} [maxCount=Infinity]
     * @returns {Array<object>} [] while the layer is off.
     */
    getAnalystRecords(maxCount = Infinity) {
      if (!enabled || destroyed || !model.analyst) return [];
      return records.slice(0, maxCount).map((r, i) => model.analyst(r, i));
    },
    getStats() {
      const failed = failedSources();
      return {
        count: records.length,
        lastUpdate,
        loading,
        error,
        stale: Boolean(snapshot?.stale),
        partial: failed.length > 0,
        // A named upstream (e.g. adsb.lol) must not read as a degraded fallback.
        fallback: false,
        source,
        attribution: snapshot?.attribution || null,
      };
    },
    getDiagnostics() {
      return {
        ...renderer?.getDiagnostics(),
        enabled,
        loading,
        requestPending: !!request,
        selectionActive: clickHandler !== null,
        selectedId,
        timerActive: false,
      };
    },
    destroy() {
      if (destroyed) return;
      layer.disable();
      destroyed = true;
      renderer?.destroy();
      renderer = null;
      viewer = null;
      listener = null;
      runNavigation = null;
    },
  };
  return layer;
}
