/**
 * The interval → seconds mapping. Every countdown, rollover boundary, slot step
 * and chart span derives from it, so a wrong entry here corrupts all of them at
 * once — and the browser copy drifting from the server copy would corrupt half.
 */
import { describe, it, expect } from 'vitest'
import { INTERVAL_SECS, INTERVALS, intervalSecs, intervalMins, isInterval } from '../../src/intervals.js'
import {
  INTERVAL_SECS as CLIENT_SECS,
  INTERVALS as CLIENT_INTERVALS,
  intervalSecs as clientIntervalSecs,
} from '../../client/lib/intervals.js'

describe('INTERVAL_SECS', () => {
  it('maps every tradable interval to its real length', () => {
    expect(INTERVAL_SECS).toEqual({ '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 })
  })

  it('lists the intervals shortest-first', () => {
    expect(INTERVALS).toEqual(['5m', '15m', '1h', '1d'])
    const secs = INTERVALS.map(i => INTERVAL_SECS[i])
    expect(secs).toEqual([...secs].sort((a, b) => a - b))
  })
})

describe('intervalSecs', () => {
  it('returns the mapped seconds', () => {
    expect(intervalSecs('5m')).toBe(300)
    expect(intervalSecs('15m')).toBe(900)
    expect(intervalSecs('1h')).toBe(3600)
    expect(intervalSecs('1d')).toBe(86400)
  })

  it('falls back to 5m for anything unknown (the old default)', () => {
    for (const v of [undefined, null, '', '4h', 900, {}]) {
      expect(intervalSecs(v)).toBe(300)
    }
  })

  it('intervalMins is the same value in minutes', () => {
    expect(intervalMins('1h')).toBe(60)
    expect(intervalMins('1d')).toBe(1440)
    expect(intervalMins('5m')).toBe(5)
  })

  it('isInterval only accepts the known keys', () => {
    expect(isInterval('1d')).toBe(true)
    expect(isInterval('1w')).toBe(false)
    expect(isInterval(3600)).toBe(false)
  })
})

describe('client/lib/intervals.ts stays in sync with src/intervals.ts', () => {
  it('has identical seconds and ordering', () => {
    expect(CLIENT_SECS).toEqual(INTERVAL_SECS)
    expect(CLIENT_INTERVALS).toEqual(INTERVALS)
  })

  it('resolves the same seconds, including the fallback', () => {
    for (const v of ['5m', '15m', '1h', '1d', 'nonsense', undefined]) {
      expect(clientIntervalSecs(v)).toBe(intervalSecs(v))
    }
  })
})
