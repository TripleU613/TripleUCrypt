import React, { useRef, useEffect, useState, type ReactNode } from 'react'
import NumberFlow from '@number-flow/react'
import { useStore } from '../store.js'
import { call } from '../api.js'
import { OrderBook } from './trading/OrderBook.js'
import { LivePrice } from './shared/LivePrice.js'
import { RollDigits } from './shared/RollDigits.js'
import { computePositionsLive, computeClaimablePositions, type ComputedPosition } from '../lib/compute.js'
import { placeBuy, placeSell } from '../lib/placeTrade.js'
import { playFx } from '../lib/fx.js'
import { useCountdown } from '../lib/useCountdown.js'
import { intervalSecs } from '../lib/intervals.js'
import { C, FONT, D, STR, SP, SZ, FS, FW } from '../constants/index.js'

// ── Live ask value hook — one number, straight off the SSE-fed store ──────────
// The server streams the whole CLOB book into token_asks, so the ask for a token
// is already in the store. Select the SINGLE number, never the token_asks map:
// selecting the map would re-render on any of the ~28 streamed tokens moving.
// The server also gates its patches on a >0.05¢ move, so no local threshold.
function useLiveAsk(side: string, upToken: string, dnToken: string): number {
  const token = side === 'DOWN' ? dnToken : upToken
  return useStore(s => (token ? s.token_asks[token] ?? 0 : 0))
}

// ── Live ask chip — NumberFlow flip ───────────────────────────────────────────

function LiveAsk({ side, upToken, dnToken, color, glowCls = '' }:
  { side: string; upToken: string; dnToken: string; color: string; glowCls?: string }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const ask = useLiveAsk(side, upToken, dnToken)
  if (!(ask > 0)) return <span style={{ color, fontVariantNumeric: 'tabular-nums' }}>—</span>
  return mounted
    ? <NumberFlow value={ask} suffix="¢" trend={0}
        format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
        transformTiming={{ duration: 400, easing: 'ease-out' }}
        spinTiming={{ duration: 400, easing: 'ease-out' }}
        opacityTiming={{ duration: 200, easing: 'ease-out' }}
        className={glowCls}
        style={{ color, fontVariantNumeric: 'tabular-nums' }} />
    : <span className={glowCls} style={{ color, fontVariantNumeric: 'tabular-nums' }}>{ask.toFixed(1)}¢</span>
}

function LivePayout({ side, size, upToken, dnToken, color }:
  { side: string; size: number; upToken: string; dnToken: string; color: string }) {
  const ask = useLiveAsk(side, upToken, dnToken)
  if (!(ask > 0) || !(size > 0)) return <span style={{ color }}>—</span>
  const pays = (size * 100 / ask).toFixed(2)
  return <span style={{ color, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>${pays}</span>
}

// ── Countdown timer (client-side) ─────────────────────────────────────────────

function Countdown({ endTs, intervalS }: { endTs: number; intervalS: number }) {
  // `text` (not mm:ss) so the hour-plus windows read h:mm:ss.
  const { secsLeft, stale, text } = useCountdown(endTs, intervalS)
  if (stale) return <span style={{ color: 'var(--tc-dim)', fontFamily: FONT.TIME }}>—</span>
  return <RollDigits text={text} style={{ color: secsLeft < 30 ? C.GOLD : 'var(--tc-white)', fontFamily: FONT.TIME, letterSpacing: '0.02em', fontVariantNumeric: 'tabular-nums' }} />
}

// ── FlipNumber ────────────────────────────────────────────────────────────────

function Flip({ value, format, color, fontSize = FS.XL, fontWeight = '900' }:
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { value: number; format?: any; color: string; fontSize?: string; fontWeight?: string }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const fmt = format ?? { style: 'currency', currency: 'USD' }
  if (!mounted) return <span style={{ color, fontSize, fontWeight, fontFamily: FONT.MONO }}>{value.toFixed(2)}</span>
  return <NumberFlow value={value} format={fmt}
    transformTiming={{ duration: 400, easing: 'ease-out' }}
    spinTiming={{ duration: 400, easing: 'ease-out' }}
    opacityTiming={{ duration: 200, easing: 'ease-out' }}
    style={{ color, fontSize, fontWeight, fontFamily: FONT.MONO, fontVariantNumeric: 'tabular-nums' }} />
}

// ── Skeletons ─────────────────────────────────────────────────────────────────

function SkelBox({ w, h, radius = D.R_SM }: { w: string; h: string; radius?: string }) {
  return <div className="tc-skel" style={{ width: w, height: h, borderRadius: radius }} />
}

function BuyHeaderSkeleton() {
  const card = () => (
    <div style={{ width: '100%', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'var(--tc-card-alt)', borderRadius: D.R_BTN, border: '1px solid var(--tc-active)' }}>
      <SkelBox w="70%" h={SP.LG} />
    </div>
  )
  return (
    <div style={{ display: 'flex', gap: D.GAP_MD, width: '100%', height: '104px', alignItems: 'stretch' }}>
      <div style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--tc-card-alt)', borderRadius: D.R_CARD, border: '1px solid var(--tc-active)', padding: SP.MD }}>
        <SkelBox w="70%" h={SZ.S44} radius={D.R_BTN} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: D.GAP_MD, width: '120px', flexShrink: 0, height: '100%' }}>
        {card()}{card()}{card()}
      </div>
    </div>
  )
}

function SideBtnSkeleton() {
  return (
    <div style={{ flex: 1, padding: `${SP.XXL} 0`, borderRadius: '12px', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', background: 'var(--tc-card-alt)', border: '1px solid var(--tc-active)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: D.GAP_MD, alignItems: 'center' }}>
        <SkelBox w="40%" h={SP.XL} /><SkelBox w="60%" h={SZ.S28} radius={D.R_SM} />
      </div>
    </div>
  )
}

