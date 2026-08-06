/**
 * LeftDock — the customisable left column.
 *
 * Four panels (time · markets · system stats · logs) the user can:
 *   • reorder by press-and-hold + drag (drag any part; a quick tap/scroll passes
 *     through to the panel's own content). Reordering animates via FLIP.
 *   • resize by dragging the invisible-until-hover splitter between two panels —
 *     growing one shrinks its neighbour (tiling; the stack stays fitted).
 * Order + heights persist to localStorage; a reset control restores defaults.
 *
 * Per-panel behaviour:
 *   time    — small; grows into a stacked 5m/15m/1h/1d, capped at its natural size.
 *   markets — scrolls internally when short; capped tall.
 *   stats   — resource grid; fewer columns (bigger tiles) as it grows.
 *   logs    — scrolls; grows large but capped.
 */
import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { animate } from 'animejs'
import { useStore } from '../../store.js'
import { call } from '../../api.js'
import { playFx } from '../../lib/fx.js'
import { MarketSidebar } from '../market/MarketSidebar.js'
import { LiveTrades } from '../market/LiveTrades.js'
import { ResourceBar } from '../ResourceBar.js'
import { ghostSegStyle } from '../shared/ui.js'
import { C, D, FONT, SP, FS, FW } from '../../constants/index.js'
import { INTERVALS } from '../../lib/intervals.js'

type PanelId = 'time' | 'markets' | 'stats' | 'logs'
const DEFAULT_ORDER: PanelId[] = ['time', 'markets', 'stats', 'logs']

// Per-panel height limits (px). time is capped — it can't grow past the four
// timeframes stacked. markets/logs grow large but not unbounded. stats sits in
// between.
const LIMITS: Record<PanelId, { min: number; max: number }> = {
  time:    { min: 40,  max: 248 },
  markets: { min: 110, max: 900 },
  stats:   { min: 92,  max: 560 },
  logs:    { min: 90,  max: 900 },
}
const DEFAULTS: Record<PanelId, number> = { time: 40, markets: 300, stats: 184, logs: 220 }
// panel that soaks up container-size changes (so the stack stays fitted) —
// keep markets out of it so it stays snapped to whole cards
const FLEX_PANELS: PanelId[] = ['logs']

const LS_KEY = 'tc-left-dock-v1'
const HOLD_MS = 200       // press-and-hold before a panel lifts for reorder
const MOVE_TOL = 8        // px of movement during the hold that means scroll/click
const GAP = 8             // matches D.GAP_MD (px between panels)

interface Persisted { order: PanelId[]; heights: Record<PanelId, number> }

function loadState(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>
      const got = Array.isArray(p.order) ? p.order.filter(x => DEFAULT_ORDER.includes(x)) : []
      const order = [...got, ...DEFAULT_ORDER.filter(x => !got.includes(x))] as PanelId[]
      const heights = { ...DEFAULTS, ...(p.heights ?? {}) }
      return { order, heights }
    }
  } catch { /* corrupt — fall through to defaults */ }
  return { order: [...DEFAULT_ORDER], heights: { ...DEFAULTS } }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// ── Adaptive timeframe bar (5m / 15m / 1h / 1d) ───────────────────────────────
