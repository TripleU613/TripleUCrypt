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

const INTERVALS: Record<string, number> = { "1m": 1, "5m": 5, "15m": 15 };

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
 * Return the Kraken 1-minute open price for `asset` at Unix timestamp `ts`.
 * Returns 0 on failure.
 */
export async function fetchOpenPriceAt(asset: string, ts: number): Promise<number> {
  const [pairReq, pairKey] = ASSET_PAIRS[asset] ?? ASSET_PAIRS["BTC"];
  try {
    const result = await _getOHLC({ pair: pairReq, interval: 1, since: ts - 60 });
    const rows = _ohlcRows(result, pairReq, pairKey);
    if (!rows.length) return 0;
    // Find candle where open time === ts exactly
    for (const k of rows) {
      if (parseInt(String(k[0]), 10) === ts) return parseFloat(String(k[1]));
    }
    // Fallback: closest candle
    const closest = rows.reduce((a, b) =>
      Math.abs(parseInt(String(a[0]), 10) - ts) <=
      Math.abs(parseInt(String(b[0]), 10) - ts)
        ? a
        : b,
    );
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
 * 1-minute OHLC bars for `asset` within [startTs, endTs) (Unix seconds).
 */
export async function fetchKlinesRange(
  startTs: number,
  endTs: number,
  asset = "BTC",
): Promise<OHLCBar[]> {
  const [pairReq, pairKey] = ASSET_PAIRS[asset] ?? ASSET_PAIRS["BTC"];
  const result = await _getOHLC({ pair: pairReq, interval: 1, since: startTs - 60 });
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
    const iv = parseInt(String(b["interval"] ?? "5"), 10) === 15 ? "15m" : "5m";
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
