import { state, patch, sleep } from './state.js'
import type { AppState } from './state.js'
import { pollSleep } from './performance.js'
import { bus } from '../bus.js'
import type { OHLCBar } from '../types.js'
import { loadSettings as ioLoadSettings, saveSettings as ioSaveSettings } from '../io/settings.js'
import { INTERVALS } from '../intervals.js'
import { guardSocket } from '../io/ws-guard.js'

// ── IO imports ────────────────────────────────────────────────────────────────

type KrakenModule = {
  fetchKlines(interval: string, asset: string, limit: number): Promise<OHLCBar[]>
  fetchKlinesRange(startTs: number, endTs: number, asset: string): Promise<OHLCBar[]>
  wsSubscriptions(): Record<string, unknown>[]
  parseWsMessage(msg: Record<string, unknown>): {type: string; symbol?: string; price?: number; change_pct?: number; groups?: unknown[]} | null
  WS_URL?: string
}

let _kraken: KrakenModule | null = null

try {
  _kraken = await import('../io/kraken.js') as unknown as KrakenModule
} catch {
  // kraken io not available
}

let clSubscribeMsg: (() => string) | null = null
let clParseMsg: ((raw: string) => {asset: string; price: number} | null) | null = null
let CL_RTDS_URL: string = 'wss://ws-live-data.polymarket.com'

try {
  const cl = await import('../io/chainlink.js')
  clSubscribeMsg = cl.subscribeMsg
  clParseMsg = cl.parseMsg
  CL_RTDS_URL = (cl as unknown as {RTDS_URL?: string}).RTDS_URL ?? CL_RTDS_URL
} catch {
  // chainlink io not available
}

// ── Module-level candle store ─────────────────────────────────────────────────

const _candles: Map<string, {[tf: string]: OHLCBar[]}> = new Map()
const _clPrices: Map<string, number> = new Map()
const _clPricesTs: Map<string, number> = new Map()

// Rolling fine-grained price tick buffer per asset (sec, price). Lets a past
// window be redrawn with every twist that actually happened — far more detail
// than Kraken's 1-minute bars (~5 points for a 5m window). Bounded to ~2h.
const _tickBuf: Map<string, Array<[number, number]>> = new Map()
const TICK_BUF_MAX = 24000
const TICK_BUF_SECS = 7200

function _recordTick(asset: string, price: number): void {
  if (!asset || !isFinite(price) || price <= 0) return
  const a = asset.toUpperCase()
  let buf = _tickBuf.get(a)
  if (!buf) { buf = []; _tickBuf.set(a, buf) }
  const nowSec = Date.now() / 1000
  buf.push([nowSec, price])
  if (buf.length > TICK_BUF_MAX) buf.splice(0, buf.length - TICK_BUF_MAX + 4000)
  const cutoff = nowSec - TICK_BUF_SECS
  while (buf.length && buf[0][0] < cutoff) buf.shift()
}

// Buffer Kraken ticks too, but only for assets Chainlink isn't currently
// feeding (e.g. HYPE) — avoids interleaving two price feeds for one asset.
bus.on('kraken_tick', (asset: string, price: number) => {
  if (Date.now() - (_clPricesTs.get(asset) ?? 0) > 30_000) _recordTick(asset, price)
})

/**
 * Build a high-resolution OHLC series for [startTs, endTs] from the live tick
 * buffer — ~70 bars across the window so line/percentage/candle modes all show
 * the full path. Returns [] when the window wasn't streamed this session.
 */
