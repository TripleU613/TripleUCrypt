/**
 * reconcileHolding — "a penny went missing" guard.
 *
 * The buy path used to report a fill straight from the CLOB response and never
 * check the position book agreed. A fill that is reported but never materialises
 * showed a success toast over nothing. These tests pin the behaviour that
 * catches it, including the cases where it must NOT cry wolf (position indexing
 * legitimately lags a fill by a second or two).
 */

import { describe, it, expect, vi } from 'vitest'
import {
  reconcileHolding, describeMismatch,
  reconcileReduction, describeReductionMismatch,
} from '../../src/engine/reconcile.js'

/** No real waiting. */
const nosleep = async (): Promise<void> => {}
const DELAYS = [10, 20, 30]

describe('reconcileHolding', () => {
  it('confirms immediately when the holding is already there', async () => {
    const read = vi.fn().mockResolvedValue(12.34)
    const r = await reconcileHolding({ expected: 12.34, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(1)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('tolerates indexing lag — confirms on a later attempt without warning', async () => {
    // Position shows up only on the third look. This is the NORMAL case and must
    // not be reported as a mismatch.
    const read = vi.fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(10)
    const r = await reconcileHolding({ expected: 10, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(3)
  })

  it('FAILS when the position never appears (the money-missing case)', async () => {
    const read = vi.fn().mockResolvedValue(0)
    const r = await reconcileHolding({ expected: 10, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(false)
    expect(r.observed).toBe(0)
    expect(r.unreadable).toBe(false)
    expect(r.attempts).toBe(3)
  })

  it('FAILS when the position is short of what was reported', async () => {
    // Reported 10 filled, only 4 ever showed up.
    const read = vi.fn().mockResolvedValue(4)
    const r = await reconcileHolding({ expected: 10, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(false)
    expect(r.observed).toBe(4)
    expect(describeMismatch(r)).toContain('10.00')
    expect(describeMismatch(r)).toContain('4.00')
  })

  it('accepts a holding LARGER than the fill (pre-existing position adds)', async () => {
    // Absolute check, not differential: already held 90, bought 10 -> 100.
    const read = vi.fn().mockResolvedValue(100)
    const r = await reconcileHolding({ expected: 10, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(true)
  })

  it('allows float dust rather than flagging a rounding difference', async () => {
    const read = vi.fn().mockResolvedValue(9.9999)
    const r = await reconcileHolding({ expected: 10, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(true)
  })

  it('distinguishes UNREADABLE from short — different problems', async () => {
    const read = vi.fn().mockResolvedValue(null)
    const r = await reconcileHolding({ expected: 10, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(false)
    expect(r.unreadable).toBe(true)
    expect(r.observed).toBeNull()
    expect(describeMismatch(r)).toMatch(/could not be verified/i)
  })

  it('treats a throwing reader as unreadable, never propagating the error', async () => {
    const read = vi.fn().mockRejectedValue(new Error('rpc down'))
    const r = await reconcileHolding({ expected: 10, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(false)
    expect(r.unreadable).toBe(true)
  })

  it('recovers if a later read succeeds after an earlier throw', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValueOnce(10)
    const r = await reconcileHolding({ expected: 10, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(true)
    expect(r.unreadable).toBe(false)
  })

  it('reports the BEST holding seen, not merely the last', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(3)   // transient bad read
      .mockResolvedValueOnce(3)
    const r = await reconcileHolding({ expected: 10, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(false)
    expect(r.observed).toBe(7)
  })

  it('short-circuits a zero-size fill (nothing to prove)', async () => {
    const read = vi.fn()
    const r = await reconcileHolding({ expected: 0, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(true)
    expect(read).not.toHaveBeenCalled()
  })

  it('waits before the first look (indexing lag), never reads instantly', async () => {
    const order: string[] = []
    const r = await reconcileHolding({
      expected: 5,
      readHeld: async () => { order.push('read'); return 5 },
      delaysMs: [10],
      sleep: async () => { order.push('sleep') },
    })
    expect(r.ok).toBe(true)
    expect(order).toEqual(['sleep', 'read'])
  })

  it('never exceeds the configured attempt budget', async () => {
    const read = vi.fn().mockResolvedValue(0)
    await reconcileHolding({ expected: 10, readHeld: read, delaysMs: [1, 2], sleep: nosleep })
    expect(read).toHaveBeenCalledTimes(2)
  })
})

// ── Sell side ────────────────────────────────────────────────────────────────
// A sell that reports filled but leaves the shares in place is the dangerous
// direction: the user believes they are out and stop watching, while still
// exposed into resolution.

describe('reconcileReduction', () => {
  it('confirms a full exit (holding reaches zero)', async () => {
    const read = vi.fn().mockResolvedValue(0)
    const r = await reconcileReduction({ heldBefore: 10, sold: 10, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(1)
  })

  it('confirms a partial exit down to the expected remainder', async () => {
    // Held 10, sold 4 -> at most 6 should remain.
    const read = vi.fn().mockResolvedValue(6)
    const r = await reconcileReduction({ heldBefore: 10, sold: 4, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(true)
    expect(r.expected).toBe(6)
  })

  it('FAILS when the shares never left (still fully exposed)', async () => {
    const read = vi.fn().mockResolvedValue(10)
    const r = await reconcileReduction({ heldBefore: 10, sold: 10, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(false)
    expect(r.observed).toBe(10)
    expect(describeReductionMismatch(r)).toMatch(/still held|still be exposed/i)
  })

  it('FAILS when only part of the reported sale actually left', async () => {
    // Reported selling all 10, but 7 are still there.
    const read = vi.fn().mockResolvedValue(7)
    const r = await reconcileReduction({ heldBefore: 10, sold: 10, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(false)
    expect(r.observed).toBe(7)
  })

  it('tolerates settlement lag — confirms on a later attempt', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(10)   // not indexed yet
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(0)
    const r = await reconcileReduction({ heldBefore: 10, sold: 10, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(3)
  })

  it('accepts a holding BELOW target (something else also sold)', async () => {
    const read = vi.fn().mockResolvedValue(2)
    const r = await reconcileReduction({ heldBefore: 10, sold: 4, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(true)
  })

  it('reports the LOWEST holding seen (closest to settled)', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(9)
    const r = await reconcileReduction({ heldBefore: 10, sold: 10, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(false)
    expect(r.observed).toBe(8)
  })

  it('distinguishes unreadable positions from shares not leaving', async () => {
    const read = vi.fn().mockResolvedValue(null)
    const r = await reconcileReduction({ heldBefore: 10, sold: 10, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(false)
    expect(r.unreadable).toBe(true)
    expect(describeReductionMismatch(r)).toMatch(/could not be verified/i)
  })

  it('short-circuits a zero-size sell', async () => {
    const read = vi.fn()
    const r = await reconcileReduction({ heldBefore: 10, sold: 0, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.ok).toBe(true)
    expect(read).not.toHaveBeenCalled()
  })

  it('never expects a negative remainder', async () => {
    // Oversized sold value (shouldn't happen post-clamp, but must not go negative).
    const read = vi.fn().mockResolvedValue(0)
    const r = await reconcileReduction({ heldBefore: 5, sold: 50, readHeld: read, delaysMs: DELAYS, sleep: nosleep })
    expect(r.expected).toBe(0)
    expect(r.ok).toBe(true)
  })
})
