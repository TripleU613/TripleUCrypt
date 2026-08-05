import { describe, it, expect } from 'vitest'
import { NeedsFundingError, _internal } from '../../src/banking/swap.js'

describe('swap fee-tier selection', () => {
  it('uses the 0.01% pool for USDC ↔ USDC.e', () => {
    expect(_internal.feeFor('USDC_NATIVE', 'USDC_E')).toBe(100)
    expect(_internal.feeFor('USDC_E', 'USDC_NATIVE')).toBe(100)
  })
  it('uses the 0.05% pool for anything ↔ POL', () => {
    expect(_internal.feeFor('USDC_E', 'POL')).toBe(500)
    expect(_internal.feeFor('USDC_NATIVE', 'POL')).toBe(500)
    expect(_internal.feeFor('POL', 'USDC_E')).toBe(500)
  })
})

describe('swap token mapping', () => {
  it('maps POL to wrapped POL (18 decimals, native)', () => {
    expect(_internal.decimalsOf('POL')).toBe(18)
    expect(_internal.decimalsOf('USDC_NATIVE')).toBe(6)
    expect(_internal.isNative('POL')).toBe(true)
    expect(_internal.isNative('USDC_E')).toBe(false)
  })
})

describe('NeedsFundingError', () => {
  it('is a named Error subclass', () => {
    const e = new NeedsFundingError()
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('NeedsFundingError')
  })
})
