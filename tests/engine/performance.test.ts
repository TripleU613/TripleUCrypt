import { describe, it, expect, beforeEach } from 'vitest'
import { TIER_SETTINGS, reportFps, currentTier } from '../../src/engine/performance.js'
import { PowerTier } from '../../src/types.js'

describe('TIER_SETTINGS', () => {
  it('has correct entries for all 4 tiers', () => {
    expect(TIER_SETTINGS.size).toBe(4)
    expect(TIER_SETTINGS.has(PowerTier.TURBO)).toBe(true)
    expect(TIER_SETTINGS.has(PowerTier.SMOOTH)).toBe(true)
    expect(TIER_SETTINGS.has(PowerTier.ECO)).toBe(true)
    expect(TIER_SETTINGS.has(PowerTier.SURVIVAL)).toBe(true)
  })

  // Tightened when the browser's direct market sockets were removed: fast_ms is
  // now the only path a price tick has to the screen.
  it('TURBO has fast_ms=120', () => {
    expect(TIER_SETTINGS.get(PowerTier.TURBO)!.fast_ms).toBe(120)
  })

  it('SMOOTH has fast_ms=150', () => {
    expect(TIER_SETTINGS.get(PowerTier.SMOOTH)!.fast_ms).toBe(150)
  })

  it('SURVIVAL has fast_ms=1000', () => {
    expect(TIER_SETTINGS.get(PowerTier.SURVIVAL)!.fast_ms).toBe(1000)
  })
})

describe('reportFps', () => {
  it('fps < 30 immediately sets tier to SURVIVAL', () => {
    reportFps(25)
    expect(currentTier()).toBe(PowerTier.SURVIVAL)
  })

  it('fps < 45 immediately sets tier to ECO', () => {
    reportFps(40)
    expect(currentTier()).toBe(PowerTier.ECO)
  })
})
