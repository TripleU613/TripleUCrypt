import { useState, useEffect } from 'react'
import NumberFlow from '@number-flow/react'
import { useStore } from '../../store.js'
import { call } from '../../api.js'
import { C, FONT, D, MS, SP, SZ, FS, FW, STR } from '../../constants/index.js'
import { playFx } from '../../lib/fx.js'

type Level = Record<string, unknown>

// ── Animated number cells ─────────────────────────────────────────────────────

function FlipCents({ value, color }: { value: number; color: string }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  if (!mounted) {
    return (
      <span style={{ color, fontSize: FS.BASE, fontWeight: FW.BOLD, fontFamily: FONT.MONO, fontVariantNumeric: 'tabular-nums' }}>
        {value.toFixed(1)}¢
      </span>
    )
  }
  return (
    <NumberFlow
      value={value}
      suffix="¢"
      format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
      transformTiming={{ duration: 400, easing: 'ease-out' }}
      spinTiming={{ duration: 400, easing: 'ease-out' }}
      opacityTiming={{ duration: 200, easing: 'ease-out' }}
      style={{ color, fontSize: FS.BASE, fontWeight: FW.BOLD, fontFamily: FONT.MONO, fontVariantNumeric: 'tabular-nums' }}
    />
  )
}

function FlipInt({ value, color, prefix = '', fontSize = FS.SM }:
  { value: number; color: string; prefix?: string; fontSize?: string }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const fmt = { useGrouping: true, minimumFractionDigits: 0, maximumFractionDigits: 0 }
  if (!mounted) {
    return (
      <span style={{ color, fontSize, fontFamily: FONT.MONO, fontVariantNumeric: 'tabular-nums' }}>
        {prefix}{Math.round(value).toLocaleString()}
      </span>
    )
  }
  return (
    <NumberFlow
      value={Math.round(value)}
      prefix={prefix}
      format={fmt}
      transformTiming={{ duration: 400, easing: 'ease-out' }}
      spinTiming={{ duration: 400, easing: 'ease-out' }}
      opacityTiming={{ duration: 200, easing: 'ease-out' }}
      style={{ color, fontSize, fontFamily: FONT.MONO, fontVariantNumeric: 'tabular-nums' }}
    />
  )
}

function SkeletonRow() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: SP.MD,
      padding: `${SP.XXS} ${SP.LG}`, height: SZ.S24, width: '100%',
    }}>
      <div className="tc-skel" style={{ width: SZ.S60, height: SP.XL, borderRadius: '3px', flexShrink: 0 }} />
      <div className="tc-skel" style={{ width: SZ.S36, height: SP.LG, borderRadius: '3px', marginLeft: 'auto' }} />
      <div className="tc-skel" style={{ flex: 1, height: SP.LG, borderRadius: '3px' }} />
      <div className="tc-skel" style={{ width: SZ.S44, height: SP.LG, borderRadius: '3px' }} />
    </div>
  )
}

function LevelRow({ level }: { level: Level }) {
  const isAsk = level['is_ask'] as boolean
  const barPct = (level['bar_pct'] as number) ?? 0
  const priceF = (level['price_f'] as number) ?? 0
  const sizeF = (level['size_f'] as number) ?? 0
  const totalF = (level['total_f'] as number) ?? 0
  const priceCents = (level['price_cents'] as number) ?? 0

  const rowColor = isAsk ? C.RED : C.GREEN
  const barBg = isAsk
    ? 'linear-gradient(90deg, rgba(239,68,68,0.18), rgba(239,68,68,0.06))'
    : `linear-gradient(90deg, rgba(${C.GREEN_RGB},0.18), rgba(${C.GREEN_RGB},0.06))`
  const hoverBg = isAsk ? 'var(--tc-down-tint)' : 'var(--tc-up-tint)'

  return (
    <div
      onClick={() => {
        if (isAsk) {
          call('ob_click_ask', priceCents)
        } else {
          call('ob_click_bid', priceCents)
        }
      }}
      style={{
        cursor: 'pointer', padding: `${SP.XXS} ${SP.LG}`, height: SZ.S24,
        width: '100%', display: 'flex', alignItems: 'center',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = hoverBg; playFx(e.currentTarget.querySelector('div'), 'pulse') }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.MD, width: '100%' }}>
        {/* Depth bar */}
        <div style={{ width: SZ.S60, height: SP.XXL, flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center' }}>
          <div style={{
            height: '100%', width: `${Math.min(100, barPct)}%`,
            background: barBg, borderRadius: '2px',
          }} />
        </div>
        {/* Price */}
        <div style={{ width: SZ.S48, textAlign: 'right', display: 'flex', justifyContent: 'flex-end' }}>
          <FlipCents value={priceF} color={rowColor} />
        </div>
        {/* Shares */}
        <div style={{ flex: 1, textAlign: 'right', display: 'flex', justifyContent: 'flex-end' }}>
          <FlipInt value={sizeF} color="var(--tc-text)" />
        </div>
        {/* Total */}
        <div style={{ width: SZ.S64, textAlign: 'right', display: 'flex', justifyContent: 'flex-end' }}>
          <FlipInt value={totalF} color={C.DIM3} prefix="$" />
        </div>
      </div>
    </div>
  )
}

function SideTab({ label, value, active }: { label: string; value: string; active: boolean }) {
  const accent = value === 'UP' ? C.GREEN : C.RED
  return (
    <div
      onClick={() => call('set_ob_side', value)}
      onMouseEnter={e => { if (!active) e.currentTarget.style.color = C.WHITE; playFx(e.currentTarget, 'pulse') }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.color = C.DIM3 }}
      style={{
        cursor: 'pointer', padding: `${SP.SM} ${SP.XXL}`, userSelect: 'none', display: 'inline-block',
        borderBottom: active ? `2px solid ${accent}` : '2px solid transparent',
        color: active ? C.WHITE : C.DIM3,
        fontSize: FS.BASE, fontWeight: FW.BOLD,
        transition: `all ${MS.TRANSITION_QUICK}ms`,
      }}
    >
      {label}
    </div>
  )
}

