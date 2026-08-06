/**
 * The one place that knows how long a trading window is.
 *
 * Every countdown, rollover boundary, slot step, chart span and history walk is
 * derived from these seconds. It used to be spelled `interval === '15m' ? 900 :
 * 300` in a dozen files, which silently corrupted all of them the moment a third
 * interval existed — so any new interval must be added HERE and nowhere else.
 *
 * client/lib/intervals.ts is the browser twin of this module (the client cannot
 * import from src/ — tsconfig.server.json roots at src/). Keep them in sync.
 */

export const INTERVAL_SECS = {
  "5m":  300,
  "15m": 900,
  "1h":  3600,
  "1d":  86400,
} as const;

export type Interval = keyof typeof INTERVAL_SECS;

/** Display/selector order, shortest first. */
export const INTERVALS: Interval[] = ["5m", "15m", "1h", "1d"];

export function isInterval(v: unknown): v is Interval {
  return typeof v === "string" && v in INTERVAL_SECS;
}

/**
 * Window length in seconds. Unknown/absent intervals fall back to 5m — the same
 * default every call site used before this module existed.
 */
export function intervalSecs(interval: unknown): number {
  return isInterval(interval) ? INTERVAL_SECS[interval] : INTERVAL_SECS["5m"];
}

/** Window length in whole minutes (fetchWindowHistory's step unit). */
export function intervalMins(interval: unknown): number {
  return intervalSecs(interval) / 60;
}
