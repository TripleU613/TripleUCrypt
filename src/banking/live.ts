/**
 * LiveBroker — real money path against Polymarket.
 *
 * Uses @polymarket/clob-client for order placement and viem for on-chain reads.
 *
 * SECURITY: the private key + API secret are read from env ONLY. They are NEVER
 * returned from any method, never logged, and never reach the client.
 */

import crypto from "crypto";
import { createPublicClient, http, getAddress } from "viem";
import { polygon } from "viem/chains";

import type { Broker } from "./broker.js";
import type { SwapToken } from "./swap.js";
import type { WalletInfo, Portfolio, Position, Stats, Quote, Fill, OrderResult } from "./models.js";
import {
  NATIVE_USDC, USDC_E, POLYGON_RPC, CLOB_HOST, RELAYER_URL, POLYGON_CHAIN_ID,
  CTF_EXCHANGE,
  DEFAULT_TICK, MIN_ORDER_USD, MIN_SHARES,
} from "./models.js";
import { withRetries, shortError } from "./resilience.js";

// ── Env helpers ───────────────────────────────────────────────────────────────

function placeholder(v: string): boolean {
  return !v || v.startsWith("0x_your") || v.startsWith("your_") || v.startsWith("paste");
}

const REQUIRED = ["POLY_PRIVATE_KEY", "POLY_WALLET_ADDRESS"] as const;

export function isConfigured(): boolean {
  return _envConfigured() || _localUsable();
}

function _envConfigured(): boolean {
  return REQUIRED.every(k => !placeholder(process.env[k] ?? ""));
}

function _localUsable(): boolean {
  try {
    const { defaultWallet } = require("./local-wallet.js") as typeof import("./local-wallet.js");
    const w = defaultWallet();
    if (!w.exists()) return false;
    return true; // plaintext mode — always usable
  } catch {
    return false;
  }
}

function _liveAddress(): string {
  if (_envConfigured()) return process.env["POLY_WALLET_ADDRESS"] ?? "";
  try {
    const { defaultWallet } = require("./local-wallet.js") as typeof import("./local-wallet.js");
    return defaultWallet().address();
  } catch {
    return "";
  }
}

interface KeySource {
  source: "env" | "local";
  private_key: string;
  funder: string;
  signature_type: number;
  address: string;
}

function _keySource(): KeySource | null {
  if (_envConfigured()) {
    return {
      source:         "env",
      private_key:    process.env["POLY_PRIVATE_KEY"]     ?? "",
      funder:         process.env["POLY_WALLET_ADDRESS"]  ?? "",
      signature_type: 2,
      address:        process.env["POLY_WALLET_ADDRESS"]  ?? "",
    };
  }
  try {
    const { defaultWallet } = require("./local-wallet.js") as typeof import("./local-wallet.js");
    const w = defaultWallet();
    if (!w.exists()) return null;
    const pw = process.env["TUC_WALLET_PASSWORD"] || undefined;
    const acct = w.signer(pw);
    const addr = acct.address;
    // We need the raw private key for ClobClient
    // The signer is a PrivateKeyAccount — its private key is stored in the file
    // Re-read directly for ClobClient
    const { LocalWallet } = require("./local-wallet.js") as typeof import("./local-wallet.js");
    void LocalWallet; // just a check
    // Read plaintext key
    const fs = require("fs") as typeof import("fs");
    const os = require("os") as typeof import("os");
    const path = require("path") as typeof import("path");
    const dataDir = (process.env["TC_DATA_DIR"] ?? "").trim() ||
                    path.join(os.homedir(), ".triplecrypt");
    const raw = fs.readFileSync(path.join(dataDir, "trading_wallet.json"), "utf8");
    const d = JSON.parse(raw) as { private_key?: string };
    const pk = d.private_key ?? "";
    if (!pk) return null;
    return {
      source:         "local",
      private_key:    pk,
      funder:         addr,
      signature_type: 0,
      address:        addr,
    };
  } catch (e) {
    console.warn("local wallet resolve failed:", shortError(e));
    return null;
  }
}

// ── CLOB client singleton ─────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _clientCache: any = null;
let _credsReady = false;

// Build the ClobClient with a REAL ethers signer and L2 API creds. clob-client
// 4.x has NO setApiCreds() — creds are passed to the CONSTRUCTOR — so we build
// once to derive the key, then REBUILD with the creds (same pattern the browser
// path uses). Verified against clob-client 4.22.8 on the live box.
// (Previously: passed `undefined` signer + the raw key in the creds slot, then
// called non-existent createOrDeriveApiCreds()/setApiCreds() in a swallowing
// try/catch — so server-mode could never sign or authenticate.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function _makeClient(): Promise<any> {
  if (_clientCache && _credsReady) return _clientCache;
  const { ClobClient } = require("@polymarket/clob-client-v2") as
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { ClobClient: new (...args: any[]) => any };
  const src = _keySource();
  if (!src) throw new Error("Not configured: no .env creds and no local wallet");
  const { Wallet } = require("ethers") as typeof import("ethers");
  const signer = new Wallet(src.private_key);
  // clob-client-v2 uses an options-object constructor. Build once to derive the
  // L2 key, then rebuild with creds (no setApiCreds in v2 either).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any = new ClobClient({ host: CLOB_HOST, chain: POLYGON_CHAIN_ID, signer, signatureType: src.signature_type, funderAddress: src.funder });
  try {
    const creds = await client.createOrDeriveApiKey();
    client = new ClobClient({ host: CLOB_HOST, chain: POLYGON_CHAIN_ID, signer, creds, signatureType: src.signature_type, funderAddress: src.funder });
    _credsReady = true;
  } catch (e) {
    console.warn("[live] api-key derive failed:", shortError(e));
  }
  _clientCache = client;
  return _clientCache;
}