function PresetSkeleton() {
  return (
    <div style={{ flex: 1, height: SZ.S46, borderRadius: D.R_BTN, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', background: 'var(--tc-card-alt)', border: '1px solid var(--tc-active)', minWidth: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: D.GAP_MD, alignItems: 'center' }}>
        <SkelBox w="55%" h={SP.XXL} /><SkelBox w="45%" h={SP.LG} />
      </div>
    </div>
  )
}

// ── Side buttons (UP / DOWN) ──────────────────────────────────────────────────

function SideBtn({ direction, tall = false }: { direction: 'UP' | 'DOWN'; tall?: boolean }) {
  const buySide = useStore(s => s.buy_side) as string
  const upToken = useStore(s => s.up_token) as string
  const dnToken = useStore(s => s.dn_token) as string
  const isUp = direction === 'UP'
  const selected = buySide === direction
  const color = isUp ? C.GREEN : C.RED
  const arrow = isUp ? '▲' : '▼'
  const label = isUp ? STR.UP : STR.DOWN
  // Selected = filled tint + bold frame + strong glow; idle = hollow, dim and
  // clearly receded so the active side is unmistakable.
  return (
    <div onClick={() => call('set_buy_side', direction)}
         className={selected ? 'tc-hoverlift tc-pop' : 'tc-hoverlift'}
         onMouseEnter={e => { if (!selected) e.currentTarget.style.borderColor = `${color}88`; playFx(e.currentTarget, 'glow') }}
         onMouseLeave={e => { e.currentTarget.style.borderColor = selected ? color : `${color}24` }}
         style={{
           flex: 1, cursor: 'pointer', padding: tall ? `${SP.H3} 0` : `${SP.LG} 0`, borderRadius: tall ? D.R_CARD : D.R_CTRL,
           textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center',
           background: selected ? `${color}22` : 'transparent',
           border: `${selected ? 2 : 1}px solid ${selected ? color : `${color}24`}`,
           boxShadow: selected ? `0 0 22px ${color}66, inset 0 0 16px ${color}26` : 'none',
           opacity: selected ? 1 : 0.45,
           transition: 'background 0.14s, border-color 0.14s, box-shadow 0.14s, opacity 0.14s',
           userSelect: 'none', boxSizing: 'border-box',
         }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: D.GAP_SM, alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SP.XXS }}>
          <span style={{ fontSize: FS.XS, fontWeight: FW.XBOLD, color }}>{arrow}</span>
          <span style={{ fontSize: FS.SM, fontWeight: FW.BOLD, letterSpacing: '0.02em', color }}>{label}</span>
        </div>
        <div style={{ fontSize: FS.H1, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, lineHeight: 1, letterSpacing: '-0.01em' }}>
          <LiveAsk side={direction} upToken={upToken} dnToken={dnToken}
            color={color}
            glowCls={selected ? 'tc-tick' : `tc-tglow-${direction.toLowerCase()} tc-tick`} />
        </div>
      </div>
    </div>
  )
}

// ── Preset chip (1-Tap) ───────────────────────────────────────────────────────

function PresetChip({ value, onEdit, mobile = false, selected = false, onSelect }: {
  value: number; onEdit: (v: number) => void
  // mobile: single tap selects (parent shows a Buy button), double tap edits.
  mobile?: boolean; selected?: boolean; onSelect?: () => void
}) {
  const buySide = useStore(s => s.buy_side) as string
  const upToken = useStore(s => s.up_token) as string
  const dnToken = useStore(s => s.dn_token) as string
  const sideColor = buySide === 'UP' ? C.GREEN : C.RED
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(value))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing) { inputRef.current?.focus(); inputRef.current?.select() } }, [editing])

  const commit = () => {
    const n = parseFloat(draft)
    if (!isNaN(n) && n > 0) onEdit(Math.round(n * 100) / 100)
    setEditing(false)
  }
  const cancel = () => { setDraft(String(value)); setEditing(false) }

  if (editing) {
    return (
      <div style={{
        flex: 1, height: SZ.S46, borderRadius: D.R_BTN, minWidth: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SP.HAIR,
        background: 'var(--tc-card-alt)', border: `1px solid ${sideColor}`,
        boxShadow: `0 0 10px ${sideColor}33`,
      }}>
        <span style={{ fontSize: FS.LG, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, color: 'var(--tc-white)', lineHeight: 1, flexShrink: 0 }}>$</span>
        <input
          ref={inputRef}
          value={draft}
          inputMode="decimal"
          onChange={e => setDraft(e.target.value.replace(/[^0-9.]/g, ''))}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') cancel() }}
          style={{
            // width hugs the content so "$10" reads as one centred unit, not a left-aligned field
            width: `${Math.max(1.2, draft.length + 0.5)}ch`,
            background: 'transparent', border: 'none', outline: 'none', textAlign: 'left',
            color: 'var(--tc-white)', fontSize: FS.LG, fontWeight: FW.XBOLD, fontFamily: FONT.MONO,
            padding: SP.NONE, margin: SP.NONE, lineHeight: 1, fontVariantNumeric: 'tabular-nums', caretColor: sideColor,
          }}
        />
      </div>
    )
  }

  const startEdit = () => { setDraft(String(value)); setEditing(true) }
  return (
    <div onClick={() => { if (mobile) onSelect?.(); else placeBuy(buySide, value) }}
         onDoubleClick={mobile ? (e => { e.preventDefault(); startEdit() }) : undefined}
         onContextMenu={e => { e.preventDefault(); startEdit() }}
         className="tc-hoverlift"
         title={mobile ? STR.PRESET_SELECT_HINT : STR.PRESET_EDIT_HINT}
         style={{
           flex: 1, height: mobile ? SZ.S54 : SZ.S46, cursor: 'pointer', borderRadius: D.R_BTN, minWidth: 0,
           display: 'flex', alignItems: 'center', justifyContent: 'center',
           background: selected ? `${sideColor}1f` : 'var(--tc-card-alt)',
           border: `1px solid ${selected ? sideColor : 'var(--tc-border)'}`,
           boxShadow: selected ? `0 0 12px ${sideColor}44` : 'var(--tc-elev-1)', userSelect: 'none',
           touchAction: mobile ? 'manipulation' : undefined,
           transition: 'background 0.14s, border-color 0.14s, box-shadow 0.14s',
         }}
         onMouseEnter={e => { if (!selected) e.currentTarget.style.borderColor = sideColor; playFx(e.currentTarget.querySelector('div'), 'pop') }}
         onMouseLeave={e => (e.currentTarget.style.borderColor = selected ? sideColor : 'var(--tc-border)')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: D.GAP_SM, alignItems: 'center', minWidth: 0 }}>
        <span style={{ fontSize: FS.LG, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, color: 'var(--tc-white)', lineHeight: 1 }}>
          ${value % 1 === 0 ? value : value.toFixed(2)}
        </span>
        <div style={{ fontSize: FS.XXS, fontWeight: FW.SEMI, fontFamily: FONT.MONO, lineHeight: 1, whiteSpace: 'nowrap' }}>
          <LivePayout side={buySide} size={value} upToken={upToken} dnToken={dnToken}
            color="var(--tc-dim2)" />
        </div>
      </div>
    </div>
  )
}

// ── Input field ───────────────────────────────────────────────────────────────

function Field({ label, value, onChange, placeholder, prefix = '', suffix = '', accent }:
  { label: string; value: string; onChange: (v: string) => void; placeholder: string; prefix?: string; suffix?: string; accent?: string }) {
  const affix = accent ?? 'var(--tc-dim2)'
  return (
    <div className="tc-field" style={{
      flex: 1, height: SZ.S54, minHeight: SZ.S54, padding: `${SP.NONE} ${SP.XL}`, display: 'flex',
      flexDirection: 'column', justifyContent: 'center', gap: SP.XS, borderRadius: D.R_CTRL,
      background: 'transparent', border: `1px solid ${accent ?? 'var(--tc-border)'}`,
      boxSizing: 'border-box', minWidth: 0,
    }}>
      <span style={{ fontSize: FS.NANO, fontWeight: FW.XBOLD, letterSpacing: '0.14em',
                     color: accent ?? 'var(--tc-dim2)', fontFamily: FONT.MONO, textTransform: 'uppercase' }}>
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: D.GAP_SM, width: '100%' }}>
        {prefix && <span style={{ fontSize: FS.XL, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, color: affix, lineHeight: 1, flexShrink: 0 }}>{prefix}</span>}
        <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
               style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none',
                        color: 'var(--tc-white)', fontSize: FS.H3, fontWeight: FW.XBOLD,
                        letterSpacing: '-0.01em', fontFamily: FONT.MONO, padding: SP.NONE, margin: SP.NONE,
                        lineHeight: 1, fontVariantNumeric: 'tabular-nums', boxSizing: 'border-box' }} />
        {suffix && <span style={{ fontSize: FS.XL, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, color: affix, lineHeight: 1, flexShrink: 0 }}>{suffix}</span>}
      </div>
    </div>
  )
}

// ── CTA button ────────────────────────────────────────────────────────────────

function CtaButton({ children }: { children: ReactNode }) {
  const configured = useStore(s => s.trading_configured) as boolean
  const loading = useStore(s => s.loading) as boolean
  const buySide = useStore(s => s.buy_side) as string
  const color = buySide === 'UP' ? C.GREEN : C.RED
  if (!configured) {
    return (
      <div style={{ width: '100%', height: SZ.S48, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: D.R_CTRL, background: 'transparent', border: '1px dashed var(--tc-border-hi)',
                    userSelect: 'none' }}>
        <span style={{ fontSize: FS.MD, fontWeight: FW.BOLD, fontFamily: FONT.MONO, color: 'var(--tc-dim2)' }}>
          {STR.NO_SIGNER}
        </span>
      </div>
    )
  }
  // Skeletonized: hollow colored frame + colored text, soft glow (no fill).
  return (
    <div onClick={() => placeBuy(buySide)}
         className="tc-hoverlift tc-sheen"
         onMouseEnter={e => { if (configured && !loading) { e.currentTarget.style.boxShadow = `0 0 20px ${color}55`; playFx(e.currentTarget.querySelector('div'), 'pulse') } }}
         onMouseLeave={e => { e.currentTarget.style.boxShadow = `0 0 14px ${color}2e` }}
         style={{ cursor: 'pointer', width: '100%', height: SZ.S54, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', borderRadius: '13px', background: 'transparent',
                  border: `1.5px solid ${color}`, boxShadow: `0 0 14px ${color}2e`,
                  boxSizing: 'border-box', userSelect: 'none' }}>
      {loading
        ? <div style={{ width: SP.XXL, height: SP.XXL, borderRadius: '50%',
                        border: `2px solid ${color}`,
                        borderTopColor: 'transparent', animation: 'spin 0.6s linear infinite' }} />
        : children}
    </div>
  )
}