export function fineWindowCandles(asset: string, startTs: number, endTs: number): unknown[][] {
  const buf = _tickBuf.get(asset.toUpperCase())
  if (!buf || !buf.length) return []
  const span = Math.max(1, endTs - startTs)
  const step = Math.max(2, Math.round(span / 72))   // ~72 bars across the window
  const byBucket = new Map<number, number[]>()
  for (const [t, p] of buf) {
    if (t < startTs || t > endTs) continue
    const b = startTs + Math.floor((t - startTs) / step) * step
    const arr = byBucket.get(b)
    if (arr) arr.push(p); else byBucket.set(b, [p])
  }
  if (byBucket.size < 6) return []   // too sparse to be worth it — use 1m bars
  const keys = [...byBucket.keys()].sort((a, b) => a - b)
  // …and the samples must actually COVER the window. The tick buffer only holds
  // ~2h, so a 1d window would otherwise return a dense series spanning just its
  // final two hours, which the canvas would then stretch across the whole span.
  if (keys[keys.length - 1] - keys[0] < span * 0.8) return []
  const bars: number[][] = []
  let prevClose = NaN
  for (const k of keys) {
    const ps = byBucket.get(k)!
    const open = isFinite(prevClose) ? prevClose : ps[0]
    const close = ps[ps.length - 1]
    bars.push([k, open, Math.max(open, ...ps), Math.min(open, ...ps), close])
    prevClose = close
  }
  return bars
}

export function getCandles(): Map<string, {[tf: string]: OHLCBar[]}> {
  return _candles
}

