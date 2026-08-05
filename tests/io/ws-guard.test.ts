/**
 * ws-guard — upstream socket liveness.
 *
 * Regression cover for the server-side half of "the screens don't last the day":
 * every stream loop awaits a promise that only settles on 'close'/'error', so a
 * half-open upstream socket (no FIN/RST) hangs the loop FOREVER and that feed is
 * dead until the process restarts. The background-task supervisor cannot catch
 * it, because the loop is hung rather than crashing.
 *
 * Uses a fake `ws`-shaped EventEmitter so we can assert terminate() is what
 * fires (not close(), which can itself hang on a half-open socket).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { guardSocket } from '../../src/io/ws-guard.js'

/** Minimal stand-in for a `ws` WebSocket. */
class FakeWs extends EventEmitter {
  pings = 0
  terminated = 0
  closed = 0
  ping(): void { this.pings++ }
  terminate(): void { this.terminated++; this.emit('close') }
  close(): void { this.closed++ }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const guard = (ws: FakeWs, staleMs = 45_000) =>
  guardSocket(ws as any, { label: 'test', staleMs })

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('guardSocket', () => {
  it('probes with pings rather than sitting passive', () => {
    const ws = new FakeWs()
    guard(ws)
    expect(ws.pings).toBe(0)
    vi.advanceTimersByTime(15_000)
    expect(ws.pings).toBe(1)
    vi.advanceTimersByTime(15_000)
    expect(ws.pings).toBe(2)
  })

  it('terminates a socket that never answers (the half-open case)', () => {
    const ws = new FakeWs()
    guard(ws)
    vi.advanceTimersByTime(30_000)
    expect(ws.terminated).toBe(0)          // still within budget
    vi.advanceTimersByTime(30_000)         // past 45s with no message/pong
    expect(ws.terminated).toBe(1)
  })

  it('uses terminate(), not close() - close can hang on a half-open socket', () => {
    const ws = new FakeWs()
    guard(ws)
    vi.advanceTimersByTime(60_000)
    expect(ws.terminated).toBe(1)
    expect(ws.closed).toBe(0)
  })

  it('a pong keeps a QUIET but healthy socket alive indefinitely', () => {
    const ws = new FakeWs()
    guard(ws)
    // No market data at all for 5 minutes, but the peer answers every probe.
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(15_000)
      ws.emit('pong')
    }
    expect(ws.terminated).toBe(0)          // never killed for merely being quiet
    expect(ws.pings).toBeGreaterThan(15)
  })

  it('real messages also count as liveness', () => {
    const ws = new FakeWs()
    guard(ws)
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(20_000)
      ws.emit('message', Buffer.from('{}'))
    }
    expect(ws.terminated).toBe(0)
  })

  it('goes quiet after the socket closes (no work on a dead handle)', () => {
    const ws = new FakeWs()
    guard(ws)
    vi.advanceTimersByTime(15_000)
    const pings = ws.pings
    ws.emit('close')
    vi.advanceTimersByTime(120_000)
    expect(ws.pings).toBe(pings)           // stopped probing
    expect(ws.terminated).toBe(0)
  })

  it('stops on error too', () => {
    const ws = new FakeWs()
    guard(ws)
    ws.emit('error', new Error('reset'))
    const pings = ws.pings
    vi.advanceTimersByTime(120_000)
    expect(ws.pings).toBe(pings)
    expect(ws.terminated).toBe(0)
  })

  it('the returned stop() disables it', () => {
    const ws = new FakeWs()
    const stop = guard(ws)
    stop()
    vi.advanceTimersByTime(120_000)
    expect(ws.pings).toBe(0)
    expect(ws.terminated).toBe(0)
  })

  it('terminates only once even if timers keep firing', () => {
    const ws = new FakeWs()
    guard(ws)
    vi.advanceTimersByTime(300_000)
    // terminate() emits 'close', which stops the guard -> exactly one kill.
    expect(ws.terminated).toBe(1)
  })

  it('covers a handshake that never completes (no open, no error)', () => {
    const ws = new FakeWs()
    guard(ws, 30_000)
    // 'open' never fires; a blackholed SYN would otherwise wait out the OS TCP
    // timeout, which can be minutes.
    //
    // The contract is "dead within staleMs + one probe interval", not exactly at
    // staleMs: the guard only kills on a probe tick, and probes run every
    // staleMs/3. So at 31s (past the budget but before the 40s tick) it is still
    // alive by design; by 41s it must be gone.
    vi.advanceTimersByTime(31_000)
    expect(ws.terminated).toBe(0)
    vi.advanceTimersByTime(10_000)
    expect(ws.terminated).toBe(1)
  })

  it('always dies within staleMs + one probe interval', () => {
    for (const staleMs of [15_000, 30_000, 45_000, 60_000]) {
      const ws = new FakeWs()
      guard(ws, staleMs)
      const probeMs = Math.max(5_000, Math.floor(staleMs / 3))
      vi.advanceTimersByTime(staleMs)
      expect(ws.terminated, `staleMs=${staleMs}: alive at the budget`).toBe(0)
      vi.advanceTimersByTime(probeMs + 1_000)
      expect(ws.terminated, `staleMs=${staleMs}: dead one probe later`).toBe(1)
    }
  })
})
