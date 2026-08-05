/**
 * RTDS-fed live price + delta component.
 * Ported from TripleUCrypt/ui/shared/live_price.py
 *
 * kind="value" → the current price ("$67,432.10"), colored green/red vs open.
 * kind="delta" → the signed delta from open ("+$124.50" / "-$3.20").
 */

import { useEffect, useRef, useState } from 'react'
import NumberFlow from '@number-flow/react'
import { sub } from '../../buses/RtdsBus'
import { useStore } from '../../store'
import { C } from '../../constants/index.js'

interface LivePriceProps {
  kind: 'value' | 'delta'
  asset: string
  openPrice: number
  /** Server price shown until first socket frame */
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
  const [px, setPx] = useState(seed > 0 ? seed : 0)
  const pxRef   = useRef(seed > 0 ? seed : 0)
  const openRef = useRef(openPrice)
  useEffect(() => { openRef.current = openPrice }, [openPrice])

  // SSR safety — NumberFlow is client-only
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  // Re-seed from server value only while socket hasn't produced a live tick yet
  useEffect(() => {
    if (!(pxRef.current > 0) && seed > 0) { pxRef.current = seed; setPx(seed) }
  }, [seed])

  // Subscribe to the shared RTDS bus; filter to this asset's chainlink price
  useEffect(() => {
    const want = ((asset || 'BTC').toLowerCase()) + '/usd'
    const unsub = sub((arr) => {
      for (const msg of arr as {topic?: string; payload?: {symbol?: string; value?: string|number}}[]) {
        if (msg && msg.topic === 'crypto_prices_chainlink' && msg.payload &&
            (msg.payload.symbol || '').toLowerCase() === want) {
          const v = parseFloat(String(msg.payload.value))
          if (!isNaN(v) && Math.abs(v - pxRef.current) > 1e-9) {
            pxRef.current = v
            setPx(v)
          }
        }
      }
    })
    return () => unsub()
  }, [asset])

  // Fallback to store's cl_price if RTDS stalls >1.5s
  const clPrice = useStore((s) => s.cl_price)
  useEffect(() => {
    if (clPrice > 0 && !(pxRef.current > 0)) {
      pxRef.current = clPrice
      setPx(clPrice)
    }
  }, [clPrice])

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
