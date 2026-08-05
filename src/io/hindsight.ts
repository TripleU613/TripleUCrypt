/**
 * In-memory rolling 24-hour store of resolved windows.
 * Mirrors TripleUCrypt/io/hindsight.py exactly.
 */

const _DAY_SECS = 24 * 60 * 60;

/** Key: "asset:interval:start_ts" */
const _STORE = new Map<string, unknown>();

function _key(asset: string, interval: string, startTs: number | string): string {
  return `${asset}:${interval}:${Math.trunc(Number(startTs))}`;
}

/** Drop entries older than 24 hours. */
function _prune(now?: number): void {
  const cutoff = (now ?? Math.trunc(Date.now() / 1000)) - _DAY_SECS;
  for (const k of _STORE.keys()) {
    try {
      const parts = k.split(":");
      const ts = parseInt(parts[parts.length - 1], 10);
      if (ts < cutoff) {
        _STORE.delete(k);
      }
    } catch {
      // skip malformed keys
    }
  }
}

/**
 * Store a frozen window snapshot. Idempotent — does nothing if startTs is
 * falsy. Prunes entries older than 24h after inserting.
 */
export function put(
  asset: string,
  interval: string,
  startTs: number | string,
  snap: unknown,
): void {
  if (!startTs) return;
  _STORE.set(_key(asset, interval, startTs), snap);
  _prune();
}

/**
 * Return the stored snapshot or undefined.
 */
export function get(
  asset: string,
  interval: string,
  startTs: number | string,
): unknown | undefined {
  try {
    return _STORE.get(_key(asset, interval, startTs));
  } catch {
    return undefined;
  }
}

/**
 * Return true if a snapshot exists for this key.
 */
export function has(
  asset: string,
  interval: string,
  startTs: number | string,
): boolean {
  try {
    return _STORE.has(_key(asset, interval, startTs));
  } catch {
    return false;
  }
}
