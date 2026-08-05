# TripleUCrypt

A real-time crypto **up/down trading terminal** for [Polymarket](https://polymarket.com),
built with Node.js/TypeScript (Express + Vite + React). Live candlestick charts, an order book,
one-click buy/sell, and live positions — across BTC, ETH, SOL, XRP, DOGE, HYPE and BNB
5-minute and 15-minute windows.

![TripleUCrypt](assets/screenshot.png)

## What it does

- **Live charts** (custom HTML5 canvas engine, ~60fps requestAnimationFrame) — Line,
  Probability and Candlestick modes, 5m / 15m intervals, auto-zoomed to the visible range.
  Candles stream live from Kraken; the forming bar updates every second.
- **All 7 assets** — click any market card to switch the chart and trade panel to that asset.
- **14 live markets** — every BTC/ETH/SOL/XRP/DOGE/HYPE/BNB up/down window, discovered from
  Polymarket and streamed over the CLOB WebSocket (best ask per side, combined, arb badge).
- **Order book** — full depth per side with spread + last price.
- **Trade panel** — size presets, live payout/profit, one-click buy, sell with live P&L on
  open positions.
- **Adaptive performance** — a power manager scales stream/poll intervals to system load.

## Data sources

| Source | Use | Auth |
|--------|-----|------|
| Kraken (REST + WebSocket) | live prices + OHLC candles for all 7 assets | none |
| Polymarket Gamma API | active up/down window discovery | none |
| Polymarket CLOB (REST + WebSocket) | order book, asks, balance, orders | your keys (trading only) |

Market data needs **no credentials**. Credentials are required only to place real trades.

## Two modes

- **Read-only (default — no `.env`):** charts, markets and order book are fully live. The
  trade buttons show *"Add credentials in .env to trade."* Nothing can place an order.
- **Configured:** add `POLY_PRIVATE_KEY` + `POLY_WALLET_ADDRESS` to `.env` → buy/sell, balance
  and positions go live against the Polymarket CLOB via
  [`@polymarket/clob-client-v2`](https://github.com/Polymarket/clob-client).

## Setup

Requires **Node.js 22+**.

```bash
git clone https://github.com/TripleU613/TripleUCrypt
cd TripleUCrypt
npm ci
cp .env.example .env        # optional — leave the placeholders for read-only mode
npm run dev                 # frontend :5173 (Vite), backend :8200 (Express)
```

Open <http://localhost:5173>. (Production — `npm run build && npm start` — serves
single-port on <http://localhost:8200> instead; the client talks same-origin, so
there's no separate frontend port to open.)

## Enabling trading

There are two ways in (market data and charts always work with no credentials):

**Easiest — generate a wallet (no key to paste).** Leave `.env` unset, switch to live,
open the **Wallet** panel and click **Generate trading wallet**. The app creates a
dedicated trading key, stores it locally under `~/.triplecrypt` (`trading_wallet.json`,
locked `0600` — or an encrypted keystore if you set a password), and signs orders
**server-side** (instant, no browser popups). Fund the address shown with **USDC on
Polygon**, plus a little **POL** for the one-time on-chain trading approval (a self-funded
wallet pays its own gas).

**Power users — bring an existing Polymarket key.** Fill in `.env` (see `.env.example`):

```bash
POLY_PRIVATE_KEY=0x...       # your Ethereum (Polygon) wallet private key
POLY_WALLET_ADDRESS=0x...    # your Polymarket (proxy/funder) wallet address
```

If present, these take **precedence** over a generated wallet, so existing setups are
unchanged. The CLOB L2 API credentials are derived from your private key automatically at
runtime (the canonical Polymarket flow) — you do not need to paste
`api_key`/`secret`/`passphrase`, and any stored ones are ignored. `.env.example` documents
the optional extras (Polygon RPC override, deposit history, the gated send feature).

The app reads secrets **only** from local files (git-ignored, never committed) and passes
the key solely to `@polymarket/clob-client-v2` against `clob.polymarket.com` — it is never
logged or sent to the browser.

## Docker

```bash
cp .env.example .env        # optional — skip for read-only/practice mode
docker compose up -d
```

See [DOCKER.md](DOCKER.md) for details.

## Architecture

| Path | Role |
|------|------|
| `src/server/` | Express app (`index.ts`) — SSE state stream, action dispatch, CLOB proxy, SPA fallback |
| `src/engine/` | Server-side state + logic: `state.ts` + `market-data.ts`, `chart.ts`, `windows.ts`, `trading.ts`, `positions.ts`, `order-book.ts`, `social.ts`, `performance.ts`, `wallet.ts` |
| `src/io/` | Data layer — `kraken.ts`, `polymarket.ts` (Gamma/CLOB), `chainlink.ts`, `hindsight.ts` |
| `src/banking/` | Money engine behind one `Broker` interface — `live.ts` (`@polymarket/clob-client-v2`), `paper.ts` + `ledger.ts` (practice), `local-wallet.ts` (generated wallet), `resilience.ts` |
| `client/components/` | UI — nav, chart (canvas engine in `chart/EChart.tsx`), market sidebar, trade panel, order book, wallet panel |
| `client/buses/` | Browser-side realtime + wallet bridges — `RtdsBus.ts` (Chainlink), `ClobBus.ts`/`ClobTrade.ts` (CLOB), `MetaMaskBus.ts` |
| `client/store.ts` | Zustand client state |

See [ROADMAP.md](ROADMAP.md) for the feature checklist.

## Disclaimer

**This software places real, irreversible, on-chain orders with real money.** In live mode it
signs and submits fill-or-kill / limit orders to Polymarket against funds in your wallet.

- **Not financial advice.** Nothing here is a recommendation to trade. You alone are
  responsible for every order placed and every dollar gained or lost.
- **Your keys, your funds.** You supply your own private key via a local, git-ignored `.env`.
  The maintainers never receive it and cannot recover losses. Secure your key and your machine.
- **Jurisdiction.** Polymarket is **geo-restricted and unavailable to users in several
  jurisdictions, including the United States.** You are responsible for complying with
  Polymarket's Terms of Service and the laws that apply to you. Default mode is **practice
  (paper)** — live trading is opt-in and requires credentials.
- **No warranty.** Provided "as is", without warranty of any kind, to the extent permitted by
  the AGPL-3.0 (see sections 15–16). Practice mode is the safe way to evaluate it.

## License

Licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).
In short: you may use, modify, and redistribute it, but if you run a modified version as a
network service, you must make your modified source available to its users under the same
license.

Bundled assets (the Inter typeface, Polymarket marks, coin icons) have their own licenses —
see [assets/LICENSES.md](assets/LICENSES.md).
