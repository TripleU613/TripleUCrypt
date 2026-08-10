# Guided Onboarding — server-driven browser

**Status:** plan. Nothing built yet.

**Product shape:** open-source, **self-hosted, single-tenant**. Each user deploys their
own instance behind their own Cloudflare Access. The maintainer hosts nothing and holds
nobody's keys. (`state.ts:183` is a single global state object and there is one
`paper_ledger.json` — the app is architecturally one user per instance. That is correct
for this product and stays.)

## Goals, in priority order

1. **Setup easy** — one click. No config files, no browser or OS settings to change.
2. **Credentials extracted automatically** — the user never sees or copies a hex string.
3. **Light** — must fit the existing 2 GB box. No upgrade.
4. **Polymarket and any third party see the SERVER only** — never the user's browser,
   IP or location.

## The decision

**Playwright (headless) + CDP screencast, rendered into a `<canvas>` in our own page.**

Goal 4 is what decides it. Every browser-side option leaks the user's real IP:

| Rejected | Why |
|---|---|
| iframe of polymarket.com | impossible — `frame-ancestors 'self' auth.magic.link chrome-extension://acmac…` |
| new tab / popup | works, but Polymarket sees the **user's** IP → fails 4 |
| direct browser → CLOB | same → fails 4 |
| clipboard capture of the address | the signup still happens in the user's browser → fails 4 |
| SOCKS / WireGuard on the box | per-user OS or browser config → fails 1, and is not a product |
| Ultraviolet / CSP-rewriting proxy | technically dead, see below |
| headful Chromium + VNC | ~450 MB plus Xvfb/x11vnc, 300–600 MB RAM → fails 3 |

Once the browser must live on the server, goal 2 comes free: CDP `page.evaluate` reads
the address straight out of the DOM. No clipboard, no paste, no OCR.

### Why not Ultraviolet (`@titaniumnetwork-dev/ultraviolet` v3.2.10, MIT)

It is the literal "embedded but not embedded" tool — a service-worker proxy that
rewrites a site to run under our origin, stripping CSP, with no browser on the server.
It would satisfy goals 3 and 4. **It fails because every Polymarket login path is
origin-bound:**

- **MetaMask** injects `window.ethereum` per origin; the dApp would connect as
  `crypto.tripleu.org`, not `polymarket.com`.
- **WalletConnect** pairing and its return deep-links are origin-verified.
- **magic.link** (email) enforces an origin allowlist — which is exactly why
  `auth.magic.link` appears in Polymarket's own `frame-ancestors`.
- Their CSP is `default-src 'self'` plus `wss://*.polymarket.com`; every request
  including WebSockets must be rewritten, and it re-breaks on each of their deploys.

Result: a page that renders and **cannot be logged into.** Separately, stripping another
site's anti-framing headers is the clickjacking pattern those headers exist to prevent —
but the login breakage kills it first.

## Architecture

```
user browser ──HTTPS──▶ Cloudflare Access ──tunnel──▶ Express :8200
                                                        │
   canvas  ◀── JPEG frames ── /onboard/stream (WS) ◀─────┤
   input   ──▶ mouse / key ──▶ /onboard/input  ──────────┤
                                                        └─ Playwright headless
                                                           (chrome-headless-shell,
                                                            CDP bound to loopback)
```

- `Page.startScreencast` → JPEG frames → WebSocket → `<canvas>` inside our layout.
  Looks embedded; is a pixel feed, so no origin problems at all.
- `Input.dispatchMouseEvent` / `dispatchKeyEvent` back the other way (~80 lines).
- All Polymarket traffic originates from the **server** — goal 4 by construction.
- Loopback-only; Express proxies it, so **Cloudflare Access already gates the entire
  remote-input surface.** No new port, no new auth to build.
- Spawn on demand, kill on tab close, hard idle timeout. Never resident.

### The constraint that keeps it light

**Popups are the only thing that forces headful + X + VNC.** So support the login
methods that need no popup — all three confirmed present in Polymarket's CSP
`frame-src`:

| Login | Popup? | Key on server? |
|---|---|---|
| **WalletConnect** (`*.walletconnect.com/.org`) | no — the QR is just pixels; the user scans it with their phone | **no** — signing happens on the phone |
| **Email / magic link** (`*.magic.link`) | no — code typed in-page | no wallet involved |
| ~~Google OAuth~~ (`*.google.com`) | **yes** — not supported | — |

Dropping Google login is what buys the light architecture:

| | headful + VNC | **headless + CDP** |
|---|---|---|
| extra services | Xvfb, x11vnc, websockify | **none** |
| browser | ~450 MB | **~170 MB** |
| RAM per page | 300–600 MB | **150–250 MB** |
| wire format | constant framebuffer | **JPEG deltas, fps-capped** |
| box | needs 4 GB | **fits the current 2 GB** |

**The MetaMask extension is NOT installed server-side.** That would put a private key on
the server — the thing browser mode exists to avoid. WalletConnect replaces it: any
mobile wallet, key stays on the user's phone.

## Phases

**Phase 1 — stream + input (~1 day).** Separate compose service, hard memory cap, so it
can never OOM the trading process. `/onboard/stream`, `/onboard/input`, canvas renderer,
spawn/kill lifecycle, idle timeout.
*Done when:* the wallet tab shows a live, drivable Polymarket page.

**Phase 2 — auto-extract (~1 day).** ← goal 2
After onboarding, `page.evaluate` reads the proxy address from the DOM; validate with the
already-shipped `verifyMaker()` so the CLOB confirms the maker before anything is stored;
write to `secrets.env` server-side. The user never sees a hex string.
*Scope discipline:* read values from pages the user navigated to. Do not script signup.

**Phase 3 — step guidance (~half day).** `needs_account → needs_deposit → ready`,
rendered in **our** UI beside the stream. No DOM injection into their page.

**Phase 4 — mode choice (~half day).** Offer Server vs Browser once credentials exist.

## Costs

- **No box upgrade.** Headless shell ~170 MB disk (12 GB free), 150–250 MB RAM
  (~1128 MB available). Fits.
- **Egress:** JPEG deltas only while the tab is open, fps-capped, quality ~60, browser
  killed on close. This is an onboarding surface, not a persistent viewport — the 36.8x
  SSE reduction must not be handed straight back.
- Deps: `playwright` (Apache-2.0). `browserless-chrome` exists but is **GPL-3.0**;
  ~200 lines directly on Playwright is lighter and avoids the licence question.

## Risks

- **ToS.** A human driving a remote browser is close to "using a browser." *Scripting*
  polymarket.com is closer to automation. Phase 2 reads values from pages the user
  navigated to and never automates signup.
- **Open source + Cloudflare Access is not a blanket answer.** Access genuinely gates the
  remote-input surface for free, which is load-bearing here. It does not change
  Polymarket's headers or their stance on automation. Keep the browser loopback-bound and
  short-lived.
- **Isolation.** Separate service, hard memory cap. The browser must never be able to OOM
  the trading process.
- **Brittleness.** DOM extraction breaks when Polymarket redesigns. It must fail loudly
  to a manual field, never silently store a wrong address.

## Prerequisite that may delete Phases 1–3 entirely

**Does a bare-EOA maker work?** The generated wallet (§9, already built) signs
`signatureType 0` — the maker type the CLOB refused with *"maker address not allowed,
please use the deposit wallet flow"*. Its own on-chain approvals may be what legitimises
it; the observed rejection happened *after* approvals had passed.

If bare-EOA **works**, onboarding is already solved and meets all four goals with zero
new code:

> deploy → "Generate trading wallet" → fund the address shown → trade

No Polymarket account, no browser, no extraction. This subsystem then becomes an
*optional* path for people who want to trade an existing Polymarket account.

If it **does not work**, every user needs a Polymarket account and this plan is
mandatory.

**One ~$2 funded test order answers it** — and the same order settles the second blocker:
the SDK's `getContractConfig(137)` reports collateral
`0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` and signs against `exchangeV3`/`exchangeV2`,
while `ClobTrade.ts` approves USDC.e `0x2791bca1…` against the **V1** exchange. For a
self-hosted product that mismatch means telling strangers to fund the wrong token.
