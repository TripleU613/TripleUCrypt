/**
 * Kraken REST + WebSocket data layer.
 * Mirrors TripleUCrypt/io/kraken.py exactly.
 * Uses undici for REST calls (not node-fetch, not axios).
 */
import { Pool } from "undici";
import type { OHLCBar } from "../types.js";

export const REST_URL = "https://api.kraken.com/0/public";
export const WS_URL   = "wss://ws.kraken.com/v2";

export const PRICE_SYMBOLS = [
  "BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD",
  "DOGE/USD", "HYPE/USD", "BNB/USD",
];

/** Maps asset code → [restSymbol, wsSymbol] */
export const ASSET_PAIRS: Record<string, [string, string]> = {
  BTC:  ["XBTUSD",  "XXBTZUSD"],
  ETH:  ["ETHUSD",  "XETHZUSD"],
  SOL:  ["SOLUSD",  "SOLUSD"],
  XRP:  ["XRPUSD",  "XXRPZUSD"],
  DOGE: ["DOGEUSD", "XDOGEZUSD"],
  HYPE: ["HYPEUSD", "HYPEUSD"],
  BNB:  ["BNBUSD",  "BNBUSD"],
};

/** Chart timeframe → Kraken OHLC interval in minutes. */
const INTERVALS: Record<string, number> = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "1d": 1440 };

/** Kraken's OHLC interval → the timeframe key we label its bars with. */
const MINS_TO_TF: Record<number, string> = { 1: "1m", 5: "5m", 15: "15m", 60: "1h", 1440: "1d" };

/**
 * Bar size (minutes) for an intra-window fetch spanning `spanSecs`.
 *
 * Kraken returns at most ~720 bars per call and the hindsight canvas only needs
 * ~60-100 points, so a day-long window must not be asked for at 1-minute
 * granularity: 1440 bars is both truncated AND pointless detail.
 */
export function rangeGranularityMins(spanSecs: number): number {
  if (spanSecs <= 3600)      return 1;    // 5m/15m/1h windows → ≤ 60 bars
  if (spanSecs <= 6 * 3600)  return 5;
  return 15;                              // 1d window → 96 bars
}

// ── Persistent undici pool ────────────────────────────────────────────────────

let _krakenPool: Pool | null = null;

function getKrakenPool(): Pool {
  if (!_krakenPool) {
    _krakenPool = new Pool("https://api.kraken.com", {
      connections: 10,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    });
  }
  return _krakenPool;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface KrakenResult {
  result?: Record<string, unknown>;
  error?: string[];
}

async function _getOHLC(
  params: Record<string, string | number>,
): Promise<Record<string, unknown>> {
  const pool = getKrakenPool();
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  ).toString();
  const { body, statusCode } = await pool.request({
    path: `/0/public/OHLC?${qs}`,
    method: "GET",
    headers: { "accept": "application/json" },
  });
  if (statusCode !== 200) {
    await body.dump();
    return {};
  }
  const text = await body.text();
  const data = JSON.parse(text) as KrakenResult;
  return (data.result as Record<string, unknown>) ?? {};
}

/**
 * Pull the OHLC row list out of a Kraken /OHLC result robustly.
 * Tries pair_key, then pair_req, then first list value that isn't "last".
 */
function _ohlcRows(
  result: Record<string, unknown>,
  pairReq: string,
  pairKey: string,
): unknown[][] {
  let rows = result[pairKey] ?? result[pairReq];
  if (!Array.isArray(rows)) {
    rows = Object.entries(result).find(
      ([k, v]) => k !== "last" && Array.isArray(v),
    )?.[1];
  }
  return Array.isArray(rows) ? (rows as unknown[][]) : [];
}

