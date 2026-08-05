/**
 * SSE broadcaster — manages all connected SSE clients.
 *
 * On new client connection:
 *   1. Writes SSE headers
 *   2. Sends a full AppState snapshot as `event: snapshot`
 *   3. Registers client for future patch events
 *
 * On bus 'patch' event:
 *   Sends delta to all clients as `event: patch`
 *
 * On client disconnect:
 *   Removes client from the list
 */
import type { Request, Response } from 'express'
import { state } from '../engine/state.js'
import { bus } from '../bus.js'

// ── Client registry ───────────────────────────────────────────────────────────

const _clients: Set<Response> = new Set()
const _heartbeats: Map<Response, ReturnType<typeof setInterval>> = new Map()

function _cleanup(res: Response): void {
  const hb = _heartbeats.get(res)
  if (hb) { clearInterval(hb); _heartbeats.delete(res) }
  _clients.delete(res)
}

// ── SSE request handler ───────────────────────────────────────────────────────

export function sseHandler(req: Request, res: Response): void {
  // Write SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()

  // Tell EventSource to retry quickly (2s) if the stream drops.
  res.write('retry: 2000\n\n')

  // Send full snapshot on connect — re-syncs state on every (re)connect.
  res.write(`event: snapshot\ndata: ${JSON.stringify(state)}\n\n`)

  _clients.add(res)

  // Heartbeat every 15s. Keeps the connection alive through proxies
  // (cloudflared/nginx idle timeouts) during quiet periods AND — critically —
  // gives the browser something it can actually OBSERVE.
  //
  // This used to be an SSE comment (`: ping`). Comments keep proxies happy but
  // fire NO listener in EventSource, so the client had no way to tell a live
  // stream from a dead one. On a half-open connection (laptop sleep, wifi
  // change, NAT/edge idle reset) the TCP socket dies with no FIN, `onerror`
  // never fires, readyState stays OPEN, and the tab renders frozen state
  // forever while believing it is connected. A NAMED event is visible to the
  // client, which lets it run a staleness watchdog. See client/sse-client.ts.
  const hb = setInterval(() => {
    try { res.write(`event: hb\ndata: ${Date.now()}\n\n`) } catch { _cleanup(res) }
  }, 15000)
  _heartbeats.set(res, hb)

  req.on('close', () => _cleanup(res))
  res.on('error', () => _cleanup(res))
}

// ── Broadcast a patch to all connected clients ────────────────────────────────

export function broadcastPatch(key: string, value: unknown): void {
  if (_clients.size === 0) return
  const data = JSON.stringify({ [key]: value })
  const msg = `event: patch\ndata: ${data}\n\n`
  for (const res of _clients) {
    try {
      res.write(msg)
    } catch {
      // Client gone — drop it and clear its heartbeat
      _cleanup(res)
    }
  }
}

// ── Broadcast a notification to all connected clients ─────────────────────────

export function broadcastNotify(payload: { id: number; level: string; text: string }): void {
  if (_clients.size === 0) return
  const msg = `event: notify\ndata: ${JSON.stringify(payload)}\n\n`
  for (const res of _clients) {
    try {
      res.write(msg)
    } catch {
      _cleanup(res)
    }
  }
}

// Wire up bus listeners once at module load
bus.on('patch', broadcastPatch)
bus.on('notify', broadcastNotify)

export function getClientCount(): number {
  return _clients.size
}
