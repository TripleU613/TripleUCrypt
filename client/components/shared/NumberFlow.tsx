/**
 * Animated number flip component — @number-flow/react.
 * Ported from TripleUCrypt/animations/number_flow.py
 */

import React from 'react'
import NumberFlow from '@number-flow/react'
import { useStore } from '../../store'
import { MS } from '../../constants/index.js'

// ── Per-tier flip durations (ms) matching TIER_SETTINGS in performance.ts ──────
const FLIP_MS: Record<string, number> = {
  turbo:    MS.FLIP_TURBO,
  smooth:   MS.FLIP_SMOOTH,
  eco:      MS.FLIP_ECO,
  survival: MS.FLIP_SURVIVAL,
}

export function useFlipMs(): number {
  const q = useStore(s => s.ui_quality)
  return FLIP_MS[q] ?? 450
}

const OPACITY_TIMING: EffectTiming = { duration: 200, easing: 'ease-out' }

// ── FlipNumber component ─────────────────────────────────────────────────────

export interface FlipNumberProps {
  value: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  format?: any
  prefix?: string
  suffix?: string
  trend?: number
  className?: string
  transformTiming?: EffectTiming
  spinTiming?: EffectTiming
  opacityTiming?: EffectTiming
  style?: React.CSSProperties
}

export function FlipNumber({
  value,
  format,
  prefix,
  suffix,
  trend = 0,
  className,
  transformTiming,
  spinTiming,
  opacityTiming,
  style,
}: FlipNumberProps): JSX.Element {
  const flipMs = useFlipMs()
  const timing: EffectTiming = { duration: flipMs, easing: 'ease-out' }
  return (
    <NumberFlow
      value={value}
      format={format}
      prefix={prefix}
      suffix={suffix}
      trend={trend as 0 | 1 | -1}
      className={className}
      transformTiming={transformTiming ?? timing}
      spinTiming={spinTiming ?? timing}
      opacityTiming={opacityTiming ?? OPACITY_TIMING}
      style={style}
    />
  )
}
