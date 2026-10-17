import { coalesceProxyRequest } from './http.js';

export const GEV_USER_AGENT = 'GodsEyeView/0.2 (+local)';

const DAY = 24 * 3600_000;

/**
 * Fixed-origin JSON route with an in-memory TTL cache, request coalescing, an
 * upstream deadline and STALE-on-failure.
 *
 * `load({ signal, now, previous })` acquires one complete snapshot object (it
 * owns upstream URLs, byte caps and parsing) and throws when nothing usable
 * could be acquired. A failure serves the last good body as STALE and backs
 * off for `failureCooldownMs` (or the thrown error's `cooldownMs`), so a struggling upstream is not hammered by
 * every poll. With nothing cached the failure is relayed as 502.
 *
 * @param {object} options
 * @param {string} options.name Plugin name.
 * @param {string} options.route Mount path, e.g. `/api/natural-events`.
 * @param {number} options.ttlMs Fresh-cache lifetime.
 * @param {Function} options.load Snapshot acquisition.
 * @param {number} [options.timeoutMs] Whole-refresh deadline.
 * @param {number} [options.failureCooldownMs] Backoff after a failed refresh.
 * @param {number} [options.maxStaleMs] Oldest body still served as STALE.
 * @param {Function} [options.now] Clock.
 * @returns {{name:string, configureServer:Function, configurePreviewServer:Function}}
 */
export function createCachedJsonRoute({
  name,
  route,
  ttlMs,
  load,
  timeoutMs = 25_000,
  failureCooldownMs = 15_000,
  maxStaleMs = DAY,
  now = () => Date.now(),
}) {
  let entry = null;
  let cooldownUntil = -Infinity;
  const inFlight = new Map();

  function body(snapshot, stale) {
    return JSON.stringify({
      schemaVersion: 1,
      fetchedAt: snapshot.at,
      stale,
      ...snapshot.value,
    });
  }
  const usableStale = () => entry && now() - entry.at <= maxStaleMs;

  async function refresh() {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`${name}_timeout`)),
      timeoutMs,
    );
    try {
      const value = await load({
        signal: controller.signal,
        now,
        previous: entry?.value ?? null,
      });
      controller.signal.throwIfAborted();
      entry = { value, at: now() };
      cooldownUntil = -Infinity;
      return entry;
    } finally {
      clearTimeout(timer);
    }
  }

  /** @returns {Promise<{snapshot:object, stale:boolean, cache:string}>} */
  async function acquire() {
    if (entry && now() - entry.at < ttlMs)
      return { snapshot: entry, stale: false, cache: 'HIT' };
    if (now() < cooldownUntil) {
      if (usableStale())
        return { snapshot: entry, stale: true, cache: 'STALE' };
      throw new Error(`${name}_retry_later`);
    }
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'snapshot', refresh);
      return { snapshot: await promise, stale: false, cache: 'MISS' };
    } catch (error) {
      // A load may name its own backoff (e.g. an upstream Retry-After).
      cooldownUntil =
        now() +
        (Number.isFinite(error?.cooldownMs)
          ? error.cooldownMs
          : failureCooldownMs);
      console.warn(`[${name}] refresh failed: ${error?.message || error}`);
      if (usableStale())
        return { snapshot: entry, stale: true, cache: 'STALE' };
      throw error;
    }
  }

  async function handler(req, res) {
    const send = (status, text, cache) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Feed-Cache': cache,
      });
      res.end(text);
    };
    if (req.method !== 'GET')
      return send(405, JSON.stringify({ error: 'method_not_allowed' }), 'NONE');
    if (req.url !== '/' && req.url !== '')
      return send(
        400,
        JSON.stringify({ error: `invalid_${name}_query` }),
        'NONE',
      );
    try {
      const result = await acquire();
      send(200, body(result.snapshot, result.stale), result.cache);
    } catch {
      send(502, JSON.stringify({ error: `${name}_unavailable` }), 'NONE');
    }
  }

  // No return value: Vite treats a returned function as a post-middleware hook.
  const install = ({ middlewares }) => {
    middlewares.use(route, handler);
  };
  return {
    name,
    configureServer: install,
    configurePreviewServer: install,
  };
}

/** One bounded upstream GET; returns the Response only when it is OK. */
export async function fetchUpstream(fetchImpl, url, { signal, accept }) {
  signal?.throwIfAborted();
  const response = await fetchImpl(url, {
    signal,
    redirect: 'error',
    headers: { Accept: accept, 'User-Agent': GEV_USER_AGENT },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error(`upstream_http_${response.status}`), {
      status: response.status,
      response,
    });
  }
  return response;
}