function CtaLabel({ verb, profitNode }: { verb: ReactNode; profitNode: ReactNode }) {
  const buySide = useStore(s => s.buy_side) as string
  const fg = buySide === 'UP' ? C.GREEN : C.RED
  return (
    <div style={{ display: 'flex', alignItems: 'center', width: '100%', height: '100%',
                  padding: `${SP.NONE} ${SP.LG} ${SP.NONE} ${SP.XXL}`, gap: SP.XL }}>
      <span style={{ fontSize: FS.LG, fontWeight: FW.BLACK, fontFamily: FONT.MONO, color: fg,
                     letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        {verb}
      </span>
      <div style={{ flex: 1 }} />
      {profitNode}
      <div style={{ width: SZ.S28, height: SZ.S28, borderRadius: '50%', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: `1.5px solid ${fg}`, color: fg, fontSize: FS.LG, fontWeight: FW.BLACK, lineHeight: 1 }}>
        →
      </div>
    </div>
  )
}

// ── Buy modes ─────────────────────────────────────────────────────────────────

const DEFAULT_PRESETS: number[] = [5, 10, 25, 50]
const PRESETS_KEY = 'tc_presets'

function loadPresets(): number[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr) && arr.length === DEFAULT_PRESETS.length
          && arr.every(n => typeof n === 'number' && n > 0)) {
        return arr
      }
    }
  } catch { /* fall through to defaults */ }
  return DEFAULT_PRESETS
}

function savePresets(p: number[]): void {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(p)) } catch { /* ignore */ }
}

function Mode1Tap({ mobile = false }: { mobile?: boolean } = {}) {
  const configured = useStore(s => s.trading_configured) as boolean
  // Presets live in the server settings.json now (persist across restarts);
  // the store value is the source of truth, localStorage is just an offline cache.
  const presets = useStore(s => s.presets) as number[]
  const buySide = useStore(s => s.buy_side) as string
  const upToken = useStore(s => s.up_token) as string
  const dnToken = useStore(s => s.dn_token) as string
  // Mobile: tap selects a preset (no instant buy); a Buy button confirms it.
  // Default to the first preset so the Buy button is ready the moment 1-Tap opens.
  const [selIdx, setSelIdx] = useState<number>(0)
  if (!configured) {
    return (
      <div style={{ width: '100%', height: SZ.S46, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: D.R_BTN, background: 'var(--tc-panel)', border: '1px dashed var(--tc-border-hi)',
                    boxShadow: 'var(--tc-elev-1)', userSelect: 'none' }}>
        <span style={{ fontSize: FS.MD, fontWeight: FW.BOLD, fontFamily: FONT.MONO, color: 'var(--tc-dim2)' }}>
          {STR.NO_SIGNER}
        </span>
      </div>
    )
  }
  const editAt = (i: number, v: number) => {
    const next = presets.slice()
    next[i] = v
    savePresets(next)                       // offline cache
    useStore.getState()._patch({ presets: next }) // optimistic
    call('set_presets', next)               // persist to settings.json
  }

  if (mobile) {
    const selVal = selIdx < presets.length ? presets[selIdx] : null
    const sideColor = buySide === 'UP' ? C.GREEN : C.RED
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP.LG, width: '100%' }}>
        <div style={{ display: 'flex', gap: D.GAP_MD, width: '100%' }}>
          {presets.map((value, i) => (
            <PresetChip key={i} value={value} mobile selected={selIdx === i}
              onSelect={() => setSelIdx(i)} onEdit={v => editAt(i, v)} />
          ))}
        </div>
        {selVal != null && (
          <button
            onClick={() => placeBuy(buySide, selVal)}
            style={{
              width: '100%', minHeight: SZ.S54, padding: `${SP.MD} ${SP.XL}`, borderRadius: D.R_CARD, cursor: 'pointer',
              border: `1px solid ${sideColor}`, background: `${sideColor}22`, color: sideColor,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: SP.XXS,
              fontFamily: FONT.MONO, fontWeight: FW.XBOLD, letterSpacing: '0.02em', WebkitTapHighlightColor: 'transparent',
            }}>
            <span style={{ fontSize: FS.XL }}>
              Buy ${selVal % 1 === 0 ? selVal : selVal.toFixed(2)} {buySide === 'UP' ? '▲' : '▼'}
            </span>
            <span style={{ fontSize: FS.XS, fontWeight: FW.BOLD, opacity: 0.92 }}>
              <LivePayout side={buySide} size={selVal} upToken={upToken} dnToken={dnToken} color={sideColor} />
            </span>
          </button>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: D.GAP_MD, width: '100%' }}>
      {presets.map((value, i) => <PresetChip key={i} value={value} onEdit={v => editAt(i, v)} />)}
    </div>
  )
}

function ModeMarket() {
  const buySide = useStore(s => s.buy_side) as string
  const tradeSize = useStore(s => s.trade_size) as string
  const upToken = useStore(s => s.up_token) as string
  const dnToken = useStore(s => s.dn_token) as string
  // Live ask off the SSE-fed store so the payout/CTA update in real time
  const ask = useLiveAsk(buySide, upToken, dnToken)
  // Gross payout - cost = profit (same formula as Python win_profit_float)
  const size = parseFloat(tradeSize) || 0
  const payout = ask > 0 ? (size * 100 / ask) : 0
  const profit = payout - size
  const priced = ask > 0 && size > 0
  const sideColor = buySide === 'UP' ? C.GREEN : C.RED
  const fg = sideColor

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP.LG, width: '100%' }}>
      {/* Amount + live payout — orange "money" theme to stand apart from the
          green/red side + CTA. */}
      <div style={{ display: 'flex', gap: D.GAP_MD, width: '100%', alignItems: 'stretch' }}>
        <Field label={STR.YOU_PAY} value={String(tradeSize)} onChange={v => call('set_size', v)} placeholder="0" prefix="$" accent={C.GOLD} />
        <div style={{
          flex: 1, minHeight: SZ.S54, padding: `${SP.NONE} ${SP.XXL}`, display: 'flex', flexDirection: 'column',
          justifyContent: 'center', gap: SP.XS, borderRadius: D.R_CTRL, minWidth: 0,
          background: 'transparent', boxSizing: 'border-box',
          border: `1px solid ${priced ? C.GOLD : 'var(--tc-border)'}`,
          transition: 'all 0.16s',
        }}>
          <span style={{ fontSize: FS.NANO, fontWeight: FW.XBOLD, letterSpacing: '0.14em',
                         color: C.GOLD, fontFamily: FONT.MONO, textTransform: 'uppercase' }}>
            {STR.TO_WIN}
          </span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: SP.SM, minWidth: 0 }}>
            {priced
              ? <Flip value={profit} format={{ style: 'currency', currency: 'USD', signDisplay: 'always', maximumFractionDigits: 2 }}
                      color={C.GOLD} fontSize={FS.H3} fontWeight="900" />
              : <span style={{ fontSize: FS.H3, fontWeight: FW.BLACK, fontFamily: FONT.MONO, color: 'var(--tc-dim2)' }}>—</span>}
          </div>
        </div>
      </div>

      <CtaButton>
        <CtaLabel
          verb={buySide === 'UP' ? STR.BUY_UP : STR.BUY_DOWN}
          profitNode={
            <span style={{ fontSize: FS.H3, fontWeight: FW.BLACK, fontFamily: FONT.MONO, color: fg,
                           fontVariantNumeric: 'tabular-nums', opacity: priced ? 1 : 0.5 }}>
              {priced ? `$${payout.toFixed(2)}` : '—'}
            </span>
          } />
      </CtaButton>
    </div>
  )
}

