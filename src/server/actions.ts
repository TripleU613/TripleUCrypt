/**
 * Flat dispatch table for all UI event handlers.
 *
 * Keys match the Python state method names (snake_case).
 * Values are async wrappers that receive the args array from POST /action/:name.
 */

import { state, patch } from '../engine/state.js'
import * as chart from '../engine/chart.js'
import * as trading from '../engine/trading.js'
import * as positions from '../engine/positions.js'
import * as social from '../engine/social.js'
import * as wallet from '../engine/wallet.js'
import * as windows from '../engine/windows.js'
import * as orderBook from '../engine/order-book.js'
import { reportFps } from '../engine/performance.js'
import { notify } from '../engine/notify.js'

// ── windows.ts — event handlers ───────────────────────────────────────────────

async function _setActiveWindow(slug: string): Promise<void> {
  const wins = state.windows ?? []
  const idx = wins.findIndex(w => (w['slug'] as string) === slug)
  if (idx < 0) return
  patch('active_window', idx)
  const w = wins[idx] as Record<string, unknown>
  patch('up_ask',        Number(w['up_ask'] ?? 0))
  patch('dn_ask',        Number(w['dn_ask'] ?? 0))
  patch('combined',      Number(w['combined'] ?? 0))
  patch('secs_left',     Number(w['secs_left'] ?? 0))
  patch('active_end_ts', Number(w['end_ts'] ?? 0))
  patch('up_token',      String(w['up_token'] ?? ''))
  patch('dn_token',      String(w['dn_token'] ?? ''))
  patch('strike_price',  Number(w['strike'] ?? 0))
  patch('chart_asset',   String(w['asset'] ?? 'BTC'))
  const newCid = String(w['condition_id'] ?? '')
  const newSid = String(w['series_id'] ?? '')
  patch('viewed_condition_id', newCid)
  patch('viewed_series_id',    newSid)
  // Engine_016: update effective routing ids
  patch('effective_condition_id', windows.computeEffectiveCid(state.viewing_slot ?? '', newCid, newCid))
  patch('effective_series_id',    windows.computeEffectiveSid(state.viewing_slot ?? '', newSid, newSid))
  // Repoint open price for the newly selected window
  const openKey = `${String(w['slug'] ?? '')}@${Number(w['event_start_ts'] ?? 0)}`
  const op = (state.window_opens ?? {})[openKey] ?? 0
  if (op > 0) patch('window_open_price', op)
  // Clear stale candles and social so they reload for the new window
  patch('window_candles_1m', [])
  patch('mkt_trades', [])
  patch('mkt_up_holders', [])
  patch('mkt_dn_holders', [])
  patch('mkt_comments', [])
  patch('mkt_up_pos', [])
  patch('mkt_dn_pos', [])
  // Engine_018: chain refresh_slot_results + load_candles for the new window
  await Promise.all([_refreshSlotResults(), _loadCandles()])
}

function _setChartAsset(asset: string): void {
  patch('chart_asset', asset)
  // Surface the new asset's candles immediately (cached → instant, then fresh).
  void chart.refreshActiveCandles()
}

function _toggleNavSlots(): void {
  patch('nav_slots_expanded', !state.nav_slots_expanded)
}

function _slotsBack(): void {
  patch('slot_offset', (state.slot_offset ?? 0) - 1)
  _snapChartIfOffscreen()
}

function _slotsForward(): void {
  patch('slot_offset', (state.slot_offset ?? 0) + 1)
  _snapChartIfOffscreen()
}

// Engine_006: complete slots_live — clear ALL time-travel state
function _slotsLive(): void {
  patch('slot_offset', 0)
  patch('viewing_slot', '')
  patch('viewing_future', false)
  patch('viewed_outcome', '')
  patch('window_candles_1m', [])
  patch('hist_prob', [])
  // Restore social feeds to the live active window's ids
  const active = (state.windows ?? [])[0] as Record<string, unknown> | undefined
  const liveCid = active ? String(active['condition_id'] ?? '') : ''
  const liveSid = active ? String(active['series_id'] ?? '') : ''
  patch('viewed_condition_id', liveCid)
  patch('viewed_series_id', liveSid)
  patch('effective_condition_id', liveCid)
  patch('effective_series_id', liveSid)
  patch('chart_rev', (state.chart_rev ?? 0) + 1)
}

