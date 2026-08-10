import { state, patch, sleep } from './state.js'
import { notify } from './notify.js'
import type { AppState } from './state.js'
import { defaultWallet, localWalletAddress } from '../banking/local-wallet.js'
import { getBroker, armLiveOps as bankArmLiveOps, allowanceStatus } from '../banking/index.js'
import { liveSignerReady } from './trading.js'

// ── Wallet IO ───────────────────────────────────────────────────────────────
// The previous code required a non-existent '../banking/wallet.js' via CommonJS
// require() (undefined under type:module) so the whole wallet panel was inert.
// Wire it to the real local-wallet (keypair generation + deposit address need
// NO credentials) and gracefully degrade the on-chain ops that do need them.

type WalletIO = {
  generateWallet(): Promise<{address: string}>
  approveWallet(address: string, signMode: string): Promise<void>
  getDepositAddress(chain: string): Promise<string>
  getWalletHistory(address: string): Promise<Record<string, unknown>[]>
  sendFunds(from: string, to: string, amount: number): Promise<{ok: boolean; error?: string}>
}

const _walletIO: WalletIO = {
  async generateWallet() {
    const w = defaultWallet()
    const address = w.exists() ? w.address() : w.generate()
    return { address }
  },
  async approveWallet() {
    // One-time on-chain approvals so subsequent trades are instant. Routes to the
    // live broker's ensureReady() (EOA path), which is now unlocked by the in-app
    // "Enable trading" confirm rather than an .env flag.
    const broker = getBroker(false)
    if (!broker) throw new Error('Live trading not configured (no wallet)')
    const res = await broker.ensureReady()
    if (!res.ok) throw new Error(res.error || 'Approval failed')
  },
  async getDepositAddress() {
    return localWalletAddress()
  },
  async getWalletHistory() {
    const broker = getBroker(false)
    if (!broker) return []
    return broker.txHistory(25)
  },
  async sendFunds(_from, to, amount) {
    const broker = getBroker(false)
    if (!broker) return { ok: false, error: 'Live trading not configured (no wallet)' }
    const res = await broker.send(amount, to)
    return { ok: res.ok, error: res.error }
  },
}

