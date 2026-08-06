/**
 * Live price + delta component, fed from the store's Chainlink price.
 * Ported from TripleUCrypt/ui/shared/live_price.py
 *
 * kind="value" → the current price ("$67,432.10"), colored green/red vs open.
 * kind="delta" → the signed delta from open ("+$124.50" / "-$3.20").
 *
 * The price used to come from a browser socket to Polymarket's RTDS. The server
 * runs that socket now and patches state.cl_price — which it only does for the
 * chart asset, hence the asset check below.
 */

import { useEffect, useRef, useState } from 'react'
import NumberFlow from '@number-flow/react'
import { useStore } from '../../store'
import { C } from '../../constants/index.js'

interface LivePriceProps {
  kind: 'value' | 'delta'
  asset: string
  openPrice: number
  /** Price shown until the stream produces a tick for this asset */
  seed?: number
  upColor?: string
  downColor?: string
  dimColor?: string
}

export function LivePrice({
  kind,
  asset,
  openPrice,
  seed = 0,
  upColor = C.GREEN,
  downColor = C.RED,
  dimColor = 'var(--tc-dim2)',
}: LivePriceProps): JSX.Element {
  const openRef = useRef(openPrice)
  useEffect(() => { openRef.current = openPrice }, [openPrice])

  // SSR safety — NumberFlow is client-only
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  // cl_price only tracks the chart asset, so ignore it for any other asset and
  // let `seed` carry that case. One number out of the selector, so this
  // re-renders on a price move and nothing else.
  const live = useStore((s) =>
    (s.chart_asset || '').toUpperCase() === (asset || 'BTC').toUpperCase() ? s.cl_price : 0)
  const px = live > 0 ? live : (seed > 0 ? seed : 0)

  const open = openRef.current
  const col = open <= 0 ? dimColor : px >= open ? upColor : downColor

  if (kind === 'delta') {
    if (open <= 0 || px <= 0) return <span style={{ color: dimColor }}>{'—'}</span>
    const d = px - open
    const txt = (d >= 0 ? '+' : '-') + '$' + Math.abs(d).toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    })
    return <span style={{ color: col, fontVariantNumeric: 'tabular-nums' }}>{txt}</span>
  }

  // kind === 'value' — casino-flip odometer
  if (px <= 0) return <span style={{ color: dimColor }}>{'—'}</span>
  return mounted
    ? (
      <NumberFlow
        value={px}
        prefix="$"
        trend={0}
        format={{ minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true }}
        transformTiming={{ duration: 400, easing: 'ease-out' }}
        spinTiming={{ duration: 400, easing: 'ease-out' }}
        opacityTiming={{ duration: 200, easing: 'ease-out' }}
        style={{ color: col, fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}
      />
    ) : (
      <span style={{ color: col, fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
        {'$' + px.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    )
}