export function getClPrices(): Map<string, number> {
  return _clPrices
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initState(s: AppState): void {
  s.interval = '5m'
  s.mode = 'line'
  s.theme = 'dark'
  s.chart_rev = 0
  s.window_candles_1m = []
  s.strike_price = 0
  s.cl_price = 0
  s.chart_asset = 'BTC'
  s.chart_target = 0
}

// ── Settings persistence ──────────────────────────────────────────────────────

export async function loadSettings(): Promise<void> {
  const s = ioLoadSettings()
  if (s.interval) patch('interval', s.interval)
  if (s.mode) patch('mode', s.mode)
  if (s.theme) {
    patch('theme', s.theme)
    bus.emit('theme_change', s.theme)
  }
  if (s.chart_asset) patch('chart_asset', s.chart_asset)
  if (s.practice !== undefined) patch('practice', s.practice)
  if (s.buy_mode) patch('buy_mode', s.buy_mode)
  if (s.buy_side) patch('buy_side', s.buy_side)
  if (s.trade_size) patch('trade_size', s.trade_size)
  if (s.limit_price) patch('limit_price', s.limit_price)
  if (Array.isArray(s.presets) && s.presets.length) patch('presets', s.presets)
  if (s.sign_mode) patch('sign_mode', s.sign_mode)
  if (s.send_currency) patch('send_currency', s.send_currency)
  if (s.swap_from) patch('swap_from', s.swap_from)
  if (s.swap_to) patch('swap_to', s.swap_to)
  if (s.last_wallet) patch('last_wallet', s.last_wallet)
  if (s.poly_proxy) patch('server_proxy', s.poly_proxy)
  patch('chart_rev', (state.chart_rev ?? 0) + 1)
}

export function saveSettings(): void {
  ioSaveSettings({
    interval: state.interval ?? '5m',
    mode: state.mode ?? 'line',
    theme: state.theme ?? 'dark',
    chart_asset: state.chart_asset ?? 'BTC',
    practice: state.practice ?? true,
    buy_mode: state.buy_mode ?? '1tap',
    buy_side: state.buy_side ?? 'UP',
    trade_size: state.trade_size ?? '25',
    limit_price: state.limit_price ?? '97',
    presets: (state.presets as number[] | undefined) ?? undefined,
    sign_mode: state.sign_mode ?? 'instant',
    send_currency: state.send_currency ?? 'USDC',
    swap_from: state.swap_from ?? 'USDC',
    swap_to: state.swap_to ?? 'USDC.e',
    last_wallet: state.last_wallet ?? undefined,
  })
}

// ── Event handlers ────────────────────────────────────────────────────────────

export function setChartInterval(interval: string): void {
  patch('interval', interval)
  patch('chart_rev', (state.chart_rev ?? 0) + 1)
  // Reset time-travel state on interval switch
  patch('viewing_slot', '')
  patch('viewing_future', false)
  patch('viewed_outcome', '')
  patch('window_candles_1m', [])
  patch('hist_prob', [])
  patch('viewed_condition_id', '')
  patch('viewed_series_id', '')
  patch('slot_offset', 0)
  patch('slot_results', {})
  // Clear social feeds so they reload for the new interval
  patch('mkt_trades', [])
  patch('mkt_up_holders', [])
  patch('mkt_dn_holders', [])
  patch('mkt_comments', [])
  patch('mkt_up_pos', [])
  patch('mkt_dn_pos', [])
  saveSettings()
  // Refetch candles for the new interval right away (no blank gap).
  void refreshActiveCandles()
}

export function setMode(mode: string): void {
  patch('mode', mode)
  patch('chart_rev', (state.chart_rev ?? 0) + 1)
}

export function toggleTheme(): void {
  const next = state.theme === 'dark' ? 'light' : 'dark'
  patch('theme', next)
  bus.emit('theme_change', next)
  saveSettings()
}

export function restoreSession(asset: string, interval: string): void {
  patch('chart_asset', asset)
  patch('interval', interval)
}

// ── Computed: chart_target ────────────────────────────────────────────────────

export function computeChartTarget(): number {
  // (a) time-travel: use the open price from the viewed window candles
  if (state.viewing_slot && state.window_candles_1m && state.window_candles_1m.length > 0) {
    const open = state.window_candles_1m[0][1] as number
    if (open && open > 0) return open
  }
  // (b) published strike
  if ((state.strike_price ?? 0) > 0) return state.strike_price
  // (c) per-window captured open
  const wins = state.windows ?? []
  if (wins.length > 0) {
    // Index by active_window, NOT wins[0]. wins[0] is whatever discovery
    // returned first (BTC 5m), so on any other selection this looked up the
    // wrong window's captured open and reported a wrong strike. Every sibling
    // site already reads active_window (see engine/windows.ts:381).
    const active = (wins[state.active_window ?? 0] ?? wins[0]) as Record<string, unknown>
    const activeKey = `${String(active['slug'] ?? '')}@${Number(active['event_start_ts'] ?? 0)}`
    const op = (state.window_opens ?? {})[activeKey] ?? 0
    if (op > 0) return op
  }
  // (d) stored window open price scalar
  if ((state.window_open_price ?? 0) > 0) return state.window_open_price
  // (e) live price as placeholder
  return state.cl_price || state.btc_price || 0
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _cacheKey(asset: string): string {
  return asset.toUpperCase()
}

function _publishCandles(asset: string, tf: string): void {
  // While time-travelling, window_candles_1m holds the VIEWED window's bars —
  // don't let the background live-candle loader clobber them (that race is why
  // the hindsight chart "randomly" reverted to the full live history and the
  // target jumped to a 2-day-old price).
  if (state.viewing_slot) return
  const key = _cacheKey(asset)
  const assetCandles = _candles.get(key)
  if (!assetCandles) return
  const rows = assetCandles[tf] ?? []
  if (asset === state.chart_asset && tf === state.interval) {
    patch('window_candles_1m', rows as unknown[][])
    patch('chart_rev', (state.chart_rev ?? 0) + 1)
  }
}

/**
 * Fetch the price candles spanning a single window [startTs, endTs) — used for
 * the hindsight canvas so a past window shows its full intra-window price action
 * end-to-end, not one interval-sized bar. Bar size follows the span (see
 * kraken.rangeGranularityMins): 1-minute for 5m/15m/1h, coarser for 1d, where
 * 1440 one-minute bars would be both truncated by Kraken and pointless.
 */
const _windowCandleCache = new Map<string, unknown[][]>()

export async function fetchWindowCandles(
  asset: string, startTs: number, endTs: number,
): Promise<unknown[][]> {
  if (!_kraken) return []
  const key = `${asset.toUpperCase()}:${startTs}:${endTs}`
  const cached = _windowCandleCache.get(key)
  if (cached && cached.length) return cached
  // Kraken's public OHLC rate-limits, so a single fetch intermittently returns
  // nothing ("candles randomly don't load"). Retry a few times, then cache the
  // result so re-viewing the same window is instant and never re-fails.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const bars = await _kraken.fetchKlinesRange(startTs, endTs, asset)
      if (bars && bars.length) {
        const out = bars as unknown as unknown[][]
        _windowCandleCache.set(key, out)
        if (_windowCandleCache.size > 200) {
          _windowCandleCache.delete(_windowCandleCache.keys().next().value as string)
        }
        return out
      }
    } catch { /* retry */ }
    await sleep(400)
  }
  return []
}

