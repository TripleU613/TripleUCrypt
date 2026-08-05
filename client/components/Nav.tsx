import { useEffect, useRef, useState } from 'react'
import { animate, stagger } from 'animejs'
import { useStore } from '../store.js'
import { call } from '../api.js'
import { WindowNav } from './nav/WindowNav.js'
import { useDragOrder } from '../lib/useDragOrder.js'
import { C, FONT, D, MS, STR, SP, SZ, FS, FW } from '../constants/index.js'

// ── Brand wordmark — a "light" bursts across the letters via anime.js grid
// stagger (the official stagger-grid demo): each letter brightens with a glow,
// its delay staggered by grid position FROM A RANDOM ORIGIN, and re-fires from
// a new random origin every cycle (onComplete → replay). ────────────────────
// The brand is the logo + the wordmark as ONE unit: the same "light" burst
// (grid stagger from a random origin, re-firing each cycle) sweeps across the
// icon and every letter together. The bare icon (no container) glows via a
// drop-shadow as the wave passes it.
function Brand() {
  const ref = useRef<HTMLDivElement>(null)
  const chars = 'TripleUCrypt'.split('')
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const targets = el.querySelectorAll('.tc-brand-el') // icon + chars
    if (!targets.length) return
    let alive = true
    const n = targets.length
    const play = () => {
      if (!alive) return
      animate(targets, {
        color: [{ to: 'var(--tc-text-strong)' }, { to: '#2b2b2b' }],          // the light-burst — lights the icon (fill=currentColor) + letters identically
        textShadow: [{ to: '0 0 9px currentColor' }, { to: '0 0 0px currentColor' }],
        duration: 2600,
        ease: 'inOutSine',
        delay: stagger(280, { grid: [n, 1], from: Math.floor(Math.random() * n) }),
        onComplete: play,
      })
    }
    play()
    return () => { alive = false }
  }, [chars.length])
  return (
    <div ref={ref} aria-label="TripleUCrypt" style={{ display: 'flex', alignItems: 'center', gap: D.GAP_SM }}>
      {/* inline SVG with fill=currentColor — lights up via the SAME `color` wave as
          the letters, so the burst sweeps through the icon as one continuous piece */}
      <svg className="tc-brand-el" width="22" height="22" viewBox="0 0 512 512" fill="none"
           aria-hidden="true" style={{ display: 'block', flexShrink: 0, color: '#2b2b2b' }}>
        <path fill="currentColor" d="M375.84 389.422C375.84 403.572 375.84 410.647 371.212 414.154C366.585 417.662 359.773 415.75 346.15 411.927L127.22 350.493C119.012 348.19 114.907 347.038 112.534 343.907C110.161 340.776 110.161 336.513 110.161 327.988V184.012C110.161 175.487 110.161 171.224 112.534 168.093C114.907 164.962 119.012 163.81 127.22 161.507L346.15 100.072C359.773 96.2495 366.585 94.338 371.212 97.8455C375.84 101.353 375.84 108.428 375.84 122.578V389.422ZM164.761 330.463L346.035 381.337V279.595L164.761 330.463ZM139.963 306.862L321.201 256L139.963 205.138V306.862ZM164.759 181.537L346.035 232.406V130.663L164.759 181.537Z" />
      </svg>
      <span style={{ fontWeight: FW.XBOLD, fontSize: FS.XL, fontFamily: FONT.SANS, letterSpacing: '-0.03em', color: '#2b2b2b', whiteSpace: 'nowrap' }}>
        {chars.map((c, i) => (
          <span key={i} className="tc-brand-el tc-wm-char" style={{ display: 'inline-block' }}>{c}</span>
        ))}
      </span>
    </div>
  )
}

// ── Formatted stat helpers (mirrors stat_*_str in Python) ────────────────────

function abbrevMoney(v: number): string {
  const a = Math.abs(v)
  if (a >= 1_000_000) return `$${(a / 1_000_000).toFixed(1)}M`.replace('.0M', 'M')
  if (a >= 10_000)    return `$${(a / 1_000).toFixed(0)}k`
  if (a >= 1_000)     return `$${(a / 1_000).toFixed(1)}k`.replace('.0k', 'k')
  if (a >= 100)       return `$${a.toFixed(0)}`
  return `$${a.toFixed(2)}`
}

