/**
 * System-resources monitor for the left column.
 *
 * A checkerboard grid of bordered tiles — one host metric per tile (icon +
 * animated value in the digital "time" font). Every tile is colored by a
 * verdict on whether that resource is good enough to run TripleUCrypt:
 *   green = good · orange = tight · red = a problem.
 * No neutral/white — the color IS the judgement.
 */
import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import { FlipNumber } from './shared/NumberFlow.js'
import { playFx } from '../lib/fx.js'
import { C, FONT, D, SP, FS, FW } from '../constants/index.js'

// bytes/sec → { value, unit } for an animated readout
function rate(bps: number): { v: number; u: string } {
  if (!bps || bps < 1) return { v: 0, u: 'B' }
  if (bps >= 1e6) return { v: Math.round((bps / 1e6) * 10) / 10, u: 'M' }
  if (bps >= 1e3) return { v: Math.round(bps / 1e3), u: 'K' }
  return { v: Math.round(bps), u: 'B' }
}

// ── Per-metric verdicts: is this good enough for TripleUCrypt? ───────────────
type Verdict = { color: string; word: string }
const GOOD = (w: string): Verdict => ({ color: C.GREEN, word: w })
const TIGHT = (w: string): Verdict => ({ color: C.GOLD, word: w })
const BAD = (w: string): Verdict => ({ color: C.RED, word: w })

// CPU/GPU/RAM usage: low = headroom (good), high = strained.
const judgeCpu = (p: number): Verdict => p < 70 ? GOOD('plenty of headroom') : p < 88 ? TIGHT('getting busy') : BAD('maxed out')
const judgeGpu = (p: number): Verdict => p < 85 ? GOOD('barely breaking a sweat') : p < 95 ? TIGHT('working hard') : BAD('saturated')
const judgeRam = (p: number): Verdict => p < 80 ? GOOD('plenty free') : p < 92 ? TIGHT('filling up') : BAD('nearly full')
const judgeTemp = (t: number): Verdict => t < 70 ? GOOD('running cool') : t < 85 ? TIGHT('warm') : BAD('too hot')
const judgeFps = (f: number): Verdict => f >= 50 ? GOOD('buttery smooth') : f >= 35 ? TIGHT('a little choppy') : BAD('struggling')
// Throughput: any current traffic is well within budget for this app.
const judgeFlow = (): Verdict => GOOD('well within budget')
// Network latency: low = snappy fills, high = laggy.
const judgePing = (ms: number): Verdict => ms < 60 ? GOOD('snappy connection') : ms < 150 ? TIGHT('a little laggy') : BAD('high latency')
// Free disk space.
const judgeDisk = (free: number): Verdict => free > 20 ? GOOD('plenty of room') : free > 8 ? TIGHT('getting full') : BAD('almost full')
// Informational metrics (clock, uptime) — neutral cyan, not a good/bad call.
const INFO = (w: string): Verdict => ({ color: C.CYAN, word: w })

// uptime seconds → { value, unit } for an animated readout
function upfmt(secs: number): { v: number; u: string } {
  if (secs >= 86400) return { v: Math.floor(secs / 86400), u: 'd' }
  if (secs >= 3600) return { v: Math.floor(secs / 3600), u: 'h' }
  return { v: Math.floor(secs / 60), u: 'm' }
}

// ── Tile ────────────────────────────────────────────────────────────────────
function Tile({ idx, title, color, icon, children }: {
  idx: number; title: string; color: string; icon: React.ReactNode; children: React.ReactNode
}) {
  // checkerboard: alternate a faint background between tiles
  const dark = (idx % 2 === 0)
  const iconRef = useRef<SVGSVGElement>(null)
  return (
    <div
      title={title}
      className="tc-fadein"
      onMouseEnter={(e) => { playFx(e.currentTarget, 'pulse'); playFx(iconRef.current as unknown as HTMLElement, 'jiggle') }}
      style={{
        animationDelay: `${0.04 * idx}s`,
        display: 'flex', alignItems: 'center', gap: SP.SM,
        padding: `${SP.SM} ${SP.MD}`, minWidth: 0,
        border: `1px solid ${color}33`, borderRadius: D.R_BTN,
        background: dark ? 'var(--tc-bg-deep, #0a0a0a)' : 'var(--tc-card-alt, #0d0d0d)',
      }}
    >
      <svg
        ref={iconRef}
        width={15} height={15} viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
        style={{ flexShrink: 0, display: 'block', color }}
      >
        {icon}
      </svg>
      <span style={{
        fontFamily: FONT.TIME, fontSize: FS.SM, fontWeight: FW.BOLD, letterSpacing: '0.01em',
        color, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'baseline',
      }}>
        {children}
      </span>
    </div>
  )
}

