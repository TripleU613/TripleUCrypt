/**
 * Native HTML5 canvas chart engine — Line / Probability / Candles.
 *
 * Lifted directly from TripleUCrypt/ui/chart/echarts_view.py _JSX string.
 * Props are wired to useStore() hooks.
 *
 * The live price and ask series used to arrive on browser sockets (RTDS + CLOB),
 * whose callbacks wrote straight into priceBuf/askBuf without rendering. The
 * server owns those sockets now and streams the same values in state, but they
 * are read NON-REACTIVELY inside the RAF loop (useStore.getState()) rather than
 * with useStore(): a subscription would add a React commit to this whole
 * component on every tick, which is exactly the cost the buffers existed to
 * avoid. See the top of frame().
 */

import { useRef, useEffect } from 'react'
import { useStore } from '../../store'
import { C, FONT, MS } from '../../constants/index.js'
import { intervalSecs } from '../../lib/intervals.js'
import {
  WIN_RUNGS, pickWindowRung, quantizeCam, decimateBucketMs,
  type CamBand, type CamBounds,
} from '../../lib/chartCamera.js'

// ── Helpers to derive computed values from the store ─────────────────────────

function deriveViewStartTs(viewingSlot: string): number {
  try { return viewingSlot ? parseInt(viewingSlot, 10) || 0 : 0 }
  catch { return 0 }
}

function deriveViewEndTs(viewStartTs: number, interval: string): number {
  if (viewStartTs <= 0) return 0
  return viewStartTs + intervalSecs(interval)
}

interface OHLCRow {
  time: number
  open: number
  high: number
  low: number
  close: number
}

function _quant(v: number): number {
  return v >= 10 ? Math.round(v * 100) / 100 : Math.round(v * 1e6) / 1e6
}

// Probability heat — clean banded palette by win probability (no muddy blend):
//   ≥60% green (likely win) · 40–60% orange (toss-up) · <40% red (likely lose)
function probRgb(pct: number): string {
  if (pct >= 60) return '34,212,123'   // green
  if (pct >= 40) return '245,158,11'   // orange
  return '239,68,68'                    // red
}
function probColor(pct: number): string { return `rgb(${probRgb(pct)})` }

function deriveDisplayCandles(windowCandles1m: unknown[][]): OHLCRow[] {
  if (!windowCandles1m || !windowCandles1m.length) return []
  const seen = new Map<number, OHLCRow>()
  for (const r of windowCandles1m) {
    try {
      // rows are [datetime_str, open, high, low, close]
      const raw = r[0]
      let ts: number
      if (typeof raw === 'string') {
        // "YYYY-MM-DD HH:MM:SS" UTC
        ts = Math.floor(new Date(raw.replace(' ', 'T') + 'Z').getTime() / 1000)
      } else {
        ts = Number(raw)
      }
      if (!isFinite(ts)) continue
      seen.set(ts, {
        time:  ts,
        open:  _quant(parseFloat(String(r[1]))),
        high:  _quant(parseFloat(String(r[2]))),
        low:   _quant(parseFloat(String(r[3]))),
        close: _quant(parseFloat(String(r[4]))),
      })
    } catch { /* skip bad row */ }
  }
  return [...seen.values()].sort((a, b) => a.time - b.time)
}

function deriveChartTarget(
  viewingSlot: string,
  windowCandles1m: unknown[][],
  strikePrice: number,
  windows: Record<string, unknown>[],
  activeWindow: number,
  windowOpens: Record<string, number>,
  windowOpenPrice: number,
  serverChartTarget: number,
): number {
  // When viewing a past slot, use the viewed window's open — and NEVER fall
  // through to the live price (it blows up the y-axis and crushes the line to
  // the bottom while candles are still loading). Prefer the candle open, then
  // the server-computed window target.
  if (viewingSlot) {
    if (windowCandles1m.length > 0) {
      try { return parseFloat(String(windowCandles1m[0][1])) || serverChartTarget || 0 } catch { /* fall through */ }
    }
    return serverChartTarget || 0
  }
  if (strikePrice > 0) return strikePrice
  if (windows && activeWindow < windows.length) {
    const aw = windows[activeWindow]
    if (aw) {
      // window_opens key mirrors Python _open_key — use condition_id if available
      const cid = String(aw['condition_id'] || '')
      const op = cid ? (windowOpens[cid] || 0) : 0
      if (op > 0) return op
      if (windowOpenPrice > 0) return windowOpenPrice
      const cp = parseFloat(String(aw['current_price'] || 0))
      if (cp > 0) return cp
    }
  }
  // Fall back to the server-computed target (its chain includes the strike and
  // a live-price placeholder) so EVERY asset shows a target bar, not just the
  // ones whose window-open we captured locally.
  return windowOpenPrice || serverChartTarget || 0
}

interface ChartPositionLine {
  price: number
  side: 'UP' | 'DOWN'
  pnl: number
}

function deriveChartPositionLines(
  positions: Record<string, unknown>[],
  upToken: string,
  dnToken: string,
): ChartPositionLine[] {
  if (!upToken && !dnToken) return []
  const lines: ChartPositionLine[] = []
  for (const p of positions) {
    const tok = String(p['token_id'] || '')
    if (tok && (tok === upToken || tok === dnToken)) {
      lines.push({
        price: parseFloat(String(p['avg_price'] || 0)),
        side:  tok === upToken ? 'UP' : 'DOWN',
        pnl:   parseFloat(String(p['pnl'] || 0)),
      })
    }
  }
  return lines
}

// ── EChart component ──────────────────────────────────────────────────────────

// ms durations per tier — 0 in survival skips intro sweeps entirely
const ANIM_MS: Record<string, number> = {
  turbo:    MS.ANIM_TURBO,
  smooth:   MS.ANIM_SMOOTH,
  eco:      MS.ANIM_ECO,
  survival: MS.ANIM_SURVIVAL,
}

