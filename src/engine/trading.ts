import { state, patch, sleep } from './state.js'
import type { AppState } from './state.js'
import type { Stats, Portfolio, Fill } from '../types.js'
import { runRefreshPositions } from './positions.js'
import { getBroker as bankingGetBroker, recordBuyWindow, slippageCapCents } from '../banking/index.js'
import { notify } from './notify.js'
import { recordTrade } from '../io/trade-audit.js'
import { reconcileHolding, describeMismatch } from './reconcile.js'
import { intervalSecs } from '../intervals.js'

// ── Banking import ────────────────────────────────────────────────────────────

type BrokerLike = {
  getStats(): Promise<Stats>
  getPortfolio(): Promise<Portfolio>
  getWalletInfo(): Promise<{address: string; native_usdc: number; usdc_e: number; total: number}>
  buy(direction: string, size: number, tokenId: string, limitPrice?: number, mode?: string): Promise<Fill>
  sell(tokenId: string, amount: number): Promise<Fill>
  claimWinnings(posIds: string[]): Promise<unknown>
  /** Read-only tradeability preflight (approvals). Absent on PaperBroker. */
  checkTradeable?(): Promise<{ ok: boolean; error: string }>
}

export function getBroker(): BrokerLike | null {
  // Mode-aware: practice → paper broker; live → real broker only if configured
  // (else null, so live mode never trades with practice money).
  return (bankingGetBroker(state.practice ?? true) as unknown as BrokerLike | null) ?? null
}

/** Most recent fills kept in `state.orders` (a UI display buffer, and part of
 *  every SSE snapshot — so it must not grow unbounded over a long session). */
const ORDERS_MAX = 50

/**
 * Confirm a live fill actually produced the position it claimed.
 *
 * Runs detached (the trade is already done — this only decides what we tell the
 * user and what we record). Never throws into the trading path.
 *
 * On a confirmed mismatch it warns explicitly and writes an `unreconciled`
 * audit row, because a fill the exchange reported but the book does not show is
 * exactly the case where silence loses track of real money.
 */