function fmtCash(n: number, fresh: boolean): string {
  return fresh ? abbrevMoney(n) : '—'
}
function fmtProfit(n: number, fresh: boolean): string {
  if (!fresh) return '—'
  const sign = n >= 0 ? '+' : '-'
  return sign + abbrevMoney(n)
}
function profitColor(n: number, fresh: boolean): string {
  if (!fresh) return C.DIM
  return n >= 0 ? C.GREEN : C.RED
}
function fmtPct(n: number, fresh: boolean): string {
  return fresh ? `${n.toFixed(0)}%` : '—'
}
function fmtWallet(n: number, hasWallet: boolean, fresh: boolean): string {
  if (!fresh) return '—'
  return hasWallet ? abbrevMoney(n) : '$0.00'
}

// ── Scoreboard: label-less icon chips with a clever hover-reveal ─────────────
// Resting state is just icon + value. Hovering anywhere in the cluster collapses
// every chip to its icon to free space; the chip you're actually over expands to
// reveal its label + a plain-English explanation. Pure CSS sibling-aware flex,
// so the whole row reflows smoothly (see .tc-scoreboard in theme.ts).

function ChipIcon({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3"
         strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0, color }}>
      {children}
    </svg>
  )
}

interface ChipDef {
  key: string; icon: React.ReactNode; value: React.ReactNode
  color: string; label: string; detail: string; cls?: string
}

