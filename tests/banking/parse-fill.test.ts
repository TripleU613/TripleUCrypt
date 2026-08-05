/**
 * ClobTrade.parseFill — the success-ONLY-when-matched logic for browser-mode
 * CLOB orders. Truth is makingAmount/takingAmount, NOT the presence of an orderID
 * or a non-error status. A killed FOK/FAK still returns an orderID + a live/delayed
 * status, and that must NOT count as a fill.
 *
 * ClobTrade.ts imports cleanly in the Node/vitest env (its browser access is behind
 * `typeof window !== 'undefined'` guards), so parseFill is unit-testable directly.
 * parseFill is a module-local helper exported minimally for this test (no behaviour
 * change). parseFill itself does no I/O.
 */
import { describe, it, expect } from "vitest";
import { parseFill } from "../../client/buses/ClobTrade.js";

describe("parseFill — killed / unmatched orders", () => {
  it("a killed FOK (status 'live', zero making/taking) is NOT a fill", () => {
    const resp = { orderID: "0xabc", status: "live", makingAmount: "0", takingAmount: "0" };
    const r = parseFill(resp, "BUY", 10, 0);
    expect(r.ok).toBe(false);
    expect(r.shares).toBe(0);
    expect(r.usd).toBe(0);
    expect(r.price).toBe(0);
    // orderID is still surfaced, but does not make it a fill.
    expect(r.orderId).toBe("0xabc");
  });

  it("a 'delayed' order with zero amounts is NOT a fill", () => {
    const resp = { orderID: "0xdef", status: "delayed", makingAmount: 0, takingAmount: 0 };
    const r = parseFill(resp, "SELL", 0, 5);
    expect(r.ok).toBe(false);
    expect(r.shares).toBe(0);
  });

  it("surfaces an error message when not filled", () => {
    const resp = { orderID: "0x1", status: "live", errorMsg: "not enough liquidity" };
    const r = parseFill(resp, "BUY", 10, 0);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not enough liquidity");
  });

  it("a null/empty response is NOT a fill", () => {
    const r = parseFill(null, "BUY", 10, 0);
    expect(r.ok).toBe(false);
    expect(r.shares).toBe(0);
  });
});

describe("parseFill — full match", () => {
  it("a fully-matched BUY reports real shares, usd and price (cents)", () => {
    // BUY: making = USD spent (10), taking = shares received (20) → 50¢ avg.
    const resp = { orderID: "0xfull", status: "matched", makingAmount: "10", takingAmount: "20" };
    const r = parseFill(resp, "BUY", 10, 0);
    expect(r.ok).toBe(true);
    expect(r.usd).toBe(10);
    expect(r.shares).toBe(20);
    expect(r.price).toBe(50); // 10/20 = 0.50 → 50¢
    expect(r.orderId).toBe("0xfull");
  });

  it("a fully-matched SELL reports shares sold and usd received", () => {
    // SELL: making = shares sold (20), taking = USD received (12) → 60¢ avg.
    const resp = { orderID: "0xsell", status: "matched", makingAmount: "20", takingAmount: "12" };
    const r = parseFill(resp, "SELL", 0, 20);
    expect(r.ok).toBe(true);
    expect(r.shares).toBe(20);
    expect(r.usd).toBe(12);
    expect(r.price).toBe(60); // 12/20 = 0.60 → 60¢
    // requested == matched → not partial
    expect((r as unknown as { partial: boolean }).partial).toBe(false);
  });
});

describe("parseFill — partial SELL", () => {
  it("flags a partial FAK sell (matched shares < requested)", () => {
    // Requested 10 shares; only 4 matched (making = shares sold = 4, taking = USD = 2).
    const resp = { orderID: "0xpart", status: "matched", makingAmount: "4", takingAmount: "2" };
    const r = parseFill(resp, "SELL", 0, 10);
    expect(r.ok).toBe(true);
    expect(r.shares).toBe(4);
    expect(r.shares).toBeLessThan(10); // matched < requested
    expect((r as unknown as { partial: boolean }).partial).toBe(true);
    expect((r as unknown as { requested: number }).requested).toBe(10);
  });

  it("does NOT flag partial on a BUY (partial is SELL-only)", () => {
    const resp = { orderID: "0xb", status: "matched", makingAmount: "5", takingAmount: "8" };
    const r = parseFill(resp, "BUY", 10, 0);
    expect(r.ok).toBe(true);
    expect((r as unknown as { partial: boolean }).partial).toBe(false);
  });
});
