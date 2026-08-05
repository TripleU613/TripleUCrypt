/**
 * Broker — the single interface the app talks to for money operations.
 *
 * The trading/UI engine imports ONLY this (and the models). It never touches
 * @polymarket/clob-client, viem, or any RPC directly — those live behind LiveBroker.
 * PaperBroker implements the identical surface against a virtual ledger, so the
 * UI is byte-identical between live and practice.
 *
 * All methods are async and ALWAYS return a clean typed result (never raise into
 * the UI). Resilience/normalisation happens inside the concrete brokers.
 */

import type { WalletInfo, Portfolio, Stats, Quote, Fill, OrderResult } from "./models.js";

export interface Broker {
  /** "live" | "practice" */
  readonly mode: string;

  // ── balances ───────────────────────────────────────────────────────────────
  /** Your on-chain wallet: address + native USDC + USDC.e. */
  wallet(): Promise<WalletInfo>;

  /** Polymarket trading cash (pUSD collateral balance), in USD. */
  cash(): Promise<number>;

  /** Open positions with live mark-to-market value + P&L. */
  portfolio(): Promise<Portfolio>;

  /**
   * Persistent personal scoreboard for THIS mode: cash, spendable,
   * wallet, lifetime profit, accuracy, wins, losses, transferred-out.
   * Always returns graceful zeros — never raises into the UI.
   *
   * Optional pre-fetched cash/wallet/portfolio let the caller fetch them
   * once and avoid a duplicate round-trip; when omitted they're read
   * concurrently internally.
   */
  stats(opts?: { cash?: number; wallet?: WalletInfo; portfolio?: Portfolio }): Promise<Stats>;

  // ── market data ────────────────────────────────────────────────────────────
  /** Best bid/ask for a token, in cents. */
  quote(token: string): Promise<Quote>;

  // ── orders (instant / marketable) ─────────────────────────────────────────
  /** Instant marketable BUY for `usd` notional, capped at `maxPrice` cents. */
  buy(token: string, usd: number, maxPrice?: number): Promise<Fill>;

  /** Instant SELL of `shares`, floored at `minPrice` cents. */
  sell(token: string, shares: number, minPrice?: number): Promise<Fill>;

  // ── one-time setup ──────────────────────────────────────────────────────────
  /**
   * One-time approvals/allowances so subsequent trades are instant.
   * Idempotent — safe to call repeatedly; a no-op once satisfied.
   */
  ensureReady(): Promise<OrderResult>;

  // ── wallet / money management ──────────────────────────────────────────────
  /**
   * Where to send funds to top up: `{address, chain, token}`.
   * Empty object in practice (no real wallet).
   */
  depositAddress(): Promise<{ address: string; chain: string; token: string } | Record<string, never>>;

  /**
   * Recent on-chain USDC transfers to/from the funder, newest-first.
   * Always graceful — returns `[]` in practice or on any error.
   */
  txHistory(limit?: number): Promise<Record<string, unknown>[]>;

  /**
   * Claim a RESOLVED winning position's payout into spendable collateral.
   * LIVE only (generated-EOA path; gated behind TUC_REDEEM_ENABLED).
   * Practice settles automatically on window close, so PaperBroker is a no-op.
   * Never raises into the UI.
   */
  redeem(conditionId: string): Promise<OrderResult>;

  /**
   * Send `usdc` from the funder to an arbitrary address (gasless via the relayer).
   * LIVE only and gated behind TUC_SEND_ENABLED; PaperBroker returns 'not available in practice'.
   * Validates address + amount; never raises into the UI.
   */
  send(usdc: number, to: string): Promise<OrderResult>;

  /**
   * Swap `amount` of `from` token into `to` token on-chain (native USDC / USDC.e / POL)
   * via the 0x Swap API. LIVE generated-EOA only; PaperBroker returns 'not available'.
   */
  swap(from: string, to: string, amount: number): Promise<OrderResult>;

  /**
   * Ensure the trading wallet holds enough POL for gas, swapping a little USDC.e → POL
   * if low. LIVE generated-EOA only; PaperBroker is a no-op success.
   */
  topUpGas(): Promise<OrderResult>;
}
