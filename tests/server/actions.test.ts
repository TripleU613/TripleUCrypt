/**
 * Tests for the action dispatch table.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock all engine modules before importing actions ──────────────────────────

vi.mock('../../src/engine/state.js', () => {
  const state: Record<string, unknown> = {
    nav_slots_expanded: false,
    slot_offset: 0,
    viewing_slot: '',
    buy_mode: '1tap',
    practice: false,
    trade_size: '25',
    stat_spendable: 100,
    limit_price: '97',
    sign_mode: 'instant',
    show_wallet: false,
    show_orderbook: false,
    market_tab: 'activity',
    panel_tab: 'buy',
    sell_size: 'all',
    status_seq: 0,
    status: '',
    status_ok: true,
    windows: [{ slug: 'btc-5m' }],
  }
  return {
    state,
    patch: vi.fn((key: string, value: unknown) => { state[key] = value }),
    sleep: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('../../src/engine/chart.js', () => ({
  setChartInterval: vi.fn(),
  setMode: vi.fn(),
  toggleTheme: vi.fn(),
  saveSettings: vi.fn(),
  restoreSession: vi.fn(),
  runLoadCandles: vi.fn(() => Promise.resolve()),
  runStreamChainlink: vi.fn(() => Promise.resolve()),
  initState: vi.fn(),
  getCandles: vi.fn(() => new Map()),
  getClPrices: vi.fn(() => new Map()),
}))

vi.mock('../../src/engine/trading.js', () => ({
  setSize: vi.fn(),
  setMaxSize: vi.fn(),
  setBuySide: vi.fn(),
  setBuyMode: vi.fn(),
  cycleBuyMode: vi.fn(),
  setLimitPrice: vi.fn(),
  togglePractice: vi.fn(),
  clearStatusAfter: vi.fn(),
  runBuy: vi.fn(() => Promise.resolve()),
  runRefreshBalance: vi.fn(() => Promise.resolve()),
  getBroker: vi.fn(() => null),
  initState: vi.fn(),
}))

vi.mock('../../src/engine/positions.js', () => ({
  runRefreshPositions: vi.fn(() => Promise.resolve()),
  runSell: vi.fn(() => Promise.resolve()),
  runClaimWinnings: vi.fn(() => Promise.resolve()),
  initState: vi.fn(),
  computePositionsLive: vi.fn(() => []),
  computeClaimablePositions: vi.fn(() => []),
  computeChartPositionLines: vi.fn(() => []),
  posComputed: vi.fn(() => ({})),
}))

vi.mock('../../src/engine/social.js', () => ({
  setMarketTab: vi.fn(),
  loadMoreFeed: vi.fn(() => Promise.resolve()),
  fetchPositionsLeaderboard: vi.fn(() => Promise.resolve()),
  runStreamSocial: vi.fn(() => Promise.resolve()),
  runPollResults: vi.fn(() => Promise.resolve()),
  runRefreshSlotResults: vi.fn(() => Promise.resolve()),
  initState: vi.fn(),
}))

vi.mock('../../src/engine/wallet.js', () => ({
  toggleWallet: vi.fn(),
  closeWallet: vi.fn(),
  generateWallet: vi.fn(() => Promise.resolve()),
  approveWallet: vi.fn(() => Promise.resolve()),
  setSignMode: vi.fn(),
  toggleSignMode: vi.fn(),
  runRefreshWalletHistory: vi.fn(() => Promise.resolve()),
  initState: vi.fn(),
}))

vi.mock('../../src/engine/order-book.js', () => ({
  toggleOrderbook: vi.fn(),
  setObSide: vi.fn(),
  obClickAsk: vi.fn(),
  obClickBid: vi.fn(),
  pollOrderbookOnce: vi.fn(() => Promise.resolve()),
  runPollOrderbook: vi.fn(() => Promise.resolve()),
  initState: vi.fn(),
  computeObLevels: vi.fn(() => [[], '', '']),
}))

vi.mock('../../src/engine/performance.js', () => ({
  reportFps: vi.fn(),
  initState: vi.fn(),
  runPowerManager: vi.fn(() => Promise.resolve()),
  fastSleep: vi.fn(() => 300),
  tickSleep: vi.fn(() => 700),
  pollSleep: vi.fn(() => 4000),
  obSleep: vi.fn(() => 5000),
  currentTier: vi.fn(() => 1),
  TIER_SETTINGS: new Map(),
}))

vi.mock('../../src/engine/session.js', () => ({
  bumpGeneration: vi.fn(),
  getSignal: vi.fn(() => new AbortController().signal),
  getGeneration: vi.fn(() => 0),
}))

vi.mock('../../src/engine/market-data.js', () => ({
  initState: vi.fn(),
  runStreamKraken: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../src/engine/windows.js', () => ({
  initState: vi.fn(),
  runStreamPolymarket: vi.fn(() => Promise.resolve()),
  runTickWindows: vi.fn(() => Promise.resolve()),
  getPriceBuf: vi.fn(() => new Map()),
  getBookBuf: vi.fn(() => new Map()),
  computeWindowTimeStr: vi.fn(() => '4:30'),
  computeMarketsReady: vi.fn(() => false),
  computeTimeSlots: vi.fn(() => []),
}))

vi.mock('../../src/engine/index.js', () => ({
  initAllState: vi.fn(),
  runAllBackgroundTasks: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../src/bus.js', () => ({
  bus: { on: vi.fn(), emit: vi.fn(), off: vi.fn(), setMaxListeners: vi.fn() },
}))

// ── Now import the module under test ─────────────────────────────────────────

import { actions, dispatch } from '../../src/server/actions.js'
import * as chart from '../../src/engine/chart.js'
import * as trading from '../../src/engine/trading.js'
import * as positions from '../../src/engine/positions.js'
import * as social from '../../src/engine/social.js'
import * as wallet from '../../src/engine/wallet.js'
import * as orderBook from '../../src/engine/order-book.js'
import { reportFps } from '../../src/engine/performance.js'
import { patch } from '../../src/engine/state.js'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('actions dispatch table', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dispatch set_buy_side calls setBuySide with UP', async () => {
    await dispatch('set_buy_side', ['UP'])
    expect(trading.setBuySide).toHaveBeenCalledWith('UP')
  })

  it('dispatch set_buy_side with DOWN', async () => {
    await dispatch('set_buy_side', ['DOWN'])
    expect(trading.setBuySide).toHaveBeenCalledWith('DOWN')
  })

  it('dispatch unknown_action throws', async () => {
    await expect(dispatch('unknown_action', [])).rejects.toThrow('Unknown action: unknown_action')
  })

  it('dispatch set_interval calls setChartInterval', async () => {
    await dispatch('set_interval', ['15m'])
    expect(chart.setChartInterval).toHaveBeenCalledWith('15m')
  })

  it('dispatch toggle_theme calls toggleTheme', async () => {
    await dispatch('toggle_theme', [])
    expect(chart.toggleTheme).toHaveBeenCalled()
  })

  it('dispatch set_mode calls setMode', async () => {
    await dispatch('set_mode', ['candle'])
    expect(chart.setMode).toHaveBeenCalledWith('candle')
  })

  it('dispatch restore_session calls restoreSession', async () => {
    await dispatch('restore_session', ['ETH', '1h'])
    expect(chart.restoreSession).toHaveBeenCalledWith('ETH', '1h')
  })

  it('dispatch buy calls runBuy', async () => {
    await dispatch('buy', ['UP'])
    expect(trading.runBuy).toHaveBeenCalledWith('UP')
  })

  it('dispatch toggle_practice calls togglePractice', async () => {
    await dispatch('toggle_practice', [])
    expect(trading.togglePractice).toHaveBeenCalled()
  })

  it('dispatch set_size calls setSize', async () => {
    await dispatch('set_size', ['50'])
    expect(trading.setSize).toHaveBeenCalledWith('50')
  })

  it('dispatch set_max calls setMaxSize', async () => {
    await dispatch('set_max', [])
    expect(trading.setMaxSize).toHaveBeenCalled()
  })

  it('dispatch refresh_balance calls runRefreshBalance', async () => {
    await dispatch('refresh_balance', [])
    expect(trading.runRefreshBalance).toHaveBeenCalled()
  })

  it('dispatch set_panel_tab patches panel_tab', async () => {
    await dispatch('set_panel_tab', ['sell'])
    expect(patch).toHaveBeenCalledWith('panel_tab', 'sell')
  })

  it('dispatch refresh_positions calls runRefreshPositions', async () => {
    await dispatch('refresh_positions', [])
    expect(positions.runRefreshPositions).toHaveBeenCalled()
  })

  it('dispatch sell calls runSell', async () => {
    await dispatch('sell', ['0xabc', 10])
    expect(positions.runSell).toHaveBeenCalledWith('0xabc', 10)
  })

  it('dispatch claim_winnings calls runClaimWinnings', async () => {
    await dispatch('claim_winnings', [])
    expect(positions.runClaimWinnings).toHaveBeenCalled()
  })

  it('dispatch set_market_tab calls setMarketTab', async () => {
    await dispatch('set_market_tab', ['holders'])
    expect(social.setMarketTab).toHaveBeenCalledWith('holders')
  })

  it('dispatch load_more_feed calls loadMoreFeed', async () => {
    await dispatch('load_more_feed', [])
    expect(social.loadMoreFeed).toHaveBeenCalled()
  })

  it('dispatch fetch_positions_leaderboard calls fetchPositionsLeaderboard', async () => {
    await dispatch('fetch_positions_leaderboard', [])
    expect(social.fetchPositionsLeaderboard).toHaveBeenCalled()
  })

  it('dispatch toggle_wallet calls toggleWallet', async () => {
    await dispatch('toggle_wallet', [])
    expect(wallet.toggleWallet).toHaveBeenCalled()
  })

  it('dispatch close_wallet calls closeWallet', async () => {
    await dispatch('close_wallet', [])
    expect(wallet.closeWallet).toHaveBeenCalled()
  })

  it('dispatch generate_wallet calls generateWallet', async () => {
    await dispatch('generate_wallet', [])
    expect(wallet.generateWallet).toHaveBeenCalled()
  })

  it('dispatch approve_wallet calls approveWallet', async () => {
    await dispatch('approve_wallet', [])
    expect(wallet.approveWallet).toHaveBeenCalled()
  })

  it('dispatch set_sign_mode calls setSignMode', async () => {
    await dispatch('set_sign_mode', ['safe'])
    expect(wallet.setSignMode).toHaveBeenCalledWith('safe')
  })

  it('dispatch toggle_sign_mode calls toggleSignMode', async () => {
    await dispatch('toggle_sign_mode', [])
    expect(wallet.toggleSignMode).toHaveBeenCalled()
  })

  it('dispatch refresh_wallet_history calls runRefreshWalletHistory', async () => {
    await dispatch('refresh_wallet_history', [])
    expect(wallet.runRefreshWalletHistory).toHaveBeenCalled()
  })

  it('dispatch toggle_orderbook calls toggleOrderbook', async () => {
    await dispatch('toggle_orderbook', [])
    expect(orderBook.toggleOrderbook).toHaveBeenCalled()
  })

  it('dispatch set_ob_side calls setObSide', async () => {
    await dispatch('set_ob_side', ['DN'])
    expect(orderBook.setObSide).toHaveBeenCalledWith('DN')
  })

  it('dispatch ob_click_ask calls obClickAsk', async () => {
    await dispatch('ob_click_ask', [95])
    expect(orderBook.obClickAsk).toHaveBeenCalledWith(95)
  })

  it('dispatch ob_click_bid calls obClickBid', async () => {
    await dispatch('ob_click_bid', [93])
    expect(orderBook.obClickBid).toHaveBeenCalledWith(93)
  })

  it('dispatch poll_orderbook_once calls pollOrderbookOnce', async () => {
    await dispatch('poll_orderbook_once', [])
    expect(orderBook.pollOrderbookOnce).toHaveBeenCalled()
  })

  it('dispatch report_fps calls reportFps', async () => {
    await dispatch('report_fps', [55])
    expect(reportFps).toHaveBeenCalledWith(55)
  })

  it('dispatch cycle_buy_mode calls cycleBuyMode', async () => {
    await dispatch('cycle_buy_mode', [])
    expect(trading.cycleBuyMode).toHaveBeenCalled()
  })

  it('dispatch set_limit_price calls setLimitPrice', async () => {
    await dispatch('set_limit_price', ['95'])
    expect(trading.setLimitPrice).toHaveBeenCalledWith('95')
  })

  it('dispatch clear_status_after calls clearStatusAfter', async () => {
    await dispatch('clear_status_after', [5000])
    expect(trading.clearStatusAfter).toHaveBeenCalledWith(5000)
  })

  it('dispatch set_sell_size patches sell_size', async () => {
    await dispatch('set_sell_size', ['50'])
    expect(patch).toHaveBeenCalledWith('sell_size', '50')
  })

  it('all action names cover at least 30 entries', () => {
    const names = Object.keys(actions)
    expect(names.length).toBeGreaterThanOrEqual(30)
  })

  it('action table includes all expected action names', () => {
    const expected = [
      'set_active_window', 'set_chart_asset', 'toggle_nav_slots', 'slots_back',
      'slots_forward', 'slots_live', 'set_viewing_slot', 'load_prob_history',
      'refresh_slot_results', 'begin_session',
      'set_interval', 'set_mode', 'toggle_theme', 'restore_session',
      'load_settings', 'load_candles',
      'set_size', 'set_max', 'set_buy_side', 'set_buy_mode', 'cycle_buy_mode',
      'set_limit_price', 'toggle_practice', 'reset_practice', 'buy',
      'clear_status_after', 'refresh_balance',
      'set_panel_tab', 'set_sell_size', 'refresh_positions', 'sell', 'claim_winnings',
      'set_market_tab', 'load_more_feed', 'fetch_positions_leaderboard',
      'toggle_wallet', 'close_wallet', 'generate_wallet', 'approve_wallet',
      'set_sign_mode', 'toggle_sign_mode', 'refresh_wallet_history',
      'toggle_orderbook', 'set_ob_side', 'ob_click_ask', 'ob_click_bid',
      'poll_orderbook_once',
      'report_fps',
    ]
    for (const name of expected) {
      expect(actions).toHaveProperty(name)
    }
  })
})
