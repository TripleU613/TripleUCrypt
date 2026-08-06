/**
 * Polymarket window discovery + order placement IO layer.
 * Mirrors TripleUCrypt/io/polymarket.py exactly.
 * Uses undici Pool for all HTTP calls.
 */
import { Pool } from "undici";
import type { MarketWindow, MarketSlug, TradeRow, HolderRow, CommentRow, PositionRow } from "../types.js";

// ── URL Constants ─────────────────────────────────────────────────────────────

export const GAMMA_API   = "https://gamma-api.polymarket.com";
export const CLOB_API    = "https://clob.polymarket.com";
export const DATA_API    = "https://data-api.polymarket.com";
export const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
export const RTDS_URL    = "wss://ws-live-data.polymarket.com";

// ── Market Slugs ──────────────────────────────────────────────────────────────

/** 14 markets: 7 assets × 2 intervals */
export const MARKET_SLUGS: MarketSlug[] = [
  { asset: "BTC",  interval: "5m",  baseSlug: "btc-updown-5m"  },
  { asset: "BTC",  interval: "15m", baseSlug: "btc-updown-15m" },
  { asset: "ETH",  interval: "5m",  baseSlug: "eth-updown-5m"  },
  { asset: "ETH",  interval: "15m", baseSlug: "eth-updown-15m" },
  { asset: "SOL",  interval: "5m",  baseSlug: "sol-updown-5m"  },
  { asset: "SOL",  interval: "15m", baseSlug: "sol-updown-15m" },
  { asset: "XRP",  interval: "5m",  baseSlug: "xrp-updown-5m"  },
  { asset: "XRP",  interval: "15m", baseSlug: "xrp-updown-15m" },
  { asset: "DOGE", interval: "5m",  baseSlug: "doge-updown-5m" },
  { asset: "DOGE", interval: "15m", baseSlug: "doge-updown-15m"},
  { asset: "HYPE", interval: "5m",  baseSlug: "hype-updown-5m" },
  { asset: "HYPE", interval: "15m", baseSlug: "hype-updown-15m"},
  { asset: "BNB",  interval: "5m",  baseSlug: "bnb-updown-5m"  },
  { asset: "BNB",  interval: "15m", baseSlug: "bnb-updown-15m" },
];

const _STRIKE_RE = /\$[\d,]+(?:\.\d+)?/;

// ── Persistent HTTP pools ─────────────────────────────────────────────────────

let _gammaPool: Pool | null = null;
let _clobPool: Pool | null  = null;
let _dataPool: Pool | null  = null;

/** Returns the singleton undici Pool for Gamma API calls. */
export function getHttpClient(): Pool {
  if (!_gammaPool) {
    _gammaPool = new Pool("https://gamma-api.polymarket.com", {
      connections: 50,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    });
  }
  return _gammaPool;
}

function _clobClient(): Pool {
  if (!_clobPool) {
    _clobPool = new Pool("https://clob.polymarket.com", {
      connections: 50,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    });
  }
  return _clobPool;
}

function _dataClient(): Pool {
  if (!_dataPool) {
    _dataPool = new Pool("https://data-api.polymarket.com", {
      connections: 20,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    });
  }
  return _dataPool;
}

// ── Helper: generic JSON GET ──────────────────────────────────────────────────

