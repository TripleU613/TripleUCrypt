/**
 * placeTrade — routes a buy/sell to the right signer based on Wallet Mode.
 *   practice / Server mode  → server action (PaperBroker / LiveBroker, unchanged)
 *   Browser mode (wallet)   → ClobTrade (MetaMask signs, client-side)
 * Call sites in TradingBar use these instead of call('buy'|'sell') directly.
 */

import { useStore, toast } from '../store.js'
import { call } from '../api.js'
import { browserBuy, browserSell, ensureBrowserApprovals, refreshBrowserPortfolio, slippageCapCents, slippageFloorCents, freshHeldSize } from '../buses/ClobTrade.js'
import { ensurePolygon } from '../buses/MetaMaskBus.js'
import { auditBrowserFill } from './auditFill.js'

function isBrowserMode(): boolean {
  const s = useStore.getState()
  return !s.practice && s.sign_mode === 'wallet'
}

// Hard re-entry guard — a browser trade fans out into several wallet popups, so
// a second click (or a re-render) must NOT start another one.
let _tradeBusy = false

export async function placeBuy(side: string, sizeOverride?: number): Promise<void> {
  if (!isBrowserMode()) {
    // Server mode fires a market order server-side; guard against rapid taps /
    // double-clicks firing multiple orders. Reset in finally so a failed/rejected
    // dispatch can't leave a permanent lock.
    if (_tradeBusy) { toast('A trade is already in progress…', 'warn'); return }
    _tradeBusy = true
    try {
      if (sizeOverride != null) await call('buy_preset', side, String(sizeOverride))
      else await call('buy', side)
    } catch (e) {
      console.error('[trade] buy error', e)
      toast((e as Error)?.message || 'Order failed', 'error')
    } finally {
      _tradeBusy = false
    }
    return
  }
  if (_tradeBusy) { toast('A trade is already in progress…', 'warn'); return }
  _tradeBusy = true
  const s = useStore.getState()
  const patch = s._patch
  patch({ loading: true })
  try {
    const addr = s.mm_address
    if (!addr) { toast('Connect a wallet first', 'error'); return }
    // Re-check the wallet's chain right before signing — the user may have
    // switched MetaMask off Polygon after connecting. Refuse if we can't get
    // (or switch) to Polygon rather than signing/approving on the wrong chain.
    if (!(await ensurePolygon())) { toast('Switch your wallet to Polygon to trade', 'error'); return }
    const tokenId = side === 'UP' ? s.up_token : s.dn_token
    if (!tokenId) { toast('No market right now', 'warn'); return }
    const usd = sizeOverride ?? parseFloat(s.trade_size || '25')
    if (!(usd > 0)) { toast('Invalid size', 'warn'); return }
    // LIMIT: honor the user's explicit cap. 1-Tap/Market: cap at the live ask ×
    // (1 + MAX_SLIPPAGE) so a thin book can't fill up to the 99¢ ceiling.
    let maxCents: number
    if (s.buy_mode === 'limit') {
      maxCents = parseFloat(s.limit_price || '97')
    } else {
      const askCents = side === 'UP' ? (s.up_ask ?? 0) : (s.dn_ask ?? 0)
      const cap = slippageCapCents(askCents)
      if (cap == null) { toast('No live price — order not placed', 'warn'); return }
      maxCents = cap
    }

    const appr = await ensureBrowserApprovals(addr, tokenId)
    if (!appr.ok) { toast(appr.error || 'Approve trading first', 'error'); return }
    toast('Confirm the order in your wallet…', 'log')
    const fill = await browserBuy(addr, tokenId, usd, maxCents)
    if (fill.ok) {
      toast(`Bought ${fill.shares.toFixed(2)} ${side} @ ${fill.price}¢`, 'log')
      await refreshBrowserPortfolio(addr)
      // Browser-signed fills never touch the server, so without this they would
      // leave NO durable record and get NO verification — while server-mode
      // fills get both. Same guarantees for both signers.
      void auditBrowserFill('buy', {
        asset: useStore.getState().chart_asset, direction: side, token: tokenId,
        shares: fill.shares, price_cents: fill.price, usd: fill.usd, ref: fill.orderId,
      }, addr, fill.shares, 'atLeast')
    }
    else toast(fill.error || 'Order not filled', 'error')
  } catch (e) {
    console.error('[trade] buy error', e)
    toast((e as Error)?.message || 'Order failed', 'error')
  } finally {
    _tradeBusy = false
    patch({ loading: false })
  }
}