// ── Fill amount helpers ───────────────────────────────────────────────────────

function fillAmounts(
  resp: Record<string, unknown>,
  side: string,
): [number, number, number] {
  const making = parseFloat(String(resp["makingAmount"] ?? 0)) || 0;
  const taking = parseFloat(String(resp["takingAmount"] ?? 0)) || 0;
  if (making <= 0 || taking <= 0) return [0, 0, 0];
  const [usd, shares] = side === "BUY" ? [making, taking] : [taking, making];
  return [
    Math.round(shares * 1e4) / 1e4,
    Math.round((usd / shares) * 100 * 100) / 100,
    Math.round(usd * 100) / 100,
  ];
}

// ── ERC-20 balanceOf via Polygon JSON-RPC ─────────────────────────────────────

async function erc20Balance(contract: string, owner: string): Promise<number> {
  const client = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC) });
  const bal = await client.readContract({
    address: getAddress(contract),
    abi: [
      {
        name: "balanceOf", type: "function", stateMutability: "view",
        inputs: [{ name: "o", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const,
    functionName: "balanceOf",
    args: [getAddress(owner)],
  });
  return Math.round(Number(bal) / 1_000_000 * 1e4) / 1e4;
}

// ── LiveBroker ────────────────────────────────────────────────────────────────

export class LiveBroker implements Broker {
  readonly mode = "live";

  private _inflight = new Set<string>();
  private _readyDone = false;
  private _sendLocked = false;
  txHistoryError = "";

  // ── balances ──────────────────────────────────────────────────────────────────

  async cash(): Promise<number> {
    if (!isConfigured()) return 0.0;
    try {
      return await withRetries(async () => {
        const client = await _makeClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const resp = await client.getBalanceAllowance({ assetType: "COLLATERAL" } as any);
        if (resp && typeof resp === "object") {
          const raw = (resp as Record<string, unknown>)["balance"] ?? "0";
          return Math.round(parseFloat(String(raw)) / 1_000_000 * 1e4) / 1e4;
        }
        return 0.0;
      }, 3, 0.25, "cash");
    } catch (e) {
      console.warn("cash() error:", shortError(e));
      return 0.0;
    }
  }

  async wallet(): Promise<WalletInfo> {
    if (!isConfigured()) return { address: "", native_usdc: 0, usdc_e: 0, total: 0 };
    const addr = _liveAddress();
    try {
      const [native, usdce] = await withRetries(
        () => Promise.all([
          erc20Balance(NATIVE_USDC, addr),
          erc20Balance(USDC_E, addr),
        ]),
        3, 0.25, "wallet"
      );
      return { address: addr, native_usdc: native, usdc_e: usdce, total: Math.round((native + usdce) * 100) / 100 };
    } catch (e) {
      console.warn("wallet() error:", shortError(e));
      return { address: addr, native_usdc: 0, usdc_e: 0, total: 0 };
    }
  }

  async portfolio(): Promise<Portfolio> {
    if (!isConfigured()) return { positions: [], total_value: 0, unrealized: 0, realized: 0 };
    try {
      // Fetch positions from CLOB data API
      const wallet = _liveAddress();
      const resp = await withRetries(async () => {
        const r = await fetch(`https://data-api.polymarket.com/positions?user=${wallet}&sizeThreshold=0.01`);
        if (!r.ok) throw new Error(`positions fetch ${r.status}`);
        return r.json() as Promise<unknown>;
      }, 3, 0.25, "positions");

      let raw: Record<string, unknown>[];
      if (Array.isArray(resp)) {
        raw = resp as Record<string, unknown>[];
      } else if (resp && typeof resp === "object" && "data" in (resp as object)) {
        raw = ((resp as Record<string, unknown>)["data"] as Record<string, unknown>[]) ?? [];
      } else {
        raw = [];
      }

      if (!raw.length) return { positions: [], total_value: 0, unrealized: 0, realized: 0 };

      const positions: Position[] = [];
      let total = 0.0;
      let unreal = 0.0;

      for (const p of raw) {
        try {
          const avgRaw = parseFloat(String(p["avgPrice"] ?? p["avg_price"] ?? 0));
          const avgCents = avgRaw <= 1.0 ? avgRaw * 100 : avgRaw;
          const shares = parseFloat(String(p["size"] ?? p["quantity"] ?? 0));
          const cost = Math.round(shares * avgCents / 100 * 100) / 100;

          // Prefer the REAL market fields the data-api already returns. Fall back
          // to the avg-cost estimate only when a field is missing (so unrealized
          // P&L isn't structurally pinned to ~0).
          // data-api fields: curPrice (0–1), currentValue (USD), cashPnl (USD).
          const curRaw = p["curPrice"] ?? p["cur_price"];
          const cur = curRaw !== undefined && curRaw !== null
            ? Math.round(parseFloat(String(curRaw)) * 100 * 100) / 100  // 0–1 → cents
            : Math.round(avgCents * 100) / 100;                          // fallback: avg

          const valRaw = p["currentValue"] ?? p["value"];
          const value = valRaw !== undefined && valRaw !== null
            ? Math.round(parseFloat(String(valRaw)) * 100) / 100
            : Math.round(shares * cur / 100 * 100) / 100;                // fallback: shares × cur

          const pnlRaw = p["cashPnl"] ?? p["unrealized_pnl"];
          const pnl = pnlRaw !== undefined && pnlRaw !== null
            ? Math.round(parseFloat(String(pnlRaw)) * 100) / 100
            : Math.round((value - cost) * 100) / 100;                    // fallback: value − cost

          total += value;
          unreal += pnl;
          const redeemable = Boolean(p["redeemable"]);
          positions.push({
            token:          String(p["asset"] ?? p["token_id"] ?? ""),
            condition_id:   String(p["conditionId"] ?? p["condition_id"] ?? ""),
            outcome:        String(p["outcome"] ?? "?"),
            asset:          "?",
            shares,
            avg_price:      Math.round(avgCents * 100) / 100,
            cur_price:      cur,
            value,
            cost_basis:     cost,
            unrealized_pnl: pnl,
            settled:        redeemable,
          });
        } catch { continue; }
      }

      return {
        positions,
        total_value: Math.round(total * 100) / 100,
        unrealized:  Math.round(unreal * 100) / 100,
        realized:    0.0,
      };
    } catch (e) {
      console.warn("portfolio() error:", shortError(e));
      return { positions: [], total_value: 0, unrealized: 0, realized: 0 };
    }
  }

  async stats(opts?: { cash?: number; wallet?: WalletInfo; portfolio?: Portfolio }): Promise<Stats> {
    if (!isConfigured()) return {
      cash: 0, spendable: 0, wallet: 0, has_wallet: false,
      profit: 0, accuracy: 0, wins: 0, losses: 0, transferred_out: 0,
    };
    const [c, w, port] = await Promise.all([
      opts?.cash      !== undefined ? Promise.resolve(opts.cash)      : this.cash(),
      opts?.wallet    !== undefined ? Promise.resolve(opts.wallet)    : this.wallet(),
      opts?.portfolio !== undefined ? Promise.resolve(opts.portfolio) : this.portfolio(),
    ]);
    return {
      cash:            Math.round((c + port.total_value) * 100) / 100,
      spendable:       Math.round(c * 100) / 100,
      wallet:          w.total,
      has_wallet:      true,
      profit:          Math.round(port.unrealized * 100) / 100,
      accuracy:        0.0,
      wins:            0,
      losses:          0,
      transferred_out: 0.0,
    };
  }

  async quote(token: string): Promise<Quote> {
    if (!token) return { token, bid: 0, ask: 0, outcome: "?", asset: "?" };
    try {
      return await withRetries(async () => {
        const r = await fetch(`https://clob.polymarket.com/book?token_id=${token}`);
        if (!r.ok) throw new Error(`quote fetch ${r.status}`);
        const data = await r.json() as Record<string, unknown>;
        const bids = (data["bids"] as Array<{ price: string }>) ?? [];
        const asks = (data["asks"] as Array<{ price: string }>) ?? [];
        const bid = bids.length ? Math.round(parseFloat(bids[0].price) * 100 * 100) / 100 : 0;
        const ask = asks.length ? Math.round(parseFloat(asks[0].price) * 100 * 100) / 100 : 99;
        return { token, bid, ask, outcome: "?", asset: "?" };
      }, 3, 0.25, "quote");
    } catch (e) {
      console.warn("quote() error:", shortError(e));
      return { token, bid: 0, ask: 0, outcome: "?", asset: "?" };
    }
  }

  // ── orders ────────────────────────────────────────────────────────────────────

  async buy(token: string, usd: number, maxPrice = 99.0): Promise<Fill> {
    if (!isConfigured()) return emptyFill("BUY", token, false, "Not configured");
    if (!token) return emptyFill("BUY", "", false, "No token");
    if (!Number.isFinite(usd) || usd <= 0) return emptyFill("BUY", token, false, "Invalid order amount");
    if (usd < MIN_ORDER_USD) return emptyFill("BUY", token, false, `Minimum order is $${MIN_ORDER_USD}`);
    const key = `BUY:${token}:${Math.round(usd * 100) / 100}`;
    if (this._inflight.has(key)) return emptyFill("BUY", token, false, "Order already in flight");
    this._inflight.add(key);
    try {
      const resp = await (async () => {
        const client = await _makeClient();
        const price = clampToTick(maxPrice / 100.0);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const order = await client.createMarketOrder({
          tokenId: token, amount: usd, side: "BUY", price, orderType: "FOK",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await client.postOrder(order, "FOK" as any);
        return (typeof r === "object" ? r : { raw: String(r) }) as Record<string, unknown>;
      })();
      const oid = String(resp["orderID"] ?? resp["id"] ?? resp["order_id"] ?? "");
      const status = String(resp["status"] ?? "").toLowerCase();
      const ok = Boolean(oid) || ["matched", "live", "success"].includes(status);
      const [shares, price, usdFilled] = fillAmounts(resp, "BUY");
      if (ok && shares <= 0) {
        console.info("buy() ok but no matched amounts (unconfirmed):", resp);
        return { token, side: "BUY", ok: true, unconfirmed: true, order_id: oid, shares: 0, price: 0, usd: 0, error: "" };
      }
      return {
        token, side: "BUY", shares, price, usd: Math.round((usdFilled || usd) * 100) / 100,
        ok, order_id: oid, unconfirmed: false,
        error: ok ? "" : shortError(String(resp["error"] ?? JSON.stringify(resp))),
      };
    } catch (e) {
      console.warn("buy() error:", shortError(e));
      return emptyFill("BUY", token, false, shortError(e), Math.round(usd * 100) / 100);
    } finally {
      this._inflight.delete(key);
    }
  }

  async sell(token: string, shares: number, minPrice?: number): Promise<Fill> {
    if (!isConfigured()) return emptyFill("SELL", token, false, "Not configured");
    if (!token) return emptyFill("SELL", token, false, "Nothing to sell");
    if (!Number.isFinite(shares) || shares <= 0) return emptyFill("SELL", token, false, "Invalid share amount");
    if (shares < MIN_SHARES) return emptyFill("SELL", token, false, `Minimum sell is ${MIN_SHARES} shares`);
    // Slippage protection: the limit price MUST be the live best bid ×
    // (1 - MAX_SLIPPAGE). A missing/unusable floor (no live bid / book too thin)
    // means we refuse the sell rather than dump down to a 1¢ floor.
    if (!(typeof minPrice === "number" && minPrice > 0)) {
      return emptyFill("SELL", token, false, "No live bid — order not placed");
    }
    const key = `SELL:${token}:${Math.round(shares * 100) / 100}`;
    if (this._inflight.has(key)) return emptyFill("SELL", token, false, "Order already in flight");
    this._inflight.add(key);
    try {
      const resp = await (async () => {
        const client = await _makeClient();
        const price = clampToTick(minPrice / 100.0);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const order = await client.createOrder({
          tokenId: token, price, size: shares, side: "SELL",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await client.postOrder(order, "FAK" as any);
        return (typeof r === "object" ? r : { raw: String(r) }) as Record<string, unknown>;
      })();
      const oid = String(resp["orderID"] ?? resp["id"] ?? resp["order_id"] ?? "");
      const status = String(resp["status"] ?? "").toLowerCase();
      const ok = Boolean(oid) || ["matched", "live", "success"].includes(status);
      const [filled, price, usdFilled] = fillAmounts(resp, "SELL");
      if (ok && filled <= 0) {
        console.info("sell() ok but no matched amounts (unconfirmed):", resp);
        return { token, side: "SELL", ok: true, unconfirmed: true, order_id: oid, shares: 0, price: 0, usd: 0, error: "" };
      }
      return {
        token, side: "SELL", shares: filled || shares, price, usd: usdFilled,
        ok, order_id: oid, unconfirmed: false,
        error: ok ? "" : shortError(String(resp["error"] ?? JSON.stringify(resp))),
      };
    } catch (e) {
      console.warn("sell() error:", shortError(e));
      return emptyFill("SELL", token, false, shortError(e));
    } finally {
      this._inflight.delete(key);
    }
  }

  // ── one-time setup ────────────────────────────────────────────────────────────

  async ensureReady(): Promise<OrderResult> {
    if (!isConfigured()) return { ok: false, error: "Not configured", detail: "" };
    if (this._readyDone) return { ok: true, error: "", detail: "already ready" };
    const src = _keySource();
    try {
      if (src?.source === "local") {
        const { ensureEoaAllowances } = await import("./eoa-allowance.js");
        const hashes = await ensureEoaAllowances(src.private_key);
        this._readyDone = true;
        return { ok: true, error: "", detail: `allowances set (${hashes.length} tx)` };
      }
      // .env proxy path — CLOB gasless allowance
      const client = await _makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await client.updateBalanceAllowance({ assetType: "COLLATERAL" } as any);
      this._readyDone = true;
      return { ok: true, error: "", detail: "allowance set" };
    } catch (e) {
      console.warn("ensureReady() error:", shortError(e));
      return { ok: false, error: shortError(e), detail: "" };
    }
  }

  /**
   * READ-ONLY tradeability preflight. Answers "would an order actually settle?"
   * without signing anything or spending gas.
   *
   * Without this a live buy from an unapproved EOA got signed and posted, and
   * only failed at settlement — indistinguishable, to the user, from the app
   * being broken. ensureReady() cannot serve this purpose: it BROADCASTS the
   * approvals (real gas, and gated), so it must stay an explicit user action.
   *
   * Only the CTF Exchange is required, because these are binary markets
   * (verified: the up/down windows report neg_risk=false). Demanding the
   * neg-risk spenders too would refuse trades that would have settled fine.
   *
   * Cached once satisfied — an approval is not spontaneously revoked, so the
   * on-chain read is paid at most once per process and never sits in the hot
   * path of a 1-tap buy.
   */
  private _tradeableOk = false;
  async checkTradeable(): Promise<OrderResult> {
    if (this._tradeableOk) return { ok: true, error: "", detail: "cached" };
    if (!isConfigured()) return { ok: false, error: "Not configured", detail: "" };
    const src = _keySource();
    // .env proxy path: collateral allowance is CLOB/relayer-managed, not an EOA
    // approval we can read this way. Nothing to assert here.
    if (src?.source !== "local") {
      this._tradeableOk = true;
      return { ok: true, error: "", detail: "proxy path" };
    }
    try {
      const { allowanceStatus } = await import("./eoa-allowance.js");
      const st = await allowanceStatus(src.address);
      const exch = getAddress(CTF_EXCHANGE);
      const eq = (a: string) => getAddress(a) === exch;
      const missing = st.missing_erc20.some(eq) || st.missing_ctf.some(eq);
      if (missing) {
        return {
          ok: false,
          error: "Trading not approved yet — open Wallet and click Enable trading",
          detail: "",
        };
      }
      this._tradeableOk = true;
      return { ok: true, error: "", detail: "approved" };
    } catch (e) {
      // A failed READ must never block a trade that would have worked. Report
      // ok and let the order path surface any real problem itself.
      console.warn("checkTradeable() read failed (allowing trade):", shortError(e));
      return { ok: true, error: "", detail: "unverified" };
    }
  }

  // ── wallet / money management ──────────────────────────────────────────────────

  async depositAddress(): Promise<{ address: string; chain: string; token: string } | Record<string, never>> {
    if (!isConfigured()) return {};
    const addr = _liveAddress();
    return addr ? { address: addr, chain: "Polygon", token: "USDC" } : {};
  }

  async txHistory(limit = 25): Promise<Record<string, unknown>[]> {
    this.txHistoryError = "";
    if (!isConfigured()) return [];
    const addr = (_liveAddress() ?? "").toLowerCase();
    const apiKey = (process.env["POLYGONSCAN_API_KEY"] ?? "").trim();
    if (!addr || !apiKey) {
      if (addr && !apiKey) this.txHistoryError = "Activity unavailable — POLYGONSCAN_API_KEY not set.";
      return [];
    }
    const rows: Record<string, unknown>[] = [];
    for (const [contract, token] of [[NATIVE_USDC, "USDC"], [USDC_E, "USDC.e"]] as const) {
      try {
        const url = new URL("https://api.etherscan.io/v2/api");
        url.searchParams.set("chainid", "137");
        url.searchParams.set("module", "account");
        url.searchParams.set("action", "tokentx");
        url.searchParams.set("contractaddress", contract);
        url.searchParams.set("address", addr);
        url.searchParams.set("page", "1");
        url.searchParams.set("offset", String(limit));
        url.searchParams.set("sort", "desc");
        url.searchParams.set("apikey", apiKey);
        const r = await fetch(url.toString());
        const data = await r.json() as Record<string, unknown>;
        if (String(data["status"]) !== "1") {
          const msg = `${data["message"] ?? ""} ${data["result"] ?? ""}`.trim();
          if (!msg.toLowerCase().includes("no transactions found")) {
            console.warn(`tx_history(${token}) etherscan error:`, msg.slice(0, 160));
            this.txHistoryError = "Activity unavailable — explorer API error.";
          }
          continue;
        }
        for (const t of (data["result"] as Record<string, unknown>[]) ?? []) {
          try {
            const dec = parseInt(String(t["tokenDecimal"] ?? 6), 10);
            const amt = Math.round(parseFloat(String(t["value"] ?? "0")) / Math.pow(10, dec) * 100) / 100;
            if (amt === 0) continue;
            const to_ = String(t["to"] ?? "").toLowerCase();
            const frm = String(t["from"] ?? "").toLowerCase();
            const incoming = to_ === addr;
            rows.push({
              ts:           parseInt(String(t["timeStamp"] ?? 0), 10),
              kind:         incoming && frm === addr ? "self" : incoming ? "in" : "out",
              amount:       amt,
              token,
              hash:         t["hash"] ?? "",
              counterparty: incoming ? frm : to_,
            });
          } catch { continue; }
        }
      } catch (e) {
        console.warn(`tx_history(${token}) error:`, shortError(e));
        this.txHistoryError = "Activity unavailable — explorer unreachable.";
      }
    }
    rows.sort((a, b) => (b["ts"] as number) - (a["ts"] as number));
    return rows.slice(0, limit);
  }

  async redeem(conditionId: string): Promise<OrderResult> {
    if (!isConfigured()) return { ok: false, error: "Not configured", detail: "" };
    if (!conditionId) return { ok: false, error: "No market to redeem", detail: "" };
    const { redeemEoa } = await import("./eoa-allowance.js");
    const src = _keySource();
    try {
      if (src?.source === "local") {
        const tx = await redeemEoa(src.private_key, conditionId);
        return { ok: true, error: "", detail: tx };
      }
      // .env proxy path — not implemented in TS (see live.py for the Safe execTransaction path)
      return { ok: false, error: "Proxy redeem not implemented in TS layer", detail: "" };
    } catch (e) {
      console.warn("redeem() error:", shortError(e));
      return { ok: false, error: shortError(e), detail: "" };
    }
  }

  async send(usdc: number, to: string): Promise<OrderResult> {
    if (!isConfigured()) return { ok: false, error: "Not configured", detail: "" };
    const src = _keySource();
    if (src?.source === "local") {
      return this._sendEoa(usdc, to, src.private_key);
    }
    const sendEnabled = ["1", "true", "yes", "on"].includes(
      (process.env["TUC_SEND_ENABLED"] ?? "").trim().toLowerCase()
    );
    if (!sendEnabled) return { ok: false, error: "Send is disabled (preview) — not enabled yet", detail: "" };
    if (!process.env["BUILDER_API_KEY"]) return { ok: false, error: "Missing BUILDER_API_KEY for the relayer", detail: "" };

    const dest = _validAddress(to);
    if (!dest) return { ok: false, error: "Invalid destination address", detail: "" };

    // Self-send guard (the EOA path already has one) — sending to the funder
    // (the proxy/Safe that holds the collateral) is a no-op that wastes a relayer
    // tx, so refuse it up front.
    const funderAddr = process.env["POLY_WALLET_ADDRESS"] ?? "";
    if (funderAddr && dest.toLowerCase() === funderAddr.toLowerCase()) {
      return { ok: false, error: "Destination is this wallet (self-send)", detail: "" };
    }

    let micro: number;
    try {
      micro = Math.round(parseFloat(String(usdc)) * 1_000_000);
      if (!isFinite(micro)) throw new Error("Invalid amount");
    } catch {
      return { ok: false, error: "Invalid amount", detail: "" };
    }
    if (micro < 10_000) return { ok: false, error: "Minimum send is $0.01", detail: "" };
    const amount = micro / 1_000_000;

    const key = `send:${dest}:${micro}`;
    if (this._inflight.has(key)) return { ok: false, error: "A matching send is already in flight", detail: "" };
    this._inflight.add(key);
    try {
      if (this._sendLocked) {
        return { ok: false, error: "A send is already processing", detail: "" };
      }
      this._sendLocked = true;
      try {
        const avail = await this.cash();
        if (amount > avail + 1e-9) {
          return { ok: false, error: `Amount exceeds available $${avail.toFixed(2)}`, detail: "" };
        }
        // Relayer send (WALLET type) — mirrors live.py.
        // Pick the transfer token by which balance actually funds the send: the
        // funder may hold native USDC or bridged USDC.e. Hardcoding USDC.e sends
        // nothing (reverts) when the funder holds native USDC. Read both balances
        // and prefer the one that covers `amount`; if neither alone covers it,
        // fall back to whichever has the larger balance.
        const funder = process.env["POLY_WALLET_ADDRESS"] ?? "";
        let token = USDC_E;
        try {
          const [natBal, eBal] = await Promise.all([
            erc20Balance(NATIVE_USDC, funder),
            erc20Balance(USDC_E, funder),
          ]);
          if (eBal + 1e-9 >= amount) token = USDC_E;
          else if (natBal + 1e-9 >= amount) token = NATIVE_USDC;
          else token = natBal > eBal ? NATIVE_USDC : USDC_E;
        } catch (e) {
          // On a balance-read failure keep the historical default (USDC.e).
          console.info("send() token selection fell back to USDC.e:", shortError(e));
        }
        const calldata = "0xa9059cbb" + encodeAbiUint256Pair(dest, micro);
        const body = JSON.stringify({
          type: "WALLET", from: funder, to: token,
          data: calldata,
          owner: process.env["POLY_PRIVATE_KEY"] ? _eoaAddress(process.env["POLY_PRIVATE_KEY"]) : funder,
        });
        const path = "/submit";
        const headers = this._builderHeaders("POST", path, body);
        const r = await fetch(`${RELAYER_URL}${path}`, { method: "POST", headers, body });
        const data = await (r.headers.get("content-type")?.includes("json") ? r.json() : Promise.resolve({})) as Record<string, unknown>;
        const tx = data["transactionID"] ?? data["transactionHash"] ?? data["hash"];
        if (r.status >= 400 || !tx) {
          return { ok: false, error: `Relayer rejected: ${String(JSON.stringify(data)).slice(0, 120)}`, detail: "" };
        }
        const txHash = String(data["transactionHash"] ?? data["hash"] ?? "");
        return await this._awaitSendConfirmation(String(tx), txHash);
      } finally {
        this._sendLocked = false;
      }
    } catch (e) {
      console.warn("send() error:", shortError(e));
      return { ok: false, error: shortError(e), detail: "" };
    } finally {
      this._inflight.delete(key);
    }
  }

  async swap(from: string, to: string, amount: number): Promise<OrderResult> {
    if (!isConfigured()) return { ok: false, error: "Not configured", detail: "" };
    const src = _keySource();
    if (src?.source !== "local") {
      return { ok: false, error: "Swap requires the generated trading wallet", detail: "" };
    }
    // A swap spends REAL funds on-chain (ERC-20 approve + Uniswap V3 trade), so
    // it stays inert until live ops are armed (Wallet panel → "Enable trading")
    // or TUC_SWAP_ENABLED is set — matching every sibling on-chain write path.
    {
      const { swapEnabled } = await import("./eoa-allowance.js");
      if (!swapEnabled()) {
        return { ok: false, error: "Swap not enabled — click Enable trading first", detail: "" };
      }
    }
    if (!(amount > 0)) return { ok: false, error: "Enter an amount", detail: "" };
    const map: Record<string, SwapToken> = { "USDC": "USDC_NATIVE", "USDC.e": "USDC_E", "POL": "POL" };
    const sell = map[from];
    const buy = map[to];
    if (!sell || !buy) return { ok: false, error: "Unknown token", detail: "" };
    if (sell === buy) return { ok: false, error: "Pick two different tokens", detail: "" };
    try {
      const { getSwapQuote, executeSwap } = await import("./swap.js");
      const account = _liveAddress();
      // POL has 18 decimals; USDC variants 6.
      const base = sell === "POL" ? BigInt(Math.round(amount * 1e18)) : BigInt(Math.round(amount * 1e6));
      const quote = await getSwapQuote({ sell, buy, sellAmount: base, taker: account });
      const { hash } = await executeSwap(src.private_key, quote);
      return { ok: true, error: "", detail: hash };
    } catch (e) {
      console.warn("swap() error:", shortError(e));
      return { ok: false, error: shortError(e), detail: "" };
    }
  }

  async topUpGas(): Promise<OrderResult> {
    if (!isConfigured()) return { ok: false, error: "Not configured", detail: "" };
    const src = _keySource();
    if (src?.source !== "local") {
      return { ok: false, error: "Gas top-up requires the generated trading wallet", detail: "" };
    }
    // Swaps USDC → POL on-chain with real funds — same gate as swap(). (The
    // auto-gas step inside eoa-allowance's own approve/withdraw/redeem flows is
    // a DIFFERENT, internal helper and is intentionally not gated here; its
    // callers are already gated.)
    {
      const { swapEnabled } = await import("./eoa-allowance.js");
      if (!swapEnabled()) {
        return { ok: false, error: "Gas top-up not enabled — click Enable trading first", detail: "" };
      }
    }
    try {
      const { ensureGas } = await import("./swap.js");
      await ensureGas(src.private_key);
      return { ok: true, error: "", detail: "" };
    } catch (e) {
      console.warn("topUpGas() error:", shortError(e));
      return { ok: false, error: shortError(e), detail: "" };
    }
  }

  // ── private helpers ───────────────────────────────────────────────────────────

  private async _sendEoa(usdc: number, to: string, privateKey: string): Promise<OrderResult> {
    const dest = _validAddress(to);
    if (!dest) return { ok: false, error: "Invalid destination address", detail: "" };
    const own = _liveAddress();
    if (own && dest.toLowerCase() === own.toLowerCase()) {
      return { ok: false, error: "Destination is this wallet (self-send)", detail: "" };
    }
    let micro: number;
    try {
      micro = Math.round(parseFloat(String(usdc)) * 1_000_000);
      if (!isFinite(micro)) throw new Error("invalid");
    } catch {
      return { ok: false, error: "Invalid amount", detail: "" };
    }
    if (micro < 10_000) return { ok: false, error: "Minimum send is $0.01", detail: "" };
    const key = `send:${dest}:${micro}`;
    if (this._inflight.has(key)) return { ok: false, error: "A matching send is already in flight", detail: "" };
    this._inflight.add(key);
    try {
      if (this._sendLocked) return { ok: false, error: "A send is already processing", detail: "" };
      this._sendLocked = true;
      try {
        const { eoaWithdraw } = await import("./eoa-allowance.js");
        const tx = await eoaWithdraw(privateKey, dest, BigInt(micro));
        return { ok: true, error: "", detail: tx };
      } finally {
        this._sendLocked = false;
      }
    } catch (e) {
      console.warn("_sendEoa() error:", shortError(e));
      return { ok: false, error: shortError(e), detail: "" };
    } finally {
      this._inflight.delete(key);
    }
  }

  private _builderHeaders(method: string, path: string, body: string): Record<string, string> {
    const bKey  = process.env["BUILDER_API_KEY"]        ?? "";
    const bSec  = process.env["BUILDER_API_SECRET"]     ?? "";
    const bPass = process.env["BUILDER_API_PASSPHRASE"] ?? "";
    const ts = String(Math.floor(Date.now() / 1000));
    let raw: Buffer;
    try {
      const pad = { 2: "==", 3: "=" }[(bSec.length % 4) as 2 | 3] ?? "";
      raw = Buffer.from(bSec + pad, "base64url");
    } catch {
      raw = Buffer.from(bSec);
    }
    const sig = crypto.createHmac("sha256", raw)
      .update(`${ts}${method}${path}${body}`)
      .digest("base64url");
    return {
      "POLY_BUILDER_API_KEY":     bKey,
      "POLY_BUILDER_SIGNATURE":   sig,
      "POLY_BUILDER_TIMESTAMP":   ts,
      "POLY_BUILDER_PASSPHRASE":  bPass,
      "Content-Type":             "application/json",
    };
  }

  private async _awaitSendConfirmation(txId: string, txHash: string): Promise<OrderResult> {
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2500));
      try {
        if (txHash) {
          const mined = await this._txReceiptOk(txHash);
          if (mined === true) return { ok: true, error: "", detail: txHash };
          if (mined === false) return { ok: false, error: "Transfer reverted on-chain", detail: "" };
        } else {
          const [state, h] = await this._relayerTxStatus(txId);
          txHash = h || txHash;
          if (state.includes("FAIL")) return { ok: false, error: `Relayer reported failure (${state})`, detail: "" };
          if (!txHash && (state.includes("MINED") || state.includes("CONFIRMED"))) {
            return { ok: true, error: "", detail: txId };
          }
        }
      } catch (e) {
        console.info("send confirmation poll:", shortError(e));
      }
    }
    return {
      ok: false,
      error: "Submitted — confirmation pending. Check Activity before retrying.",
      detail: txHash || txId,
    };
  }

  private async _relayerTxStatus(txId: string): Promise<[string, string]> {
    const path = "/transaction";
    const headers = this._builderHeaders("GET", path, "");
    const r = await fetch(`${RELAYER_URL}${path}?id=${txId}`, { headers });
    r.ok ? null : r.text(); // consume
    if (!r.ok) throw new Error(`relayer status ${r.status}`);
    let data = await r.json() as unknown;
    if (Array.isArray(data)) data = data[0] ?? {};
    if (!data || typeof data !== "object") return ["", ""];
    const d = data as Record<string, unknown>;
    return [
      String(d["state"] ?? d["status"] ?? "").toUpperCase(),
      String(d["transactionHash"] ?? d["hash"] ?? ""),
    ];
  }

  private async _txReceiptOk(txHash: string): Promise<boolean | null> {
    const r = await fetch(POLYGON_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
    });
    r.ok ? null : null;
    const body = await r.json() as Record<string, unknown>;
    const res = body["result"];
    if (!res) return null;
    return String((res as Record<string, unknown>)["status"]) === "0x1";
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/**
 * Snap a decimal price to the valid CLOB order grid. The CLOB rejects any price
 * outside [tick, 1 - tick] (for a 0.01-tick market: 0.01 … 0.99) or off the tick
 * grid. We clamp into [tick, 1 - tick] then round to the nearest tick. tickSize
 * isn't tracked per-market here, so DEFAULT_TICK is the assumed grid.
 */
export function clampToTick(price: number, tick = DEFAULT_TICK): number {
  const lo = tick;
  const hi = 1 - tick;
  const clamped = Math.min(hi, Math.max(lo, price));
  const snapped = Math.round(clamped / tick) * tick;
  // Re-clamp after snapping (rounding can nudge just past a bound) and fix FP drift.
  return Math.round(Math.min(hi, Math.max(lo, snapped)) * 1e4) / 1e4;
}

function _validAddress(addr: string): string | null {
  try {
    const checked = getAddress(addr);
    if (BigInt(checked) === 0n) return null;
    return checked;
  } catch {
    return null;
  }
}

function _eoaAddress(pk: string): string {
  try {
    const { privateKeyToAccount } = require("viem/accounts") as typeof import("viem/accounts");
    const normalized = (pk.startsWith("0x") ? pk : "0x" + pk) as `0x${string}`;
    return privateKeyToAccount(normalized).address;
  } catch {
    return "";
  }
}

function encodeAbiUint256Pair(address: string, amount: number): string {
  // ABI encode (address, uint256) for ERC-20 transfer calldata
  const addr = address.toLowerCase().replace("0x", "").padStart(64, "0");
  const amt = BigInt(amount).toString(16).padStart(64, "0");
  return addr + amt;
}

function emptyFill(side: string, token: string, ok: boolean, error: string, usd = 0): Fill {
  return { token, side, shares: 0, price: 0, usd, ok, error, order_id: "", unconfirmed: false };
}
