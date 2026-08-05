/**
 * Banking layer barrel + engine-facing broker factory.
 *
 * The migration built the broker layer (PaperBroker/LiveBroker) with one method
 * surface (stats/portfolio/wallet/buy(token,usd)/sell(token,shares)/redeem) while
 * the engine modules (trading/positions/wallet) call a different surface
 * (getStats/getPortfolio/getWalletInfo/getPositions/buy(dir,size,token)/sell(token,amt)/
 * claimWinnings). This module bridges the two via `BrokerAdapter` and exposes the
 * single `getBroker()` factory the engine resolves through `require('../banking/index.js')`.
 */

export * from './models.js'
export * from './broker.js'
export * from './resilience.js'
export { PaperLedger, HISTORY_CAP } from './ledger.js'
export type { LedgerPosition, LedgerState, BuyResult, SellResult, LedgerStats } from './ledger.js'
export * from './local-wallet.js'
export * from './eoa-allowance.js'
export * from './paper.js'
export * from './live.js'

import { PaperBroker } from './paper.js'
import { LiveBroker, isConfigured as liveIsConfigured } from './live.js'
import type { Broker } from './broker.js'
import type { Fill, Stats, Portfolio, WalletInfo, Quote, Position, OrderResult } from '../types.js'

// ── Engine-facing broker interface ──────────────────────────────────────────────
// The exact method names/signatures the engine/* modules call.
export interface EngineBroker {
  getStats(): Promise<Stats>
  getPortfolio(): Promise<Portfolio>
  getWalletInfo(): Promise<WalletInfo>
  getPositions(): Promise<Record<string, unknown>[]>
  buy(direction: string, size: number, tokenId: string, limitPrice?: number, mode?: string): Promise<Fill>
  sell(tokenId: string, amount: number, minPriceCents?: number): Promise<Fill>
  claimWinnings(posIds: string[]): Promise<{ ok: boolean; claimed: number; errors: string[]; refs: string[] }>
  // ── wallet / money management (forwarded to the underlying broker) ──────────
  ensureReady(): Promise<OrderResult>
  /** Read-only tradeability preflight (live only; absent on PaperBroker). */
  checkTradeable?(): Promise<OrderResult>
  send(usdc: number, to: string): Promise<OrderResult>
  txHistory(limit?: number): Promise<Record<string, unknown>[]>
  swap(from: string, to: string, amount: number): Promise<OrderResult>
  topUpGas(): Promise<OrderResult>
}

// ── Live-quote provider ───────────────────────────────────────────────────────
// The engine injects a function that reads the live best bid/ask it already
// streams (token_asks/token_bids), so the paper ledger fills at real prices.
type QuoteProvider = (token: string) => Quote
let _quoteProvider: QuoteProvider | null = null

export function setQuoteProvider(fn: QuoteProvider): void {
  _quoteProvider = fn
}

function paperQuoteFn(token: string): Promise<Quote> {
  if (_quoteProvider) {
    try { return Promise.resolve(_quoteProvider(token)) } catch { /* fall through */ }
  }
  return Promise.resolve({ token, bid: 0, ask: 0, outcome: '?', asset: '?' })
}

// ── Position record mapping (Position → UI record) ──────────────────────────────
function _outcomeLabel(outcome: string): string {
  return outcome === 'DOWN' || outcome === 'Down' ? 'Down' : 'Up'
}

function toRecord(p: Position): Record<string, unknown> {
  const dir = _outcomeLabel(p.outcome)
  return {
    ...p,
    // engine/positions.ts filters on these — paper never resolves on the sell list
    resolved: p.settled,
    redeemable: false,
    // display fields the SellBtn reads
    asset_dir_label: `${p.asset} ${dir}`,
    size_str: `${p.shares.toFixed(1)} shares`,
  }
}

// ── Adapter ─────────────────────────────────────────────────────────────────────
// Exported so tests can wrap a stub Broker and assert the adapter's own guards
// (e.g. the sell-size clamp) in isolation. PaperBroker's ledger clamps sells
// internally, so testing through it can't distinguish the adapter's behavior
// from the ledger's — and LiveBroker does NOT clamp, which is the case that
// matters. Production code should still go through getBroker().
export class BrokerAdapter implements EngineBroker {
  constructor(private readonly b: Broker) {}