function ModeLimit() {
  const buySide = useStore(s => s.buy_side) as string
  const tradeSize = useStore(s => s.trade_size) as string
  const limitPrice = useStore(s => s.limit_price) as string
  const fg = buySide === 'UP' ? C.GREEN : C.RED
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP.XL, width: '100%' }}>
      <div style={{ display: 'flex', gap: D.GAP_MD, width: '100%' }}>
        <Field label={STR.MAX_PRICE} value={String(limitPrice)} onChange={v => call('set_limit_price', v)} placeholder="97" suffix="¢" />
        <Field label={STR.AMOUNT} value={String(tradeSize)} onChange={v => call('set_size', v)} placeholder="25" prefix="$" />
      </div>
      <CtaButton>
        <CtaLabel
          verb={buySide === 'UP' ? STR.LIMIT_UP : STR.LIMIT_DOWN}
          profitNode={
            <div style={{ display: 'flex', alignItems: 'center', gap: D.GAP_SM }}>
              <span style={{ fontSize: FS.LG, fontWeight: FW.BOLD, fontFamily: FONT.MONO, color: fg, opacity: 0.7 }}>@</span>
              <span style={{ fontSize: FS.H3, fontWeight: FW.BLACK, fontFamily: FONT.MONO, color: fg,
                             letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums' }}>
                {limitPrice}¢
              </span>
            </div>
          } />
      </CtaButton>
    </div>
  )
}

// ── Sell button (under CTA in buy tab) ────────────────────────────────────────

