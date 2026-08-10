import { useStore } from './store.js'

/**
 * Open an SSE connection to /sse and feed the Zustand store.
 * Returns a cleanup function that closes the connection.
 *
 * WHY THERE IS A WATCHDOG HERE
 * ----------------------------
 * EventSource cannot be trusted to notice a dead stream. On a HALF-OPEN
 * connection -- laptop sleep, wifi/network change, NAT or Cloudflare-edge idle
 * reset -- the socket dies without a FIN, so:
 *   * `onerror` never fires,
 *   * `readyState` stays OPEN,
 *   * the browser never retries.
 * The tab then renders whatever it last received, forever, while reporting
 * itself connected. This stream is now the ONLY live feed the browser has --
 * prices, order book, windows, positions and scoreboard all arrive here -- so a
 * half-open stream freezes the entire screen while it claims to be connected.
 *
 * So the server emits a named `hb` event every 15s and we require it: if
 * nothing at all arrives for STALE_MS, tear the stream down and reopen. That is
 * the only reliable way to catch this case.
 */

/** No data of any kind for this long => dead, not merely quiet. Server
 *  heartbeat is 15s, so this tolerates ~3 missed beats. */
const STALE_MS = 50_000
/** Watchdog cadence. Background tabs throttle timers to ~1/min, which is
 *  exactly why visibilitychange also forces an immediate check below. */
const CHECK_MS = 5_000

export function connectSSE(): () => void {
  let source: EventSource | null = null
  let downTimer: ReturnType<typeof setTimeout> | null = null
  let lastRx = Date.now()
  let closed = false
  let reopening = false

  const clearDown = (): void => {
    if (downTimer) { clearTimeout(downTimer); downTimer = null }
  }

  /** Any inbound event proves the stream is alive. */
  const markRx = (): void => {
    lastRx = Date.now()
    clearDown()
    if (!useStore.getState()._connected) useStore.getState()._patch({ _connected: true })
  }

  function open(): void {
    if (closed) return
    reopening = false
    const src = new EventSource('/sse')
    source = src

    src.onopen = markRx

    // Carries no state — exists purely so the client can prove the stream is
    // still delivering. Do not remove.
    src.addEventListener('hb', markRx)

    src.addEventListener('snapshot', (e: MessageEvent) => {
      markRx()
      try {
        const snap = JSON.parse(e.data)
        // Read client-side from the connected wallet — the server's copy is
        // always empty/zero, so don't let a (re)connect snapshot clobber them.
        delete snap.mm_usdc; delete snap.mm_usdce; delete snap.mm_pol; delete snap.mm_bal_loading
        useStore.getState()._patch({ ...snap, _connected: true })
      } catch {
        // ignore malformed snapshot
      }
    })

    src.addEventListener('patch', (e: MessageEvent) => {
      markRx()
      try {
        useStore.getState()._patch(JSON.parse(e.data))
      } catch {
        // ignore malformed patch
      }
    })

    // ── Delta events (see patchMap/patchPrepend in src/engine/state.ts) ──────
    // The server used to ship whole collections; token_asks/token_bids plus
    // mkt_trades/activity were 93.6% of all stream bytes. These apply the delta
    // locally. A dropped delta self-heals: every (re)connect replays a full
    // snapshot, which is authoritative.

    src.addEventListener('merge', (e: MessageEvent) => {
      markRx()
      try {
        const { k, set, del } = JSON.parse(e.data) as {
          k: string; set: Record<string, number>; del: string[]
        }
        if (!k) return
        const store = useStore.getState()
        const cur = { ...((store as unknown as Record<string, unknown>)[k] as Record<string, number> ?? {}) }
        if (Array.isArray(del)) for (const d of del) delete cur[d]
        Object.assign(cur, set ?? {})
        store._patch({ [k]: cur } as never)
      } catch {
        // ignore malformed merge
      }
    })

    src.addEventListener('prepend', (e: MessageEvent) => {
      markRx()
      try {
        const { k, items, cap } = JSON.parse(e.data) as {
          k: string; items: unknown[]; cap: number
        }
        if (!k || !Array.isArray(items) || items.length === 0) return
        const store = useStore.getState()
        const cur = ((store as unknown as Record<string, unknown>)[k] as unknown[]) ?? []
        // Trim with the server's own cap so both sides hold the same window.
        const next = cap > 0 ? [...items, ...cur].slice(0, cap) : [...items, ...cur]
        store._patch({ [k]: next } as never)
      } catch {
        // ignore malformed prepend
      }
    })

    src.addEventListener('notify', (e: MessageEvent) => {
      markRx()
      try {
        const n = JSON.parse(e.data)
        if (n && n.text) {
          useStore.getState()._pushToast({ id: n.id, level: n.level ?? 'log', text: String(n.text) })
        }
      } catch {
        // ignore malformed notification
      }
    })

    src.onerror = () => {
      // Debounce: only report disconnected after a sustained outage; a quick
      // reconnect cancels it. EventSource retries by itself here — this is the
      // CLEAN failure. The watchdog handles the dirty one, where no error comes.
      if (!downTimer) {
        downTimer = setTimeout(() => {
          downTimer = null
          useStore.getState()._patch({ _connected: false })
        }, 4000)
      }
    }
  }

  /** Tear down a zombie stream and start a fresh one. */
  function reopen(why: string): void {
    if (closed || reopening) return
    reopening = true
    // Detach before closing so a late error/retry can't race the new stream.
    if (source) {
      try {
        source.onerror = null
        source.onopen = null
        source.close()
      } catch { /* already gone */ }
      source = null
    }
    useStore.getState()._patch({ _connected: false })
    console.warn(`[sse] ${why} - reconnecting`)
    lastRx = Date.now()          // give the new stream a full grace period
    open()
  }

  function checkLiveness(): void {
    if (closed) return
    const age = Date.now() - lastRx
    if (age > STALE_MS) {
      reopen(`no data for ${Math.round(age / 1000)}s`)
      return
    }
    if (source && source.readyState === 2 /* CLOSED */) {
      reopen('stream closed')
    }
  }

  open()
  const watchdog = setInterval(checkLiveness, CHECK_MS)

  // Returning to the tab is the highest-risk moment: timers were throttled or
  // frozen while hidden, so the watchdog may not have run for minutes. Check
  // right now instead of waiting for the next tick.
  // (There used to be a kickBuses() call here and in checkLiveness above, to
  // force the browser's RTDS/CLOB sockets to recover alongside the stream. Those
  // sockets are gone -- the server owns them now -- so there is nothing to kick.)
  const onWake = (): void => {
    if (document.visibilityState !== 'visible') return
    checkLiveness()
  }
  document.addEventListener('visibilitychange', onWake)
  // Waking from sleep or restoring from the back/forward cache does not always
  // emit visibilitychange.
  window.addEventListener('online', onWake)
  window.addEventListener('pageshow', onWake)

  return () => {
    closed = true
    clearInterval(watchdog)
    clearDown()
    document.removeEventListener('visibilitychange', onWake)
    window.removeEventListener('online', onWake)
    window.removeEventListener('pageshow', onWake)
    if (source) { try { source.close() } catch { /* already gone */ } source = null }
  }
}