async function _verifyFilled(
  broker: BrokerLike,
  tokenId: string,
  shares: number,
  direction: string,
): Promise<void> {
  try {
    const outcome = await reconcileHolding({
      expected: shares,
      readHeld: async () => {
        const port = await broker.getPortfolio()
        const pos = (port.positions ?? []).find(p => p.token === tokenId)
        return pos ? Number(pos.shares) : 0
      },
    })
    if (outcome.ok) return

    const msg = describeMismatch(outcome)
    console.error(`[reconcile] BUY ${direction} ${tokenId.slice(0, 12)} ${msg}`)
    notify(msg, 'error')
    recordTrade({
      action: 'buy',
      mode: 'live',
      asset: String(state.chart_asset ?? '?'),
      direction,
      token: tokenId,
      shares,
      unreconciled: true,
      observed_shares: outcome.observed ?? 0,
    })
  } catch (e) {
    // Verification failing must never look like the trade failing.
    console.warn('[reconcile] check errored (fill itself unaffected):', e instanceof Error ? e.message : e)
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initState(s: AppState): void {
  s.practice = true
  s.trade_size = '25'
  s.wallet_balance = 0
  s.trading_configured = true  // practice=true on init → always configured
  s.orders = []
  s.status = ''
  s.status_ok = true
  s.loading = false
  s.status_seq = 0
  s.buy_side = 'UP'
  s.buy_mode = '1tap'
  s.limit_price = '97'
  s.presets = [5, 10, 25, 50]
  s.stats_fresh = false
  s.stat_cash = 0
  s.stat_spendable = 0
  s.stat_wallet = 0
  s.stat_has_wallet = false
  s.stat_profit = 0
  s.stat_accuracy = 0
  s.stat_wins = 0
  s.stat_losses = 0
  s.stat_out = 0
  s.portfolio_value = 0
  s.portfolio_unrealized = 0
  s.portfolio_realized = 0
  s.wallet_address = ''
  s.wallet_native_usdc = 0
  s.wallet_usdc_e = 0
  s.wallet_total = 0
  // Engine_019: static preset sizes ($5, $25, $100)
  // Python recomputes this from ask prices but TS keeps it static — ask computed client-side via CLOB bus
  s.win_for_size = [
    { size_str: '$5', size_val: '5' },
    { size_str: '$25', size_val: '25' },
    { size_str: '$100', size_val: '100' },
  ]
}

// ── Event handlers ────────────────────────────────────────────────────────────

export function setSize(size: string): void {
  const n = parseFloat(size)
  if (!isNaN(n) && n > 0) patch('trade_size', String(n))
}

export function setMaxSize(): void {
  const spendable = state.stat_spendable ?? 0
  if (spendable > 0) patch('trade_size', String(Math.floor(spendable)))
}

export function setBuySide(side: string): void {
  patch('buy_side', side)
}

const BUY_MODE_LABEL: Record<string, string> = {
  '1tap': '1-Tap',
  market: 'Market',
  limit: 'Limit',
}

export function setBuyMode(mode: string): void {
  patch('buy_mode', mode)
  notify(`${BUY_MODE_LABEL[mode] ?? mode} buy mode`, 'log')
}

const BUY_MODES = ['1tap', 'market', 'limit']

export function cycleBuyMode(): void {
  const idx = BUY_MODES.indexOf(state.buy_mode ?? '1tap')
  const next = BUY_MODES[(idx + 1) % BUY_MODES.length]
  patch('buy_mode', next)
  notify(`${BUY_MODE_LABEL[next] ?? next} buy mode`, 'log')
}

export function setLimitPrice(price: string): void {
  patch('limit_price', price)
}

/**
 * Can live mode actually sign an order right now?
 *
 * TWO signers qualify, not one: a server-side broker (an `.env` key or a
 * generated local wallet), OR the user's own browser wallet in Browser mode —
 * there the extension holds the key and the server never needs one.
 *
 * This used to test only `getBroker()`, which meant someone who intended to
 * sign in MetaMask was told "add credentials to .env" — pointing the safest
 * setup (no key on the box at all) at the riskiest one (paste your private key).
 */
export function liveSignerReady(): boolean {
  return !!getBroker() || state.sign_mode === 'wallet'
}

export function togglePractice(): void {
  const next = !state.practice
  patch('practice', next)
  if (next) patch('sign_mode', 'instant')
  // Practice mode is always configured; live needs a signer (either kind).
  const liveReady = liveSignerReady()
  patch('trading_configured', next ? true : liveReady)
  if (next) {
    notify('Practice mode on', 'log')
  } else if (liveReady) {
    notify('Live mode on — real funds', 'warn')
  } else {
    // Live with no signer yet. Not an error — a next step, and there are two of
    // them. Name the browser wallet first: it needs no config and no key here.
    notify('Live mode — choose a signer in the Wallet panel: connect a browser wallet, or generate/configure a server wallet', 'warn')
  }
  // Refresh balances/positions for the new mode so live↔practice swap their
  // money + holdings instead of showing the other mode's figures.
  void runRefreshBalance()
  void runRefreshPositions()
}

// ── Engine_009: buy_preset ────────────────────────────────────────────────────

export async function runBuyPreset(direction: string, size: string): Promise<void> {
  const n = parseFloat(size)
  if (isNaN(n) || n <= 0) {
    notify('Invalid preset size', 'warn')
    return
  }
  patch('trade_size', String(n))
  await runBuy(direction)
}

export function clearStatusAfter(ms: number): void {
  const seq = (state.status_seq ?? 0) + 1
  patch('status_seq', seq)
  setTimeout(() => {
    if (state.status_seq === seq) {
      patch('status', '')
    }
  }, ms)
}

// ── Async: refresh balance / stats ────────────────────────────────────────────

export async function runRefreshBalance(): Promise<void> {
  // FIX B: capture the mode this refresh was started for. After an await the
  // user may have toggled practice↔live; if so we must DROP this result rather
  // than patch stale figures over the new mode (last-writer-wins race).
  const startedPractice = state.practice
  // Browser (wallet) mode: the connected wallet's balances are read client-side
  // and own these fields — don't let the server (env wallet) clobber them.
  if (!state.practice && state.sign_mode === 'wallet') { patch('trading_configured', true); return }
  // Set configured first — practice is always ready, live needs a signer.
  patch('trading_configured', state.practice ? true : liveSignerReady())
  const broker = getBroker()
  if (!broker) {
    // Live mode with no credentials — show zeros, not leftover practice money.
    patch('stat_cash', 0)
    patch('stat_spendable', 0)
    patch('stat_wallet', 0)
    patch('stat_has_wallet', false)
    patch('stat_profit', 0)
    patch('stat_accuracy', 0)
    patch('stat_wins', 0)
    patch('stat_losses', 0)
    patch('portfolio_value', 0)
    patch('portfolio_unrealized', 0)
    patch('portfolio_realized', 0)
    patch('positions', [])
    patch('wallet_native_usdc', 0)
    patch('wallet_usdc_e', 0)
    patch('wallet_total', 0)
    return
  }

  try {
    const [statsResult, portfolioResult, walletResult] = await Promise.allSettled([
      broker.getStats(),
      broker.getPortfolio(),
      broker.getWalletInfo(),
    ])

    // FIX B: mode changed while we were awaiting → these figures belong to the
    // old mode. Drop them so we don't flash practice numbers in live (or v.v.).
    if (state.practice !== startedPractice) return

    if (statsResult.status === 'fulfilled') {
      const st = statsResult.value
      patch('stat_cash', st.cash)
      patch('stat_spendable', st.spendable)
      patch('stat_wallet', st.wallet)
      patch('stat_has_wallet', st.has_wallet)
      patch('stat_profit', st.profit)
      patch('stat_accuracy', st.accuracy)
      patch('stat_wins', st.wins)
      patch('stat_losses', st.losses)
      patch('stat_out', st.transferred_out)
      patch('stats_fresh', true)
    }

    if (portfolioResult.status === 'fulfilled') {
      const p = portfolioResult.value
      patch('portfolio_value', p.total_value)
      patch('portfolio_unrealized', p.unrealized)
      patch('portfolio_realized', p.realized)
    }

    if (walletResult.status === 'fulfilled') {
      const w = walletResult.value
      patch('wallet_address', w.address)
      patch('wallet_native_usdc', w.native_usdc)
      patch('wallet_usdc_e', w.usdc_e)
      patch('wallet_total', w.total)
    }
  } catch (e: unknown) {
    // FIX F: a persistent auth/RPC failure here silently freezes the scoreboard
    // on stale money figures — log it so it's diagnosable. Behavior unchanged.
    console.error('[trading] runRefreshBalance failed:', e)
  }
}

// ── Background: keep the scoreboard fresh ─────────────────────────────────────
// runRefreshBalance/Positions used to fire only on user actions (toggle, buy,
// refresh button), so on a cold boot the top-bar scoreboard stayed stuck on
// "—" (stats_fresh=false) until you touched something. Pull them on boot and on
// a slow cadence so the scoreboard initializes and tracks settlements/prices.
export async function runRefreshScoreboard(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await Promise.all([runRefreshBalance(), runRefreshPositions()])
    } catch {
      // ignore — try again next cycle
    }
    // Refresh roughly every 5s; the values change only on settle/price moves.
    for (let i = 0; i < 50 && !signal.aborted; i++) await sleep(100)
  }
}

