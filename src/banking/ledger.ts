/**
 * Virtual ledger for PRACTICE (paper) mode.
 *
 * A tiny, self-contained double-entry-ish ledger:
 *   - cash:      virtual USD available to trade (starts at $100)
 *   - positions: token -> {shares, cost_usd, outcome, asset}
 *   - realized:  lifetime realized P&L in USD
 *
 * Persists to a JSON file so practice survives hot-reload / restart.
 * NO market data lives here — quotes come from the live broker/state.
 * The ledger only knows shares and dollars; PaperBroker feeds it live prices.
 */

import fs from "fs";
import os from "os";
import path from "path";

export const HISTORY_CAP = 300;
export const START_BANKROLL = 100.0;

export interface LedgerPosition {
  shares: number;
  cost_usd: number;
  outcome: string;
  asset: string;
}

export interface LedgerState {
  cash: number;
  positions: Record<string, LedgerPosition>;
  realized: number;
  wins: number;
  losses: number;
  lifetime_profit: number;
  transferred_out: number;
  history: Record<string, unknown>[];
}

export interface BuyResult {
  ok: boolean;
  error: string;
  usd_spent: number;
}

export interface SellResult {
  ok: boolean;
  error: string;
  usd_recv: number;
}

export interface LedgerStats {
  wins: number;
  losses: number;
  accuracy: number;
  lifetime_profit: number;
  transferred_out: number;
}

