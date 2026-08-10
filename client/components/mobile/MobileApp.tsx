/**
 * Mobile surface — a fully separate single-column app for ≤768px.
 * Desktop (App.tsx three-column layout) is untouched; App picks one or the other
 * at the root. Everything here reuses the same store-driven panels.
 *
 * Layout (top → bottom):
 *   row 1  [theme][buymode]            [stats strip ⇆]
 *   row 2  [line|%|candle]             [time window]      (chart views only)
 *   body   <view>                                          (scrolls)
 *   tabs   Home/Wallet/Refill · Game⇄Real · Market · Activity
 */

import React, { useEffect, useState } from 'react'
import { useStore } from '../../store.js'
import { call } from '../../api.js'
import { ChartView } from '../ChartView.js'
import { TradingBar } from '../TradingBar.js'
import { MarketPanel } from '../MarketPanel.js'
import { WalletPanel } from '../WalletPanel.js'
import { WindowNav } from '../nav/WindowNav.js'
import { ghostSegStyle } from '../shared/ui.js'
import { INTERVALS } from '../../lib/intervals.js'
import { C, FONT, D, SP, SZ, FS, FW, STR } from '../../constants/index.js'

type View = 'home' | 'activity' | 'wallet'

// ── Stat formatting (mirrors Nav.tsx) ────────────────────────────────────────
function abbrevMoney(v: number): string {
  const a = Math.abs(v)
  if (a >= 1_000_000) return `$${(a / 1_000_000).toFixed(1)}M`.replace('.0M', 'M')
  if (a >= 10_000)    return `$${(a / 1_000).toFixed(0)}k`
  if (a >= 1_000)     return `$${(a / 1_000).toFixed(1)}k`.replace('.0k', 'k')
  if (a >= 100)       return `$${a.toFixed(0)}`
  return `$${a.toFixed(2)}`
}

// ── Icons ─────────────────────────────────────────────────────────────────────
function Svg({ children, size = 18 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      {children}
    </svg>
  )
}
const IcoHome    = () => <Svg><path d="M3 9.5 12 3l9 6.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" /></Svg>
const IcoWallet  = () => <Svg><path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1" /><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2z" /><circle cx="16.5" cy="13" r="1" /></Svg>
const IcoRefresh = () => <Svg><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></Svg>
const IcoGamepad = () => <Svg><path d="M6 11h4M8 9v4" /><circle cx="15.5" cy="11" r="0.6" /><circle cx="17.5" cy="13" r="0.6" /><path d="M17.3 5H6.7A4.7 4.7 0 0 0 2 9.7L1 16a2 2 0 0 0 3.5 1.6L6.5 15h11l2 2.6A2 2 0 0 0 23 16l-1-6.3A4.7 4.7 0 0 0 17.3 5z" /></Svg>
const IcoCash    = () => <Svg><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /></Svg>
const IcoList    = () => <Svg><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" /></Svg>

// Monochrome coin icon for the current market — the mono PNGs in /coins/mono are
// rendered as a currentColor mask so they follow the tab colour + OS theme.
// Falls back to a ticker glyph in a ring for any asset without an icon file.
const COIN_GLYPH: Record<string, string> = {
  BTC: '₿', ETH: 'Ξ', SOL: '◎', XRP: '✕', DOGE: 'Ð', HYPE: 'H', BNB: 'B',
}
// web3icons mono SVGs where available; icons8 mono PNGs for doge/hype (web3icons
// has no DOGE/HYPE mono glyph). Both render as a currentColor mask.
const MONO_EXT: Record<string, string> = {
  BTC: 'svg', ETH: 'svg', SOL: 'svg', XRP: 'svg', BNB: 'svg', DOGE: 'png', HYPE: 'png',
}
function CoinIcon() {
  const asset = (useStore(s => s.chart_asset) || 'BTC').toUpperCase()
  const ext = MONO_EXT[asset]
  if (!ext) {
    return (
      <span style={{
        width: 21, height: 21, borderRadius: '50%', border: '1.6px solid currentColor',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: FS.XXS, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, lineHeight: 1,
      }}>{COIN_GLYPH[asset] ?? asset[0] ?? '$'}</span>
    )
  }
  const url = `/coins/mono/${asset.toLowerCase()}.${ext}`
  return (
    <span style={{
      width: 22, height: 22, display: 'inline-block', backgroundColor: 'currentColor',
      WebkitMaskImage: `url(${url})`, maskImage: `url(${url})`,
      WebkitMaskSize: 'contain', maskSize: 'contain',
      WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
      WebkitMaskPosition: 'center', maskPosition: 'center',
    }} />
  )
}

