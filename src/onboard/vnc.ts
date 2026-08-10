/**
 * onboard/vnc — a REAL Chromium window, running on the server, streamed to the client.
 *
 * WHY THIS EXISTS ALONGSIDE browser.ts
 * ------------------------------------
 * browser.ts streams via CDP Page.startScreencast, which captures the PAGE VIEWPORT
 * only — browser chrome is never in those frames. So the toolbar, tabs, omnibox and
 * extension buttons cannot be shown that way; a UI has to fake them, which is what it
 * did. To show the actual browser the whole WINDOW must be captured, so:
 *
 *   Xvfb (virtual X display) → headed Chromium on that display → x11vnc → WebSocket
 *   → noVNC in the wallet tab.
 *
 * What this buys, beyond looking right:
 *   - Genuine Chromium UI: tabs, omnibox, back/forward, menus, downloads, devtools.
 *   - A PERSISTENT profile, so logins survive between sessions.
 *   - Extensions actually work (Playwright can't load them in Firefox at all, and
 *     Chromium needs a headed persistent profile — which this is).
 *
 * "Mobile mode" is a phone-shaped display (portrait, phone-width) plus a mobile UA, so
 * sites serve their mobile layout and the window fits the wallet tab — with the real
 * toolbar on top rather than a drawn one.
 *
 * Same contract as browser.ts: this is a SCREEN. It reads no keys and no seed phrases;
 * whatever the user types goes to the page, not to us.
 *
 * Lifecycle: the three processes start on the first viewer and are killed together when
 * the last one leaves (after an idle grace). Never resident.
 */

import { spawn, type ChildProcess } from 'child_process'
import net from 'net'
import fs from 'fs'
import path from 'path'
import os from 'os'

// ── Tuning ──────────────────────────────────────────────────────────────────────

const DISPLAY_NUM = 99
const DISPLAY = `:${DISPLAY_NUM}`
// Phone-shaped, portrait. Chromium's toolbar eats ~72px of this, leaving a
// phone-proportioned page area beneath a real toolbar.
const SCREEN_W = 420
const SCREEN_H = 900
const VNC_PORT = 5900
const IDLE_KILL_MS = 120_000
const START_URL = 'https://polymarket.com/'
// A real mobile UA so sites serve mobile layouts at this width.
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/151.0.0.0 Mobile Safari/537.36'

function chromiumBin(): string {
  return (process.env['PLAYWRIGHT_CHROMIUM_PATH'] || '').trim() || '/usr/bin/chromium'
}

/** Persistent profile: keeps logins and installed extensions between sessions. */
function profileDir(): string {
  const base = (process.env['TC_DATA_DIR'] ?? '').trim() || path.join(os.homedir(), '.triplecrypt')
  return path.join(base, 'onboard-profile')
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

/** Resolve once something is listening on a local TCP port (or time out). */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(resolve => {
      const s = net.connect({ host: '127.0.0.1', port })
      const done = (v: boolean) => { try { s.destroy() } catch { /* */ } resolve(v) }
      s.once('connect', () => done(true))
      s.once('error', () => done(false))
      setTimeout(() => done(false), 500)
    })
    if (ok) return true
    await sleep(200)
  }
  return false
}

class VncBrowser {
  private xvfb: ChildProcess | null = null
  private chrome: ChildProcess | null = null
  private x11vnc: ChildProcess | null = null
  private viewers = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private starting: Promise<void> | null = null

  get running(): boolean { return this.x11vnc !== null }
  get port(): number { return VNC_PORT }

  /** Claim a viewer slot, starting the stack if needed. Returns a release fn. */
  async acquire(): Promise<() => void> {
    this.viewers++
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    try {
      await this.ensureStarted()
    } catch (e) {
      // Never leave a phantom viewer behind on a failed start, or the idle timer would
      // never arm and the processes (if partially up) would linger forever.
      this.release()
      throw e
    }
    let released = false
    return () => { if (!released) { released = true; this.release() } }
  }

  private release(): void {
    this.viewers = Math.max(0, this.viewers - 1)
    if (this.viewers === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => { void this.stop() }, IDLE_KILL_MS)
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.running) return
    if (this.starting) return this.starting
    this.starting = this._launch().finally(() => { this.starting = null })
    return this.starting
  }

  private async _launch(): Promise<void> {
    try {
      // 1. Virtual display.
      this.xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', `${SCREEN_W}x${SCREEN_H}x24`, '-nolisten', 'tcp'],
        { stdio: 'ignore' })
      this.xvfb.on('exit', () => { this.xvfb = null })
      // Xvfb has no port to poll; wait for its socket to appear.
      const sock = `/tmp/.X11-unix/X${DISPLAY_NUM}`
      for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(100)
      if (!fs.existsSync(sock)) throw new Error('Xvfb failed to start (no X socket)')

      // 2. Headed Chromium ON that display, with a persistent profile.
      const dir = profileDir()
      fs.mkdirSync(dir, { recursive: true })
      this.chrome = spawn(chromiumBin(), [
        `--user-data-dir=${dir}`,
        `--window-size=${SCREEN_W},${SCREEN_H}`,
        '--window-position=0,0',
        `--user-agent=${MOBILE_UA}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--disable-infobars',
        '--no-sandbox',                 // containerised, non-root user
        '--disable-dev-shm-usage',      // /dev/shm is tiny in containers
        '--disable-gpu',
        START_URL,
      ], { stdio: 'ignore', env: { ...process.env, DISPLAY } })
      this.chrome.on('exit', () => { this.chrome = null })

      // 3. Export the display over VNC. Localhost-only: the WS bridge is the only way
      // in, and it rides the app's origin (so Cloudflare Access already gates it).
      this.x11vnc = spawn('x11vnc', [
        '-display', DISPLAY,
        '-rfbport', String(VNC_PORT),
        '-localhost',
        '-nopw',
        '-forever',
        '-shared',
        '-noxdamage',
        '-quiet',
      ], { stdio: 'ignore', env: { ...process.env, DISPLAY } })
      this.x11vnc.on('exit', () => { this.x11vnc = null })

      if (!await waitForPort(VNC_PORT, 15_000)) throw new Error('x11vnc did not open its port')
    } catch (e) {
      // Tear down whatever came up so a retry starts clean instead of stacking
      // processes on a box that cannot spare the memory.
      await this.stop()
      throw e
    }
  }

  /** Kill the whole stack. Safe to call repeatedly. */
  async stop(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    for (const p of [this.x11vnc, this.chrome, this.xvfb]) {
      if (!p) continue
      try { p.kill('SIGTERM') } catch { /* already gone */ }
    }
    await sleep(300)
    for (const p of [this.x11vnc, this.chrome, this.xvfb]) {
      if (p && p.exitCode === null) { try { p.kill('SIGKILL') } catch { /* */ } }
    }
    this.x11vnc = null; this.chrome = null; this.xvfb = null
    this.viewers = 0
  }
}

export const vncBrowser = new VncBrowser()

/** Screen geometry, so the client can size its canvas without guessing. */
export const VNC_GEOMETRY = { width: SCREEN_W, height: SCREEN_H }