function dataDir(): string {
  const d = (process.env["TC_DATA_DIR"] ?? "").trim();
  const base = d ? d : path.join(os.homedir(), ".triplecrypt");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

export class PaperLedger {
  readonly path: string;
  cash: number = START_BANKROLL;
  positions: Record<string, LedgerPosition> = {};
  realized: number = 0.0;
  wins: number = 0;
  losses: number = 0;
  lifetime_profit: number = 0.0;
  transferred_out: number = 0.0;
  history: Record<string, unknown>[] = [];

  constructor(ledgerPath?: string) {
    this.path = ledgerPath ?? path.join(dataDir(), "paper_ledger.json");
    this._load();
  }

  // ── persistence ─────────────────────────────────────────────────────────────

  private _load(): void {
    try {
      if (fs.existsSync(this.path)) {
        const raw = fs.readFileSync(this.path, "utf8");
        const d = JSON.parse(raw) as Partial<LedgerState>;
        this.cash = parseFloat(String(d.cash ?? START_BANKROLL));
        this.realized = parseFloat(String(d.realized ?? 0.0));
        this.wins = parseInt(String(d.wins ?? 0), 10);
        this.losses = parseInt(String(d.losses ?? 0), 10);
        this.lifetime_profit = parseFloat(String(d.lifetime_profit ?? 0.0));
        this.transferred_out = parseFloat(String(d.transferred_out ?? 0.0));
        const rawPos = d.positions ?? {};
        this.positions = {};
        for (const [k, v] of Object.entries(rawPos)) {
          if (v && typeof v === "object") {
            this.positions[String(k)] = {
              shares:   parseFloat(String((v as LedgerPosition).shares ?? 0.0)),
              cost_usd: parseFloat(String((v as LedgerPosition).cost_usd ?? 0.0)),
              outcome:  String((v as LedgerPosition).outcome ?? "?"),
              asset:    String((v as LedgerPosition).asset ?? "?"),
            };
          }
        }
        const hist = d.history ?? [];
        this.history = Array.isArray(hist) ? hist.slice(-HISTORY_CAP) : [];
      }
    } catch (e) {
      console.warn("paper ledger load failed (%s) — starting fresh", e);
      this.cash = START_BANKROLL;
      this.positions = {};
      this.realized = 0.0;
      this.wins = 0;
      this.losses = 0;
      this.lifetime_profit = 0.0;
      this.transferred_out = 0.0;
    }
  }

  private _save(): void {
    /** Atomic write so a crash mid-write can't corrupt the ledger. */
    try {
      const payload = JSON.stringify({
        cash:             round6(this.cash),
        realized:         round6(this.realized),
        wins:             this.wins,
        losses:           this.losses,
        lifetime_profit:  round6(this.lifetime_profit),
        transferred_out:  round6(this.transferred_out),
        positions:        this.positions,
        history:          this.history.slice(-HISTORY_CAP),
      });
      const dir = path.dirname(this.path);
      const tmp = path.join(dir, `.paper_ledger_${Date.now()}.tmp`);
      fs.writeFileSync(tmp, payload, { mode: 0o600 });
      fs.renameSync(tmp, this.path);
    } catch (e) {
      console.warn("paper ledger save failed:", e);
    }
  }

  // ── mutations ────────────────────────────────────────────────────────────────

  private _log(kind: string, token: string, fields: Record<string, unknown>): void {
    this.history.push({ ts: Math.floor(Date.now() / 1000), kind, token, ...fields });
    if (this.history.length > HISTORY_CAP) {
      this.history = this.history.slice(-HISTORY_CAP);
    }
  }

  reset(): void {
    this.cash = START_BANKROLL;
    this.positions = {};
    this.realized = 0.0;
    this.wins = 0;
    this.losses = 0;
    this.lifetime_profit = 0.0;
    this.transferred_out = 0.0;
    this.history = [];
    this._save();
  }

  buy(
    token: string,
    shares: number,
    priceCents: number,
    outcome = "?",
    asset = "?",
  ): BuyResult {
    if (shares <= 0) return { ok: false, error: "Nothing to buy", usd_spent: 0.0 };
    const usd = round6(shares * priceCents / 100.0);
    if (usd > this.cash + 1e-9) {
      return { ok: false, error: `Insufficient virtual cash (have $${this.cash.toFixed(2)})`, usd_spent: 0.0 };
    }
    const pos: LedgerPosition = this.positions[token] ?? {
      shares: 0.0, cost_usd: 0.0,
      outcome,
      asset,
    };
    pos.shares   = round6(pos.shares + shares);
    pos.cost_usd = round6(pos.cost_usd + usd);
    pos.outcome  = outcome !== "?" ? outcome : (pos.outcome ?? "?");
    pos.asset    = asset !== "?" ? asset : (pos.asset ?? "?");
    this.positions[token] = pos;
    this.cash = round6(this.cash - usd);
    this._log("buy", token, { shares, price: priceCents, usd, outcome, asset });
    this._save();
    return { ok: true, error: "", usd_spent: usd };
  }

  sell(token: string, shares: number, priceCents: number): SellResult {
    const pos = this.positions[token];
    if (!pos || pos.shares <= 0) return { ok: false, error: "No virtual position to sell", usd_recv: 0.0 };
    const sellShares = Math.min(shares, pos.shares);
    if (sellShares <= 0) return { ok: false, error: "Nothing to sell", usd_recv: 0.0 };
    const usd = round6(sellShares * priceCents / 100.0);
    const frac = pos.shares > 0 ? sellShares / pos.shares : 0.0;
    const costSlice = round6(pos.cost_usd * frac);
    const delta = round6(usd - costSlice);
    this.realized = round6(this.realized + delta);
    this.lifetime_profit = round6(this.lifetime_profit + delta);
    this.cash = round6(this.cash + usd);
    pos.shares   = round6(pos.shares - sellShares);
    pos.cost_usd = round6(pos.cost_usd - costSlice);
    const asset   = pos.asset ?? "?";
    const outcome = pos.outcome ?? "?";
    if (pos.shares <= 1e-6) {
      delete this.positions[token];
    } else {
      this.positions[token] = pos;
    }
    this._log("sell", token, { shares: sellShares, price: priceCents, usd, pnl: delta, outcome, asset });
    this._save();
    return { ok: true, error: "", usd_recv: usd };
  }

  settle(token: string, won: boolean): number {
    const pos = this.positions[token];
    delete this.positions[token];
    if (!pos || pos.shares <= 0) return 0.0;
    const payout = round6(pos.shares * (won ? 1.0 : 0.0));
    const delta  = round6(payout - pos.cost_usd);
    this.realized = round6(this.realized + delta);
    this.lifetime_profit = round6(this.lifetime_profit + delta);
    if (won) {
      this.wins++;
    } else {
      this.losses++;
    }
    this.cash = round6(this.cash + payout);
    this._log("settle", token, {
      won, payout, pnl: delta,
      outcome: pos.outcome ?? "?",
      asset:   pos.asset ?? "?",
    });
    this._save();
    return delta;
  }

  withdraw(usd: number): boolean {
    const amount = round6(parseFloat(String(usd)));
    if (amount <= 0 || amount > this.cash + 1e-9) return false;
    this.cash = round6(this.cash - amount);
    this.transferred_out = round6(this.transferred_out + amount);
    this._save();
    return true;
  }

  stats(): LedgerStats {
    const total = this.wins + this.losses;
    const accuracy = total > 0 ? round1(this.wins / total * 100.0) : 0.0;
    return {
      wins:            this.wins,
      losses:          this.losses,
      accuracy,
      lifetime_profit: round2(this.lifetime_profit),
      transferred_out: round2(this.transferred_out),
    };
  }

  avgPriceCents(token: string): number {
    const pos = this.positions[token];
    if (!pos || pos.shares <= 0) return 0.0;
    return round2(pos.cost_usd / pos.shares * 100.0);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function round6(n: number): number { return Math.round(n * 1e6) / 1e6; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
function round1(n: number): number { return Math.round(n * 10) / 10; }
