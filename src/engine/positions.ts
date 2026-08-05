import { state, patch, sleep } from './state.js'
import type { AppState } from './state.js'
import { pollSleep } from './performance.js'
import type { Fill } from '../types.js'
import { getBroker as bankingGetBroker, slippageFloorCents } from '../banking/index.js'
import { notify } from './notify.js'
import { recordTrade } from '../io/trade-audit.js'
import { reconcileReduction, describeReductionMismatch } from './reconcile.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const DUST_SHARES = 1e-4
const SOLD_SUPPRESS_S = 5.0

// ── Module state ──────────────────────────────────────────────────────────────

const _recentlySold: Map<string, number> = new Map()

// ── Init ──────────────────────────────────────────────────────────────────────

export function initState(s: AppState): void {
  s.panel_tab = 'buy'
  s.positions = []
  s.pos_loading = false
  s.sell_size = 'all'
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

export interface ComputedPosition extends Record<string, unknown> {
  dust: boolean
  value_usd: number
  pnl_usd: number
  pnl_pct: number
  cur_ask: number
  cur_bid: number
  suppressed: boolean
}

export function posComputed(
  pos: Record<string, unknown>,
  ask: number,
): ComputedPosition {
  const shares = (pos['shares'] as number) ?? 0
  const avgPrice = (pos['avg_price'] as number) ?? 0
  const tokenId = (pos['token'] as string) ?? ''
  const bids = state.token_bids ?? {}
  const asks = state.token_asks ?? {}
  const curBid = bids[tokenId] ?? 0
  const curAsk = asks[tokenId] ?? ask

  const dust = shares < DUST_SHARES
  const valueCents = shares * curBid
  const valueUsd = valueCents / 100
  const costUsd = (shares * avgPrice) / 100
  const pnlUsd = valueUsd - costUsd
  const pnlPct = costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0

  const nowS = Date.now() / 1000
  const soldAt = _recentlySold.get(tokenId) ?? 0
  const suppressed = soldAt > 0 && nowS - soldAt < SOLD_SUPPRESS_S

  return {
    ...pos,
    dust,
    value_usd: valueUsd,
    pnl_usd: pnlUsd,
    pnl_pct: pnlPct,
    cur_ask: curAsk,
    cur_bid: curBid,
    suppressed,
  }
}

export function computePositionsLive(
  positions: Record<string, unknown>[],
): ComputedPosition[] {
  const asks = state.token_asks ?? {}
  return positions.map(p => posComputed(p, asks[(p['token'] as string) ?? ''] ?? 0))
}

export function computeClaimablePositions(
  positions: Record<string, unknown>[],
): Record<string, unknown>[] {
  return positions.filter(p => {
    const resolved = p['resolved'] as boolean | undefined
    const redeemable = p['redeemable'] as boolean | undefined
    return resolved && redeemable
  })
}

export function computeChartPositionLines(
  positions: Record<string, unknown>[],
  asset: string,
  interval: string,
): {price: number; side: string; ts: number}[] {
  const lines: {price: number; side: string; ts: number}[] = []
  for (const p of positions) {
    if ((p['asset'] as string) !== asset) continue
    if ((p['interval'] as string) !== interval) continue
    const avgPrice = (p['avg_price'] as number) ?? 0
    const outcome = (p['outcome'] as string) ?? ''
    const ts = (p['open_ts'] as number) ?? 0
    lines.push({ price: avgPrice / 100, side: outcome, ts })
  }
  return lines
}

// ── Banking import ────────────────────────────────────────────────────────────

type BrokerLike = {
  getPositions(): Promise<Record<string, unknown>[]>
  sell(tokenId: string, amount: number, minPriceCents?: number): Promise<Fill>
  claimWinnings(posIds: string[]): Promise<{ ok: boolean; claimed: number; errors: string[]; refs?: string[] }>
}

/**
 * Confirm a reported live SELL actually reduced the holding.
 *
 * Detached and non-throwing — the sell already happened; this only decides what
 * we tell the user and what we record. A false "you're out" is the dangerous
 * direction here, so a failure is reported as an error, not a warning.
 */
async function _verifySold(
  broker: BrokerLike,
  tokenId: string,
  heldBefore: number,
  sold: number,
): Promise<void> {
  try {
    const outcome = await reconcileReduction({
      heldBefore,
      sold,
      readHeld: async () => {
        const rows = await broker.getPositions()
        const row = rows.find(r => (r['token'] as string) === tokenId)
        return row ? Number(row['shares'] ?? 0) : 0
      },
    })
    if (outcome.ok) return

    const msg = describeReductionMismatch(outcome)
    console.error(`[reconcile] SELL ${tokenId.slice(0, 12)} ${msg}`)
    notify(msg, 'error')
    recordTrade({
      action: 'sell',
      mode: 'live',
      asset: String(state.chart_asset ?? '?'),
      token: tokenId,
      shares: sold,
      unreconciled: true,
      observed_shares: outcome.observed ?? 0,
    })
  } catch (e) {
    console.warn('[reconcile] sell check errored (sell itself unaffected):', e instanceof Error ? e.message : e)
  }
}

function _getBroker(): BrokerLike | null {
  // Mode-aware: practice → paper; live → real broker only if configured.
  return (bankingGetBroker(state.practice ?? true) as unknown as BrokerLike | null) ?? null
}

// ── Async: refresh positions ──────────────────────────────────────────────────

export async function runRefreshPositions(): Promise<void> {
  // FIX B: capture the mode this refresh was started for so we can drop the
  // result if the user toggled practice↔live mid-flight (race with the periodic
  // scoreboard refresh → last-writer-wins showing the wrong mode's holdings).
  const startedPractice = state.practice
  // Browser (wallet) mode: positions are read client-side from the connected
  // wallet — the server must not overwrite them with the env wallet's.
  if (!state.practice && state.sign_mode === 'wallet') return
  const broker = _getBroker()
  if (!broker) return

  patch('pos_loading', true)
  try {
    const positions = await broker.getPositions()
    // FIX B: mode changed while awaiting → these positions belong to the old
    // mode. Drop them rather than patch the wrong mode's holdings.
    if (state.practice !== startedPractice) return
    // Filter out recently sold + dust
    const visible = positions.filter(p => {
      const tokenId = (p['token'] as string) ?? ''
      const shares = (p['shares'] as number) ?? 0
      const nowS = Date.now() / 1000
      const soldAt = _recentlySold.get(tokenId) ?? 0
      const suppressed = soldAt > 0 && nowS - soldAt < SOLD_SUPPRESS_S
      // Keep resolved (won/lost) positions OFF the Sell list — show in history
      const resolved = p['resolved'] as boolean | undefined
      if (resolved) return false
      return !suppressed && shares >= DUST_SHARES
    })
    patch('positions', visible)
  } catch (e: unknown) {
    // FIX F: a persistent failure here silently leaves stale holdings on the
    // Sell list (money-affecting) — log it so it's diagnosable. Behavior same.
    console.error('[positions] runRefreshPositions failed:', e)
  } finally {
    patch('pos_loading', false)
  }
}

// ── Async: sell ───────────────────────────────────────────────────────────────

export async function runSell(tokenId: string, amount: number): Promise<void> {
  const broker = _getBroker()
  if (!broker) return

  // Slippage protection: floor the sell at the live best bid × (1 - MAX_SLIPPAGE),
  // clamped to the tick grid (cents). No live bid (book too thin / expired) → refuse
  // rather than dump at a 1¢ floor. Practice ignores this (PaperBroker uses its own
  // floor), so only refuse here in live mode where a real fill is at stake.
  const bidCents = (state.token_bids ?? {})[tokenId] ?? 0
  const minPriceCents = slippageFloorCents(bidCents)
  if (!state.practice && minPriceCents == null) {
    patch('status', 'No live bid — order not placed')
    patch('status_ok', false)
    notify('No live bid — order not placed', 'warn')
    return
  }

  // Optimistically suppress + remove from the list so the UI feels responsive.
  // This is REVERTED below unless the sell is a CONFIRMED fill — an unconfirmed
  // or zero-fill result must NOT delete a still-held position.
  _recentlySold.set(tokenId, Date.now() / 1000)
  const before = state.positions ?? []
  const filtered = before.filter(p => (p['token'] as string) !== tokenId)
  patch('positions', filtered)

  // Baseline for the post-sell reconcile (see _verifySold). Taken from the same
  // snapshot the optimistic removal uses, so it costs nothing extra.
  const heldBefore = Number(
    (before.find(p => (p['token'] as string) === tokenId)?.['shares']) ?? 0,
  )

  try {
    const fill = await broker.sell(tokenId, amount, minPriceCents ?? undefined)
    if (fill.unconfirmed) {
      // Submitted but no matched amounts — NOT a completed sell. Don't claim the
      // position is closed: drop the optimistic suppression/removal and let the
      // next refresh reconcile what is actually still held.
      _recentlySold.delete(tokenId)
      patch('status', 'Order submitted — confirming…')
      patch('status_ok', false)
      notify('Order submitted — confirming…', 'warn')
    } else if (!fill.ok) {
      // Un-suppress + restore the position on failure.
      _recentlySold.delete(tokenId)
      patch('positions', before)
      patch('status', fill.error || 'Sell failed')
      patch('status_ok', false)
      notify(fill.error || 'Sell failed', 'error')
    } else {
      // Confirmed fill. A partial FAK fill (matched < requested) leaves a residual
      // position — say so and let refresh show the remainder (don't suppress it).
      const partial = fill.shares + 1e-6 < amount
      if (partial) _recentlySold.delete(tokenId)
      recordTrade({
        action: 'sell',
        mode: state.practice ? 'practice' : 'live',
        asset: String(state.chart_asset ?? '?'),
        token: tokenId,
        shares: fill.shares, price_cents: fill.price, usd: fill.usd,
        ref: fill.order_id, partial,
      })
      const msg = partial
        ? `Sold ${fill.shares.toFixed(2)} of ${amount.toFixed(2)} shares @ ${fill.price}¢`
        : `Sold ${fill.shares.toFixed(2)} shares @ ${fill.price}¢`
      patch('status', msg)
      patch('status_ok', true)
      notify(msg, 'log')
      // LIVE ONLY: confirm the shares actually left. A sell that reports filled
      // but leaves the position in place is worse than the buy equivalent — the
      // user believes they are out and stop watching, while still exposed into
      // resolution.
      if (!state.practice && heldBefore > 0) {
        void _verifySold(broker, tokenId, heldBefore, fill.shares)
      }
    }
  } catch (e: unknown) {
    _recentlySold.delete(tokenId)
    patch('positions', before)
    const errMsg = e instanceof Error ? e.message : 'Sell error'
    patch('status', errMsg)
    patch('status_ok', false)
    notify(errMsg, 'error')
  }

  await runRefreshPositions()
}

// ── Async: claim winnings ─────────────────────────────────────────────────────

/**
 * Claim any redeemable winnings.
 * Returns the number claimed: >0 on success (and toasts it), 0 if there was
 * nothing to claim, -1 if there's no broker. The caller decides whether to
 * toast the "nothing to claim" case (e.g. the manual refresh button does).
 */
export async function runClaimWinnings(): Promise<number> {
  const broker = _getBroker()
  if (!broker) return -1

  const claimable = computeClaimablePositions(state.positions ?? [])
  if (!claimable.length) return 0

  const posIds = claimable.map(p => (p['condition_id'] as string) ?? '')
  try {
    const res = await broker.claimWinnings(posIds)
    // Truthful: only toast success for what was ACTUALLY redeemed. A 0-claim
    // result surfaces the broker's own error (e.g. neg-risk not yet supported,
    // redemption not enabled) rather than a false "claimed" toast.
    if (res.claimed > 0) {
      recordTrade({
        action: 'claim',
        mode: state.practice ? 'practice' : 'live',
        claimed: res.claimed,
        // On-chain redeem tx hash(es) — the only durable handle on a real claim.
        ref: (res.refs ?? []).join(','),
      })
      notify(`Claimed ${res.claimed} winning position(s)`, 'log')
      await runRefreshPositions()
      return res.claimed
    }
    notify(res.errors[0] || 'Nothing to claim', 'error')
    return 0
  } catch (e: unknown) {
    notify(e instanceof Error ? e.message : 'Claim failed', 'error')
    return 0
  }
}
