/**
 * Shared TypeScript interfaces mirroring the Python models.
 * All prices are in CENTS (0-100) unless noted otherwise.
 * All money is USD floats.
 */

// ── OHLC ─────────────────────────────────────────────────────────────────────

/** [utc_str, open, high, low, close] */
export type OHLCBar = [string, number, number, number, number];

// ── Order Book ────────────────────────────────────────────────────────────────

export interface OrderBookLevel {
  price_str: string;
  size_str: string;
  total_str: string;
  bar_pct: number;
  is_ask: boolean;
  price_cents: number;
}

// ── Polymarket Market Window ──────────────────────────────────────────────────

/** Per-market active window returned by fetchAllWindows */
export interface MarketWindow {
  asset: string;
  interval: string;
  slug: string;
  up_token: string;
  dn_token: string;
  up_ask: number;       // cents
  dn_ask: number;       // cents
  combined: number;     // cents
  secs_left: number;
  secs_str: string;
  end_ts: number;
  question: string;
  strike: string;
  event_start_ts: number;
  condition_id: string;
  series_id: string;
  current_price: number;
}

// ── Banking Models ────────────────────────────────────────────────────────────

export interface WalletInfo {
  address: string;
  native_usdc: number;   // native USDC (0x3c49…3359)
  usdc_e: number;        // bridged USDC.e (0x2791…4174)
  total: number;         // computed: native_usdc + usdc_e
}

export interface Position {
  token: string;
  condition_id: string;
  outcome: string;       // "UP" | "DOWN" | "?"
  asset: string;         // "BTC" | "ETH" | …
  shares: number;
  avg_price: number;     // cents — entry cost basis
  cur_price: number;     // cents — current best BID
  value: number;         // USD — shares * cur_price/100
  cost_basis: number;    // USD — shares * avg_price/100
  unrealized_pnl: number; // USD — value - cost_basis
  settled: boolean;      // resolved/claimable, NOT sellable
}

export interface Portfolio {
  positions: Position[];
  total_value: number;
  unrealized: number;
  realized: number;
}

export interface Stats {
  cash: number;
  spendable: number;
  wallet: number;
  has_wallet: boolean;
  profit: number;
  accuracy: number;
  wins: number;
  losses: number;
  transferred_out: number;
}

export interface Quote {
  token: string;
  bid: number;   // cents
  ask: number;   // cents
  outcome: string; // "UP" | "DOWN"
  asset: string;   // "BTC" | "ETH" | …
}

export interface Fill {
  token: string;
  side: string;    // "BUY" | "SELL"
  shares: number;
  price: number;   // cents
  usd: number;
  ok: boolean;
  error: string;
  order_id: string;
  unconfirmed: boolean;
}

export interface OrderResult {
  ok: boolean;
  error: string;
  detail: string;
}

// ── Time Slots (carousel) ─────────────────────────────────────────────────────

export interface TimeSlot {
  label: string;      // "HH:MM"
  ts: number;         // Unix seconds
  is_current: boolean;
  is_past: boolean;
  is_viewing: boolean;
  result: string;     // "UP" | "DOWN" | "?" | ""
}

// ── Social Feed Rows ──────────────────────────────────────────────────────────

export interface TradeRow {
  name: string;
  img: string;
  color: string;    // CSS gradient or empty
  side: string;     // "bought" | "sold"
  outcome: string;  // "Up" | "Down"
  is_up: boolean;
  size: string;     // formatted shares
  price: string;    // "XX.X¢"
  usd: string;      // "$X,XXX"
  ago: string;      // "Xs" | "Xm" | "Xh" | "Xd"
}

export interface HolderRow {
  name: string;
  img: string;
  color: string;
  shares: string;   // formatted
  _amt: number;     // raw for sorting
}

export interface CommentRow {
  name: string;
  img: string;
  color: string;
  body: string;
  ago: string;
  likes: string;
}

export interface PositionRow {
  name: string;
  img: string;
  color: string;
  avg: string;      // "XX.X¢"
  pnl: string;      // "$X,XXX.XX" or "-$X,XXX.XX"
  pnl_pos: boolean; // true = profit
  _pnl: number;     // raw for sorting
}

// ── Power Manager ─────────────────────────────────────────────────────────────

export enum PowerTier {
  TURBO    = 0,
  SMOOTH   = 1,
  ECO      = 2,
  SURVIVAL = 3,
}

// ── MarketSlug ────────────────────────────────────────────────────────────────

export interface MarketSlug {
  asset: string;
  interval: string;
  baseSlug: string;
}