/**
 * Immediately surface candles for the current asset/interval — publish cached
 * bars instantly (no blank gap on switch), then refresh from Kraken. Call this
 * on asset/interval changes instead of waiting for the background sweep.
 */
export async function refreshActiveCandles(): Promise<void> {
  const asset = state.chart_asset ?? 'BTC'
  const tf = state.interval ?? '5m'
  const cached = _candles.get(_cacheKey(asset))?.[tf]
  if (cached && cached.length) _publishCandles(asset, tf)
  await _loadCandlesForAsset(asset, tf)
}

async function _loadCandlesForAsset(asset: string, tf: string): Promise<void> {
  if (!_kraken) return
  try {
    const bars = await _kraken.fetchKlines(tf, asset, 500)
    // Don't clobber good candles with an empty result — Kraken rate-limits and
    // intermittently returns nothing; keeping the last good set stops the
    // "candles won't load here and there" flicker.
    if (!bars || !bars.length) return
    const key = _cacheKey(asset)
    if (!_candles.has(key)) _candles.set(key, {})
    _candles.get(key)![tf] = bars
    _publishCandles(asset, tf)
  } catch {
    // transient load error — keep the cached candles
  }
}

// ── Background: load candles ──────────────────────────────────────────────────

export async function runLoadCandles(signal: AbortSignal): Promise<void> {
  const assets = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'HYPE', 'BNB']
  // One timeframe per tradable interval and nothing more — 4h/1w etc. would be
  // wasted load that trips Kraken's rate limit. 28 calls per sweep at the 220ms
  // stagger below is ~6s of gentle traffic; the active pair is fetched first.
  const tfs = INTERVALS

  // Active asset/interval first so the visible chart fills fast, then the rest.
  const loadActive = async () => {
    await _loadCandlesForAsset(state.chart_asset ?? 'BTC', state.interval ?? '5m')
  }

  while (!signal.aborted) {
    await loadActive()
    for (const asset of assets) {
      for (const tf of tfs) {
        if (signal.aborted) return
        await _loadCandlesForAsset(asset, tf)
        await sleep(220) // gentle stagger to stay under Kraken's rate limit
      }
    }
    await sleep(pollSleep())
    if (signal.aborted) break
    await loadActive()
  }
}

// ── Background: stream Chainlink prices ───────────────────────────────────────

export async function runStreamChainlink(signal: AbortSignal): Promise<void> {
  const WebSocket = (await import('ws')).default

  while (!signal.aborted) {
    if (!clSubscribeMsg || !clParseMsg) {
      await sleep(5000)
      continue
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(CL_RTDS_URL)
        // Half-open sockets never fire close/error, which would hang this loop
        // forever. Ping/pong probe terminates a dead peer so the loop reconnects.
        guardSocket(ws, { label: 'chainlink', staleMs: 45000 })

        ws.on('open', () => {
          ws.send(clSubscribeMsg!())
        })

        ws.on('message', (data: Buffer) => {
          if (signal.aborted) { ws.close(); resolve(); return }
          try {
            const tick = clParseMsg!(data.toString())
            if (tick) {
              _clPrices.set(tick.asset, tick.price)
              _clPricesTs.set(tick.asset, Date.now())
              _recordTick(tick.asset, tick.price)
              bus.emit('chainlink_tick', tick.asset, tick.price)
              if (tick.asset === state.chart_asset) {
                patch('cl_price', tick.price)
              }
            }
          } catch {
            // parse error
          }
        })

        ws.on('error', reject)
        ws.on('close', resolve)

        signal.addEventListener('abort', () => { ws.close(); resolve() }, { once: true })
      })
    } catch {
      // reconnect
    }

    if (!signal.aborted) {
      await sleep(3000)
    }
  }
}