// All scoreboard chips for the current mode (store reads + render data).
function useChips(): ChipDef[] {
  const cash      = useStore(s => s.stat_cash)
  const spendable = useStore(s => s.stat_spendable)
  const walletBal = useStore(s => s.stat_wallet)
  const hasWallet = useStore(s => s.stat_has_wallet)
  const profit    = useStore(s => s.stat_profit)
  const accuracy  = useStore(s => s.stat_accuracy)
  const wins      = useStore(s => s.stat_wins)
  const losses    = useStore(s => s.stat_losses)
  const fresh     = useStore(s => s.stats_fresh)
  const practice  = useStore(s => s.practice)

  const record = fresh
    ? (<><span style={{ color: C.GREEN }}>{wins}</span><span style={{ color: C.DIM }}>–</span><span style={{ color: C.RED }}>{losses}</span></>)
    : '—'

  return [
    { key: 'cash', cls: 'tc-stat-core', color: C.WHITE, value: fmtCash(cash, fresh),
      label: STR.STAT_CASH, detail: STR.DET_CASH,
      icon: <ChipIcon color={C.WHITE}><circle cx="12" cy="12" r="9" /><path d="M14.6 9.4c-.5-1-1.5-1.4-2.6-1.4-1.5 0-2.6.9-2.6 2s1 1.5 2.6 2 2.6 1 2.6 2-1.1 2-2.6 2c-1.1 0-2.1-.5-2.6-1.5M12 6.4v11.2" /></ChipIcon> },
    { key: 'spend', cls: 'tc-stat-core', color: C.WHITE, value: fmtCash(spendable, fresh),
      label: STR.STAT_SPEND, detail: STR.DET_SPEND,
      icon: <ChipIcon color={C.WHITE}><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.2" /><path d="M6 12h.01M18 12h.01" /></ChipIcon> },
    ...(!practice ? [{ key: 'wallet', cls: 'tc-stat-extra', color: C.WHITE, value: fmtWallet(walletBal, hasWallet, fresh),
      label: STR.STAT_WALLET, detail: STR.DET_WALLET,
      icon: <ChipIcon color={C.WHITE}><path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4" /><path d="M4 6v12c0 1.1.9 2 2 2h14v-4" /><path d="M18 12a2 2 0 0 0 0 4h4v-4z" /></ChipIcon> } as ChipDef] : []),
    { key: 'profit', cls: 'tc-stat-core', color: profitColor(profit, fresh), value: fmtProfit(profit, fresh),
      label: STR.STAT_PROFIT, detail: STR.DET_PROFIT,
      icon: <ChipIcon color={profitColor(profit, fresh)}><path d="M3 17l6-6 4 4 7-7" /><path d="M14 7h7v7" /></ChipIcon> },
    { key: 'acc', cls: 'tc-stat-core', color: C.CYAN, value: fmtPct(accuracy, fresh),
      label: STR.STAT_ACC, detail: STR.DET_ACC,
      icon: <ChipIcon color={C.CYAN}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.4" /></ChipIcon> },
    { key: 'record', cls: 'tc-stat-wl', color: C.WHITE, value: record,
      label: STR.STAT_RECORD, detail: STR.DET_RECORD,
      icon: <ChipIcon color={C.GOLD}><path d="M7 4h10v4a5 5 0 0 1-10 0z" /><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3M9 16h6M10 16v-2.5M14 16v-2.5M8 20h8" /></ChipIcon> },
  ]
}

// ── Tooltip wrapper (nav_008) — styled popover, replaces native title ─────────

function Tooltip({ content, children }: { content: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      {open && (
        <span style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)',
          background: 'var(--tc-panel)', border: '1px solid var(--tc-border)', color: 'var(--tc-text)',
          borderRadius: D.R_SM, padding: `${SP.XS} ${SP.MD}`, fontSize: FS.XS, fontFamily: FONT.MONO,
          whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 99999, boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
        }}>{content}</span>
      )}
    </span>
  )
}

// ── Toggle button (shared shape) ──────────────────────────────────────────────

function ToggleBtn({
  onClick, title, active = false, children,
}: {
  onClick: () => void
  title: string
  active?: boolean
  children: React.ReactNode
}) {
  // Skeletonized + colorless: hollow frame, white when active, dim otherwise.
  const iconRef = useRef<HTMLSpanElement>(null)
  const spin = () => {
    if (iconRef.current) animate(iconRef.current, { rotate: [0, 360], duration: 600, ease: 'inOutQuad' })
  }
  return (
    <div
      onClick={onClick}
      onMouseEnter={spin}
      className="tc-hoverlift"
      title={title}
      style={{
        cursor: 'pointer', padding: D.PAD_BTN, borderRadius: D.R_BTN,
        border: `1px solid ${active ? C.WHITE : 'var(--tc-border-hi)'}`,
        background: 'transparent', boxSizing: 'border-box',
        flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: `all ${MS.TRANSITION_QUICK}ms`,
      }}
    >
      <span ref={iconRef} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        {children}
      </span>
    </div>
  )
}

// ── Inline SVG icons (lucide style: 24×24 vb, stroke-based, sw 2.5) ──────────

const IC: React.CSSProperties = { display: 'block', flexShrink: 0 }

// zap (1-tap buy mode / instant sign)
function IcoZap({ color }: { color: string }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ ...IC, color }}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
}
// gauge / speedometer (market buy mode)
function IcoGauge({ color }: { color: string }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ ...IC, color }}><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>
}
// target / crosshair (limit buy mode)
function IcoTarget({ color }: { color: string }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ ...IC, color }}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
}
// gamepad-2 (practice mode)
function IcoGamepad({ color }: { color: string }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ ...IC, color }}><line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><rect x="2" y="6" width="20" height="12" rx="2"/></svg>
}
// banknote (live/real-money mode)
function IcoBanknote({ color }: { color: string }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ ...IC, color }}><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>
}
// rotate-ccw (refill)
function IcoRotateCCW({ color }: { color: string }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ ...IC, color }}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
}
// wallet (wallet panel)
function IcoWallet({ color }: { color: string }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ ...IC, color }}><path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>
}
// shield-check (wallet signing)
function IcoShieldCheck({ color }: { color: string }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ ...IC, color }}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
}
// key (instant / server-side signing)
function IcoKey({ color }: { color: string }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ ...IC, color }}><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>
}
// sun (light theme)
function IcoSun({ color }: { color: string }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ ...IC, color }}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
}
// moon (dark theme)
function IcoMoon({ color }: { color: string }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ ...IC, color }}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
}

// ── Buy-mode icon ──────────────────────────────────────────────────────────────

function BuyModeIcon({ mode }: { mode: string }) {
  if (mode === 'market') return <IcoGauge color={C.WHITE} />
  if (mode === 'limit')  return <IcoTarget color={C.WHITE} />
  return <IcoZap color={C.WHITE} />
}

// ── Nav ───────────────────────────────────────────────────────────────────────