// ── Row 1: stats strip ───────────────────────────────────────────────────────
function StatsStrip() {
  const cash = useStore(s => s.stat_cash)
  const spend = useStore(s => s.stat_spendable)
  const wallet = useStore(s => s.stat_wallet)
  const hasWallet = useStore(s => s.stat_has_wallet)
  const profit = useStore(s => s.stat_profit)
  const acc = useStore(s => s.stat_accuracy)
  const wins = useStore(s => s.stat_wins)
  const losses = useStore(s => s.stat_losses)
  const fresh = useStore(s => s.stats_fresh)
  const practice = useStore(s => s.practice)

  const dash = (v: string) => fresh ? v : '—'
  const pills: { label: string; value: string; color: string }[] = [
    { label: STR.STAT_CASH,   value: dash(abbrevMoney(cash)),  color: 'var(--tc-text-strong)' },
    { label: STR.STAT_SPEND,  value: dash(abbrevMoney(spend)), color: 'var(--tc-text-strong)' },
    ...(!practice ? [{ label: STR.STAT_WALLET, value: dash(hasWallet ? abbrevMoney(wallet) : '$0.00'), color: 'var(--tc-text-strong)' }] : []),
    { label: STR.STAT_PROFIT, value: fresh ? (profit >= 0 ? '+' : '-') + abbrevMoney(profit) : '—', color: !fresh ? C.DIM : profit >= 0 ? C.GREEN : C.RED },
    { label: STR.STAT_ACC,    value: dash(`${acc.toFixed(0)}%`), color: C.GOLD },
    { label: STR.REC,    value: fresh ? `${wins}-${losses}` : '—', color: 'var(--tc-text-strong)' },
  ]
  return (
    <div className="tc-mob-strip" style={{
      flex: 1, minWidth: 0, width: '100%', display: 'flex', alignItems: 'stretch', gap: SP.XS, height: '42px',
    }}>
      {pills.map(p => (
        <div key={p.label} style={{
          flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center',
          alignItems: 'center', padding: `${SP.NONE} ${SP.XS}`, borderRadius: D.R_BTN, border: '1px solid var(--tc-border)',
          background: 'var(--tc-card)', overflow: 'hidden',
        }}>
          <span style={{ fontSize: FS.MICRO, fontWeight: FW.XBOLD, letterSpacing: '0.06em', color: 'var(--tc-dim2)', fontFamily: FONT.MONO }}>{p.label}</span>
          <span style={{
            fontSize: FS.SM, fontWeight: FW.XBOLD, color: p.color, fontFamily: FONT.MONO, fontVariantNumeric: 'tabular-nums',
            lineHeight: 1.15, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{p.value}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Interval switcher (5m / 15m / 1h / 1d).
 *
 * Mobile previously READ state.interval and filtered markets by it, but had no way
 * to CHANGE it -- so a phone was pinned to whichever interval the server happened
 * to hold, and the 1h/1d windows were unreachable. Desktop has had this in
 * components/left/LeftDock.tsx all along; this is the same control, same action,
 * same INTERVALS source, sized for a thumb.
 *
 * Renders all four unconditionally, exactly like desktop: `set_interval` is the
 * user's intent even when discovery has not yet found a market at that interval
 * (see the self-healing note in src/server/actions.ts), and the server follows the
 * selection to a tradeable window for the same asset where one exists. Deliberately
 * does NOT subscribe to `windows` to grey out empty intervals -- that map is patched
 * on every tick and would re-render this row constantly for a cosmetic hint.
 */
function IntervalSwitcher() {
  const interval = useStore(s => s.interval)
  return (
    <div
      role="tablist"
      aria-label="Window length"
      style={{
        display: 'flex', gap: SP.XS, width: '100%', flexShrink: 0,
        padding: SP.XXS, borderRadius: D.R_BTN,
        border: '1px solid var(--tc-border)', background: 'var(--tc-card)',
        boxSizing: 'border-box',
      }}
    >
      {INTERVALS.map(v => {
        const active = interval === v
        return (
          <button
            key={v}
            role="tab"
            aria-selected={active}
            data-tf={v}
            onClick={() => { call('set_interval', v).catch(() => {}) }}
            style={{
              flex: '1 1 0', minWidth: 0,
              // 34px keeps the tap target at a usable size after the
              // scale-to-fit transform in useViewportScale() shrinks it.
              height: '34px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: D.R_SM, cursor: 'pointer',
              fontSize: FS.SM, fontWeight: FW.XBOLD, fontFamily: FONT.MONO,
              WebkitTapHighlightColor: 'transparent',
              ...ghostSegStyle(active, C.GREEN, false),
            }}
          >
            {v}
          </button>
        )
      })}
    </div>
  )
}

function TopChrome({ view }: { view: View }) {
  const showChartRow = view === 'home'
  return (
    <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: SP.SM, padding: `${SP.MD} ${SP.MD} 0` }}>
      {/* stats strip (theme is OS-auto; buy-mode moved into the buying panel) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.SM }}>
        <StatsStrip />
      </div>
      {/* interval (5m/15m/1h/1d) — sits directly above the slots it re-scopes */}
      {showChartRow && <IntervalSwitcher />}
      {/* time window — wide, full width */}
      {showChartRow && (
        <div style={{ display: 'flex', position: 'relative', height: SZ.S40, alignItems: 'center' }}>
          <WindowNav fluid />
        </div>
      )}
    </div>
  )
}

// ── Bottom tab bar ──────────────────────────────────────────────────────────
interface Tab { key: string; label: string; icon: React.ReactNode; active: boolean; onClick: () => void; accent?: string }

function BottomBar({ view, setView }: { view: View; setView: (v: View) => void }) {
  const practice = useStore(s => s.practice)
  const interval = useStore(s => s.interval)

  // Market is a BUTTON, not a view: tap advances to the next market (window) of
  // the current interval. The chart/odds follow via set_active_window; the coin
  // icon reflects the new market.
  const cycleMarket = () => {
    // Read imperatively: subscribing to `windows`/`active_window` re-rendered the
    // whole tab bar on every tick for values only this handler ever reads.
    const st = useStore.getState()
    const windows = (st.windows ?? []) as Record<string, unknown>[]
    const activeIdx = st.active_window as number
    const mkts = windows.filter(w => String(w['interval'] ?? '') === interval && String(w['up_token'] ?? '') !== '')
    if (mkts.length < 2) return
    const curSlug = String(windows[activeIdx]?.['slug'] ?? '')
    const i = mkts.findIndex(w => String(w['slug'] ?? '') === curSlug)
    const next = mkts[(i + 1 + mkts.length) % mkts.length]
    call('set_active_window', String(next['slug'] ?? '')).catch(() => {})
  }

  // Slot 1 — Home / Wallet (real) / Refill (game), per the agreed mapping.
  let slot1: Tab
  if (view !== 'home' && view !== 'wallet') {
    slot1 = { key: 'home', label: STR.TAB_HOME, icon: <IcoHome />, active: false, onClick: () => setView('home') }
  } else if (practice) {
    slot1 = { key: 'refill', label: STR.TAB_REFILL, icon: <IcoRefresh />, active: false, onClick: () => call('reset_practice').catch(() => {}) }
  } else {
    const onWallet = view === 'wallet'
    slot1 = { key: 'wallet', label: onWallet ? STR.TAB_TRADE : STR.TAB_WALLET, icon: onWallet ? <IcoHome /> : <IcoWallet />, active: onWallet, accent: C.GOLD, onClick: () => setView(onWallet ? 'home' : 'wallet') }
  }

  const tabs: Tab[] = [
    slot1,
    { key: 'mode',
      // Label the DESTINATION, not the current state: this previously read "Game"
      // while practice was on, so the tab saying "Game" was the one that switched
      // to real money.
      label: practice ? STR.TAB_GO_REAL : STR.TAB_GO_GAME,
      icon: practice ? <IcoCash /> : <IcoGamepad />,
      active: !practice,
      accent: practice ? C.GREEN : C.PURPLE,
      onClick: () => {
        // Entering live mode spends real funds -- confirm first. Returning to
        // paper is always safe, so that direction stays a single tap.
        if (practice && !window.confirm(STR.CONFIRM_GO_REAL)) return
        call('toggle_practice').catch(() => {})
      } },
    { key: 'market', label: STR.TAB_MARKET, icon: <CoinIcon />, active: false, onClick: cycleMarket },
    { key: 'activity', label: STR.TAB_ACTIVITY_M, icon: <IcoList />, active: view === 'activity', accent: C.BTC, onClick: () => setView('activity') },
  ]

  return (
    <div style={{
      flexShrink: 0, display: 'flex', borderTop: '1px solid var(--tc-border)',
      background: 'var(--tc-card)', paddingBottom: 'env(safe-area-inset-bottom)',
    }}>
      {tabs.map(t => {
        const col = t.active ? (t.accent ?? 'var(--tc-text-strong)') : 'var(--tc-dim3)'
        return (
          <button key={t.key} onClick={t.onClick} style={{
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: SP.XXS, padding: `${SP.MD} 0 ${SP.LG}`, background: 'transparent', border: 'none',
            cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
            color: t.key === 'mode' ? (t.accent ?? col) : t.key === 'market' ? 'var(--tc-text-2)' : col,
          }}>
            {t.icon}
            <span style={{ fontSize: FS.NANO, fontWeight: FW.XBOLD, letterSpacing: '0.04em', fontFamily: FONT.MONO }}>{t.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Reusable chart card ──────────────────────────────────────────────────────
function ChartCard({ height }: { height: string }) {
  return (
    <div style={{
      height, flexShrink: 0, position: 'relative', overflow: 'hidden',
      borderRadius: D.R_CARD, border: '1px solid var(--tc-border)',
      background: 'var(--tc-card)', boxShadow: 'var(--tc-elev-1)',
    }}>
      {/* canvas-type selector stays as an overlay on the canvas; window label is
          off because the time window lives in its own full-width bar above. */}
      <ChartView showWindowLabel={false} />
    </div>
  )
}

// ── Smart auto-sizing ─────────────────────────────────────────────────────────
// Design the UI once at a base width, then scale-to-fit the actual viewport so
// every size/padding/font scales proportionally per screen — no per-element
// media queries. Clamped so it never gets tiny on small phones or huge on a
// tablet-width mobile view. visualViewport keeps it correct when the mobile
// browser chrome / keyboard shows or hides.
const BASE_W = 390
const SCALE_MIN = 0.82
const SCALE_MAX = 1.28
function useViewportScale() {
  const read = () => {
    const vw = (typeof window !== 'undefined' && (window.visualViewport?.width ?? window.innerWidth)) || BASE_W
    const vh = (typeof window !== 'undefined' && (window.visualViewport?.height ?? window.innerHeight)) || 800
    const scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, vw / BASE_W))
    return { scale, w: vw / scale, h: vh / scale }
  }
  const [s, setS] = useState(read)
  useEffect(() => {
    const on = () => setS(read())
    window.addEventListener('resize', on)
    window.addEventListener('orientationchange', on)
    window.visualViewport?.addEventListener('resize', on)
    return () => {
      window.removeEventListener('resize', on)
      window.removeEventListener('orientationchange', on)
      window.visualViewport?.removeEventListener('resize', on)
    }
  }, [])
  return s
}

// ── Mobile app shell ──────────────────────────────────────────────────────────
function MobileAppInner({ unveiling }: { unveiling: boolean }) {
  const [view, setView] = useState<View>('home')
  const practice = useStore(s => s.practice)
  const { scale, w, h } = useViewportScale()

  // Wallet is live-only; if the user flips to practice while on it, fall back home.
  useEffect(() => { if (practice && view === 'wallet') setView('home') }, [practice, view])

  // Mobile theme follows the OS (browser auto) — no manual light/dark toggle.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => useStore.getState()._patch({ theme: mq.matches ? 'dark' : 'light' })
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  return (
    <div
      id="tc-app-root"
      className={unveiling ? undefined : 'tc-boot-blur'}
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: 'var(--tc-bg)' }}
    >
      {/* scale-to-fit canvas: laid out at w×h, scaled to exactly fill the viewport */}
      <div style={{
        width: `${w}px`, height: `${h}px`,
        transform: `scale(${scale})`, transformOrigin: 'top left',
        display: 'flex', flexDirection: 'column', willChange: 'transform',
      }}>
        <TopChrome view={view} />

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', display: 'flex', flexDirection: 'column', gap: SP.MD, padding: SP.MD }}>
          {view === 'home' && (
            <>
              <ChartCard height="40%" />
              <div style={{ flexShrink: 0, border: '1px solid var(--tc-border)', borderRadius: D.R_CARD, overflow: 'hidden' }}>
                <TradingBar mobile />
              </div>
            </>
          )}

          {view === 'activity' && (
            <div style={{ flex: 1, minHeight: 0 }}>
              <MarketPanel />
            </div>
          )}

          {view === 'wallet' && (
            <div className="tc-mob-wallet" style={{ flex: 1, minHeight: 0, width: '100%', maxWidth: '100%', overflowX: 'hidden' }}>
              <WalletPanel onClose={() => setView('home')} />
            </div>
          )}
        </div>

        <BottomBar view={view} setView={setView} />
      </div>
    </div>
  )
}

// Memoised: App is the root and re-renders on theme/mode/wallet changes.
// These panels take no props (or one stable one) and read what they need from
// the store themselves, so a parent re-render should never cascade into them.
export const MobileApp = React.memo(MobileAppInner)
