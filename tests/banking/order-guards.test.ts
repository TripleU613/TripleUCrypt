/**
 * LiveBroker.buy / .sell input-validation guards.
 *
 * These guards short-circuit and return the broker's Fill error shape BEFORE any
 * CLOB client is constructed or any network request is made (verified: the
 * validation returns at the top of buy()/sell(), above the `_makeClient()` IIFE).
 * So they are safe to exercise offline — no RPC / CLOB / MetaMask involved.
 *
 * isConfigured() short-circuits to "Not configured" when there are no creds, so we
 * set non-placeholder POLY_* env creds for this file. The creds are NEVER used:
 * every case below is rejected by a validation guard before _keySource/_makeClient.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LiveBroker } from "../../src/banking/live.js";
import { MIN_ORDER_USD, MIN_SHARES } from "../../src/banking/models.js";

const SAVED: Record<string, string | undefined> = {};
const SET = {
  POLY_PRIVATE_KEY: "0x" + "1".repeat(64),
  POLY_WALLET_ADDRESS: "0x000000000000000000000000000000000000dEaD",
};

beforeAll(() => {
  for (const k of Object.keys(SET) as (keyof typeof SET)[]) {
    SAVED[k] = process.env[k];
    process.env[k] = SET[k];
  }
});

afterAll(() => {
  for (const k of Object.keys(SET)) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

const TOKEN = "0xtoken";

describe("LiveBroker.buy guards (no network)", () => {
  const b = new LiveBroker();

  it("rejects a missing token", async () => {
    const r = await b.buy("", 5);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("No token");
    expect(r.side).toBe("BUY");
    expect(r.shares).toBe(0);
  });

  it("rejects NaN amount", async () => {
    const r = await b.buy(TOKEN, NaN);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Invalid order amount");
  });

  it("rejects Infinity amount", async () => {
    const r = await b.buy(TOKEN, Infinity);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Invalid order amount");
  });

  it("rejects zero / negative amount", async () => {
    expect((await b.buy(TOKEN, 0)).error).toBe("Invalid order amount");
    expect((await b.buy(TOKEN, -3)).error).toBe("Invalid order amount");
  });

  it("rejects a buy below the $1 minimum", async () => {
    const r = await b.buy(TOKEN, 0.5);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(`Minimum order is $${MIN_ORDER_USD}`);
  });

  it("returns the full Fill error shape (no leaked creds)", async () => {
    const r = await b.buy(TOKEN, 0.5);
    expect(r).toMatchObject({
      token: TOKEN, side: "BUY", ok: false, shares: 0, price: 0,
      order_id: "", unconfirmed: false,
    });
    // Nothing money-bearing or secret leaks into the rejection.
    expect(JSON.stringify(r)).not.toContain("1111111111");
  });
});

describe("LiveBroker.sell guards (no network)", () => {
  const b = new LiveBroker();

  it("rejects a missing token", async () => {
    const r = await b.sell("", 5, 50);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Nothing to sell");
    expect(r.side).toBe("SELL");
  });

  it("rejects NaN / Infinity shares", async () => {
    expect((await b.sell(TOKEN, NaN, 50)).error).toBe("Invalid share amount");
    expect((await b.sell(TOKEN, Infinity, 50)).error).toBe("Invalid share amount");
  });

  it("rejects zero / negative shares", async () => {
    expect((await b.sell(TOKEN, 0, 50)).error).toBe("Invalid share amount");
    expect((await b.sell(TOKEN, -2, 50)).error).toBe("Invalid share amount");
  });

  it("rejects a dust sell below MIN_SHARES", async () => {
    const r = await b.sell(TOKEN, 0.001, 50);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(`Minimum sell is ${MIN_SHARES} shares`);
  });

  it("refuses a sell with no usable bid floor (missing minPrice)", async () => {
    const r = await b.sell(TOKEN, 5);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("No live bid — order not placed");
  });

  it("refuses a sell with a zero / negative floor", async () => {
    expect((await b.sell(TOKEN, 5, 0)).error).toBe("No live bid — order not placed");
    expect((await b.sell(TOKEN, 5, -1)).error).toBe("No live bid — order not placed");
  });
});
