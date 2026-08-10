/**
 * onboard/browser — a single headless browser, running ON THE SERVER, streamed as
 * pixels into the wallet tab.
 *
 * WHY THIS EXISTS (and what it deliberately does NOT do)
 * ------------------------------------------------------
 * Polymarket cannot be iframed (frame-ancestors) and account setup has no API, so to
 * guide a user through it inside the app the app must drive a real browser. Running
 * it here (not in the user's browser) is what makes Polymarket see the SERVER's IP
 * and jurisdiction rather than the user's — the whole point.
 *
 * It renders as a JPEG screencast into a <canvas>. It is a SCREEN, not a wallet:
 *   - The user logs in via WalletConnect (QR scanned by their phone) or email/magic.
 *     With WalletConnect the signing key stays on the phone and never reaches here.
 *   - We read only PUBLIC data from the page (the proxy/maker address, which is
 *     on-chain public info) via page.evaluate.
 *   - We do NOT extract private keys or seed phrases. That is the mechanic of a
 *     wallet drainer, it is unnecessary (CLOB trading needs the public address plus a
 *     signature, never the raw key), and it would be impossible for the safe logins
 *     anyway (the key is on the phone / custodied). This module has no such path and
 *     must never grow one.
 *
 * Lifecycle: launched on demand, killed when the last viewer disconnects or after an
 * idle timeout. Never resident.
 *
 * CAVEAT (do not read more safety into this than exists): it currently runs INSIDE the
 * app container, sharing the process's memory limits. docker-compose's
 * deploy.resources.limits is Swarm-only and is ignored by `docker compose up`, so
 * there is no enforced cap today — a heavy page could contend for RAM with the trading
 * engine on a small box. Mitigations in place are on-demand launch + idle kill. Moving
 * it to its own service with mem_limit is the real fix and is not done yet.
 */

import type { Browser, Page, CDPSession } from 'playwright-core'

// ── Tuning ──────────────────────────────────────────────────────────────────────

// Mobile viewport so the page fits the wallet-tab window and Polymarket serves its
// mobile layout (simpler, fewer popups, thumb-sized controls).
const VIEWPORT = { width: 390, height: 780 }
const DEVICE_SCALE = 2
const SCREENCAST = { format: 'jpeg' as const, quality: 60, maxWidth: 780, maxHeight: 1560, everyNthFrame: 1 }
const IDLE_KILL_MS = 90_000     // no viewer for this long → shut the browser down
const START_URL = 'https://polymarket.com/'

/**
 * Turn whatever was typed in the address bar into something to load — the same
 * judgement a real browser's omnibox makes.
 *
 * This is a FULL browser by design: any http/https destination is allowed, because the
 * user needs to be able to reach whatever their onboarding actually requires (wallets,
 * exchanges, email, support pages) without us guessing the list up front.
 *
 * Non-web schemes (file:, chrome:, about: beyond blank) are treated as a SEARCH rather
 * than opened. That is not a browsing restriction — it is what an omnibox does with
 * input that isn't a web address — and it keeps a typo from turning the server's own
 * filesystem into a page. Everything reachable over http/https stays reachable.
 */
export function resolveNavInput(raw: string): string {
  const q = String(raw ?? '').trim()
  if (!q) return 'about:blank'
  // Already a web URL.
  if (/^https?:\/\//i.test(q)) {
    try { new URL(q); return q } catch { /* fall through to search */ }
  }
  // Looks like a bare host ("polymarket.com", "app.uniswap.org/swap") → https.
  if (/^[\w-]+(\.[\w-]+)+(\/[^\s]*)?$/.test(q) && !q.includes(' ')) {
    return 'https://' + q
  }
  // Anything else: search it.
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(q)
}

// Where the headless-shell binary lives. Installed on the box by provision.sh; the
// env var lets a deployer point at a system Chromium instead. No bundled download.
function executablePath(): string | undefined {
  return (process.env['PLAYWRIGHT_CHROMIUM_PATH'] || '').trim() || undefined
}

// ── Types the client cares about ──────────────────────────────────────────────

export type Frame = { data: string; w: number; h: number }   // base64 jpeg + css px
// What the viewer receives. Frames are pixels; 'url' keeps the address bar in sync
// with wherever the page actually went (in-page links, redirects, logins).
export type OutEvent =
  | ({ t: 'frame' } & Frame)
  | { t: 'url'; url: string; loading: boolean }
