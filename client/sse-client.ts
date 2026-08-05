import { useStore } from './store.js'

/**
 * Open an SSE connection to /sse and feed the Zustand store.
 * Returns a cleanup function that closes the connection.
 */
export function connectSSE(): () => void {
  const source = new EventSource('/sse')
  let downTimer: ReturnType<typeof setTimeout> | null = null

  // EventSource auto-reconnects. Only surface a disconnect if the stream stays
  // down a few seconds — avoids a banner/grey-out flash on every brief blip.
  const markUp = () => {
    if (downTimer) { clearTimeout(downTimer); downTimer = null }
    if (!useStore.getState()._connected) useStore.getState()._patch({ _connected: true })
  }

  source.onopen = markUp

  source.addEventListener('snapshot', (e: MessageEvent) => {
    try {
      const snap = JSON.parse(e.data)
      if (downTimer) { clearTimeout(downTimer); downTimer = null }
      // These are read client-side from the connected wallet — the server's copy
      // is always empty/zero, so don't let a (re)connect snapshot clobber them.
      delete snap.mm_usdc; delete snap.mm_usdce; delete snap.mm_pol; delete snap.mm_bal_loading
      useStore.getState()._patch({ ...snap, _connected: true })
    } catch {
      // ignore malformed snapshot
    }
  })

  source.addEventListener('patch', (e: MessageEvent) => {
    try {
      const patch = JSON.parse(e.data)
      markUp()
      useStore.getState()._patch(patch)
    } catch {
      // ignore malformed patch
    }
  })

  source.addEventListener('notify', (e: MessageEvent) => {
    try {
      const n = JSON.parse(e.data)
      if (n && n.text) {
        useStore.getState()._pushToast({ id: n.id, level: n.level ?? 'log', text: String(n.text) })
      }
    } catch {
      // ignore malformed notification
    }
  })

  source.onerror = () => {
    // Debounce: report disconnected only after a sustained outage; a quick
    // reconnect (snapshot/patch) cancels it.
    if (!downTimer) {
      downTimer = setTimeout(() => {
        downTimer = null
        useStore.getState()._patch({ _connected: false })
      }, 4000)
    }
  }

  return () => {
    if (downTimer) clearTimeout(downTimer)
    source.close()
  }
}
