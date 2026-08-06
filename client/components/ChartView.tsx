/**
 * Chart view — native-canvas engine + floating mode-switch overlay.
 * Replaces the stub. Ported from TripleUCrypt/ui/chart/chart_view.py
 */

import React, { useState, useEffect, useRef } from 'react'
import { animate } from 'animejs'
import { playFx } from '../lib/fx.js'
import { useStore } from '../store'
import { EChart } from './chart/EChart'
import { C, FONT, D, Z, SP, SZ, FS, FW, STR } from '../constants/index.js'
import { call } from '../api.js'
import { intervalSecs } from '../lib/intervals.js'

// ── Icons (inline SVG so there's no icon library dependency) ─────────────────

function IconChartLine(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}

function IconPercent(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="5" x2="5" y2="19" />
      <circle cx="6.5" cy="6.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
    </svg>
  )
}

function IconCandlestick(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5v4" /><rect x="7" y="9" width="4" height="6" /><path d="M9 15v4" />
      <path d="M17 3v2" /><rect x="15" y="5" width="4" height="8" /><path d="M17 13v4" />
    </svg>
  )
}

// ── Mode icon button ──────────────────────────────────────────────────────────

interface ModeIconProps {
  icon: JSX.Element
  value: string
  accent: string
  glow: string
  currentMode: string
  onSetMode: (m: string) => void
}

function ModeIcon({ icon, value, accent, glow, currentMode, onSetMode }: ModeIconProps): JSX.Element {
  const active = currentMode === value
  const [hovered, setHovered] = useState(false)
  const iconRef = useRef<HTMLSpanElement>(null)
  return (
    <div
      onClick={() => onSetMode(value)}
      onMouseEnter={() => { setHovered(true); playFx(iconRef.current, 'jiggle') }}
      onMouseLeave={() => setHovered(false)}
      title={value}
      data-mode={value}
      style={{
        position: 'relative', zIndex: 1,
        cursor: 'pointer',
        width: SZ.S30,
        height: SZ.S28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: D.R_SM,
        boxSizing: 'border-box',
        // active icon = accent colour; inactive stays grey (the sliding frame
        // overlay is what carries the per-mode colour).
        color: active ? accent : hovered ? 'var(--tc-text, #d6d9e0)' : 'var(--tc-dim3, #565656)',
        background: active ? 'transparent' : hovered ? 'var(--tc-white-07, rgba(255,255,255,0.07))' : 'transparent',
        border: '1px solid transparent',
        transform: hovered ? 'translateY(-1px)' : 'translateY(0)',
        transition: 'all var(--tc-dur, 0.15s) var(--tc-ease, ease)',
        userSelect: 'none',
        flexShrink: 0,
      }}
    >
      <span ref={iconRef} style={{ display: 'inline-flex' }}>{icon}</span>
    </div>
  )
}

// ── Mode overlay ──────────────────────────────────────────────────────────────

interface ModeOverlayProps {
  mode: string
  onSetMode: (m: string) => void
}

const MODE_ACCENT: Record<string, { c: string; glow: string }> = {
  line:        { c: C.BTC,   glow: 'var(--tc-glow-btc)' },
  probability: { c: C.RED,   glow: 'var(--tc-glow-down)' },
  candles:     { c: C.GREEN, glow: 'var(--tc-glow-up)' },
}