// ── Async: execute buy ────────────────────────────────────────────────────────

export async function runBuy(direction: string): Promise<void> {
  if (state.loading) return

  const size = parseFloat(state.trade_size ?? '25')
  if (isNaN(size) || size <= 0) {
    notify('Invalid size', 'warn')
    return
  }

  const upToken = state.up_token ?? ''
  const dnToken = state.dn_token ?? ''
  const tokenId = direction === 'UP' ? upToken : dnToken

  if (!tokenId) {
    notify('No market available right now', 'warn')
    return
  }

  // Practice routes through the PaperBroker (virtual ledger); live needs creds.
  const broker = getBroker()
  if (!broker) {
    notify('Trading not configured — add credentials to .env', 'error')
    return
  }

  // Preflight (live only): refuse an order we can already tell will not fill.
  // Without this, an over-sized buy got signed and posted, then bounced with a
  // raw CLOB error — which reads to the user as "transactions aren't going
  // through" rather than "you don't have the money". Uses the last known cash
  // and only refuses on a CONFIDENT shortfall, so a stale/failed balance read
  // can never block a legitimate trade.
  if (!state.practice) {
    const cash = Number(state.stat_spendable ?? state.stat_cash ?? NaN)
    if (Number.isFinite(cash) && cash > 0 && size > cash + 1e-9) {
      notify(`Not enough USDC — $${size.toFixed(2)} order, $${cash.toFixed(2)} available`, 'warn')
      return
    }
    // Approvals: an unapproved EOA signs and posts fine, then fails at
    // settlement — which looks like a broken app rather than a missing one-time
    // approval. This read is cached after the first success, so it never sits in
    // the hot path of a 1-tap buy, and a failed READ never blocks a trade.
    if (typeof broker.checkTradeable === 'function') {
      const ready = await broker.checkTradeable()
      if (!ready.ok) {
        notify(ready.error || 'Trading not approved yet', 'error')
        return
      }
    }
  }

  patch('loading', true)

  try {
    const mode = state.buy_mode ?? '1tap'
    let limitPrice: number | undefined
    if (mode === 'limit') {
      // LIMIT: honor the user's explicit cap exactly — never override it. But
      // validate it first: the field is free text, so a cleared/garbage value
      // yields NaN, and NaN propagates silently through the tick clamp
      // (Math.min/max keep it NaN) into a malformed order price. Refuse the same
      // way the market branch refuses a missing slippage cap, rather than
      // relying on the CLOB to reject it after signing.
      const parsed = parseFloat(state.limit_price ?? '97')
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 99) {
        notify('Enter a limit price between 1¢ and 99¢ — order not placed', 'warn')
        patch('loading', false)
        return
      }
      limitPrice = parsed
    } else {
      // 1-Tap / Market: cap at the live ask × (1 + MAX_SLIPPAGE) so a thin book
      // can't match up through to the 99¢ ceiling. No live ask → refuse (better a
      // no-fill than overpaying). Ask is in cents (state.up_ask/dn_ask).
      const askCents = direction === 'UP' ? (state.up_ask ?? 0) : (state.dn_ask ?? 0)
      const cap = slippageCapCents(askCents)
      if (cap == null) {
        notify('No live price — order not placed', 'warn')
        patch('loading', false)
        return
      }
      limitPrice = cap
    }
    // FIX E: snapshot the active window's identity BEFORE awaiting the order. If
    // the window rolls over while the buy is in flight, the window at toast time
    // is the NEXT window — recording against it would settle/strand the position
    // on the wrong window. Capture end_ts/interval now and use them post-fill.
    // Read the SELECTED window (the one this order's token came from), not
    // windows[0] — with 1h/1d cards those differ, and the recorded end_ts is what
    // settlement keys on.
    const wAtBuy = (state.windows ?? [])[state.active_window ?? 0] as Record<string, unknown> | undefined
    const endTsAtBuy = Number(wAtBuy?.['end_ts'] ?? state.active_end_ts ?? 0)
    const intervalSAtBuy = intervalSecs(wAtBuy?.['interval'])
    const fill = await broker.buy(direction, size, tokenId, limitPrice, mode)

    if (fill.unconfirmed) {
      // Submitted but the CLOB returned no matched amounts — NOT a completed
      // buy. Don't toast "Bought 0.00 @ 0¢"; tell the user it's confirming and
      // let the next refresh reconcile what (if anything) actually filled.
      notify('Order submitted — confirming…', 'warn')
      await Promise.all([runRefreshBalance(), runRefreshPositions()])
    } else if (fill.ok) {
      const tag = state.practice ? '[Practice] ' : ''
      recordTrade({
        action: 'buy',
        mode: state.practice ? 'practice' : 'live',
        asset: String(state.chart_asset ?? '?'),
        direction, token: tokenId,
        shares: fill.shares, price_cents: fill.price, usd: size,
        ref: fill.order_id,
      })
      notify(`${tag}Bought ${fill.shares.toFixed(2)} ${direction} @ ${fill.price}¢`, 'log')
      // Cap the in-memory order list. This is a display buffer, and it used to
      // grow without limit for the life of the process -- and it ships inside
      // EVERY SSE snapshot, so an all-day session made each reconnect resend a
      // steadily larger payload. Durable history lives in the trade-audit log
      // (io/trade-audit.ts), not here.
      patch('orders', [
        fill as unknown as Record<string, unknown>,
        ...(state.orders ?? []),
      ].slice(0, ORDERS_MAX))
      // Record the window this token belongs to so it settles on close. Use the
      // snapshot taken BEFORE the order (FIX E), not windows[0] at toast time —
      // the window may have rolled over while the order was in flight.
      if (endTsAtBuy > 0) recordBuyWindow(tokenId, endTsAtBuy - intervalSAtBuy, direction)
      // Refresh balance + positions so the new holding shows up to sell.
      await Promise.all([runRefreshBalance(), runRefreshPositions()])
      // LIVE ONLY: independently confirm the position exists. A reported fill is
      // a claim, not proof — and a success toast over a position that never
      // arrived is the worst way to lose track of real money. Practice settles
      // locally and instantly, so there is nothing to verify there.
      if (!state.practice) void _verifyFilled(broker, tokenId, fill.shares, direction)
    } else {
      notify(fill.error || 'Order failed', 'error')
    }
  } catch (e: unknown) {
    notify(e instanceof Error ? e.message : 'Order error', 'error')
  } finally {
    patch('loading', false)
  }
}