// Horizontal pills when short; stacks vertically when the panel is grown. The
// green selection frame slides on whichever axis is active — it measures the
// selected segment, so it works for any number of options.
function DockTimeBar() {
  const interval = useStore(s => s.interval) as string
  const barRef = useRef<HTMLDivElement>(null)
  const indRef = useRef<HTMLDivElement>(null)
  const [stacked, setStacked] = useState(false)
  const firstRef = useRef(true)

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return
    // Only stack once every timeframe gets a usable row (~30px each) — with four
    // options the old 64px threshold produced four squashed 14px rows.
    const ro = new ResizeObserver(entries =>
      setStacked((entries[0]?.contentRect.height ?? 0) > 30 * INTERVALS.length))
    ro.observe(bar)
    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    const bar = barRef.current, ind = indRef.current
    if (!bar || !ind) return
    const seg = bar.querySelector(`[data-tf="${interval}"]`) as HTMLElement | null
    if (!seg) return
    const to = {
      left: `${seg.offsetLeft}px`, top: `${seg.offsetTop}px`,
      width: `${seg.offsetWidth}px`, height: `${seg.offsetHeight}px`,
    }
    if (firstRef.current) { Object.assign(ind.style, to, { opacity: '1' }); firstRef.current = false; return }
    animate(ind, { ...to, duration: 300, ease: 'out(3)' })
  }, [interval, stacked])

  return (
    <div ref={barRef} style={{
      position: 'relative', display: 'flex',
      flexDirection: stacked ? 'column' : 'row',
      alignItems: 'stretch', gap: D.GAP_SM,
      width: '100%', height: '100%', padding: SP.XXS, boxSizing: 'border-box',
      background: 'var(--tc-card-alt)', border: '1px solid var(--tc-border)',
      borderRadius: D.R_CTRL, boxShadow: 'var(--tc-elev-1)',
    }}>
      <div ref={indRef} style={{
        position: 'absolute', left: 0, top: 0, width: 0, height: 0, opacity: 0,
        border: `1px solid ${C.GREEN}`, borderRadius: D.R_SM,
        boxShadow: 'var(--tc-glow-up)', pointerEvents: 'none', boxSizing: 'border-box', zIndex: 0,
      }} />
      {INTERVALS.map(v => {
        const active = interval === v
        return (
          <div
            key={v}
            data-tf={v}
            onClick={() => call('set_interval', v)}
            onMouseEnter={e => playFx(e.currentTarget, 'pulse')}
            className="tc-sheen"
            style={{
              position: 'relative', zIndex: 1, flex: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: D.R_SM, cursor: 'pointer', userSelect: 'none',
              fontSize: stacked ? FS.LG : FS.SM, fontWeight: FW.XBOLD, fontFamily: FONT.MONO,
              ...ghostSegStyle(active, C.GREEN, false),
              border: '1px solid transparent',
            }}
          >
            {v}
          </div>
        )
      })}
    </div>
  )
}

