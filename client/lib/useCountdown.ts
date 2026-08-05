/**
 * useCountdown — time remaining on a trading window, with staleness.
 *
 * TradingBar and MarketSidebar each had their own copy of this (ticking at
 * different rates — 500ms vs 1000ms — with slightly different mm:ss padding and
 * duplicated staleness math), so the two could drift apart. One hook, one
 * definition of "how long is left and is this window stale".
 *
 * The math lives in the pure `computeCountdown()` below so it can be unit-tested
 * without a DOM/React test environment; the hook is just the ticking wrapper.
 */

import { useEffect, useState } from 'react'

export interface Countdown {
  /** Whole seconds until `endTs`, floored at 0. */
  secsLeft: number
  /** No end timestamp, or past the window's end by more than one full interval. */
  stale: boolean
  /** Minutes part, unpadded. */
  mm: string
  /** Seconds part, zero-padded to 2. */
  ss: string
  /** `m:ss`, or '—' when stale. */
  text: string
}

const nowSecs = (): number => Math.floor(Date.now() / 1000)

/**
 * Pure countdown math.
 *
 * @param endTs     window end, unix seconds (0/absent → stale)
 * @param intervalS window length in seconds (300 for 5m, 900 for 15m) — how far
 *                  past `endTs` to tolerate before calling it stale
 * @param now       current time, unix seconds
 */
export function computeCountdown(endTs: number, intervalS: number, now: number): Countdown {
  const secsLeft = Math.max(0, endTs - now)
  // A missing/zero endTs is stale: there is no window to count down to, so
  // callers render a dash rather than a meaningless 0:00.
  const stale = !(endTs > 0) || now > endTs + intervalS
  const mm = String(Math.floor(secsLeft / 60))
  const ss = String(secsLeft % 60).padStart(2, '0')
  return { secsLeft, stale, mm, ss, text: stale ? '—' : `${mm}:${ss}` }
}

/**
 * @param tickMs refresh cadence; 500ms keeps the final second from visibly
 *               lingering, which is why the trade panel uses that rate.
 */
export function useCountdown(endTs: number, intervalS: number, tickMs = 500): Countdown {
  const [now, setNow] = useState(nowSecs)

  useEffect(() => {
    // Re-sync immediately so a changed endTs doesn't briefly show the previous
    // window's remainder until the next tick.
    setNow(nowSecs())
    const id = setInterval(() => setNow(nowSecs()), tickMs)
    return () => clearInterval(id)
  }, [endTs, tickMs])

  return computeCountdown(endTs, intervalS, now)
}