function ModeOverlay({ mode, onSetMode }: ModeOverlayProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const indRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef(true)

  // Slide the selection frame to the active mode AND morph its colour to that
  // mode's accent (line=orange, %=red, candles=green) — anime.js.
  useEffect(() => {
    const box = boxRef.current, ind = indRef.current
    if (!box || !ind) return
    const seg = box.querySelector(`[data-mode="${mode}"]`) as HTMLElement | null
    if (!seg) { ind.style.opacity = '0'; return }
    const left = seg.offsetLeft, w = seg.offsetWidth
    const acc = MODE_ACCENT[mode] ?? MODE_ACCENT.line
    // Set colour directly — acc.c is a CSS var() string which anime can't
    // interpolate (it would silently leave the border on its initial colour).
    ind.style.boxShadow = acc.glow
    ind.style.borderColor = acc.c
    if (firstRef.current) {
      ind.style.left = `${left}px`; ind.style.width = `${w}px`; ind.style.opacity = '1'
      firstRef.current = false
      return
    }
    animate(ind, { left: `${left}px`, width: `${w}px`, opacity: 1, duration: 320, ease: 'out(3)' })
  }, [mode])

  return (
    <div
      ref={boxRef}
      className="tc-glass"
      style={{
        position: 'absolute',
        top: SP.LG,
        right: SP.XL,
        zIndex: Z.CHART_LABEL,
        display: 'flex',
        flexDirection: 'row',
        gap: SP.XXS,
        padding: SP.XXS,
        borderRadius: D.R_CTRL,
      }}
    >
      <div ref={indRef} style={{
        position: 'absolute', top: SP.XXS, bottom: SP.XXS, left: SP.NONE, width: SP.NONE, opacity: 0,
        border: '1px solid transparent', borderRadius: D.R_SM,
        pointerEvents: 'none', boxSizing: 'border-box', zIndex: 0,
      }} />
      <ModeIcon icon={<IconChartLine />}    value="line"        accent={C.BTC}   glow="var(--tc-glow-btc)"  currentMode={mode} onSetMode={onSetMode} />
      <ModeIcon icon={<IconPercent />}      value="probability" accent={C.RED}   glow="var(--tc-glow-down)" currentMode={mode} onSetMode={onSetMode} />
      <ModeIcon icon={<IconCandlestick />}  value="candles"     accent={C.GREEN} glow="var(--tc-glow-up)"   currentMode={mode} onSetMode={onSetMode} />
    </div>
  )
}

// ── Window label overlay ──────────────────────────────────────────────────────

interface WindowLabelProps {
  label: string
}

function WindowLabel({ label }: WindowLabelProps): JSX.Element | null {
  if (!label) return null
  return (
    <div
      className="tc-glass"
      style={{
        position: 'absolute',
        top: SP.LG,
        left: SP.XL,
        zIndex: Z.CHART_LABEL,
        padding: `${SP.XS} ${SP.MD}`,
        borderRadius: D.R_BTN,
      }}
    >
      <span style={{
        fontSize: FS.XXS,
        fontWeight: FW.BOLD,
        fontFamily: FONT.TIME,
        color: 'var(--tc-dim2, #737373)',
        whiteSpace: 'nowrap',
        letterSpacing: '0.04em',
      }}>
        {label}
      </span>
    </div>
  )
}

// ── Chart skeleton (48-bar candlestick silhouette) ───────────────────────────

function ChartSkeleton(): JSX.Element {
  // deterministic pseudo-random wave so the silhouette looks chart-like
  const bars: number[] = []
  for (let i = 0; i < 48; i++) {
    const h = 14 + 70 * (0.5 + 0.5 * Math.sin(i * 0.6)) * (0.55 + 0.45 * ((i * 7) % 5) / 4.0)
    bars.push(h)
  }
  const gridLines = [0, 1, 2, 3]

  return (
    <div
      className="tc-fadein"
      style={{
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        background: 'var(--tc-card, #0f0f0f)',
        zIndex: Z.CHART_SKELETON,
        overflow: 'hidden',
      }}
    >
      {/* grid lines */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, bottom: '30px',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        padding: `${SP.H2} 0`,
      }}>
        {gridLines.map((i) => (
          <div key={i} style={{ width: '100%', height: SP.HAIR, background: 'var(--tc-panel, #1a1a1a)' }} />
        ))}
      </div>
      {/* bars */}
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'row', alignItems: 'flex-end', gap: SP.XXS,
        padding: '34px 18px 30px',
      }}>
        {bars.map((h, i) => (
          <div
            key={i}
            className="tc-skel"
            style={{
              flex: 1,
              minWidth: 0,
              height: h + '%',
              borderRadius: '2px',
              background: 'var(--tc-hover)',
              flexShrink: 0,
              alignSelf: 'flex-end',
            }}
          />
        ))}
      </div>
    </div>
  )
}

// ── Derive window_time_label from store ───────────────────────────────────────