// ── Panel content ─────────────────────────────────────────────────────────────
function PanelBody({ id }: { id: PanelId }) {
  switch (id) {
    case 'time':
      return <DockTimeBar />
    case 'markets':
      return (
        <div style={{
          width: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden',
          scrollbarWidth: 'none', boxSizing: 'border-box',
          padding: D.GAP_MD, border: '1px solid var(--tc-border)',
          borderRadius: D.R_CARD, background: 'var(--tc-card)',
        }}>
          <MarketSidebar />
        </div>
      )
    case 'stats':
      return (
        <div style={{ width: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none' }}>
          <ResourceBar />
        </div>
      )
    case 'logs':
      return <LiveTrades />
  }
}

// ── LeftDock ────────────────────────────────────────────────────────────────
function LeftDockInner() {
  const init = useRef(loadState()).current
  const [order, setOrder] = useState<PanelId[]>(init.order)
  const [heights, setHeights] = useState<Record<PanelId, number>>(init.heights)
  const [draggingId, setDraggingId] = useState<PanelId | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)   // render-space gap index

  // drives the on-load markets snap (cards appear / count or interval changes)
  const marketCount = useStore(s => s.windows.length)
  const interval = useStore(s => s.interval)

  const dockRef = useRef<HTMLDivElement>(null)
  const panelRefs = useRef(new Map<PanelId, HTMLDivElement>())
  const setPanelRef = useCallback((id: PanelId) => (el: HTMLDivElement | null) => {
    if (el) panelRefs.current.set(id, el); else panelRefs.current.delete(id)
  }, [])

  // live drag bookkeeping
  const insRef = useRef(0)            // insertion index in the without-dragged array
  const prevTops = useRef<Map<PanelId, number>>(new Map())
  const flipPending = useRef(false)

  // Persist on change.
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ order, heights })) } catch { /* ignore */ }
  }, [order, heights])

  // Keep the stack fitted to the dock: push container-size changes into the
  // flexible panels so the panels always exactly fill the height (tiling).
  useEffect(() => {
    const dock = dockRef.current
    if (!dock) return
    const fit = () => {
      // panels share the dock minus the inter-panel gaps and the reset row
      const avail = dock.clientHeight - GAP * (order.length - 1)
      if (avail <= 0) return
      setHeights(prev => {
        const sum = order.reduce((s, id) => s + prev[id], 0)
        let diff = avail - sum
        if (Math.abs(diff) < 1) return prev
        const next = { ...prev }
        // distribute the difference across flexible panels present in the dock
        const flex = FLEX_PANELS.filter(id => order.includes(id))
        const pool = flex.length ? flex : order
        for (let pass = 0; pass < 3 && Math.abs(diff) >= 1; pass++) {
          const share = diff / pool.length
          for (const id of pool) {
            const want = clamp(next[id] + share, LIMITS[id].min, LIMITS[id].max)
            diff -= want - next[id]
            next[id] = want
          }
        }
        return next
      })
    }
    const ro = new ResizeObserver(fit)
    ro.observe(dock)
    fit()
    return () => ro.disconnect()
  }, [order])

  // FLIP after a reorder commit.
  useLayoutEffect(() => {
    if (!flipPending.current) return
    flipPending.current = false
    for (const [id, el] of panelRefs.current) {
      const before = prevTops.current.get(id)
      if (before == null) continue
      const after = el.getBoundingClientRect().top
      const dy = before - after
      if (Math.abs(dy) < 1) continue
      animate(el, { translateY: [dy, 0], duration: 420, ease: 'out(3)' })
    }
  }, [order])

  const snapshotTops = () => {
    prevTops.current.clear()
    for (const [id, el] of panelRefs.current) prevTops.current.set(id, el.getBoundingClientRect().top)
  }

  // ── Reorder: press-hold to lift, drag to choose a slot, drop to commit ──────
  const onPanelPointerDown = (id: PanelId) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const startY = e.clientY, startX = e.clientX
    let holdTimer: ReturnType<typeof setTimeout> | null = null
    let lifted = false
    const el = panelRefs.current.get(id)

    const begin = () => {
      lifted = true
      setDraggingId(id)
      if (el) { el.style.zIndex = '50'; el.style.cursor = 'grabbing' }
      document.body.style.userSelect = 'none'
    }

    const move = (ev: PointerEvent) => {
      if (!lifted) {
        if (Math.abs(ev.clientY - startY) > MOVE_TOL || Math.abs(ev.clientX - startX) > MOVE_TOL) cleanup()
        return
      }
      const dy = ev.clientY - startY
      if (el) el.style.transform = `translateY(${dy}px)`
      const r = el?.getBoundingClientRect()
      const centre = r ? r.top + r.height / 2 : ev.clientY
      // insertion index among the OTHER panels (without-dragged space)
      let ins = 0
      for (const pid of order) {
        if (pid === id) continue
        const pr = panelRefs.current.get(pid)?.getBoundingClientRect()
        if (pr && pr.top + pr.height / 2 < centre) ins++
      }
      insRef.current = ins
      // map to a render-space gap index for the drop indicator
      const without = order.filter(x => x !== id)
      const target = without[ins]
      setDropAt(target ? order.indexOf(target) : order.length)
    }

    const up = () => {
      if (lifted) {
        if (el) { el.style.transform = ''; el.style.zIndex = ''; el.style.cursor = '' }
        document.body.style.userSelect = ''
        const without = order.filter(x => x !== id)
        without.splice(insRef.current, 0, id)
        if (without.some((x, i) => x !== order[i])) { snapshotTops(); flipPending.current = true; setOrder(without) }
      }
      cleanup()
    }

    const cleanup = () => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDraggingId(null)
      setDropAt(null)
    }

    holdTimer = setTimeout(begin, HOLD_MS)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Snap a candidate markets-panel height so the list shows a whole number of
  // market cards (no half-cut row). Measures the real card pitch from the DOM,
  // so it tracks whatever the cards actually render at.
  const snapMarketsHeight = (raw: number): number => {
    const panel = panelRefs.current.get('markets')
    const cards = panel?.querySelectorAll('[data-mkt-slug]')
    if (!panel || !cards || cards.length < 1) return raw
    const panelTop = panel.getBoundingClientRect().top
    const first = (cards[0] as HTMLElement).getBoundingClientRect()
    const cardH = first.height
    const pitch = cards.length >= 2
      ? (cards[1] as HTMLElement).getBoundingClientRect().top - first.top
      : cardH + 6
    if (pitch <= 0) return raw
    const chrome = (first.top - panelTop) * 2          // padding+border above + below
    // whole cards, never more than actually exist (no empty trailing slot)
    const n = clamp(Math.round((raw - chrome - cardH) / pitch) + 1, 1, cards.length)
    return Math.round((n - 1) * pitch + cardH + chrome)
  }

  // Keep the markets panel snapped to whole cards AND never taller than the
  // markets actually take up: snapMarketsHeight caps to the rendered card count,
  // so it shrinks to fit (e.g. when the window count drops) and never leaves an
  // empty trailing slot. Re-runs on every count/interval/order change.
  useEffect(() => {
    const panel = panelRefs.current.get('markets')
    if (!panel?.querySelector('[data-mkt-slug]')) return
    setHeights(prev => {
      const snapped = clamp(snapMarketsHeight(prev.markets), LIMITS.markets.min, LIMITS.markets.max)
      if (Math.abs(snapped - prev.markets) < 1) return prev
      const logsNew = clamp(prev.logs - (snapped - prev.markets), LIMITS.logs.min, LIMITS.logs.max)
      return { ...prev, markets: prev.markets + (prev.logs - logsNew), logs: logsNew }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketCount, interval, order])

  // ── Resize: drag the splitter; transfer px between the two neighbours ───────
  const onSplitterPointerDown = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation()
    const a = order[i], b = order[i + 1]
    const startY = e.clientY
    const startA = heights[a], startB = heights[b]
    const total = startA + startB                 // the pair total is conserved

    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY
      // a's feasible window given both panels' limits
      const aLo = Math.max(LIMITS[a].min, total - LIMITS[b].max)
      const aHi = Math.min(LIMITS[a].max, total - LIMITS[b].min)
      let aTarget = clamp(startA + dy, aLo, aHi)
      // magnet the markets panel to whole cards (whichever side it's on)
      if (a === 'markets') {
        aTarget = clamp(snapMarketsHeight(aTarget), aLo, aHi)
      } else if (b === 'markets') {
        aTarget = clamp(total - snapMarketsHeight(total - aTarget), aLo, aHi)
      }
      setHeights(prev => ({ ...prev, [a]: aTarget, [b]: total - aTarget }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'ns-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      ref={dockRef}
      style={{
        width: '100%', height: '100%', minHeight: 0,
        display: 'flex', flexDirection: 'column', gap: D.GAP_MD,
        position: 'relative', overflow: 'hidden',
      }}
    >
      {order.map((id, idx) => {
        const dragging = draggingId === id
        return (
          <React.Fragment key={id}>
            {dropAt === idx && draggingId && draggingId !== id && <div className="tc-dock-drop" />}
            <div
              ref={setPanelRef(id)}
              onPointerDown={onPanelPointerDown(id)}
              className={`tc-dock-panel${dragging ? ' tc-dock-dragging' : ''}`}
              style={{
                position: 'relative', width: '100%',
                height: `${heights[id]}px`, flexShrink: 0,
              }}
            >
              <PanelBody id={id} />
              {idx < order.length - 1 && (
                <div className="tc-dock-splitter" onPointerDown={onSplitterPointerDown(idx)} aria-hidden="true" />
              )}
            </div>
          </React.Fragment>
        )
      })}
      {dropAt === order.length && draggingId && <div className="tc-dock-drop" />}
    </div>
  )
}

// Memoised: App is the root and re-renders on theme/mode/wallet changes.
// These panels take no props (or one stable one) and read what they need from
// the store themselves, so a parent re-render should never cascade into them.
export const LeftDock = React.memo(LeftDockInner)
