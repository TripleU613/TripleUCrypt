/**
 * onboard/routes — wire the server-side browser (onboard/browser.ts) to the client.
 *
 * One WebSocket at /onboard/ws:
 *   server → client   { t:'frame', data, w, h }   base64 JPEG screencast frames
 *   client → server   { t:'input', ev }           mouse/key events into the page
 *                      { t:'nav', url }            navigate the page
 *
 * The socket is attached to the app's existing http.Server (no new port) and its path
 * is served through the same origin, so **Cloudflare Access already gates it** — the
 * remote-input surface inherits the login wall for free. It also binds wherever the
 * app binds (127.0.0.1 in prod, behind the tunnel), never the public internet.
 */

import type { Server } from 'http'
import { onboardBrowser, type Input } from './browser.js'

const WS_PATH = '/onboard/ws'

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

      // Frames out. ws.send can throw on a half-closed socket; swallow so a dead
      // viewer never propagates into the browser controller.
      const sink = (f: { data: string; w: number; h: number }): void => {
        try {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'frame', ...f }))
        } catch { /* viewer gone */ }
      }

      onboardBrowser.attach(sink)
        .then(fn => { detach = fn })
        .catch(err => {
          try { ws.send(JSON.stringify({ t: 'error', message: String(err instanceof Error ? err.message : err) })) } catch { /* */ }
          try { ws.close() } catch { /* */ }
        })

      ws.on('message', (raw: import('ws').RawData) => {
        let msg: { t?: string; ev?: Input; url?: string }
        try { msg = JSON.parse(String(raw)) } catch { return }
        if (msg.t === 'input' && msg.ev) void onboardBrowser.input(msg.ev)
        else if (msg.t === 'nav' && typeof msg.url === 'string') void onboardBrowser.navigate(msg.url)
      })

      ws.on('close', () => { detach?.() })
      ws.on('error', () => { detach?.() })
    })

    console.log(`onboard ws mounted at ${WS_PATH}`)
  }).catch(err => {
    console.error('onboard ws failed to mount:', err instanceof Error ? err.message : err)
  })
}
