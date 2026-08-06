/**
 * computeCountdown — the shared window-countdown math previously duplicated in
 * TradingBar.tsx and MarketSidebar.tsx (at different tick rates, with slightly
 * different formatting). Pure, so it's testable without a DOM environment.
 */

import { describe, it, expect } from 'vitest'
import { computeCountdown } from '../../client/lib/useCountdown.js'

const FIVE_MIN = 300
const NOW = 1_700_000_000

describe('computeCountdown', () => {
  it('formats remaining time as m:ss', () => {
    const c = computeCountdown(NOW + 125, FIVE_MIN, NOW)   // 2m05s
    expect(c.secsLeft).toBe(125)
    expect(c.mm).toBe('2')
    expect(c.ss).toBe('05')
    expect(c.text).toBe('2:05')
    expect(c.stale).toBe(false)
  })

  it('zero-pads seconds but not minutes', () => {
    expect(computeCountdown(NOW + 61, FIVE_MIN, NOW).text).toBe('1:01')
    expect(computeCountdown(NOW + 600, FIVE_MIN, NOW).text).toBe('10:00')
    expect(computeCountdown(NOW + 9, FIVE_MIN, NOW).text).toBe('0:09')
  })

  it('floors at 0:00 at the moment the window ends (never negative)', () => {
    const at = computeCountdown(NOW, FIVE_MIN, NOW)
    expect(at.secsLeft).toBe(0)
    expect(at.text).toBe('0:00')
    expect(at.stale).toBe(false)   // ended, but not yet stale
  })

  it('stays 0:00 (not negative) just past the end, before the stale cutoff', () => {
    const c = computeCountdown(NOW - 10, FIVE_MIN, NOW)
    expect(c.secsLeft).toBe(0)
    expect(c.text).toBe('0:00')
    expect(c.stale).toBe(false)
  })

  it('goes stale only after a full interval past the end', () => {
    // Exactly at the cutoff — not yet stale.
    expect(computeCountdown(NOW - FIVE_MIN, FIVE_MIN, NOW).stale).toBe(false)
    // One second past it — stale.
    expect(computeCountdown(NOW - FIVE_MIN - 1, FIVE_MIN, NOW).stale).toBe(true)
    expect(computeCountdown(NOW - FIVE_MIN - 1, FIVE_MIN, NOW).text).toBe('—')
  })

  it('grows an hours field for the 1h/1d windows', () => {
    const c = computeCountdown(NOW + 3661, 3600, NOW)        // 1h01m01s
    expect(c.hh).toBe('1')
    expect(c.mm).toBe('01')                                   // padded once hours show
    expect(c.ss).toBe('01')
    expect(c.text).toBe('1:01:01')
  })

  it('counts a whole day down without overflowing into minutes', () => {
    const DAY = 86400
    expect(computeCountdown(NOW + DAY, DAY, NOW).text).toBe('24:00:00')
    expect(computeCountdown(NOW + 3600, DAY, NOW).text).toBe('1:00:00')
    // One second under the hour drops back to m:ss — no stray '0:' prefix.
    const c = computeCountdown(NOW + 3599, DAY, NOW)
    expect(c.hh).toBe('0')
    expect(c.text).toBe('59:59')
  })

  it('goes stale a full day past the end of a 1d window', () => {
    const DAY = 86400
    expect(computeCountdown(NOW - DAY, DAY, NOW).stale).toBe(false)
    expect(computeCountdown(NOW - DAY - 1, DAY, NOW).stale).toBe(true)
  })

  it('honours a 15m interval for the stale cutoff', () => {
    const FIFTEEN = 900
    expect(computeCountdown(NOW - 600, FIFTEEN, NOW).stale).toBe(false)  // within 15m
    expect(computeCountdown(NOW - 901, FIFTEEN, NOW).stale).toBe(true)
  })

  it('treats a missing/zero end timestamp as stale (renders a dash, not 0:00)', () => {
    for (const endTs of [0, -1, Number.NaN]) {
      const c = computeCountdown(endTs, FIVE_MIN, NOW)
      expect(c.stale, `endTs=${endTs} must be stale`).toBe(true)
      expect(c.text).toBe('—')
    }
  })
})
