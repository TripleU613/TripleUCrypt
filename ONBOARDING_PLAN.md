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
**plus** a remote-input surface) for *less* safety.

Dropping the extension does **not** buy a lighter architecture, though — full user
control does require a headful browser regardless (native popups, OS dialogs,
clipboard). What replaces the extension is **WalletConnect**: the user scans a QR with
their phone and signs there, so no key reaches the server. See 3b.

## 3. Architecture

**REVISED.** An earlier draft chose headless Chromium + CDP screencast on footprint
grounds. That was correct for a *narrow guided flow* and wrong for the actual
requirement, which is **the user must fully control the browser, and we do not know
which login method they will pick.** Headless cannot do native popups (Google
OAuth), OS file dialogs, or clipboard properly. So: headful browser, whole-desktop
stream.

```
user browser ──HTTPS──▶ Cloudflare Access ──tunnel──▶ Express :8200
                                                        │
                                                        ├─ /remote  → websockify → x11vnc (loopback)
                                                        └─ Xvfb :99 + headful Chromium (no extensions)
```

Streaming the whole X display, not a single page target, is what makes "full control"
work: every popup, dropdown, native dialog and clipboard action is just pixels and
input on a real desktop. No per-target window management to hand-write.

Cost of the reversal, measured: Xvfb (2.1 MB) + x11vnc (2.1 MB) + websockify (85 KB)
on disk, full Chromium instead of the headless shell (~450 MB vs ~170 MB), ~300-600 MB
RAM per page instead of ~150-250 MB, and a framebuffer instead of JPEG deltas.

**Bandwidth mitigations** (a framebuffer would otherwise undo the 36.8x SSE cut):
- stream **only** while the onboarding tab is open; kill the browser on close
- modest display (1280x800), 16-bit colour depth
- `tight` encoding + `-ncache`; noVNC quality/compression turned down
- this is an **onboarding-only** surface, not a persistent viewport

`chromium` is **not** a real deb on Ubuntu 24.04 (`chromium-browser` is a 103 KB snap
shim; snap does not work in Docker), so the binary comes from Playwright's download or
a Playwright base image either way.

**Everything binds loopback.** Browser, X display and VNC are never exposed. Express
proxies the socket, so **Cloudflare Access already gates the whole remote-input
surface** — no new auth, no new open port. This is the part where Access is doing real
load-bearing work.

**Lifecycle:** spawn on demand, kill on tab close, hard idle timeout. Never resident.

## 3b. How the user logs into Polymarket

We do not have to choose — all three of Polymarket's methods work in a headful remote
browser. Confirmed from their own CSP `frame-src`:

```
https://*.magic.link            https://*.walletconnect.com
https://*.google.com            https://*.walletconnect.org
```

| Method | How it works in the remote browser | Key on the server? |
|---|---|---|
| **WalletConnect** *(recommended)* | Polymarket renders a QR; the user scans it with **any** mobile wallet. Every signature happens on their phone. | **No.** The browser is only a screen. |
| Email / magic link | Code arrives in the user's email; they type it into the stream. | No wallet involved. |
| Google OAuth | Opens a **native popup** — the reason headful is required. | No wallet involved. |

**WalletConnect is the answer to "I don't know how they will log in."** It is
wallet-agnostic (MetaMask mobile, Rainbow, Trust, Coinbase Wallet, ...) and it keeps
custody on the user's phone, so the server never holds a key even though the browser
runs there.

**Installing the MetaMask extension into the server browser is possible and NOT
recommended.** It would put the private key on the server — the thing this plan
otherwise avoids. Offer it only as an explicit expert choice, clearly labelled, never
the default.

## 4. Phases

### Phase 1 — the browser exists (~1 day)
- Add a **separate compose service** for the browser (isolated, resource-capped,
  killable without touching the trading app)
- `/remote` websocket -> websockify -> x11vnc; **noVNC** client bundled (no canvas
  renderer or input mapping to hand-write -- that came free with the reversal)
- Launch Chromium with `--remote-debugging-port` on **loopback** as well: VNC carries
  the pixels, CDP stays available for Phase 3's read-back. Both, not either.
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
- After onboarding, read the proxy address from the page via **CDP** `page.evaluate`
  (the debugging port from Phase 1 -- streaming is VNC, read-back is CDP)
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
