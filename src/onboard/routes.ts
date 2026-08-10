/**
 * onboard/routes — wire the server-side browser (onboard/browser.ts) to the client.
 *
 * One WebSocket at /onboard/ws:
 *   server → client   { t:'frame', data, w, h }   base64 JPEG screencast frames
 *                      { t:'url', url, loading }   where the page actually is
 *   client → server   { t:'input', ev }           mouse/key events into the page
 *                      { t:'nav', url }            address bar: URL, host or search
 *                      { t:'back' | 'forward' | 'reload' }
 *
 * The socket is attached to the app's existing http.Server (no new port) and its path
 * is served through the same origin, so **Cloudflare Access already gates it** — the
 * remote-input surface inherits the login wall for free. It also binds wherever the
 * app binds (127.0.0.1 in prod, behind the tunnel), never the public internet.
 */

import type { Server } from 'http'
import { onboardBrowser, type Input, type OutEvent } from './browser.js'

const WS_PATH = '/onboard/ws'
// Drop frames once this much is already queued for the viewer (~2 frames' worth).
const MAX_BUFFERED_BYTES = 512 * 1024

export function attachOnboardWs(server: Server): void {
  // Lazy import: `ws` is already a dependency, and this keeps the onboarding
  // subsystem out of the hot path for instances that never open the wallet tab.
  void import('ws').then(({ WebSocketServer }) => {
    const wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
      // Only claim our own path; other upgrades (if any) pass through untouched.
      const url = req.url || ''
      if (!url.startsWith(WS_PATH)) return
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
    })

    wss.on('connection', (ws: import('ws').WebSocket) => {
      let detach: (() => void) | null = null
      // The socket can close DURING attach() — which awaits a multi-second Chromium
      // launch for the first viewer. Without this flag, close fires while detach is
      // still null (a no-op), attach() then resolves and adds the sink anyway, and
      // sinks.size never returns to 0 — so the idle-kill timer is never armed and the
      // headless Chromium stays resident forever. Track closure and detach whenever
      // the attach resolves late.
      let closed = false
      const release = (): void => {
        closed = true
        detach?.()
        detach = null
      }

      // Frames out. ws.send can throw on a half-closed socket; swallow so a dead
      // viewer never propagates into the browser controller.
      //
      // DROP rather than queue when the viewer can't keep up: frames arrive
      // continuously (everyNthFrame 1) and a slow socket (mobile, congested tunnel)
      // would otherwise pile base64 JPEGs into ws's unbounded send buffer and grow
      // RSS on a 2 GB box. One frame in flight is enough; the newest frame is the
      // only one worth showing anyway.
      const sink = (e: OutEvent): void => {
        try {
          if (ws.readyState !== ws.OPEN) return
          // Backpressure applies to FRAMES only — dropping an address-bar update would
          // leave the bar showing the wrong page, and those messages are tiny.
          if (e.t === 'frame' && ws.bufferedAmount > MAX_BUFFERED_BYTES) return
          ws.send(JSON.stringify(e))
        } catch { /* viewer gone */ }
      }

      onboardBrowser.attach(sink)
        .then(fn => {
          if (closed) { fn(); return }
          detach = fn
          // Tell a fresh viewer where the page already is, so its address bar is
          // correct before the next navigation happens.
          sink({ t: 'url', url: onboardBrowser.url, loading: false })
        })
        .catch(err => {
          try { ws.send(JSON.stringify({ t: 'error', message: String(err instanceof Error ? err.message : err) })) } catch { /* */ }
          try { ws.close() } catch { /* */ }
        })

      ws.on('message', (raw: import('ws').RawData) => {
        let msg: { t?: string; ev?: Input; url?: string }
        try { msg = JSON.parse(String(raw)) } catch { return }
        if (msg.t === 'input' && msg.ev) void onboardBrowser.input(msg.ev)
        else if (msg.t === 'nav' && typeof msg.url === 'string') void onboardBrowser.navigate(msg.url)
        else if (msg.t === 'back') void onboardBrowser.back()
        else if (msg.t === 'forward') void onboardBrowser.forward()
        else if (msg.t === 'reload') void onboardBrowser.reload()
      })

      ws.on('close', release)
      ws.on('error', release)
    })

    console.log(`onboard ws mounted at ${WS_PATH}`)
  }).catch(err => {
    console.error('onboard ws failed to mount:', err instanceof Error ? err.message : err)
  })
}
