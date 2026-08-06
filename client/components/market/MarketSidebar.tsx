import { useEffect, useRef } from 'react'
import { animate } from 'animejs'
import { useStore } from '../../store.js'
import { call } from '../../api.js'
import { AskTile } from './AskTile.js'
import { RollDigits } from '../shared/RollDigits.js'
import { playFx } from '../../lib/fx.js'
import { useCountdown } from '../../lib/useCountdown.js'
import { FONT, C, D, SP, SZ, FS, FW } from '../../constants/index.js'

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonCard() {
  const bar = (w: string, h: string) => (
    <div className="tc-skel" style={{ width: w, height: h, borderRadius: D.R_XS }} />
  )
  return (
    <div style={{
      padding: `${SP.LG} ${SP.XL}`, borderRadius: D.R_CARD,
      background: 'var(--tc-panel)', border: '1px solid var(--tc-border)',
      boxShadow: 'var(--tc-elev-1)', width: '100%',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: D.GAP_MD, marginBottom: D.GAP_MD }}>
        {bar(SP.XXL, SP.XXL)}{bar('38%', SP.XXL)}<div style={{ flex: 1 }} />{bar('28%', SP.XL)}
      </div>
      <div style={{ display: 'flex', gap: SP.XS }}>
        {bar('48%', SZ.S28)}{bar('48%', SZ.S28)}
      </div>
    </div>
  )
}

// ── Result icon ───────────────────────────────────────────────────────────────

function ResultIcon({ result }: { result: string }) {
  if (result === 'UP') return (
    <span style={{ color: C.GREEN, fontSize: FS.XXS, fontWeight: FW.BLACK, fontFamily: FONT.MONO }}>▲</span>
  )
  if (result === 'DOWN') return (
    <span style={{ color: C.RED, fontSize: FS.XXS, fontWeight: FW.BLACK, fontFamily: FONT.MONO }}>▼</span>
  )
  return (
    <span style={{ color: 'var(--tc-dim)', fontSize: FS.XXS, fontFamily: FONT.MONO }}>·</span>
  )
}

// ── Single market card ────────────────────────────────────────────────────────