export function OrderBook() {
  const obSide = useStore(s => s.ob_side)
  const obLoading = useStore(s => s.ob_loading)
  const obUpLevels = useStore(s => s.ob_up_levels)
  const obDnLevels = useStore(s => s.ob_dn_levels)
  const obLastUp = useStore(s => s.ob_last_up)
  const obLastDn = useStore(s => s.ob_last_dn)
  const obSpreadUp = useStore(s => s.ob_spread_up)
  const obSpreadDn = useStore(s => s.ob_spread_dn)

  const levels = obSide === 'UP' ? obUpLevels : obDnLevels
  const lastStr = obSide === 'UP' ? obLastUp : obLastDn
  const spreadStr = obSide === 'UP' ? obSpreadUp : obSpreadDn
  const showSkeleton = obLoading && levels.length === 0

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
      background: 'var(--tc-panel)', overflow: 'hidden',
      boxShadow: 'var(--tc-elev-1)',
    }}>
      {/* Header: side tabs + refresh */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 0,
        padding: `${SP.NONE} ${SP.LG}`, borderBottom: '1px solid var(--tc-border)', flexShrink: 0,
      }}>
        <SideTab label={STR.OB_TRADE_UP} value="UP" active={obSide === 'UP'} />
        <SideTab label={STR.OB_TRADE_DOWN} value="DOWN" active={obSide === 'DOWN'} />
        <div style={{ flex: 1 }} />
        {showSkeleton
          ? <span style={{ color: C.DIM3, fontSize: FS.XS, fontFamily: FONT.MONO }}>{STR.LOADING}</span>
          : <span
              onClick={() => call('poll_orderbook_once')}
              onMouseEnter={e => { e.currentTarget.style.color = C.WHITE; playFx(e.currentTarget, 'spin') }}
              onMouseLeave={e => { e.currentTarget.style.color = C.DIM3 }}
              style={{ color: C.DIM3, fontSize: FS.XL, cursor: 'pointer', padding: `${SP.MD} ${SP.NONE}`, display: 'inline-block' }}
              title={STR.OB_REFRESH}
            >↻</span>
        }
      </div>

      {/* Column headers */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: SP.MD,
        padding: `${SP.XS} ${SP.LG} ${SP.XXS}`, flexShrink: 0,
      }}>
        <div style={{ width: SZ.S60, flexShrink: 0 }} />
        <span style={{ color: 'var(--tc-dim)', fontSize: FS.NANO, fontWeight: FW.BOLD, letterSpacing: '0.1em', width: SZ.S48, textAlign: 'right' }}>{STR.COL_PRICE}</span>
        <span style={{ color: 'var(--tc-dim)', fontSize: FS.NANO, fontWeight: FW.BOLD, letterSpacing: '0.1em', flex: 1, textAlign: 'right' }}>{STR.COL_SHARES}</span>
        <span style={{ color: 'var(--tc-dim)', fontSize: FS.NANO, fontWeight: FW.BOLD, letterSpacing: '0.1em', width: SZ.S64, textAlign: 'right' }}>{STR.COL_TOTAL}</span>
      </div>

      {/* Asks badge */}
      <div style={{ padding: `${SP.XXS} ${SP.LG}` }}>
        <span style={{
          fontSize: FS.NANO, fontWeight: FW.XBOLD, letterSpacing: '0.05em',
          color: 'var(--tc-bg)', background: C.RED,
          borderRadius: D.R_XS, padding: `${SP.HAIR} ${SP.SM}`, display: 'inline-block',
        }}>{STR.COL_ASKS}</span>
      </div>

      {/* Level rows */}
      <div style={{ flex: 1, overflowY: 'auto', width: '100%' }}>
        {showSkeleton
          ? [0,1,2,3,4,5,6,7].map(i => <SkeletonRow key={i} />)
          : levels.map((level, i) => <LevelRow key={i} level={level} />)
        }
      </div>

      {/* Footer: last price + spread */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: `${SP.XS} ${SP.LG}`, borderTop: '1px solid var(--tc-border)', flexShrink: 0,
      }}>
        <span style={{ color: C.DIM3, fontSize: FS.XS, fontWeight: FW.SEMI, fontFamily: FONT.MONO, fontVariantNumeric: 'tabular-nums' }}>
          {lastStr}
        </span>
        <span style={{ color: C.DIM3, fontSize: FS.XS, fontWeight: FW.SEMI, fontFamily: FONT.MONO, fontVariantNumeric: 'tabular-nums' }}>
          {spreadStr}
        </span>
      </div>
    </div>
  )
}
