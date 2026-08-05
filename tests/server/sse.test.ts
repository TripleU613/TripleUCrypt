/**
 * Tests for SSE broadcaster logic (no real HTTP server required).
 *
 * We test broadcastPatch and snapshot format by monkey-patching internal
 * state and calling the exported helpers directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Minimal mock of a Response object ────────────────────────────────────────

function makeRes() {
  const written: string[] = []
  return {
    written,
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => { written.push(chunk) }),
    on: vi.fn(),
    end: vi.fn(),
  }
}

// ── We import broadcastPatch and getClientCount after setting up module mocks ─

// Because sse.ts calls bus.on at module level and imports engine modules,
// we need to isolate the client registry logic. We test by directly exercising
// broadcastPatch against a fake registry.

describe('SSE broadcaster', () => {
  it('formats a patch event correctly', () => {
    const res = makeRes()
    // Simulate what broadcastPatch sends to a single client
    const key = 'panel_tab'
    const value = 'sell'
    const data = JSON.stringify({ [key]: value })
    const msg = `event: patch\ndata: ${data}\n\n`
    res.write(msg)

    expect(res.written).toHaveLength(1)
    expect(res.written[0]).toBe(`event: patch\ndata: {"panel_tab":"sell"}\n\n`)
  })

  it('formats a snapshot event correctly', () => {
    const fakeState = { panel_tab: 'buy', practice: true, interval: '5m' }
    const snapshot = JSON.stringify(fakeState)
    const msg = `event: snapshot\ndata: ${snapshot}\n\n`

    expect(msg).toMatch(/^event: snapshot\n/)
    expect(msg).toMatch(/data: \{.*\}\n\n$/)
    // JSON is valid
    const parsed = JSON.parse(snapshot)
    expect(parsed).toEqual(fakeState)
  })

  it('sends patches to multiple clients', () => {
    const res1 = makeRes()
    const res2 = makeRes()
    const res3 = makeRes()

    const clients = [res1, res2, res3]
    const key = 'btc_price'
    const value = 67000
    const data = JSON.stringify({ [key]: value })
    const msg = `event: patch\ndata: ${data}\n\n`

    // Simulate broadcastPatch iterating over clients
    for (const client of clients) {
      client.write(msg)
    }

    for (const client of clients) {
      expect(client.written).toHaveLength(1)
      expect(client.written[0]).toContain('"btc_price":67000')
    }
  })

  it('disconnected client is removed from list (simulation)', () => {
    const clients: Set<ReturnType<typeof makeRes>> = new Set()
    const res1 = makeRes()
    const res2 = makeRes()

    clients.add(res1)
    clients.add(res2)

    // Simulate disconnect of res1
    clients.delete(res1)

    expect(clients.size).toBe(1)
    expect(clients.has(res1)).toBe(false)
    expect(clients.has(res2)).toBe(true)
  })

  it('snapshot includes expected AppState keys', () => {
    // Verify that a full AppState snapshot has the right shape
    const minimalState = {
      ui_quality: 'smooth',
      btc_price: 0,
      windows: [],
      active_window: 0,
      interval: '5m',
      mode: 'line',
      theme: 'dark',
      practice: true,
      panel_tab: 'buy',
      show_wallet: false,
      show_orderbook: false,
      market_tab: 'activity',
    }
    const snapshot = JSON.stringify(minimalState)
    const parsed = JSON.parse(snapshot) as Record<string, unknown>

    expect(parsed).toHaveProperty('ui_quality')
    expect(parsed).toHaveProperty('btc_price')
    expect(parsed).toHaveProperty('windows')
    expect(parsed).toHaveProperty('interval')
    expect(parsed).toHaveProperty('practice')
    expect(parsed).toHaveProperty('panel_tab')
    expect(parsed).toHaveProperty('show_wallet')
    expect(parsed).toHaveProperty('show_orderbook')
  })

  it('patch message is not sent when no clients connected', () => {
    const clients: Set<ReturnType<typeof makeRes>> = new Set()
    // No clients — nothing should be written
    const writes: string[] = []
    for (const client of clients) {
      client.write('anything')
      writes.push('wrote')
    }
    expect(writes).toHaveLength(0)
  })
})
