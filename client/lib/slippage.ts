/**
 * Pure slippage maths, deliberately kept OUT of buses/ClobTrade.ts.
 *
 * ClobTrade pulls in ethers + @polymarket/clob-client-v2 + node polyfills -- ~43%
 * of the whole bundle -- and is only needed for browser-wallet ORDER SIGNING,
 * which practice mode (the default) never does. It is therefore loaded lazily.
 * These four values are the exception: placeTrade.ts needs them SYNCHRONOUSLY to
 * compute a price cap before it can even decide to load the signer, so leaving
 * them in ClobTrade would have dragged the entire web3 stack back into the eager
 * chunk and defeated the split.
 *
 * Mirror of the server-side maths in src/banking/models.ts.
 */

// ── Slippage protection (marketable buys) ─────────────────────────────────────
// Mirror of src/banking/models.ts: a market/1-Tap FOK buy is capped at the live
// ask × (1 + MAX_SLIPPAGE) so a thin book can't match up to the 99¢ ceiling.
export const MAX_SLIPPAGE = 0.02 // 2%
export const DEFAULT_TICK = 0.01 // 1¢ tick grid (binary markets)

/**
 * Bound a marketable buy cap (CENTS) from the live ask (CENTS): ask × (1+slip),
 * clamped into the tick grid [tick, 1 - tick] and snapped up to the tick.
 * Returns null when `askCents` isn't a usable positive number.
 */
export function slippageCapCents(askCents: number, tick = DEFAULT_TICK): number | null {
  if (!(askCents > 0)) return null
  const tickCents = tick * 100
  const capped = askCents * (1 + MAX_SLIPPAGE)
  const clamped = Math.min(100 - tickCents, Math.max(tickCents, capped))
  return Math.ceil(clamped / tickCents) * tickCents
}

/**
 * Bound a marketable SELL floor (CENTS) from the live best bid (CENTS):
 * bid × (1 - MAX_SLIPPAGE), clamped into the tick grid [tick, 1 - tick] and
 * snapped DOWN to the tick. Returns null when `bidCents` isn't a usable positive
 * number, so the caller REFUSES the sell rather than dumping at a 1¢ floor.
 */
export function slippageFloorCents(bidCents: number, tick = DEFAULT_TICK): number | null {
  if (!(bidCents > 0)) return null
  const tickCents = tick * 100
  const floored = bidCents * (1 - MAX_SLIPPAGE)
  const clamped = Math.min(100 - tickCents, Math.max(tickCents, floored))
  return Math.floor(clamped / tickCents) * tickCents
}
