import { state, patch, sleep } from './state.js'
import type { AppState } from './state.js'
import { fastSleep, tickSleep } from './performance.js'
import { bus } from '../bus.js'
import type { TimeSlot, MarketWindow } from '../types.js'
import WebSocket from 'ws'
import { fetchOpenPriceAt } from '../io/kraken.js'
import { guardSocket } from '../io/ws-guard.js'

// ── IO imports ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any

let _pm: Record<string, AnyFn> | null = null
let CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'

try {
  _pm = await import('../io/polymarket.js') as unknown as Record<string, AnyFn>
  CLOB_WS_URL = (_pm as unknown as {CLOB_WS_URL: string}).CLOB_WS_URL ?? CLOB_WS_URL
} catch {
  // io/polymarket not available
}

function _call<T>(name: string, ...args: unknown[]): Promise<T> | null {
  if (!_pm || typeof _pm[name] !== 'function') return null
  return _pm[name](...args) as Promise<T>
}

// ── Module-level buffers ──────────────────────────────────────────────────────

const _priceBuf: Map<string, [number, boolean, number, number]> = new Map()
const _bookBuf: Map<string, {asks: unknown[], bids: unknown[]}> = new Map()

// ── Module-level rollover tracking ────────────────────────────────────────────

let _lastEndTs = 0
let _rolloverSlug = ''

export function getPriceBuf(): Map<string, [number, boolean, number, number]> {
  return _priceBuf
}

