/**
 * Polymarket window discovery + order placement IO layer.
 * Mirrors TripleUCrypt/io/polymarket.py exactly.
 * Uses undici Pool for all HTTP calls.
 */
import { Pool } from "undici";
import type { MarketWindow, MarketSlug, TradeRow, HolderRow, CommentRow, PositionRow } from "../types.js";
import { intervalSecs } from "../intervals.js";

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

// ── Series slugs (1h / 1d) ────────────────────────────────────────────────────

/**
 * Hourly and daily up/down markets do NOT use the epoch-suffixed slug scheme
 * above. Their per-window slugs are human-readable ET dates —
 *   hourly: bitcoin-up-or-down-august-6-2026-11am-et
 *   daily:  bitcoin-up-or-down-on-august-6-2026        ("on-" only for daily)
 * — which cannot be built reliably (full asset name, month names, no zero
 * padding, am/pm, and US-Eastern with DST). So instead of constructing slugs we
 * walk the recurring SERIES: /series?slug=… yields an id, /events?series_id=…
 * lists every window with its markets[] (slug, endDate, clobTokenIds…).
 */
const SERIES_RECURRENCE: Record<string, string> = { "1h": "hourly", "1d": "daily" };

/** Recurrence-series intervals, in the order they should appear after 5m/15m. */
export const SERIES_INTERVALS = ["1h", "1d"] as const;

const SERIES_ASSETS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "HYPE", "BNB"];

export function seriesSlugFor(asset: string, interval: string): string {
  return `${asset.toLowerCase()}-up-or-down-${SERIES_RECURRENCE[interval] ?? interval}`;
}

/**
 * The (asset, interval) pairs we LOOK for on the series path. Coverage is not
 * uniform — SOL has no hourly/daily and DOGE has no daily — so a pair whose
 * series doesn't resolve simply produces no window (never a dead card). Nothing
 * here is hardcoded per asset: the lookup decides.
 */
export const SERIES_SLUGS: MarketSlug[] = SERIES_ASSETS.flatMap((asset) =>
  SERIES_INTERVALS.map((interval) => ({ asset, interval, baseSlug: seriesSlugFor(asset, interval) })),
);

/** True for a slug that addresses a recurrence series rather than one window. */
export function isSeriesSlug(slug: string): boolean {
  return /-up-or-down-(hourly|daily)$/.test(slug);
}

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

/** Window fields that don't depend on which (asset, interval) asked for them. */
type BaseWindow = Omit<MarketWindow, "asset" | "interval" | "slug" | "current_price" | "secs_str">;

/** Parse clobTokenIds (string-encoded JSON array or a real array) → [up, dn]. */
function _tokensOf(mkt: RawMarket): string[] {
  try {
    if (typeof mkt.clobTokenIds === "string") return JSON.parse(mkt.clobTokenIds) as string[];
    if (Array.isArray(mkt.clobTokenIds)) return mkt.clobTokenIds;
  } catch { /* malformed — treat as no tokens */ }
  return [];
}

function _seriesIdOf(mkt: RawMarket): string {
  try {
    const sers = (mkt.events ?? [])[0]?.series ?? [];
    return sers.length ? String(sers[0].id ?? "") : "";
  } catch {
    return "";
  }
}

