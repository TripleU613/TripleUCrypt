import { create } from 'zustand'

/** One row of the cross-market activity log. Mirrors ActivityEntry in
 *  src/engine/activity.ts — the server ships it pre-formatted (`t` is already
 *  "HH:MM:SS" UTC, `text` is already the rendered sentence). */
export interface ActivityEntry {
  id: number
  t: string
  kind: 'price' | 'trade' | 'chat'
  text: string
  /** Only present on kind === 'trade': true = Up, false = Down. */
  up?: boolean
}

// AppState mirrors src/engine/state.ts AppState interface
export interface AppState {
  // Performance
  ui_quality: string
  reported_fps: number

  // System resources
  sys_cpu_cores: number
  sys_cpu_pct: number
  sys_mem_pct: number
  sys_disk_io: number
  sys_net_down: number
  sys_net_up: number
  sys_gpu_pct: number
  sys_cpu_temp: number
  sys_mem_total_gb: number
  sys_cpu_ghz: number
  sys_ping_ms: number
  sys_disk_free_pct: number
  sys_uptime_sec: number

  // Market Data
  btc_price: number
  btc_change: number
  eth_price: number
  sol_price: number
  xrp_price: number
  doge_price: number
  hype_price: number
  bnb_price: number

  // Windows
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
  hist_prob: Record<string, unknown>[]
  viewed_condition_id: string
  viewed_series_id: string
  effective_condition_id: string
  effective_series_id: string
  clock_tick: number
  feed_degraded: boolean
  slot_results: Record<string, string>

  // Chart
  interval: string
  mode: string
  theme: string
  chart_rev: number
  window_candles_1m: unknown[][]
  strike_price: number
  cl_price: number
  chart_target: number
  window_time_label: string

  // Trading
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

  // Positions
  panel_tab: string
  positions: Record<string, unknown>[]
  pos_loading: boolean
  sell_size: string

  // Social
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
  /** Cross-market activity log, newest first, capped server-side. */
  activity: ActivityEntry[]

  // Wallet Panel
  show_wallet: boolean
  deposit_addr: string
  deposit_chain: string
  wallet_history: Record<string, unknown>[]
  wallet_loading: boolean
  wallet_error: string
  wallet_history_error: string
  local_wallet_addr: string
  has_local_wallet: boolean
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
  // Live on-chain balances of the connected browser wallet (Polygon), read
  // client-side directly from the injected provider. Client-only (not from SSE).
  mm_usdc: number
  mm_usdce: number
  mm_pol: number
  mm_bal_loading: boolean
  send_to: string
  send_amount: string
  send_currency: string
  send_confirming: boolean
  send_busy: boolean
  send_status: string
  send_ok: boolean

