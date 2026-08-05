/**
 * PaperBroker — PRACTICE mode against a virtual $100 ledger.
 *
 * Identical Broker surface to LiveBroker, so the UI is byte-identical.
 * Orders fill against the virtual ledger, not the chain.
 *
 * Live prices are NOT polled here. The broker is handed a `quoteFn` (an async
 * callable token -> Quote) that reads the SAME live best-bid/ask the UI already
 * streams. So:
 *   - buy()    fills at the live ASK (debits virtual cash, opens/extends position)
 *   - sell()   fills at the live BID (credits cash, realizes P&L)
 *   - settle() (on window close) redeems at $1 won / $0 lost
 *
 * No credentials required — that's the whole value.
 */

import type { Broker } from "./broker.js";
import { PaperLedger, START_BANKROLL } from "./ledger.js";
import type {
  WalletInfo, Portfolio, Position, Stats, Quote, Fill, OrderResult
} from "./models.js";

export type QuoteFn = (token: string) => Promise<Quote>;

async function zeroQuote(token: string): Promise<Quote> {
  return { token, bid: 0, ask: 0, outcome: "?", asset: "?" };
}

export class PaperBroker implements Broker {
  readonly mode = "practice";

  private readonly _ledger: PaperLedger;
  private _quoteFn: QuoteFn;
  // Async mutex via a promise chain — simple, no external dep.
  private _lock: Promise<void> = Promise.resolve();

  constructor(quoteFn?: QuoteFn) {
    this._ledger = new PaperLedger();
    this._quoteFn = quoteFn ?? zeroQuote;
  }

  setQuoteFn(quoteFn: QuoteFn): void {
    this._quoteFn = quoteFn;
  }

  get startBankroll(): number { return START_BANKROLL; }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async _withLock<T>(fn: () => T): Promise<T> {
    let resolve!: () => void;
    const next = new Promise<void>(r => { resolve = r; });
    const prev = this._lock;
    this._lock = next;
    await prev;
    try {
      return fn();
    } finally {
      resolve();
    }
  }

  // ── balances ──────────────────────────────────────────────────────────────────

  async wallet(): Promise<WalletInfo> {
    return {
      // No real wallet in practice — paper cash is NOT on-chain USDC, so the
      // wallet fields are zero (the bankroll surfaces via stats cash/spendable).
      // Reporting cash here leaked the practice balance into the live "USDC" row.
      address:     "",
      native_usdc: 0.0,
      usdc_e:      0.0,
      total:       0.0,
    };
  }

  async cash(): Promise<number> {
    return round2(this._ledger.cash);
  }

  async quote(token: string): Promise<Quote> {
    try {
      return await this._quoteFn(token);
    } catch (e) {
      console.warn("paper quote() error:", e);
      return { token, bid: 0, ask: 0, outcome: "?", asset: "?" };
    }
  }

  async portfolio(): Promise<Portfolio> {
    // Snapshot positions outside lock, then fetch quotes
    const items = await this._withLock(() =>
      Object.entries(this._ledger.positions)
    );

    const positions: Position[] = [];
    let total = 0.0;
    let unreal = 0.0;

    for (const [token, pos] of items) {
      const shares = pos.shares;
      if (shares <= 0) continue;
      const q = await this.quote(token);
      const bid = q.bid;
      const avg = shares > 0 ? round2(pos.cost_usd / shares * 100.0) : 0.0;
      const value = round2(shares * bid / 100.0);
      const cost = round2(pos.cost_usd);
      const pnl = round2(value - cost);
      total += value;
      unreal += pnl;
      positions.push({
        token,
        condition_id: "",
        outcome:       pos.outcome ?? "?",
        asset:         pos.asset ?? "?",
        shares,
        avg_price:     avg,
        cur_price:     bid,
        value,
        cost_basis:    cost,
        unrealized_pnl: pnl,
        settled:       false,
      });
    }

    return {
      positions,
      total_value: round2(total),
      unrealized:  round2(unreal),
      realized:    round2(this._ledger.realized),
    };
  }

  async stats(opts?: { cash?: number; wallet?: WalletInfo; portfolio?: Portfolio }): Promise<Stats> {
    const s = this._ledger.stats();
    const free = opts?.cash ?? round2(this._ledger.cash);
    const port = opts?.portfolio ?? await this.portfolio();
    return {
      cash:            round2(free + port.total_value),
      spendable:       free,
      wallet:          0.0,
      has_wallet:      false,
      profit:          round2(s.lifetime_profit + port.unrealized),
      accuracy:        s.accuracy,
      wins:            s.wins,
      losses:          s.losses,
      transferred_out: s.transferred_out,
    };
  }