const flipStyle = (color: string): React.CSSProperties => ({
  fontFamily: FONT.TIME, fontWeight: FW.BOLD, color, fontVariantNumeric: 'tabular-nums',
})

// Placeholder shown when a metric isn't available on this OS / didn't respond —
// the tile still renders (with its icon) so the grid is always complete.
const NA = <span style={{ fontFamily: FONT.TIME, fontWeight: FW.BOLD, fontSize: FS.SM, color: C.DIM2, opacity: 0.6, letterSpacing: '0.02em' }}>N/A</span>
const NA_C = C.DIM2

export function ResourceBar() {
  // Columns follow the panel width: wide → 3 across (stacked power grid),
  // medium → 2, narrow → 1.
  const gridRef = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState(2)
  useEffect(() => {
    const wrap = gridRef.current?.parentElement
    if (!wrap) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0
      setCols(w >= 300 ? 3 : w >= 200 ? 2 : 1)
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  const cores = useStore(s => s.sys_cpu_cores)
  const cpu = useStore(s => s.sys_cpu_pct)
  const gpu = useStore(s => s.sys_gpu_pct)
  const temp = useStore(s => s.sys_cpu_temp)
  const mem = useStore(s => s.sys_mem_pct)
  const ramGb = useStore(s => s.sys_mem_total_gb)
  const diskIo = useStore(s => s.sys_disk_io)
  const fps = useStore(s => s.reported_fps)
  const down = useStore(s => s.sys_net_down)
  const up = useStore(s => s.sys_net_up)
  const ghz = useStore(s => s.sys_cpu_ghz)
  const ping = useStore(s => s.sys_ping_ms)
  const diskFree = useStore(s => s.sys_disk_free_pct)
  const uptime = useStore(s => s.sys_uptime_sec)

  const dn = rate(down), upR = rate(up), dio = rate(diskIo)
  const upt = upfmt(uptime)

  const vCpu = judgeCpu(cpu), vGpu = judgeGpu(gpu), vRam = judgeRam(mem)
  const vTemp = judgeTemp(temp), vFps = judgeFps(fps), vFlow = judgeFlow()
  const vPing = judgePing(ping), vDisk = judgeDisk(diskFree)

  const tiles: Array<{ key: string; title: string; color: string; icon: React.ReactNode; body: React.ReactNode }> = []
  tiles.push({
    key: 'cpu', title: `CPU · ${cores || '?'} cores · ${cpu}% — ${vCpu.word}`, color: vCpu.color,
    icon: <><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" /></>,
    body: <FlipNumber value={cpu} suffix="%" style={flipStyle(vCpu.color)} />,
  })
  tiles.push({
    key: 'gpu', title: gpu >= 0 ? `GPU · ${gpu}% — ${vGpu.word}` : 'GPU · not detected', color: gpu >= 0 ? vGpu.color : NA_C,
    icon: <><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="8" cy="12" r="2" /><circle cx="15" cy="12" r="2" /><path d="M5 18v2M19 18v2" /></>,
    body: gpu >= 0 ? <FlipNumber value={gpu} suffix="%" style={flipStyle(vGpu.color)} /> : NA,
  })
  tiles.push({
    key: 'temp', title: temp > 0 ? `CPU temp · ${temp}° — ${vTemp.word}` : 'CPU temp · unavailable', color: temp > 0 ? vTemp.color : NA_C,
    icon: <path d="M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0z" />,
    body: temp > 0 ? <FlipNumber value={temp} suffix="°" style={flipStyle(vTemp.color)} /> : NA,
  })
  tiles.push({
    key: 'ram', title: `RAM · ${ramGb || '?'} GB · ${mem}% used — ${vRam.word}`, color: vRam.color,
    icon: <><rect x="3" y="7" width="18" height="10" rx="1.5" /><path d="M7 17v3M11 17v3M15 17v3M19 17v3M7 11v2M11 11v2M15 11v2" /></>,
    body: <FlipNumber value={mem} suffix="%" style={flipStyle(vRam.color)} />,
  })
  tiles.push({
    key: 'disk', title: `Storage I/O — ${vFlow.word}`, color: vFlow.color,
    icon: <><rect x="3" y="13" width="18" height="8" rx="2" /><path d="M7 17h.01M3 13l3-9h12l3 9" /></>,
    body: <FlipNumber value={dio.v} suffix={dio.u} style={flipStyle(vFlow.color)} />,
  })
  tiles.push({
    key: 'fps', title: `Render FPS · ${Math.round(fps)} — ${vFps.word}`, color: vFps.color,
    icon: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
    body: <FlipNumber value={Math.round(fps)} style={flipStyle(vFps.color)} />,
  })
  tiles.push({
    key: 'down', title: `Download — ${vFlow.word}`, color: vFlow.color,
    icon: <path d="M12 3v13M7 11l5 5 5-5M5 21h14" />,
    body: <FlipNumber value={dn.v} suffix={dn.u} style={flipStyle(vFlow.color)} />,
  })
  tiles.push({
    key: 'up', title: `Upload — ${vFlow.word}`, color: vFlow.color,
    icon: <path d="M12 21V8M7 13l5-5 5 5M5 3h14" />,
    body: <FlipNumber value={upR.v} suffix={upR.u} style={flipStyle(vFlow.color)} />,
  })
  tiles.push({
    key: 'ping', title: ping >= 0 ? `Network latency · ${ping} ms — ${vPing.word}` : 'Network latency · unavailable', color: ping >= 0 ? vPing.color : NA_C,
    icon: <><path d="M5 12.55a11 11 0 0 1 14 0M8.5 16.1a6 6 0 0 1 7 0" /><line x1="12" y1="20" x2="12.01" y2="20" /></>,
    body: ping >= 0 ? <FlipNumber value={ping} suffix="ms" style={flipStyle(vPing.color)} /> : NA,
  })
  {
    const vClk = INFO('clock speed')
    tiles.push({
      key: 'clk', title: ghz > 0 ? `CPU clock · ${ghz} GHz` : 'CPU clock · unavailable', color: ghz > 0 ? vClk.color : NA_C,
      icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
      body: ghz > 0 ? <FlipNumber value={ghz} format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }} suffix="G" style={flipStyle(vClk.color)} /> : NA,
    })
  }
  tiles.push({
    key: 'disk-free', title: diskFree >= 0 ? `Disk free · ${diskFree}% — ${vDisk.word}` : 'Disk free · unavailable', color: diskFree >= 0 ? vDisk.color : NA_C,
    icon: <><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 9 9h-9z" /></>,
    body: diskFree >= 0 ? <FlipNumber value={diskFree} suffix="%" style={flipStyle(vDisk.color)} /> : NA,
  })
  {
    const vUp = INFO('uptime')
    tiles.push({
      key: 'uptime', title: `Uptime · ${upt.v}${upt.u}`, color: vUp.color,
      icon: <><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></>,
      body: <FlipNumber value={upt.v} suffix={upt.u} style={flipStyle(vUp.color)} />,
    })
  }

  return (
    <div
      ref={gridRef}
      data-spot="resources"
      style={{
        width: '100%', minHeight: '100%', boxSizing: 'border-box',
        display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridAutoRows: 'minmax(34px, 1fr)', gap: SP.XS,
        padding: SP.MD, border: '1px solid var(--tc-border)', borderRadius: 'var(--tc-r-card, 10px)',
        background: 'var(--tc-card)',
      }}
    >
      {tiles.map((t, i) => (
        <Tile key={t.key} idx={i} title={t.title} color={t.color} icon={t.icon}>
          {t.body}
        </Tile>
      ))}
    </div>
  )
}