// `serverArg` is what the server-side sell takes ('all' or a $ amount). In Browser
// mode we sell the full position (partial-by-$ client-side is out of scope).
export async function placeSell(token: string, shares: number, serverArg: string = 'all'): Promise<void> {
  if (!isBrowserMode()) {
    // Server mode (see placeBuy): guard against double-submit; reset in finally.
    if (_tradeBusy) { toast('A trade is already in progress…', 'warn'); return }
    _tradeBusy = true
    try {
      await call('sell', token, serverArg)
    } catch (e) {
      console.error('[trade] sell error', e)
      toast((e as Error)?.message || 'Sell failed', 'error')
    } finally {
      _tradeBusy = false
    }
    return
  }
  if (_tradeBusy) { toast('A trade is already in progress…', 'warn'); return }
  _tradeBusy = true
  const s = useStore.getState()
  const patch = s._patch
  patch({ loading: true })
  try {
    const addr = s.mm_address
    if (!addr) { toast('Connect a wallet first', 'error'); return }
    // Re-check the wallet's chain right before signing (see placeBuy) — refuse
    // rather than sign a sell on a non-Polygon network.
    if (!(await ensurePolygon())) { toast('Switch your wallet to Polygon to trade', 'error'); return }
    if (!(shares > 0)) { toast('Nothing to sell', 'warn'); return }
    // Slippage protection: floor the sell at the live best bid × (1 - MAX_SLIPPAGE),
    // tick-clamped. No live bid → refuse rather than dump at a 1¢ floor.
    const tokenBids = (s.token_bids ?? {}) as Record<string, number>
    const floorCents = slippageFloorCents(tokenBids[token] ?? 0)
    if (floorCents == null) { toast('No live bid — order not placed', 'warn'); return }
    // Re-read the FRESHEST held size right before selling — the polled snapshot
    // (~15s) can overstate the balance after a partial/external sale or a
    // resolution. Clamp the order to what's actually held; a resolved token must
    // go to CLAIM, not the sell path; ~0 held → refuse rather than revert.
    const fresh = await freshHeldSize(addr, token)
    if (fresh) {
      if (fresh.resolved) { toast('Position resolved — claim it instead', 'warn'); return }
      if (!(fresh.size > 1e-4)) { toast('Nothing to sell', 'warn'); return }
      if (fresh.size + 1e-6 < shares) shares = fresh.size
    }
    toast('Confirm the sell in your wallet…', 'log')
    const fill = await browserSell(addr, token, shares, floorCents)
    if (fill.ok) {
      // Partial FAK sell: matched fewer than requested — say so, don't pretend
      // the position is fully closed.
      const msg = fill.partial
        ? `Sold ${fill.shares.toFixed(2)} of ${shares.toFixed(2)} shares @ ${fill.price}¢`
        : `Sold ${fill.shares.toFixed(2)} shares @ ${fill.price}¢`
      toast(msg, 'log')
      await refreshBrowserPortfolio(addr)
      // See the buy path: same audit + verification for browser-signed sells.
      // Expect the holding to be at most (what we had) - (what sold).
      void auditBrowserFill('sell', {
        asset: useStore.getState().chart_asset, token,
        shares: fill.shares, price_cents: fill.price, usd: fill.usd,
        ref: fill.orderId, partial: fill.partial,
      }, addr, Math.max(0, (fresh?.size ?? shares) - fill.shares), 'atMost')
    }
    else toast(fill.error || 'Sell not filled', 'error')
  } catch (e) {
    console.error('[trade] sell error', e)
    toast((e as Error)?.message || 'Sell failed', 'error')
  } finally {
    _tradeBusy = false
    patch({ loading: false })
  }
}
