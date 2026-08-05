import { describe, it, expect, beforeEach } from 'vitest'
import { getBroker, getPaperBroker, setQuoteProvider, BrokerAdapter } from '../../src/banking/index.js'

// Simulate the live bid/ask the engine streams.
const QUOTES: Record<string, { bid: number; ask: number; outcome: string; asset: string }> = {
  'tok-up': { bid: 80, ask: 82, outcome: 'UP', asset: 'BTC' },
}

describe('BrokerAdapter (engine-facing) — paper buy/positions/sell', () => {
  beforeEach(async () => {
    setQuoteProvider(t => ({ token: t, ...(QUOTES[t] ?? { bid: 0, ask: 0, outcome: '?', asset: '?' }) }))
    await getPaperBroker()?.resetPractice()
  })

  it('buy creates a sellable position that getPositions returns', async () => {
    const broker = getBroker()!
    const fill = await broker.buy('UP', 25, 'tok-up')
    expect(fill.ok).toBe(true)
    expect(fill.shares).toBeGreaterThan(0)
    expect(fill.price).toBe(82) // filled at live ask

    const positions = await broker.getPositions()
    expect(positions.length).toBe(1)
    expect(positions[0]['token']).toBe('tok-up')
    expect(positions[0]['asset_dir_label']).toBe('BTC Up')
    expect(positions[0]['resolved']).toBe(false) // stays on the sell list
    expect(String(positions[0]['size_str'])).toContain('shares')
  })

  it('sell-all (amount=-1) closes the position', async () => {
    const broker = getBroker()!
    await broker.buy('UP', 25, 'tok-up')

    const fill = await broker.sell('tok-up', -1)
    expect(fill.ok).toBe(true)
    expect(fill.shares).toBeGreaterThan(0)
    expect(fill.price).toBe(80) // filled at live bid

    const positions = await broker.getPositions()
    expect(positions.length).toBe(0)
  })

  it('leaves an in-range explicit sell size untouched (partial sell still works)', async () => {
    const broker = getBroker()!
    const buy = await broker.buy('UP', 25, 'tok-up')
    const half = buy.shares / 2

    const fill = await broker.sell('tok-up', half)
    expect(fill.ok).toBe(true)
    expect(fill.shares).toBeCloseTo(half, 4)
    // The remainder is still open — the clamp must not close the whole position.
    const positions = await broker.getPositions()
    expect(positions.length).toBe(1)
    expect(Number(positions[0]['shares'])).toBeCloseTo(half, 4)
  })
})

// ── TOCTOU guard on the explicit-size (quick-sell) branch ────────────────────
// The $5/$25/$50 buttons pass a size from the client's LAST-POLLED snapshot,
// which can overstate the real balance after a partial/external sale or a
// resolution. The adapter must clamp DOWN before submitting.
//
// These use a STUB broker that does not clamp, deliberately: PaperBroker's
// ledger already does `Math.min(shares, pos.shares)` internally, so asserting
// through it would pass even with the adapter guard removed. LiveBroker is the
// one that forwards the size straight to the CLOB — that's what's under test.
describe('BrokerAdapter.sell — stale-size clamp (stub broker, no internal clamp)', () => {
  function stubBroker(held: number) {
    const submitted: number[] = []
    const broker = {
      mode: 'live' as const,
      portfolio: async () => ({
        positions: held > 0 ? [{ token: 'tok', shares: held }] : [],
      }),
      // Mimics LiveBroker: fills exactly what it was handed, no clamping.
      sell: async (_t: string, shares: number) => {
        submitted.push(shares)
        return {
          token: 'tok', side: 'SELL', shares, price: 50, usd: shares * 0.5,
          ok: true, error: '', order_id: 'stub', unconfirmed: false,
        }
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { adapter: new BrokerAdapter(broker as any), submitted }
  }

  it('clamps an oversized stale request down to the real holding', async () => {
    const { adapter, submitted } = stubBroker(10)
    const fill = await adapter.sell('tok', 100, 40)   // stale snapshot says 100
    expect(fill.ok).toBe(true)
    expect(submitted).toEqual([10])                   // submitted the real 10, not 100
    expect(fill.shares).toBe(10)
  })

  it('refuses (and submits nothing) when the position is already gone', async () => {
    const { adapter, submitted } = stubBroker(0)
    const fill = await adapter.sell('tok', 50, 40)
    expect(fill.ok).toBe(false)
    expect(fill.error).toBe('Nothing to sell')
    expect(submitted).toEqual([])                     // never reached the broker
  })

  it('passes an in-range size through unchanged', async () => {
    const { adapter, submitted } = stubBroker(10)
    const fill = await adapter.sell('tok', 4, 40)
    expect(fill.ok).toBe(true)
    expect(submitted).toEqual([4])                    // not clamped to 10
    expect(fill.shares).toBe(4)
  })

  it('falls back to the requested size when the freshness read throws', async () => {
    const submitted: number[] = []
    const broker = {
      mode: 'live' as const,
      portfolio: async () => { throw new Error('rpc down') },
      sell: async (_t: string, shares: number) => {
        submitted.push(shares)
        return {
          token: 'tok', side: 'SELL', shares, price: 50, usd: shares * 0.5,
          ok: true, error: '', order_id: 'stub', unconfirmed: false,
        }
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new BrokerAdapter(broker as any)
    const fill = await adapter.sell('tok', 7, 40)
    // A read failure must not block a legitimate sell.
    expect(fill.ok).toBe(true)
    expect(submitted).toEqual([7])
  })
})
