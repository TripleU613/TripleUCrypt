/**
 * Tests for src/io/kraken.ts
 * Uses vitest with vi.mock for undici to avoid real HTTP calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ASSET_PAIRS, PRICE_SYMBOLS, wsSubscriptions, parseWsMessage, rangeGranularityMins } from "../../src/io/kraken.js";

// ── ASSET_PAIRS ───────────────────────────────────────────────────────────────

describe("ASSET_PAIRS", () => {
  it("has 7 entries", () => {
    expect(Object.keys(ASSET_PAIRS)).toHaveLength(7);
  });

  it("BTC maps to XBTUSD / XXBTZUSD", () => {
    expect(ASSET_PAIRS["BTC"]).toEqual(["XBTUSD", "XXBTZUSD"]);
  });

  it("SOL maps to SOLUSD / SOLUSD (same key)", () => {
    expect(ASSET_PAIRS["SOL"]).toEqual(["SOLUSD", "SOLUSD"]);
  });

  it("all entries are [restSymbol, wsSymbol] tuples", () => {
    for (const [asset, pair] of Object.entries(ASSET_PAIRS)) {
      expect(Array.isArray(pair)).toBe(true);
      expect(pair).toHaveLength(2);
      expect(typeof pair[0]).toBe("string");
      expect(typeof pair[1]).toBe("string");
    }
  });
});

// ── PRICE_SYMBOLS ─────────────────────────────────────────────────────────────

describe("PRICE_SYMBOLS", () => {
  it("has 7 entries", () => {
    expect(PRICE_SYMBOLS).toHaveLength(7);
  });

  it("includes BTC/USD and ETH/USD", () => {
    expect(PRICE_SYMBOLS).toContain("BTC/USD");
    expect(PRICE_SYMBOLS).toContain("ETH/USD");
  });
});

// ── wsSubscriptions ───────────────────────────────────────────────────────────

describe("wsSubscriptions", () => {
  it("returns 3 frames", () => {
    expect(wsSubscriptions()).toHaveLength(3);
  });

  it("first frame subscribes to ticker channel", () => {
    const frames = wsSubscriptions();
    expect(frames[0]).toMatchObject({ method: "subscribe", params: { channel: "ticker" } });
  });

  it("second frame is ohlc interval=5", () => {
    const frames = wsSubscriptions();
    expect(frames[1]).toMatchObject({ method: "subscribe", params: { channel: "ohlc", interval: 5 } });
  });

  it("third frame is ohlc interval=15", () => {
    const frames = wsSubscriptions();
    expect(frames[2]).toMatchObject({ method: "subscribe", params: { channel: "ohlc", interval: 15 } });
  });
});

// ── parseWsMessage ────────────────────────────────────────────────────────────

describe("parseWsMessage", () => {
  it("parses a ticker message", () => {
    const msg = {
      channel: "ticker",
      data: [{ symbol: "BTC/USD", last: "95000.5", change_pct: "2.34" }],
    };
    const result = parseWsMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("ticker");
    if (result!.type === "ticker") {
      expect(result.symbol).toBe("BTC/USD");
      expect(result.price).toBe(95000.5);
      expect(result.change_pct).toBe(2.34);
    }
  });

  it("parses an ohlc message with single bar", () => {
    const msg = {
      channel: "ohlc",
      data: [
        {
          symbol: "BTC/USD",
          interval: 5,
          interval_begin: "2024-01-01T12:00:00Z",
          open: "90000",
          high: "91000",
          low: "89000",
          close: "90500",
        },
      ],
    };
    const result = parseWsMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("ohlc");
    if (result!.type === "ohlc") {
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].asset).toBe("BTC");
      expect(result.groups[0].interval).toBe("5m");
      expect(result.groups[0].bars).toHaveLength(1);
      const bar = result.groups[0].bars[0];
      expect(bar[1]).toBe(90000); // open
      expect(bar[2]).toBe(91000); // high
      expect(bar[3]).toBe(89000); // low
      expect(bar[4]).toBe(90500); // close
    }
  });

  it("correctly assigns 15m interval", () => {
    const msg = {
      channel: "ohlc",
      data: [
        {
          symbol: "ETH/USD",
          interval: 15,
          interval_begin: "2024-01-01T12:00:00Z",
          open: "3000",
          high: "3100",
          low: "2900",
          close: "3050",
        },
      ],
    };
    const result = parseWsMessage(msg);
    expect(result!.type).toBe("ohlc");
    if (result!.type === "ohlc") {
      expect(result.groups[0].interval).toBe("15m");
      expect(result.groups[0].asset).toBe("ETH");
    }
  });

  it("returns null for unrecognized channel", () => {
    const msg = { channel: "heartbeat", data: [{}] };
    expect(parseWsMessage(msg)).toBeNull();
  });

  it("returns null for empty data array", () => {
    const msg = { channel: "ticker", data: [] };
    expect(parseWsMessage(msg)).toBeNull();
  });

  it("groups mixed ohlc bars by asset and interval", () => {
    const msg = {
      channel: "ohlc",
      data: [
        {
          symbol: "BTC/USD", interval: 5,
          interval_begin: "2024-01-01T12:00:00Z",
          open: "90000", high: "91000", low: "89000", close: "90500",
        },
        {
          symbol: "ETH/USD", interval: 5,
          interval_begin: "2024-01-01T12:00:00Z",
          open: "3000", high: "3100", low: "2900", close: "3050",
        },
        {
          symbol: "BTC/USD", interval: 15,
          interval_begin: "2024-01-01T12:00:00Z",
          open: "90000", high: "91500", low: "88000", close: "91000",
        },
      ],
    };
    const result = parseWsMessage(msg);
    expect(result!.type).toBe("ohlc");
    if (result!.type === "ohlc") {
      expect(result.groups).toHaveLength(3);
      const btc5 = result.groups.find((g) => g.asset === "BTC" && g.interval === "5m");
      const eth5 = result.groups.find((g) => g.asset === "ETH" && g.interval === "5m");
      const btc15 = result.groups.find((g) => g.asset === "BTC" && g.interval === "15m");
      expect(btc5).toBeDefined();
      expect(eth5).toBeDefined();
      expect(btc15).toBeDefined();
    }
  });
});

// ── rangeGranularityMins ──────────────────────────────────────────────────────

describe("rangeGranularityMins", () => {
  it("keeps 1-minute bars for the short windows", () => {
    expect(rangeGranularityMins(300)).toBe(1);      // 5m
    expect(rangeGranularityMins(900)).toBe(1);      // 15m
    expect(rangeGranularityMins(3600)).toBe(1);     // 1h → 60 bars
  });

  it("coarsens past an hour so a day isn't asked for as 1440 bars", () => {
    expect(rangeGranularityMins(6 * 3600)).toBe(5);
    expect(rangeGranularityMins(86400)).toBe(15);   // 1d → 96 bars
  });

  it("never asks for more bars than Kraken returns (~720)", () => {
    for (const span of [300, 900, 3600, 6 * 3600, 86400]) {
      expect(span / (rangeGranularityMins(span) * 60)).toBeLessThanOrEqual(720);
    }
  });
});
