/**
 * ws-guard — keep an upstream WebSocket from dying silently.
 *
 * THE PROBLEM
 * -----------
 * Every stream loop in src/engine follows this shape:
 *
 *     while (!signal.aborted) {
 *       await new Promise((resolve, reject) => {
 *         const ws = new WebSocket(url)
 *         ws.on('error', reject)
 *         ws.on('close', resolve)
 *       })
 *     }
 *
 * That reconnects fine on a CLEAN failure. But on a HALF-OPEN socket -- the peer
 * or a middlebox drops the connection without sending FIN/RST, which is routine
 * over days of uptime -- neither 'close' nor 'error' ever fires. The promise
 * never settles, the loop is stuck awaiting forever, and that feed is dead until
 * the process restarts. Note the background-task supervisor in engine/index.ts
 * cannot save this: the loop is not crashing, it is hung.
 *
 * THE FIX
 * -------
 * Actively probe with WebSocket ping frames. A live peer answers with a pong,
 * which counts as liveness -- so a legitimately QUIET market (no trades for a
 * while) is never killed, only a genuinely unresponsive one. If nothing arrives
 * for `staleMs`, terminate() the socket, which forces 'close' to fire, settles
 * the promise, and lets the existing loop reconnect on its normal path.
 */

import type WebSocket from 'ws'

export interface GuardOptions {
  /** Name for logs, e.g. 'kraken'. */
  label: string
  /** Terminate after this long with no message AND no pong. Default 45s. */
  staleMs?: number
}

/**
 * Attach a liveness guard to `ws`. Returns a stop function; it is also wired to
 * the socket's own 'close'/'error' so it cleans itself up.
 */
export function guardSocket(ws: WebSocket, opts: GuardOptions): () => void {
  const staleMs = opts.staleMs ?? 45_000
  // Probe at a third of the budget: two probes can be lost before we give up.
  const probeMs = Math.max(5_000, Math.floor(staleMs / 3))

  // Starts now, which also covers "never finished connecting": if the handshake
  // blackholes, no message and no pong ever arrive and we terminate rather than
  // waiting out the OS-level TCP timeout (which can be many minutes).
  let last = Date.now()
  let stopped = false

  const bump = (): void => { last = Date.now() }
  ws.on('message', bump)
  ws.on('pong', bump)
  ws.on('open', bump)

  const timer = setInterval(() => {
    if (stopped) return
    const age = Date.now() - last
    if (age > staleMs) {
      console.warn(`[ws:${opts.label}] silent for ${Math.round(age / 1000)}s - terminating to force reconnect`)
      // terminate(), not close(): a half-open socket will not complete a
      // graceful closing handshake, so close() can hang exactly as long as the
      // problem we are solving.
      try { ws.terminate() } catch { /* already gone */ }
      return
    }
    try { ws.ping() } catch { /* socket not open yet, or already gone */ }
  }, probeMs)

  // Don't hold the event loop open on shutdown.
  if (typeof timer.unref === 'function') timer.unref()

  const stop = (): void => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }

  ws.on('close', stop)
  ws.on('error', stop)

  return stop
}