  // Order Book
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

// ── Toast notifications (ephemeral, client-owned) ────────────────────────────

export type ToastLevel = 'log' | 'warn' | 'error'
export interface Toast {
  id: number
  level: ToastLevel
  text: string
}

// ── Store type: AppState + client metadata + patcher ─────────────────────────

export type Store = AppState & {
  _connected: boolean
  _markets_ready: boolean
  _patch: (update: Partial<AppState & { _connected: boolean; _markets_ready: boolean }>) => void
  _toasts: Toast[]
  _pushToast: (t: { id?: number; level: ToastLevel; text: string }) => void
  _dismissToast: (id: number) => void
}

// Monotonic id source for client-originated toasts (server toasts carry their own).
let _localToastId = -1

// ── Default state — every field has a safe zero value ────────────────────────

export const useStore = create<Store>((set) => ({
  // client meta
  _connected: false,
  _markets_ready: false,
  _patch: (update) => set(update as Partial<Store>),

  // toasts
  _toasts: [],
  _pushToast: (t) =>
    set((s) => {
      const id = t.id ?? _localToastId--
      // Collapse a duplicate of the same text that's still showing, then cap
      // the stack so a burst of events can't flood the screen.
      const next = [...s._toasts.filter((x) => x.text !== t.text), { id, level: t.level, text: t.text }]
      return { _toasts: next.slice(-4) }
    }),
  _dismissToast: (id) =>
    set((s) => ({ _toasts: s._toasts.filter((t) => t.id !== id) })),

  // Performance
  ui_quality: 'smooth',
  reported_fps: 0,

  // System resources
  sys_cpu_cores: 0,
  sys_cpu_pct: 0,
  sys_mem_pct: 0,
  sys_disk_io: 0,
  sys_net_down: 0,
  sys_net_up: 0,
  sys_gpu_pct: -1,
  sys_cpu_temp: 0,
  sys_mem_total_gb: 0,
  sys_cpu_ghz: 0,
  sys_ping_ms: -1,
  sys_disk_free_pct: -1,
  sys_uptime_sec: 0,

  // Market Data
  btc_price: 0,
  btc_change: 0,
  eth_price: 0,
  sol_price: 0,
  xrp_price: 0,
  doge_price: 0,
  hype_price: 0,
  bnb_price: 0,

  // Windows
  windows: [],
  active_window: 0,
  up_ask: 0,
  dn_ask: 0,
  combined: 0,
  secs_left: 0,
  active_end_ts: 0,
  up_token: '',
  dn_token: '',
  token_asks: {},
  token_bids: {},
  rollover_rev: 0,
  window_open_price: 0,
  window_opens: {},
  chart_asset: 'BTC',
  nav_slots_expanded: false,
  slot_offset: 0,
  viewing_slot: '',
  viewing_future: false,
  viewed_outcome: '',
  hist_prob: [],
  viewed_condition_id: '',
  viewed_series_id: '',
  effective_condition_id: '',
  effective_series_id: '',
  clock_tick: 0,
  feed_degraded: false,
  slot_results: {},

  // Chart
  interval: '5m',
  mode: 'price',
  theme: 'dark',
  chart_rev: 0,
  window_candles_1m: [],
  strike_price: 0,
  cl_price: 0,
  chart_target: 0,
  window_time_label: '',

  // Trading
  trade_size: '5',
  wallet_balance: 0,
  trading_configured: false,
  orders: [],
  status: '',
  status_ok: true,
  loading: false,
  status_seq: 0,
  practice: true,
  wallet_address: '',
  wallet_native_usdc: 0,
  wallet_usdc_e: 0,
  wallet_total: 0,
  portfolio_value: 0,
  portfolio_unrealized: 0,
  portfolio_realized: 0,
  stat_cash: 0,
  stat_spendable: 0,
  stat_wallet: 0,
  stat_has_wallet: false,
  stat_profit: 0,
  stat_accuracy: 0,
  stat_wins: 0,
  stat_losses: 0,
  stat_out: 0,
  stats_fresh: false,
  buy_side: 'UP',
  buy_mode: '1tap',
  limit_price: '',
  win_for_size: [
    { size_str: '$5', size_val: '5' },
    { size_str: '$25', size_val: '25' },
    { size_str: '$100', size_val: '100' },
  ],

  // Positions
  panel_tab: 'positions',
  positions: [],
  pos_loading: false,
  sell_size: '',

  // Social
  market_tab: 'trades',
  mkt_trades: [],
  mkt_up_holders: [],
  mkt_dn_holders: [],
  mkt_comments: [],
  mkt_up_pos: [],
  mkt_dn_pos: [],
  social_loaded_cid: '',
  social_full_cid: '',
  feed_limit: 20,
  feed_loading_more: false,
  pos_lb_loading: false,
  pos_lb_limit: 20,
  recent_results: [],
  history_expanded: false,
  window_results: {},
  activity: [],

  // Wallet Panel
  show_wallet: false,
  deposit_addr: '',
  deposit_chain: 'polygon',
  wallet_history: [],
  wallet_loading: false,
  wallet_error: '',
  wallet_history_error: '',
  local_wallet_addr: '',
  has_local_wallet: false,
  wallet_setup_busy: false,
  wallet_approve_busy: false,
  wallet_approve_status: '',
  live_armed: false,
  approve_ready: false,
  presets: [5, 10, 25, 50],
  last_wallet: '',
  swap_from: 'USDC',
  swap_to: 'USDC.e',
  swap_amount: '',
  swap_busy: false,
  swap_status: '',
  gas_busy: false,
  gas_status: '',
  sign_mode: 'instant',
  mm_address: '',
  mm_status: '',
  mm_usdc: 0,
  mm_usdce: 0,
  mm_pol: 0,
  mm_bal_loading: false,
  send_to: '',
  send_amount: '',
  send_currency: 'USDC',
  send_confirming: false,
  send_busy: false,
  send_status: '',
  send_ok: false,

  // Order Book
  show_orderbook: false,
  ob_side: 'UP',
  ob_up_levels: [],
  ob_dn_levels: [],
  ob_last_up: '',
  ob_last_dn: '',
  ob_spread_up: '',
  ob_spread_dn: '',
  ob_loading: false,
}))

/**
 * Fire a toast from anywhere on the client (e.g. browser-wallet flows that
 * never touch the server). Server-originated toasts arrive over SSE.
 */
export function toast(text: string, level: ToastLevel = 'log'): void {
  const msg = (text ?? '').trim()
  if (!msg) return
  useStore.getState()._pushToast({ level, text: msg })
}
