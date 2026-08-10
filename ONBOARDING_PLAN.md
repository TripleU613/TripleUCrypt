# Guided Onboarding — server-driven browser

**Status:** plan only. Nothing here is built.
**Goal:** a fresh user goes from "server is up" to "first trade" without reading a
credentials table, copying a hex string, or leaving the app.

---

## 1. The constraint that decides the architecture

Polymarket **cannot be embedded in an iframe.** Measured from the production host:

```
$ curl -sI https://polymarket.com/ | grep frame-ancestors
frame-ancestors 'self' https://auth.magic.link chrome-extension://acmacodkjbdgmoleebolmdjonilkdbch
```

Only Polymarket itself, Magic's auth domain, and one specific extension may frame
it. There is also no API for account creation, and no public endpoint that resolves
an EOA to its proxy wallet (probed: `polymarket.com/api`, `data-api`, `gamma-api`,
`lb-api` — all 404; `gamma-api/users` returns 401, so it exists but needs a
polymarket.com session cookie we cannot have).

So: to guide a user through Polymarket onboarding *inside* this app, the app must
drive a **real browser it controls**. That is the only mechanism left.

## 2. What the server browser is for — and what it is NOT for

**It is for:**

1. **Presenting the correct jurisdiction.** A user physically in a permitted country
   but behind a corporate VPN that exits somewhere restricted cannot onboard from
   their own machine. A browser on the host presents the host's country, which is
   the user's actual permitted location, not their employer's exit node.
2. **Reaching a flow that has no API.** Account creation and deposit are
   browser-only by Polymarket's design.
3. **Killing the copy-paste.** If the app owns the browser session it can read the
   proxy address off the page itself. The paste exists only because the app does not
   own the session.

**It is NOT for holding a wallet.** Running MetaMask in the server's browser would
put the private key on the server — precisely what browser ("Wallet") mode exists to
avoid. That would be *more* attack surface than server mode (a key-holding extension
**plus** a remote-input surface) for *less* safety. MetaMask is therefore out of this
flow entirely, which is what allows the lightweight architecture below: no extension
means no headful browser means no X server.

## 3. Architecture

```
user browser ──HTTPS──▶ Cloudflare Access ──tunnel──▶ Express :8200
                                                        │
                                                        ├─ GET  /onboard/stream   (JPEG frames, SSE or WS)
                                                        ├─ POST /onboard/input    (mouse/key -> CDP)
                                                        └─ chrome-headless-shell via CDP (loopback only)
```

**CDP screencast, not VNC.** Chosen on measured footprint:

| | VNC stack | CDP screencast |
|---|---|---|
| Extra services | Xvfb + x11vnc + websockify | none |
| Browser | full Chromium, ~450 MB disk | `chrome-headless-shell`, ~170 MB |
| RAM per page | ~300–600 MB | ~150–250 MB |
| Wire format | raw framebuffer, always streaming | JPEG deltas, only on change, fps-capped |
| Input | free (real X input) | hand-mapped (~80 lines) |

The framebuffer is the problem: SSE was just cut 36.8x (68.7 -> 1.87 MB/min) and a
constant framebuffer would hand that back. Screencast deltas are throttleable.

Note: `chromium` is **not** a real deb on Ubuntu 24.04 — `chromium-browser` is a
103 KB snap shim, and snap does not work inside Docker. The binary must come from
Playwright's own download (or a Playwright base image) regardless of which option is
chosen.

**Everything binds loopback.** The browser and CDP are never exposed. Express proxies
them, so **Cloudflare Access already gates the whole surface** — no new auth to
build, no new port to firewall.

**Lifecycle:** spawn on demand when the onboarding tab opens; kill on close; hard
idle timeout. Never a permanently resident browser.

## 4. Phases

### Phase 1 — the browser exists (~1 day)
- Add a **separate compose service** for the browser (isolated, resource-capped,
  killable without touching the trading app)
- `/onboard/stream` + `/onboard/input`, client-side canvas renderer
- Spawn/kill lifecycle + idle timeout
- **Done when:** the wallet tab shows a live, drivable Polymarket page.

### Phase 2 — guided overlays (~1 day)
- Step machine in server state:
  `needs_account -> needs_deposit -> needs_proxy -> ready`
- Overlays render in **our** UI beside the stream. They do **not** inject into
  Polymarket's DOM — no tampering, no automation grey area.
- Each step: what to do, why, and a "done / stuck" control.
- Cuttable: can start as three lines of static text.