// Engine_007: snap chart back to live if current viewing_slot scrolled off-screen
function _snapChartIfOffscreen(): void {
  if (!state.viewing_slot) return
  const wins = state.windows ?? []
  if (!wins.length) return

  const active = wins[0] as Record<string, unknown>
  const endTs = Number(active['end_ts'] ?? 0)
  const interval = String(active['interval'] ?? '5m')
  const intervalSecs = interval === '15m' ? 900 : 300
  const slotOffset = state.slot_offset ?? 0

  const visibleTs = new Set<string>()
  for (let i = -2; i <= 2; i++) {
    const slotEndTs = endTs + (i + slotOffset) * intervalSecs
    const slotStartTs = slotEndTs - intervalSecs
    visibleTs.add(String(slotStartTs))
  }

  if (!visibleTs.has(state.viewing_slot)) {
    patch('viewing_slot', '')
    patch('viewing_future', false)
    patch('viewed_outcome', '')
    patch('window_candles_1m', [])
    patch('hist_prob', [])
    patch('chart_rev', (state.chart_rev ?? 0) + 1)
  }
}

// Engine_005: full set_viewing_slot with future/past handling and candle/prob chain
async function _setViewingSlot(slotTs: number): Promise<void> {
  const wins = state.windows ?? []

  // Clicking the current live window slot clears time-travel
  if (slotTs === 0) {
    _slotsLive()
    return
  }

  // If already viewing this slot, toggle off back to live
  if (state.viewing_slot === String(slotTs)) {
    _slotsLive()
    return
  }

  await windows.runSetViewingSlot(slotTs)
}

async function _loadProbHistory(slotTs: number): Promise<void> {
  await windows.runLoadProbHistory(slotTs)
}

async function _refreshSlotResults(): Promise<void> {
  await social.runRefreshSlotResults()
}

function _beginSession(): void {
  // begin_session is handled at SSE connect time via bumpGeneration()
  // This no-op keeps the action registered for explicit calls too
}

async function _loadCandles(): Promise<void> {
  // Candle load is handled by the background runLoadCandles task.
  // Re-publish current cached candles for the active asset/interval.
  const { getCandles } = await import('../engine/chart.js')
  const asset = (state.chart_asset ?? 'BTC').toUpperCase()
  const interval = state.interval ?? '5m'
  const cached = getCandles().get(asset)?.[interval]
  if (cached && cached.length > 0) {
    patch('window_candles_1m', cached as unknown[][])
    patch('chart_rev', (state.chart_rev ?? 0) + 1)
  }
}

async function _resetPractice(): Promise<void> {
  patch('practice', true)
  patch('sign_mode', 'instant')
  // Reset the underlying virtual ledger (cash, positions, W/L) first…
  const banking = await import('../banking/index.js')
  await banking.resetPaper()
  // …then mirror the cleared state to the UI.
  patch('stat_cash', 100)
  patch('stat_spendable', 100)
  patch('wallet_balance', 100)
  patch('stat_profit', 0)
  patch('stat_wins', 0)
  patch('stat_losses', 0)
  patch('stat_accuracy', 0)
  patch('positions', [])
  notify('Practice balance refilled to $100', 'log')
}

async function _refreshBalance(): Promise<void> {
  await trading.runRefreshBalance()
}

async function _refreshPositions(): Promise<void> {
  await positions.runRefreshPositions()
}

async function _sell(tokenId: string, amount: number): Promise<void> {
  await positions.runSell(tokenId, amount)
}

async function _claimWinnings(): Promise<void> {
  const claimed = await positions.runClaimWinnings()
  // runClaimWinnings toasts the success case itself; cover the rest here so the
  // button always reports what happened.
  if (claimed === 0) notify('No winnings to claim', 'log')
  else if (claimed < 0) notify('Trading not configured', 'warn')
}

async function _refreshWalletHistory(): Promise<void> {
  await wallet.runRefreshWalletHistory()
}

// ── Dispatch table ─────────────────────────────────────────────────────────────

