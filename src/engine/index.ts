export * from './state.js'
export * from './session.js'
export * as performance from './performance.js'
export * as windows from './windows.js'
export * as chart from './chart.js'
export * as trading from './trading.js'
export * as positions from './positions.js'
export * as social from './social.js'
export * as activity from './activity.js'
export * as wallet from './wallet.js'
export * as marketData from './market-data.js'
export * as orderBook from './order-book.js'

import { state, sleep } from './state.js'
import { initState as perfInit } from './performance.js'
import { initState as windowsInit } from './windows.js'
import { initState as chartInit, loadSettings as chartLoadSettings } from './chart.js'
import { initState as tradingInit } from './trading.js'
import { initState as positionsInit } from './positions.js'
import { initState as socialInit } from './social.js'
import { initState as activityInit, startActivityFeed } from './activity.js'
import { initState as walletInit } from './wallet.js'
import { initState as marketDataInit } from './market-data.js'
import { initState as orderBookInit } from './order-book.js'
import { setQuoteProvider } from '../banking/index.js'
import * as performance from './performance.js'
import * as windows from './windows.js'
import * as chart from './chart.js'
import * as trading from './trading.js'
import * as social from './social.js'
import * as marketData from './market-data.js'
import * as orderBook from './order-book.js'

export function initAllState(): void {
  perfInit(state)
  windowsInit(state)
  chartInit(state)
  tradingInit(state)
  positionsInit(state)
  socialInit(state)
  activityInit(state)
  walletInit(state)
  marketDataInit(state)
  orderBookInit(state)
  _wireBrokerQuotes()
  // Subscribe the activity log to the bus feeds it draws on (Chainlink ticks).
  startActivityFeed()
  // Restore persisted settings (mode, config, prefs) over the defaults set above.
  // Body is synchronous (sync fs read), so state is ready before clients connect.
  void chartLoadSettings()
}

// Feed the paper ledger the live best bid/ask the engine already streams, so
// practice orders fill at real prices. The token's outcome/asset is resolved
// from the active window (up_token/dn_token + chart_asset).
function _wireBrokerQuotes(): void {
  setQuoteProvider((token: string) => {
    const asks = state.token_asks ?? {}
    const bids = state.token_bids ?? {}
    const asset = state.chart_asset ?? '?'
    const outcome = token === state.up_token ? 'UP' : token === state.dn_token ? 'DOWN' : '?'
    return { token, bid: bids[token] ?? 0, ask: asks[token] ?? 0, outcome, asset }
  })
}

// ── Background-task supervision ───────────────────────────────────────────────
// These 10 loops are the app's entire live-data surface (prices, windows,
// candles, order book, social, scoreboard). They used to run in a single
// Promise.all with one top-level .catch — so ONE loop throwing past its own
// internal guard rejected the whole thing and left every feed permanently dead
// while /health still reported healthy. Each loop is now supervised
// independently: a crash is logged, the loop restarts with capped exponential
// backoff, and its state is exposed for /health.
//
// Deliberate scope note: this catches a loop that CRASHES, not one that HANGS
// (an await that never settles still looks alive here). Hang detection would
// need per-iteration tick reporting inside all 10 loop bodies.

export interface TaskHealth {
  name: string
  /** false only after shutdown (abort) — a crashed loop is restarted, not left dead. */
  alive: boolean
  restarts: number
  lastError: string | null
  startedAt: number
  lastRestartAt: number | null
}

const _taskHealth = new Map<string, TaskHealth>()

/**
 * Snapshot of background-loop state for /health.
 *
 * `ok` stays true while at least one loop is alive, ON PURPOSE: /health drives
 * the Docker healthcheck and the deploy gate, and flapping it on a single
 * transient feed crash would restart the whole process — killing in-flight
 * orders — over something that self-heals. `degraded` + `tasks[]` carry the
 * detail for operators/alerting without arming that footgun.
 */
export function backgroundTaskHealth(): {
  ok: boolean
  degraded: boolean
  tasks: TaskHealth[]
} {
  const tasks = [..._taskHealth.values()]
  const anyAlive = tasks.some(t => t.alive)
  const recentlyRestarted = tasks.some(
    t => t.lastRestartAt != null && Date.now() - t.lastRestartAt < 60_000,
  )
  return {
    ok: tasks.length === 0 || anyAlive,
    degraded: tasks.some(t => !t.alive) || recentlyRestarted,
    tasks,
  }
}

async function _supervise(
  name: string,
  run: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const h: TaskHealth = {
    name, alive: true, restarts: 0, lastError: null,
    startedAt: Date.now(), lastRestartAt: null,
  }
  _taskHealth.set(name, h)

  let backoff = 1_000
  while (!signal.aborted) {
    try {
      await run(signal)
      if (signal.aborted) break
      // These loops are meant to run until abort; returning early is a bug.
      h.lastError = 'loop returned unexpectedly'
      console.error(`[bg:${name}] returned unexpectedly — restarting in ${backoff}ms`)
    } catch (e) {
      if (signal.aborted) break
      h.lastError = e instanceof Error ? e.message : String(e)
      console.error(`[bg:${name}] crashed — restarting in ${backoff}ms:`, e)
    }
    h.restarts += 1
    h.lastRestartAt = Date.now()
    await sleep(backoff)
    // Cap the backoff so a permanently-broken loop retries slowly instead of
    // spinning, but still recovers on its own if the cause clears.
    backoff = Math.min(backoff * 2, 30_000)
  }
  h.alive = false
}

export async function runAllBackgroundTasks(signal: AbortSignal): Promise<void> {
  await Promise.all([
    _supervise('power-manager',     performance.runPowerManager,   signal),
    _supervise('stream-polymarket', windows.runStreamPolymarket,   signal),
    _supervise('tick-windows',      windows.runTickWindows,        signal),
    _supervise('load-candles',      chart.runLoadCandles,          signal),
    _supervise('stream-chainlink',  chart.runStreamChainlink,      signal),
    _supervise('stream-social',     social.runStreamSocial,        signal),
    _supervise('poll-results',      social.runPollResults,         signal),
    _supervise('stream-kraken',     marketData.runStreamKraken,    signal),
    _supervise('poll-orderbook',    orderBook.runPollOrderbook,    signal),
    _supervise('refresh-scoreboard', trading.runRefreshScoreboard, signal),
  ])
}
