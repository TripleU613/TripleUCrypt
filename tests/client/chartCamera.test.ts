/**
 * chartCamera — the pure transform logic behind EChart's LINE / PROBABILITY
 * modes (ROADMAP 1.12: the live curve must MOVE, not re-shape).
 *
 * Every test here is really one assertion in different clothes: given data that
 * only drifts, the transform must come back IDENTICAL, because any change to it
 * re-draws history at new coordinates — the "crooked up / crooked down" bug.
 */

import { describe, it, expect } from 'vitest'
import {
  WIN_RUNGS, pickWindowRung, niceRangeUp, quantizeCam, decimateBucketMs,
} from '../../client/lib/chartCamera.js'

describe('pickWindowRung', () => {
  it('starts on the smallest rung for a fresh buffer', () => {
    expect(pickWindowRung(0, null)).toBe(WIN_RUNGS[0])
    expect(pickWindowRung(1500, undefined)).toBe(20000)
  })

  it('holds the rung while the span grows inside it — the span must be constant', () => {
    for (const span of [0, 1000, 9000, 19_999]) {
      expect(pickWindowRung(span, 20000)).toBe(20000)
    }
  })

  it('steps up when the span reaches the current rung', () => {
    expect(pickWindowRung(20000, 20000)).toBe(30000)
    expect(pickWindowRung(30000, 30000)).toBe(45000)
  })

  it('never steps back down (a shrinking span must not re-squeeze the curve)', () => {
    expect(pickWindowRung(0, 60000)).toBe(60000)
    expect(pickWindowRung(1000, 90000)).toBe(90000)
  })

  it('saturates at the top rung — older points scroll off instead of widening', () => {
    const top = WIN_RUNGS[WIN_RUNGS.length - 1]
    expect(pickWindowRung(10 * 60 * 1000, top)).toBe(top)
    expect(pickWindowRung(1e9, null)).toBe(top)
  })

  it('snaps an off-ladder stored value onto the ladder', () => {
    expect(pickWindowRung(0, 21_500)).toBe(30000)
    expect(pickWindowRung(0, 1)).toBe(20000)
  })

  it('is monotone over a whole simulated window', () => {
    let cur: number | null = null
    let prev = 0
    for (let span = 0; span <= 300_000; span += 250) {
      cur = pickWindowRung(span, cur)
      expect(cur).toBeGreaterThanOrEqual(prev)
      expect(WIN_RUNGS).toContain(cur)
      prev = cur
    }
  })
})

describe('niceRangeUp', () => {
  it('returns the smallest ladder value >= v', () => {
    expect(niceRangeUp(1)).toBe(1)
    expect(niceRangeUp(1.2)).toBe(1.5)
    expect(niceRangeUp(6)).toBe(7)
    expect(niceRangeUp(7)).toBe(7)
    expect(niceRangeUp(8)).toBe(10)
    expect(niceRangeUp(430)).toBe(500)
    expect(niceRangeUp(0.0031)).toBeCloseTo(0.005, 10)
  })

  it('is defensive about junk', () => {
    expect(niceRangeUp(0)).toBeGreaterThan(0)
    expect(niceRangeUp(NaN)).toBeGreaterThan(0)
    expect(niceRangeUp(-5)).toBeGreaterThan(0)
  })
})