export type MouseInput = { type: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
export type KeyInput = { type: 'key'; text?: string; key?: string; code?: string }
export type Input = MouseInput | KeyInput

type FrameSink = (e: OutEvent) => void

// ── Controller (single-tenant: one browser per instance) ────────────────────────

class OnboardBrowser {
  private browser: Browser | null = null
  private page: Page | null = null
  private cdp: CDPSession | null = null
  private sinks = new Set<FrameSink>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private starting: Promise<void> | null = null

  /** Is a browser currently live? */
  get running(): boolean { return this.browser !== null }

  /** Attach a viewer. Launches the browser on the first one. Returns a detach fn. */
  async attach(sink: FrameSink): Promise<() => void> {
    this.sinks.add(sink)
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    await this.ensureStarted()
    return () => this.detach(sink)
  }

  private detach(sink: FrameSink): void {
    this.sinks.delete(sink)
    // Last viewer gone → arm the idle shutdown. A quick reconnect cancels it.
    if (this.sinks.size === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => { void this.stop() }, IDLE_KILL_MS)
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.browser) return
    if (this.starting) return this.starting
    this.starting = this._launch().finally(() => { this.starting = null })
    return this.starting
  }

  private async _launch(): Promise<void> {
    const { chromium } = await import('playwright-core')
    const browser = await chromium.launch({
      headless: true,
      executablePath: executablePath(),
      args: [
        '--no-sandbox',                        // containerised, non-root user
        '--disable-dev-shm-usage',             // /dev/shm is tiny in containers
        '--disable-gpu',
      ],
    })
    // Adopt the process IMMEDIATELY. If any later step throws, the catch below can
    // close it — otherwise the launched Chromium would be unreachable (this.browser
    // still null) and leak, AND `running` staying false would let the next attach()
    // launch another one, piling up orphans on a flapping launch.
    this.browser = browser
    try {
      await this._wire(browser)
    } catch (e) {
      await this.stop().catch(() => {})
      throw e
    }
  }

  private async _wire(browser: Browser): Promise<void> {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE,
      isMobile: true,
      hasTouch: true,
      // A real mobile UA so Polymarket serves the mobile layout.
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
        + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    })
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)

    cdp.on('Page.screencastFrame', (e: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } }) => {
      // ACK immediately or Chromium stops sending frames.
      cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {})
      this.emit({
        t: 'frame',
        data: e.data,
        w: e.metadata?.deviceWidth ?? VIEWPORT.width,
        h: e.metadata?.deviceHeight ?? VIEWPORT.height,
      })
    })

    this.page = page
    this.cdp = cdp

    // Keep the client's address bar honest: report wherever the page actually ends up,
    // including in-page links, redirects and login bounces we never asked for.
    page.on('framenavigated', f => {
      if (f === page.mainFrame()) this.emit({ t: 'url', url: f.url(), loading: false })
    })
    page.on('load', () => this.emit({ t: 'url', url: page.url(), loading: false }))

    await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await cdp.send('Page.startScreencast', SCREENCAST).catch(() => {})
  }

  private emit(e: OutEvent): void {
    for (const s of this.sinks) { try { s(e) } catch { /* a bad sink must not kill the stream */ } }
  }

  /** Current address, for a viewer that just attached. */
  get url(): string { return this.page?.url() ?? '' }

  /** Feed one input event from the client into the page. Never throws. */
  async input(ev: Input): Promise<void> {
    const cdp = this.cdp
    if (!cdp) return
    try {
      if (ev.type === 'move' || ev.type === 'down' || ev.type === 'up') {
        await cdp.send('Input.dispatchMouseEvent', {
          type: ev.type === 'move' ? 'mouseMoved' : ev.type === 'down' ? 'mousePressed' : 'mouseReleased',
          x: ev.x, y: ev.y,
          button: ev.button ?? 'left',
          clickCount: ev.type === 'down' ? 1 : 0,
        })
      } else if (ev.type === 'key') {
        // insertText handles pasted / typed characters incl. emoji; dispatchKeyEvent
        // handles named keys (Enter, Backspace, arrows).
        if (ev.text) await cdp.send('Input.insertText', { text: ev.text })
        else if (ev.key) {
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ev.key, code: ev.code })
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ev.key, code: ev.code })
        }
      }
    } catch {
      /* input on a torn-down page — ignore */
    }
  }

  /**
   * Navigate. Unrestricted by design: this is a general-purpose browser so the user can
   * reach whatever their setup needs, not a kiosk locked to one site. Input goes through
   * resolveNavInput so the address bar accepts URLs, bare hosts, or search terms.
   */
  async navigate(input: string): Promise<void> {
    const target = resolveNavInput(input)
    const p = this.page
    if (!p) return
    this.emit({ t: 'url', url: target, loading: true })
    try { await p.goto(target, { waitUntil: 'domcontentloaded' }) } catch { /* ignore */ }
    this.emit({ t: 'url', url: p.url(), loading: false })
  }

  /** Browser history / reload, so the embedded view behaves like a real browser. */
  async back(): Promise<void> { try { await this.page?.goBack({ waitUntil: 'domcontentloaded' }) } catch { /* */ } }
  async forward(): Promise<void> { try { await this.page?.goForward({ waitUntil: 'domcontentloaded' }) } catch { /* */ } }
  async reload(): Promise<void> { try { await this.page?.reload({ waitUntil: 'domcontentloaded' }) } catch { /* */ } }

  /**
   * Read PUBLIC page data with a caller-supplied DOM function. Used by Phase 2 to
   * capture the proxy/maker address (public, on-chain) — never secrets. Returns null
   * on any failure; callers must validate (verifyMaker) before trusting it.
   */
  async readPage<T>(fn: () => T): Promise<T | null> {
    try { return (await this.page?.evaluate(fn)) ?? null } catch { return null }
  }

  async stop(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    const b = this.browser
    this.browser = null; this.page = null; this.cdp = null
    try { await b?.close() } catch { /* already gone */ }
  }
}

/** One controller per instance (single-tenant app). */
export const onboardBrowser = new OnboardBrowser()
