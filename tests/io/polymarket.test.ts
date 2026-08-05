/**
 * Tests for src/io/polymarket.ts
 * Uses vitest with vi.mock for undici.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { bookToCents, MARKET_SLUGS, parseStrike, parseClobWs, parseRtdsTrade } from "../../src/io/polymarket.js";

// ── bookToCents ───────────────────────────────────────────────────────────────

describe("bookToCents", () => {
  it("returns best_ask as min(asks)*100 and best_bid as max(bids)*100", () => {
    const book = {
      asks: [{ price: "0.55" }, { price: "0.60" }, { price: "0.52" }],
      bids: [{ price: "0.48" }, { price: "0.45" }, { price: "0.50" }],
    };
    const [bestAsk, bestBid] = bookToCents(book);
    expect(bestAsk).toBe(52.0);  // min(0.55, 0.60, 0.52) * 100
    expect(bestBid).toBe(50.0);  // max(0.48, 0.45, 0.50) * 100
  });

  it("defaults to ask=99 when asks is empty", () => {
    const book = {
      asks: [],
      bids: [{ price: "0.48" }],
    };
    const [bestAsk, bestBid] = bookToCents(book);
    expect(bestAsk).toBe(99.0);
    expect(bestBid).toBe(48.0);
  });

  it("defaults to bid=0 when bids is empty", () => {
    const book = {
      asks: [{ price: "0.52" }],
      bids: [],
    };
    const [bestAsk, bestBid] = bookToCents(book);
    expect(bestAsk).toBe(52.0);
    expect(bestBid).toBe(0.0);
  });

  it("skips levels with missing/malformed price", () => {
    const book = {
      asks: [{ price: "not-a-number" }, { price: "0.60" }],
      bids: [{ price: "0.40" }, { price: "invalid" }],
    };
    const [bestAsk, bestBid] = bookToCents(book);
    expect(bestAsk).toBe(60.0);
    expect(bestBid).toBe(40.0);
  });

  it("handles empty book object gracefully", () => {
    const [bestAsk, bestBid] = bookToCents({});
    expect(bestAsk).toBe(99.0);
    expect(bestBid).toBe(0.0);
  });

  it("rounds to 1 decimal place", () => {
    const book = {
      asks: [{ price: "0.521" }],
      bids: [{ price: "0.479" }],
    };
    const [bestAsk, bestBid] = bookToCents(book);
    expect(bestAsk).toBe(52.1);
    expect(bestBid).toBe(47.9);
  });
});

// ── MARKET_SLUGS ──────────────────────────────────────────────────────────────

describe("MARKET_SLUGS", () => {
  it("has exactly 14 entries", () => {
    expect(MARKET_SLUGS).toHaveLength(14);
  });

  it("all entries have non-empty baseSlug", () => {
    for (const { baseSlug } of MARKET_SLUGS) {
      expect(baseSlug).toBeTruthy();
      expect(typeof baseSlug).toBe("string");
    }
  });

  it("has 7 assets × 2 intervals", () => {
    const assets = new Set(MARKET_SLUGS.map((s) => s.asset));
    const intervals = new Set(MARKET_SLUGS.map((s) => s.interval));
    expect(assets.size).toBe(7);
    expect(intervals.size).toBe(2);
    expect(intervals.has("5m")).toBe(true);
    expect(intervals.has("15m")).toBe(true);
  });

  it("all base slugs follow the <asset>-updown-<interval> pattern", () => {
    for (const { asset, interval, baseSlug } of MARKET_SLUGS) {
      const expected = `${asset.toLowerCase()}-updown-${interval}`;
      expect(baseSlug).toBe(expected);
    }
  });

  it("contains expected assets", () => {
    const assets = MARKET_SLUGS.map((s) => s.asset);
    for (const a of ["BTC", "ETH", "SOL", "XRP", "DOGE", "HYPE", "BNB"]) {
      expect(assets).toContain(a);
    }
  });
});

// ── parseStrike ───────────────────────────────────────────────────────────────

describe("parseStrike", () => {
  it("extracts the dollar amount from a question", () => {
    expect(parseStrike("Will BTC be above $95,000 at close?")).toBe("$95,000");
  });

  it("returns — when no dollar amount found", () => {
    expect(parseStrike("Will BTC go up?")).toBe("—");
  });

  it("extracts amounts with decimal places", () => {
    expect(parseStrike("Will ETH be above $3,450.50?")).toBe("$3,450.50");
  });
});

// ── parseClobWs ───────────────────────────────────────────────────────────────

describe("parseClobWs", () => {
  it("parses a list (book snapshot)", () => {
    const msg = [
      {
        asset_id: "token-abc",
        asks: [{ price: "0.60" }],
        bids: [{ price: "0.40" }],
      },
    ];
    const result = parseClobWs(msg);
    expect(result).toHaveLength(1);
    expect(result[0].token_id).toBe("token-abc");
    expect(result[0].best_ask).toBe(60.0);
    expect(result[0].best_bid).toBe(40.0);
  });

  it("parses a dict (price_changes)", () => {
    const msg = {
      price_changes: [
        { asset_id: "token-xyz", best_ask: "0.55", best_bid: "0.45" },
      ],
    };
    const result = parseClobWs(msg);
    expect(result).toHaveLength(1);
    expect(result[0].token_id).toBe("token-xyz");
    expect(result[0].best_ask).toBe(55.0);
    expect(result[0].best_bid).toBe(45.0);
  });

  it("uses 0.0 (not 99.0) for missing side in price_changes", () => {
    const msg = {
      price_changes: [
        { asset_id: "token-xyz", best_bid: "0.45" },
      ],
    };
    const result = parseClobWs(msg);
    expect(result[0].best_ask).toBe(0.0);
    expect(result[0].best_bid).toBe(45.0);
  });

  it("skips items without asset_id", () => {
    const msg = [{ asks: [], bids: [] }];
    const result = parseClobWs(msg);
    expect(result).toHaveLength(0);
  });
});

// ── parseRtdsTrade ────────────────────────────────────────────────────────────

describe("parseRtdsTrade", () => {
  it("parses a valid trade payload", () => {
    const msg = {
      topic: "activity",
      payload: {
        conditionId: "cond-123",
        side: "BUY",
        outcome: "Up",
        price: "0.62",
        size: "100",
        timestamp: "1700000000",
        proxyWallet: "0xabcdef123456",
      },
    };
    const result = parseRtdsTrade(msg);
    expect(result).not.toBeNull();
    expect(result!.condition_id).toBe("cond-123");
    expect(result!.side).toBe("bought");
    expect(result!.is_up).toBe(true);
    expect(result!.price).toBe("62.0¢");
    expect(result!._ts).toBe(1700000000);
  });

  it("returns null for wrong topic", () => {
    const msg = { topic: "other", payload: { side: "BUY", outcome: "Up" } };
    expect(parseRtdsTrade(msg)).toBeNull();
  });

  it("returns null for payload with no side or outcome", () => {
    const msg = { topic: "activity", payload: { price: "0.5" } };
    expect(parseRtdsTrade(msg)).toBeNull();
  });

  it("maps SELL side to 'sold'", () => {
    const msg = {
      payload: { side: "SELL", outcome: "Down", price: "0.55", size: "50", timestamp: "0" },
    };
    const result = parseRtdsTrade(msg);
    expect(result!.side).toBe("sold");
    expect(result!.is_up).toBe(false);
  });
});
