# Security Policy

TripleUCrypt can place **real, irreversible, on-chain orders** and handles a
wallet private key in live mode. Security issues are taken seriously.

## Reporting a vulnerability

**Do not open a public issue for security or fund-safety bugs.** Instead, use
GitHub's **private vulnerability reporting** ("Report a vulnerability" under the
repository's **Security** tab), or contact the maintainer privately.

Please include:

- A description of the issue and its impact (e.g. fund loss, key exposure,
  unsigned/mis-signed orders, unintended live execution).
- Steps to reproduce, ideally in **practice mode**.
- Affected version / commit.

We'll acknowledge as soon as we can and keep you updated on a fix.

## Scope — what matters most

This project's threat model centers on **money and keys**:

- **Key custody.** The private key is read only from local, git-ignored files (a
  `.env`, or a generated `trading_wallet.json` under `TC_DATA_DIR`), used solely
  inside `@polymarket/clob-client-v2` against `clob.polymarket.com`, and is never
  logged, serialized, returned from any method, or sent to the browser. Any path
  that leaks it is critical.
- **Order integrity.** Signing is delegated entirely to
  `@polymarket/clob-client-v2` (EIP-712 + L2 HMAC) — in server mode with a local
  key, or in browser ("Wallet") mode by the user's own extension, which is
  zero-custody. No hand-rolled signatures. Live market buys are capped
  at the displayed ask + a small slippage bound; the order path is never
  auto-retried (no double-spend). Bugs that break these guarantees are critical.
- **Mode safety.** Practice (paper) is the default; live trading is opt-in and
  requires credentials. A path that executes live when the user intended
  practice is critical.

## For users

- Keep your `.env` and machine secure — your key is your funds.
- Use **practice mode** to evaluate the app. Only enable live trading
  deliberately, and only where Polymarket is available to you (see the README
  disclaimer — it is geo-restricted, including in the United States).
