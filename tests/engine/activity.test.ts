import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initState, ingestRtdsFrame } from '../../src/engine/activity.js'
import { state } from '../../src/engine/state.js'
import type { ActivityEntry } from '../../src/engine/activity.js'

function frameTrade(over: Record<string, unknown> = {}): unknown {
  return {
    topic: 'activity',
    payload: {
      conditionId: '0xabc', side: 'BUY', outcome: 'Up', size: '10', price: '0.5',
      name: 'alice', ...over,
    },
  }
}

describe('activity feed', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    initState(state)
  })

  it('coalesces arrivals into one patch on the flush interval', () => {
    ingestRtdsFrame(frameTrade())
    ingestRtdsFrame(frameTrade({ name: 'bob' }))
    // Nothing published until the flush timer fires — one frame per message is
    // exactly what the coalescing exists to prevent.
    expect(state.activity).toEqual([])

    vi.advanceTimersByTime(300)
    expect(state.activity.length).toBe(2)
    // Newest first
    expect(state.activity[0]!.text).toContain('bob')
  })

  it('formats a trade row ready to render', () => {
    ingestRtdsFrame(frameTrade())
    vi.advanceTimersByTime(300)
    const e = state.activity[0] as ActivityEntry
    expect(e.kind).toBe('trade')
    expect(e.up).toBe(true)
    expect(e.text).toBe('alice bought Up $5.00')
    expect(e.t).toMatch(/^\d\d:\d\d:\d\d$/)
  })

  it('keeps trades from every market — no condition_id filter', () => {
    ingestRtdsFrame(frameTrade({ conditionId: '0xsomewhere-else', name: 'zed' }))
    vi.advanceTimersByTime(300)
    expect(state.activity[0]!.text).toContain('zed')
  })

  it('renders SELL and Down', () => {
    ingestRtdsFrame(frameTrade({ side: 'SELL', outcome: 'Down', size: '4000', price: '0.5' }))
    vi.advanceTimersByTime(300)
    const e = state.activity[0]!
    expect(e.up).toBe(false)
    expect(e.text).toBe('alice sold Down $2,000')
  })

  it('renders a comment', () => {
    ingestRtdsFrame({ topic: 'comments', payload: { body: 'gm', profile: { name: 'carol' } } })
    vi.advanceTimersByTime(300)
    expect(state.activity[0]).toMatchObject({ kind: 'chat', text: 'carol: gm' })
  })

  it('ignores chainlink frames (they arrive via the chart socket instead)', () => {
    ingestRtdsFrame({ topic: 'crypto_prices_chainlink', payload: { symbol: 'BTC/USD', value: '100' } })
    vi.advanceTimersByTime(300)
    expect(state.activity).toEqual([])
  })

  it('caps the array so it cannot bloat every SSE snapshot', () => {
    for (let i = 0; i < 200; i++) ingestRtdsFrame(frameTrade({ name: `u${i}` }))
    vi.advanceTimersByTime(300)
    expect(state.activity.length).toBe(60)
    // Newest survive
    expect(state.activity[0]!.text).toContain('u199')
  })

  it('survives malformed frames', () => {
    expect(() => { ingestRtdsFrame(null); ingestRtdsFrame('x'); ingestRtdsFrame({}) }).not.toThrow()
    vi.advanceTimersByTime(300)
    expect(state.activity).toEqual([])
  })
})
