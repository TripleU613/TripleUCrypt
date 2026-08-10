import { bus } from '../bus.js'
import type { ActivityEntry } from './activity.js'

export interface AppState {
  // ── Performance ──────────────────────────────────────────────────────────
  ui_quality: string
  reported_fps: number

  // ── System resources (live host metrics) ───────────────────────────────────
  sys_cpu_cores: number   // logical core count
  sys_cpu_pct: number     // CPU load %
  sys_mem_pct: number     // RAM used %
  sys_disk_io: number     // disk read+write throughput, bytes/sec
  sys_net_down: number    // network rx, bytes/sec
  sys_net_up: number      // network tx, bytes/sec
  sys_gpu_pct: number     // GPU utilization % (-1 = no GPU)
  sys_cpu_temp: number    // CPU package temp °C (0 = unknown)
  sys_mem_total_gb: number // total RAM in GB (for the rig score)
  sys_cpu_ghz: number     // current CPU clock, GHz (0 = unknown)
  sys_ping_ms: number     // internet round-trip latency, ms (-1 = unknown)
  sys_disk_free_pct: number // free space on the main disk, % (-1 = unknown)
  sys_uptime_sec: number  // host/process uptime, seconds

  // ── Market Data ────────────────────────────────────────────────────────────
  btc_price: number
  btc_change: number
  eth_price: number
  sol_price: number
  xrp_price: number
  doge_price: number
  hype_price: number
  bnb_price: number

  // ── Windows ───────────────────────────────────────────────────────────────
  windows: Record<string, unknown>[]
  active_window: number
  up_ask: number
  dn_ask: number
  combined: number
  secs_left: number
  active_end_ts: number
  up_token: string
  dn_token: string
  token_asks: Record<string, number>
  token_bids: Record<string, number>
  rollover_rev: number
  window_open_price: number
  window_opens: Record<string, number>
  chart_asset: string
  nav_slots_expanded: boolean
  slot_offset: number
  viewing_slot: string
  viewing_future: boolean
  viewed_outcome: string
  viewed_open_str: string
  viewed_settle_str: string
  viewed_delta_str: string
  hist_prob: Record<string, unknown>[]
  viewed_condition_id: string
  viewed_series_id: string
  effective_condition_id: string
  effective_series_id: string
  clock_tick: number
  feed_degraded: boolean
  slot_results: Record<string, string>

  // ── Chart ─────────────────────────────────────────────────────────────────
  interval: string
  mode: string
  theme: string
  chart_rev: number
  window_candles_1m: unknown[][]
  strike_price: number
  cl_price: number
  chart_target: number
  window_time_label: string

  // ── Trading ───────────────────────────────────────────────────────────────
  trade_size: string
  wallet_balance: number
  trading_configured: boolean
  orders: Record<string, unknown>[]
  status: string
  status_ok: boolean
  loading: boolean
  status_seq: number
  practice: boolean
  wallet_address: string
  wallet_native_usdc: number
  wallet_usdc_e: number
  wallet_total: number
  portfolio_value: number
  portfolio_unrealized: number
  portfolio_realized: number
  stat_cash: number
  stat_spendable: number
  stat_wallet: number
  stat_has_wallet: boolean
  stat_profit: number
  stat_accuracy: number
  stat_wins: number
  stat_losses: number
  stat_out: number
  stats_fresh: boolean
  buy_side: string
  buy_mode: string
  limit_price: string
  win_for_size: { size_str: string; size_val: string }[]

  // ── Positions ────────────────────────────────────────────────────────────
  panel_tab: string
  positions: Record<string, unknown>[]
  pos_loading: boolean
  sell_size: string