function SellBtn({ pos }: { pos: ComputedPosition }) {
  const curBid = (pos['cur_bid'] as number) ?? 0
  const priced = curBid > 0
  const shares = (pos['shares'] as number) ?? 0
  const avgPrice = (pos['avg_price'] as number) ?? 0
  const costBasis = (shares * avgPrice) / 100
  const valueNow = (pos['value_usd'] as number) ?? 0
  const displayValue = priced ? valueNow : costBasis
  const pnl = (pos['pnl_usd'] as number) ?? 0
  const pnlPct = (pos['pnl_pct'] as number) ?? 0
  const pnlColor = pnl >= 0 ? C.GREEN : C.RED
  const [hover, setHover] = useState(false)
  const badgeRef = useRef<HTMLDivElement>(null)

  return (
    <div onClick={() => placeSell(String(pos['token'] ?? ''), shares, 'all')}
         className="tc-hoverlift"
         onMouseEnter={() => { setHover(true); playFx(badgeRef.current, 'shake') }}
         onMouseLeave={() => setHover(false)}
         style={{
           cursor: 'pointer', width: '100%', padding: `${SP.LG} ${SP.XL}`,
           borderRadius: '12px', background: 'var(--tc-card-alt)',
           border: `1px solid ${hover ? C.RED : 'var(--tc-border-hi)'}`,
           boxShadow: hover ? `0 0 0 1px rgba(${C.RED_RGB},0.27), var(--tc-elev-2)` : 'var(--tc-elev-1)',
           display: 'flex', alignItems: 'center', gap: SP.XL, userSelect: 'none',
           transition: 'all 0.12s',
         }}>
      {/* SELL badge — fills red on hover */}
      <div ref={badgeRef} style={{ padding: `${SP.SM} ${SP.LG}`, borderRadius: '7px', flexShrink: 0,
                    background: hover ? C.RED : 'var(--tc-active)', transition: 'all 0.12s' }}>
        <span style={{ fontSize: FS.NANO, fontWeight: FW.BLACK, fontFamily: FONT.MONO,
                       color: hover ? C.RED_TEXT : 'var(--tc-dim2)', letterSpacing: '0.1em' }}>{STR.SELL_BADGE}</span>
      </div>

      {/* asset + size */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP.XXS, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: FS.MD, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, color: 'var(--tc-white)', lineHeight: 1 }}>
          {String(pos['asset_dir_label'] ?? '')}
        </span>
        <span style={{ fontSize: FS.XXS, fontWeight: FW.SEMI, fontFamily: FONT.MONO, color: 'var(--tc-dim2)', lineHeight: 1 }}>
          {String(pos['size_str'] ?? '')}
        </span>
      </div>

      {/* value + P&L (cost basis fallback when no live bid) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP.XS, alignItems: 'flex-end', flexShrink: 0 }}>
        <Flip value={displayValue} format={{ style: 'currency', currency: 'USD' }}
              color="var(--tc-white)" fontSize={FS.XL} fontWeight="900" />
        {priced ? (
          <span style={{ fontSize: FS.XXS, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, color: pnlColor,
                         fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
            {pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(2)} ({pnl >= 0 ? '+' : '−'}{Math.abs(pnlPct).toFixed(1)}%)
          </span>
        ) : (
          <span style={{ fontSize: FS.NANO, fontWeight: FW.BOLD, fontFamily: FONT.MONO, color: 'var(--tc-dim)',
                         letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
            {STR.COST_BASIS}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Buy-mode cycle button (mobile) — desktop-style icon + label ──────────────
// Mirrors the Nav's buymode control: one button cycling 1-Tap → Market → Limit.
// wide = the full-width "Buying type" bar at the top of the mobile buy panel.
function BuyModeBtn({ wide = false }: { wide?: boolean } = {}) {
  const buyMode = useStore(s => s.buy_mode) as string
  const meta: Record<string, { label: string; icon: ReactNode }> = {
    market: { label: STR.BM_MARKET, icon: <svg width={wide ? 18 : 15} height={wide ? 18 : 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a9 9 0 1 0 9 9" /><path d="M12 12l5-3" /><path d="M12 7v5" /></svg> },
    limit:  { label: STR.BM_LIMIT,  icon: <svg width={wide ? 18 : 15} height={wide ? 18 : 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.5" /><circle cx="12" cy="12" r="0.5" /></svg> },
  }
  const m = meta[buyMode] ?? { label: STR.BM_1TAP, icon: <svg width={wide ? 18 : 15} height={wide ? 18 : 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg> }
  return (
    <button onClick={() => call('cycle_buy_mode').catch(() => {})} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: wide ? SP.MD : SP.SM, padding: wide ? `${SP.NONE} ${SP.XXL}` : `${SP.NONE} ${SP.XL}`,
      height: wide ? SZ.S52 : SZ.S36, width: wide ? '100%' : undefined,
      borderRadius: D.R_CARD, border: '1px solid var(--tc-border)', background: 'var(--tc-card)',
      color: C.GOLD, fontFamily: FONT.MONO, fontSize: wide ? '15px' : FS.SM, fontWeight: FW.XBOLD, letterSpacing: '0.04em',
      cursor: 'pointer', WebkitTapHighlightColor: 'transparent', flexShrink: 0,
    }}>
      {m.icon}<span>{m.label}</span>
      {wide && <span style={{ color: 'var(--tc-dim2)', fontWeight: FW.BOLD, fontSize: FS.XS, letterSpacing: '0.02em' }}>{STR.BM_TAP_CHANGE}</span>}
    </button>
  )
}

// Value-only card for the mobile buy header (open / live / delta — no labels).
function InfoCard({ children }: { children: ReactNode }) {
  return (
    <div style={{
      flex: '1 1 0', minWidth: 0, display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: `${SP.XXL} ${SP.SM}`, minHeight: SZ.S64,
      background: 'var(--tc-card-alt)', borderRadius: D.R_CARD, border: '1px solid var(--tc-active)',
      boxShadow: 'var(--tc-elev-1)',
    }}>
      <span style={{ fontSize: FS.MD, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, color: 'var(--tc-white)', lineHeight: 1, textAlign: 'center' }}>{children}</span>
    </div>
  )
}

// ── Buy panel ─────────────────────────────────────────────────────────────────

/**
 * Claim entry point for mobile.
 *
 * The only claim UI in the app lives in SellPanel, which never renders: nothing
 * dispatches `set_panel_tab` and src/engine/positions.ts pins `panel_tab` to
 * 'buy'. So a resolved winner could only be redeemed through the small refresh
 * icon in the live-only wallet view -- undiscoverable, and absent in practice
 * mode. That left real money sitting unclaimed.
 *
 * Uses computeClaimablePositions() rather than an inline filter so this can never
 * drift from the server's own definition of claimable (src/engine/positions.ts).
 * Renders nothing when there is nothing to claim, so it costs no vertical space
 * on a phone in the common case.
 */
function MobileClaimBanner({ positions }: { positions: Record<string, unknown>[] }) {
  const claimable = computeClaimablePositions(positions)
  if (claimable.length === 0) return null
  const label = claimable.length === 1
    ? '1 resolved position ready to claim'
    : `${claimable.length} resolved positions ready to claim`
  return (
    <button
      onClick={() => { call('claim_winnings').catch(() => {}) }}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: D.GAP_MD,
        padding: `${SP.MD} ${SP.LG}`, borderRadius: D.R_CTRL,
        border: `1px solid ${C.GREEN_BORDER}`, background: C.GREEN_BG,
        cursor: 'pointer', WebkitTapHighlightColor: 'transparent', textAlign: 'left',
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={C.GREEN} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
      <span style={{ color: C.GREEN, fontSize: FS.SM, fontWeight: FW.BOLD, fontFamily: FONT.MONO, flex: 1 }}>{label}</span>
      <span style={{
        color: 'var(--tc-bg)', fontSize: FS.XS, fontWeight: FW.XBOLD, fontFamily: FONT.MONO,
        background: C.GREEN, padding: `${SP.XXS} ${SP.LG}`, borderRadius: D.R_SM, flexShrink: 0,
      }}>{STR.CLAIM}</span>
    </button>
  )
}

function BuyPanel({ mobile = false }: { mobile?: boolean } = {}) {
  const upAsk = useStore(s => s.up_ask) as number
  const upToken = useStore(s => s.up_token) as string
  const dnToken = useStore(s => s.dn_token) as string
  const activeEndTs = useStore(s => s.active_end_ts) as number ?? 0
  const windows = (useStore(s => s.windows) ?? []) as Record<string, unknown>[]
  // The SELECTED window's length — the countdown/stale cutoff below is only
  // right if it comes from the card being traded, not from windows[0].
  const activeIdx = useStore(s => s.active_window) as number
  const activeIntervalS = intervalSecs(windows[activeIdx]?.['interval'])
  const windowOpenPrice = useStore(s => s.window_open_price) as number ?? 0
  const chartAsset = useStore(s => s.chart_asset) as string ?? 'BTC'
  const chartPrice = useStore(s => s.cl_price) as number ?? 0
  const buyMode = useStore(s => s.buy_mode) as string
  const positions = (useStore(s => s.positions) ?? []) as Record<string, unknown>[]
  const tokenAsks = (useStore(s => s.token_asks) ?? {}) as Record<string, number>
  const tokenBids = (useStore(s => s.token_bids) ?? {}) as Record<string, number>
  const positionsLive = computePositionsLive(positions, tokenAsks, tokenBids)
    // Resolved positions are NOT sellable on CLOB — they route to CLAIM. Keep
    // them off the quick-sell list (selling a resolved token reverts on-chain).
    .filter(p => !(p['dust'] as boolean) && !(p['resolved'] as boolean))

  const hasAsks = upAsk > 0

  // ── Mobile buy panel — redesigned per the wireframe ──────────────────────
  // Buying-type bar · was/is/by-how-much cards · big down/up · presets.
  if (mobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP.XL, width: '100%', padding: SP.XXL }}>
        {/* Buying type + time-to-close. The countdown is not decoration on a

            5-minute market: without it an order can be placed with seconds left

            and no way to see it. Desktop has always shown this. */}

        <div style={{ display: 'flex', alignItems: 'center', gap: SP.MD, width: '100%' }}>

          <div style={{ flex: 1, minWidth: 0 }}><BuyModeBtn wide /></div>

          <div style={{

            flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',

            minWidth: '74px', padding: `${SP.SM} ${SP.MD}`, borderRadius: D.R_BTN,

            border: '1px solid var(--tc-border)', background: 'var(--tc-card)',

            fontSize: FS.LG, fontWeight: FW.BLACK,

          }}>

            <Countdown endTs={activeEndTs} intervalS={activeIntervalS} />

          </div>

        </div>

        {/* was (open) · is (live) · by how much (delta) */}
        {hasAsks ? (
          <div style={{ display: 'flex', gap: SP.MD, width: '100%' }}>
            <InfoCard>
              {windowOpenPrice > 0
                ? <Flip value={windowOpenPrice} color="var(--tc-white)" fontSize={FS.MD} fontWeight="800" />
                : '—'}
            </InfoCard>
            <InfoCard>
              <LivePrice kind="value" asset={chartAsset} openPrice={windowOpenPrice} seed={chartPrice} />
            </InfoCard>
            <InfoCard>
              <LivePrice kind="delta" asset={chartAsset} openPrice={windowOpenPrice} seed={chartPrice} />
            </InfoCard>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: SP.MD, width: '100%' }}>
            <SkelBox w="100%" h={SZ.S70} radius={D.R_CARD} /><SkelBox w="100%" h={SZ.S70} radius={D.R_CARD} /><SkelBox w="100%" h={SZ.S70} radius={D.R_CARD} />
          </div>
        )}

        {/* Claim — resolved winners are redeemable but had no entry point here */}

        <MobileClaimBanner positions={positions} />

        {/* down (left) / up (right) — big */}
        {hasAsks ? (
          <div style={{ display: 'flex', gap: SP.MD, width: '100%' }}>
            <SideBtn direction="DOWN" tall /><SideBtn direction="UP" tall />
          </div>
        ) : (
          <div style={{ display: 'flex', gap: SP.MD, width: '100%' }}>
            <SideBtnSkeleton /><SideBtnSkeleton />
          </div>
        )}

        {/* presets (1-Tap) / size + CTA (Market·Limit) */}
        {hasAsks ? (
          buyMode === 'market' ? <ModeMarket /> : buyMode === 'limit' ? <ModeLimit /> : <Mode1Tap mobile />
        ) : (
          <div style={{ display: 'flex', gap: D.GAP_MD, width: '100%' }}>
            <PresetSkeleton /><PresetSkeleton /><PresetSkeleton /><PresetSkeleton />
          </div>
        )}

        {/* open positions — quick-sell */}
        {positionsLive.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: D.GAP_MD, width: '100%' }}>
            {positionsLive.map((p, i) => <SellBtn key={i} pos={p} />)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP.XXL, width: '100%', padding: `${SP.XXL} ${SP.XXL}` }}>
      {/* Header: countdown + 3 info cards */}
      {hasAsks ? (
        <div style={{ display: 'flex', gap: D.GAP_MD, width: '100%', height: '104px', alignItems: 'stretch' }}>
          <div style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'var(--tc-card-alt)', borderRadius: D.R_CARD, border: '1px solid var(--tc-active)',
                        boxShadow: 'var(--tc-elev-1)', padding: SP.MD,
                        fontSize: FS.DISPLAY, fontWeight: FW.BLACK, fontFamily: FONT.MONO, lineHeight: 1 }}>
            <Countdown endTs={activeEndTs} intervalS={activeIntervalS} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: D.GAP_MD, width: '120px', flexShrink: 0, height: '100%' }}>
            {/* Open price */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: 'var(--tc-card-alt)', borderRadius: D.R_BTN, border: '1px solid var(--tc-active)',
                          boxShadow: 'var(--tc-elev-1)' }}>
              {windowOpenPrice > 0
                ? <Flip value={windowOpenPrice} color="var(--tc-dim3)" fontSize={FS.BASE} fontWeight="700" />
                : <span style={{ color: 'var(--tc-dim3)', fontSize: FS.BASE, fontWeight: FW.BOLD, fontFamily: FONT.MONO }}>—</span>}
            </div>
            {/* Live price */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: 'var(--tc-card-alt)', borderRadius: D.R_BTN, border: '1px solid var(--tc-active)',
                          boxShadow: 'var(--tc-elev-1)', fontSize: FS.BASE, fontFamily: FONT.MONO }}>
              <LivePrice kind="value" asset={chartAsset} openPrice={windowOpenPrice} seed={chartPrice} />
            </div>
            {/* Delta */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: 'var(--tc-card-alt)', borderRadius: D.R_BTN, border: '1px solid var(--tc-active)',
                          boxShadow: 'var(--tc-elev-1)', fontSize: FS.BASE, fontWeight: FW.BOLD, fontFamily: FONT.MONO }}>
              <LivePrice kind="delta" asset={chartAsset} openPrice={windowOpenPrice} seed={chartPrice} />
            </div>
          </div>
        </div>
      ) : <BuyHeaderSkeleton />}

      <div style={{ height: SP.HAIR, width: '100%', background: 'var(--tc-panel)' }} />

      {/* UP / DOWN side buttons */}
      {hasAsks ? (
        <div style={{ display: 'flex', gap: D.GAP_MD, width: '100%' }}>
          <SideBtn direction="UP" /><SideBtn direction="DOWN" />
        </div>
      ) : (
        <div style={{ display: 'flex', gap: D.GAP_MD, width: '100%' }}>
          <SideBtnSkeleton /><SideBtnSkeleton />
        </div>
      )}

      {/* Mode-switched size + CTA */}
      {hasAsks ? (
        buyMode === 'market' ? <ModeMarket /> : buyMode === 'limit' ? <ModeLimit /> : <Mode1Tap />
      ) : (
        <div style={{ display: 'flex', gap: D.GAP_MD, width: '100%' }}>
          <PresetSkeleton /><PresetSkeleton /><PresetSkeleton /><PresetSkeleton />
        </div>
      )}

      {/* Open positions — quick-sell buttons under CTA */}
      {positionsLive.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: D.GAP_MD, width: '100%' }}>
          {positionsLive.map((p, i) => <SellBtn key={i} pos={p} />)}
        </div>
      )}
    </div>
  )
}

