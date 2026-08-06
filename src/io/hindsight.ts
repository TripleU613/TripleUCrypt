/**
 * In-memory rolling 24-hour store of resolved windows.
 * Mirrors TripleUCrypt/io/hindsight.py exactly.
 */

import { intervalSecs } from "../intervals.js";

/** How long a resolved window stays replayable AFTER it ends. */
const _RETAIN_SECS = 24 * 60 * 60;

/** Key: "asset:interval:start_ts" */
const _STORE = new Map<string, unknown>();

function _key(asset: string, interval: string, startTs: number | string): string {
  return `${asset}:${interval}:${Math.trunc(Number(startTs))}`;
}

/**
 * Drop entries whose window ENDED more than _RETAIN_SECS ago.
 *
 * Retention is measured from the window's end, not its start. The key holds the
 * START ts, so pruning on that directly meant a window was judged by when it
 * OPENED — which is fine at 5m but fatal at 1d: a 1-day window starts 86400s
 * before it ends, so a just-resolved daily window was already "older than 24h"
 * and put() deleted it on the very call that inserted it. Daily hindsight replay
 * could therefore never work.
 */
function _prune(now?: number): void {
  const nowS = now ?? Math.trunc(Date.now() / 1000);
  for (const k of _STORE.keys()) {
    try {
      const parts = k.split(":");
      const startTs = parseInt(parts[parts.length - 1], 10);
      if (!Number.isFinite(startTs)) continue;
      // parts = [asset, interval, startTs]
      const endTs = startTs + intervalSecs(parts[1] ?? "");
      if (endTs < nowS - _RETAIN_SECS) {
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
