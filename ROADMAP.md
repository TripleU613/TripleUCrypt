# TripleUCrypt — Feature Roadmap

Features extracted from Polymarket reference screenshots + sell/cashout requirements.
Status: ✅ Done | 🔨 In Progress | 📋 Planned

---

## 1. Chart (per-market window view)

| # | Feature | Status |
|---|---------|--------|
| 1.1 | Per-window price chart — 1-minute candles scoped to active 5/15m window | ✅ |
| 1.2 | "Price To Beat" dashed horizontal reference line at strike price | ✅ |
| 1.3 | "Current Price" readout with live delta from strike (e.g. +$124) | ✅ |
| 1.4 | Live dot / marker on chart at current price position | ✅ (LWC native last-bar marker) |
| 1.5 | Open-position P&L labels overlaid on chart at entry price level | 📋 |
| 1.6 | "Target ▼" interactive button anchored to strike line | 📋 |
| 1.7 | Window time range label (e.g. "June 1, 12:40–12:45PM ET") | ✅ (LIVE/NEXT/PAST overlay, ET) |
| 1.8 | Countdown timer — large MINS + SECS split display, red when < 60s | ✅ (in window cards) |
| 1.9 | Chart type switcher: line, asset icon, candlestick | 🔨 (Candles/Area done) |
| 1.10 | X-axis in wall-clock time within the window | ✅ (1m candles auto-scope) |
| 1.11 | Orange/amber "winning" color theme for active window chart line | 📋 |
| 1.12 | **Line/percentage modes should MOVE, not re-render** — see below | 📋 |

### 1.12 — chart motion (line + percentage modes)

Today a new tick re-renders the whole curve: autoscale re-fits and the spline
re-smooths, so the line visibly re-shapes ("crooked up / crooked down") on every
update. Wanted instead: the existing line **keeps its shape** and the chart
**slides/translates** so it glides into its new position — smooth, flowy motion
of what's already drawn, rather than recomputing it each tick. The pen/marker may
move too.

Explicitly **out of scope** for this item: zoom, pan, resize, adopting a charting
library, or a from-scratch rewrite. Keep the existing hand-rolled canvas engine
(`client/components/chart/EChart.tsx`); candlestick mode stays as-is.

---

## 2. Window Navigation

| # | Feature | Status |
|---|---------|--------|
| 2.1 | "Past ▼" dropdown to view historical closed windows | 📋 |
| 2.2 | Upcoming window time slots strip (12:40, 12:45 ●, 12:50, 12:55) | ✅ |
| 2.3 | Active window highlighted with red dot indicator | ✅ |
| 2.4 | "More ▼" to show additional future slots | ✅ |
| 2.5 | Click window slot to switch chart view to that window's 1m candles | ✅ |
| 2.6 | BTC / ETH / SOL asset selector in window nav | ✅ |

---

## 3. Buy Panel

| # | Feature | Status |
|---|---------|--------|
| 3.1 | Market header: asset color dot + "BTC Up or Down 5m" title | ✅ |
| 3.2 | Current winning side indicator ("Up" / "Down") subtitle | ✅ |
| 3.3 | Buy / Sell tab switcher | ✅ |
| 3.4 | "1-Tap ▼" one-tap buy mode with preset grid | ✅ |
| 3.5 | Large Up / Down price buttons showing current ask | ✅ |
| 3.6 | Selected side highlighted green (Up) or red (Down) | ✅ |
| 3.7 | One-tap buy preset grid: $5 / $25 / $100 with "win $X" payout | ✅ |
| 3.8 | Win amount on each preset updates live with ask price | ✅ |
| 3.9 | Terms of Use disclaimer text below presets | ✅ |
| 3.10 | Maker Rebate info link | ✅ |
| 3.11 | + Rewards link | ✅ |

---

## 4. Sell / Cashout (before expiration)

| # | Feature | Status |
|---|---------|--------|
| 4.1 | Sell tab in buy panel to switch to exit mode | ✅ |
| 4.2 | List open positions (token, direction, size, entry price, current bid) | ✅ |
| 4.3 | Live P&L for each open position (current bid vs. entry cost) | ✅ |
| 4.4 | "Sell All" button to market-sell entire position at best bid | ✅ |
| 4.5 | Partial sell — custom share/dollar amount input | ✅ |
| 4.6 | Sell preset grid ($5 / $25 / $100 worth to sell) | ✅ |
| 4.7 | Confirmation step before executing sell | 📋 |
| 4.8 | Fetch open positions from Polymarket CLOB API | ✅ (py-clob-client, in-process) |
| 4.9 | Sell order placement via py-clob-client (SELL side) | ✅ (in-process, no external scripts) |
| 4.10 | Position P&L overlaid on window chart — per entry-price horizontal line | 📋 |
| 4.11 | Auto-refresh position list after buy or sell | ✅ |

---

## 5. Order Book