// ── Sell panel ────────────────────────────────────────────────────────────────

function SellSizeBtn({ s }: { s: string }) {
  const sellSize = useStore(s_ => s_.sell_size) as string
  const active = sellSize === s
  return (
    <div onClick={() => call('set_sell_size', s)}
         onMouseEnter={e => {
           if (!active) {
             e.currentTarget.style.borderColor = C.RED
             e.currentTarget.style.color = C.WHITE
           }
           playFx(e.currentTarget, 'pop')
         }}
         onMouseLeave={e => {
           if (!active) {
             e.currentTarget.style.borderColor = 'var(--tc-border)'
             e.currentTarget.style.color = 'var(--tc-dim2)'
           }
         }}
         style={{
           cursor: 'pointer', padding: `${SP.XS} ${SP.LG}`, borderRadius: '7px',
           fontSize: FS.SM, fontWeight: FW.BOLD, fontFamily: FONT.MONO, userSelect: 'none',
           color: active ? 'var(--tc-bg)' : 'var(--tc-dim2)',
           background: active ? C.RED : 'var(--tc-hover)',
           border: active ? `1px solid ${C.RED}` : '1px solid var(--tc-border)',
           transition: 'all 0.1s',
         }}>
      {s === 'all' ? STR.SIZE_ALL : s}
    </div>
  )
}

