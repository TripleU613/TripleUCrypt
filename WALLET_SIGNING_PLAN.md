# Browser-MetaMask Signing Mode — Implementation Plan

**Status:** fully implemented (mode switch, connect, order-signing core,
approvals, portfolio sync). **Never exercised against a real funded
account** — that's the one remaining gap, and it's inherently
**browser-dependent — it cannot be verified in a headless dev environment**
(no browser, no extension, no funded account, no live CLOB). This document is
the checklist to close that gap at a machine with a browser.

## What's built

- **Mode switch** (`client/components/WalletPanel.tsx`, segmented control):
  Server Wallet (instant, `.env`/generated key) ↔ Browser Wallet
  (MetaMask/any EIP-1193/EIP-6963 wallet). Backed by `src/engine/wallet.ts`
  (`toggleSignMode` / `setSignMode`) → `sign_mode` in the store.
- **Wallet bus** (`client/buses/MetaMaskBus.ts`): EIP-1193 + EIP-6963
  multi-wallet discovery (MetaMask, Rabby, Coinbase Wallet, Frame, …),
  `connectMetaMask()`, `signTypedData()`, `personalSign()`, `ensurePolygon()`
  (auto chain-switch/add), balance reads, raw sends/approvals.
- **Order-signing core** (`client/buses/ClobTrade.ts`, ~500 lines): builds a
  browser-side `@polymarket/clob-client-v2` `ClobClient` bound to the
  wallet's `ethers` signer, derives L2 API creds via one `personalSign`
  (`createOrDeriveApiKey()`, cached per-address in `sessionStorage`), and
  implements `browserBuy` / `browserSell` (FOK/FAK, the same slippage-cap /
  floor math as the server path), `ensureBrowserApprovals` (binary CTF Exchange
  + neg-risk-aware), auth-retry on a rotated/revoked L2 key, a fresh-held-size
  re-check right before selling, and resolved-position → claim routing.
- **Bridge** (`client/lib/placeTrade.ts`): routes `placeBuy` / `placeSell` to
  `ClobTrade` when `sign_mode === 'wallet'`, mapping fills into the same
  toast/status path server mode uses.
- **Portfolio sync** (`ClobTrade.refreshBrowserPortfolio`): balances from a
  public Polygon RPC, positions from the public data-api — independent of the
  server (which doesn't track a browser-signed wallet) — with stale-write
  guards if the mode or active address changes mid-poll.

## The core decision (resolved): official JS CLOB client, in-browser

As planned: the browser owns the `ClobClient` end-to-end (signs, derives L2
creds, builds and posts orders) — the server never sees the key and never
signs. One detail beyond the original plan: browser requests route through
this app's own `/clob` proxy (`src/server/index.ts`) to `clob.polymarket.com`,
forwarding the raw body verbatim so the `poly_signature` HMAC (computed
client-side over the exact bytes) still verifies — same-origin avoids
CORS/bot-detection issues. The server does not build, sign, or inspect the
order; it's a transparent pipe.

## What's NOT done: live verification

Nothing above has been exercised against a real browser + funded wallet +
live CLOB. Structurally everything type-checks, builds (`npm run build`
bundles `@polymarket/clob-client-v2` + `ethers` cleanly — see
`vite.config.ts`'s `optimizeDeps`), and mirrors the server path's semantics —
but a live signature round-trip, a real fill, and real on-chain approvals are
untested.

## Verification checklist (browser, real account)

- [ ] `connectMetaMask()` returns the address; wrong-chain warning fires off-Polygon.
- [ ] L2 creds derive from a single `personalSign` at the first order (`client()` in `ClobTrade.ts`).
- [ ] A tiny live buy: wallet confirm dialog → order posts → fill returns →
      position appears (identical UI to instant mode).
- [ ] A sell (FAK) exits and credits cash; a partial FAK fill reports the
      partial size, not a false "fully sold."
- [ ] Rejected signature / closed dialog → clean error, no wedged spinner
      (`_tradeBusy` / `_approving` reset in `finally`).
- [ ] Neg-risk market: the extra `NEG_RISK_EXCHANGE`/`NEG_RISK_ADAPTER`
      approvals actually fire and the order fills (binary markets are the
      common case and get fewer popups by design — this path is the least
      exercised).
- [ ] Auth-retry: an expired/rotated L2 key actually gets cleared and
      re-derived once, not looped.

## One open gap: no env-level off-switch

Unlike the other real-money write paths (EOA approvals, redeem), there is no
`TUC_WALLET_SIGN_ENABLED`-style flag gating this anymore, despite
`ROADMAP.md` and `.env.example` still describing one — it doesn't appear
anywhere in the current code. The only gate today is the in-app mode switch
itself (an explicit click + a connected, funded wallet). If that's
intentional — mirroring how EOA-approve/redeem moved from an env flag to an
in-app confirm dialog — no action needed, just confirm; if not, this is the
one wiring gap left before "browser wallet" should be called done.

## Caveats

- Per-order wallet confirm dialogs are inherent to true MetaMask signing —
  that's the cost of zero-custody, and exactly why Server Wallet (instant)
  stays the default for fast 5-minute scalping.
- None of the above was exercisable in this environment (no browser, no
  extension, no funded account) — treat the whole path as
  needs-live-browser-verification until the checklist passes.
