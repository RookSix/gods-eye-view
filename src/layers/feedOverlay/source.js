import { readResponseJsonCapped } from '../../sources/httpBody.js';

export const FEED_RESPONSE_LIMIT = 8 * 1024 * 1024;

/**
 * Lazy same-origin acquisition of one provider route. The source owns only its
 * deadline, byte cap and cancellation; `validate` owns the response contract
 * and must throw on anything it will not draw.
 * @param {object} options
 * @param {string} options.url Same-origin route.
 * @param {string} options.label Name used in error text.
 * @param {(payload:object)=>object} options.validate Snapshot validator.
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.fetchImpl]
 * @returns {{getSnapshot:(options?:{signal?:AbortSignal})=>Promise<object>}}
 */
export function createFeedSource({
  url,
  label,
  validate,
  timeoutMs = 20_000,
  limit = FEED_RESPONSE_LIMIT,
  fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error(`${label} request timed out`)),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(url, {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`${label} HTTP ${response.status}`);
        }
        const payload = await readResponseJsonCapped(
          response,
          limit,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        return validate(payload);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}

const malformed = (label) => new Error(`Malformed ${label} snapshot`);

/** Shared envelope checks; returns the fields every provider route emits. */
export function validateEnvelope(payload, label, { records = true } = {}) {
  if (
    !payload ||
    payload.schemaVersion !== 1 ||
    typeof payload.stale !== 'boolean' ||
    (records && !Array.isArray(payload.records))
  )
    throw malformed(label);
  return {
    source: String(payload.source || '').slice(0, 80),
    attribution: String(payload.attribution || '').slice(0, 240),
    fetchedAt: Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : null,
    stale: payload.stale,
    sources:
      payload.sources && typeof payload.sources === 'object'
        ? Object.fromEntries(
            Object.entries(payload.sources)
              .slice(0, 8)
              .map(([key, value]) => [
                String(key).slice(0, 16),
                {
                  ok: value?.ok === true,
                  count: Number.isFinite(value?.count) ? value.count : 0,
                  stale: value?.stale === true,
                  skipped:
                    typeof value?.skipped === 'string' ? value.skipped : null,
                },
              ]),
          )
        : {},
  };
}

/** Accept a finite coordinate pair or fail the whole snapshot. */
export function validCoordinate(lon, lat, label) {
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    Math.abs(lon) > 180 ||
    Math.abs(lat) > 90
  )
    throw malformed(label);
}

/** A bounded printable string or null. */
export function boundedText(value, max = 200) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

/** An https URL string or null; never any other scheme. */
export function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 400) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