function _getWalletIO(): WalletIO | null {
  return _walletIO
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initState(s: AppState): void {
  s.show_wallet = false
  s.deposit_addr = ''
  s.deposit_chain = 'MATIC'
  s.wallet_history = []
  s.wallet_loading = false
  s.wallet_error = ''
  s.wallet_history_error = ''
  // Reflect any existing on-disk local trading wallet (no decrypt/secret needed).
  const existing = localWalletAddress()
  s.local_wallet_addr = existing
  s.server_proxy = ''
  s.has_local_wallet = !!existing
  s.deposit_addr = existing
  s.wallet_setup_busy = false
  s.wallet_approve_busy = false
  s.wallet_approve_status = ''
  s.live_armed = false
  s.approve_ready = false
  s.last_wallet = ''
  s.swap_from = 'USDC'
  s.swap_to = 'USDC.e'
  s.swap_amount = ''
  s.swap_busy = false
  s.swap_status = ''
  s.gas_busy = false
  s.gas_status = ''
  s.sign_mode = 'instant'
  s.mm_address = ''
  s.mm_status = ''
  s.send_to = ''
  s.send_amount = ''
  s.send_currency = 'USDC'
  s.send_confirming = false
  s.send_busy = false
  s.send_status = ''
  s.send_ok = false
}

// ── Event handlers ────────────────────────────────────────────────────────────

export function toggleWallet(): void {
  patch('show_wallet', !state.show_wallet)
  if (state.show_wallet) {
    runRefreshWalletHistory().catch(() => {})
  }
}

export function closeWallet(): void {
  patch('show_wallet', false)
}

export function setSignMode(mode: string): void {
  const changed = state.sign_mode !== mode
  patch('sign_mode', mode)
  // Switching to Browser signing makes live mode tradeable with no server key —
  // but `trading_configured` used to wait for the 5s scoreboard loop to notice,
  // so the trade buttons stayed dead for up to five seconds immediately after
  // the user did the correct thing. Settle it on the spot instead.
  if (!state.practice) patch('trading_configured', liveSignerReady())

  // Server and Browser are DIFFERENT accounts — a generated/.env wallet vs. the
  // connected wallet's Polymarket proxy — with different balances and positions.
  // The display fields (stat_*, positions) are shared, and the inactive mode's
  // refresh is gated off, so on a switch the PREVIOUS account's money would sit on
  // screen until the new account refreshed (or forever, if the new mode isn't set
  // up). Wipe the money view immediately so it can never show the wrong account's
  // funds, then let the active mode's refresh repopulate.
  if (changed) {
    patch('stats_fresh', false)
    patch('stat_cash', 0); patch('stat_spendable', 0)
    patch('stat_wallet', 0); patch('stat_has_wallet', false)
    patch('positions', [])
    // P&L and the W/L record are per-account too — they were left behind on the top
    // bar, so the server wallet's profit and win/loss record stayed visible while the
    // browser account was selected (and vice versa).
    patch('stat_profit', 0); patch('stat_accuracy', 0)
    patch('stat_wins', 0); patch('stat_losses', 0)
    patch('wallet_balance', 0)
    patch('wallet_native_usdc', 0); patch('wallet_usdc_e', 0)
    // Server mode: its refresh is gated off during wallet mode, so kick it now
    // rather than wait for the 5s loop. Browser mode: the client re-runs
    // refreshBrowserPortfolio off the sign_mode change (see App.tsx).
    if (mode !== 'wallet' && !state.practice) {
      void import('./trading.js').then(m => m.runRefreshBalance?.()).catch(() => {})
      void import('./positions.js').then(m => m.runRefreshPositions?.()).catch(() => {})
    }
  }
}

export function toggleSignMode(): void {
  if (state.practice) { patch('sign_mode', 'instant'); return }
  // Route through setSignMode so the toggle gets the same immediate
  // trading_configured settle as the Wallet panel's segmented control.
  setSignMode(state.sign_mode === 'wallet' ? 'instant' : 'wallet')
}

export async function generateWallet(): Promise<void> {
  const io = _getWalletIO()
  if (!io) {
    patch('wallet_error', 'Wallet generation not available')
    return
  }

  patch('wallet_setup_busy', true)
  patch('wallet_error', '')

  try {
    const { address } = await io.generateWallet()
    patch('local_wallet_addr', address)
    patch('has_local_wallet', true)
    patch('deposit_addr', address) // show the fund-me address + QR immediately
    await runRefreshWalletHistory()
  } catch (e: unknown) {
    patch('wallet_error', e instanceof Error ? e.message : 'Wallet generation failed')
  } finally {
    patch('wallet_setup_busy', false)
  }
}

export async function approveWallet(): Promise<void> {
  const io = _getWalletIO()
  const addr = state.local_wallet_addr ?? ''
  if (!io || !addr) {
    patch('wallet_approve_status', 'No wallet to approve')
    return
  }

  patch('wallet_approve_busy', true)
  patch('wallet_approve_status', 'Approving...')

  try {
    await io.approveWallet(addr, state.sign_mode ?? 'instant')
    patch('wallet_approve_status', 'Approved')
    patch('approve_ready', true)
  } catch (e: unknown) {
    patch('wallet_approve_status', e instanceof Error ? e.message : 'Approval failed')
  } finally {
    patch('wallet_approve_busy', false)
  }
}

// ── Enable live trading (arm real-money ops) ──────────────────────────────────
// The user explicitly confirms a "this moves real funds" dialog in the UI; that
// flips the per-process armed flag so the on-chain approve/withdraw/redeem paths
// unlock (no .env flag needed). Resets on restart.

export function armLiveOps(): void {
  bankArmLiveOps()
  patch('live_armed', true)
  // Reflect current approval state so the UI can show "approve" vs "ready".
  refreshApproveStatus().catch(() => {})
}

/** READ-ONLY: refresh whether the trading wallet's exchange approvals are set. */
export async function refreshApproveStatus(): Promise<void> {
  const addr = state.local_wallet_addr ?? state.wallet_address ?? ''
  if (!addr) { patch('approve_ready', false); return }
  try {
    const st = await allowanceStatus(addr)
    patch('approve_ready', st.ready)
  } catch { /* leave previous value */ }
}

// ── Swap + auto-gas ───────────────────────────────────────────────────────────

export function setSwapFrom(t: string): void { patch('swap_from', t) }
export function setSwapTo(t: string): void { patch('swap_to', t) }
export function setSwapAmount(v: string): void {
  patch('swap_amount', String(v).replace(/[^0-9.]/g, ''))
  patch('swap_status', '')
}

export async function runSwap(): Promise<void> {
  if (state.swap_busy) return
  const from = state.swap_from || 'USDC'
  const to = state.swap_to || 'USDC.e'
  const amount = parseFloat(state.swap_amount || '0')
  if (!(amount > 0)) { notify('Enter an amount', 'warn'); return }
  if (from === to) { notify('Pick two different tokens', 'warn'); return }

  patch('swap_busy', true)
  patch('swap_status', 'Swapping…')
  try {
    const broker = getBroker(false)
    if (!broker) throw new Error('Live trading not configured (no wallet)')
    const res = await broker.swap(from, to, amount)
    if (res.ok) {
      patch('swap_status', 'Swapped')
      patch('swap_amount', '')
      notify(`Swapped ${amount} ${from} → ${to}`, 'log')
    } else {
      patch('swap_status', res.error || 'Swap failed')
      notify(res.error || 'Swap failed', 'error')
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Swap failed'
    patch('swap_status', msg); notify(msg, 'error')
  } finally {
    patch('swap_busy', false)
  }
}

export async function runGetGas(): Promise<void> {
  if (state.gas_busy) return
  patch('gas_busy', true)
  patch('gas_status', 'Getting gas…')
  try {
    const broker = getBroker(false)
    if (!broker) throw new Error('Live trading not configured (no wallet)')
    const res = await broker.topUpGas()
    if (res.ok) {
      patch('gas_status', 'Gas ready')
      notify('Gas topped up', 'log')
    } else {
      patch('gas_status', res.error || 'Gas top-up failed')
      notify(res.error || 'Gas top-up failed', 'error')
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Gas top-up failed'
    patch('gas_status', msg); notify(msg, 'error')
  } finally {
    patch('gas_busy', false)
  }
}

// ── Engine_011: review_send / confirm_send ────────────────────────────────────

export function reviewSend(): void {
  const to = state.send_to ?? ''
  const amountStr = state.send_amount ?? ''
  const amount = parseFloat(amountStr)
  const spendable = state.stat_spendable ?? 0

  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    patch('send_status', 'Invalid address')
    return
  }
  if (isNaN(amount) || amount < 0.01) {
    patch('send_status', 'Minimum send is $0.01')
    return
  }
  if (amount > spendable) {
    patch('send_status', `Insufficient balance (max $${spendable.toFixed(2)})`)
    return
  }
  patch('send_status', '')
  patch('send_confirming', true)
}

export async function confirmSend(): Promise<void> {
  if (state.send_busy) return
  patch('send_busy', true)
  patch('send_status', 'Sending…')

  const io = _getWalletIO()
  const from = state.local_wallet_addr ?? ''
  const to = state.send_to ?? ''
  const amount = parseFloat(state.send_amount ?? '0')

  try {
    if (!io) throw new Error('Wallet IO not available')
    const result = await io.sendFunds(from, to, amount)
    if (result.ok) {
      patch('send_ok', true)
      patch('send_status', 'Sent')
      patch('send_confirming', false)
      // Insert a synthetic history row so the panel updates immediately
      const syntheticRow: Record<string, unknown> = {
        type: 'send',
        to,
        amount,
        ts: Date.now() / 1000,
        status: 'confirmed',
      }
      patch('wallet_history', [syntheticRow, ...(state.wallet_history ?? [])])
      await runRefreshWalletHistory()
    } else {
      patch('send_status', result.error ?? 'Send failed')
    }
  } catch (e: unknown) {
    patch('send_status', e instanceof Error ? e.message : 'Send failed')
  } finally {
    patch('send_busy', false)
  }
}

export function setSendCurrency(currency: string): void {
  patch('send_currency', currency)
}

// One-step send: validate + send in a single tap (no review/confirm step).
export async function sendNow(): Promise<void> {
  if (state.send_busy) return
  const to = (state.send_to ?? '').trim()
  const amount = parseFloat(state.send_amount ?? '0')
  const currency = state.send_currency ?? 'USDC'
  const spendable = state.stat_spendable ?? 0

  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    notify('Invalid address', 'warn'); return
  }
  if (isNaN(amount) || amount <= 0) {
    notify('Enter an amount', 'warn'); return
  }
  // We only track the USDC cash balance; cap against it for USDC variants.
  if ((currency === 'USDC' || currency === 'USDC.e') && amount > spendable) {
    notify(`Amount exceeds balance (max $${spendable.toFixed(2)})`, 'warn'); return
  }

  patch('send_busy', true)
  const io = _getWalletIO()
  const from = state.local_wallet_addr ?? ''
  try {
    if (!io) throw new Error('Wallet not available')
    const result = await io.sendFunds(from, to, amount)
    if (result.ok) {
      patch('send_amount', ''); patch('send_to', '')
      notify(`Sent ${amount} ${currency}`, 'log')
      await runRefreshWalletHistory()
    } else {
      notify(result.error ?? 'Send failed', 'error')
    }
  } catch (e: unknown) {
    notify(e instanceof Error ? e.message : 'Send failed', 'error')
  } finally {
    patch('send_busy', false)
  }
}

export function setSendMax(): void {
  // "Everything out" — the full spendable cash balance.
  patch('send_amount', String(state.stat_spendable ?? 0))
}

// ── Engine_012: MetaMask connect / disconnect ─────────────────────────────────

// `silent` = a load-time reconnect (restore from the saved authorization) — sync
// state but don't toast/notify. Only a user-initiated connect announces itself.
export function onMmConnect(address: string, chainId: string, silent = false): void {
  const isPolygon = chainId === '0x89' || chainId === '137'
  if (!isPolygon) {
    if (!silent) { patch('mm_status', 'Wrong network — switch to Polygon'); notify('Wrong network — switch to Polygon', 'warn') }
    return
  }
  patch('mm_address', address)
  patch('mm_status', silent ? '' : 'Connected')
  patch('sign_mode', 'wallet')
  if (!silent) notify('Wallet connected', 'log')
}

export function disconnectMetamask(): void {
  patch('mm_address', '')
  patch('mm_status', '')
  patch('sign_mode', 'instant')
}

// ── Async: refresh wallet history ─────────────────────────────────────────────

export async function runRefreshWalletHistory(): Promise<void> {
  const io = _getWalletIO()
  const addr = state.local_wallet_addr ?? state.wallet_address ?? ''
  if (!io || !addr) return

  patch('wallet_loading', true)
  patch('wallet_history_error', '')

  try {
    const history = await io.getWalletHistory(addr)
    patch('wallet_history', history)
  } catch (e: unknown) {
    patch('wallet_history_error', e instanceof Error ? e.message : 'History load failed')
  } finally {
    patch('wallet_loading', false)
  }
}