function PositionCard({ pos }: { pos: ComputedPosition }) {
  const sellSize = useStore(s => s.sell_size) as string
  const priced = (pos['cur_bid'] as number) > 0
  const valueNow = pos['value_usd'] as number ?? 0
  const pnl = pos['pnl_usd'] as number ?? 0
  const pnlColor = pnl >= 0 ? C.GREEN : C.RED
  const bestBid = pos['cur_bid'] as number ?? 0
  const dirColor = (pos['direction_color'] as string) ?? C.GREEN
  return (
    <div
      onMouseEnter={e => { e.currentTarget.style.borderColor = `rgba(${C.RED_RGB},0.53)`; playFx(e.currentTarget, 'pulse') }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--tc-border)' }}
      style={{ padding: `${SP.LG} ${SP.XL}`, borderRadius: D.R_CTRL, background: 'var(--tc-hover)',
                border: '1px solid var(--tc-border)', width: '100%', transition: 'all 0.12s' }}>
      <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: D.GAP_SM, flex: 1, minWidth: 0 }}>
          <div style={{ background: dirColor, borderRadius: '5px', padding: D.PAD_CHIP, display: 'inline-block', width: 'fit-content' }}>
            <span style={{ fontSize: FS.SM, fontWeight: FW.XBOLD, color: 'var(--tc-bg)' }}>
              {String(pos['asset_dir_label'] ?? '')}
            </span>
          </div>
          <span style={{ fontSize: FS.XS, fontWeight: FW.SEMI, fontFamily: FONT.MONO, color: 'var(--tc-dim2)' }}>
            {String(pos['size_str'] ?? '')}
          </span>
          {priced
            ? <span style={{ fontSize: FS.BASE, fontWeight: FW.BOLD, fontFamily: FONT.MONO, color: 'var(--tc-white)' }}>
                {bestBid.toFixed(1)}¢
              </span>
            : <span style={{ fontSize: FS.BASE, fontWeight: FW.BOLD, fontFamily: FONT.MONO, color: 'var(--tc-dim2)' }}>—</span>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: D.GAP_MD, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: D.GAP_MD }}>
            {priced
              ? <Flip value={valueNow} color="var(--tc-white)" fontSize={FS.LG} fontWeight="900" />
              : <span style={{ fontSize: FS.LG, fontWeight: FW.BLACK, fontFamily: FONT.MONO, color: 'var(--tc-dim2)' }}>—</span>}
            <div style={{ background: 'var(--tc-bg-deep)', border: '1px solid var(--tc-border)',
                          borderRadius: D.R_PILL, padding: `${SP.XXS} ${SP.SM}` }}>
              {priced
                ? <Flip value={pnl} format={{ signDisplay: 'always', style: 'currency', currency: 'USD' }}
                        color={pnlColor} fontSize={FS.XXS} fontWeight="800" />
                : <span style={{ fontSize: FS.XXS, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, color: 'var(--tc-dim2)' }}>—</span>}
            </div>
          </div>
          <div onClick={() => placeSell(String(pos['token'] ?? ''), Number(pos['shares'] ?? 0), sellSize)}
               onMouseEnter={e => {
                 if (priced) {
                   e.currentTarget.style.boxShadow = `0 4px 18px rgba(${C.RED_RGB},0.47)`
                   e.currentTarget.style.filter = 'brightness(1.06)'
                   playFx(e.currentTarget, 'shake')
                 }
               }}
               onMouseLeave={e => {
                 if (priced) {
                   e.currentTarget.style.boxShadow = `0 2px 10px rgba(${C.RED_RGB},0.27)`
                   e.currentTarget.style.filter = ''
                 }
               }}
               style={{
                 cursor: priced ? 'pointer' : 'default', padding: `${SP.XS} ${SP.XXL}`, borderRadius: D.R_BTN,
                 background: priced ? C.RED : 'var(--tc-active)', userSelect: 'none',
                 border: priced ? `1px solid ${C.RED}` : '1px solid var(--tc-border)',
                 boxShadow: priced ? `0 2px 10px rgba(${C.RED_RGB},0.27)` : 'none', transition: 'all 0.12s',
               }}>
            <span style={{ fontSize: FS.SM, fontWeight: FW.XBOLD, color: priced ? C.RED_TEXT : 'var(--tc-dim2)' }}>
              {sellSize === 'all' ? STR.SELL_ALL : `Sell $${sellSize}`}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function SellPanel() {
  const posLoading = useStore(s => s.pos_loading) as boolean
  const positions = (useStore(s => s.positions) ?? []) as Record<string, unknown>[]
  const tokenAsks = (useStore(s => s.token_asks) ?? {}) as Record<string, number>
  const tokenBids = (useStore(s => s.token_bids) ?? {}) as Record<string, number>
  const claimablePositions = positions.filter(p => (p['resolved'] as boolean) && (p['redeemable'] as boolean))
  const claimableCount = claimablePositions.length
  const claimableLabel = claimableCount === 1
    ? '1 resolved position ready to claim'
    : `${claimableCount} resolved positions ready to claim`
  const positionsLive = computePositionsLive(positions, tokenAsks, tokenBids)
    // Resolved positions route to CLAIM (banner above) — never the sell list.
    .filter(p => !(p['dust'] as boolean) && !(p['resolved'] as boolean))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP.XL, width: '100%', padding: SP.XXL }}>
      {/* Size selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: D.GAP_MD, width: '100%' }}>
        <span style={{ fontSize: FS.XXS, fontWeight: FW.BOLD, letterSpacing: '0.12em',
                       color: 'var(--tc-dim)', fontFamily: FONT.MONO }}>{STR.SELL_SIZE}</span>
        {['all', '5', '25', '50'].map(s => <SellSizeBtn key={s} s={s} />)}
        <div style={{ flex: 1 }} />
        {posLoading && <span style={{ fontSize: FS.XS, fontFamily: FONT.MONO, color: 'var(--tc-dim2)' }}>{STR.LOADING}</span>}
      </div>

      {posLoading ? (
        <span style={{ fontSize: FS.BASE, fontFamily: FONT.MONO, color: 'var(--tc-dim2)', padding: `${SP.LG} 0` }}>{STR.FETCHING_POS}</span>
      ) : (
        <>
          {claimableCount > 0 && (
            <div onClick={() => call('claim_winnings')}
                 className="tc-hoverlift"
                 onMouseEnter={e => playFx(e.currentTarget, 'glow')}
                 style={{ cursor: 'pointer', width: '100%', padding: `${SP.MD} ${SP.LG}`, marginBottom: SP.XS,
                          borderRadius: D.R_CTRL, border: `1px solid ${C.GREEN_BORDER}`,
                          background: C.GREEN_BG, display: 'flex', alignItems: 'center', gap: D.GAP_MD }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={C.GREEN} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
              <span style={{ color: C.GREEN, fontSize: FS.SM, fontWeight: FW.BOLD, fontFamily: FONT.MONO, flex: 1 }}>{claimableLabel}</span>
              <span style={{ color: 'var(--tc-bg)', fontSize: FS.XS, fontWeight: FW.XBOLD, fontFamily: FONT.MONO,
                             background: C.GREEN, padding: `${SP.XXS} ${SP.LG}`, borderRadius: D.R_SM }}>{STR.CLAIM}</span>
            </div>
          )}
          {positionsLive.length === 0 ? (
            <div style={{ padding: `${SP.H3} 0`, width: '100%', textAlign: 'center', display: 'flex',
                          flexDirection: 'column', alignItems: 'center', gap: D.GAP_SM }}>
              <span style={{ color: 'var(--tc-dim2)', fontSize: FS.MD, fontWeight: FW.SEMI, fontFamily: FONT.MONO }}>{STR.NO_POSITIONS}</span>
              <span style={{ color: 'var(--tc-dim)', fontSize: FS.XS, fontFamily: FONT.MONO }}>{STR.NO_POSITIONS_HINT}</span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: D.GAP_MD, width: '100%' }}>
              {positionsLive.map((p, i) => <PositionCard key={i} pos={p} />)}
            </div>
          )}
        </>
      )}

      <div style={{ width: '100%', textAlign: 'center', paddingTop: SP.XS }}>
        <span onClick={() => call('refresh_positions')}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--tc-white)'; playFx(e.currentTarget, 'spin') }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--tc-dim2)' }}
              style={{ cursor: 'pointer', display: 'inline-block', fontSize: FS.XS, fontWeight: FW.SEMI, fontFamily: FONT.MONO,
                       color: 'var(--tc-dim2)' }}>
          ↻ Refresh Positions
        </span>
      </div>
    </div>
  )
}

// ── Time-travel views ─────────────────────────────────────────────────────────

function ResolvedStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: D.GAP_SM,
                  padding: `${SP.MD} ${SP.XS}`, borderRadius: D.R_CARD, background: 'var(--tc-card-alt)',
                  border: '1px solid var(--tc-active)', boxShadow: 'var(--tc-elev-1)' }}>
      <span style={{ fontSize: FS.NANO, fontWeight: FW.XBOLD, letterSpacing: '0.1em', color: 'var(--tc-dim2)', fontFamily: FONT.MONO }}>
        {label}
      </span>
      <span style={{ fontSize: FS.MD, fontWeight: FW.XBOLD, color, fontFamily: FONT.MONO, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
    </div>
  )
}

function ResolvedView() {
  const viewedOutcomeRaw = useStore(s => s.viewed_outcome) as string
  const viewingSlot = useStore(s => s.viewing_slot) as string
  const slotResults = useStore(s => s.slot_results) as Record<string, string>
  // viewed_outcome is only set from the hindsight cache; for most past windows
  // the resolved winner lives in slot_results (keyed by start_ts) — fall back to
  // it so the panel doesn't sit on "RESOLVING…" forever.
  const viewedOutcome = viewedOutcomeRaw || (slotResults?.[viewingSlot] ?? '')
  const viewedHasData = viewedOutcome !== ''
  const viewedUpWon = viewedOutcome === 'UP'
  const viewedResultLabel = viewedOutcome === 'UP' ? '▲ UP WON' : viewedOutcome === 'DOWN' ? '▼ DOWN WON' : 'RESOLVING…'
  const viewedResultColor = viewedOutcome === 'UP' ? C.GREEN : viewedOutcome === 'DOWN' ? C.RED : 'var(--tc-dim2)'
  // Label: format HH:MM from the slot ts stored in viewing_slot
  const slotTs = parseInt(viewingSlot) || 0
  const viewedLabel = slotTs
    ? (() => { const d = new Date(slotTs * 1000); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` })()
    : ''
  // Price strings come from server-patched fields; accessed via unknown to avoid strict Store type
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewedOpenStr = String((useStore(s => (s as any).viewed_open_str)) ?? '—')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewedSettleStr = String((useStore(s => (s as any).viewed_settle_str)) ?? '—')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewedDeltaStr = String((useStore(s => (s as any).viewed_delta_str)) ?? '—')
  const wonGlow = viewedHasData ? (viewedUpWon ? 'var(--tc-glow-up)' : 'var(--tc-glow-down)') : 'var(--tc-elev-1)'
  const wonTint = viewedHasData ? (viewedUpWon ? 'var(--tc-up-tint)' : 'var(--tc-down-tint)') : 'var(--tc-card-alt)'
  const wonBrd = viewedHasData ? (viewedUpWon ? `1px solid ${C.GREEN}` : `1px solid ${C.RED}`) : '1px solid var(--tc-border-hi)'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP.XL, width: '100%', padding: SP.XXL }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.SM, width: '100%' }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0, color: 'var(--tc-dim2)' }}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span style={{ fontSize: FS.XXS, fontWeight: FW.XBOLD, letterSpacing: '0.12em', color: 'var(--tc-dim2)', fontFamily: FONT.MONO }}>{STR.PAST_WINDOW}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: FS.SM, fontWeight: FW.BOLD, color: 'var(--tc-white)', fontFamily: FONT.TIME, letterSpacing: '0.02em' }}>{viewedLabel}</span>
      </div>
      <div className="tc-fadein" style={{ width: '100%', padding: `${SP.H3} ${SP.XL}`, borderRadius: '14px', textAlign: 'center',
                                          background: wonTint, border: wonBrd, boxShadow: wonGlow }}>
        <span style={{ fontSize: FS.H1, fontWeight: FW.BLACK, fontFamily: FONT.MONO,
                       color: viewedHasData ? viewedResultColor : 'var(--tc-dim2)' }}>
          {viewedResultLabel}
        </span>
      </div>
      <div style={{ display: 'flex', gap: D.GAP_MD, width: '100%' }}>
        <ResolvedStat label={STR.STAT_OPEN} value={viewedOpenStr} color="var(--tc-dim)" />
        <ResolvedStat label={STR.STAT_SETTLE} value={viewedSettleStr} color={viewedResultColor} />
        <ResolvedStat label={STR.STAT_CHANGE} value={viewedDeltaStr} color={viewedResultColor} />
      </div>
      <div onClick={() => call('slots_live')}
           className="tc-glass tc-back-live tc-hoverlift"
           onMouseEnter={e => playFx(e.currentTarget, 'pulse')}
           style={{ cursor: 'pointer', width: '100%', padding: `${SP.LG} ${SP.XXL}`, borderRadius: '13px',
                    border: `1px solid ${C.GREEN}`, color: C.GREEN, boxSizing: 'border-box',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SP.MD }}>
        {/* pulsing live dot */}
        <span style={{ width: SP.MD, height: SP.MD, borderRadius: '50%', background: C.GREEN,
                       boxShadow: `0 0 8px ${C.GREEN}`, flexShrink: 0,
                       animation: 'tcpulse 2s ease-in-out infinite' }} />
        <span style={{ fontSize: FS.BASE, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, letterSpacing: '0.05em' }}>
          {STR.BACK_TO_LIVE}
        </span>
        <svg className="tc-bl-arrow" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </div>
    </div>
  )
}