describe('quantizeCam', () => {
  it('contains the data with visible padding on a fresh fit', () => {
    const c = quantizeCam(59_800, 60_200, null)
    expect(c.lo).toBeLessThanOrEqual(59_800)
    expect(c.hi).toBeGreaterThanOrEqual(60_200)
    const fill = 400 / (c.hi - c.lo)
    expect(fill).toBeLessThanOrEqual(0.6 + 1e-9)
  })

  it('is idempotent — feeding its own output back changes nothing', () => {
    const a = quantizeCam(59_800, 60_200, null)
    const b = quantizeCam(59_800, 60_200, a)
    expect(b).toEqual(a)
  })

  it('HOLDS the band while data drifts inside the deadzone (the whole point)', () => {
    // seed with the same extent the loop feeds, so any movement is real drift
    let cam = quantizeCam(59_960, 60_040, null)
    const first = { ...cam }
    // a price wandering within a fraction of the range must not move the camera
    for (let i = 0; i < 200; i++) {
      const mid = 60_000 + Math.sin(i / 7) * 20
      cam = quantizeCam(mid - 40, mid + 40, cam)
      expect(cam).toEqual(first)
    }
  })

  it('does not move at all for a perfectly flat price (no vertical drift)', () => {
    let cam = quantizeCam(60_000, 60_000, null)
    const first = { ...cam }
    for (let i = 0; i < 500; i++) cam = quantizeCam(60_000, 60_000, cam)
    expect(cam).toEqual(first)
  })

  it('is symmetric: a new low moves the camera as much as an equal new high', () => {
    // The old code used `else if` with a top-anchored deadzone: a new HIGH shoved
    // the whole curve down while an equal new LOW did nothing at all.
    const base = quantizeCam(99, 101, null)
    const range = base.hi - base.lo
    const c0 = (base.lo + base.hi) / 2
    const up = quantizeCam(99, 101 + range, base)
    const dn = quantizeCam(99 - range, 101, base)
    expect(up.hi - up.lo).toBeCloseTo(dn.hi - dn.lo, 9)
    const upShift = (up.lo + up.hi) / 2 - c0
    const dnShift = c0 - (dn.lo + dn.hi) / 2
    expect(upShift).toBeGreaterThan(0)
    expect(dnShift).toBeGreaterThan(0)
    // equal within one center-grid cell (range/8) — the residual is the grid snap
    expect(Math.abs(upShift - dnShift)).toBeLessThanOrEqual((up.hi - up.lo) / 8 + 1e-9)
  })

  it('jumps in discrete steps, and each jump lands somewhere it can rest', () => {
    let cam = quantizeCam(0, 10, null)
    let jumps = 0
    // a steady ramp: the camera must follow in a handful of steps, not per-tick
    for (let i = 0; i < 400; i++) {
      const hi = 10 + i * 0.5
      const next = quantizeCam(0, hi, cam)
      if (next.lo !== cam.lo || next.hi !== cam.hi) {
        jumps++
        // after any jump the data sits inside the band with room to spare
        expect(next.lo).toBeLessThanOrEqual(0)
        expect(next.hi).toBeGreaterThanOrEqual(hi)
        // and the jump is immediately stable — no jitter between two bands
        expect(quantizeCam(0, hi, next)).toEqual(next)
      }
      cam = next
    }
    expect(jumps).toBeGreaterThan(0)
    expect(jumps).toBeLessThan(30)
  })

  it('always contains the data, however the data moves', () => {
    let cam = quantizeCam(49, 51, null)
    let v = 50
    for (let i = 0; i < 2000; i++) {
      v += Math.sin(i / 13) * 3 + Math.cos(i / 5)
      const lo = v - 2, hi = v + 2
      cam = quantizeCam(lo, hi, cam)
      expect(cam.lo).toBeLessThanOrEqual(lo + 1e-9)
      expect(cam.hi).toBeGreaterThanOrEqual(hi - 1e-9)
      expect(cam.hi).toBeGreaterThan(cam.lo)
    }
  })

  it('re-seeds on a drastic change (asset switch scale)', () => {
    const btc = quantizeCam(59_000, 61_000, null)
    const sol = quantizeCam(140, 142, btc)
    expect(sol.lo).toBeLessThanOrEqual(140)
    expect(sol.hi).toBeGreaterThanOrEqual(142)
    expect(sol.hi - sol.lo).toBeLessThan(100)
  })

  describe('with bounds (probability 0–100)', () => {
    const B = { min: 0, max: 100 }

    it('slides the band inside the domain without changing its range', () => {
      const free = quantizeCam(40, 60, null)
      const near0 = quantizeCam(1, 4, null, B)
      const near100 = quantizeCam(96, 99, null, B)
      expect(near0.lo).toBeGreaterThanOrEqual(0)
      expect(near100.hi).toBeLessThanOrEqual(100)
      // a slid band keeps the same quantized range as an unslid one of that size
      expect(near100.hi - near100.lo).toBeCloseTo(near0.hi - near0.lo, 9)
      expect(free.hi).toBeLessThanOrEqual(100)
    })

    it('stays inside the domain and stays still while pinned at an edge', () => {
      let cam = quantizeCam(97, 99, null, B)
      const first = { ...cam }
      for (let i = 0; i < 100; i++) {
        cam = quantizeCam(97 + (i % 3) * 0.5, 99 + (i % 2) * 0.4, cam, B)
        expect(cam.lo).toBeGreaterThanOrEqual(0)
        expect(cam.hi).toBeLessThanOrEqual(100)
      }
      expect(cam).toEqual(first)
    })

    it('falls back to the full domain when the range would exceed it', () => {
      const cam = quantizeCam(2, 98, null, B)
      expect(cam).toEqual({ lo: 0, hi: 100 })
    })
  })
})

describe('decimateBucketMs', () => {
  it('picks a bucket that keeps the point count under the cap', () => {
    expect(90_000 / decimateBucketMs(90_000, 900)).toBeLessThanOrEqual(900)
    expect(90_000 / decimateBucketMs(90_000, 90)).toBeLessThanOrEqual(90)
  })

  it('is constant for a constant span — so survivors do not change per tick', () => {
    const a = decimateBucketMs(60_000, 900)
    for (let i = 0; i < 50; i++) expect(decimateBucketMs(60_000, 900)).toBe(a)
  })

  it('is defensive about junk', () => {
    expect(decimateBucketMs(0, 900)).toBeGreaterThan(0)
    expect(decimateBucketMs(1000, 0)).toBeGreaterThan(0)
  })
})