  // ── Social ────────────────────────────────────────────────────────────────
  market_tab: string
  mkt_trades: Record<string, unknown>[]
  mkt_up_holders: Record<string, unknown>[]
  mkt_dn_holders: Record<string, unknown>[]
  mkt_comments: Record<string, unknown>[]
  mkt_up_pos: Record<string, unknown>[]
  mkt_dn_pos: Record<string, unknown>[]
  social_loaded_cid: string
  social_full_cid: string
  feed_limit: number
  feed_loading_more: boolean
  pos_lb_loading: boolean
  pos_lb_limit: number
  recent_results: Record<string, unknown>[]
  history_expanded: boolean
  window_results: Record<string, string[]>
  /** Cross-market activity log, newest first, capped (see engine/activity.ts). */
  activity: ActivityEntry[]

  // ── Wallet Panel ──────────────────────────────────────────────────────────
  show_wallet: boolean
  deposit_addr: string
  deposit_chain: string
  wallet_history: Record<string, unknown>[]
  wallet_loading: boolean
  wallet_error: string
  wallet_history_error: string
  local_wallet_addr: string
  has_local_wallet: boolean
  server_proxy: string       // Polymarket proxy (maker) for the SERVER wallet
  wallet_setup_busy: boolean
  wallet_approve_busy: boolean
  wallet_approve_status: string
  live_armed: boolean
  approve_ready: boolean
  presets: number[]
  last_wallet: string
  swap_from: string
  swap_to: string
  swap_amount: string
  swap_busy: boolean
  swap_status: string
  gas_busy: boolean
  gas_status: string
  sign_mode: string
  mm_address: string
  mm_status: string
  send_to: string
  send_amount: string
  send_currency: string
  send_confirming: boolean
  send_busy: boolean
  send_status: string
  send_ok: boolean

  // ── Order Book ────────────────────────────────────────────────────────────
  show_orderbook: boolean
  ob_side: string
  ob_up_levels: Record<string, unknown>[]
  ob_dn_levels: Record<string, unknown>[]
  ob_last_up: string
  ob_last_dn: string
  ob_spread_up: string
  ob_spread_dn: string
  ob_loading: boolean
}

export const state: AppState = {} as AppState

export function patch<K extends keyof AppState>(key: K, value: AppState[K]): void {
  if (state[key] === value) return
  state[key] = value
  bus.emit('patch', key, value)
}

// ── Delta patches ─────────────────────────────────────────────────────────────
//
// patch() ships the WHOLE value and only dedupes on `===`, so a freshly built
// collection never matches and the entire thing goes out. Measured on the real
// stream, three keys were 93.6% of all bytes: token_asks/token_bids re-sent all 64
// entries (~5.3 kB) whenever a single token moved 0.05c, and mkt_trades/activity
// re-sent the whole capped list to add one row.
//
// These two helpers keep the FULL value in `state` (so the connect snapshot stays
// authoritative and complete) while putting only the delta on the wire. A dropped
// delta self-heals: every (re)connect replays a full snapshot.

/**
 * Map-valued key: store `next` whole, broadcast only entries that changed plus the
 * keys that disappeared. Call sites keep passing a complete map.
 */
export function patchMap<K extends keyof AppState>(key: K, next: Record<string, number>): void {
  const prev = (state[key] ?? {}) as Record<string, number>
  const set: Record<string, number> = {}
  let changed = 0
  for (const k in next) {
    if (prev[k] !== next[k]) { set[k] = next[k]; changed++ }
  }
  const del: string[] = []
  for (const k in prev) {
    if (!(k in next)) del.push(k)
  }
  state[key] = next as AppState[K]
  if (changed === 0 && del.length === 0) return
  bus.emit('merge', key, set, del)
}

/**
 * Capped newest-first list: prepend `items`, broadcast only the new rows. The cap
 * travels with the delta so the client trims identically to the server.
 */
export function patchPrepend<K extends keyof AppState>(
  key: K, items: readonly unknown[], cap: number,
): void {
  if (items.length === 0) return
  const prev = (state[key] ?? []) as unknown[]
  state[key] = [...items, ...prev].slice(0, cap) as AppState[K]
  bus.emit('prepend', key, items, cap)
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