| # | Feature | Status |
|---|---------|--------|
| 5.1 | Order book panel: Trade Up / Trade Down tab switcher | ✅ |
| 5.2 | Asks section with red "Asks" badge and levels (price, shares, total) | ✅ |
| 5.3 | Bids section with green "Bids" badge and levels | ✅ |
| 5.4 | "Last: Xc" last-traded price display | ✅ |
| 5.5 | "Spread: Xc" bid-ask spread display | ✅ |
| 5.6 | Depth visualization bar (left column, scaled to max total) | ✅ |
| 5.7 | PRICE / SHARES / TOTAL column headers | ✅ |
| 5.8 | Live orderbook refresh (manual ↻ + auto every 5s) | ✅ |
| 5.9 | Click a bid level → switches to Sell tab | ✅ |
| 5.10 | Click an ask level → sets buy side + Buy tab | ✅ |

---

## 6. Market Data

| # | Feature | Status |
|---|---------|--------|
| 6.1 | BTC live price from Kraken WebSocket | ✅ |
| 6.2 | ETH live price from Kraken WebSocket | ✅ |
| 6.3 | SOL live price from Kraken WebSocket | ✅ |
| 6.4 | BTC 5m / 15m OHLC candles | ✅ |
| 6.5 | Strike price parsed from Polymarket question text | ✅ |
| 6.6 | UP / DOWN ask prices polled every 4s | ✅ |
| 6.7 | ARB badge when combined ≤ 97¢ | ✅ |
| 6.8 | Window countdown timer (live 1-second tick) | ✅ |
| 6.9 | All 6 markets polled in parallel (BTC/ETH/SOL × 5m/15m) | ✅ |
| 6.10 | "Price To Beat" delta: live (current − strike) with direction arrow in nav | ✅ |
| 6.11 | Historical window result fetch (UP/DOWN outcome badges on past slots) | ✅ |
| 6.12 | Position data from Polymarket API (open orders, fills, P&L) | ✅ (live positions via data-api `/positions`, marked-to-market) |

---

## 7. UI / Layout

| # | Feature | Status |
|---|---------|--------|
| 7.1 | TradingView Lightweight Charts (canvas, live tick updates) | ✅ |
| 7.2 | Auto-resize chart to screen height | ✅ |
| 7.3 | Window cards strip (scrollable, 6 markets) | ✅ |
| 7.4 | Active window card selection (green highlight) | ✅ |
| 7.5 | Current price + 24h % change in nav bar | ✅ |
| 7.6 | Candles / Area chart mode toggle | ✅ |
| 7.7 | 5m / 15m interval toggle | ✅ |
| 7.8 | Trade size preset buttons + custom input | ✅ |
| 7.9 | Buy UP / DOWN buttons with payout label | ✅ |
| 7.10 | Asset color indicators: BTC orange, ETH purple, SOL violet | ✅ |
| 7.11 | Market chart panel switchable: price chart ↔ order book view | ✅ |
| 7.12 | Dark theme throughout | ✅ |
| 7.13 | JetBrains Mono font | ✅ |

---

## Remaining (next priorities)

1. **1.12** — Line/percentage chart should translate smoothly, not re-render each tick
2. **4.7** — Confirmation step before sell
3. **4.10 / 1.5** — Position P&L lines overlaid on chart
4. **2.1** — "Past ▼" dropdown for historical closed windows
5. **1.6** — "Target ▼" button anchored to strike line
6. **1.11** — Orange/amber color for winning-side chart line

---

## 8. Wallet / Money Management  ✅ SHIPPED (live paths gated, see below)

A top-bar **Wallet** toggle swaps the trade panel for a wallet view: balances,
deposit address, send/withdraw, activity. **Live mode only.** All money ops go
through the one `Broker` interface (`banking/`); the UI is byte-identical between
live and practice.

> **Trust model:** the app no longer requires pasting a private key. Two live key
> sources, resolved in `live.ts::_keySource()` (`.env` wins, else generated):
> a **generated local trading wallet** (default — see §9) or an existing `.env`
> proxy key. All on-chain *write* paths are **gated off by default** behind env
> flags so they never fire an unverified real transaction.

### UI (swaps the right trade panel)

| # | Feature | Status |
|---|---------|--------|
| 8.1 | Top-bar **Wallet** toggle (live only) — swaps trade panel ↔ wallet panel | ✅ |
| 8.2 | **Balances** card: spendable collateral · open-position value · on-chain USDC · total | ✅ |
| 8.3 | **Deposit**: address + copy, "USDC on **Polygon**" warning (+ POL note for EOA) | ✅ (QR was built — `client/components/wallet/QR.tsx` — but never wired into the panel; removed as dead code) |
| 8.4 | **Withdraw**: amount + destination + **review/confirm** → on-chain / relayer transfer out | ✅ (gated) |
| 8.5 | **Send**: transfer to an arbitrary address (review → confirm) | ✅ (gated) |
| 8.6 | **Activity**: recent transfers + explorer links (Etherscan-v2, needs `POLYGONSCAN_API_KEY`) | ✅ |
| 8.7 | Empty/zero + practice states; wallet panel hidden in practice | ✅ |

