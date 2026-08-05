import { describe, it, expect } from 'vitest'
import { computeWindowTimeStr, computeMarketsReady } from '../../src/engine/windows.js'

describe('computeWindowTimeStr', () => {
  it('formats seconds correctly', () => {
    expect(computeWindowTimeStr(90)).toBe('1:30')
    expect(computeWindowTimeStr(65)).toBe('1:05')
    expect(computeWindowTimeStr(0)).toBe('—')
    expect(computeWindowTimeStr(-1)).toBe('—')
    expect(computeWindowTimeStr(59)).toBe('0:59')
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
