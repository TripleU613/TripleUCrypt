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
      // `no-transform` was here to stop proxies mangling the stream, but it also
      // forbids Cloudflare from COMPRESSING it -- and this payload is repeated,
      // near-identical JSON arrays that gzip ~29x (measured over a 60s capture:
      // 25.4 MB -> 0.88 MB). Dropping it is the largest bandwidth win available
      // and directly cuts the GCP egress bill.
      //
      // `no-cache` still prevents caching and X-Accel-Buffering: no still prevents
      // buffering, which is what actually matters for stream liveness.
      'Cache-Control': 'no-cache',
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

// ── Broadcast delta patches ───────────────────────────────────────────────────
// See the patchMap/patchPrepend notes in src/engine/state.ts. Separate event names
// (rather than an envelope inside `patch`) keep the wire readable in DevTools and
// let the client apply each with the right merge semantics.

function _writeAll(msg: string): void {
  for (const res of _clients) {
    try {
      res.write(msg)
    } catch {
      _cleanup(res)
    }
  }
}

/** Changed map entries (`set`) plus removed keys (`del`). */
export function broadcastMerge(key: string, set: Record<string, number>, del: string[]): void {
  if (_clients.size === 0) return
  _writeAll(`event: merge\ndata: ${JSON.stringify({ k: key, set, del })}\n\n`)
}

/** New rows for a capped newest-first list; `cap` so the client trims the same. */
export function broadcastPrepend(key: string, items: readonly unknown[], cap: number): void {
  if (_clients.size === 0) return
  _writeAll(`event: prepend\ndata: ${JSON.stringify({ k: key, items, cap })}\n\n`)
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
bus.on('merge', broadcastMerge)
bus.on('prepend', broadcastPrepend)
bus.on('notify', broadcastNotify)

export function getClientCount(): number {
  return _clients.size
}
