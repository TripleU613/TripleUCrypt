import { PowerTier } from '../types.js'
import { patch, sleep } from './state.js'
import type { AppState } from './state.js'

// Try to import systeminformation; if not available, degrade gracefully
let si: typeof import('systeminformation') | null = null
try {
  si = await import('systeminformation')
} catch {
  // systeminformation not available; power manager will use defaults
}

import { execSync } from 'child_process'
import fs from 'node:fs'

// Read GPU utilisation across vendors, cheapest source first:
//   1. Linux sysfs gpu_busy_percent — AMD (amdgpu) and some others, instant
//   2. nvidia-smi — NVIDIA, fast
//   3. systeminformation graphics — catch-all (Intel / Windows / Apple where the
//      OS exposes it)
// Returns a 0–100 %, or -1 when no GPU utilisation is available.
async function readGpuPct(): Promise<number> {
  if (process.platform === 'linux') {
    try {
      for (const card of fs.readdirSync('/sys/class/drm')) {
        if (!/^card\d+$/.test(card)) continue
        const p = `/sys/class/drm/${card}/device/gpu_busy_percent`
        if (!fs.existsSync(p)) continue
        const v = parseInt(fs.readFileSync(p, 'utf8').trim(), 10)
        if (Number.isFinite(v)) return Math.max(0, Math.min(100, v))
      }
    } catch { /* no sysfs gpu */ }
  }
  try {
    const out = execSync('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits',
      { timeout: 500, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
    const val = parseInt(out.split('\n')[0], 10)
    if (Number.isFinite(val)) return val
  } catch { /* no nvidia */ }
  if (process.platform === 'win32') {
    try {
      // Sum the GPU 3D-engine utilisation counters — what Task Manager shows,
      // works for any vendor (AMD / Intel / NVIDIA) on Windows.
      const ps = `$s=(Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -EA SilentlyContinue).CounterSamples; if($s){[math]::Round((($s|Measure-Object CookedValue -Sum).Sum))}else{''}`
      const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`,
        { timeout: 2500, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
      const v = parseInt(out, 10)
      if (Number.isFinite(v)) return Math.max(0, Math.min(100, v))
    } catch { /* no perf counter */ }
  }
  try {
    if (si) {
      const g = await si.graphics()
      let best = -1
      for (const c of g.controllers ?? []) {
        const u = Number((c as { utilizationGpu?: number }).utilizationGpu)
        if (Number.isFinite(u) && u >= 0) best = Math.max(best, Math.round(u))
      }
      if (best >= 0) return best
    }
  } catch { /* graphics not available */ }
  return -1
}

// Windows CPU temp via WMI thermal zone (systeminformation returns 0 on Windows
// without a hardware-monitor driver). Best-effort: if the zone isn't exposed we
// stop trying so we don't spawn PowerShell every cycle.
let _winTempOff = false
function readWinCpuTemp(): number {
  if (process.platform !== 'win32' || _winTempOff) return 0
  try {
    const ps = `$t=(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -EA SilentlyContinue | Select-Object -First 1).CurrentTemperature; if($t){[math]::Round($t/10-273.15)}else{''}`
    const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`,
      { timeout: 2500, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
    const v = parseInt(out, 10)
    if (Number.isFinite(v) && v > 0 && v < 130) return v
  } catch { /* not available */ }
  _winTempOff = true   // don't keep paying for a sensor that isn't there
  return 0
}

export interface TierSettings {
  fast_ms: number
  tick_ms: number
  poll_ms: number
  ob_ms: number
  anim_ms: number
  flip_ms: number
}

// fast_ms on the two top tiers is tighter than it looks like it needs to be
// because the browser no longer opens its own market sockets: this loop is now
// the ONLY path a price tick has to the screen, not a second opinion behind a
// direct feed. ECO/SURVIVAL keep their slower cadence on purpose — those tiers
// exist for machines that genuinely cannot keep up.
export const TIER_SETTINGS: Map<PowerTier, TierSettings> = new Map([
  [PowerTier.TURBO,    { fast_ms: 120,  tick_ms: 500,  poll_ms: 3000,  ob_ms: 4000,  anim_ms: 300, flip_ms: 350 }],
  [PowerTier.SMOOTH,   { fast_ms: 150,  tick_ms: 700,  poll_ms: 4000,  ob_ms: 5000,  anim_ms: 200, flip_ms: 450 }],
  [PowerTier.ECO,      { fast_ms: 500,  tick_ms: 1000, poll_ms: 6000,  ob_ms: 8000,  anim_ms: 150, flip_ms: 600 }],
  [PowerTier.SURVIVAL, { fast_ms: 1000, tick_ms: 2000, poll_ms: 12000, ob_ms: 15000, anim_ms: 0,   flip_ms: 800 }],
])

let _tier: PowerTier = PowerTier.SMOOTH
let _tierVotes = 0
let _pendingTier: PowerTier | undefined = undefined
let _uiFps = 60.0
let _cpuEma = 30.0

export function currentTier(): PowerTier {
  return _tier
}

export function fastSleep(): number {
  return TIER_SETTINGS.get(currentTier())!.fast_ms
}

export function tickSleep(): number {
  return TIER_SETTINGS.get(currentTier())!.tick_ms
}

export function pollSleep(): number {
  return TIER_SETTINGS.get(currentTier())!.poll_ms
}

export function obSleep(): number {
  return TIER_SETTINGS.get(currentTier())!.ob_ms
}

export function reportFps(fps: number): void {
  _uiFps = fps
  if (fps < 30) {
    _tier = PowerTier.SURVIVAL
  } else if (fps < 45) {
    _tier = PowerTier.ECO
  }
}

export function initState(s: AppState): void {
  s.ui_quality = 'smooth'
  s.reported_fps = 60
  s.sys_cpu_cores = 0
  s.sys_cpu_pct = 0
  s.sys_mem_pct = 0
  s.sys_disk_io = 0
  s.sys_net_down = 0
  s.sys_net_up = 0
  s.sys_gpu_pct = -1
  s.sys_cpu_temp = 0
  s.sys_mem_total_gb = 0
  s.sys_cpu_ghz = 0
  s.sys_ping_ms = -1
  s.sys_disk_free_pct = -1
  s.sys_uptime_sec = 0
}

let _coresPatched = false
let _memTotalPatched = false

function _tierName(t: PowerTier): string {
  switch (t) {
    case PowerTier.TURBO:    return 'turbo'
    case PowerTier.SMOOTH:   return 'smooth'
    case PowerTier.ECO:      return 'eco'
    case PowerTier.SURVIVAL: return 'survival'
    default:                 return 'smooth'
  }
}

function _computeDesiredTier(cpuLoad: number, memFree: number, hasGpu: boolean): PowerTier {
  if (cpuLoad > 85 || memFree < 200) return PowerTier.SURVIVAL
  if (cpuLoad > 65 || memFree < 500) return PowerTier.ECO
  if (cpuLoad < 30 && memFree > 2000 && (_uiFps >= 55 || hasGpu)) return PowerTier.TURBO
  return PowerTier.SMOOTH
}

export async function runPowerManager(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await sleep(5000)
    if (signal.aborted) break

    let cpuLoad = _cpuEma
    let memFreeMb = 1000
    let hasGpu = false

    try {
      if (si) {
        const [load, mem, net, fs, temp, speed, fsSize, ping] = await Promise.all([
          si.currentLoad(),
          si.mem(),
          si.networkStats().catch(() => []),
          si.fsStats().catch(() => null),
          si.cpuTemperature().catch(() => null),
          si.cpuCurrentSpeed().catch(() => null),
          si.fsSize().catch(() => null),
          si.inetLatency().catch(() => -1),
        ])
        const rawLoad = load.currentLoad ?? 30
        _cpuEma = _cpuEma * 0.7 + rawLoad * 0.3
        cpuLoad = _cpuEma
        memFreeMb = (mem.available ?? 1_000_000_000) / 1_000_000

        // Patch the live resource metrics for the left-column readout.
        if (!_coresPatched) {
          try {
            const cpu = await si.cpu()
            patch('sys_cpu_cores', cpu.cores ?? cpu.physicalCores ?? 0)
            _coresPatched = true
          } catch { /* keep trying next cycle */ }
        }
        patch('sys_cpu_pct', Math.round(cpuLoad))
        const memTotal = mem.total || 1
        patch('sys_mem_pct', Math.round(((mem.active ?? (mem.total - mem.available)) / memTotal) * 100))
        if (!_memTotalPatched && mem.total) {
          patch('sys_mem_total_gb', Math.round(mem.total / 1e9))
          _memTotalPatched = true
        }
        // networkStats() per-interface; sum the throughput. (_sec is -1 on the
        // first sample until a baseline exists — clamp to 0.)
        const ifaces = Array.isArray(net) ? net : []
        const down = ifaces.reduce((a, n) => a + Math.max(0, n.rx_sec ?? 0), 0)
        const up = ifaces.reduce((a, n) => a + Math.max(0, n.tx_sec ?? 0), 0)
        patch('sys_net_down', Math.round(down))
        patch('sys_net_up', Math.round(up))
        if (fs) {
          const io = Math.max(0, fs.rx_sec ?? 0) + Math.max(0, fs.wx_sec ?? 0)
          patch('sys_disk_io', Math.round(io))
        }
        if (temp && typeof temp.main === 'number' && temp.main > 0) {
          patch('sys_cpu_temp', Math.round(temp.main))
        } else {
          const winTemp = readWinCpuTemp()   // Windows WMI fallback (best-effort)
          if (winTemp > 0) patch('sys_cpu_temp', winTemp)
        }
        // CPU clock (GHz)
        if (speed && typeof speed.avg === 'number' && speed.avg > 0) {
          patch('sys_cpu_ghz', Math.round(speed.avg * 10) / 10)
        }
        // free space on the busiest/main mount (%)
        if (Array.isArray(fsSize) && fsSize.length) {
          const main = fsSize.reduce((a, b) => ((b.size ?? 0) > (a.size ?? 0) ? b : a), fsSize[0])
          if (main && main.size) patch('sys_disk_free_pct', Math.round(100 - (main.use ?? 0)))
        }
        // internet round-trip latency (ms)
        if (typeof ping === 'number' && ping >= 0) patch('sys_ping_ms', Math.round(ping))
        // host uptime (seconds)
        patch('sys_uptime_sec', Math.round(si.time().uptime ?? 0))
      }
    } catch {
      // ignore metrics errors
    }

    const gpuPct = await readGpuPct()
    hasGpu = gpuPct >= 0
    patch('sys_gpu_pct', gpuPct)

    const desired = _computeDesiredTier(cpuLoad, memFreeMb, hasGpu)

    if (desired === _pendingTier) {
      _tierVotes++
      if (_tierVotes >= 2) {
        _tier = desired
        _tierVotes = 0
        _pendingTier = undefined
      }
    } else {
      _pendingTier = desired
      _tierVotes = 1
    }

    patch('ui_quality', _tierName(_tier))
  }
}
