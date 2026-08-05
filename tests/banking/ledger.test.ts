import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PaperLedger, START_BANKROLL, HISTORY_CAP } from "../../src/banking/ledger.js";

let tmpDir: string;
let ledgerPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
  ledgerPath = path.join(tmpDir, "paper_ledger.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeLedger(): PaperLedger {
  return new PaperLedger(ledgerPath);
}

describe("PaperLedger", () => {
  it("starts with START_BANKROLL cash", () => {
    const l = makeLedger();
    expect(l.cash).toBe(START_BANKROLL);
    expect(l.positions).toEqual({});
    expect(l.realized).toBe(0);
  });

  describe("buy", () => {
    it("deducts cash and opens a position", () => {
      const l = makeLedger();
      const r = l.buy("tok1", 10, 50); // 10 shares @ 50¢ = $5
      expect(r.ok).toBe(true);
      expect(r.error).toBe("");
      expect(r.usd_spent).toBeCloseTo(5.0, 5);
      expect(l.cash).toBeCloseTo(START_BANKROLL - 5.0, 5);
      expect(l.positions["tok1"]).toBeDefined();
      expect(l.positions["tok1"]!.shares).toBeCloseTo(10, 5);
    });

    it("rejects a buy exceeding cash", () => {
      const l = makeLedger();
      const r = l.buy("tok1", 1000, 99); // 1000 shares @ 99¢ = $990 > $100
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/insufficient/i);
      expect(r.usd_spent).toBe(0);
    });

    it("rejects shares <= 0", () => {
      const l = makeLedger();
      const r = l.buy("tok1", 0, 50);
      expect(r.ok).toBe(false);
    });

    it("extends an existing position", () => {
      const l = makeLedger();
      l.buy("tok1", 5, 50);
      l.buy("tok1", 5, 60);
      expect(l.positions["tok1"]!.shares).toBeCloseTo(10, 5);
    });
  });

  describe("sell", () => {
    it("buy then sell round-trip: verifies P&L and cash balance", () => {
      const l = makeLedger();
      l.buy("tok1", 10, 50);  // 10 shares @ 50¢ = $5 spent
      const r = l.sell("tok1", 10, 60); // 10 shares @ 60¢ = $6 recv
      expect(r.ok).toBe(true);
      expect(r.usd_recv).toBeCloseTo(6.0, 5);
      expect(l.cash).toBeCloseTo(START_BANKROLL - 5.0 + 6.0, 4);
      expect(l.realized).toBeCloseTo(1.0, 4); // $6 - $5 = $1 profit
    });

    it("rejects selling non-existent position", () => {
      const l = makeLedger();
      const r = l.sell("tok1", 10, 50);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/no virtual position/i);
    });

    it("removes position when fully sold", () => {
      const l = makeLedger();
      l.buy("tok1", 10, 50);
      l.sell("tok1", 10, 60);
      expect(l.positions["tok1"]).toBeUndefined();
    });

    it("realizes P&L correctly on partial sell", () => {
      const l = makeLedger();
      l.buy("tok1", 10, 50);  // cost_usd = $5
      const r = l.sell("tok1", 5, 60); // sell half @ 60¢ = $3, cost basis = $2.5
      expect(r.ok).toBe(true);
      expect(l.realized).toBeCloseTo(0.5, 4); // $3 - $2.5 = $0.50
      expect(l.positions["tok1"]!.shares).toBeCloseTo(5, 5);
    });
  });

  describe("settle", () => {
    it("settle(won=true): position redeems at $1", () => {
      const l = makeLedger();
      l.buy("tok1", 10, 50); // $5 cost
      const delta = l.settle("tok1", true);
      // 10 shares * $1 = $10 payout; delta = $10 - $5 = $5
      expect(delta).toBeCloseTo(5.0, 4);
      expect(l.cash).toBeCloseTo(START_BANKROLL - 5.0 + 10.0, 4);
      expect(l.wins).toBe(1);
      expect(l.losses).toBe(0);
      expect(l.positions["tok1"]).toBeUndefined();
    });

    it("settle(won=false): position redeems at $0", () => {
      const l = makeLedger();
      l.buy("tok1", 10, 50); // $5 cost
      const delta = l.settle("tok1", false);
      // 0 payout; delta = $0 - $5 = -$5
      expect(delta).toBeCloseTo(-5.0, 4);
      expect(l.cash).toBeCloseTo(START_BANKROLL - 5.0, 4);
      expect(l.wins).toBe(0);
      expect(l.losses).toBe(1);
      expect(l.positions["tok1"]).toBeUndefined();
    });

    it("settle on non-existent token returns 0", () => {
      const l = makeLedger();
      const delta = l.settle("nonexistent", true);
      expect(delta).toBe(0.0);
    });
  });

  describe("reset", () => {
    it("clears positions and realized, preserves nothing in practice mode", () => {
      const l = makeLedger();
      l.buy("tok1", 10, 50);
      l.settle("tok1", true); // wins++, lifetime_profit accumulates
      expect(l.wins).toBe(1);
      l.reset();
      expect(l.cash).toBe(START_BANKROLL);
      expect(l.positions).toEqual({});
      expect(l.realized).toBe(0);
      expect(l.wins).toBe(0);
      expect(l.losses).toBe(0);
      expect(l.lifetime_profit).toBe(0);
      expect(l.history).toEqual([]);
    });
  });

  describe("stats", () => {
    it("returns zeros when no trades", () => {
      const l = makeLedger();
      const s = l.stats();
      expect(s.wins).toBe(0);
      expect(s.losses).toBe(0);
      expect(s.accuracy).toBe(0);
      expect(s.lifetime_profit).toBe(0);
    });

    it("accuracy = wins / (wins+losses) * 100", () => {
      const l = makeLedger();
      // 2 wins 1 loss = 66.7%
      l.buy("t1", 1, 50); l.settle("t1", true);
      l.buy("t2", 1, 50); l.settle("t2", true);
      l.buy("t3", 1, 50); l.settle("t3", false);
      const s = l.stats();
      expect(s.wins).toBe(2);
      expect(s.losses).toBe(1);
      expect(s.accuracy).toBeCloseTo(66.7, 0);
    });
  });

  describe("history cap", () => {
    it("caps history at HISTORY_CAP events", () => {
      const l = makeLedger();
      // Buy 1 share many times to fill history
      for (let i = 0; i < HISTORY_CAP + 10; i++) {
        const tok = `tok${i}`;
        // Buy very small so we don't run out of cash
        l.buy(tok, 0.001, 1);
      }
      expect(l.history.length).toBeLessThanOrEqual(HISTORY_CAP);
    });
  });

  describe("persistence", () => {
    it("persists and reloads state correctly", () => {
      const l1 = makeLedger();
      l1.buy("tok1", 5, 50);
      l1.settle("tok1", true);

      const l2 = new PaperLedger(ledgerPath);
      expect(l2.cash).toBeCloseTo(l1.cash, 4);
      expect(l2.wins).toBe(1);
      expect(l2.lifetime_profit).toBeCloseTo(l1.lifetime_profit, 4);
    });
  });

  describe("withdraw", () => {
    it("debits cash and accrues transferred_out", () => {
      const l = makeLedger();
      const ok = l.withdraw(20.0);
      expect(ok).toBe(true);
      expect(l.cash).toBeCloseTo(START_BANKROLL - 20.0, 4);
      expect(l.transferred_out).toBeCloseTo(20.0, 4);
    });

    it("rejects overdraft", () => {
      const l = makeLedger();
      const ok = l.withdraw(200.0);
      expect(ok).toBe(false);
      expect(l.cash).toBe(START_BANKROLL);
    });
  });
});