function ForwardView() {
  const viewingSlot = useStore(s => s.viewing_slot) as string
  const slotTs = parseInt(viewingSlot) || 0
  const viewedLabel = slotTs
    ? (() => { const d = new Date(slotTs * 1000); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` })()
    : ''
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP.XL, width: '100%', padding: SP.XXL }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.SM, width: '100%' }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0, color: 'var(--tc-dim2)' }}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span style={{ fontSize: FS.XXS, fontWeight: FW.XBOLD, letterSpacing: '0.12em', color: 'var(--tc-dim2)', fontFamily: FONT.MONO }}>{STR.NEXT_WINDOW}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: FS.SM, fontWeight: FW.BOLD, color: 'var(--tc-white)', fontFamily: FONT.TIME, letterSpacing: '0.02em' }}>{viewedLabel}</span>
      </div>
      <div className="tc-fadein" style={{ width: '100%', padding: `${SP.XXL} ${SP.XL}`, borderRadius: '14px', textAlign: 'center',
                                          background: 'var(--tc-card-alt)', border: `1px solid rgba(245,158,11,0.27)`,
                                          boxShadow: 'var(--tc-glow-gold)' }}>
        <span style={{ fontSize: FS.H2, fontWeight: FW.BLACK, fontFamily: FONT.MONO, color: C.GOLD }}>{STR.OPENS_SOON}</span>
      </div>
      <div style={{ display: 'flex', gap: D.GAP_MD, width: '100%' }}>
        {[['▲ UP', '50¢', C.GREEN], ['▼ DOWN', '50¢', C.RED]].map(([label, val, color]) => (
          <div key={label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: D.GAP_MD,
                                    padding: `${SP.XXL} ${SP.XS}`, borderRadius: '12px', background: 'var(--tc-card-alt)',
                                    border: '1px solid var(--tc-active)', boxShadow: 'var(--tc-elev-1)' }}>
            <span style={{ fontSize: FS.XXS, fontWeight: FW.XBOLD, letterSpacing: '0.08em', color: 'var(--tc-dim2)', fontFamily: FONT.MONO }}>{label}</span>
            <span style={{ fontSize: FS.H1, fontWeight: FW.BLACK, color, fontFamily: FONT.MONO, lineHeight: 1 }}>{val}</span>
          </div>
        ))}
      </div>
      <span style={{ fontSize: FS.XS, color: 'var(--tc-dim2)', fontFamily: FONT.MONO, textAlign: 'center' }}>
        {STR.WINDOW_FLAT}
      </span>
      <div onClick={() => call('slots_live')}
           className="tc-glass tc-back-live tc-hoverlift"
           onMouseEnter={e => playFx(e.currentTarget, 'pulse')}
           style={{ cursor: 'pointer', width: '100%', padding: `${SP.LG} ${SP.XXL}`, borderRadius: '13px',
                    border: `1px solid ${C.GREEN}`, color: C.GREEN, boxSizing: 'border-box',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SP.MD }}>
        {/* pulsing live dot */}
        <span style={{ width: SP.MD, height: SP.MD, borderRadius: '50%', background: C.GREEN,
                       boxShadow: `0 0 8px ${C.GREEN}`, flexShrink: 0,
                       animation: 'tcpulse 2s ease-in-out infinite' }} />
        <span style={{ fontSize: FS.BASE, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, letterSpacing: '0.05em' }}>
          {STR.BACK_TO_LIVE}
        </span>
        <svg className="tc-bl-arrow" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </div>
    </div>
  )
}

// ── Panel tab strip ───────────────────────────────────────────────────────────

function PanelTab({ rawTab }: { rawTab: string }) {
  const panelTab = rawTab === 'positions' ? 'sell' : rawTab
  const tabs: { key: string; label: string; color: string }[] = [
    { key: 'buy',  label: STR.BUY,  color: C.GREEN },
    { key: 'sell', label: STR.SELL, color: C.RED   },
    { key: 'book', label: STR.BOOK, color: C.GOLD  },
  ]
  return (
    <div style={{ display: 'flex', alignItems: 'center', width: '100%',
                  borderBottom: '1px solid var(--tc-border)', flexShrink: 0 }}>
      {tabs.map(tab => {
        const active = panelTab === tab.key
        return (
          <div
            key={tab.key}
            onClick={() => call('set_panel_tab', tab.key)}
            onMouseEnter={e => { if (!active) (e.currentTarget.querySelector('span') as HTMLElement).style.color = C.WHITE; playFx(e.currentTarget.querySelector('span'), 'pulse') }}
            onMouseLeave={e => { if (!active) (e.currentTarget.querySelector('span') as HTMLElement).style.color = C.DIM2 }}
            style={{
              cursor: 'pointer', padding: `${SP.MD} ${SP.XXL}`, userSelect: 'none',
              borderBottom: active ? `2px solid ${tab.color}` : '2px solid transparent',
              marginBottom: '-1px',
              transition: 'all 0.12s',
            }}>
            <span style={{
              display: 'inline-block',
              fontSize: FS.SM, fontWeight: FW.BOLD, fontFamily: FONT.MONO,
              color: active ? C.WHITE : C.DIM2,
              transition: 'all 0.12s',
            }}>
              {tab.label}
            </span>
          </div>
        )
      })}
      <div style={{ flex: 1 }} />
      {panelTab === 'sell' && (
        <span
          onClick={() => call('refresh_positions')}
          onMouseEnter={e => { e.currentTarget.style.color = C.WHITE; playFx(e.currentTarget, 'spin') }}
          onMouseLeave={e => { e.currentTarget.style.color = C.DIM2 }}
          style={{ cursor: 'pointer', display: 'inline-block', color: C.DIM2, fontSize: FS.XL, padding: `${SP.SM} ${SP.LG}`,
                   transition: 'all 0.12s' }}
          title={STR.REFRESH_POS}
        >↻</span>
      )}
    </div>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────

function TradingBarInner({ mobile = false }: { mobile?: boolean } = {}) {
  const viewingFuture = useStore(s => s.viewing_future) as boolean
  const viewingSlot = useStore(s => s.viewing_slot) as string
  const rawTab = useStore(s => s.panel_tab) as string
  const viewing = !viewingFuture && viewingSlot !== ''
  const panelTab = rawTab === 'positions' ? 'sell' : rawTab

  let body: ReactNode
  if (panelTab === 'sell') {
    body = <SellPanel />
  } else if (panelTab === 'book') {
    body = <OrderBook />
  } else {
    // buy tab — time-travel views override
    if (viewingFuture) {
      body = <ForwardView />
    } else if (viewing) {
      body = <ResolvedView />
    } else {
      body = <BuyPanel mobile={mobile} />
    }
  }

  return (
    <div className="tc-grad tc-trading-bar" style={{
      display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
      background: 'var(--tc-panel)', overflow: 'hidden', gap: 0,
    }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none' }}>
        {body}
      </div>
    </div>
  )
}

// Memoised: App is the root and re-renders on theme/mode/wallet changes.
// These panels take no props (or one stable one) and read what they need from
// the store themselves, so a parent re-render should never cascade into them.
export const TradingBar = React.memo(TradingBarInner)
