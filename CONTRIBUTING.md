# Contributing to TripleUCrypt

Thanks for your interest! This is a Node.js/TypeScript (Express + Vite + React +
Zustand) trading terminal for Polymarket. Contributions of all kinds are
welcome — bug fixes, features, docs, and design polish.

## Ground rules

- **Be safe with the money path.** Anything touching `src/banking/` or order
  placement is real money in live mode. Default to **practice mode** for
  development; never commit credentials, keys, or a populated `.env`.
- **Practice mode needs no setup.** `npm run dev` works out of the box against
  live market data with a virtual $100 bankroll — you can build and test
  almost everything without ever enabling live trading.
- By contributing you agree your work is licensed under the project's
  [AGPL-3.0](LICENSE).

## Getting set up

```bash
git clone https://github.com/TripleU613/TripleUCrypt
cd TripleUCrypt
npm ci
npm run dev                 # frontend :5173 (Vite), backend :8200 (Express)
```

Open <http://localhost:5173>. No `.env` is required for practice mode.

> **Before submitting:** `npm test` (vitest) and `npm run build` (`tsc` + Vite)
> should both pass clean.

## Project layout

| Path | Role |
|------|------|
| `src/server/` | Express app — SSE state stream, action dispatch, CLOB proxy, SPA fallback |
| `src/engine/` | Server-side state + logic: `state.ts` + `market-data.ts`, `chart.ts`, `windows.ts`, `trading.ts`, `positions.ts`, `order-book.ts`, `social.ts`, `performance.ts`, `wallet.ts` |
| `src/io/` | Data layer — Kraken, Polymarket (Gamma/CLOB), Chainlink, hindsight |
| `src/banking/` | Money engine behind one `Broker` interface — `live.ts`, `paper.ts` + `ledger.ts`, `local-wallet.ts`, `resilience.ts` |
| `client/components/` | UI — nav, chart (canvas engine), market sidebar, trade panel, order book |
| `client/buses/` | Browser-side realtime + wallet bridges (Chainlink, CLOB, MetaMask) |

## Conventions

- **Brokers return clean typed results, never raise into the UI.** Surface
  failures as a status string.
- **Never retry the order path.** Retries are for reads only — retrying a
  buy/sell risks a double-spend (see `src/banking/resilience.ts`).
- Match the surrounding code's style, comment density, and naming.

## Submitting changes

1. Branch off `main`.
2. Keep commits focused; write a clear message describing the *why*.
3. Test in practice mode; if you touched the live path, say how you verified it.
4. Open a PR against `main` and fill out the template.

## Reporting bugs / security issues

- Regular bugs: open a GitHub issue with steps to reproduce.
- **Security / fund-safety issues:** see [SECURITY.md](SECURITY.md) — please do
  **not** open a public issue for those.