async function _getJson(pool: Pool, path: string): Promise<unknown> {
  const { body, statusCode } = await pool.request({
    path,
    method: "GET",
    headers: { accept: "application/json", "cache-control": "no-cache" },
  });
  if (statusCode !== 200) {
    await body.dump();
    return null;
  }
  return JSON.parse(await body.text());
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Extract first $X,XXX dollar amount from a question string. */
export function parseStrike(question: string): string {
  const m = _STRIKE_RE.exec(question);
  return m ? m[0] : "—";
}

interface ClobBookLevel {
  price: string | number;
  size?: string | number;
}

interface ClobBookRaw {
  asks?: ClobBookLevel[];
  bids?: ClobBookLevel[];
}

/**
 * Convert a CLOB /book (or WS snapshot) dict into (best_ask, best_bid) in CENTS.
 * best_ask = lowest ask * 100; best_bid = highest bid * 100.
 * Missing side → ask defaults to 99.0¢, bid to 0.0¢.
 */
export function bookToCents(book: ClobBookRaw): [number, number] {
  const asks = Array.isArray(book.asks) ? book.asks : [];
  const bids = Array.isArray(book.bids) ? book.bids : [];

  const askPx: number[] = [];
  for (const lv of asks) {
    try {
      const p = parseFloat(String(lv.price));
      if (isFinite(p)) askPx.push(p);
    } catch { /* skip */ }
  }
  const bidPx: number[] = [];
  for (const lv of bids) {
    try {
      const p = parseFloat(String(lv.price));
      if (isFinite(p)) bidPx.push(p);
    } catch { /* skip */ }
  }

  const bestAsk = askPx.length ? Math.round(Math.min(...askPx) * 100 * 10) / 10 : 99.0;
  const bestBid = bidPx.length ? Math.round(Math.max(...bidPx) * 100 * 10) / 10 : 0.0;
  return [bestAsk, bestBid];
}

function _nowSec(): number {
  return Math.trunc(Date.now() / 1000);
}

function _utcLabel(dt: Date): string {
  return `${String(dt.getUTCHours()).padStart(2, "0")}:${String(dt.getUTCMinutes()).padStart(2, "0")}`;
}

function _ago(ts: number): string {
  try {
    const d = _nowSec() - Math.trunc(ts);
    if (d < 60)    return `${d}s`;
    if (d < 3600)  return `${Math.trunc(d / 60)}m`;
    if (d < 86400) return `${Math.trunc(d / 3600)}h`;
    return `${Math.trunc(d / 86400)}d`;
  } catch {
    return "";
  }
}

function _nameFromRow(row: Record<string, unknown>): string {
  const n = String(row["name"] ?? row["pseudonym"] ?? "").trim();
  if (n) return n;
  const w = String(row["proxyWallet"] ?? "");
  return w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : (w || "anon");
}

function _avatarColor(seed: string): string {
  const s = seed || "anon";
  let h = 2166136261;
  for (const ch of s) {
    h = (((h ^ ch.charCodeAt(0)) * 16777619) >>> 0);
  }
  const hue1 = h % 360;
  const hue2 = (hue1 + 35 + (h >>> 9) % 90) % 360;
  return `linear-gradient(135deg, hsl(${hue1},68%,56%), hsl(${hue2},72%,46%))`;
}

// ── Window discovery ──────────────────────────────────────────────────────────

interface RawMarket {
  slug?: string;
  active?: boolean;
  closed?: boolean;
  clobTokenIds?: string | string[];
  endDate?: string;
  question?: string;
  conditionId?: string;
  eventStartTime?: string;
  outcomePrices?: string;
  events?: Array<{
    series?: Array<{ id?: unknown }>;
  }>;
}

async function _discoverActiveWindows(): Promise<RawMarket[]> {
  const now = _nowSec();
  const b5  = Math.trunc(now / 300) * 300;
  const b15 = Math.trunc(now / 900) * 900;
  const pool = getHttpClient();

  const slugs = MARKET_SLUGS.map(({ interval, baseSlug }) =>
    `${baseSlug}-${interval === "5m" ? b5 : b15}`,
  );

  const results = await Promise.allSettled(
    slugs.map(async (slug) => {
      const d = await _getJson(
        pool,
        `/markets?slug=${encodeURIComponent(slug)}&limit=1`,
      );
      if (Array.isArray(d) && d.length && (d[0] as RawMarket).active) {
        return d[0] as RawMarket;
      }
      return null;
    }),
  );

  return results
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((m): m is RawMarket => m !== null);
}

/**
 * Discover all active UP/DOWN windows.
 * Returns one MarketWindow per MARKET_SLUGS entry (placeholder if no live window found).
 * withBooks=false skips CLOB /book REST calls; the WS fills prices within ~1s.
 */
export async function fetchAllWindows(withBooks = true): Promise<MarketWindow[]> {
  const rawMarkets = await _discoverActiveWindows();

  // Map base slug → raw market
  const slugToMarket = new Map<string, RawMarket>();
  for (const mkt of rawMarkets) {
    const slug = mkt.slug ?? "";
    for (const { baseSlug } of MARKET_SLUGS) {
      if (slug.startsWith(baseSlug) && !slugToMarket.has(baseSlug)) {
        slugToMarket.set(baseSlug, mkt);
      }
    }
  }

  async function enrich(
    baseSlug: string,
    mkt: RawMarket,
  ): Promise<[string, Omit<MarketWindow, "asset" | "interval" | "slug" | "current_price" | "secs_str"> | null]> {
    let rawTokens: string[] = [];
    try {
      if (typeof mkt.clobTokenIds === "string") {
        rawTokens = JSON.parse(mkt.clobTokenIds) as string[];
      } else if (Array.isArray(mkt.clobTokenIds)) {
        rawTokens = mkt.clobTokenIds;
      }
    } catch { /* skip */ }

    if (rawTokens.length < 2) return [baseSlug, null];
    const [upId, dnId] = rawTokens;

    let upAsk = 0;
    let dnAsk = 0;

    if (withBooks) {
      const clobPool = _clobClient();
      const [upBook, dnBook] = await Promise.all([
        _getJson(clobPool, `/book?token_id=${upId}`),
        _getJson(clobPool, `/book?token_id=${dnId}`),
      ]);
      [upAsk] = bookToCents(upBook as ClobBookRaw ?? {});
      [dnAsk] = bookToCents(dnBook as ClobBookRaw ?? {});
    }

    let endTs = 0;
    let secs = 0;
    try {
      const endDt = new Date(mkt.endDate ?? "");
      if (!isNaN(endDt.getTime())) {
        endTs = Math.trunc(endDt.getTime() / 1000);
        secs = Math.max(0, Math.trunc((endDt.getTime() - Date.now()) / 1000));
      }
    } catch { /* skip */ }

    let seriesId = "";
    try {
      const evs = mkt.events ?? [];
      if (evs.length) {
        const sers = evs[0].series ?? [];
        if (sers.length) seriesId = String(sers[0].id ?? "");
      }
    } catch { /* skip */ }

    let eventStartTs = 0;
    try {
      const est = mkt.eventStartTime ?? "";
      if (est) eventStartTs = Math.trunc(new Date(est).getTime() / 1000);
    } catch { /* skip */ }

    const question = mkt.question ?? "";
    return [
      baseSlug,
      {
        up_token:       upId,
        dn_token:       dnId,
        up_ask:         upAsk,
        dn_ask:         dnAsk,
        combined:       Math.round((upAsk + dnAsk) * 10) / 10,
        secs_left:      secs,
        end_ts:         endTs,
        question,
        strike:         parseStrike(question),
        event_start_ts: eventStartTs,
        condition_id:   mkt.conditionId ?? "",
        series_id:      seriesId,
      },
    ];
  }

  const enriched = new Map<string, ReturnType<typeof enrich> extends Promise<[string, infer V]> ? V : never>();
  const pairs = await Promise.allSettled(
    Array.from(slugToMarket.entries()).map(([s, m]) => enrich(s, m)),
  );
  for (const r of pairs) {
    if (r.status === "fulfilled") {
      const [baseSlug, w] = r.value;
      if (w) enriched.set(baseSlug, w as NonNullable<typeof w>);
    }
  }

  return MARKET_SLUGS.map(({ asset, interval, baseSlug }) => {
    const w = enriched.get(baseSlug);
    if (w) {
      const secs = w.secs_left;
      return {
        ...w,
        asset,
        interval,
        slug:          baseSlug,
        current_price: 0,
        secs_str:      secs > 0 ? `${Math.trunc(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : "—",
      } as MarketWindow;
    }
    return {
      asset,
      interval,
      slug:          baseSlug,
      up_token:      "",
      dn_token:      "",
      up_ask:        0,
      dn_ask:        0,
      combined:      0,
      secs_left:     0,
      secs_str:      "—",
      end_ts:        0,
      question:      "",
      strike:        "—",
      event_start_ts: 0,
      condition_id:  "",
      series_id:     "",
      current_price: 0,
    } as MarketWindow;
  });
}

// ── Order book ────────────────────────────────────────────────────────────────

interface OrderbookResult {
  best_bid: number;
  best_ask: number;
  bids: ClobBookLevel[];
  asks: ClobBookLevel[];
}

/**
 * Return best bid/ask and top-of-book levels for a token.
 * Raises (rejects) on non-200 status.
 */
export async function fetchOrderbook(tokenId: string): Promise<OrderbookResult> {
  const pool = _clobClient();
  const { body, statusCode } = await pool.request({
    path: `/book?token_id=${encodeURIComponent(tokenId)}`,
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (statusCode >= 400) {
    await body.dump();
    throw new Error(`CLOB /book returned ${statusCode} for token ${tokenId}`);
  }
  const data = JSON.parse(await body.text()) as ClobBookRaw;
  const [bestAsk, bestBid] = bookToCents(data);
  return {
    best_bid: bestBid,
    best_ask: bestAsk,
    bids: (data.bids ?? []).slice(0, 8),
    asks: (data.asks ?? []).slice(0, 8),
  };
}

// ── Recent results ────────────────────────────────────────────────────────────

export interface WindowResult {
  end_ts: number;
  end_label: string;
  winner: "UP" | "DOWN" | "?";
}

/**
 * Fetch recently closed markets for a slug and determine UP/DOWN winner.
 * Returns [{end_ts, end_label, winner}] sorted newest first.
 */
export async function fetchRecentResults(
  slug: string,
  limit = 6,
): Promise<WindowResult[]> {
  const pool = getHttpClient();
  let markets: RawMarket[] = [];
  try {
    const d = await _getJson(
      pool,
      `/markets?slug=${encodeURIComponent(slug)}&closed=true&limit=${limit}`,
    );
    if (Array.isArray(d)) markets = d as RawMarket[];
  } catch { /* skip */ }

  const results: WindowResult[] = [];
  for (const mkt of markets) {
    try {
      const endDt = new Date(mkt.endDate ?? "");
      if (isNaN(endDt.getTime())) continue;
      const endTs  = Math.trunc(endDt.getTime() / 1000);
      const endLbl = _utcLabel(endDt);

      let winner: "UP" | "DOWN" | "?" = "?";
      try {
        const prices = JSON.parse(mkt.outcomePrices ?? "[]") as string[];
        if (prices.length >= 2) {
          const pUp = parseFloat(prices[0]);
          const pDn = parseFloat(prices[1]);
          if (pUp > 0.9) winner = "UP";
          else if (pDn > 0.9) winner = "DOWN";
        }
      } catch { /* skip */ }

      results.push({ end_ts: endTs, end_label: endLbl, winner });
    } catch { /* skip */ }
  }

  results.sort((a, b) => b.end_ts - a.end_ts);
  return results;
}

/**
 * Resolved results for recent past windows of a rolling up/down series.
 * Reconstructs the last `limit` boundary slugs and queries each.
 */
export async function fetchWindowHistory(
  baseSlug: string,
  intervalMins = 5,
  limit = 8,
  anchorEndTs = 0,
): Promise<WindowResult[]> {
  if (!baseSlug) return [];
  const pool = getHttpClient();
  const step = Math.max(60, intervalMins * 60);
  const now  = _nowSec();
  // Anchor on the live window's real end timestamp when known (per-window market
  // slugs are suffixed with the END boundary, e.g. baseSlug-<endTs>). Computing
  // it from trunc(now/step)*step can be misaligned and miss every past slug.
  const curEnd = anchorEndTs > 0 ? Math.trunc(anchorEndTs) : Math.trunc(now / step) * step + step;
  const slugs = Array.from({ length: limit }, (_, k) => `${baseSlug}-${curEnd - step * (k + 1)}`);

  const reqs = await Promise.allSettled(
    slugs.map((s) =>
      _getJson(pool, `/markets?slug=${encodeURIComponent(s)}&limit=1`),
    ),
  );

  const out: WindowResult[] = [];
  for (const r of reqs) {
    if (r.status !== "fulfilled" || !Array.isArray(r.value) || !r.value.length) continue;
    const m = r.value[0] as RawMarket;
    try {
      const endDt = new Date(m.endDate ?? "");
      if (isNaN(endDt.getTime())) continue;
      let winner: "UP" | "DOWN" | "?" = "?";
      try {
        const prices = JSON.parse(m.outcomePrices ?? "[]") as string[];
        if (prices.length >= 2) {
          if (parseFloat(prices[0]) > 0.9) winner = "UP";
          else if (parseFloat(prices[1]) > 0.9) winner = "DOWN";
        }
      } catch { /* skip */ }
      out.push({
        end_ts:    Math.trunc(endDt.getTime() / 1000),
        end_label: _utcLabel(endDt),
        winner,
      });
    } catch { /* skip */ }
  }
  out.sort((a, b) => b.end_ts - a.end_ts);
  return out;
}

/**
 * Metadata for a (possibly past) window: UP token id, condition_id, series_id,
 * plus the resolved outcome ("UP" | "DOWN" | "") read from outcomePrices.
 */
export async function fetchWindowMeta(
  baseSlug: string,
  boundaryTs: number,
): Promise<{ token: string; condition_id: string; series_id: string; outcome: string; closed: boolean }> {
  const out = { token: "", condition_id: "", series_id: "", outcome: "", closed: false };
  if (!baseSlug) return out;
  const pool = getHttpClient();
  try {
    const d = await _getJson(
      pool,
      `/markets?slug=${encodeURIComponent(`${baseSlug}-${boundaryTs}`)}&limit=1`,
    );
    if (!Array.isArray(d) || !d.length) return out;
    const m = d[0] as RawMarket;
    try {
      const toks = JSON.parse(String(m.clobTokenIds ?? "[]")) as string[];
      out.token = toks[0] ?? "";
    } catch { /* skip */ }
    out.condition_id = m.conditionId ?? "";
    out.closed = m.closed === true;
    try {
      const evs = m.events ?? [];
      if (evs.length) {
        const sers = evs[0].series ?? [];
        if (sers.length) out.series_id = String(sers[0].id ?? "");
      }
    } catch { /* skip */ }
    // Resolved winner from outcomePrices ([UP, DOWN]); >0.9 ⇒ that side won.
    try {
      const prices = JSON.parse(m.outcomePrices ?? "[]") as string[];
      if (prices.length >= 2) {
        if (parseFloat(prices[0]) > 0.9) out.outcome = "UP";
        else if (parseFloat(prices[1]) > 0.9) out.outcome = "DOWN";
      }
    } catch { /* skip */ }
  } catch { /* skip */ }
  return out;
}

/**
 * Historical UP-probability for a CLOB token over [startTs, endTs].
 * Returns [{t: ms, pct: 0-100}] ascending.
 */
export async function fetchProbHistory(
  tokenId: string,
  startTs: number,
  endTs: number,
  fidelity = 1,
): Promise<{ t: number; pct: number }[]> {
  if (!tokenId) return [];
  const pool = _clobClient();
  try {
    const d = await _getJson(
      pool,
      `/prices-history?market=${encodeURIComponent(tokenId)}&startTs=${startTs}&endTs=${endTs}&fidelity=${fidelity}`,
    );
    if (!d || typeof d !== "object") return [];
    const pts = ((d as Record<string, unknown>)["history"] ?? []) as Array<Record<string, unknown>>;
    const out = pts.flatMap((p) => {
      try {
        return [{ t: Math.trunc(Number(p["t"])) * 1000, pct: Math.round(parseFloat(String(p["p"])) * 100 * 100) / 100 }];
      } catch { return []; }
    });
    out.sort((a, b) => a.t - b.t);
    return out;
  } catch {
    return [];
  }
}

// ── RTDS ──────────────────────────────────────────────────────────────────────

/** RTDS subscribe frame for the live global activity/trades firehose. */
export function rtdsTradesSubscribe(): string {
  return JSON.stringify({
    action: "subscribe",
    subscriptions: [{ topic: "activity", type: "trades" }],
  });
}

/**
 * RTDS subscribe frame for the full social firehose: trades from every market
 * plus comments. Feeds both the per-market trade feed and the cross-market
 * activity log (engine/activity.ts) off one socket. Chainlink price ticks are
 * NOT included here — chart.ts already has its own subscription for those.
 */
export function rtdsActivitySubscribe(): string {
  return JSON.stringify({
    action: "subscribe",
    subscriptions: [
      { topic: "activity", type: "trades" },
      { topic: "comments", type: "*" },
    ],
  });
}

/**
 * Parse one RTDS activity frame → a TradeRow with extras.
 * Returns null if not a valid trade.
 */
export function parseRtdsTrade(
  msg: unknown,
): (TradeRow & { condition_id: string; _ts: number }) | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  const p: Record<string, unknown> =
    "payload" in m && typeof m["payload"] === "object" && m["payload"] !== null
      ? (m["payload"] as Record<string, unknown>)
      : (m as Record<string, unknown>);
  if (typeof m["topic"] === "string" && m["topic"] !== "activity") return null;
  if (!p["side"] && !p["outcome"]) return null;
  try {
    const price = Math.round(parseFloat(String(p["price"] ?? "0")) * 100 * 10) / 10;
    const size  = parseFloat(String(p["size"] ?? "0"));
    const side  = String(p["side"] ?? "").toUpperCase();
    const oc    = String(p["outcome"] ?? "");
    return {
      condition_id: String(p["conditionId"] ?? ""),
      name:    _nameFromRow(p),
      img:     String(p["profileImage"] ?? ""),
      color:   _avatarColor(String(p["proxyWallet"] ?? "") || _nameFromRow(p)),
      side:    side === "BUY" ? "bought" : "sold",
      outcome: oc,
      is_up:   oc.toLowerCase() === "up",
      size:    `${Math.round(size)}`,
      price:   `${price.toFixed(1)}¢`,
      usd:     `$${(size * price / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
      ago:     _ago(parseInt(String(p["timestamp"] ?? "0"), 10)),
      _ts:     parseInt(String(p["timestamp"] ?? "0"), 10),
    };
  } catch {
    return null;
  }
}

// ── CLOB WS ───────────────────────────────────────────────────────────────────

interface ClobWsUpdate {
  token_id: string;
  best_ask: number;
  best_bid: number;
}

/**
 * Parse a CLOB WebSocket message into token price updates.
 * Returns list of {token_id, best_ask, best_bid} in CENTS.
 */
export function parseClobWs(msg: unknown): ClobWsUpdate[] {
  const out: ClobWsUpdate[] = [];
  if (Array.isArray(msg)) {
    for (const item of msg as Record<string, unknown>[]) {
      const tid = String(item["asset_id"] ?? "");
      if (!tid) continue;
      const [bestAsk, bestBid] = bookToCents(item as ClobBookRaw);
      out.push({ token_id: tid, best_ask: bestAsk, best_bid: bestBid });
    }
  } else if (msg !== null && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    for (const change of (m["price_changes"] ?? []) as Record<string, unknown>[]) {
      const tid    = String(change["asset_id"] ?? "");
      const askRaw = change["best_ask"];
      const bidRaw = change["best_bid"];
      if (!tid || (askRaw == null && bidRaw == null)) continue;
      const bestAsk = askRaw ? Math.round(parseFloat(String(askRaw)) * 100 * 10) / 10 : 0;
      const bestBid = bidRaw ? Math.round(parseFloat(String(bidRaw)) * 100 * 10) / 10 : 0;
      out.push({ token_id: tid, best_ask: bestAsk, best_bid: bestBid });
    }
  }
  return out;
}

// ── Social feeds ──────────────────────────────────────────────────────────────

/**
 * Recent trades for a market. Returns TradeRow[].
 */
export async function fetchMarketTrades(
  conditionId: string,
  limit = 40,
): Promise<TradeRow[]> {
  if (!conditionId) return [];
  const pool = _dataClient();
  try {
    const d = await _getJson(
      pool,
      `/trades?market=${encodeURIComponent(conditionId)}&limit=${limit}&takerOnly=false`,
    );
    if (!Array.isArray(d)) return [];
    return d.flatMap((t: Record<string, unknown>) => {
      try {
        const price = Math.round(parseFloat(String(t["price"] ?? "0")) * 100 * 10) / 10;
        const size  = parseFloat(String(t["size"] ?? "0"));
        const side  = String(t["side"] ?? "").toUpperCase();
        return [{
          name:    _nameFromRow(t),
          img:     String(t["profileImage"] ?? ""),
          color:   _avatarColor(String(t["proxyWallet"] ?? "") || _nameFromRow(t)),
          side:    side === "BUY" ? "bought" : "sold",
          outcome: String(t["outcome"] ?? ""),
          is_up:   String(t["outcome"] ?? "").toLowerCase() === "up",
          size:    `${Math.round(size)}`,
          price:   `${price.toFixed(1)}¢`,
          usd:     `$${(size * price / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
          ago:     _ago(Number(t["timestamp"] ?? 0)),
        } as TradeRow];
      } catch { return []; }
    });
  } catch {
    return [];
  }
}

async function _fetchHoldersRaw(
  conditionId: string,
  limit = 20,
): Promise<unknown[]> {
  if (!conditionId) return [];
  const pool = _dataClient();
  try {
    const d = await _getJson(
      pool,
      `/holders?market=${encodeURIComponent(conditionId)}&limit=${limit}`,
    );
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

/**
 * Top holders per outcome → {up: HolderRow[], down: HolderRow[]}.
 */
export async function fetchMarketHolders(
  conditionId: string,
  limit = 20,
  raw?: unknown[],
): Promise<{ up: HolderRow[]; down: HolderRow[] }> {
  if (!conditionId) return { up: [], down: [] };
  const rows = raw ?? await _fetchHoldersRaw(conditionId, limit);
  const up: HolderRow[] = [];
  const down: HolderRow[] = [];
  for (const tok of rows as Array<Record<string, unknown>>) {
    const holders = Array.isArray(tok["holders"]) ? tok["holders"] as Record<string, unknown>[] : [];
    for (const h of holders) {
      const row: HolderRow = {
        name:   _nameFromRow(h),
        img:    String(h["profileImage"] ?? ""),
        color:  _avatarColor(String(h["proxyWallet"] ?? "") || _nameFromRow(h)),
        shares: parseFloat(String(h["amount"] ?? "0")).toLocaleString("en-US", { maximumFractionDigits: 0 }),
        _amt:   parseFloat(String(h["amount"] ?? "0")),
      };
      if (parseInt(String(h["outcomeIndex"] ?? "0"), 10) === 0) {
        up.push(row);
      } else {
        down.push(row);
      }
    }
  }
  up.sort((a, b) => b._amt - a._amt);
  down.sort((a, b) => b._amt - a._amt);
  return { up: up.slice(0, limit), down: down.slice(0, limit) };
}

/**
 * Market-wide top positions by cash PnL → {up: PositionRow[], down: PositionRow[]}.
 */
export async function fetchMarketPositions(
  conditionId: string,
  topN = 10,
  holders?: unknown[],
): Promise<{ up: PositionRow[]; down: PositionRow[] }> {
  if (!conditionId) return { up: [], down: [] };
  const pool = _dataClient();
  const raw = holders ?? await _fetchHoldersRaw(conditionId, topN);

  const meta = new Map<string, Record<string, unknown>>();
  const cand: Record<string, unknown>[] = [];
  for (const tok of raw as Array<Record<string, unknown>>) {
    const holderList = Array.isArray(tok["holders"]) ? tok["holders"] as Record<string, unknown>[] : [];
    for (const hd of holderList) {
      const w = String(hd["proxyWallet"] ?? "");
      if (w && !meta.has(w)) {
        meta.set(w, hd);
        cand.push(hd);
      }
    }
  }
  cand.sort((a, b) => parseFloat(String(b["amount"] ?? "0")) - parseFloat(String(a["amount"] ?? "0")));
  const wallets = cand.slice(0, Math.max(topN * 2, 16)).map((h) => String(h["proxyWallet"]));

  const res = await Promise.allSettled(
    wallets.map(async (w) => {
      const d = await _getJson(
        pool,
        `/positions?user=${encodeURIComponent(w)}&market=${encodeURIComponent(conditionId)}`,
      );
      return [w, Array.isArray(d) ? d : []] as [string, Record<string, unknown>[]];
    }),
  );

  const up: PositionRow[] = [];
  const down: PositionRow[] = [];
  for (const r of res) {
    if (r.status !== "fulfilled") continue;
    const [w, poss] = r.value;
    const m = meta.get(w) ?? {};
    let name = String(m["pseudonym"] ?? m["name"] ?? "");
    if (!name || (name.startsWith("0x") && name.length > 14)) {
      name = w ? `${w.slice(0, 6)}…${w.slice(-4)}` : "anon";
    }
    for (const p of poss) {
      try {
        const pnl  = parseFloat(String(p["cashPnl"] ?? "0"));
        const avg  = parseFloat(String(p["avgPrice"] ?? "0")) * 100;
        const size = parseFloat(String(p["size"] ?? "0"));
        if (size <= 0) continue;
        const row: PositionRow = {
          name,
          img:     String(m["profileImage"] ?? ""),
          color:   _avatarColor(w || name),
          avg:     `${avg.toFixed(1)}¢`,
          pnl:     `${pnl >= 0 ? "" : "-"}$${Math.abs(pnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          pnl_pos: pnl >= 0,
          _pnl:    pnl,
        };
        (parseInt(String(p["outcomeIndex"] ?? "0"), 10) === 0 ? up : down).push(row);
      } catch { /* skip */ }
    }
  }
  up.sort((a, b) => b._pnl - a._pnl);
  down.sort((a, b) => b._pnl - a._pnl);
  return { up: up.slice(0, topN), down: down.slice(0, topN) };
}

/**
 * Comments for the recurring up/down series. Returns CommentRow[].
 */
export async function fetchMarketComments(
  seriesId: string,
  limit = 30,
): Promise<CommentRow[]> {
  if (!seriesId) return [];
  const pool = getHttpClient();
  try {
    const d = await _getJson(
      pool,
      `/comments?parent_entity_type=Series&parent_entity_id=${encodeURIComponent(seriesId)}&limit=${limit}&order=createdAt&ascending=false`,
    );
    if (!Array.isArray(d)) return [];
    return d.flatMap((cm: Record<string, unknown>) => {
      try {
        const prof = (cm["profile"] ?? {}) as Record<string, unknown>;
        let ts = 0;
        try {
          ts = Math.trunc(new Date(String(cm["createdAt"] ?? "")).getTime() / 1000);
        } catch { /* skip */ }
        let name = String(prof["pseudonym"] ?? prof["name"] ?? "anon");
        if (name.startsWith("0x") && name.length > 14) {
          name = `${name.slice(0, 6)}…${name.slice(-4)}`;
        }
        return [{
          name,
          img:   String(prof["profileImage"] ?? ""),
          color: _avatarColor(String(prof["proxyWallet"] ?? "") || name),
          body:  String(cm["body"] ?? ""),
          ago:   ts ? _ago(ts) : "",
          likes: String(cm["reactionCount"] ?? "0"),
        } as CommentRow];
      } catch { return []; }
    });
  } catch {
    return [];
  }
}