### Phase 3 — zero-paste credential capture (~1–2 days)  ← the actual prize
- After onboarding, read the proxy address from the page via CDP `page.evaluate`
- Validate with the existing `verifyMaker()` (already shipped) — the CLOB confirms
  the maker before anything is stored
- Write to `/opt/tripleucrypt/secrets.env` server-side; the user never sees a hex
  string
- **Scope discipline:** read one address from a page the user already navigated to.
  Do not script the signup itself.

### Phase 4 — mode choice (~half day)
- With creds present, offer **Server** (recommended) vs **Browser**
- Additional browser views spawn only where a real one is needed (deposit, claim)

**Fast path:** Phases 1 + 3 alone deliver click-clack, ~2 days. Phase 2 is polish.

## 5. Costs

**The box must be upgraded.** Measured on the live host: 833 MB used of 1961 MB, so
~1128 MB available. A browser page at 150–250 MB fits, but with no margin for the
build (`vite build` already needs the 2 GB swap) or a second page.

  e2-small (2 GB, ~$13/mo)  ->  e2-medium (4 GB, ~$27/mo)

Disk is fine: 12 GB free, browser needs ~170 MB.

**Egress.** Screencast is bandwidth-heavy while visible. Mitigations: stream only
while the tab is open, cap fps, JPEG quality ~60, and treat this as an
**onboarding-only** surface rather than a persistent viewport. At $0.12/GB this is
the main running cost and the main reason CDP beat VNC.

## 6. Risks and boundaries

- **Terms of service.** A human driving a remote browser is close to "using a
  browser." *Scripting* polymarket.com is closer to automation. Phase 3 stays on the
  right side of that line by reading a single value from a page the user navigated
  to, and never automating signup.
- **Open source + Cloudflare Access is not a blanket answer.** Access protects *who
  can reach this app* — real and load-bearing here, since it gates the remote-input
  surface for free. It does not change Polymarket's headers, their automation stance,
  or the fact that a remote browser is a powerful primitive. Keep it loopback-bound
  and short-lived.
- **Rejected: reverse-proxying polymarket.com through our origin to strip
  `frame-ancestors`.** It would be the lightest option (no browser at all) and it
  would work for the geo problem. Not doing it: those headers are anti-clickjacking
  controls, stripping another site's framing protection to embed it is the exact
  attack they exist to stop, and it breaks their cookie-scoped auth, WebSockets and
  magic.link redirects anyway.
- **Resource isolation.** The browser must not be able to OOM the trading process.
  Separate service with a hard memory cap, not a child of the app.

## 7. Open questions blocking a start

1. **Email/magic login or wallet login?** Changes Phase 3:
   - **Email/magic** -> type-1 **proxy wallet**. The official `@polymarket/sdk`
     (8.0.1) ships `getProxyWalletAddress(factory, user)` — real CREATE2 derivation,
     salt `keccak256("polymarket-wallet-factory")`. The address may be *derivable*
     rather than scraped, if the Polygon factory address can be sourced (the package
     takes it as an argument and does not publish it).
   - **Wallet login** -> type-2 **Gnosis Safe**. No published derivation; must be
     read off the page.
   - Email is simpler *and* possibly derivable. Recommended starting point.
2. **Is this to unblock one user, or a product feature?** A one-off unblock argues
   for the crude version. A feature for strangers cloning the repo argues for
   repeatability and isolation from the start, and justifies the cost easily.
3. **Cheaper alternative first:** if the user can get off the corporate VPN for ten
   minutes (phone on cellular, personal machine), they can onboard directly and paste
   once — problem solved for zero code and zero dollars. Worth confirming this is
   genuinely unavailable before building a remote-browser subsystem.

## 8. Independent blockers — resolve before Phase 3 ships

Neither depends on this plan, both gate a real trade:

1. **Collateral / exchange-version mismatch.** The SDK's `getContractConfig(137)`
   reports collateral `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` and signs against
   `exchangeV3` / `exchangeV2`, while `client/buses/ClobTrade.ts` approves USDC.e
   `0x2791bca1...` against the **V1** exchange. Onboarding a user and then funding
   the wrong token would be a bad first experience.
2. **Do bare-EOA makers work at all?** The generated wallet signs `signatureType 0`
   — the maker type the CLOB refused with "maker address not allowed, please use the
   deposit wallet flow". Its own on-chain approvals may be what legitimises it, but
   the observed rejection happened *after* approvals passed.

Both are answerable with a single ~$2 funded test order.
