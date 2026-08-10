/**
 * onboard/vnc-routes — bridge noVNC (in the browser) to x11vnc (on the server).
 *
 * noVNC speaks the RFB protocol over a *binary* WebSocket. x11vnc speaks RFB over plain
 * TCP on localhost. This is the pipe between them — the job websockify does, which is
 * about forty lines with `ws` + `net`, so there's no reason to add Python to the image.
 *
 * Mounted on the app's existing http.Server at /onboard/vnc, so it shares the origin
 * (Cloudflare Access gates it for free) and opens no extra public port. x11vnc itself
 * binds 127.0.0.1 only, so this bridge is the sole way in.
 *
 * The VNC stack is started on the first viewer and killed when the last one leaves; see
 * vnc.ts. Nothing runs until someone opens the wallet tab.
 */

import type { Server } from 'http'
import net from 'net'
import { vncBrowser } from './vnc.js'

const WS_PATH = '/onboard/vnc'
// Stop reading from the TCP side when the socket is this far behind, so a slow viewer
// can't make us buffer framebuffer updates without bound.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

export function attachVncWs(server: Server): void {
  void import('ws').then(({ WebSocketServer }) => {
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })

    server.on('upgrade', (req, socket, head) => {
      const url = req.url || ''
      if (!url.startsWith(WS_PATH)) return   // not ours; leave it for other handlers
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
    })

    wss.on('connection', async (ws: import('ws').WebSocket) => {
      let release: (() => void) | null = null
      let closed = false
      let tcp: net.Socket | null = null

      const shutdown = (): void => {
        closed = true
        try { tcp?.destroy() } catch { /* */ }
        tcp = null
        release?.(); release = null
        try { if (ws.readyState === ws.OPEN) ws.close() } catch { /* */ }
      }
      ws.on('close', shutdown)
      ws.on('error', shutdown)

      // Booting Xvfb + Chromium + x11vnc takes seconds; the viewer can vanish during
      // it. If that happens, hand the slot straight back so the idle timer arms and the
      // processes don't sit there holding memory with nobody watching.
      try {
        release = await vncBrowser.acquire()
      } catch (e) {
        try { ws.close(1011, String(e instanceof Error ? e.message : e).slice(0, 120)) } catch { /* */ }
        return
      }
      if (closed) { release(); return }

      tcp = net.connect({ host: '127.0.0.1', port: vncBrowser.port })

      tcp.on('connect', () => {
        // server → client
        tcp?.on('data', (buf: Buffer) => {
          if (ws.readyState !== ws.OPEN) return
          try {
            ws.send(buf, { binary: true })
            if (ws.bufferedAmount > MAX_BUFFERED_BYTES) tcp?.pause()
          } catch { shutdown() }
        })
        // Resume reading once the viewer has caught up. RFB is stateful — frames cannot
        // be dropped like JPEGs, so this throttles instead of discarding.
        const drain = setInterval(() => {
          if (!tcp) { clearInterval(drain); return }
          if (tcp.isPaused() && ws.bufferedAmount < MAX_BUFFERED_BYTES / 2) tcp.resume()
        }, 50)
        tcp?.on('close', () => clearInterval(drain))
      })

      // client → server (input events, framebuffer requests)
      ws.on('message', (data: import('ws').RawData, isBinary: boolean) => {
        if (!tcp || tcp.destroyed) return
        const buf = Buffer.isBuffer(data) ? data
          : Array.isArray(data) ? Buffer.concat(data)
          : Buffer.from(data as ArrayBuffer)
        try { tcp.write(buf) } catch { shutdown() }
        void isBinary
      })

      tcp.on('error', shutdown)
      tcp.on('close', shutdown)
    })

    console.log(`onboard vnc ws mounted at ${WS_PATH}`)
  }).catch(err => {
    console.error('onboard vnc ws failed to mount:', err instanceof Error ? err.message : err)
  })
}