export function getBookBuf(): Map<string, {asks: unknown[], bids: unknown[]}> {
  return _bookBuf
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initState(s: AppState): void {
  s.windows = []
  s.active_window = 0
  s.up_ask = 0
  s.dn_ask = 0
  s.combined = 0
  s.secs_left = 0
  s.active_end_ts = 0
  s.up_token = ''
  s.dn_token = ''
  s.token_asks = {}
  s.token_bids = {}
  s.rollover_rev = 0
  s.window_open_price = 0
  s.window_opens = {}
  s.chart_asset = 'BTC'
  s.nav_slots_expanded = false
  s.slot_offset = 0
  s.viewing_slot = ''
  s.viewing_future = false
  s.viewed_outcome = ''
  s.viewed_open_str = ''
  s.viewed_settle_str = ''
  s.viewed_delta_str = ''
  s.hist_prob = []
  s.viewed_condition_id = ''
  s.viewed_series_id = ''
  s.clock_tick = 0
  s.feed_degraded = false
  s.slot_results = {}
  s.window_time_label = ''
  s.effective_condition_id = ''
  s.effective_series_id = ''
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Gate: only patch price indexes when values actually changed by > eps cents */
export function _indexChanged(
  oldIdx: Record<string, number>,
  newIdx: Record<string, number>,
  eps = 0.05,
): boolean {
  const oldKeys = Object.keys(oldIdx)
  const newKeys = Object.keys(newIdx)
  if (oldKeys.length !== newKeys.length) return true
  for (const k of newKeys) {
    if (!(k in oldIdx)) return true
    if (Math.abs(oldIdx[k] - newIdx[k]) > eps) return true
  }
  return false
}

/** Compute the effective condition id for social feed routing */
export function computeEffectiveCid(
  viewingSlot: string,
  viewedCid: string,
  activeCid: string,
): string {
  return viewingSlot && viewedCid ? viewedCid : activeCid
}

/** Compute the effective series id for social feed routing */
export function computeEffectiveSid(
  viewingSlot: string,
  viewedSid: string,
  activeSid: string,
): string {
  return viewingSlot && viewedSid ? viewedSid : activeSid
}

/** Compute the window time range label (LIVE/PAST/NEXT prefix + date + HH:MM–HH:MM ET) */
export function computeWindowTimeLabel(
  windows: Record<string, unknown>[],
  viewingSlot: string,
  viewingFuture: boolean,
  nowTs: number,
): string {
  if (!windows.length) return ''

  const active = windows[0] as Record<string, unknown>
  const activeEndTs = (active['end_ts'] as number) ?? 0
  const interval = (active['interval'] as string) ?? '5m'
  const intervalSecs = interval === '15m' ? 900 : 300

  let startTs: number
  let endTs: number

  if (viewingSlot) {
    const slotTs = Number(viewingSlot)
    startTs = slotTs
    endTs = slotTs + intervalSecs
  } else {
    endTs = activeEndTs
    startTs = endTs - intervalSecs
  }

  const prefix = viewingFuture ? 'NEXT' : viewingSlot ? 'PAST' : 'LIVE'

  const etFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  const startDate = new Date(startTs * 1000)
  const endDate = new Date(endTs * 1000)

  // Build date string from startDate
  const parts = etFmt.formatToParts(startDate)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  const dateStr = `${get('weekday')} ${get('month')} ${get('day')}`

  const startTime = timeFmt.format(startDate)
  const endTime = timeFmt.format(endDate)

  void nowTs // suppress unused warning
  return `${prefix} ${dateStr} · ${startTime}–${endTime} ET`
}

export function computeWindowTimeStr(secsLeft: number): string {
  if (secsLeft <= 0) return '—'
  const m = Math.floor(secsLeft / 60)
  const s = Math.floor(secsLeft % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function computeMarketsReady(
  windows: Record<string, unknown>[],
  tokenAsks: Record<string, number>,
): boolean {
  if (!windows.length) return false
  const w = windows[0]
  const upToken = w['up_token'] as string | undefined
  const dnToken = w['dn_token'] as string | undefined
  if (!upToken || !dnToken) return false
  return upToken in tokenAsks && dnToken in tokenAsks
}

export function computeTimeSlots(
  windows: Record<string, unknown>[],
  slotOffset: number,
  viewingSlot: string,
  slotResults: Record<string, string>,
  nowTs: number,
): TimeSlot[] {
  const slots: TimeSlot[] = []
  if (!windows.length) {
    for (let i = 0; i < 5; i++) {
      slots.push({ label: '--:--', ts: 0, is_current: false, is_past: false, is_viewing: false, result: '' })
    }
    return slots
  }

  const active = windows[0]
  const endTs = (active['end_ts'] as number) ?? 0
  const interval = (active['interval'] as string) ?? '5m'
  const intervalSecs = interval === '15m' ? 900 : 300

  for (let i = -2; i <= 2; i++) {
    const slotEndTs = endTs + (i + slotOffset) * intervalSecs
    const slotStartTs = slotEndTs - intervalSecs
    const label = _fmtTs(slotStartTs)
    const slotKey = String(slotStartTs)
    const isPast = slotEndTs <= nowTs
    const isCurrent = i === 0 && slotOffset === 0
    const isViewing = viewingSlot !== '' ? viewingSlot === slotKey : isCurrent
    const result = slotResults[slotKey] ?? ''
    slots.push({ label, ts: slotStartTs, is_current: isCurrent, is_past: isPast, is_viewing: isViewing, result })
  }
  return slots
}

function _fmtTs(ts: number): string {
  if (!ts) return '--:--'
  const d = new Date(ts * 1000)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

// ── Background: stream Polymarket CLOB prices ─────────────────────────────────

export async function runStreamPolymarket(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const tokens = [...new Set([
      ...Object.keys(state.token_asks ?? {}),
      ...Object.keys(state.token_bids ?? {}),
    ])]
    if (!tokens.length || !_pm) {
      await sleep(fastSleep())
      continue
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(CLOB_WS_URL)
        // Half-open sockets never fire close/error, which would hang this loop
        // forever. Ping/pong probe terminates a dead peer so the loop reconnects.
        guardSocket(ws, { label: 'clob', staleMs: 60000 })

        ws.on('open', () => {
          ws.send(JSON.stringify({ assets_ids: tokens, type: 'market' }))
        })

        ws.on('message', (data: Buffer) => {
          if (signal.aborted) { ws.close(); resolve(); return }
          try {
            const parseFn = _pm?.['parseClobWs']
            if (typeof parseFn !== 'function') return
            const raw = JSON.parse(data.toString()) as unknown
            const ticks = parseFn(raw) as Array<{token_id: string; best_ask: number; best_bid: number}>
            const newAsks: Record<string, number> = { ...state.token_asks }
            const newBids: Record<string, number> = { ...state.token_bids }
            let changed = false
            for (const t of ticks) {
              const prev = _priceBuf.get(t.token_id)
              _priceBuf.set(t.token_id, [prev ? prev[0] : 0, prev ? prev[1] : true, t.best_ask, t.best_bid])
              if (newAsks[t.token_id] !== t.best_ask || newBids[t.token_id] !== t.best_bid) {
                newAsks[t.token_id] = t.best_ask
                newBids[t.token_id] = t.best_bid
                changed = true
                bus.emit('price_buf', t.token_id, _priceBuf.get(t.token_id)![1], t.best_ask, t.best_bid)
              }
            }
            if (changed) {
              // Engine_014: only patch indexes when values changed by > 0.05 cents
              if (_indexChanged(state.token_asks ?? {}, newAsks)) {
                patch('token_asks', newAsks)
              }
              if (_indexChanged(state.token_bids ?? {}, newBids)) {
                patch('token_bids', newBids)
              }
              _updateActivePrices()
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
      // reconnect after delay
    }

    if (!signal.aborted) {
      await sleep(fastSleep())
    }
  }
}

function _updateActivePrices(): void {
  const asks = state.token_asks ?? {}
  const bids = state.token_bids ?? {}
  const upToken = state.up_token
  const dnToken = state.dn_token
  if (upToken && dnToken) {
    patch('up_ask', asks[upToken] ?? 0)
    patch('dn_ask', asks[dnToken] ?? 0)
    patch('combined', (asks[upToken] ?? 0) + (asks[dnToken] ?? 0))
  }
}

// ── Background: tick windows clock + periodic refresh ─────────────────────────

export async function runTickWindows(signal: AbortSignal): Promise<void> {
  let lastPoll = 0

  while (!signal.aborted) {
    await sleep(tickSleep())
    if (signal.aborted) break

    const nowTs = Math.floor(Date.now() / 1000)
    const endTs = state.active_end_ts ?? 0
    const secsLeft = Math.max(0, endTs - nowTs)
    patch('secs_left', secsLeft)
    patch('clock_tick', (state.clock_tick ?? 0) + 1)

    // Engine_015: update window time label every tick
    patch('window_time_label', computeWindowTimeLabel(
      state.windows ?? [],
      state.viewing_slot ?? '',
      state.viewing_future ?? false,
      nowTs,
    ))

    // Engine_017: update chart_target every tick
    const { computeChartTarget } = await import('./chart.js')
    patch('chart_target', computeChartTarget())

    // Smooth rollover: once the active window crosses its boundary, poll hard
    // (~every 2s) until the next window publishes — so the whole site flips to
    // the new window within a second or two instead of waiting on the 30s poll.
    const expired = endTs > 0 && nowTs >= endTs
    if (expired) {
      if (nowTs - lastPoll >= 2) { lastPoll = nowTs; await _refreshWindows() }
    } else if (!lastPoll || nowTs - lastPoll > 30) {
      lastPoll = nowTs
      await _refreshWindows()
    }
  }
}

// Fire one coordinated, site-wide refresh the instant a window rolls over: settle
// & auto-cash-out wins, pull fresh results, and refresh the order book + the
// connected/active balances + positions — so every field flips together.
function _onRollover(): void {
  ;(async () => {
    try { (await import('./social.js')).refreshResultsNow().catch(() => {}) } catch { /* */ }
    try { (await import('./order-book.js')).pollOrderbookOnce().catch(() => {}) } catch { /* */ }
    try {
      const [{ runRefreshPositions }, { runRefreshBalance }] = await Promise.all([
        import('./positions.js'), import('./trading.js'),
      ])
      runRefreshPositions().catch(() => {}); runRefreshBalance().catch(() => {})
    } catch { /* */ }
  })()
}

function _openKey(w: MarketWindow): string {
  return `${w.slug ?? ''}@${w.event_start_ts ?? 0}`
}

async function _refreshWindows(): Promise<void> {
  const promise = _call<MarketWindow[]>('fetchAllWindows')
  if (!promise) return

  try {
    const wins = await promise
    if (!wins.length) { patch('feed_degraded', true); return }
    patch('feed_degraded', false)

    // Fetch open price for each window (Chainlink if at boundary, else Kraken 1m)
    const newOpenEntries = await Promise.all(wins.map(async (w) => {
      const est = w.event_start_ts ?? 0
      if (!est) return null
      const key = _openKey(w)
      try {
        const price = await fetchOpenPriceAt(w.asset ?? 'BTC', est)
        return price > 0 ? [key, price] as [string, number] : null
      } catch {
        return null
      }
    }))

    const newOpens: Record<string, number> = {}
    for (const entry of newOpenEntries) {
      if (entry) newOpens[entry[0]] = entry[1]
    }

    // FIRST capture wins — don't clobber a live Chainlink open with a later Kraken fallback
    const liveKeys = new Set(wins.map(w => _openKey(w)))
    const kept: Record<string, number> = {}
    for (const [k, v] of Object.entries(state.window_opens ?? {})) {
      if (liveKeys.has(k)) kept[k] = v
    }
    const mergedOpens = { ...newOpens, ...kept }
    patch('window_opens', mergedOpens)

    const active = wins[0]

    // Engine_008: rollover_rev bump on window boundary crossing
    if (_lastEndTs > 0 && active.end_ts > _lastEndTs && active.slug === _rolloverSlug) {
      // Same market, boundary advanced — bump rollover + fire the coordinated refresh
      patch('rollover_rev', (state.rollover_rev ?? 0) + 1)
      _onRollover()
    } else if (_lastEndTs > 0 && active.slug !== _rolloverSlug) {
      // New slug = new market — also bump so chart resets
      patch('rollover_rev', (state.rollover_rev ?? 0) + 1)
      _onRollover()
    }
    _lastEndTs = active.end_ts
    _rolloverSlug = active.slug

    patch('windows', wins as unknown as Record<string, unknown>[])
    patch('active_end_ts', active.end_ts)
    patch('up_token', active.up_token)
    patch('dn_token', active.dn_token)
    patch('up_ask', active.up_ask)
    patch('dn_ask', active.dn_ask)
    patch('combined', active.combined)
    patch('secs_left', active.secs_left)
    patch('viewed_condition_id', active.condition_id)
    patch('viewed_series_id', active.series_id)

    // Engine_016: update effective routing ids
    patch('effective_condition_id', computeEffectiveCid(
      state.viewing_slot ?? '', state.viewed_condition_id ?? '', active.condition_id))
    patch('effective_series_id', computeEffectiveSid(
      state.viewing_slot ?? '', state.viewed_series_id ?? '', active.series_id))

    // Update the displayed open price for the active window
    const activeKey = _openKey(active)
    const op = mergedOpens[activeKey] ?? 0
    if (op > 0) patch('window_open_price', op)

    const newAsks: Record<string, number> = {}
    const newBids: Record<string, number> = {}
    for (const w of wins) {
      if (w.up_token) { newAsks[w.up_token] = w.up_ask; newBids[w.up_token] = 100 - w.up_ask }
      if (w.dn_token) { newAsks[w.dn_token] = w.dn_ask; newBids[w.dn_token] = 100 - w.dn_ask }
    }
    // Engine_014: gate seed asks/bids on _indexChanged
    if (_indexChanged(state.token_asks ?? {}, newAsks)) patch('token_asks', newAsks)
    if (_indexChanged(state.token_bids ?? {}, newBids)) patch('token_bids', newBids)
  } catch {
    patch('feed_degraded', true)
  }
}

// ── Engine_004: load_prob_history ─────────────────────────────────────────────

export async function runLoadProbHistory(slotTs: number): Promise<void> {
  const asset = state.chart_asset ?? 'BTC'
  const interval = state.interval ?? '5m'
  const intervalSecs = interval === '15m' ? 900 : 300
  const boundaryTs = slotTs + intervalSecs // the window's end_ts

  // Stale check before starting
  if (state.viewing_slot !== String(slotTs)) return

  // Try hindsight snapshot first (instant, no fetch)
  const { get: getHindsight } = await import('../io/hindsight.js')
  const frozen = getHindsight(asset, interval, slotTs) as Record<string, unknown> | undefined
  if (frozen?.['prob_series']) {
    patch('hist_prob', frozen['prob_series'] as Record<string, unknown>[])
    if (frozen['condition_id']) {
      const cid = String(frozen['condition_id'])
      const sid = String(frozen['series_id'] ?? '')
      patch('viewed_condition_id', cid)
      patch('viewed_series_id', sid)
      patch('effective_condition_id', computeEffectiveCid(state.viewing_slot, cid, cid))
      patch('effective_series_id', computeEffectiveSid(state.viewing_slot, sid, sid))
    }
    return
  }

  // A past window is a SEPARATE market with its own slug/token/condition id,
  // not present in state.windows (which only holds the current windows per
  // asset/interval). Resolve it from the base slug + the window's end boundary.
  const wins = state.windows ?? []
  const assetLc = asset.toLowerCase()
  const activeWin = wins.find(w =>
    String(w['interval'] ?? '') === interval &&
    String(w['slug'] ?? '').startsWith(assetLc),
  ) as Record<string, unknown> | undefined
  const baseSlug = activeWin ? String(activeWin['slug'] ?? '') : ''
  if (!baseSlug) return

  // Resolve the past window's UP token + condition/series id by slug+boundary.
  const metaP = _call<{ token: string; condition_id: string; series_id: string; outcome: string }>(
    'fetchWindowMeta', baseSlug, boundaryTs)
  const meta = metaP ? await metaP : null
  if (state.viewing_slot !== String(slotTs)) return // stale
  if (meta?.condition_id) {
    const cid = meta.condition_id
    const sid = meta.series_id ?? ''
    patch('viewed_condition_id', cid)
    patch('viewed_series_id', sid)
    patch('effective_condition_id', computeEffectiveCid(state.viewing_slot, cid, cid))
    patch('effective_series_id', computeEffectiveSid(state.viewing_slot, sid, sid))
  }
  // Resolved winner straight from the window's market — no more stuck "RESOLVING…".
  if (meta?.outcome) patch('viewed_outcome', meta.outcome)

  // Fetch UP-probability history for that window's token over [start, end].
  if (meta?.token) {
    const histP = _call<{ t: number; pct: number }[]>(
      'fetchProbHistory', meta.token, slotTs, boundaryTs)
    if (histP) {
      try {
        const series = await histP
        if (state.viewing_slot !== String(slotTs)) return // stale
        patch('hist_prob', series as unknown as Record<string, unknown>[])
      } catch {
        // ignore fetch errors
      }
    }
  }
}

// ── Engine_005: set_viewing_slot ──────────────────────────────────────────────

export async function runSetViewingSlot(slotTs: number): Promise<void> {
  const wins = state.windows ?? []
  const active = wins[0] as Record<string, unknown> | undefined

  // If slotTs is 0 or matches the live window, go to live
  if (slotTs === 0) {
    // caller handles slotsLive
    return
  }

  const nowTs = Date.now() / 1000

  // Future slot
  if (slotTs > nowTs) {
    patch('viewing_slot', String(slotTs))
    patch('viewing_future', true)
    patch('viewed_outcome', '')
    patch('window_candles_1m', [])
    patch('hist_prob', [])
    // Update effective ids — no viewed cid for future slots
    const liveCid = active ? String(active['condition_id'] ?? '') : ''
    const liveSid = active ? String(active['series_id'] ?? '') : ''
    patch('effective_condition_id', computeEffectiveCid('', '', liveCid))
    patch('effective_series_id', computeEffectiveSid('', '', liveSid))
    patch('chart_rev', (state.chart_rev ?? 0) + 1)
    return
  }

  // Past slot
  patch('viewing_slot', String(slotTs))
  patch('viewing_future', false)
  // Clear the previous slot's snapshot so we never show a stale outcome/chart
  // while the new window loads (prevents the "up won… ah, down won" flicker).
  patch('viewed_outcome', '')
  patch('hist_prob', [])
  patch('window_candles_1m', [])
  patch('chart_rev', (state.chart_rev ?? 0) + 1)

  const asset = state.chart_asset ?? 'BTC'
  const interval = state.interval ?? '5m'
  const intervalSecs = interval === '15m' ? 900 : 300
  const slotEnd = slotTs + intervalSecs

  // Update effective_condition/series_id (refined by load_prob_history)
  const liveCid = active ? String(active['condition_id'] ?? '') : ''
  const liveSid = active ? String(active['series_id'] ?? '') : ''
  patch('effective_condition_id', computeEffectiveCid(String(slotTs), state.viewed_condition_id ?? '', liveCid))
  patch('effective_series_id', computeEffectiveSid(String(slotTs), state.viewed_series_id ?? '', liveSid))

  // Hindsight snapshot first (instant restore if captured this session)
  const { get: getHindsight } = await import('../io/hindsight.js')
  const frozen = getHindsight(asset, interval, slotTs) as Record<string, unknown> | undefined
  const frozenCandles = frozen?.['candles'] as unknown[] | undefined
  if (frozenCandles && frozenCandles.length > 0) {
    patch('window_candles_1m', frozenCandles as unknown[][])
    if (frozen?.['outcome']) patch('viewed_outcome', String(frozen['outcome']))
    patch('chart_rev', (state.chart_rev ?? 0) + 1)
    await runLoadProbHistory(slotTs)
    return
  }

  const { fetchWindowCandles, fineWindowCandles, computeChartTarget } = await import('./chart.js')

  // Prefer the high-resolution series built from the live tick buffer (every
  // twist the window actually had); fall back to Kraken 1-minute bars for
  // windows that weren't streamed this session.
  const fine = fineWindowCandles(asset, slotTs, slotEnd)
  if (fine.length > 0) {
    patch('window_candles_1m', fine)
    patch('chart_rev', (state.chart_rev ?? 0) + 1)
    _applyCandleSnapshot(fine)
    patch('chart_target', computeChartTarget())
    await runLoadProbHistory(slotTs)
    return
  }

  // Fetch the full intra-window 1-minute price history so the canvas shows the
  // whole window end-to-end (5 bars for 5m, 15 for 15m), not one interval bar.
  const winCandles = await fetchWindowCandles(asset, slotTs, slotEnd)
  if (state.viewing_slot !== String(slotTs)) return // stale
  if (winCandles.length > 0) {
    patch('window_candles_1m', winCandles)
    patch('chart_rev', (state.chart_rev ?? 0) + 1)
    // Derive the window's snapshot from its own candles — works for ANY window
    // Kraken covers (~12h), unlike the gamma outcome which only spans ~2 windows.
    // The market resolves UP if it closed above where it opened, else DOWN.
    _applyCandleSnapshot(winCandles)
  }
  patch('chart_target', computeChartTarget())
  await runLoadProbHistory(slotTs)
}

// Compute viewed open/settle/delta + outcome from the window's own candles.
function _applyCandleSnapshot(candles: unknown[][]): void {
  const first = candles[0]
  const last = candles[candles.length - 1]
  if (!first || !last) return
  const open = Number(first[1])   // [time, open, high, low, close]
  const settle = Number(last[4])
  if (!isFinite(open) || !isFinite(settle) || open <= 0) return
  const delta = settle - open
  patch('viewed_open_str', _fmtPrice(open))
  patch('viewed_settle_str', _fmtPrice(settle))
  patch('viewed_delta_str', (delta >= 0 ? '+' : '−') + _fmtPrice(Math.abs(delta)))
  // Candle-derived outcome — overridden by the gamma outcome later if available.
  patch('viewed_outcome', settle >= open ? 'UP' : 'DOWN')
}

function _fmtPrice(v: number): string {
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