  getStats(): Promise<Stats> { return this.b.stats() }
  getPortfolio(): Promise<Portfolio> { return this.b.portfolio() }
  getWalletInfo(): Promise<WalletInfo> { return this.b.wallet() as Promise<WalletInfo> }

  async getPositions(): Promise<Record<string, unknown>[]> {
    const port = await this.b.portfolio()
    return port.positions.filter(p => p.shares > 0).map(toRecord)
  }

  buy(_direction: string, size: number, tokenId: string, limitPrice?: number, _mode?: string): Promise<Fill> {
    // The token already encodes the side; limitPrice (cents) caps a marketable buy.
    return this.b.buy(tokenId, size, limitPrice ?? 99)
  }

  async sell(tokenId: string, amount: number, minPriceCents?: number): Promise<Fill> {
    let shares = amount
    if (!(shares > 0)) {
      // amount <= 0 (e.g. -1 from "sell all") → sell the full position
      const port = await this.b.portfolio()
      const pos = port.positions.find(p => p.token === tokenId)
      shares = pos ? pos.shares : 0
    } else {
      // Explicit size (the $5/$25/$50 quick-sell buttons) arrives from the
      // client's LAST-POLLED positions snapshot, which can overstate the real
      // balance after a prior partial sell, an external sale, or a resolution.
      // Re-read and CLAMP (never raise) before submitting — the same TOCTOU
      // guard the "sell all" branch above and ClobTrade.freshHeldSize() in the
      // browser path already apply. A read failure leaves the requested size
      // untouched rather than blocking a legitimate sell.
      try {
        const port = await this.b.portfolio()
        const pos = port.positions.find(p => p.token === tokenId)
        const held = pos ? pos.shares : 0
        if (held + 1e-6 < shares) shares = held
      } catch { /* keep the requested size — don't fail the sell on a read error */ }
      if (!(shares > 1e-4)) {
        return {
          token: tokenId, side: 'SELL', shares: 0, price: 0, usd: 0,
          ok: false, error: 'Nothing to sell', order_id: '', unconfirmed: false,
        }
      }
    }
    // Slippage protection (live only): `minPriceCents` is the live best bid ×
    // (1 - MAX_SLIPPAGE), already clamped to the tick grid. The LiveBroker refuses
    // the sell when it's missing (no live bid). Practice keeps its own default
    // floor so PaperBroker behavior is unchanged.
    const fill = this.b.mode === 'practice'
      ? await this.b.sell(tokenId, shares)
      : await this.b.sell(tokenId, shares, minPriceCents)
    if (fill.ok) return fill
    // Practice fallback: the market has no live bid (expired/dead book) — close
    // the position at cost basis so a practice holding can never get stranded.
    const paper = this.b as Partial<PaperBroker>
    if (this.b.mode === 'practice' && typeof paper.close === 'function') {
      return paper.close(tokenId)
    }
    return fill
  }

