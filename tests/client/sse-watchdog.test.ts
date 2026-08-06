/**
 * SSE liveness watchdog.
 *
 * Regression cover for the "screens don't last the day" bug: on a HALF-OPEN
 * connection the socket is dead but EventSource never fires `onerror` and
 * `readyState` stays OPEN, so the tab rendered frozen server state indefinitely
 * while reporting itself connected. Nothing detected it, because the server's
 * only liveness signal was an SSE *comment* (`: ping`), which fires no listener
 * in EventSource and is therefore invisible to the client.
 *
 * These tests drive connectSSE() against a fake EventSource and fake timers to
 * assert the watchdog actually tears down and replaces a silent stream. It
 * matters more than ever now that this stream is the browser's only live feed --
 * there are no market WebSockets left to keep any part of the screen moving.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── Fake EventSource ────────────────────────────────────────────────────────
type Listener = (e: { data: string }) => void

class FakeEventSource {
  static instances: FakeEventSource[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2

  url: string
  readyState = 1                      // OPEN, like a real connected stream
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, cb: Listener): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(cb)
    this.listeners.set(type, arr)
  }

  close(): void {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }

  /** Simulate the server delivering an event. */
  emit(type: string, data: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb({ data: JSON.stringify(data) })
  }

  static reset(): void { FakeEventSource.instances = [] }
  static get live(): FakeEventSource[] { return FakeEventSource.instances.filter(i => !i.closed) }
}

// ── Fakes for the module's collaborators ────────────────────────────────────
const patchSpy = vi.fn()
vi.mock('../../client/store.js', () => ({
  useStore: {
    getState: () => ({
      _connected: true,
      _patch: (u: Record<string, unknown>) => patchSpy(u),
      _pushToast: () => {},
    }),
  },
}))

let cleanup: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.reset()
  patchSpy.mockClear()
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
  // Minimal DOM surface the module touches.
  const noop = () => {}
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: noop, removeEventListener: noop })
  vi.stubGlobal('window', { addEventListener: noop, removeEventListener: noop })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  if (cleanup) { cleanup(); cleanup = null }
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function start() {
  const { connectSSE } = await import('../../client/sse-client.js')
  cleanup = connectSSE()
  return FakeEventSource.instances[0]
}

describe('SSE watchdog', () => {
  it('opens a stream on connect', async () => {
    const es = await start()
    expect(es).toBeDefined()
    expect(es.url).toBe('/sse')
    expect(FakeEventSource.live).toHaveLength(1)
  })

  it('replaces a silent-but-OPEN stream (the half-open zombie case)', async () => {
    const first = await start()
    // Stays OPEN and never errors -- exactly the failure the old code missed.
    expect(first.readyState).toBe(FakeEventSource.OPEN)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(first.closed).toBe(false)              // still inside the grace period

    await vi.advanceTimersByTimeAsync(30_000)     // now past STALE_MS (50s)
    expect(first.closed).toBe(true)               // zombie torn down
    expect(FakeEventSource.instances.length).toBeGreaterThan(1)
    expect(FakeEventSource.live).toHaveLength(1)  // exactly one replacement
  })

  it('a heartbeat keeps the stream alive indefinitely', async () => {
    const es = await start()
    // Beat every 15s like the server does, well past the stale threshold.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(15_000)
      es.emit('hb', Date.now())
    }
    expect(es.closed).toBe(false)
    expect(FakeEventSource.instances).toHaveLength(1)   // never reconnected
  })

  it('real data also counts as liveness (not just heartbeats)', async () => {
    const es = await start()
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(20_000)
      es.emit('patch', { up_ask: 40 + i })
    }
    expect(es.closed).toBe(false)
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('marks the store disconnected when it reconnects a zombie', async () => {
    await start()
    patchSpy.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(patchSpy.mock.calls.some(([u]) => u && u._connected === false)).toBe(true)
  })

  it('replaces a stream found in CLOSED state', async () => {
    const first = await start()
    // Browser gave up retrying; nothing else would have noticed.
    first.readyState = FakeEventSource.CLOSED
    await vi.advanceTimersByTimeAsync(6_000)      // one watchdog tick
    expect(FakeEventSource.live).toHaveLength(1)
    expect(FakeEventSource.live[0]).not.toBe(first)
  })

  it('does not leak streams across repeated reconnects', async () => {
    await start()
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(60_000)
    // Many reconnects, but only ever one live stream at a time.
    expect(FakeEventSource.instances.length).toBeGreaterThan(3)
    expect(FakeEventSource.live).toHaveLength(1)
  })

  it('cleanup closes the stream and stops the watchdog', async () => {
    const es = await start()
    cleanup!(); cleanup = null
    expect(es.closed).toBe(true)
    const n = FakeEventSource.instances.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(FakeEventSource.instances).toHaveLength(n)   // no zombie reconnects
  })
})
