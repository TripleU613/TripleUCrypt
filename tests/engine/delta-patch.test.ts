/**
 * patchMap / patchPrepend — the delta-patch wire protocol.
 *
 * WHY THIS EXISTS
 * ---------------
 * patch() ships the WHOLE value and only dedupes on `===`, so a freshly built
 * collection never matches and the entire thing goes out. Measured on the real
 * stream, three keys were 93.6% of all bytes: token_asks/token_bids re-sent all
 * ~64 entries (~5.3 kB) whenever a single token moved 0.05c, and
 * mkt_trades/activity re-sent the whole capped list to add one row. Switching
 * those to deltas cut the stream 36.8x (68.7 -> 1.87 MB/min, measured).
 *
 * The invariant these tests protect: `state` must still hold the COMPLETE value
 * (the connect snapshot is authoritative and must be able to fully re-sync a
 * client), while only the delta goes on the bus. If that ever inverts — state
 * holding partial data, or the bus carrying the whole collection again — prices
 * silently drift on the client, or the bandwidth win silently disappears.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { bus } from '../../src/bus.js'
import { state, patchMap, patchPrepend } from '../../src/engine/state.js'

type MergeCall = { key: string; set: Record<string, number>; del: string[] }
type PrependCall = { key: string; items: readonly unknown[]; cap: number }

let merges: MergeCall[]
let prepends: PrependCall[]

function onMerge(key: string, set: Record<string, number>, del: string[]): void {
  merges.push({ key, set, del })
}
function onPrepend(key: string, items: readonly unknown[], cap: number): void {
  prepends.push({ key, items, cap })
}

beforeEach(() => {
  merges = []
  prepends = []
  bus.on('merge', onMerge)
  bus.on('prepend', onPrepend)
  // These keys are the real ones the protocol targets.
  state.token_asks = {}
  state.token_bids = {}
  state.mkt_trades = []
  state.activity = []
})

afterEach(() => {
  bus.off('merge', onMerge)
  bus.off('prepend', onPrepend)
  vi.restoreAllMocks()
})

describe('patchMap — map deltas', () => {
  it('broadcasts only the entries that changed, not the whole map', () => {
    state.token_asks = { a: 10, b: 20, c: 30 }
    // Only `b` moves.
    patchMap('token_asks', { a: 10, b: 25, c: 30 })

    expect(merges).toHaveLength(1)
    expect(merges[0]!.key).toBe('token_asks')
    // THE POINT: one entry on the wire, not three.
    expect(merges[0]!.set).toEqual({ b: 25 })
    expect(merges[0]!.del).toEqual([])
  })

  it('still stores the COMPLETE map, so the connect snapshot can re-sync', () => {
    state.token_asks = { a: 10, b: 20 }
    patchMap('token_asks', { a: 10, b: 25, c: 30 })
    // Wire carries the delta...
    expect(merges[0]!.set).toEqual({ b: 25, c: 30 })
    // ...state carries everything.
    expect(state.token_asks).toEqual({ a: 10, b: 25, c: 30 })
  })

  it('reports removed keys so the client can delete them', () => {
    state.token_bids = { a: 1, gone: 2, b: 3 }
    patchMap('token_bids', { a: 1, b: 3 })
    expect(merges[0]!.del).toEqual(['gone'])
    expect(merges[0]!.set).toEqual({})
    expect(state.token_bids).toEqual({ a: 1, b: 3 })
  })

  it('emits nothing when nothing actually changed', () => {
    state.token_asks = { a: 10, b: 20 }
    patchMap('token_asks', { a: 10, b: 20 })
    expect(merges).toHaveLength(0)
    // A no-op must not silently drop the value either.
    expect(state.token_asks).toEqual({ a: 10, b: 20 })
  })

  it('treats a first population as an all-new delta', () => {
    patchMap('token_asks', { a: 1, b: 2 })
    expect(merges[0]!.set).toEqual({ a: 1, b: 2 })
    expect(merges[0]!.del).toEqual([])
  })

  it('does not confuse a 0 value with a missing key', () => {
    state.token_asks = { a: 5 }
    // 0 is a legitimate ask (no bid/ask), and must be sent, not treated as absent.
    patchMap('token_asks', { a: 0 })
    expect(merges[0]!.set).toEqual({ a: 0 })
    expect(merges[0]!.del).toEqual([])
    expect(state.token_asks).toEqual({ a: 0 })
  })
})

describe('patchPrepend — capped newest-first lists', () => {
  it('broadcasts only the new rows, not the whole list', () => {
    state.mkt_trades = [{ id: 'old1' }, { id: 'old2' }]
    patchPrepend('mkt_trades', [{ id: 'new' }], 20)

    expect(prepends).toHaveLength(1)
    // THE POINT: one row on the wire regardless of how long the list is.
    expect(prepends[0]!.items).toEqual([{ id: 'new' }])
    expect(prepends[0]!.cap).toBe(20)
  })

  it('prepends newest-first and keeps the full list in state', () => {
    state.mkt_trades = [{ id: 'old' }]
    patchPrepend('mkt_trades', [{ id: 'new' }], 20)
    expect(state.mkt_trades).toEqual([{ id: 'new' }, { id: 'old' }])
  })

  it('enforces the cap in state, and ships the cap so the client trims identically', () => {
    state.activity = Array.from({ length: 60 }, (_, i) => ({ n: i }))
    patchPrepend('activity', [{ n: 'a' }, { n: 'b' }], 60)
    expect(state.activity).toHaveLength(60)          // still capped
    expect((state.activity as Record<string, unknown>[])[0]).toEqual({ n: 'a' })
    expect(prepends[0]!.cap).toBe(60)                // client trims the same
    expect(prepends[0]!.items).toHaveLength(2)       // only the new rows
  })

  it('emits nothing for an empty batch', () => {
    state.activity = [{ n: 1 }]
    patchPrepend('activity', [], 60)
    expect(prepends).toHaveLength(0)
    expect(state.activity).toEqual([{ n: 1 }])
  })

  it('keeps a multi-row batch in the order given', () => {
    state.activity = [{ n: 'old' }]
    patchPrepend('activity', [{ n: 'x' }, { n: 'y' }], 60)
    expect(state.activity).toEqual([{ n: 'x' }, { n: 'y' }, { n: 'old' }])
  })
})

describe('client-side replay reproduces server state', () => {
  // Mirrors the merge/prepend handlers in client/sse-client.ts. If these two
  // implementations ever diverge, the client's prices drift from the server's
  // with no error anywhere — so pin the semantics here.
  function applyMerge(
    store: Record<string, unknown>, key: string,
    set: Record<string, number>, del: string[],
  ): void {
    const cur = { ...((store[key] as Record<string, number>) ?? {}) }
    for (const d of del) delete cur[d]
    Object.assign(cur, set)
    store[key] = cur
  }
  function applyPrepend(
    store: Record<string, unknown>, key: string, items: readonly unknown[], cap: number,
  ): void {
    const cur = (store[key] as unknown[]) ?? []
    const next = [...items, ...cur]
    store[key] = cap > 0 ? next.slice(0, cap) : next
  }

  it('a snapshot plus replayed deltas equals the final server state', () => {
    // Client starts from the connect snapshot.
    state.token_asks = { a: 1, b: 2, stale: 9 }
    const client: Record<string, unknown> = { token_asks: { ...state.token_asks } }

    // Server mutates over time; each step emits a delta.
    patchMap('token_asks', { a: 1, b: 5, stale: 9 })   // b moves
    patchMap('token_asks', { a: 1, b: 5, c: 7 })       // c added, stale removed
    patchMap('token_asks', { a: 3, b: 5, c: 7 })       // a moves

    for (const m of merges) applyMerge(client, m.key, m.set, m.del)

    expect(client['token_asks']).toEqual(state.token_asks)
    expect(client['token_asks']).toEqual({ a: 3, b: 5, c: 7 })
  })

  it('replayed prepends match the server list, cap included', () => {
    state.mkt_trades = [{ id: 0 }]
    const client: Record<string, unknown> = { mkt_trades: [{ id: 0 }] }

    patchPrepend('mkt_trades', [{ id: 1 }], 3)
    patchPrepend('mkt_trades', [{ id: 2 }], 3)
    patchPrepend('mkt_trades', [{ id: 3 }], 3)   // pushes id:0 past the cap

    for (const p of prepends) applyPrepend(client, p.key, p.items, p.cap)

    expect(client['mkt_trades']).toEqual(state.mkt_trades)
    expect(state.mkt_trades).toHaveLength(3)
    expect(client['mkt_trades']).toEqual([{ id: 3 }, { id: 2 }, { id: 1 }])
  })
})