  // ── orders ────────────────────────────────────────────────────────────────────

  async buy(token: string, usd: number, maxPrice = 99.0): Promise<Fill> {
    if (!token) return emptyFill("BUY", "", false, "No token");
    if (usd <= 0) return emptyFill("BUY", token, false, "Invalid size");
    const q = await this.quote(token);
    const ask = q.ask;
    if (ask <= 0 || ask > maxPrice) {
      return emptyFill("BUY", token, false, `No fill — ask ${ask.toFixed(1)}¢ over cap ${maxPrice.toFixed(0)}¢`);
    }
    const shares = round6(usd / (ask / 100.0));
    const result = await this._withLock(() =>
      this._ledger.buy(token, shares, ask, q.outcome ?? "?", q.asset ?? "?")
    );
    return {
      token, side: "BUY", shares, price: ask,
      usd: round2(result.usd_spent),
      ok: result.ok, error: result.error,
      order_id: result.ok ? "paper" : "",
      unconfirmed: false,
    };
  }

  async sell(token: string, shares: number, minPrice = 1.0): Promise<Fill> {
    if (!token || shares <= 0) return emptyFill("SELL", token, false, "Nothing to sell");
    const q = await this.quote(token);
    const bid = q.bid;
    if (bid < minPrice) {
      return emptyFill("SELL", token, false, `No fill — bid ${bid.toFixed(1)}¢ under floor ${minPrice.toFixed(0)}¢`);
    }
    const result = await this._withLock(() =>
      this._ledger.sell(token, shares, bid)
    );
    return {
      token, side: "SELL", shares, price: bid,
      usd: round2(result.usd_recv),
      ok: result.ok, error: result.error,
      order_id: result.ok ? "paper" : "",
      unconfirmed: false,
    };
  }

  /**
   * Close a position at its cost basis (zero P&L) — used when the market has
   * expired/has no live bid, so a practice holding can never get stranded.
   */
  async close(token: string): Promise<Fill> {
    return this._withLock(() => {
      const pos = this._ledger.positions[token];
      if (!pos || pos.shares <= 0) return emptyFill("SELL", token, false, "Nothing to close");
      const shares = pos.shares;
      const avgCents = round2((pos.cost_usd / shares) * 100.0);
      const result = this._ledger.sell(token, shares, avgCents);
      return {
        token, side: "SELL", shares, price: avgCents,
        usd: round2(result.usd_recv),
        ok: result.ok, error: result.error,
        order_id: result.ok ? "paper" : "",
        unconfirmed: false,
      };
    });
  }

  async ensureReady(): Promise<OrderResult> {
    return { ok: true, error: "", detail: "practice — no approvals needed" };
  }

  // ── wallet / money management ──────────────────────────────────────────────────

  async depositAddress(): Promise<Record<string, never>> {
    return {};
  }

  async txHistory(_limit = 25): Promise<Record<string, unknown>[]> {
    return [];
  }

  async send(_usdc: number, _to: string): Promise<OrderResult> {
    return { ok: false, error: "Not available in practice", detail: "" };
  }

  async redeem(_conditionId: string): Promise<OrderResult> {
    return { ok: true, error: "", detail: "practice — settles automatically" };
  }

  async swap(_from: string, _to: string, _amount: number): Promise<OrderResult> {
    return { ok: false, error: "Not available in practice", detail: "" };
  }

  async topUpGas(): Promise<OrderResult> {
    return { ok: true, error: "", detail: "practice — no gas needed" };
  }

  // ── practice-only extras (not on the Broker interface; called by State) ────────

  async settle(token: string, won: boolean): Promise<number> {
    return this._withLock(() => this._ledger.settle(token, won));
  }

  async heldTokens(): Promise<string[]> {
    return this._withLock(() =>
      Object.entries(this._ledger.positions)
        .filter(([, p]) => p.shares > 0)
        .map(([t]) => t)
    );
  }

  async resetPractice(): Promise<void> {
    await this._withLock(() => { this._ledger.reset(); });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round6(n: number): number { return Math.round(n * 1e6) / 1e6; }

function emptyFill(side: string, token: string, ok: boolean, error: string): Fill {
  return { token, side, shares: 0, price: 0, usd: 0, ok, error, order_id: "", unconfirmed: false };
}
