import { state, patch, sleep } from './state.js'
import type { AppState } from './state.js'
import { pollSleep } from './performance.js'
import { bus } from '../bus.js'
import { notify } from './notify.js'
import { guardSocket } from '../io/ws-guard.js'
import { ingestRtdsFrame } from './activity.js'

// ── IO imports ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any

let _pm: Record<string, AnyFn> | null = null
let RTDS_URL = 'wss://ws-live-data.polymarket.com'

// cid whose social data is FULLY loaded (trades + holders + comments). Empty
// until all three land, so runPollResults keeps retrying partial loads.
let _socialFullCid = ''

try {
  _pm = await import('../io/polymarket.js') as unknown as Record<string, AnyFn>
  RTDS_URL = (_pm as unknown as {RTDS_URL: string}).RTDS_URL ?? RTDS_URL
} catch {
  // io/polymarket not available
}

function _callPm<T>(name: string, ...args: unknown[]): Promise<T> | null {
  if (!_pm || typeof _pm[name] !== 'function') return null
  return _pm[name](...args) as Promise<T>
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initState(s: AppState): void {
  s.market_tab = 'activity'
  s.mkt_trades = []
  s.mkt_up_holders = []
  s.mkt_dn_holders = []
  s.mkt_comments = []
  s.mkt_up_pos = []
  s.mkt_dn_pos = []
  s.social_loaded_cid = ''
  s.social_full_cid = ''
  s.feed_limit = 20
  s.feed_loading_more = false
  s.pos_lb_loading = false
  s.pos_lb_limit = 20
  s.recent_results = []
  s.history_expanded = false
  s.window_results = {}
}

// ── Engine_010: toggle_history ────────────────────────────────────────────────

export function toggleHistory(): void {
  patch('history_expanded', !state.history_expanded)
}

// ── Event handlers ────────────────────────────────────────────────────────────

export function setMarketTab(tab: string): void {
  patch('market_tab', tab)
}

export async function loadMoreFeed(): Promise<void> {
  if (state.feed_loading_more) return
  patch('feed_loading_more', true)
  const newLimit = (state.feed_limit ?? 20) + 20
  patch('feed_limit', newLimit)

  try {
    // Engine_016: use effective_condition_id for proper time-travel routing
    const cid = state.effective_condition_id || state.viewed_condition_id || ''
    if (cid) {
      const trades = await _callPm<Record<string, unknown>[]>('fetchMarketTrades', cid, newLimit)
      if (trades) patch('mkt_trades', trades)
    }
  } catch {
    // ignore
  } finally {
    patch('feed_loading_more', false)
  }
}

export async function fetchPositionsLeaderboard(): Promise<void> {
  if (state.pos_lb_loading) return
  patch('pos_lb_loading', true)

  try {
    // Engine_016: use effective_condition_id for proper time-travel routing
    const cid = state.effective_condition_id || state.viewed_condition_id || ''
    if (cid) {
      const result = await _callPm<{up: Record<string, unknown>[]; down: Record<string, unknown>[]}>('fetchMarketPositions', cid, state.pos_lb_limit ?? 20)
      if (result) {
        patch('mkt_up_pos', result.up)
        patch('mkt_dn_pos', result.down)
      }
    }
  } catch {
    // ignore
  } finally {
    patch('pos_lb_loading', false)
  }
}

// ── Background: stream RTDS trades ───────────────────────────────────────────

export async function runStreamSocial(signal: AbortSignal): Promise<void> {
  const WebSocket = (await import('ws')).default

  while (!signal.aborted) {
    if (!_pm) {
      await sleep(5000)
      continue
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(RTDS_URL)
        // Half-open sockets never fire close/error, which would hang this loop
        // forever. Ping/pong probe terminates a dead peer so the loop reconnects.
        guardSocket(ws, { label: 'rtds', staleMs: 60000 })

        ws.on('open', () => {
          // Prefer the trades+comments frame; fall back to trades-only so an
          // older io module still streams the per-market feed.
          const subFn = _pm?.['rtdsActivitySubscribe'] ?? _pm?.['rtdsTradesSubscribe']
          if (typeof subFn === 'function') ws.send(subFn())
        })

        ws.on('message', (data: Buffer) => {
          if (signal.aborted) { ws.close(); resolve(); return }

          // RTDS sends either a single frame or a batch, plus non-JSON keepalives.
          let frames: unknown[]
          try {
            const parsed = JSON.parse(data.toString())
            frames = Array.isArray(parsed) ? parsed : [parsed]
          } catch {
            return  // keepalive / malformed
          }

          for (const frame of frames) {
            // The cross-market activity log sees EVERY frame — it must run before
            // the condition_id filter below, which exists to keep mkt_trades
            // scoped to the viewed market.
            try { ingestRtdsFrame(frame) } catch { /* malformed frame */ }

            try {
              const parseFn = _pm?.['parseRtdsTrade']
              if (typeof parseFn !== 'function') continue

              // parseRtdsTrade takes the PARSED frame. It used to be handed the
              // raw JSON string here, which its `typeof !== "object"` guard
              // rejected outright — so this feed silently produced nothing.
              const trade = parseFn(frame) as (Record<string, unknown> & {condition_id: string}) | null
              if (!trade) continue

              // Engine_016: route by effective_condition_id for proper time-travel routing
              const cid = state.effective_condition_id || state.viewed_condition_id || ''
              if (trade['condition_id'] !== cid) continue

              bus.emit('rtds_trade', trade)

              const current = state.mkt_trades ?? []
              const updated = [trade, ...current].slice(0, state.feed_limit ?? 20)
              patch('mkt_trades', updated)
            } catch {
              // parse error
            }
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

// ── Background: poll social data + results ────────────────────────────────────

export async function runPollResults(signal: AbortSignal): Promise<void> {
  // Fast retry cadence while a market's social data is only partially loaded, so
  // Holders/Comments recover within ~1s of a transient fetch failure instead of
  // waiting a full poll cycle (3–12s depending on the power tier).
  const PARTIAL_RETRY_MS = 1000
  while (!signal.aborted) {
    // Engine_016: use effective_condition_id for routing
    const cid = state.effective_condition_id || state.viewed_condition_id || ''
    const sid = state.effective_series_id || state.viewed_series_id || ''

    if (cid) {
      // Refresh on market change, or keep retrying while this market's social
      // data is only partially loaded (a holders/comments fetch failed earlier).
      if (state.social_loaded_cid !== cid || _socialFullCid !== cid) {
        await _refreshSocial(cid, sid)
      }
      await _pollResults()
    }

    if (signal.aborted) break
    const partial = !!cid && _socialFullCid !== cid
    await sleep(partial ? Math.min(PARTIAL_RETRY_MS, pollSleep()) : pollSleep())
  }
}

async function _refreshSocial(cid: string, sid: string): Promise<void> {
  const limit = state.feed_limit ?? 20

  const [tradesP, holdersP, commentsP] = [
    _callPm<Record<string, unknown>[]>('fetchMarketTrades', cid, limit),
    _callPm<{up: Record<string, unknown>[]; down: Record<string, unknown>[]}>(
      'fetchMarketHolders', cid, limit),
    sid ? _callPm<Record<string, unknown>[]>('fetchMarketComments', sid, limit) : null,
  ]

  const results = await Promise.allSettled([
    tradesP ?? Promise.resolve(null),
    holdersP ?? Promise.resolve(null),
    commentsP ?? Promise.resolve(null),
  ])

  // Track whether each *attempted* fetch actually succeeded. A null (e.g. no
  // series id for comments) counts as "not attempted", not a failure.
  const tradesOk   = tradesP   ? results[0].status === 'fulfilled' && !!results[0].value : true
  const holdersOk  = holdersP  ? results[1].status === 'fulfilled' && !!results[1].value : true
  const commentsOk = commentsP ? results[2].status === 'fulfilled' && !!results[2].value : true

  if (results[0].status === 'fulfilled' && results[0].value) {
    patch('mkt_trades', results[0].value as Record<string, unknown>[])
  }
  if (results[1].status === 'fulfilled' && results[1].value) {
    const h = results[1].value as {up: Record<string, unknown>[]; down: Record<string, unknown>[]}
    patch('mkt_up_holders', h.up)
    patch('mkt_dn_holders', h.down)
  }
  if (results[2].status === 'fulfilled' && results[2].value) {
    patch('mkt_comments', results[2].value as Record<string, unknown>[])
  }

  // Clear the skeleton as soon as the primary feed (trades) is in — Activity is
  // the default tab and the RTDS stream keeps it live. Holders/Comments fall
  // back to their own empty states until their fetch lands.
  if (tradesOk) patch('social_loaded_cid', cid)

  // Track full completion separately: only when every attempted fetch
  // succeeded do we stop re-fetching this market. Previously a single transient
  // holders/comments failure stuck those tabs empty forever (the loaded flag
  // was set regardless), with no retry. Now runPollResults keeps retrying until
  // holders + comments actually land.
  _socialFullCid = (tradesOk && holdersOk && commentsOk) ? cid : ''
  // Publish full-load state so the client can keep Holders/Comments on a skeleton
  // (not the empty state) until their fetch actually lands.
  patch('social_full_cid', _socialFullCid)
}

/** Force an immediate results + paper-settlement (auto-cashout) refresh — called
 *  by the windows rollover so wins settle the instant the boundary crosses. */
export async function refreshResultsNow(): Promise<void> { await _pollResults() }

async function _pollResults(): Promise<void> {
  const windows = state.windows ?? []
  if (!windows.length) return

  // Engine_013: collect results across all unique slugs
  const slugSet = new Set<string>()
  for (const w of windows) {
    const slug = (w['slug'] as string) ?? ''
    if (slug) slugSet.add(slug)
  }

  const slotResults: Record<string, string> = { ...(state.slot_results ?? {}) }
  const windowResultsMap: Record<string, string[]> = {}
  const allResults: Record<string, unknown>[] = []

  await Promise.allSettled(Array.from(slugSet).map(async (slug) => {
    try {
      // Find this window's interval for computing startTs + the history step.
      const win = windows.find(w => (w['slug'] as string) === slug) as Record<string, unknown> | undefined
      const interval = win ? String(win['interval'] ?? '5m') : '5m'
      const intervalSecs = interval === '15m' ? 900 : 300
      const anchorEnd = Number(win?.['end_ts'] ?? 0)   // real boundary → aligned slugs

      // fetchRecentResults queries the *base* slug with closed=true, which returns
      // nothing (each window is a distinct timestamped slug). fetchWindowHistory
      // reconstructs the per-window boundary slugs and returns real winners.
      const results = await _callPm<Record<string, unknown>[]>(
        'fetchWindowHistory', slug, intervalSecs / 60, 12, anchorEnd)
      if (!results) return

      // Gamma only keeps ~1 past window queryable, so accumulate over time:
      // merge whatever decided windows we can see into the persistent per-market
      // history and read back its latest 3 (oldest→newest, fills in over runs).
      const { recordResults } = await import('../io/window-history.js')
      const seen = results
        .filter(r => r['winner'] === 'UP' || r['winner'] === 'DOWN')
        .map(r => ({ t: Number(r['end_ts'] ?? 0), w: r['winner'] as string }))
      const perSlug = recordResults(slug, seen, 3)
      if (perSlug.length) windowResultsMap[slug] = perSlug

      for (const r of results) {
        const endTs = Number(r['end_ts'] ?? 0)
        const winner = r['winner'] as string | undefined
        if (endTs && (winner === 'UP' || winner === 'DOWN')) {
          const startTs = endTs - intervalSecs
          slotResults[String(startTs)] = winner
        }
        allResults.push(r)
      }
    } catch {
      // ignore per-slug errors
    }
  }))

  // Persist the accumulated per-market history once for this poll.
  try { (await import('../io/window-history.js')).save() } catch { /* best-effort */ }

  patch('slot_results', slotResults)
  patch('window_results', windowResultsMap)

  // Rebuild recent_results: newest-first, last 24
  const sorted = allResults
    .filter(r => r['end_ts'])
    .sort((a, b) => Number(b['end_ts'] ?? 0) - Number(a['end_ts'] ?? 0))
    .slice(0, 24)
  patch('recent_results', sorted)

  // Engine_013: hindsight capture for newly resolved windows. Snapshot the
  // high-resolution tick series so a past window replays every twist it had.
  try {
    const { put: putHindsight, has: hasHindsight } = await import('../io/hindsight.js')
    const { fineWindowCandles } = await import('./chart.js')
    const asset = state.chart_asset ?? 'BTC'
    const interval = state.interval ?? '5m'
    const intervalSecs = interval === '15m' ? 900 : 300

    for (const r of allResults) {
      const endTs = Number(r['end_ts'] ?? 0)
      const winner = r['winner'] as string | undefined
      if (!endTs || !winner) continue
      const startTs = endTs - intervalSecs
      if (!hasHindsight(asset, interval, startTs)) {
        putHindsight(asset, interval, startTs, {
          outcome: winner === 'YES' ? 'UP' : 'DOWN',
          candles: fineWindowCandles(asset, startTs, endTs),
        })
      }
    }
  } catch {
    // hindsight not available — skip
  }

  // Engine_013: paper position settlement
  if (state.practice) {
    await _settlePaperPositions(slotResults)
  }
}

async function _settlePaperPositions(slotResults: Record<string, string>): Promise<void> {
  // Settle through the paper ledger (credits $1/share won, $0 lost, records W/L),
  // then refresh positions + balance so the resolved holding clears from the UI.
  const banking = await import('../banking/index.js')
  const results = await banking.settlePaperPositions(slotResults)
  if (results.length > 0) {
    // Float a win/loss toast per settled position — "made profit" feedback.
    for (const r of results) {
      if (r.won) {
        notify(`${r.side} won — +$${Math.abs(r.pnl).toFixed(2)} profit`, 'log')
      } else {
        notify(`${r.side} lost — -$${Math.abs(r.pnl).toFixed(2)}`, 'warn')
      }
    }
    const { runRefreshPositions } = await import('./positions.js')
    const { runRefreshBalance } = await import('./trading.js')
    await Promise.all([runRefreshPositions(), runRefreshBalance()])
  }
}

// ── Engine_003: refresh_slot_results ─────────────────────────────────────────

export async function runRefreshSlotResults(): Promise<void> {
  const windows = state.windows ?? []
  if (!windows.length) return

  const w = windows[0] as Record<string, unknown>
  const slug = String(w['slug'] ?? '')
  if (!slug) return

  const interval = String(w['interval'] ?? '5m')
  const intervalSecs = interval === '15m' ? 900 : 300

  try {
    // fetchWindowHistory reconstructs per-window slugs (fetchRecentResults on the
    // base slug returns nothing); winner is already "UP" | "DOWN" | "?".
    const results = await _callPm<Record<string, unknown>[]>(
      'fetchWindowHistory', slug, intervalSecs / 60, 12)
    if (!results) return

    const map: Record<string, string> = { ...(state.slot_results ?? {}) }
    const recent: Record<string, unknown>[] = []

    for (const r of results) {
      const endTs = Number(r['end_ts'] ?? 0)
      const winner = r['winner'] as string | undefined
      if (endTs && (winner === 'UP' || winner === 'DOWN')) {
        const startTs = endTs - intervalSecs
        map[String(startTs)] = winner
        recent.push(r)
      }
    }

    patch('slot_results', map)

    // Rebuild recent_results newest-first, last 24
    const sorted = recent
      .sort((a, b) => Number(b['end_ts'] ?? 0) - Number(a['end_ts'] ?? 0))
      .slice(0, 24)
    patch('recent_results', sorted)
  } catch {
    // ignore
  }
}