function MarketCard({ w, isActive }: { w: Record<string, unknown>; isActive: boolean }) {
  const asset = String(w['asset'] ?? '')
  const interval = String(w['interval'] ?? '')
  const slug = String(w['slug'] ?? '')
  const upToken = String(w['up_token'] ?? '')
  const dnToken = String(w['dn_token'] ?? '')
  const endTs = Number(w['end_ts'] ?? 0)
  const result = String(w['result'] ?? '')
  const intervalS = interval === '15m' ? 900 : 300
  const coinSrc = `/coins/${asset.toLowerCase()}.svg`
  const last3 = (useStore(s => s.window_results)[slug] ?? []).slice(0, 3)

  // market_001: live ticking countdown (shared hook — see lib/useCountdown.ts)
  const { secsLeft, stale, text: timerStr } = useCountdown(endTs, intervalS, 1000)

  // market_003: hover border/background swap (the green selection is the
  // sliding indicator, not a per-card border) + a subtle coin-icon jiggle.
  const coinRef = useRef<HTMLImageElement>(null)
  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
    // no border swap (that white outline was ugly) — faint bg + a card pulse + coin jiggle
    if (!isActive) e.currentTarget.style.background = 'var(--tc-hover)'
    playFx(e.currentTarget, 'pulse')
    playFx(coinRef.current, 'jiggle')
  }
  const handleMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
    e.currentTarget.style.background = isActive ? 'var(--tc-hover)' : 'var(--tc-panel)'
  }

  const cellBox: React.CSSProperties = {
    border: '1px solid var(--tc-border)', borderRadius: D.R_BTN,
    background: 'var(--tc-card-alt)', display: 'flex', minWidth: 0,
  }

  // last-3 results as ▲/▼ icons (no label)
  const last3Row = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SP.SM, height: SP.XXL }}>
      {last3.length
        ? last3.map((r, i) => (
            <span key={i} style={{ color: r === 'UP' ? C.GREEN : C.RED, fontSize: FS.XS, fontWeight: FW.BLACK, lineHeight: 1 }}>
              {r === 'UP' ? '▲' : '▼'}
            </span>
          ))
        : <span style={{ color: 'var(--tc-dim)', fontSize: FS.XS, fontFamily: FONT.MONO }}>· · ·</span>}
    </div>
  )

  return (
    <div
      data-mkt-slug={slug}
      onClick={() => call('set_active_window', slug)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        cursor: 'pointer', padding: SP.SM, borderRadius: D.R_CTRL, width: '100%',
        background: isActive ? 'var(--tc-hover)' : 'var(--tc-panel)',
        backgroundImage: 'var(--tc-grad-card)',
        border: '1px solid var(--tc-border)',
        boxShadow: 'var(--tc-elev-1)',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.1fr) minmax(0, 1.1fr)',
        gap: SP.XS,
        minWidth: 'var(--tc-card-min-w, unset)', overflow: 'hidden',
        flexShrink: 0,
        transition: 'border-color var(--tc-dur) var(--tc-ease), background-color var(--tc-dur) var(--tc-ease)',
      }}
    >
      {/* ── Currency (left) — square host box ── */}
      <div style={{ ...cellBox, aspectRatio: '1 / 1', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center', gap: SP.MD, padding: `${SP.XL} ${SP.MD}` }}>
        <img ref={coinRef} src={coinSrc} width={28} height={28} style={{ flexShrink: 0, display: 'block' }}
             onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
        <span className={`tc-tglow-${asset.toLowerCase()}`}
              style={{ color: 'var(--tc-white)', fontSize: FS.H3, fontWeight: FW.BLACK,
                       fontFamily: FONT.MONO, lineHeight: 1, letterSpacing: '-0.03em' }}>
          {asset}
        </span>
      </div>

      {/* ── UP (top) / DOWN (bottom) odds, stacked ── */}
      <div style={{ ...cellBox, padding: SP.XS, background: 'transparent', border: 'none' }}>
        <AskTile vertical upToken={upToken} dnToken={dnToken} />
      </div>

      {/* ── last-3 (top) · timer (confined, centered) ── */}
      <div style={{ ...cellBox, flexDirection: 'column', alignItems: 'center', justifyContent: 'space-evenly',
                    gap: SP.MD, padding: `${SP.LG} ${SP.LG}` }}>
        {last3Row}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
          {upToken && !stale ? (
            <RollDigits text={timerStr}
              style={{ fontSize: FS.H3, fontWeight: FW.BLACK, fontFamily: FONT.TIME, letterSpacing: '0.02em', lineHeight: 1,
                       color: secsLeft < 30 ? C.GOLD : 'var(--tc-white)' }} />
          ) : (
            <span style={{ color: 'var(--tc-dim2)', fontSize: FS.XL, fontWeight: FW.BLACK, fontFamily: FONT.TIME }}>—</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

export function MarketSidebar() {
  const allWindows = useStore(s => s.windows) as Record<string, unknown>[]
  const interval = useStore(s => s.interval) as string
  const activeIdx = useStore(s => s.active_window) as number
  const activeSlug = String(allWindows[activeIdx]?.['slug'] ?? '')
  const windows = allWindows.filter(w => w['interval'] === interval)

  // market_005: only swap out skeleton when prices are also ready
  // A window with no up_token is closed/stale and doesn't block readiness.
  // Any open window must have a non-zero ask price before we show real cards.
  const pricesReady = windows.every(w =>
    Number(w['up_ask'] ?? 0) > 0 || String(w['up_token'] ?? '') === ''
  )

  const listRef = useRef<HTMLDivElement>(null)
  const indRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef(true)

  // Slide the green selection indicator to the active card (anime.js).
  useEffect(() => {
    const list = listRef.current, ind = indRef.current
    if (!list || !ind) return
    const card = list.querySelector(`[data-mkt-slug="${(window.CSS && CSS.escape) ? CSS.escape(activeSlug) : activeSlug}"]`) as HTMLElement | null
    if (!card) { ind.style.opacity = '0'; return }
    const top = card.offsetTop
    const h = card.offsetHeight
    if (firstRef.current) {
      // first paint: snap into place, no slide
      ind.style.top = `${top}px`; ind.style.height = `${h}px`; ind.style.opacity = '1'
      firstRef.current = false
      return
    }
    animate(ind, {
      top: `${top}px`,
      height: `${h}px`,
      opacity: 1,
      duration: 420,
      ease: 'out(3)',
    })
  }, [activeSlug, interval, windows.length])

  if (!windows.length || !pricesReady) {
    return (
      <div
        data-spot="markets"
        style={{ display: 'flex', flexDirection: 'column', gap: D.GAP, width: '100%' }}
      >
        {Array.from({ length: 7 }, (_, i) => <SkeletonCard key={i} />)}
      </div>
    )
  }

  return (
    <div
      ref={listRef}
      data-spot="markets"
      style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: SP.SM, width: '100%' }}
    >
      {/* sliding green selection indicator (anime.js) */}
      <div
        ref={indRef}
        style={{
          position: 'absolute', left: 0, right: 0, top: 0, height: 0, opacity: 0,
          border: `1.5px solid ${C.GREEN}`, borderRadius: D.R_CTRL,
          boxShadow: 'var(--tc-glow-up)', pointerEvents: 'none',
          boxSizing: 'border-box', zIndex: 2,
        }}
      />
      {windows.map(w => (
        <MarketCard
          key={String(w['slug'] ?? '')}
          w={w}
          isActive={String(w['slug'] ?? '') === activeSlug}
        />
      ))}
    </div>
  )
}