  async claimWinnings(posIds: string[]): Promise<{ ok: boolean; claimed: number; errors: string[]; refs: string[] }> {
    // Actually redeem each resolved position through the underlying broker's
    // existing redeem() path:
    //   • practice → PaperBroker.redeem (no-op success; settles on window close)
    //   • live     → LiveBroker.redeem → redeemEoa (real on-chain CTF/neg-risk redeem)
    // Returns a TRUTHFUL count — never reports success while redeeming nothing.
    const ids = posIds.filter(id => !!id)
    if (!ids.length) return { ok: false, claimed: 0, errors: ['No condition id to claim'], refs: [] }
    let claimed = 0
    const errors: string[] = []
    // On-chain redeem tx hashes (live path). Surfaced so the trade-audit log can
    // record what an actual claim broadcast — otherwise the hash is unrecoverable
    // after the fact.
    const refs: string[] = []
    for (const conditionId of ids) {
      try {
        const res = await this.b.redeem(conditionId)
        if (res.ok) { claimed++; if (res.detail) refs.push(res.detail) }
        else if (res.error) errors.push(res.error)
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e))
      }
    }
    return { ok: claimed > 0, claimed, errors, refs }
  }

  ensureReady(): Promise<OrderResult> { return this.b.ensureReady() }
  /** Read-only tradeability preflight. PaperBroker has none, so default to ok. */
  async checkTradeable(): Promise<OrderResult> {
    const b = this.b as Partial<{ checkTradeable(): Promise<OrderResult> }>
    if (typeof b.checkTradeable !== 'function') return { ok: true, error: '', detail: 'n/a' }
    return b.checkTradeable()
  }
  send(usdc: number, to: string): Promise<OrderResult> { return this.b.send(usdc, to) }
  txHistory(limit?: number): Promise<Record<string, unknown>[]> { return this.b.txHistory(limit) }
  swap(from: string, to: string, amount: number): Promise<OrderResult> { return this.b.swap(from, to, amount) }
  topUpGas(): Promise<OrderResult> { return this.b.topUpGas() }

  // Expose the underlying broker for practice-only extras (settle/reset).
  get raw(): Broker { return this.b }
}

// ── Factory ───────────────────────────────────────────────────────────────────
let _paper: PaperBroker | null = null
let _paperAdapter: BrokerAdapter | null = null
let _liveAdapter: BrokerAdapter | null = null

/**
 * Returns the engine-facing broker for the requested mode.
 * - practice → PaperBroker (virtual $100 ledger, no creds needed)
 * - live     → LiveBroker, but ONLY if real credentials are configured;
 *              otherwise null so live mode reads as "not configured" instead of
 *              silently trading with practice money.
 */
export function getBroker(practice = true): EngineBroker | null {
  if (practice) {
    if (!_paperAdapter) {
      _paper = new PaperBroker(paperQuoteFn)
      _paperAdapter = new BrokerAdapter(_paper)
    }
    return _paperAdapter
  }
  if (!liveIsConfigured()) return null
  if (!_liveAdapter) _liveAdapter = new BrokerAdapter(new LiveBroker())
  return _liveAdapter
}

/** The underlying PaperBroker (for settle/reset on window close). */
export function getPaperBroker(): PaperBroker | null {
  if (!_paper) { _paper = new PaperBroker(paperQuoteFn); _paperAdapter = new BrokerAdapter(_paper) }
  return _paper
}

// ── Practice settlement registry ────────────────────────────────────────────────
// Binary up/down positions don't get sold — they settle ($1/share won, $0 lost)
// when their window closes. The ledger position doesn't carry which window it
// belongs to, so we record token -> {window startTs, side} at buy time and use
// the resolved slot results to settle on close.
const _posWindows = new Map<string, { startTs: number; side: string }>()

/** Record which window/side a freshly-bought token belongs to (called from runBuy). */
export function recordBuyWindow(token: string, startTs: number, side: string): void {
  if (token && startTs > 0) _posWindows.set(token, { startTs, side: side.toUpperCase() })
}

/**
 * Settle any held paper position whose window has resolved.
 * slotResults: startTs(string) -> "UP" | "DOWN".
 * Returns one entry per settled position (won + realized P&L), so the caller
 * can surface a "Won/Lost" toast.
 */
export interface SettleResult { side: string; won: boolean; pnl: number }

export async function settlePaperPositions(slotResults: Record<string, string>): Promise<SettleResult[]> {
  const paper = getPaperBroker()
  if (!paper) return []
  const held = await paper.heldTokens()
  const results: SettleResult[] = []
  for (const token of held) {
    const meta = _posWindows.get(token)
    if (!meta) continue
    const winner = slotResults[String(meta.startTs)]
    if (!winner) continue // not resolved yet
    const won = winner === meta.side
    const pnl = await paper.settle(token, won)
    _posWindows.delete(token)
    results.push({ side: meta.side, won, pnl })
  }
  return results
}

/** Reset the virtual ledger to the starting bankroll and clear the registry. */
export async function resetPaper(): Promise<void> {
  _posWindows.clear()
  const paper = getPaperBroker()
  if (paper) await paper.resetPractice()
}
