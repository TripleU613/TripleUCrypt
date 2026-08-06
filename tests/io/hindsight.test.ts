/**
 * hindsight retention.
 *
 * Regression cover for a bug found when 1h/1d windows were added: the store keys
 * entries by window START, and retention was measured against that start. At 5m
 * that is harmless, but a 1-day window starts 86400s before it ends — so a
 * just-resolved daily window was already "older than 24h" and put() deleted it on
 * the very call that inserted it. Daily hindsight replay could never work.
 *
 * Retention is now measured from the window's END.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { put, get, has } from '../../src/io/hindsight.js'

const HOUR = 3600
const DAY = 86400

// A fixed "now" so the assertions are about retention, not wall-clock timing.
const NOW = 1_800_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW * 1000)
})

describe('hindsight retention', () => {
  it('keeps a 1d window that JUST resolved (the original bug)', () => {
    // Started a day ago, ended right now.
    put('BTC', '1d', NOW - DAY, { snap: 'daily' })
    expect(has('BTC', '1d', NOW - DAY)).toBe(true)
    expect(get('BTC', '1d', NOW - DAY)).toEqual({ snap: 'daily' })
  })

  it('keeps a 1d window that resolved a few hours ago', () => {
    // Under start-based retention this was ~27h "old" and pruned instantly.
    const start = NOW - DAY - 3 * HOUR
    put('BTC', '1d', start, { snap: 'yesterday' })
    expect(has('BTC', '1d', start)).toBe(true)
  })

  it('still keeps a fresh 5m window', () => {
    put('ETH', '5m', NOW - 300, { snap: '5m' })
    expect(has('ETH', '5m', NOW - 300)).toBe(true)
  })

  it('drops a 5m window whose end is well past the retention horizon', () => {
    // Ended ~25h ago.
    const start = NOW - DAY - 3600
    put('ETH', '5m', start, { snap: 'stale' })
    // put() prunes after inserting, so a too-old entry never survives the call.
    expect(has('ETH', '5m', start)).toBe(false)
  })

  it('drops a 1d window only once its END is past the horizon', () => {
    // Ended just inside the window: start = now - DAY - DAY + 1  =>  end = now - DAY + 1
    const keep = NOW - 2 * DAY + 1
    put('XRP', '1d', keep, { snap: 'edge-keep' })
    expect(has('XRP', '1d', keep)).toBe(true)

    // Ended an hour beyond the horizon.
    const drop = NOW - 2 * DAY - HOUR
    put('XRP', '1d', drop, { snap: 'edge-drop' })
    expect(has('XRP', '1d', drop)).toBe(false)
  })

  it('retains longer intervals for longer, in wall-clock terms', () => {
    // Same START for both. The 1d entry ends a day later than the 5m one, so it
    // must outlive it — this is precisely the asymmetry the old code ignored.
    const start = NOW - DAY - 1800
    put('BNB', '5m', start, { snap: 'short' })
    put('BNB', '1d', start, { snap: 'long' })
    expect(has('BNB', '5m', start)).toBe(false)
    expect(has('BNB', '1d', start)).toBe(true)
  })

  it('ignores a falsy startTs rather than storing a bogus key', () => {
    put('SOL', '5m', 0, { snap: 'nope' })
    expect(has('SOL', '5m', 0)).toBe(false)
  })
})