export const actions: Record<string, (args: unknown[]) => Promise<void>> = {
  // ── windows ────────────────────────────────────────────────────────────────
  set_active_window: async ([slug]: unknown[]) => {
    await _setActiveWindow(String(slug ?? ''))
  },
  set_chart_asset: async ([asset]: unknown[]) => {
    _setChartAsset(String(asset ?? 'BTC'))
  },
  toggle_nav_slots: async () => {
    _toggleNavSlots()
  },
  slots_back: async () => {
    _slotsBack()
  },
  slots_forward: async () => {
    _slotsForward()
  },
  slots_live: async () => {
    _slotsLive()
  },
  set_viewing_slot: async ([slotTs]: unknown[]) => {
    await _setViewingSlot(Number(slotTs ?? 0))
  },
  load_prob_history: async ([slotTs]: unknown[]) => {
    await _loadProbHistory(Number(slotTs ?? 0))
  },
  refresh_slot_results: async () => {
    await _refreshSlotResults()
  },
  begin_session: async () => {
    _beginSession()
  },

  // ── chart ──────────────────────────────────────────────────────────────────
  set_interval: async ([iv]: unknown[]) => {
    await chart.setChartInterval(String(iv ?? '5m'))
    // Engine_002: chain refresh_slot_results + load_candles after interval switch
    await Promise.all([_refreshSlotResults(), _loadCandles()])
  },
  set_mode: async ([mode]: unknown[]) => {
    chart.setMode(String(mode ?? 'line'))
  },
  toggle_theme: async () => {
    chart.toggleTheme()
    // Engine_001: persist settings after theme change
    chart.saveSettings()
  },
  restore_session: async ([asset, iv]: unknown[]) => {
    chart.restoreSession(String(asset ?? 'BTC'), String(iv ?? '5m'))
  },
  load_settings: async () => {
    // Engine_001: load settings from disk and patch state
    await chart.loadSettings()
  },
  save_settings: async () => {
    // Engine_001: explicit save_settings action
    chart.saveSettings()
  },
  load_candles: async () => {
    await _loadCandles()
  },

  // ── trading ────────────────────────────────────────────────────────────────
  set_size: async ([size]: unknown[]) => {
    trading.setSize(String(size ?? ''))
    chart.saveSettings()
  },
  set_max: async () => {
    trading.setMaxSize()
  },
  set_buy_side: async ([side]: unknown[]) => {
    trading.setBuySide(String(side ?? 'UP'))
    chart.saveSettings()
  },
  // 1-tap preset amounts — persisted in settings.json.
  set_presets: async ([arr]: unknown[]) => {
    const a = Array.isArray(arr) ? arr.map(Number).filter(n => n > 0) : []
    if (a.length) { patch('presets', a); chart.saveSettings() }
  },
  set_buy_mode: async ([mode]: unknown[]) => {
    trading.setBuyMode(String(mode ?? '1tap'))
  },
  cycle_buy_mode: async () => {
    trading.cycleBuyMode()
    chart.saveSettings()
  },
  set_limit_price: async ([price]: unknown[]) => {
    trading.setLimitPrice(String(price ?? '97'))
    chart.saveSettings()
  },
  toggle_practice: async () => {
    trading.togglePractice()
    chart.saveSettings()
  },
  reset_practice: async () => {
    await _resetPractice()
  },
  buy: async ([direction]: unknown[]) => {
    await trading.runBuy(String(direction ?? 'UP'))
  },
  // Engine_009: buy_preset — set size then immediately buy (1-Tap flow)
  buy_preset: async ([direction, size]: unknown[]) => {
    await trading.runBuyPreset(String(direction ?? 'UP'), String(size ?? '25'))
  },
  clear_status_after: async ([ms]: unknown[]) => {
    trading.clearStatusAfter(Number(ms ?? 3000))
  },
  refresh_balance: async () => {
    await _refreshBalance()
  },

  // ── positions ──────────────────────────────────────────────────────────────
  set_panel_tab: async ([tab]: unknown[]) => {
    patch('panel_tab', String(tab ?? 'buy'))
  },
  set_sell_size: async ([size]: unknown[]) => {
    patch('sell_size', String(size ?? 'all'))
  },
  refresh_positions: async () => {
    await _refreshPositions()
  },
  sell: async ([tokenId, amount]: unknown[]) => {
    const amt = amount === undefined || amount === 'all'
      ? -1
      : Number(amount)
    await _sell(String(tokenId ?? ''), amt)
  },
  claim_winnings: async () => {
    await _claimWinnings()
  },

  // ── social ─────────────────────────────────────────────────────────────────
  set_market_tab: async ([tab]: unknown[]) => {
    social.setMarketTab(String(tab ?? 'activity'))
  },
  load_more_feed: async () => {
    await social.loadMoreFeed()
  },
  fetch_positions_leaderboard: async () => {
    await social.fetchPositionsLeaderboard()
  },
  // Engine_010: toggle_history — expands/collapses the results history strip
  toggle_history: async () => {
    social.toggleHistory()
  },

  // ── wallet ─────────────────────────────────────────────────────────────────
  toggle_wallet: async () => {
    wallet.toggleWallet()
  },
  close_wallet: async () => {
    wallet.closeWallet()
  },
  generate_wallet: async () => {
    await wallet.generateWallet()
  },
  approve_wallet: async () => {
    await wallet.approveWallet()
  },
  // Unlock real-money on-chain ops for this process (after a UI confirm dialog).
  arm_live_ops: async () => {
    wallet.armLiveOps()
  },
  // One-time exchange approvals so trades are instant (idempotent).
  ensure_ready: async () => {
    await wallet.approveWallet()
  },
  // READ-ONLY: re-check whether the trading wallet's approvals are set.
  refresh_approve_status: async () => {
    await wallet.refreshApproveStatus()
  },
  // Swap tokens (native USDC / USDC.e / POL) on-chain via 0x.
  set_swap_from: async ([t]: unknown[]) => { wallet.setSwapFrom(String(t ?? 'USDC')); chart.saveSettings() },
  set_swap_to: async ([t]: unknown[]) => { wallet.setSwapTo(String(t ?? 'USDC.e')); chart.saveSettings() },
  set_swap_amount: async ([v]: unknown[]) => { wallet.setSwapAmount(String(v ?? '')) },
  swap: async () => {
    await wallet.runSwap()
    await Promise.all([_refreshBalance(), _refreshWalletHistory()])
  },
  // Auto-gas: top the trading wallet up with POL.
  get_gas: async () => {
    await wallet.runGetGas()
    await _refreshBalance()
  },
  set_sign_mode: async ([mode]: unknown[]) => {
    wallet.setSignMode(String(mode ?? 'instant'))
    chart.saveSettings()
  },
  toggle_sign_mode: async () => {
    wallet.toggleSignMode()
  },
  refresh_wallet_history: async () => {
    await _refreshWalletHistory()
  },
  // Refresh everything the wallet shows + auto-claim any resolved winnings
  // (runClaimWinnings self-guards: it's a no-op when nothing is claimable).
  refresh_wallet: async () => {
    await Promise.all([_refreshBalance(), _refreshPositions(), _refreshWalletHistory()])
    await _claimWinnings()
  },
  set_send_amount: async ([v]: unknown[]) => {
    patch('send_amount', String(v ?? ''))
    patch('send_status', '')
  },
  set_send_to: async ([v]: unknown[]) => {
    patch('send_to', String(v ?? ''))
    patch('send_status', '')
  },
  set_send_currency: async ([currency]: unknown[]) => {
    wallet.setSendCurrency(String(currency ?? 'USDC'))
    chart.saveSettings()
  },
  set_send_max: async () => {
    wallet.setSendMax()
  },
  send_now: async () => {
    await wallet.sendNow()
  },
  // Engine_011: review_send / confirm_send / cancel_send
  review_send: async () => {
    wallet.reviewSend()
  },
  confirm_send: async () => {
    await wallet.confirmSend()
  },
  cancel_send: async () => {
    patch('send_confirming', false)
    patch('send_status', '')
  },
  // Engine_012: MetaMask connect result + disconnect
  on_mm_connect: async ([address, chainId, silent]: unknown[]) => {
    wallet.onMmConnect(String(address ?? ''), String(chainId ?? ''), silent === true)
    patch('last_wallet', String(address ?? '')) // remember for next session (hint only)
    chart.saveSettings()
  },
  disconnect_metamask: async () => {
    wallet.disconnectMetamask()
  },

  // ── order-book ─────────────────────────────────────────────────────────────
  toggle_orderbook: async () => {
    orderBook.toggleOrderbook()
  },
  set_ob_side: async ([side]: unknown[]) => {
    orderBook.setObSide(String(side ?? 'UP'))
  },
  ob_click_ask: async ([price]: unknown[]) => {
    orderBook.obClickAsk(Number(price ?? 0))
  },
  ob_click_bid: async ([price]: unknown[]) => {
    orderBook.obClickBid(Number(price ?? 0))
  },
  poll_orderbook_once: async () => {
    await orderBook.pollOrderbookOnce()
  },

  // ── performance ────────────────────────────────────────────────────────────
  report_fps: async ([fps]: unknown[]) => {
    reportFps(Number(fps ?? 60))
    patch('reported_fps', Number(fps ?? 60))
  },
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export async function dispatch(name: string, args: unknown[]): Promise<void> {
  const handler = actions[name]
  if (!handler) {
    throw new Error(`Unknown action: ${name}`)
  }
  await handler(args)
}
