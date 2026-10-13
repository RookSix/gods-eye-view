import { tilesForBounds, tileToBBox } from '../../data/tomtomTiles.js';
import {
  OVERPASS_URL,
  QUERY_LIMIT,
  MAX_VIEWPORT_DEGREES,
  QUERY_SNAP_DEGREES,
  DETAIL_MIN_ZOOM,
  DETAIL_MAX_ZOOM,
  DETAIL_MAX_TILES,
  SOURCE_RECORD_LIMIT,
  PRECISION_CACHE_LIMIT,
} from './policy.js';
import {
  createVectorTileSource,
  validTileBounds,
} from '../../sources/vectorTiles.js';
import { buildOverpassQuery, normalizeAlprNode } from './records.js';
import { decodeAlprTile } from './tileRecords.js';

/**
 * Finest attributed extract zoom whose tiles for `box` fit the per-view cap,
 * or null when even z9 would not (the layer asks the user to zoom in).
 * @param {{south:number, west:number, north:number, east:number}} box View box.
 * @returns {number|null} Tile zoom.
 */
export function alprDetailZoom(box) {
  for (let zoom = DETAIL_MAX_ZOOM; zoom >= DETAIL_MIN_ZOOM; zoom--)
    if (
      tilesForBounds(box, zoom, { maxTiles: DETAIL_MAX_TILES + 1 }).length <=
      DETAIL_MAX_TILES
    )
      return zoom;
  return null;
}

/**
 * Tile coordinates are quantized per zoom (about 19 m at z9, 2 m at z12).
 * Remember each camera's finest position so zooming out never nudges a marker
 * that a closer view already placed precisely. Bounded, oldest first.
 * @param {number} [limit] Cameras remembered.
 * @returns {{apply: (record: object, zoom: number) => object, clear: () => void,
 *   size: () => number}} Cache.
 */
export function createAlprPrecisionCache(limit = PRECISION_CACHE_LIMIT) {
  const known = new Map();
  return {
    apply(record, zoom) {
      const finer = known.get(record.id);
      if (finer && finer.zoom > zoom)
        return finer.latitude === record.latitude &&
          finer.longitude === record.longitude
          ? record
          : { ...record, latitude: finer.latitude, longitude: finer.longitude };
      known.delete(record.id);
      known.set(record.id, {
        zoom,
        latitude: record.latitude,
        longitude: record.longitude,
      });
      while (known.size > limit) known.delete(known.keys().next().value);
      return record;
    },
    clear: () => known.clear(),
    size: () => known.size,
  };
}

function intersects(box, bounds) {
  return !(
    box.east < bounds.west ||
    box.west > bounds.east ||
    box.north < bounds.south ||
    box.south > bounds.north
  );
}

const ALPR_EXTRACTS = [
  {
    country: 'us',
    // TileJSON bounds are intentionally broad enough to include neighboring
    // border tiles. Keep provider selection geographic so a Washington viewport
    // does not probe Canada's sparse/empty extract and abort valid US results.
    regions: [
      { south: 24, west: -125, north: 49.05, east: -66 },
      { south: 51, west: -170, north: 72, east: -129 },
      { south: 18, west: -161, north: 23, east: -154 },
      { south: 17, west: -68, north: 19, east: -64 },
    ],
  },
  {
    country: 'ca',
    regions: [
      { south: 48.9, west: -141, north: 84, east: -95 },
      { south: 41.6, west: -96, north: 84, east: -52 },
    ],
  },
];

function extractCoversBox(extract, box) {
  return extract.regions.some((region) => intersects(box, region));
}

