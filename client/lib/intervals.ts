// Browser twin of src/intervals.ts — the one place that knows how long a trading
// window is. Duplicated rather than imported because the client can't reach into
// src/ (tsconfig.server.json roots at src/, and the browser bundle must stay free
// of server imports — same reason client/lib/compute.ts exists). Keep in sync.

export const INTERVAL_SECS = {
  '5m':  300,
  '15m': 900,
  '1h':  3600,
  '1d':  86400,
} as const

export type Interval = keyof typeof INTERVAL_SECS

/** Selector order, shortest first — drives the LeftDock timeframe bar. */
export const INTERVALS: Interval[] = ['5m', '15m', '1h', '1d']

export function isInterval(v: unknown): v is Interval {
  return typeof v === 'string' && v in INTERVAL_SECS
}

/** Window length in seconds; unknown/absent interval → 5m (the old default). */
export function intervalSecs(interval: unknown): number {
  return isInterval(interval) ? INTERVAL_SECS[interval] : INTERVAL_SECS['5m']
}