// Every top-bar widget is one draggable item in a single shared order, so any
// control or stat can be placed anywhere — left, right, or across the centre.
// 'gap' is a flexible spacer the brand floats over; 'walletToggle' is the live
// wallet button (distinct from the on-chain 'wallet' chip).
const NAV_ORDER = [
  'buymode', 'practice', 'refill', 'walletToggle', 'theme', 'carousel',
  'gap',
  'cash', 'spend', 'wallet', 'profit', 'acc', 'record',
]
const CTRL_IDS = new Set(['buymode', 'practice', 'refill', 'walletToggle', 'theme', 'carousel'])

export function Nav() {
  const practice = useStore(s => s.practice)
  const buyMode = useStore(s => s.buy_mode)
  const theme = useStore(s => s.theme)
  const showWallet = useStore(s => s.show_wallet)

  const bmTitle: Record<string, string> = { market: STR.BUY_MODE_MARKET, limit: STR.BUY_MODE_LIMIT }

  const chips = useChips()
  const chipMap: Record<string, ChipDef> = Object.fromEntries(chips.map(c => [c.key, c]))

  // One shared order for the whole bar (persisted).
  const dnd = useDragOrder('tc-nav-all-v1', NAV_ORDER)
  // Chip hover-expand (CSS) — opens toward the bar centre (so it never reveals
  // into a wall); suppressed while dragging.
  const [active, setActive] = useState<{ id: string; dir: 'l' | 'r' } | null>(null)
  useEffect(() => { if (dnd.dragging) setActive(null) }, [dnd.dragging])

  const present = (id: string): boolean => {
    if (id === 'gap') return true
    if (id === 'refill') return practice
    if (id === 'walletToggle') return !practice
    if (CTRL_IDS.has(id)) return true
    return !!chipMap[id]   // chips present for the current mode
  }

  // Explanation shown by the expanding tc-chip-det on hover (same as the stats).
  const ctrlDetail = (id: string): string => {
    switch (id) {
      case 'buymode': return bmTitle[buyMode] ?? STR.BUY_MODE_1TAP
      case 'practice': return practice ? STR.PRACTICE_ON : STR.PRACTICE_OFF
      case 'refill': return STR.REFILL
      case 'walletToggle': return showWallet ? STR.WALLET_OPEN : STR.WALLET_CLOSED
      case 'theme': return STR.THEME_TOGGLE
      default: return ''
    }
  }

  const renderCtrl = (id: string): React.ReactNode => {
    switch (id) {
      case 'buymode':
        return <ToggleBtn onClick={() => call('cycle_buy_mode')} title=""><BuyModeIcon mode={buyMode} /></ToggleBtn>
      case 'practice':
        return <ToggleBtn onClick={() => call('toggle_practice')} title="">{practice ? <IcoGamepad color={C.WHITE} /> : <IcoBanknote color={C.WHITE} />}</ToggleBtn>
      case 'refill':
        return <ToggleBtn onClick={() => call('reset_practice')} title=""><IcoRotateCCW color={C.WHITE} /></ToggleBtn>
      case 'walletToggle':
        return <ToggleBtn onClick={() => call('toggle_wallet')} title="" active={showWallet}><IcoWallet color={C.WHITE} /></ToggleBtn>
      case 'theme':
        return <ToggleBtn onClick={() => {
          const d = document.documentElement
          d.classList.add('tc-theming')
          const next = d.getAttribute('data-theme') === 'light' ? 'dark' : 'light'
          d.setAttribute('data-theme', next)
          setTimeout(() => d.classList.remove('tc-theming'), 340)
          call('toggle_theme')
        }} title="">{theme === 'light' ? <IcoSun color={C.WHITE} /> : <IcoMoon color={C.WHITE} />}</ToggleBtn>
      default:
        return null
    }
  }

  const renderItem = (id: string): React.ReactNode => {
    if (id === 'gap') return <div key="gap" style={{ flex: 1, minWidth: SZ.S40 }} />
    if (id === 'carousel') {
      // Embla owns pointer gestures inside the carousel, so it can't host the
      // reorder press-hold directly. Keep the ref + data-dragid on the wrapper
      // (for FLIP + drop math) but route the reorder pointerdown through a small
      // grip handle that Embla never sees.
      const { onPointerDown, ...rest } = dnd.itemProps(id)
      return (
        <div key={id} {...rest} style={{ display: 'flex', alignItems: 'center', flexShrink: 0, minWidth: 0 }}>
          <div data-spot="carousel" style={{ display: 'flex', alignItems: 'center', width: '144px', minWidth: 0, overflow: 'visible' }}>
            <WindowNav onGripPointerDown={onPointerDown} dragging={dnd.dragging === id} />
          </div>
        </div>
      )
    }
    if (CTRL_IDS.has(id)) {
      // Hover-expand like the stats: the label slides OUT inline, widening the
      // item so the flex row pushes the neighbours over to make room.
      const on = active?.id === id
      return (
        <div
          key={id}
          {...dnd.itemProps(id)}
          data-chip={id}
          onMouseEnter={() => { if (!dnd.dragging) setActive({ id, dir: 'r' }) }}
          style={{
            display: 'flex', alignItems: 'center', flexShrink: 0, touchAction: 'none',
            borderRadius: D.R_BTN, background: on ? 'var(--tc-hover)' : 'transparent',
            transition: 'background-color 0.18s var(--tc-ease)',
          }}
        >
          {renderCtrl(id)}
          <span style={{
            overflow: 'hidden', whiteSpace: 'nowrap', display: 'inline-block',
            maxWidth: on ? '320px' : SP.NONE, opacity: on ? 1 : 0,
            marginLeft: on ? SP.XS : SP.NONE, paddingRight: on ? SP.SM : SP.NONE,
            transition: 'max-width 0.28s var(--tc-ease), opacity 0.2s var(--tc-ease), margin 0.28s var(--tc-ease), padding 0.28s var(--tc-ease)',
            fontFamily: FONT.MONO, fontSize: FS.SM, fontWeight: FW.BOLD, color: 'var(--tc-text-2, #b9c0cc)', lineHeight: 1.5,
          }}>
            {ctrlDetail(id)}
          </span>
        </div>
      )
    }
    const c = chipMap[id]
    if (!c) return null
    return (
      <div
        key={id}
        {...dnd.itemProps(id)}
        data-chip={id}
        onMouseEnter={(e) => {
          if (dnd.dragging) return
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setActive({ id, dir: (r.left + r.width / 2) < window.innerWidth / 2 ? 'r' : 'l' })
        }}
        style={{ touchAction: 'none' }}
        className={`tc-chip${c.cls ? ' ' + c.cls : ''}${active?.id === id ? ` is-active exp-${active.dir}` : ''}`}
      >
        {c.icon}
        <span className="tc-chip-val" style={{
          fontFamily: FONT.MONO, fontSize: FS.BASE, fontWeight: FW.XBOLD, color: c.color,
          lineHeight: 1, fontVariantNumeric: 'tabular-nums',
        }}>
          {c.value}
        </span>
        <span className="tc-chip-det"><b>{c.label}</b> {c.detail}</span>
      </div>
    )
  }

  return (
    <div
      className="tc-grad-card"
      style={{
        position: 'relative',
        width: '100%', display: 'flex', alignItems: 'center',
        paddingLeft: '0.85rem', paddingRight: '0.85rem', height: D.H_NAV,
        background: 'var(--tc-card)',
        border: '1px solid var(--tc-border)', borderRadius: D.R_CARD,
        boxShadow: 'var(--tc-elev-1)', flexShrink: 0,
      }}
    >
      {/* one shared row — every control/stat draggable anywhere; the brand
          floats over the centre gap */}
      <div
        className={`tc-scoreboard${active ? ' has-active' : ''}`}
        data-spot="wallet"
        onMouseLeave={() => setActive(null)}
        style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', width: '100%', minWidth: 0 }}
      >
        {dnd.order.filter(present).flatMap(id => {
          const node = renderItem(id)
          return dnd.dragging && dnd.dropBefore === id
            ? [<span key={`dm-${id}`} className="tc-drag-mark" />, node]
            : [node]
        })}
        {dnd.dragging && dnd.dropBefore === '__end__' && <span key="dm-end" className="tc-drag-mark" />}
      </div>

      {/* Brand — floats centred over the gap */}
      <div
        data-spot="brand"
        style={{
          position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
          display: 'flex', alignItems: 'center', gap: D.GAP_MD, pointerEvents: 'none',
        }}
      >
        <Brand />
      </div>
    </div>
  )
}