/** Construct the viewport-bounded OpenStreetMap hourly extract adapter. */
export function createAlprTileSource({
  tileFetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const sources = ALPR_EXTRACTS.map((extract) => ({
    ...extract,
    source: createVectorTileSource({
      tileJsonUrl: `https://tiles.dontgetflocked.com/cameras-${extract.country}-hourly.json`,
      allowedOrigin: 'https://tiles.dontgetflocked.com',
      decode: decodeAlprTile,
      fetchImpl: tileFetchImpl,
      maxTiles: DETAIL_MAX_TILES,
      ttlMs: 60 * 60 * 1000,
      emptyTileStatuses: [404],
      emptyTileValue: () => [],
    }),
  }));
  const precision = createAlprPrecisionCache();
  const precise = precision.apply;
  return {
    /**
     * Read the camera records for every extract tile covering `box`.
     * @param {{south:number, west:number, north:number, east:number}} box View box.
     * @param {AbortSignal} [signal] Cancellation.
     * @returns {Promise<{records: Array<object>, stale: boolean, saturated: boolean,
     *   noCoverage?: boolean, zoomIn?: boolean, coverage?: object, zoom?: number}>}
     *   Records inside the fetched tiles; `coverage` is those tiles' bounds.
     */
    async fetch(box, signal) {
      if (
        !validTileBounds(box) ||
        box.north - box.south >
          MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9 ||
        box.east - box.west >
          MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9
      )
        throw new TypeError('ALPR requires a bounded city viewport');
      signal?.throwIfAborted();
      // Fast geographic rejection; the exact extract extents below refine coverage.
      if (box.east < -180 || box.west > -50 || box.north < 17 || box.south > 84)
        return {
          records: [],
          stale: false,
          saturated: false,
          noCoverage: true,
        };
      const zoom = alprDetailZoom(box);
      if (zoom === null)
        return { records: [], stale: false, saturated: false, zoomIn: true };
      const tiles = tilesForBounds(box, zoom, {
        maxTiles: DETAIL_MAX_TILES + 1,
      });
      const tileBounds = tiles.map((tile) => tileToBBox(zoom, tile.x, tile.y));
      const coverage = {
        south: Math.min(...tileBounds.map((b) => b.south)),
        west: Math.min(...tileBounds.map((b) => b.west)),
        north: Math.max(...tileBounds.map((b) => b.north)),
        east: Math.max(...tileBounds.map((b) => b.east)),
      };
      const records = new Map();
      let covered = false,
        partial = false;
      for (const extract of sources) {
        if (!extractCoversBox(extract, box)) continue;
        const metadata = await extract.source.getMetadata(signal);
        const [west, south, east, north] = metadata.bounds || [];
        if (![west, south, east, north].every(Number.isFinite))
          throw new Error('Camera coverage unavailable');
        if (
          box.east < west ||
          box.west > east ||
          box.north < south ||
          box.south > north
        )
          continue;
        covered = true;
        const result = await extract.source.fetchBounds(box, { zoom, signal });
        partial ||= result.partial;
        for (const record of result.tiles.flat())
          records.set(record.id, precise(record, zoom));
      }
      signal?.throwIfAborted();
      let list = [...records.values()];
      const truncated = list.length > SOURCE_RECORD_LIMIT;
      if (truncated) {
        // Keep the cameras nearest the view centre when a dense metro overflows.
        const lat = (box.south + box.north) / 2;
        const lon = (box.west + box.east) / 2;
        const scale = Math.cos((lat * Math.PI) / 180);
        list = list
          .map((record) => ({
            record,
            d:
              (record.latitude - lat) ** 2 +
              ((record.longitude - lon) * scale) ** 2,
          }))
          .sort((a, b) => a.d - b.d)
          .slice(0, SOURCE_RECORD_LIMIT)
          .map((item) => item.record);
      }
      return {
        records: list,
        stale: false,
        saturated: partial || truncated,
        noCoverage: !covered,
        // A partial or truncated read does not cover its tiles; reuse only the box.
        coverage: partial || truncated ? { ...box } : coverage,
        zoom,
      };
    },
    detailZoom: alprDetailZoom,
    destroy() {
      for (const extract of sources) extract.source.clear();
      precision.clear();
    },
    label: 'OpenStreetMap · community mapped',
    attribution: {
      name: 'OpenStreetMap',
      description: '© OpenStreetMap contributors, ODbL',
      text: '© OpenStreetMap contributors, ODbL',
      href: 'https://www.openstreetmap.org/copyright',
    },
  };
}

/** Construct the bounded OSM request adapter without starting a request. */
export function createOverpassAlprSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function fetchAlprNodes(box, signal) {
    signal?.throwIfAborted();
    if (
      !box ||
      ![box.south, box.west, box.north, box.east].every(Number.isFinite) ||
      box.south < -90 ||
      box.north > 90 ||
      box.west < -180 ||
      box.east > 180 ||
      box.north <= box.south ||
      box.east <= box.west ||
      box.north - box.south >
        MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9 ||
      box.east - box.west > MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9
    ) {
      throw new TypeError('ALPR requires a bounded city viewport');
    }
    const query = buildOverpassQuery(box.south, box.west, box.north, box.east);
    const response = await fetchImpl(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      const message =
        response.status === 429
          ? 'Overpass rate-limited'
          : response.status === 504
            ? 'Overpass timed out'
            : 'Overpass temporarily unavailable';
      throw new Error(message);
    }
    const stale = response.headers.get('x-overpass-cache') === 'STALE';
    const payload = await response.json();
    signal?.throwIfAborted();
    // The shared proxy already rejects query errors. Validate here too so a
    // malformed or partial response never becomes an authoritative empty map.
    if (!Array.isArray(payload?.elements) || payload.remark) {
      throw new Error('Overpass returned an incomplete camera response');
    }
    return {
      records: [
        ...new Map(
          payload.elements
            .slice(0, QUERY_LIMIT)
            .map(normalizeAlprNode)
            .filter(Boolean)
            .map((record) => [record.id, record]),
        ).values(),
      ],
      stale,
      saturated: payload.elements.length >= QUERY_LIMIT,
    };
  }
  return {
    fetch: fetchAlprNodes,
    label: 'OpenStreetMap · community mapped',
    attribution: {
      name: 'OpenStreetMap',
      description: 'OpenStreetMap contributors (ODbL 1.0; community mapped)',
      text: '© OpenStreetMap contributors',
      href: 'https://www.openstreetmap.org/copyright',
    },
  };
}

export { buildOverpassQuery } from './records.js';