export function EChart(): JSX.Element {
  // ── Pull all needed state from the store ─────────────────────────────────
  const uiQuality     = useStore((s) => s.ui_quality)
  const mode          = useStore((s) => s.mode)
  const asset         = useStore((s) => s.chart_asset)
  const up_token      = useStore((s) => s.up_token)
  const interval      = useStore((s) => s.interval)
  const viewing_future = useStore((s) => s.viewing_future)
  const hist_prob     = useStore((s) => s.hist_prob) as {t: number; pct: number}[]
  const rollover_rev  = useStore((s) => s.rollover_rev)
  const theme         = useStore((s) => s.theme)
  const viewing_slot  = useStore((s) => s.viewing_slot)
  const windowCandles1m = useStore((s) => s.window_candles_1m)
  const strikePrice   = useStore((s) => s.strike_price)
  const windows       = useStore((s) => s.windows) as Record<string, unknown>[]
  const activeWindow  = useStore((s) => s.active_window)
  const windowOpens   = useStore((s) => s.window_opens)
  const windowOpenPrice = useStore((s) => s.window_open_price)
  const chartTarget   = useStore((s) => s.chart_target)
  const positionsRaw  = useStore((s) => s.positions) as Record<string, unknown>[]
  const dnToken       = useStore((s) => s.dn_token)

  // ── Derived values ───────────────────────────────────────────────────────
  const viewing    = viewing_slot !== ''
  const view_start = deriveViewStartTs(viewing_slot)
  const view_end   = deriveViewEndTs(view_start, interval)
  const candles    = deriveDisplayCandles(windowCandles1m as unknown[][])
  const target     = deriveChartTarget(
    viewing_slot, windowCandles1m as unknown[][], strikePrice,
    windows, activeWindow, windowOpens, windowOpenPrice, chartTarget
  )
  const positions  = deriveChartPositionLines(positionsRaw, up_token, dnToken)

  // ── Refs ─────────────────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef    = useRef<HTMLCanvasElement>(null)

  const priceBuf = useRef<{t: number; price: number}[]>([])
  const askBuf   = useRef<{t: number; pct: number}[]>([])
  const ohlcRef  = useRef<{time: number; open: number; high: number; low: number; close: number}[]>([])
  const zoomRef  = useRef<Record<string, {lo: number; hi: number}>>({})
  const tipRef   = useRef<Record<string, number>>({})
  const winRef   = useRef<Record<string, number>>({})
  // rungRef: the QUANTIZED x span currently in force (winRef only eases toward
  // it). camTgtRef: the quantized y band camZoom is easing toward — the
  // hysteresis has to be evaluated against this, not against the eased value in
  // zoomRef, or the "hold still" band drifts along with the easing.
  const rungRef  = useRef<Record<string, number>>({})
  const camTgtRef = useRef<Record<string, CamBand>>({})
  const axisLblRef = useRef<Record<string, {ticks: Map<string, {v: number; y: number; targetY: number; alpha: number; dying: boolean; bornAt: number; dieAt: number}>; lastCalc: number}>>({})
  const hoverRef = useRef<{x: number; y: number} | null>(null)
  const candleView = useRef({ count: 70, offset: 0, targetCount: 70, targetOffset: 0, touched: false })
  const dragRef    = useRef({ active: false, startX: 0, startOffset: 0 })

  const modeRef     = useRef(mode)
  const assetRef    = useRef(asset)
  const tokenRef    = useRef(up_token)
  const intervalRef = useRef(interval)
  const targetRef   = useRef(target)
  const positionsRef = useRef(positions)
  const candlesRef  = useRef(candles)
  const viewingRef   = useRef(false)
  const viewingFutureRef = useRef(false)
  const viewStartRef = useRef(0)
  const viewEndRef   = useRef(0)
  const histPriceRef = useRef<{t: number; price: number}[]>([])
  const histProbRef  = useRef<{t: number; pct: number}[]>([])

  const prevAsset = useRef(asset)
  const flashRef    = useRef({ start: 0, end: 0 })
  const prevRollRef = useRef(rollover_rev)
  const animDurRef  = useRef(ANIM_MS[uiQuality] ?? 200)

  useEffect(() => { animDurRef.current = ANIM_MS[uiQuality] ?? 200 }, [uiQuality])

  const CAP    = 600
  // The live x span is one of WIN_RUNGS (see lib/chartCamera) — the old
  // WINDOW/WIN_MIN/WIN_MAX trio described a continuously growing span, which is
  // what made the curve squeeze instead of scroll.
  const WIN_MAX = WIN_RUNGS[WIN_RUNGS.length - 1]
  const PAD    = 0.10
  const RPAD   = 56
  const BAXIS  = 16
  const BLEED  = 80
  const FILL_STEP = 1000
  const GAP_MS    = 1500
  const MAX_DRAW_PTS = 900
  const PROB_BOUNDS: CamBounds = { min: 0, max: 100 }

  // ── Sync refs on every render ───────────────────────────────────────────
  modeRef.current     = mode
  assetRef.current     = asset
  tokenRef.current     = up_token
  intervalRef.current  = interval
  targetRef.current    = target
  positionsRef.current = Array.isArray(positions) ? positions : []
  candlesRef.current   = candles || []
  viewingRef.current   = !!viewing
  viewingFutureRef.current = !!viewing_future
  viewStartRef.current = view_start || 0
  viewEndRef.current   = view_end || 0

  // historical price path for line mode
  if (viewing && candles.length) {
    const vs = view_start || 0, ve = view_end || 0
    const hp: {t: number; price: number}[] = []
    for (const c of candles) {
      if (ve > vs && (c.time < vs || c.time >= ve)) continue
      const t0 = c.time * 1000
      hp.push({ t: t0, price: c.open })
      hp.push({ t: t0 + 60000, price: c.close })
    }
    hp.sort((a, b) => a.t - b.t)
    histPriceRef.current = hp
  } else if (!viewing) {
    histPriceRef.current = []
  }
  histProbRef.current = (viewing && Array.isArray(hist_prob)) ? hist_prob : []


  function pushPrice(t: number, price: number) {
    if (viewingRef.current) return
    if (!(price > 0)) return
    const a = priceBuf.current
    const last = a[a.length - 1]
    if (last && t - last.t < 250) { last.price = price }
    else { a.push({ t, price }); if (a.length > CAP) a.splice(0, a.length - CAP) }
    foldCandle(t, price)
  }

  function pushAsk(t: number, pct: number) {
    if (viewingRef.current) return
    if (pct == null || isNaN(pct)) return
    const a = askBuf.current
    const last = a[a.length - 1]
    if (last && t - last.t < 250) { last.pct = pct }
    else { a.push({ t, pct }); if (a.length > CAP) a.splice(0, a.length - CAP) }
  }

  function foldCandle(tMs: number, price: number) {
    const arr = ohlcRef.current
    if (arr.length === 0) return
    const slotSec = intervalSecs(intervalRef.current)
    const tSec = Math.floor(tMs / 1000)
    const last = arr[arr.length - 1]
    const bucket = Math.floor(tSec / slotSec) * slotSec
    if (bucket <= last.time) {
      last.close = price
      if (price > last.high) last.high = price
      if (price < last.low)  last.low  = price
    } else {
      arr.push({ time: bucket, open: last.close, high: price, low: price, close: price })
      if (arr.length > CAP) arr.splice(0, arr.length - CAP)
    }
  }

  // Seed ohlc from candles prop whenever it changes
  useEffect(() => {
    const cs = candlesRef.current
    if (cs && cs.length) {
      ohlcRef.current = cs.map((c) => ({
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
      }))
    }
  }, [candles.length, candles[0]?.time, candles[candles.length - 1]?.time])

  // Reset priceBuf on asset change
  useEffect(() => {
    if (prevAsset.current !== asset) {
      prevAsset.current = asset
      priceBuf.current = []
      zoomRef.current = {}
      camTgtRef.current = {}
      tipRef.current = {}
      winRef.current = {}
      rungRef.current = {}
      axisLblRef.current = {}
      candleView.current = { count: 70, offset: 0, targetCount: 70, targetOffset: 0, touched: false }
    }
  }, [asset])

  // §4 rollover: flash window + reset the per-window live buffers on rollover.
  // NOTE: do NOT clear ohlcRef — price candles are continuous across betting
  // windows; clearing blanked the candle chart every rollover (foldCandle
  // no-ops on an empty buffer, so it couldn't rebuild).
  // For exactly the same reason we do NOT clear priceBuf or the 'line' camera:
  // SPOT PRICE is continuous across betting windows too. Clearing it reset the
  // visible span to ~0 (re-squeezing the whole curve) and re-seeded the y camera
  // from a 2-point range — a ~16x zoom slam — at every single rollover.
  // Probability/ask data IS per-token, so that half still resets.
  useEffect(() => {
    if (prevRollRef.current === rollover_rev) return
    prevRollRef.current = rollover_rev
    if (viewingRef.current || viewingFutureRef.current) return
    askBuf.current = []
    delete zoomRef.current['step']
    delete camTgtRef.current['step']
    delete tipRef.current['step']
    delete winRef.current['step']
    delete rungRef.current['step']
    delete axisLblRef.current['step']
    const t = Date.now()
    flashRef.current = { start: t, end: t + 650 }
  }, [rollover_rev])

  // The ask series belongs to one token, so drop it when that token changes.
  // (This effect used to own the CLOB socket subscription too; the RAF loop
  // samples the ask off the store instead.)
  useEffect(() => { askBuf.current = [] }, [up_token])

  // ── Canvas + RAF render loop (mounted once) ───────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current!
    const container = containerRef.current!
    if (!canvas || !container) return
    const ctx = canvas.getContext('2d')!
    let raf = 0, disposed = false
    let cssW = 0, cssH = 0
    let candleIntro = { key: '', start: 0 }
    let lineIntro   = { key: '', start: 0 }
    let _modeLast = '', _modeT = 0, _dprNow = 1
    type DenseState = {
      buf: {t: number; [k: string]: number}[] | null   // identity of the source buffer
      pts: {t: number; v: number}[]
      lastT: number                                    // last COMMITTED source t
      live: boolean                                    // pts ends with the live sample
    }
    const denseCache: {line: DenseState; step: DenseState} = {
      line: { buf: null, pts: [], lastT: -Infinity, live: false },
      step: { buf: null, pts: [], lastT: -Infinity, live: false },
    }
    let tgtPin = { state: '', since: 0 }

    function resize() {
      const dpr = window.devicePixelRatio || 1
      const w = container.clientWidth
      const h = container.clientHeight
      if (w <= 0 || h <= 0) return
      cssW = w; cssH = h
      canvas.width  = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width  = w + 'px'
      canvas.style.height = h + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      _dprNow = dpr
    }

    const ro = new ResizeObserver(() => { resize() })
    ro.observe(container)
    resize()

    let BG   = '#0f0f0f'
    let GRID = '#1c1c1c'
    let TEXT = '#5e5e5e'
    let LIGHT = false
    function readThemeColors() {
      const css = getComputedStyle(document.documentElement)
      BG   = css.getPropertyValue('--tc-chart-bg').trim()   || '#0f0f0f'
      GRID = css.getPropertyValue('--tc-chart-grid').trim() || '#1c1c1c'
      TEXT = css.getPropertyValue('--tc-chart-text').trim() || '#5e5e5e'
      LIGHT = (document.documentElement.getAttribute('data-theme') === 'light')
    }
    function glowBlur(base: number) { return LIGHT ? Math.round(base * 0.5) : base }
    // Canvas needs concrete hex (CSS var() does not resolve in a 2D context),
    // and the chart keeps the VIVID candle hues in both themes — so these are
    // pinned to the literal accent hexes rather than the theme-aware C.* vars.
    const ORANGE = '#f7931a'
    const GREEN  = '#22d47b'
    const RED    = '#ef4444'
    const MONO   = `11px ${FONT.MONO}`
    const MONOS  = `10px ${FONT.MONO}`

    function onMove(e: MouseEvent) {
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left, y = e.clientY - rect.top
      const dr = dragRef.current
      if (dr.active) {
        const cv = candleView.current
        const pw = cssW - RPAD
        const barsPerPx = cv.count / Math.max(pw, 1)
        cv.offset = dr.startOffset + (x - dr.startX) * barsPerPx
        if (cv.offset < 0) cv.offset = 0
        cv.targetOffset = cv.offset
        hoverRef.current = null
      } else {
        hoverRef.current = { x, y }
        canvas.style.cursor = (modeRef.current === 'candles') ? 'grab' : 'crosshair'
      }
    }
    function onLeave() { hoverRef.current = null }
    function onDown(e: MouseEvent) {
      if (modeRef.current !== 'candles') return
      const rect = canvas.getBoundingClientRect()
      const cv = candleView.current
      cv.touched = true
      dragRef.current = { active: true, startX: e.clientX - rect.left, startOffset: cv.offset }
      canvas.style.cursor = 'grabbing'
    }
    function onUp() {
      dragRef.current.active = false
      canvas.style.cursor = (modeRef.current === 'candles') ? 'grab' : 'crosshair'
    }
    function onWheel(e: WheelEvent) {
      if (modeRef.current !== 'candles') return
      e.preventDefault()
      const cv = candleView.current
      cv.touched = true
      const old = cv.targetCount != null ? cv.targetCount : cv.count
      const avail = (ohlcRef.current || []).length
      const maxBars = Math.max(24, Math.min(1500, avail || 1500))
      const next = Math.max(Math.min(24, maxBars), Math.min(maxBars, old * (e.deltaY > 0 ? 1.15 : 0.87)))
      const rect = canvas.getBoundingClientRect()
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(cssW - RPAD, 1)))
      const curOff = cv.targetOffset != null ? cv.targetOffset : cv.offset
      cv.targetOffset = Math.max(0, curOff + (1 - frac) * (old - next))
      cv.targetCount = next
    }
    function onDbl() { candleView.current = { count: 70, offset: 0, targetCount: 70, targetOffset: 0, touched: false } }

    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mouseleave', onLeave)
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mouseup', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('dblclick', onDbl)

    function roundRect(x: number, y: number, w: number, h: number, r: number) {
      ctx.beginPath()
      ctx.moveTo(x + r, y)
      ctx.arcTo(x + w, y,     x + w, y + h, r)
      ctx.arcTo(x + w, y + h, x,     y + h, r)
      ctx.arcTo(x,     y + h, x,     y,     r)
      ctx.arcTo(x,     y,     x + w, y,     r)
      ctx.closePath()
    }

    function pill(text: string, px: number, py: number, bg: string, fg: string) {
      ctx.font = MONO
      const tw = ctx.measureText(text).width
      const padX = 7, h = 18
      const w = tw + padX * 2
      let x = px, y = py - h / 2
      if (x + w > cssW) x = cssW - w
      if (y < 0) y = 0
      if (y + h > cssH) y = cssH - h
      ctx.fillStyle = bg
      roundRect(x, y, w, h, 9)
      ctx.fill()
      ctx.fillStyle = fg
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.fillText(text, x + padX, y + h / 2 + 0.5)
    }

    function drawChevron(cx: number, cy: number, dirUp: boolean, alpha: number, color: string) {
      if (alpha <= 0.01) return
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'
      const hw = 4.5, hh = 3
      ctx.beginPath()
      if (dirUp) { ctx.moveTo(cx - hw, cy + hh); ctx.lineTo(cx, cy - hh); ctx.lineTo(cx + hw, cy + hh) }
      else       { ctx.moveTo(cx - hw, cy - hh); ctx.lineTo(cx, cy + hh); ctx.lineTo(cx + hw, cy - hh) }
      ctx.stroke()
      ctx.restore()
    }
    function blinkAlpha(now: number, offset: number) {
      const phase = ((now + (offset || 0)) % 1500) / 1500
      return phase < 0.25 ? phase / 0.25 : (phase < 0.75 ? 1 : Math.max(0, 1 - (phase - 0.75) / 0.25))
    }

    // Sniper-scope reticle marking the target line (replaces the "Target" word).
    function drawSniper(cx: number, cy: number, color: string) {
      ctx.save()
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5
      ctx.lineCap = 'round'
      const r = 6, t = 4
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(cx, cy - r - t); ctx.lineTo(cx, cy - r + 1)
      ctx.moveTo(cx, cy + r - 1); ctx.lineTo(cx, cy + r + t)
      ctx.moveTo(cx - r - t, cy); ctx.lineTo(cx - r + 1, cy)
      ctx.moveTo(cx + r - 1, cy); ctx.lineTo(cx + r + t, cy)
      ctx.stroke()
      ctx.beginPath(); ctx.arc(cx, cy, 1.3, 0, Math.PI * 2); ctx.fill()
      ctx.restore()
    }

    function drawTargetLine(y: number, color: string, avoidY?: number) {
      ctx.save()
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.setLineDash([5, 5])
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(cssW - 36, y) // run the line right up to the sniper reticle
      ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()
      let py = y
      if (avoidY != null && Math.abs(py - avoidY) < 20) py = avoidY + (py >= avoidY ? 20 : -20)
      drawSniper(cssW - 26, py, ORANGE)
    }

    function drawTargetOverlay(yOf: (v: number) => number, target: number, color?: string, avoidY?: number, pinOpts?: {now: number; ph: number}) {
      if (!(target > 0)) return
      const y = yOf(target)
      if (!isFinite(y)) return
      const ph = (pinOpts && pinOpts.ph != null) ? pinOpts.ph : (cssH - BAXIS)
      const col = color || 'rgba(255,255,255,0.25)'

      if (!pinOpts) {
        if (y < 0 || y > ph) return
        drawTargetLine(y, col, avoidY)
        return
      }

      const now = pinOpts.now
      const state = (y < 0) ? 'above' : (y > ph) ? 'below' : 'in'
      if (tgtPin.state !== state) { tgtPin.state = state; tgtPin.since = now }
      const fade = easeOutCubic((now - tgtPin.since) / 180)

      ctx.save()
      ctx.globalAlpha = fade
      if (state === 'in') {
        drawTargetLine(y, col, avoidY)
      } else {
        const up = (state === 'above')
        const py = up ? 12 : (ph - 24)
        drawSniper(cssW - 26, py, ORANGE)
        const chx = cssW - 26 - 16
        const cy0 = up ? (py + 9) : (py - 9)
        drawChevron(chx, cy0,                  up, fade * blinkAlpha(now, 0),   ORANGE)
        drawChevron(chx, cy0 + (up ? 6 : -6),  up, fade * blinkAlpha(now, 400), ORANGE)
      }
      ctx.restore()
    }


    function drawPositionLines(yOf: (v: number) => number, ph: number) {
      const rows = positionsRef.current
      if (!Array.isArray(rows) || !rows.length) return
      const pw = cssW - RPAD
      for (const r of rows) {
        const cents = (r && r.price != null) ? +r.price : NaN
        if (!isFinite(cents) || cents <= 0 || cents > 100) continue
        const y = yOf(cents)
        if (!isFinite(y) || y < 0 || y > ph) continue
        const up = (r.side === 'UP')
        const col = up ? GREEN : RED
        const rgb = up ? C.GREEN_RGB : C.RED_RGB
        const yy = Math.round(y) + 0.5
        ctx.save()
        ctx.strokeStyle = col
        ctx.globalAlpha = 0.7
        ctx.lineWidth = 1
        ctx.setLineDash([2, 3])
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(pw, yy); ctx.stroke()
        ctx.restore()
        const label = (up ? 'UP ' : 'DOWN ') + Math.round(cents) + '¢'
        ctx.save()
        ctx.font = MONOS
        const tw = ctx.measureText(label).width
        let cy = y; if (cy < 8) cy = 8; if (cy > ph - 8) cy = ph - 8
        ctx.fillStyle = 'rgba(' + rgb + ',0.16)'
        roundRect(4, cy - 8, tw + 10, 16, 3); ctx.fill()
        ctx.fillStyle = col
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
        ctx.fillText(label, 9, cy + 0.5)
        ctx.restore()
      }
    }

    function timeLabel(ms: number, withSec: boolean) {
      const d = new Date(ms)
      const hh = String(d.getUTCHours()).padStart(2, '0')
      const mm = String(d.getUTCMinutes()).padStart(2, '0')
      if (!withSec) return hh + ':' + mm
      const ss = String(d.getUTCSeconds()).padStart(2, '0')
      return hh + ':' + mm + ':' + ss
    }

    const _AXIS_STEPS = [5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 180e3, 300e3, 600e3, 900e3, 18e5, 36e5]
    function drawTimeAxis(xMin: number, xMax: number) {
      const pw = cssW - RPAD
      const span = xMax - xMin
      if (!(span > 0)) return
      const target = span / 5
      let step = _AXIS_STEPS[_AXIS_STEPS.length - 1]
      for (const s of _AXIS_STEPS) { if (s >= target) { step = s; break } }
      const withSec = step < 60e3
      ctx.fillStyle = TEXT
      ctx.font = MONOS
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      for (let t = Math.ceil(xMin / step) * step; t <= xMax; t += step) {
        const x = ((t - xMin) / span) * pw
        if (x < 18 || x > pw - 18) continue
        ctx.fillText(timeLabel(t, withSec), x, cssH - 2)
      }
    }

    function fmtPrice(v: number) {
      return '$' + v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 4 : 0 })
    }

    function priceScale(yLo: number, yHi: number, _target: number, ph: number, lastY?: number) {
      const pw = cssW - RPAD
      const step = niceStep(yHi - yLo, 5)
      if (!(step > 0) || !isFinite(step)) return
      const yOf = (v: number) => ph - ((v - yLo) / (yHi - yLo)) * ph
      ctx.font = MONOS
      ctx.textBaseline = 'middle'
      const start = Math.ceil(yLo / step) * step
      ctx.save(); ctx.globalAlpha = LIGHT ? 0.7 : 0.55
      for (let v = start; v <= yHi; v += step) {
        const y = yOf(v)
        if (y < 6 || y > ph - 6) continue
        ctx.strokeStyle = GRID; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(pw, Math.round(y) + 0.5); ctx.stroke()
        if (lastY != null && Math.abs(y - lastY) < 16) continue
        ctx.save(); ctx.globalAlpha = 1; ctx.fillStyle = TEXT; ctx.textAlign = 'right'
        ctx.fillText(fmtPrice(v), cssW - 5, y); ctx.restore()
      }
      ctx.restore()
    }

    function animatedScale(key: string, yLo: number, yHi: number, ph: number, lastY: number|undefined, now: number, fmt: (v: number) => string) {
      const store = axisLblRef.current
      let st = store[key]
      if (!st) { st = store[key] = { ticks: new Map(), lastCalc: 0 } }
      const pw = cssW - RPAD
      if (now - st.lastCalc >= 100) {
        st.lastCalc = now
        const step = niceStep(yHi - yLo, 5)
        const targets = new Map<string, {v: number; ty: number}>()
        if (step > 0 && isFinite(step) && yHi > yLo) {
          const start = Math.ceil(yLo / step) * step
          for (let v = start; v <= yHi; v += step) {
            const ty = ph - ((v - yLo) / (yHi - yLo)) * ph
            if (ty < 6 || ty > ph - 6) continue
            targets.set(v.toFixed(6), { v, ty })
          }
        }
        let anyDying = false
        for (const e of st.ticks.values()) { if (e.dying) { anyDying = true; break } }
        for (const [k, t] of targets) {
          const e = st.ticks.get(k)
          if (e) { e.targetY = t.ty; e.dying = false }
          else st.ticks.set(k, { v: t.v, y: t.ty, targetY: t.ty, alpha: 0, dying: false, bornAt: now + (anyDying ? 100 : 0), dieAt: 0 })
        }
        for (const [k, e] of st.ticks) {
          if (!targets.has(k) && !e.dying) { e.dying = true; e.dieAt = now }
        }
      }
      ctx.font = MONOS
      ctx.textBaseline = 'middle'
      const gA = LIGHT ? 0.7 : 0.55
      const dead: string[] = []
      for (const [k, e] of st.ticks) {
        e.y += (e.targetY - e.y) * smoothK(60)
        if (e.dying) {
          const f = Math.min((now - e.dieAt) / 150, 1)
          e.alpha = 1 - easeInOutCubic(f)
          if (f >= 1) { dead.push(k); continue }
        } else {
          const f = Math.min(Math.max(0, now - e.bornAt) / 150, 1)
          e.alpha = easeInOutCubic(f)
        }
        if (e.alpha <= 0.01) continue
        const y = e.y
        ctx.save()
        ctx.globalAlpha = gA * e.alpha
        ctx.strokeStyle = GRID; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(pw, Math.round(y) + 0.5); ctx.stroke()
        ctx.restore()
        if (lastY != null && Math.abs(y - lastY) < 16) continue
        ctx.save()
        ctx.globalAlpha = e.alpha
        ctx.fillStyle = TEXT; ctx.textAlign = 'right'
        ctx.fillText(fmt(e.v), cssW - 5, y)
        ctx.restore()
      }
      for (const k of dead) st.ticks.delete(k)
    }

    let _dt = 16, _lastFrameT = 0
    function smoothK(tauMs: number) { return 1 - Math.exp(-_dt / Math.max(tauMs, 1)) }
    function easeOutCubic(t: number) { t = Math.max(0, Math.min(1, t)); return 1 - Math.pow(1 - t, 3) }
    function easeInOutCubic(t: number) { t = Math.max(0, Math.min(1, t)); return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2 }

    function lerpZoom(key: string, lo: number, hi: number): [number, number] {
      const z = zoomRef.current
      const k = z[key]
      if (!k || !isFinite(k.lo) || !isFinite(k.hi)) { z[key] = { lo, hi }; return [lo, hi] }
      const range = Math.max(hi - lo, 1e-9)
      if (Math.abs(lo - k.lo) > range * 4 || Math.abs(hi - k.hi) > range * 4) {
        z[key] = { lo, hi }; return [lo, hi]
      }
      const f = smoothK(95)
      k.lo += (lo - k.lo) * f
      k.hi += (hi - k.hi) * f
      return [k.lo, k.hi]
    }

    // Camera y-scale: a STEP function of the visible data (quantizeCam), eased
    // only ACROSS a step. The old version eased toward a target recomputed from
    // continuously-moving data, so the vertical scale never settled — a fixed
    // price still accumulated ~1000px of vertical travel over a few minutes.
    // Easing toward a piecewise-CONSTANT target settles exactly and then holds,
    // which is what makes the curve translate instead of warp.
    function camZoom(key: string, dataLo: number, dataHi: number, bounds?: CamBounds): [number, number] {
      const tgt = quantizeCam(dataLo, dataHi, camTgtRef.current[key], bounds)
      camTgtRef.current[key] = tgt
      const z = zoomRef.current
      const k = z[key]
      if (!k || !isFinite(k.lo) || !isFinite(k.hi)) { z[key] = { lo: tgt.lo, hi: tgt.hi }; return [tgt.lo, tgt.hi] }
      const f = smoothK(120)
      // Snap inside epsilon so the transform becomes bit-identical between steps
      // (an asymptote that never arrives is still sub-pixel motion every frame).
      const eps = (tgt.hi - tgt.lo) * 1e-3
      k.lo = Math.abs(tgt.lo - k.lo) <= eps ? tgt.lo : k.lo + (tgt.lo - k.lo) * f
      k.hi = Math.abs(tgt.hi - k.hi) <= eps ? tgt.hi : k.hi + (tgt.hi - k.hi) * f
      return [k.lo, k.hi]
    }

    // The visible x span: quantized rung, eased ONLY while a rung change is in
    // flight (~400ms). Between rungs the span is constant, so xMin = xMax - win
    // moves every point left at identical px/ms.
    function camSpan(key: string, span0: number): number {
      const rung = pickWindowRung(span0, rungRef.current[key])
      rungRef.current[key] = rung
      const w = lerpWindow(key, rung)
      if (Math.abs(rung - w) <= rung * 1e-3) { winRef.current[key] = rung; return rung }
      return w
    }

    function lerpTip(key: string, val: number) {
      const t = tipRef.current
      const cur = t[key]
      if (cur == null || !isFinite(cur)) { t[key] = val; return val }
      if (Math.abs(val - cur) > Math.max(Math.abs(val) * 0.05, 1e-9) * 20) {
        t[key] = val; return val
      }
      t[key] = cur + (val - cur) * smoothK(70)
      return t[key]
    }

    function lerpWindow(key: string, target: number) {
      const w = winRef.current
      const cur = w[key]
      if (cur == null || !isFinite(cur)) { w[key] = target; return target }
      w[key] = cur + (target - cur) * smoothK(150)
      return w[key]
    }

    const CORNER_R = 22
    function splineThrough(pts: {x: number; y: number}[]) {
      const n = pts.length
      if (n < 2) return
      if (n === 2) { ctx.lineTo(pts[1].x, pts[1].y); return }
      for (let i = 1; i < n - 1; i++) {
        const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1]
        const d01 = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1
        const d12 = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1
        const r = Math.min(CORNER_R, d01 * 0.5, d12 * 0.5)
        const ax = p1.x - (p1.x - p0.x) * (r / d01)
        const ay = p1.y - (p1.y - p0.y) * (r / d01)
        const bx = p1.x + (p2.x - p1.x) * (r / d12)
        const by = p1.y + (p2.y - p1.y) * (r / d12)
        ctx.lineTo(ax, ay)
        ctx.quadraticCurveTo(p1.x, p1.y, bx, by)
      }
      ctx.lineTo(pts[n - 1].x, pts[n - 1].y)
    }

    // APPEND-ONLY dense curve.
    //
    // The old version rebuilt the whole tail every tick (its cache key included
    // the live value) and re-synthesised five eased points between the last two
    // samples. Both re-shape history: the synth points slide as the live sample
    // moves, so the segment that was drawn last frame is not the segment drawn
    // this frame. Now every point except the live one is committed ONCE and never
    // touched again, so the past is genuinely immutable and can only translate.
    //
    // Flat gap-fill for a stale feed stays — that describes real (missing) data,
    // not an interpolation of the live pair.
    function buildDense(buf: {t: number; [k: string]: number}[], getV: (p: {t: number; [k: string]: number}) => number, cacheKey: 'line'|'step') {
      const c = denseCache[cacheKey]
      if (!buf || buf.length === 0) { c.buf = null; c.pts = []; c.lastT = -Infinity; c.live = false; return c.pts }
      // Buffer identity, not contents: every reset path replaces the array
      // (priceBuf.current = []) while the CAP splice keeps it, which is exactly
      // the distinction between "start over" and "keep appending".
      if (c.buf !== buf) { c.buf = buf; c.pts = []; c.lastT = -Infinity; c.live = false }
      if (c.live) { c.pts.pop(); c.live = false }   // drop last frame's live point

      const lastI = buf.length - 1
      for (let i = 0; i < lastI; i++) {
        const p = buf[i]
        if (p.t <= c.lastT) continue
        const v = getV(p)
        if (!isFinite(v)) continue
        // 1s buckets on absolute time — a committed point never changes bucket.
        if (c.pts.length && Math.floor(c.lastT / 1000) === Math.floor(p.t / 1000)) continue
        const prev = c.pts[c.pts.length - 1]
        if (prev && p.t - prev.t > GAP_MS) {
          const fillEnd = p.t - GAP_MS
          for (let ft = prev.t + FILL_STEP; ft <= fillEnd; ft += FILL_STEP) c.pts.push({ t: ft, v: prev.v })
        }
        c.pts.push({ t: p.t, v })
        c.lastT = p.t
      }

      // The live sample rides on the end, replaced (not accumulated) each frame.
      const lastB = buf[lastI]
      const lv = getV(lastB)
      if (isFinite(lv) && lastB.t >= c.lastT) {
        const prev = c.pts[c.pts.length - 1]
        if (prev && lastB.t - prev.t > GAP_MS) {
          const fillEnd = lastB.t - GAP_MS
          for (let ft = prev.t + FILL_STEP; ft <= fillEnd; ft += FILL_STEP) c.pts.push({ t: ft, v: prev.v })
          c.lastT = c.pts[c.pts.length - 1].t
        }
        c.pts.push({ t: lastB.t, v: lv })
        c.live = true
      }

      // Trim well behind the widest window so the left edge never truncates.
      const minT = Date.now() - WIN_MAX - 5000
      let drop = 0
      while (drop < c.pts.length - 2 && c.pts[drop + 1].t < minT) drop++
      if (drop > 0) c.pts.splice(0, drop)
      return c.pts
    }

    function densePathPts(
      dense: {t: number; v: number}[],
      xMin: number,
      xOf: (t: number) => number,
      yOf: (v: number) => number,
      vis: {t: number; [k: string]: number}[],
      getV: (p: {t: number; [k: string]: number}) => number,
    ): {x: number; y: number}[] {
      let d = dense.filter((p) => p.t >= xMin)
      if (d.length > MAX_DRAW_PTS) {
        // Bucket on ABSOLUTE time, not on index: an index stride re-picks which
        // points survive as the window scrolls, so the curve shimmers between two
        // shapes. A time bucket keeps the same survivors frame after frame.
        const bucket = decimateBucketMs(d[d.length - 1].t - d[0].t, MAX_DRAW_PTS)
        const dec: typeof d = []
        let lastB = NaN
        for (const p of d) {
          const b = Math.floor(p.t / bucket)
          if (b === lastB) continue
          lastB = b
          dec.push(p)
        }
        if (dec[dec.length - 1] !== d[d.length - 1]) dec.push(d[d.length - 1])
        d = dec
      }
      const out: {x: number; y: number}[] = []
      for (const p of d) out.push({ x: xOf(p.t), y: yOf(p.v) })
      if (!out.length) { for (const p of vis) out.push({ x: xOf(p.t), y: yOf(getV(p)) }) }
      return out
    }

    function traceCurveTo(pts: {x: number; y: number}[]) {
      if (!pts.length) return
      ctx.lineTo(pts[0].x, pts[0].y)
      splineThrough(pts)
    }

    function tracePath(pts: {x: number; y: number}[]) {
      if (!pts.length) return
      ctx.moveTo(pts[0].x, pts[0].y)
      splineThrough(pts)
    }

    function fillAreaGradient(rgb: string, ph: number) {
      const a0 = LIGHT ? 0.16 : 0.26
      const g = ctx.createLinearGradient(0, 0, 0, ph)
      // Smooth eased falloff (many stops) — avoids the visible mid-band that a
      // 3-stop gradient produced.
      const N = 12
      for (let i = 0; i <= N; i++) {
        const t = i / N
        const a = a0 * Math.pow(1 - t, 2.0) // ease-out toward 0
        g.addColorStop(t, `rgba(${rgb},${a.toFixed(4)})`)
      }
      ctx.fillStyle = g
      ctx.fill()
    }

    function strokeGlowLine(color: string, rgb: string) {
      ctx.save()
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.shadowColor = 'rgba(' + rgb + ',' + (LIGHT ? 0.35 : 0.6) + ')'
      ctx.shadowBlur = glowBlur(LIGHT ? 8 : 14)
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.restore()
    }

    function pulseRing(x: number, y: number, color: string, now: number) {
      const phase = (now % 1500) / 1500
      ctx.save()
      ctx.beginPath()
      ctx.arc(x, y, 4 + phase * 11, 0, Math.PI * 2)
      ctx.strokeStyle = color
      ctx.globalAlpha = (1 - phase) * 0.55
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.restore()
      ctx.save()
      ctx.shadowBlur = 12; ctx.shadowColor = color
      ctx.fillStyle = color
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill()
      ctx.restore()
    }

    function targetNear(target: number, lo: number, hi: number) {
      if (!(target > 0) || !isFinite(lo) || !isFinite(hi)) return false
      const mid = (lo + hi) / 2
      if (!(mid > 0)) return true
      return Math.abs(target - mid) <= mid * 0.12
    }
    function targetSane(target: number, mid: number) {
      if (!(target > 0)) return false
      if (!(mid > 0)) return true
      return Math.abs(target - mid) <= mid * 0.5
    }

    function niceStep(range: number, rows: number) {
      const raw = Math.max(range, 1e-9) / Math.max(rows, 1)
      const mag = Math.pow(10, Math.floor(Math.log10(raw)))
      const norm = raw / mag
      let s: number
      if (norm <= 1) s = 1; else if (norm <= 2) s = 2; else if (norm <= 2.5) s = 2.5
      else if (norm <= 5) s = 5; else s = 10
      return s * mag
    }

    function drawLivePrice(y: number, color: string, label: string) {
      const pw = cssW - RPAD
      const yy = Math.round(y) + 0.5
      ctx.save()
      ctx.strokeStyle = color
      ctx.globalAlpha = 0.55
      ctx.lineWidth = 1
      ctx.setLineDash([2, 4])
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(pw, yy); ctx.stroke()
      ctx.restore()
      ctx.save()
      ctx.font = MONOS
      const tw = ctx.measureText(label).width
      let cy = y; if (cy < 9) cy = 9; if (cy > cssH - 9) cy = cssH - 9
      const bx = cssW - tw - 8
      ctx.fillStyle = color
      roundRect(bx - 3, cy - 8, tw + 7, 16, 3); ctx.fill()
      ctx.fillStyle = BG
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(label, bx, cy + 0.5)
      ctx.restore()
    }

    function drawCrosshair(
      xOf: (t: number) => number,
      yOf: (v: number) => number,
      ph: number,
      data: {t?: number; time?: number; [k: string]: unknown}[],
      getT: (d: {t?: number; time?: number; [k: string]: unknown}) => number,
      getV: (d: {t?: number; time?: number; [k: string]: unknown}) => number,
      fmtV: (v: number) => string,
      color: string,
    ) {
      const hv = hoverRef.current
      if (!hv || !data || !data.length) return
      const pw = cssW - RPAD
      const hx = hv.x
      if (hx < 0 || hx > pw) return
      let best: {t?: number; time?: number; [k: string]: unknown}|null = null, bdx = Infinity
      for (const d of data) {
        const dx = Math.abs(xOf(getT(d)) - hx)
        if (dx < bdx) { bdx = dx; best = d }
      }
      if (!best) return
      const px = xOf(getT(best))
      if (px < 0 || px > pw) return
      const v = getV(best)
      const py = yOf(v)

      const cxr = Math.round(px) + 0.5
      ctx.save()
      const vg = ctx.createLinearGradient(0, 0, 0, ph)
      const cw = LIGHT ? 0.26 : 0.34
      vg.addColorStop(0,    'rgba(184,184,184,0)')
      vg.addColorStop(0.12, 'rgba(184,184,184,' + cw + ')')
      vg.addColorStop(0.88, 'rgba(184,184,184,' + cw + ')')
      vg.addColorStop(1,    'rgba(184,184,184,0)')
      ctx.strokeStyle = vg
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(cxr, 0); ctx.lineTo(cxr, ph); ctx.stroke()
      ctx.restore()
      ctx.save()
      ctx.strokeStyle = color; ctx.globalAlpha = LIGHT ? 0.3 : 0.45; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.stroke()
      ctx.restore()
      ctx.save()
      ctx.shadowColor = color; ctx.shadowBlur = glowBlur(LIGHT ? 5 : 10)
      ctx.fillStyle = color; ctx.strokeStyle = BG; ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill()
      ctx.shadowBlur = 0; ctx.stroke()
      ctx.restore()

      const ticker = (assetRef.current || '').toUpperCase()
      const l1 = ticker + '  ' + fmtV(v)
      const d = new Date(getT(best))
      const l2 = d.toLocaleString('en-US', { month: 'short', day: '2-digit', year: 'numeric',
                                             hour: '2-digit', minute: '2-digit', second: '2-digit' })
      ctx.save()
      const F1 = `bold 12px ${FONT.MONO}`
      ctx.font = F1; const w1 = ctx.measureText(l1).width
      ctx.font = MONOS; const w2 = ctx.measureText(l2).width
      const tw = Math.max(w1, w2)
      let cx = px; cx = Math.max(tw / 2 + 8, Math.min(pw - tw / 2 - 8, cx))
      // theme-aware tooltip: light pill on light, dark pill on dark — with the
      // price/date pinned to legible literals so they can never read as black
      ctx.fillStyle = LIGHT ? 'rgba(251,252,253,0.97)' : 'rgba(15,15,15,0.94)'
      ctx.strokeStyle = LIGHT ? 'rgba(16,24,40,0.12)' : 'rgba(255,255,255,0.10)'
      ctx.lineWidth = 1
      roundRect(cx - tw / 2 - 7, 4, tw + 14, 34, 6); ctx.fill(); ctx.stroke()
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.font = F1; ctx.fillStyle = LIGHT ? '#11151f' : '#f2f3f5'; ctx.fillText(l1, cx, 14)
      ctx.font = MONOS; ctx.fillStyle = LIGHT ? '#5b6675' : '#9aa1ad'; ctx.fillText(l2, cx, 29)
      ctx.restore()
    }

    function frozenXform(buf?: { t: number }[]) {
      const pw = cssW - RPAD, ph = cssH - BAXIS
      // Default to the theoretical window range, but fit to the actual data
      // extent when present so the series fills the canvas (a partial window —
      // e.g. one still filling in — otherwise squishes into the left).
      let xMin = viewStartRef.current * 1000, xMax = viewEndRef.current * 1000
      if (buf && buf.length) {
        const t0 = buf[0].t, t1 = buf[buf.length - 1].t
        if (isFinite(t0) && isFinite(t1) && t1 > t0) { xMin = t0; xMax = t1 }
      }
      const xOf = (t: number) => ((t - xMin) / (xMax - xMin)) * pw
      return { pw, ph, xMin, xMax, xOf }
    }

    function drawLineFrozen() {
      const buf = histPriceRef.current
      const { pw, ph, xMin, xMax, xOf } = frozenXform(buf)
      const tgt = targetRef.current
      if (!buf.length || !(xMax > xMin)) { drawEmpty('loading history…'); return }
      let lo = Infinity, hi = -Infinity
      for (const p of buf) { if (p.price < lo) lo = p.price; if (p.price > hi) hi = p.price }
      if (lo === hi) { lo -= 1; hi += 1 }
      const tNear = targetNear(tgt, lo, hi)
      if (tNear) { lo = Math.min(lo, tgt); hi = Math.max(hi, tgt) }
      const span = hi - lo, pad = span * 0.18
      const yLo = lo - pad, yHi = hi + pad
      const yOf = (v: number) => ph - ((v - yLo) / (yHi - yLo)) * ph
      priceScale(yLo, yHi, tNear ? tgt : 0, ph, -100)
      drawTimeAxis(xMin, xMax)
      if (tNear) drawTargetOverlay(yOf, tgt, 'rgba(247,147,26,0.5)', -100)
      const pts = []
      for (const p of buf) pts.push({ x: Math.max(0, Math.min(pw, xOf(p.t))), y: yOf(p.price) })
      const last = pts[pts.length - 1]
      ctx.save(); ctx.beginPath(); ctx.moveTo(pts[0].x, ph); traceCurveTo(pts)
      ctx.lineTo(last.x, ph); ctx.closePath()
      fillAreaGradient('247,147,26', ph); ctx.restore()
      ctx.beginPath(); tracePath(pts)
      strokeGlowLine(ORANGE, '247,147,26')
      ctx.save(); ctx.shadowColor = ORANGE; ctx.shadowBlur = glowBlur(LIGHT ? 5 : 10)
      ctx.fillStyle = ORANGE; ctx.beginPath(); ctx.arc(last.x, last.y, 3, 0, Math.PI * 2); ctx.fill(); ctx.restore()
      drawCrosshair(xOf, yOf, ph, buf as {t: number}[], (p) => (p as {t: number}).t, (p) => (p as {price: number}).price, fmtPrice, ORANGE)
    }

    function drawStepFrozen() {
      const buf = histProbRef.current
      const { pw, ph, xMin, xMax, xOf } = frozenXform(buf)
      if (!buf.length) { drawEmpty('no probability history for this window'); return }
      if (!(xMax > xMin)) { drawEmpty('loading history…'); return }
      let tlo = Infinity, thi = -Infinity
      for (const p of buf) { if (p.pct < tlo) tlo = p.pct; if (p.pct > thi) thi = p.pct }
      tlo = Math.max(0, Math.floor((tlo - 8) / 5) * 5)
      thi = Math.min(100, Math.ceil((thi + 8) / 5) * 5)
      if (thi - tlo < 10) { thi = Math.min(100, tlo + 10) }
      tlo = Math.min(tlo, 50); thi = Math.max(thi, 50)
      const yOf = (v: number) => ph - ((v - tlo) / (thi - tlo)) * ph
      ctx.font = MONOS; ctx.textBaseline = 'middle'
      const stepP = niceStep(thi - tlo, 5)
      for (let v = Math.ceil(tlo / stepP) * stepP; v <= thi; v += stepP) {
        const gy = yOf(v)
        if (gy < 6 || gy > ph - 6) continue
        ctx.strokeStyle = GRID; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(0, Math.round(gy) + 0.5); ctx.lineTo(pw, Math.round(gy) + 0.5); ctx.stroke()
        ctx.fillStyle = TEXT; ctx.textAlign = 'right'
        ctx.fillText(Math.round(v) + '%', cssW - 5, gy)
      }
      drawTimeAxis(xMin, xMax)
      drawPositionLines(yOf, ph)
      // Dynamic heat: colour by the window's resolved/last probability.
      const PC = buf[buf.length - 1].pct
      const COL = probColor(PC), RGB = probRgb(PC)
      const pts = []
      for (const p of buf) pts.push({ x: Math.max(0, Math.min(pw, xOf(p.t))), y: yOf(p.pct) })
      const last = pts[pts.length - 1]
      ctx.save(); ctx.beginPath(); ctx.moveTo(pts[0].x, ph); traceCurveTo(pts)
      ctx.lineTo(last.x, ph); ctx.closePath()
      fillAreaGradient(RGB, ph); ctx.restore()
      ctx.beginPath(); tracePath(pts)
      strokeGlowLine(COL, RGB)
      ctx.save(); ctx.shadowColor = COL; ctx.shadowBlur = glowBlur(LIGHT ? 5 : 10)
      ctx.fillStyle = COL; ctx.beginPath(); ctx.arc(last.x, last.y, 3, 0, Math.PI * 2); ctx.fill(); ctx.restore()
      drawCrosshair(xOf, yOf, ph, buf as {t: number}[], (p) => (p as {t: number}).t, (p) => (p as {pct: number}).pct, (v) => Math.round(v) + '%', COL)
    }

    function forwardLabel() {
      const vs = viewStartRef.current
      if (!vs) return 'next window'
      const d = new Date(vs * 1000)
      const hh = String(d.getUTCHours()).padStart(2, '0')
      const mm = String(d.getUTCMinutes()).padStart(2, '0')
      return 'window opens at ' + hh + ':' + mm + ' UTC'
    }

    function drawForwardFlat(color: string, _rgb: string, labelFn: () => string) {
      const pw = cssW - RPAD, ph = cssH - BAXIS
      const y = Math.round(ph * 0.5) + 0.5
      ctx.save()
      ctx.strokeStyle = color; ctx.globalAlpha = LIGHT ? 0.5 : 0.6
      ctx.lineWidth = 2; ctx.setLineDash([])
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(pw, y); ctx.stroke()
      ctx.restore()
      drawLivePrice(y, color, labelFn())
      ctx.save()
      ctx.fillStyle = TEXT; ctx.font = MONO
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(forwardLabel(), pw / 2, ph * 0.5 - 22)
      ctx.restore()
    }

    function drawLine(now: number) {
      if (viewingFutureRef.current) { drawForwardFlat(ORANGE, '247,147,26', () => 'Target'); return }
      if (viewingRef.current) { drawLineFrozen(); return }
      const pw = cssW - RPAD
      const ph = cssH - BAXIS
      const buf = priceBuf.current
      const tgt = targetRef.current
      if (!buf.length) { drawEmpty('waiting for price…'); return }

      const last = buf[buf.length - 1]
      // Quantized span, and xMin pinned to it UNCONDITIONALLY. The old code
      // clamped xMin to buf[0].t with a span that grew every frame, so the left
      // edge stood still while the right edge advanced — the whole curve was
      // squeezed horizontally every tick instead of sliding. A short buffer now
      // occupies only part of the width; that is correct, and the left-bleed
      // extrapolation below already handles a path that starts mid-canvas.
      const win = camSpan('line', now - buf[0].t)
      const xMax = now
      const xMin = xMax - win
      const xOf = (t: number) => ((t - xMin) / win) * pw

      let vis = buf.filter((p) => p.t >= xMin)
      if (vis.length < 2) vis = buf.slice(-2)

      const tipVal = lerpTip('line', last.price)

      let lo = Infinity, hi = -Infinity
      for (const p of vis) { if (p.price < lo) lo = p.price; if (p.price > hi) hi = p.price }
      lo = Math.min(lo, tipVal); hi = Math.max(hi, tipVal)
      if (lo === hi) { lo -= 1; hi += 1 }
      const dataMid = (lo + hi) / 2
      const tNear = targetNear(tgt, lo, hi)
      if (tNear) { lo = Math.min(lo, tgt); hi = Math.max(hi, tgt) }
      const tSane = targetSane(tgt, dataMid)
      const [yLo, yHi] = camZoom('line', lo, hi)
      const yOf = (v: number) => ph - ((v - yLo) / (yHi - yLo)) * ph
      const tipY = yOf(tipVal)

      animatedScale('line', yLo, yHi, ph, tipY, now, fmtPrice)
      drawTimeAxis(xMin, xMax)
      if (tSane) drawTargetOverlay(yOf, tgt, 'rgba(247,147,26,0.5)', tipY, { now, ph })

      const lk = 'L' + assetRef.current
      if (lineIntro.key !== lk) lineIntro = { key: lk, start: now }
      const _ld = animDurRef.current; const sweep = _ld <= 0 ? 1 : easeOutCubic((now - lineIntro.start) / (_ld + 250))
      // mode-select entrance: reveal left→right at the line's real positions
      // (no vertical expand — that made the line start mid-screen and drop).
      if (sweep < 1) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, (pw + RPAD) * sweep, cssH); ctx.clip() }

      // Tip indicator stays flush at the right edge.
      const tipX = pw
      const dense = buildDense(buf as {t: number; [k: string]: number}[], (p) => (p as unknown as {price: number}).price, 'line')
      const pathPts = densePathPts(dense, xMin, xOf, yOf, vis as {t: number; [k: string]: number}[], (p) => (p as unknown as {price: number}).price)
      pathPts.push({ x: tipX, y: tipY })
      // Bleed off the left edge only when the path actually REACHES that edge.
      // With a quantized span a young buffer legitimately starts mid-canvas, and
      // extrapolating the first segment's slope across that gap would fling the
      // line off-screen instead of just hiding the stroke's cap.
      if (pathPts.length && pathPts[0].x <= 1) {
        const a = pathPts[0], b = pathPts[1] || a
        const dx = b.x - a.x
        const sl = dx > 0.5 ? (b.y - a.y) / dx : 0
        pathPts.unshift({ x: -BLEED, y: a.y - sl * (a.x + BLEED) })
      }
      const x0 = pathPts[0].x

      if (pathPts.length > 1) {
        ctx.save()
        ctx.beginPath()
        ctx.moveTo(x0, ph)
        traceCurveTo(pathPts)
        ctx.lineTo(tipX, ph)
        ctx.closePath()
        fillAreaGradient('247,147,26', ph)
        ctx.restore()
      }

      ctx.beginPath()
      tracePath(pathPts)
      strokeGlowLine(ORANGE, '247,147,26')

      drawLivePrice(tipY, ORANGE, fmtPrice(tipVal))
      pulseRing(tipX, tipY, ORANGE, now)
      if (sweep < 1) ctx.restore()
      drawCrosshair(xOf, yOf, ph, vis as {t: number; [k: string]: number}[], (p) => (p as {t: number}).t, (p) => (p as {price: number}).price, fmtPrice, ORANGE)
    }

    function drawStep(now: number) {
      if (viewingFutureRef.current) { drawForwardFlat(probColor(50), probRgb(50), () => '50%'); return }
      if (viewingRef.current) { drawStepFrozen(); return }
      const pw = cssW - RPAD
      const ph = cssH - BAXIS
      const buf = askBuf.current
      if (!buf.length) { drawEmpty('waiting for order book…'); return }

      const last = buf[buf.length - 1]
      // See drawLine: constant span, xMin = xMax - win, no clamp to buf[0].t.
      const win = camSpan('step', now - buf[0].t)
      const xMax = now
      const xMin = xMax - win
      const xOf = (t: number) => ((t - xMin) / win) * pw

      let vis = buf.filter((p) => p.t >= xMin)
      if (vis.length < 3) vis = buf.slice(-3)

      let tlo = Infinity, thi = -Infinity
      for (const p of vis) { if (p.pct < tlo) tlo = p.pct; if (p.pct > thi) thi = p.pct }
      tlo = Math.min(tlo, last.pct); thi = Math.max(thi, last.pct)
      if (thi - tlo < 6) { const m = (tlo + thi) / 2; tlo = m - 3; thi = m + 3 }
      // Probability is bounded 0–100, but CROPPING the band there (the old
      // Math.max/Math.min) changed the range as the curve approached an edge —
      // i.e. it re-scaled. camZoom SLIDES the quantized band inside the domain
      // instead, so the px-per-percent never changes near 0% or 100%.
      const [lo, hi] = camZoom('step', tlo, thi, PROB_BOUNDS)
      const yOf = (v: number) => ph - ((v - lo) / (hi - lo)) * ph

      const tipVal = lerpTip('step', last.pct)
      const tipY = yOf(tipVal)
      // Dynamic heat: red (likely lose) → green (likely win) by live probability.
      const COL = probColor(tipVal), RGB = probRgb(tipVal)

      animatedScale('step', lo, hi, ph, tipY, now, (v) => Math.round(v) + '%')
      drawTimeAxis(xMin, xMax)
      drawPositionLines(yOf, ph)

      const lk = 'P' + assetRef.current
      if (lineIntro.key !== lk) lineIntro = { key: lk, start: now }
      const _pd = animDurRef.current; const sweep = _pd <= 0 ? 1 : easeOutCubic((now - lineIntro.start) / (_pd + 250))
      // mode-select entrance: reveal left→right at the line's real positions.
      if (sweep < 1) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, (pw + RPAD) * sweep, cssH); ctx.clip() }

      // Tip indicator stays flush at the right edge.
      const tipX = pw
      const dense = buildDense(buf as {t: number; [k: string]: number}[], (p) => (p as unknown as {pct: number}).pct, 'step')
      const pts = densePathPts(dense, xMin, xOf, yOf, vis as {t: number; [k: string]: number}[], (p) => (p as unknown as {pct: number}).pct)
      // See drawLine: bleed only when the path reaches the left edge.
      if (pts.length && pts[0].x <= 1) {
        const a = pts[0], b = pts[1] || a
        const dx = b.x - a.x
        const sl = dx > 0.5 ? (b.y - a.y) / dx : 0
        pts.unshift({ x: -BLEED, y: a.y - sl * (a.x + BLEED) })
      }
      const x0 = pts[0].x

      ctx.save()
      ctx.beginPath()
      ctx.moveTo(x0, ph)
      traceCurveTo(pts)
      ctx.lineTo(tipX, tipY)
      ctx.lineTo(tipX, ph)
      ctx.closePath()
      fillAreaGradient(RGB, ph)
      ctx.restore()

      ctx.beginPath()
      tracePath(pts)
      ctx.lineTo(tipX, tipY)
      strokeGlowLine(COL, RGB)

      drawLivePrice(tipY, COL, Math.round(tipVal) + '%')
      pulseRing(tipX, tipY, COL, now)
      if (sweep < 1) ctx.restore()
      drawCrosshair(xOf, yOf, ph, vis as {t: number; [k: string]: number}[], (p) => (p as {t: number}).t, (p) => (p as {pct: number}).pct, (v) => Math.round(v) + '%', COL)
    }

    function drawCandles(now: number) {
      if (viewingFutureRef.current) { drawEmpty(forwardLabel()); return }
      const arr = ohlcRef.current
      if (arr.length < 2) { drawEmpty('loading candles…'); return }
      const pw = cssW - RPAD
      const ph = cssH - BAXIS
      const viewingNow = viewingRef.current && viewEndRef.current > viewStartRef.current
      let view: typeof arr, xMin: number, xMax: number, slotW: number

      if (viewingNow) {
        const wMin = viewStartRef.current * 1000
        const wMax = viewEndRef.current * 1000
        view = arr.filter((c) => c.time * 1000 >= wMin - 1 && c.time * 1000 < wMax)
        if (view.length < 2) { drawEmpty('loading candles…'); return }
        // Fit to the actual candle extent so they fill the canvas evenly.
        // Bar width is MEASURED from the data, not assumed to be 1 minute: the
        // server picks granularity from the window span (see
        // kraken.rangeGranularityMins -- a 1d window returns 15-minute bars), and
        // fineWindowCandles can hand back another spacing again. Assuming 60s made
        // the right-most bar and the time axis wrong by up to 14 minutes.
        const gap = view[view.length - 1].time - view[view.length - 2].time
        const slotMs = (gap > 0 ? gap : 60) * 1000
        xMin = view[0].time * 1000
        xMax = view[view.length - 1].time * 1000 + slotMs
        slotW = pw / view.length
      } else {
        const cv = candleView.current
        const total = arr.length
        if (cv.targetCount == null || !isFinite(cv.targetCount)) cv.targetCount = cv.count
        if (cv.targetOffset == null || !isFinite(cv.targetOffset)) cv.targetOffset = cv.offset
        if (!isFinite(cv.count))  cv.count = 70
        if (!isFinite(cv.offset)) cv.offset = 0
        if (cv.targetCount > total) cv.targetCount = total
        if (cv.count > total) cv.count = total
        const fz = smoothK(90)
        cv.count += (cv.targetCount - cv.count) * fz
        cv.offset += (cv.targetOffset - cv.offset) * fz
        const count = Math.max(1, Math.min(total, Math.round(cv.count)))
        let offset = Math.round(cv.offset)
        if (offset < 0) offset = 0
        if (offset > total - count) offset = total - count
        const tCount = Math.max(1, Math.min(total, Math.round(cv.targetCount)))
        cv.targetOffset = Math.min(Math.max(0, cv.targetOffset), Math.max(0, total - tCount))
        const start = total - count - offset
        view = arr.slice(start, start + count)
        const slotMs = intervalSecs(intervalRef.current) * 1000
        xMin = view[0].time * 1000
        xMax = view[view.length - 1].time * 1000 + slotMs
        slotW = pw / (view.length + 1)
      }

      const xOf = viewingNow
        ? (t: number) => ((t - xMin) / (xMax - xMin)) * pw
        : (t: number) => ((t - xMin) / (xMax - xMin)) * (pw - slotW)
      const tgt = targetRef.current

      let lo = Infinity, hi = -Infinity
      for (const c of view) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high }
      if (lo === hi) { lo -= 1; hi += 1 }
      const tNear = targetNear(tgt, lo, hi)
      if (tNear) { lo = Math.min(lo, tgt); hi = Math.max(hi, tgt) }
      const mid = (lo + hi) / 2
      const minSpan = Math.max(mid * 0.0008, 1e-9)
      if (hi - lo < minSpan) { lo = mid - minSpan / 2; hi = mid + minSpan / 2 }
      const span = hi - lo, pad = span * PAD
      const [yLo, yHi] = lerpZoom('candle', lo - pad, hi + pad)
      const yOf = (v: number) => ph - ((v - yLo) / (yHi - yLo)) * ph

      const lastC = view[view.length - 1]
      const lc = lerpTip('candle', lastC.close)
      const lcY = yOf(lc)

      priceScale(yLo, yHi, tNear ? tgt : 0, ph, lcY)
      drawTimeAxis(xMin, xMax)

      const bodyCap = viewingNow ? slotW : 30
      let bodyW = Math.max(1, Math.min(bodyCap, Math.round(slotW * 0.7)))
      if (!(bodyW & 1)) bodyW = Math.max(1, bodyW - 1)
      const bodyGlow = LIGHT ? 0 : 6
      const ikey = (viewingNow ? 'F' : 'L') + assetRef.current + intervalRef.current
      if (candleIntro.key !== ikey) candleIntro = { key: ikey, start: now }
      const _cd = animDurRef.current
      const introDone = _cd <= 0 || now - candleIntro.start > view.length * 6 + 260
      const introF = (i: number) => introDone ? 1 : easeOutCubic((now - candleIntro.start - i * 6) / (_cd + 40))
      const geom = (c: typeof arr[0], i: number) => {
        const isLast = !viewingNow && i === view.length - 1
        const close = isLast ? lc : c.close
        const hiV = isLast ? Math.max(c.high, close) : c.high
        const loV = isLast ? Math.min(c.low, close) : c.low
        const bx = Math.round(xOf(c.time * 1000) + slotW / 2 - bodyW / 2)
        const f = introF(i)
        let yH = yOf(hiV), yL = yOf(loV), yO = yOf(c.open), yC = yOf(close)
        if (f < 1) {
          const m = (yH + yL) / 2
          yH = m + (yH - m) * f; yL = m + (yL - m) * f
          yO = m + (yO - m) * f; yC = m + (yC - m) * f
        }
        return { col: close >= c.open ? GREEN : RED, bx, yH, yL, yO, yC, f }
      }

      ctx.lineWidth = 1
      for (let i = 0; i < view.length; i++) {
        const g = geom(view[i], i)
        if (g.f <= 0.02) continue
        const wx = g.bx + (bodyW >> 1) + 0.5
        ctx.strokeStyle = g.col
        ctx.beginPath()
        ctx.moveTo(wx, Math.round(g.yH) + 0.5)
        ctx.lineTo(wx, Math.round(g.yL) + 0.5)
        ctx.stroke()
      }

      if (bodyGlow) { ctx.save(); ctx.shadowBlur = bodyGlow }
      for (let i = 0; i < view.length; i++) {
        const g = geom(view[i], i)
        if (g.f <= 0.02) continue
        const ty = Math.round(Math.min(g.yO, g.yC))
        const bh = Math.max(1, Math.round(Math.abs(g.yC - g.yO)))
        if (bodyGlow) ctx.shadowColor = g.col
        ctx.fillStyle = g.col
        ctx.fillRect(g.bx, ty, bodyW, bh)
      }
      if (bodyGlow) ctx.restore()
      // (candles need no target bar)

      const up = lastC.close >= lastC.open
      const col = up ? GREEN : RED
      ctx.save()
      ctx.strokeStyle = col
      ctx.lineWidth = 1
      ctx.setLineDash([4, 4])
      ctx.beginPath(); ctx.moveTo(0, lcY); ctx.lineTo(pw, lcY); ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()
      const str = '$' + lc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      pill(str, pw - ctx.measureText(str).width - 14, lcY, col, up ? '#04150c' : '#1a0606')

      const xOfCenter = (t: number) => xOf(t) + slotW / 2
      drawCrosshair(xOfCenter, yOf, ph, view as {t?: number; time?: number; [k: string]: unknown}[], (c) => (c as typeof arr[0]).time * 1000, (c) => (c as typeof arr[0]).close, fmtPrice, LIGHT ? '#475569' : '#cdd2da')
    }

    function drawEmpty(text: string) {
      ctx.fillStyle = TEXT
      ctx.font = MONO
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, cssW / 2, cssH / 2)
    }

    function frame() {
      if (disposed) return
      raf = requestAnimationFrame(frame)
      if (cssW <= 0 || cssH <= 0) return
      readThemeColors()
      const now = Date.now()
      _dt = Math.min(64, _lastFrameT ? now - _lastFrameT : 16)
      _lastFrameT = now

      if (!viewingRef.current) {
        // Sample the live series off the store WITHOUT subscribing — see the
        // module header. getState() is a plain read: no React commit, no
        // re-render of this component, whatever the tick rate upstream.
        const st = useStore.getState()
        const wl = st.cl_price > 0 ? st.cl_price : 0
        const tok = tokenRef.current
        // Midpoint when both sides are known, ask alone otherwise — the same
        // value the CLOB callback used to push. Both are already in cents.
        const ask = tok ? (st.token_asks[tok] ?? 0) : 0
        const bid = tok ? (st.token_bids[tok] ?? 0) : 0
        const wa = ask > 0 ? (bid > 0 ? (ask + bid) / 2 : ask) : null
        // Push on every change (what the socket callbacks did — pushPrice/pushAsk
        // coalesce anything closer together than 250ms), and again once the last
        // point goes stale, so a quiet feed still extends the line to `now`.
        const pb = priceBuf.current
        const lastP = pb[pb.length - 1]
        if (wl > 0 && (!lastP || wl !== lastP.price || now - lastP.t > 1500)) pushPrice(now, wl)
        const ab = askBuf.current
        const lastA = ab[ab.length - 1]
        if (wa != null && wa > 0 && (!lastA || wa !== lastA.pct || now - lastA.t > 1500)) pushAsk(now, wa)
      }

      ctx.clearRect(0, 0, cssW, cssH)
      ctx.fillStyle = BG
      ctx.fillRect(0, 0, cssW, cssH)

      const m = modeRef.current
      if (m !== _modeLast) {
        if (_modeLast) {
          _modeT = now; candleIntro.key = ''; lineIntro.key = ''
          // Complete refresh on mode switch: drop smoothing/zoom/axis state so
          // the new mode seeds AT the current value and plays its entrance from
          // scratch — instead of gliding from the last shown canvas price.
          tipRef.current = {}; zoomRef.current = {}; camTgtRef.current = {}
          winRef.current = {}; rungRef.current = {}; axisLblRef.current = {}
        }
        _modeLast = m
      }
      const mk = _modeT ? easeOutCubic((now - _modeT) / 240) : 1
      ctx.save()
      if (mk < 1) { ctx.globalAlpha = Math.max(mk, 0.05); ctx.translate(0, (1 - mk) * 8) }
      try {
        if (m === 'line') drawLine(now)
        else if (m === 'probability') drawStep(now)
        else drawCandles(now)
      } catch (_err) {
        for (let i = 0; i < 8; i++) { try { ctx.restore() } catch (_e2) {} }
        ctx.setTransform(_dprNow, 0, 0, _dprNow, 0, 0)
      }
      ctx.restore()

      const fl = flashRef.current
      if (fl.end > now && fl.end > fl.start) {
        const k = 1 - (now - fl.start) / (fl.end - fl.start)
        const e = k * k
        ctx.save()
        ctx.globalAlpha = 0.45 * e
        const g = ctx.createLinearGradient(0, 0, 0, cssH)
        g.addColorStop(0, `rgba(${C.GREEN_RGB},0.9)`)
        g.addColorStop(1, 'rgba(245,158,11,0.0)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, cssW, cssH)
        ctx.globalAlpha = e
        ctx.fillStyle = LIGHT ? '#0f1115' : '#e8e8e8'
        ctx.font = `bold 13px ${FONT.MONO}`
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText('NEW WINDOW', (cssW - RPAD) / 2, 24)
        ctx.restore()
      }
    }

    raf = requestAnimationFrame(frame)

    return () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseleave', onLeave)
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mouseup', onUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('dblclick', onDbl)
    }
  }, [])  // mount only; reads everything via refs

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        minHeight: '300px',
        flex: 1,
        overflow: 'hidden',
        position: 'relative',
        background: 'var(--tc-chart-bg)',
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  )
}