function _windowLabel(kind: string, startTs: number, endTs: number): string {
  if (startTs <= 0 || endTs <= 0) return ''
  const ET = 'America/New_York'
  const s = new Date(startTs * 1000)
  const e = new Date(endTs * 1000)
  const hm = (d: Date) => {
    const h = d.toLocaleString('en-US', { hour: 'numeric', hour12: true, timeZone: ET })
    const m = String(d.toLocaleString('en-US', { minute: '2-digit', timeZone: ET })).padStart(2, '0')
    return `${h.split(' ')[0].replace(':00','')}:${m}`.replace(/:\d+ /, ' ')
  }
  // "12:55" style — manual to match Python exactly
  const hm2 = (d: Date) => {
    const raw = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false, timeZone: ET })
    const [hh, mm] = raw.split(':')
    const h24 = parseInt(hh)
    const h12 = h24 % 12 || 12
    return `${h12}:${mm}`
  }
  const apOf = (d: Date) =>
    parseInt(d.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: ET })) < 12 ? 'AM' : 'PM'
  const monOf = (d: Date) => d.toLocaleString('en-US', { month: 'short', timeZone: ET })
  const dayOf = (d: Date) => parseInt(d.toLocaleString('en-US', { day: 'numeric', timeZone: ET }))
  const ap = apOf(e)
  const mon = monOf(e)
  const day = dayOf(e)
  // A 1d window runs noon-to-noon ET, so one date + "12:00–12:00" would read as a
  // zero-length window. Name both ends when the window crosses an ET day.
  if (monOf(s) !== mon || dayOf(s) !== day) {
    return `${kind} · ${monOf(s)} ${dayOf(s)} ${hm2(s)} ${apOf(s)} → ${mon} ${day} ${hm2(e)} ${ap} ET`
  }
  return `${kind} · ${mon} ${day} · ${hm2(s)}–${hm2(e)} ${ap} ET`
}

function useWindowTimeLabel(): string {
  const interval     = useStore((s) => s.interval)
  const viewingSlot  = useStore((s) => s.viewing_slot)
  const viewingFuture = useStore((s) => s.viewing_future)
  const windows      = useStore((s) => s.windows) as Record<string, unknown>[]
  const chartAsset   = useStore((s) => s.chart_asset)

  const span = intervalSecs(interval)

  if (viewingSlot) {
    const vs = parseInt(viewingSlot, 10) || 0
    return _windowLabel(STR.WIN_PAST, vs, vs + span)
  }

  let end = 0
  for (const w of windows) {
    if (w['asset'] === chartAsset && w['interval'] === interval) {
      end = parseInt(String(w['end_ts'] || 0), 10)
      break
    }
  }
  return _windowLabel(viewingFuture ? STR.WIN_NEXT : STR.WIN_LIVE, end - span, end)
}

// ── ChartView ─────────────────────────────────────────────────────────────────

function ChartViewInner({ overlays = true, showWindowLabel }: { overlays?: boolean; showWindowLabel?: boolean } = {}): JSX.Element {
  const showWin = showWindowLabel ?? overlays
  const mode         = useStore((s) => s.mode)
  const clPrice      = useStore((s) => s.cl_price)
  const candles1m    = useStore((s) => s.window_candles_1m)
  const windowLabel  = useWindowTimeLabel()

  // chart_003: Normalize stale initial 'price' value → 'line' before first render
  useEffect(() => {
    if (useStore.getState().mode === 'price') {
      useStore.getState()._patch({ mode: 'line' })
    }
  }, [])

  // chart_002: Show skeleton based purely on data presence, matching Python:
  //   (State.chart_price > 0) | (State.display_candles.length() > 0)
  const dataReady = clPrice > 0 || (candles1m && candles1m.length > 0)
  const showSkeleton = !dataReady

  // chart_004: Persist mode change to server so it survives snapshot refreshes
  function handleSetMode(m: string) {
    useStore.getState()._patch({ mode: m })
    call('set_mode', m).catch(() => {})
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        position: 'relative',
        background: 'var(--tc-card, #0f0f0f)',
        boxShadow: 'var(--tc-elev-2)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <EChart />
      {showSkeleton && <ChartSkeleton />}
      {overlays && <ModeOverlay mode={mode} onSetMode={handleSetMode} />}
      {showWin && <WindowLabel label={windowLabel} />}
    </div>
  )
}

// Memoised: App is the root and re-renders on theme/mode/wallet changes.
// These panels take no props (or one stable one) and read what they need from
// the store themselves, so a parent re-render should never cascade into them.
export const ChartView = React.memo(ChartViewInner)