function _utcStr(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Bar size (minutes) to read a window's OPEN price at `ts` from.
 *
 * Kraken serves ~720 bars ending at now regardless of `since`, so 1-minute bars
 * only reach ~12h back — a 1d window's open (up to 24h old) simply isn't in that
 * page. 15-minute bars reach ~7 days and still land exactly on an hourly/daily
 * ET boundary, so the open is read, not guessed.
 */
function _openGranularityMins(ageSecs: number): number {
  return ageSecs <= 8 * 3600 ? 1 : 15;
}

/**
 * Return the Kraken open price for `asset` at Unix timestamp `ts`.
 * Returns 0 on failure — including when the page doesn't actually cover `ts`.
 */
export async function fetchOpenPriceAt(asset: string, ts: number): Promise<number> {
  const [pairReq, pairKey] = ASSET_PAIRS[asset] ?? ASSET_PAIRS["BTC"];
  const gran = _openGranularityMins(Math.max(0, Math.trunc(Date.now() / 1000) - ts));
  try {
    const result = await _getOHLC({ pair: pairReq, interval: gran, since: ts - gran * 60 });
    const rows = _ohlcRows(result, pairReq, pairKey);
    if (!rows.length) return 0;
    // Find candle where open time === ts exactly
    for (const k of rows) {
      if (parseInt(String(k[0]), 10) === ts) return parseFloat(String(k[1]));
    }
    // Fallback: the closest candle — but only if it actually contains `ts`. It
    // used to accept ANY closest row, which for a boundary outside the returned
    // page (a day-old 1d open) handed back a price hours away as "the open".
    const closest = rows.reduce((a, b) =>
      Math.abs(parseInt(String(a[0]), 10) - ts) <=
      Math.abs(parseInt(String(b[0]), 10) - ts)
        ? a
        : b,
    );
    if (Math.abs(parseInt(String(closest[0]), 10) - ts) > gran * 60) return 0;
    return parseFloat(String(closest[1]));
  } catch {
    return 0;
  }
}

/**
 * Fetch 1-minute OHLC bars for `asset` since `sinceTs` (Unix seconds).
 * Returns up to `limit` bars.
 */
export async function fetchKlinesSince(
  sinceTs: number,
  asset = "BTC",
  limit = 20,
): Promise<OHLCBar[]> {
  const [pairReq, pairKey] = ASSET_PAIRS[asset] ?? ASSET_PAIRS["BTC"];
  const result = await _getOHLC({ pair: pairReq, interval: 1, since: sinceTs });
  const raw = _ohlcRows(result, pairReq, pairKey);
  const rows: OHLCBar[] = raw.map((k) => [
    _utcStr(parseInt(String(k[0]), 10)),
    parseFloat(String(k[1])),
    parseFloat(String(k[2])),
    parseFloat(String(k[3])),
    parseFloat(String(k[4])),
  ]);
  return rows.slice(-limit);
}

/**
 * OHLC bars for `asset` within [startTs, endTs) (Unix seconds).
 * Bar size defaults to whatever the span can be drawn from sensibly — 1-minute
 * for the short windows (unchanged), coarser for an hour-plus window.
 */
export async function fetchKlinesRange(
  startTs: number,
  endTs: number,
  asset = "BTC",
  granMins = rangeGranularityMins(Math.max(0, endTs - startTs)),
): Promise<OHLCBar[]> {
  const [pairReq, pairKey] = ASSET_PAIRS[asset] ?? ASSET_PAIRS["BTC"];
  const result = await _getOHLC({ pair: pairReq, interval: granMins, since: startTs - granMins * 60 });
  const raw = _ohlcRows(result, pairReq, pairKey);
  const rows: OHLCBar[] = [];
  for (const k of raw) {
    const t = parseInt(String(k[0]), 10);
    if (t < startTs || t >= endTs) continue;
    rows.push([
      _utcStr(t),
      parseFloat(String(k[1])),
      parseFloat(String(k[2])),
      parseFloat(String(k[3])),
      parseFloat(String(k[4])),
    ]);
  }
  return rows;
}

/**
 * Return [[utc_str, open, high, low, close], ...] for `asset` from Kraken REST.
 */
export async function fetchKlines(
  interval: string,
  asset = "BTC",
  limit = 150,
): Promise<OHLCBar[]> {
  const mins = INTERVALS[interval] ?? 5;
  const [pairReq, pairKey] = ASSET_PAIRS[asset] ?? ASSET_PAIRS["BTC"];
  const result = await _getOHLC({ pair: pairReq, interval: mins });
  const raw = _ohlcRows(result, pairReq, pairKey);
  const rows: OHLCBar[] = raw.map((k) => [
    _utcStr(parseInt(String(k[0]), 10)),
    parseFloat(String(k[1])),
    parseFloat(String(k[2])),
    parseFloat(String(k[3])),
    parseFloat(String(k[4])),
  ]);
  return rows.slice(-limit);
}

/**
 * Returns three WS subscribe frames: ticker for all symbols; ohlc-5; ohlc-15.
 */
export function wsSubscriptions(): Record<string, unknown>[] {
  return [
    { method: "subscribe", params: { channel: "ticker", symbol: PRICE_SYMBOLS } },
    { method: "subscribe", params: { channel: "ohlc",   symbol: PRICE_SYMBOLS, interval: 5 } },
    { method: "subscribe", params: { channel: "ohlc",   symbol: PRICE_SYMBOLS, interval: 15 } },
  ];
}

// ── WS message types ──────────────────────────────────────────────────────────

interface KrakenTickerResult {
  type: "ticker";
  symbol: string;
  price: number;
  change_pct: number;
}

interface KrakenOHLCGroup {
  asset: string;
  interval: string;
  bars: OHLCBar[];
}

interface KrakenOHLCResult {
  type: "ohlc";
  groups: KrakenOHLCGroup[];
}

/**
 * Parse a Kraken WS v2 message dict.
 * Returns a typed result or null if the message should be ignored.
 */
export function parseWsMessage(
  msg: Record<string, unknown>,
): KrakenTickerResult | KrakenOHLCResult | null {
  const ch = String(msg["channel"] ?? "");
  const data = msg["data"];
  if (!Array.isArray(data) || !data.length || (ch !== "ticker" && ch !== "ohlc")) {
    return null;
  }

  if (ch === "ticker") {
    const t = data[0] as Record<string, unknown>;
    return {
      type: "ticker",
      symbol: String(t["symbol"] ?? "BTC/USD"),
      price: parseFloat(String(t["last"] ?? "0")),
      change_pct: Math.round(parseFloat(String(t["change_pct"] ?? "0")) * 100) / 100,
    };
  }

  // ohlc — group per (asset, interval)
  const groups = new Map<string, OHLCBar[]>();
  for (const b of data as Record<string, unknown>[]) {
    const tsRaw = String(b["interval_begin"] ?? "");
    if (!tsRaw) continue;
    const tStr = new Date(tsRaw).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
    const asset = String(b["symbol"] ?? "BTC/USD").split("/")[0];
    const iv = MINS_TO_TF[parseInt(String(b["interval"] ?? "5"), 10)] ?? "5m";
    const key = `${asset}:${iv}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push([
      tStr,
      parseFloat(String(b["open"])),
      parseFloat(String(b["high"])),
      parseFloat(String(b["low"])),
      parseFloat(String(b["close"])),
    ]);
  }
  if (!groups.size) return null;
  return {
    type: "ohlc",
    groups: Array.from(groups.entries()).map(([key, bars]) => {
      const [asset, interval] = key.split(":");
      return { asset, interval, bars };
    }),
  };
}
