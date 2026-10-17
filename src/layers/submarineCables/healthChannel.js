const MAX_WARNINGS = 200;

/**
 * The seam between the navigational-warnings layer and the submarine-cables
 * layer. The warnings layer publishes its cable-related warnings here (and
 * clears them when it turns off); the cables layer subscribes while it is on.
 * Neither layer imports the other.
 *
 * A warning is `{ id, title, issued, activity, excerpt, points:[[lon,lat]],
 * lines:[[[lon,lat]]] }`.
 * @returns {{publish:Function, clear:Function, get:Function, subscribe:Function}}
 */
export function createCableHealthChannel() {
  let warnings = Object.freeze([]);
  const listeners = new Set();
  const channel = {
    publish(next) {
      warnings = Object.freeze(
        Array.isArray(next) ? next.slice(0, MAX_WARNINGS) : [],
      );
      for (const listener of [...listeners]) listener(warnings);
    },
    clear() {
      if (warnings.length) channel.publish([]);
    },
    get: () => warnings,
    /** @returns {Function} Unsubscribe. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return channel;
}
