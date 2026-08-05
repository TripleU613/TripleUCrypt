import { describe, it, expect } from 'vitest'
import { computeClaimablePositions, posComputed } from '../../src/engine/positions.js'

describe('computeClaimablePositions', () => {
  it('returns empty for empty positions', () => {
    expect(computeClaimablePositions([])).toEqual([])
  })

  it('filters to only resolved winning positions', () => {
    const positions = [
      { resolved: true, redeemable: true, shares: 10, outcome: 'UP' },
      { resolved: false, redeemable: false, shares: 10, outcome: 'UP' },
      { resolved: true, redeemable: false, shares: 10, outcome: 'UP' },
    ]
    const claimable = computeClaimablePositions(positions as Record<string, unknown>[])
    expect(claimable.length).toBe(1)
  })
})

describe('posComputed', () => {
  it('marks dust positions', () => {
    const pos = { shares: 1e-5, token_id: 'abc' }
    const result = posComputed(pos as Record<string, unknown>, 0.5)
    expect(result.dust).toBe(true)
  })

  it('normal position is not dust', () => {
    const pos = { shares: 1, token_id: 'abc' }
    const result = posComputed(pos as Record<string, unknown>, 0.5)
    expect(result.dust).toBe(false)
  })
})
