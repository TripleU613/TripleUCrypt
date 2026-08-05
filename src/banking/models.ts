/**
 * Banking value types — re-exported from src/types.ts with banking-layer constants.
 *
 * These are the ONLY shapes that cross the broker boundary.
 * Money is always USD floats. Prices are CENTS (0–100).
 */

export type {
  WalletInfo,
  Position,
  Portfolio,
  Stats,
  Quote,
  Fill,
  OrderResult,
} from "../types.js";

// ── Virtual ledger start bankroll ─────────────────────────────────────────────
export const START_BANKROLL = 100.00;

// ── Slippage protection (marketable buys) ─────────────────────────────────────
// A "market"/1-Tap FOK buy is capped at the live ask × (1 + MAX_SLIPPAGE) so a
// thin book can never match up through to the 99¢ ceiling. If it can't fill at
// or below this bounded cap it simply doesn't fill — a no-fill beats overpaying.
export const MAX_SLIPPAGE = 0.02; // 2%
// Price tick grid. Polymarket binary markets quote in 1¢ ticks; assume this when
// the exact tick size isn't known. Final caps are clamped into [TICK, 1 - TICK].
export const DEFAULT_TICK = 0.01;

// ── Order minimums (Polymarket) ───────────────────────────────────────────────
// A BUY amount is denominated in USD; Polymarket rejects orders below $1.
export const MIN_ORDER_USD = 1;
// A SELL is denominated in shares; reject dust below this minimum (also matches
// the data-API sizeThreshold used elsewhere for position visibility).
export const MIN_SHARES = 0.01;

/**
 * Bound a marketable buy cap (in CENTS) from the live ask (in CENTS).
 * Returns ask × (1 + MAX_SLIPPAGE), clamped into the tick grid [tick, 1 - tick]
 * (cents). If `askCents` is not a usable positive number, returns null so the
 * caller can decide (we refuse the order rather than fall back to 99¢).
 */
export function slippageCapCents(askCents: number, tick = DEFAULT_TICK): number | null {
  if (!(askCents > 0)) return null;
  const tickCents = tick * 100;
  const loCents = tickCents;
  const hiCents = 100 - tickCents;
  const capped = askCents * (1 + MAX_SLIPPAGE);
  const clamped = Math.min(hiCents, Math.max(loCents, capped));
  // Snap up to the tick grid so the cap is a valid order price.
  return Math.ceil(clamped / tickCents) * tickCents;
}

/**
 * Bound a marketable SELL floor (in CENTS) from the live best bid (in CENTS).
 * Returns bid × (1 - MAX_SLIPPAGE), clamped into the tick grid [tick, 1 - tick]
 * (cents) and snapped DOWN to the tick grid so the floor is a valid order price.
 * If `bidCents` is not a usable positive number, returns null so the caller can
 * REFUSE the sell rather than dump at a hardcoded 1¢ floor.
 */
export function slippageFloorCents(bidCents: number, tick = DEFAULT_TICK): number | null {
  if (!(bidCents > 0)) return null;
  const tickCents = tick * 100;
  const loCents = tickCents;
  const hiCents = 100 - tickCents;
  const floored = bidCents * (1 - MAX_SLIPPAGE);
  const clamped = Math.min(hiCents, Math.max(loCents, floored));
  // Snap down to the tick grid so the floor is a valid order price.
  return Math.floor(clamped / tickCents) * tickCents;
}

// ── Polygon chain ─────────────────────────────────────────────────────────────
export const POLYGON_CHAIN_ID = 137;

// ── Token contracts (Polygon mainnet, lowercase) ──────────────────────────────
export const NATIVE_USDC       = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
export const USDC_E            = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";  // bridged USDC.e
export const CTF_ADDRESS       = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";  // ConditionalTokens
export const CTF_EXCHANGE      = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"; // Polymarket CTF exchange
export const NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a"; // NegRisk exchange
export const NEG_RISK_ADAPTER  = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"; // NegRisk adapter

// ── Network / API endpoints ───────────────────────────────────────────────────
export const POLYGON_RPC = process.env["POLYGON_RPC"] ?? "https://polygon-bor-rpc.publicnode.com";
export const CLOB_HOST   = "https://clob.polymarket.com";
export const RELAYER_URL = "https://relayer-v2.polymarket.com";
