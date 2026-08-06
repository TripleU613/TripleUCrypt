import { describe, it, expect } from 'vitest'
import {
  computeWindowTimeStr, computeMarketsReady, computeTimeSlots, pickActiveWindow,
} from '../../src/engine/windows.js'

describe('computeWindowTimeStr', () => {
  it('formats seconds correctly', () => {
    expect(computeWindowTimeStr(90)).toBe('1:30')
    expect(computeWindowTimeStr(65)).toBe('1:05')
    expect(computeWindowTimeStr(0)).toBe('—')
    expect(computeWindowTimeStr(-1)).toBe('—')
    expect(computeWindowTimeStr(59)).toBe('0:59')
  })

  it('adds an hours field for the long windows instead of 1439 minutes', () => {
    expect(computeWindowTimeStr(3600)).toBe('1:00:00')
    expect(computeWindowTimeStr(3661)).toBe('1:01:01')
    expect(computeWindowTimeStr(86399)).toBe('23:59:59')
    expect(computeWindowTimeStr(3599)).toBe('59:59')
  })
})

describe('computeTimeSlots', () => {
  const END = 1_800_000_000

  it('steps the slot strip by the window\'s own interval', () => {
    for (const [interval, step] of [['5m', 300], ['15m', 900], ['1h', 3600], ['1d', 86400]] as const) {
      const slots = computeTimeSlots([{ end_ts: END, interval }], 0, '', {}, END)
      expect(slots).toHaveLength(5)
      expect(slots[2].ts).toBe(END - step)                 // current slot starts one step back
      expect(slots[3].ts - slots[2].ts).toBe(step)
    }
  })
})

describe('pickActiveWindow', () => {
  const wins = [
    { slug: 'btc-updown-5m', interval: '5m', up_token: 'a' },
    { slug: 'btc-up-or-down-hourly', interval: '1h', up_token: 'b' },
    { slug: 'eth-up-or-down-daily', interval: '1d', up_token: '' },   // no live window
  ]

  it('re-resolves the selection by slug, since the array is rebuilt every poll', () => {
    expect(pickActiveWindow(wins, 'btc-up-or-down-hourly', '5m').idx).toBe(1)
  })

  it('falls back to the first tradable window of the selected interval', () => {
    expect(pickActiveWindow(wins, 'gone', '1h').idx).toBe(1)
  })

  it('falls back to index 0 when the interval has no tradable window', () => {
    expect(pickActiveWindow(wins, '', '1d').idx).toBe(0)
    expect(pickActiveWindow([], '', '5m').idx).toBe(0)
  })
})

describe('computeMarketsReady', () => {
  it('returns false for empty windows', () => {
    expect(computeMarketsReady([], {})).toBe(false)
  })

  it('returns true when windows and asks are present', () => {
    const windows = [{ up_token: 'abc', dn_token: 'def' }]
    const asks = { abc: 0.5, def: 0.5 }
    expect(computeMarketsReady(windows, asks)).toBe(true)
  })
})