### Backend (`banking/` — behind the `Broker` interface)

| # | Feature | Status |
|---|---------|--------|
| 8.8 | `deposit_address()` → active funder/EOA address + chain + token | ✅ |
| 8.9 | `send(usdc, to)` → relayer transfer (proxy) **or** on-chain ERC-20 (generated EOA) | ✅ (gated) |
| 8.10 | `tx_history()` → Etherscan-v2 token transfers | ✅ |
| 8.11 | `PaperBroker`: money ops are no-ops ("not available in practice") | ✅ |

### Safety (money path)

| # | Guard | Status |
|---|-------|--------|
| 8.12 | **Confirmation step** before every send/withdraw | ✅ |
| 8.13 | Address **EIP-55 checksum + chain validation**; reject self-send / zero address | ✅ |
| 8.14 | Amount ≤ available (re-checked under lock for proxy; on-chain `balanceOf` for EOA) | ✅ |
| 8.15 | In-flight dedupe (no double-send); never retry the send path. Saved-address allowlist | ✅ / 📋 (allowlist planned) |
| 8.16 | Wallet panel + money ops hidden/inert in practice mode | ✅ |

### Answered (were "open questions")

- **Withdrawal mechanism:** proxy = **gasless relayer** (`relayer-v2`, builder-HMAC
  auth); generated EOA = **direct on-chain** ERC-20 transfer (pays its own POL gas).
- **`py-clob-client` vs web3:** the CLOB client owns order signing; **`web3` was
  added** (declared dep) only for the generated-EOA on-chain approvals / withdraw /
  redemption. Signing is always eth-account / the SDK — never hand-rolled, except
  the one gated, unverified proxy Safe-execTransaction redemption (§10).
- **Deposit target:** the active funder — the proxy (`.env`) or the generated EOA.

---

## 9. Wallet Onboarding (generated local trading wallet)  ✅ SHIPPED

No private key to paste. When no `.env` creds are set, the app **generates** a
dedicated trading keypair locally (`src/banking/local-wallet.ts`), stores it under
`~/.triplecrypt` (plaintext `0600` by default, or an encrypted keystore with a
password), and signs orders **server-side** — instant, popup-free. The user funds
the shown address from any wallet.

| # | Feature | Status |
|---|---------|--------|
| 9.1 | `local-wallet.ts` — generate / import / load / encrypt; secret never logged or returned | ✅ |
| 9.2 | `live.ts::_keySource()` resolver — `.env` proxy (sig 2) first, else generated EOA (sig 0) | ✅ |
| 9.3 | "Generate trading wallet" button + deposit address (EOA pays its own POL gas) | ✅ |
| 9.4 | One-time on-chain exchange approvals for the EOA (`eoa-allowance.ts`, viem) | ✅ (gated `TUC_EOA_APPROVE_ENABLED`) |
| 9.5 | Email / Magic-link (sig type 1) login for non-crypto users | 📋 (largely redundant with 9.1–9.3 for self-host) |

---

## 10. Settlement & Redemption  ✅ SHIPPED (live on-chain gated)

| # | Feature | Status |
|---|---------|--------|
| 10.1 | Practice: auto-settle paper positions at $1/$0 on window close | ✅ |
| 10.2 | Live: value resolved winners at $1 read-side (so a won position isn't marked $0 after the book clears) | ✅ |
| 10.3 | Live: **claim winnings** on-chain — generated EOA `CTF.redeemPositions` | ✅ (gated `TUC_REDEEM_ENABLED`) |
| 10.4 | Live: proxy (Gnosis-Safe) redemption via relayer `execTransaction` | ✅ (gated, **hand-rolled + unverified** — needs live iteration) |

---

## 11. Signing Modes  🔨 IN PROGRESS

| # | Feature | Status |
|---|---------|--------|
| 11.1 | **Instant** (default) — server-side signing with the generated/.env key, popup-free | ✅ |
| 11.2 | **Wallet** — browser MetaMask signs each order (zero-custody); mode switch + connect bus + order build→sign→post core | 🔨 (fully built; never exercised against a real funded browser account — see `WALLET_SIGNING_PLAN.md`) |

### Env gates (on-chain writes default OFF)

`TUC_SEND_ENABLED` (proxy relayer send) · `TUC_EOA_APPROVE_ENABLED` (EOA approvals +
withdraw) · `TUC_REDEEM_ENABLED` (claim winnings) · `TUC_SWAP_ENABLED` (Swap card +
"Get gas"). Each path is built but inert until its flag is set (or armed at runtime
via the Wallet panel's "Enable trading" confirm) and verified on a live account.

**Note:** Wallet Mode (11.2) has no equivalent env gate — no
`TUC_WALLET_SIGN_ENABLED` exists in the code. The only gate is the in-app mode
switch itself. Confirm whether that's intentional (see `WALLET_SIGNING_PLAN.md`).