/** m:ss, or h:mm:ss once a window is an hour or longer (1h / 1d). */
function _secsStr(secs: number): string {
  if (secs <= 0) return "—";
  const h = Math.trunc(secs / 3600);
  const m = Math.trunc((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Normalise one raw Gamma market into the shared half of a MarketWindow.
 * Prices are left at 0 — the caller fills them from /book (or the WS does).
 * `seriesIdFallback` covers the series path, where the market is nested inside
 * the event we already know the series id of and carries no events[] of its own.
 */
function _baseWindow(mkt: RawMarket, seriesIdFallback = ""): BaseWindow | null {
  const toks = _tokensOf(mkt);
  if (toks.length < 2) return null;

  let endTs = 0;
  let secs = 0;
  const endDt = new Date(mkt.endDate ?? "");
  if (!isNaN(endDt.getTime())) {
    endTs = Math.trunc(endDt.getTime() / 1000);
    secs = Math.max(0, Math.trunc((endDt.getTime() - Date.now()) / 1000));
  }

  let eventStartTs = 0;
  const est = mkt.eventStartTime ?? "";
  if (est) {
    const t = new Date(est).getTime();
    if (!isNaN(t)) eventStartTs = Math.trunc(t / 1000);
  }

  const question = mkt.question ?? "";
  return {
    up_token:       toks[0],
    dn_token:       toks[1],
    up_ask:         0,
    dn_ask:         0,
    combined:       0,
    secs_left:      secs,
    end_ts:         endTs,
    question,
    strike:         parseStrike(question),
    event_start_ts: eventStartTs,
    condition_id:   mkt.conditionId ?? "",
    series_id:      _seriesIdOf(mkt) || seriesIdFallback,
  };
}

/** Best asks (cents) for a token pair, straight off the CLOB REST book. */
async function _fetchAsks(upId: string, dnId: string): Promise<[number, number]> {
  const clobPool = _clobClient();
  const [upBook, dnBook] = await Promise.all([
    _getJson(clobPool, `/book?token_id=${upId}`),
    _getJson(clobPool, `/book?token_id=${dnId}`),
  ]);
  const [upAsk] = bookToCents((upBook as ClobBookRaw) ?? {});
  const [dnAsk] = bookToCents((dnBook as ClobBookRaw) ?? {});
  return [upAsk, dnAsk];
}

async function _discoverActiveWindows(): Promise<RawMarket[]> {
  const now = _nowSec();
  const pool = getHttpClient();

  // Each window's slug is suffixed with the boundary its interval is aligned to.
  const slugs = MARKET_SLUGS.map(({ interval, baseSlug }) => {
    const step = intervalSecs(interval);
    return `${baseSlug}-${Math.trunc(now / step) * step}`;
  });

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
 * Discover the active UP/DOWN windows on the epoch-slug path (5m / 15m).
 * Returns one MarketWindow per MARKET_SLUGS entry (placeholder if no live window found).
 */
async function _fetchEpochWindows(withBooks: boolean): Promise<MarketWindow[]> {
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
  ): Promise<[string, BaseWindow | null]> {
    const base = _baseWindow(mkt);
    if (!base) return [baseSlug, null];

    if (withBooks) {
      const [upAsk, dnAsk] = await _fetchAsks(base.up_token, base.dn_token);
      base.up_ask = upAsk;
      base.dn_ask = dnAsk;
      base.combined = Math.round((upAsk + dnAsk) * 10) / 10;
    }
    return [baseSlug, base];
  }

  const enriched = new Map<string, BaseWindow>();
  const pairs = await Promise.allSettled(
    Array.from(slugToMarket.entries()).map(([s, m]) => enrich(s, m)),
  );
  for (const r of pairs) {
    if (r.status === "fulfilled") {
      const [baseSlug, w] = r.value;
      if (w) enriched.set(baseSlug, w);
    }
  }

  return MARKET_SLUGS.map(({ asset, interval, baseSlug }) => {
    const w = enriched.get(baseSlug);
    if (w) {
      return {
        ...w,
        asset,
        interval,
        slug:          baseSlug,
        current_price: 0,
        secs_str:      _secsStr(w.secs_left),
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

// ── Series discovery (1h / 1d) ────────────────────────────────────────────────

/** One /events row: the window, carrying the tradable market(s) inside it. */
export interface SeriesEvent {
  slug?: string;
  markets?: RawMarket[];
}

// Series ids never change, so resolve each slug once and keep it. A MISS is
// cached too — but only briefly, so an asset that gains an hourly/daily series
// later (SOL has neither today) starts producing a card without a restart.
const _seriesIds = new Map<string, { id: string; ts: number }>();
const SERIES_HIT_TTL_MS  = 12 * 3600_000;
const SERIES_MISS_TTL_MS = 10 * 60_000;

/** How many events to pull per series — enough to cover the open windows. */
const SERIES_EVENT_LIMIT = 12;

/** Resolve a series slug → id, cached. Empty string = no such series. */
export async function resolveSeriesId(seriesSlug: string): Promise<string> {
  const hit = _seriesIds.get(seriesSlug);
  const now = Date.now();
  if (hit && now - hit.ts < (hit.id ? SERIES_HIT_TTL_MS : SERIES_MISS_TTL_MS)) return hit.id;

  let id = "";
  try {
    const d = await _getJson(getHttpClient(), `/series?slug=${encodeURIComponent(seriesSlug)}&limit=1`);
    if (Array.isArray(d) && d.length) id = String((d[0] as Record<string, unknown>)["id"] ?? "");
  } catch { /* leave empty — retried after the miss TTL */ }
  _seriesIds.set(seriesSlug, { id, ts: now });
  return id;
}

/** Test seam: drop everything memoised about series (ids + last live windows). */
export function _clearSeriesCaches(): void {
  _seriesIds.clear();
  _lastSeriesWin.clear();
}

/**
 * Pick the LIVE window out of a series' events.
 *
 * /events?closed=false is not a live filter: it also returns long-past events
 * whose markets have already resolved (a May window still shows up in August).
 * The live window is the tradable market with the earliest end in the future.
 */
export function pickLiveSeriesMarket(events: SeriesEvent[], nowSec: number): RawMarket | null {
  let best: RawMarket | null = null;
  let bestEnd = Infinity;
  for (const ev of events) {
    for (const mkt of ev.markets ?? []) {
      if (mkt.closed === true || mkt.active === false) continue;
      if (_tokensOf(mkt).length < 2) continue;
      const t = new Date(mkt.endDate ?? "").getTime();
      if (isNaN(t)) continue;
      const endTs = Math.trunc(t / 1000);
      if (endTs <= nowSec) continue;
      if (endTs < bestEnd) { bestEnd = endTs; best = mkt; }
    }
  }
  return best;
}

// Last live window seen per series. A single throttled/failed /events call would
// otherwise drop that card for a whole poll, and cards blinking in and out of the
// sidebar reads as breakage — so reuse the last one until it actually expires.
const _lastSeriesWin = new Map<string, BaseWindow>();

async function _fetchSeriesWindows(withBooks: boolean): Promise<MarketWindow[]> {
  const pool = getHttpClient();
  const now = _nowSec();

  const results = await Promise.allSettled(
    SERIES_SLUGS.map(async ({ asset, interval, baseSlug }): Promise<MarketWindow | null> => {
      const seriesId = await resolveSeriesId(baseSlug);
      if (!seriesId) return null;   // no series for this asset+recurrence → no card

      const d = await _getJson(
        pool,
        `/events?series_id=${encodeURIComponent(seriesId)}&limit=${SERIES_EVENT_LIMIT}&closed=false`,
      );
      const mkt = pickLiveSeriesMarket(Array.isArray(d) ? (d as SeriesEvent[]) : [], now);
      let base = mkt ? _baseWindow(mkt, seriesId) : null;
      if (base) {
        _lastSeriesWin.set(baseSlug, base);
      } else {
        // Nothing live this poll: hold the previous window while it's still
        // running, and drop it for good once its end has passed.
        const prev = _lastSeriesWin.get(baseSlug);
        if (!prev || prev.end_ts <= now) { _lastSeriesWin.delete(baseSlug); return null; }
        base = { ...prev, secs_left: Math.max(0, prev.end_ts - now) };
      }

      if (withBooks) {
        const [upAsk, dnAsk] = await _fetchAsks(base.up_token, base.dn_token);
        base.up_ask = upAsk;
        base.dn_ask = dnAsk;
        base.combined = Math.round((upAsk + dnAsk) * 10) / 10;
      }

      return {
        ...base,
        asset,
        interval,
        // The series slug is this market's stable identity across rollovers (the
        // per-window slug changes every hour/day), so it plays the same role the
        // baseSlug does for 5m/15m: selection key, results key, history anchor.
        slug:          baseSlug,
        current_price: 0,
        secs_str:      _secsStr(base.secs_left),
      } as MarketWindow;
    }),
  );

  return results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
}

/**
 * Discover all active UP/DOWN windows across every interval.
 *
 * 5m/15m come from the epoch-suffixed slug path and always yield an entry (a
 * placeholder when no live window resolved); 1h/1d come from the series path and
 * only appear when a live window exists — an asset with no hourly/daily series
 * must not render a dead card. 5m/15m stay FIRST so windows[0] keeps meaning the
 * same market it always did.
 * withBooks=false skips CLOB /book REST calls; the WS fills prices within ~1s.
 */
export async function fetchAllWindows(withBooks = true): Promise<MarketWindow[]> {
  const [epoch, series] = await Promise.all([
    _fetchEpochWindows(withBooks),
    _fetchSeriesWindows(withBooks),
  ]);
  return [...epoch, ...series];
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

/** Resolved side from outcomePrices ([UP, DOWN]); >0.9 ⇒ that side won. */
function _winnerOf(mkt: RawMarket): "UP" | "DOWN" | "?" {
  try {
    const prices = JSON.parse(mkt.outcomePrices ?? "[]") as string[];
    if (prices.length >= 2) {
      if (parseFloat(prices[0]) > 0.9) return "UP";
      if (parseFloat(prices[1]) > 0.9) return "DOWN";
    }
  } catch { /* unresolved or malformed */ }
  return "?";
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
      results.push({ end_ts: endTs, end_label: endLbl, winner: _winnerOf(mkt) });
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
  // 1h/1d windows have no reconstructable slugs — walk the series' closed events.
  if (isSeriesSlug(baseSlug)) return fetchSeriesHistory(baseSlug, limit);
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
      out.push({
        end_ts:    Math.trunc(endDt.getTime() / 1000),
        end_label: _utcLabel(endDt),
        winner:    _winnerOf(m),
      });
    } catch { /* skip */ }
  }
  out.sort((a, b) => b.end_ts - a.end_ts);
  return out;
}

/**
 * Resolved results for the most recent closed windows of a recurrence series
 * (1h / 1d). The per-window slugs can't be reconstructed, so ask the series for
 * its closed events newest-first and read each market's outcome.
 */
export async function fetchSeriesHistory(
  seriesSlug: string,
  limit = 8,
): Promise<WindowResult[]> {
  const seriesId = await resolveSeriesId(seriesSlug);
  if (!seriesId) return [];
  const events = await _fetchSeriesEvents(seriesId, true, limit);

  const out: WindowResult[] = [];
  for (const ev of events) {
    for (const mkt of ev.markets ?? []) {
      const endDt = new Date(mkt.endDate ?? "");
      if (isNaN(endDt.getTime())) continue;
      out.push({
        end_ts:    Math.trunc(endDt.getTime() / 1000),
        end_label: _utcLabel(endDt),
        winner:    _winnerOf(mkt),
      });
    }
  }
  out.sort((a, b) => b.end_ts - a.end_ts);
  return out.slice(0, limit);
}

/** One page of a series' events, newest-first when asking for closed ones. */
async function _fetchSeriesEvents(
  seriesId: string,
  closed: boolean,
  limit: number,
): Promise<SeriesEvent[]> {
  const order = closed ? "&order=endDate&ascending=false" : "";
  const d = await _getJson(
    getHttpClient(),
    `/events?series_id=${encodeURIComponent(seriesId)}&limit=${limit}&closed=${closed}${order}`,
  );
  return Array.isArray(d) ? (d as SeriesEvent[]) : [];
}

/** fetchWindowMeta for a recurrence series: find the window ending at boundaryTs. */
async function _fetchSeriesWindowMeta(
  seriesSlug: string,
  boundaryTs: number,
): Promise<{ token: string; condition_id: string; series_id: string; outcome: string; closed: boolean }> {
  const out = { token: "", condition_id: "", series_id: "", outcome: "", closed: false };
  const seriesId = await resolveSeriesId(seriesSlug);
  if (!seriesId) return out;
  // A viewed slot is usually past (closed), but the slot strip also walks
  // forward — check both pages rather than guessing which one holds it.
  const pages = await Promise.allSettled([
    _fetchSeriesEvents(seriesId, true, 24),
    _fetchSeriesEvents(seriesId, false, SERIES_EVENT_LIMIT),
  ]);
  for (const p of pages) {
    if (p.status !== "fulfilled") continue;
    for (const ev of p.value) {
      for (const mkt of ev.markets ?? []) {
        const t = new Date(mkt.endDate ?? "").getTime();
        if (isNaN(t) || Math.trunc(t / 1000) !== boundaryTs) continue;
        out.token = _tokensOf(mkt)[0] ?? "";
        out.condition_id = mkt.conditionId ?? "";
        out.series_id = seriesId;
        out.closed = mkt.closed === true;
        const w = _winnerOf(mkt);
        if (w !== "?") out.outcome = w;
        return out;
      }
    }
  }
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
  if (isSeriesSlug(baseSlug)) {
    try { return await _fetchSeriesWindowMeta(baseSlug, boundaryTs); } catch { return out; }
  }
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
