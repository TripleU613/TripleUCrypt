import { state, patch, sleep } from './state.js'
import type { AppState } from './state.js'
import { obSleep } from './performance.js'
import type { OrderBookLevel } from '../types.js'

// ── IO imports ────────────────────────────────────────────────────────────────

type BookLevel = { price: string | number; size?: string | number }
type OrderbookResult = {
  best_bid: number
  best_ask: number
  bids: BookLevel[]
  asks: BookLevel[]
}

type PolymarketFetchOrderbook = (tokenId: string) => Promise<OrderbookResult>

let fetchOrderbook: PolymarketFetchOrderbook | null = null

try {
  const pm = await import('../io/polymarket.js')
  fetchOrderbook = pm.fetchOrderbook as unknown as PolymarketFetchOrderbook
} catch {
  // io/polymarket not available
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initState(s: AppState): void {
  s.show_orderbook = false
  s.ob_side = 'UP'
  s.ob_up_levels = []
  s.ob_dn_levels = []
  s.ob_last_up = ''
  s.ob_last_dn = ''
  s.ob_spread_up = ''
  s.ob_spread_dn = ''
  s.ob_loading = false
}

// ── Pure: compute OB levels ───────────────────────────────────────────────────

function _parseLevel(lv: BookLevel): [number, number] {
  const price = parseFloat(String(lv.price))
  const size = parseFloat(String(lv.size ?? '0'))
  return [isFinite(price) ? price : 0, isFinite(size) ? size : 0]
}

export function computeObLevels(
  rawAsks: BookLevel[],
  rawBids: BookLevel[],
): [OrderBookLevel[], string, string] {
  const parsedAsks = rawAsks.map(_parseLevel).filter(([p]) => p > 0)
  const parsedBids = rawBids.map(_parseLevel).filter(([p]) => p > 0)

  const allSizes = [...parsedAsks, ...parsedBids].map(([, sz]) => sz)
  const maxSize = allSizes.length ? Math.max(...allSizes) : 1

  const levels: OrderBookLevel[] = []

  // Asks: ascending price (cheapest first)
  const sortedAsks = [...parsedAsks].sort((a, b) => a[0] - b[0]).slice(0, 8)
  for (const [price, size] of sortedAsks) {
    levels.push({
      price_str: price.toFixed(2) + '¢',
      size_str: size.toFixed(1),
      total_str: (price * size / 100).toFixed(2),
      bar_pct: maxSize > 0 ? (size / maxSize) * 100 : 0,
      is_ask: true,
      price_cents: price,
    })
  }

  // Bids: descending price
  const sortedBids = [...parsedBids].sort((a, b) => b[0] - a[0]).slice(0, 8)
  for (const [price, size] of sortedBids) {
    levels.push({
      price_str: price.toFixed(2) + '¢',
      size_str: size.toFixed(1),
      total_str: (price * size / 100).toFixed(2),
      bar_pct: maxSize > 0 ? (size / maxSize) * 100 : 0,
      is_ask: false,
      price_cents: price,
    })
  }

  // Spread & mid
  const bestAsk = sortedAsks[0]?.[0] ?? 0
  const bestBid = sortedBids[0]?.[0] ?? 0
  const spread = bestAsk > 0 && bestBid > 0 ? (bestAsk - bestBid).toFixed(2) + '¢' : ''
  const mid = bestAsk > 0 && bestBid > 0 ? ((bestAsk + bestBid) / 2).toFixed(1) + '¢' : ''

  return [levels, spread, mid]
}

// ── Event handlers ────────────────────────────────────────────────────────────

export function toggleOrderbook(): void {
  patch('show_orderbook', !state.show_orderbook)
}

export function setObSide(side: string): void {
  patch('ob_side', side)
}

export function obClickAsk(priceCents: number): void {
  patch('limit_price', String(Math.round(priceCents)))
  patch('buy_mode', 'limit')
}

export function obClickBid(priceCents: number): void {
  patch('limit_price', String(Math.round(priceCents)))
  patch('buy_mode', 'limit')
}

export async function pollOrderbookOnce(): Promise<void> {
  if (!fetchOrderbook) return

  const upToken = state.up_token ?? ''
  const dnToken = state.dn_token ?? ''
  if (!upToken && !dnToken) return

  patch('ob_loading', true)
  try {
    const [upResult, dnResult] = await Promise.allSettled([
      upToken ? fetchOrderbook(upToken) : Promise.resolve(null),
      dnToken ? fetchOrderbook(dnToken) : Promise.resolve(null),
    ])

    if (upResult.status === 'fulfilled' && upResult.value) {
      const book = upResult.value
      const [levels, spread, mid] = computeObLevels(book.asks, book.bids)
      patch('ob_up_levels', levels as unknown as Record<string, unknown>[])
      patch('ob_spread_up', spread)
      patch('ob_last_up', mid)
    }

    if (dnResult.status === 'fulfilled' && dnResult.value) {
      const book = dnResult.value
      const [levels, spread, mid] = computeObLevels(book.asks, book.bids)
      patch('ob_dn_levels', levels as unknown as Record<string, unknown>[])
      patch('ob_spread_dn', spread)
      patch('ob_last_dn', mid)
    }
  } catch {
    // ignore
  } finally {
    patch('ob_loading', false)
  }
}

// ── Background: poll order book ───────────────────────────────────────────────

export async function runPollOrderbook(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await sleep(obSleep())
    if (signal.aborted) break

    if (!state.show_orderbook) continue

    await pollOrderbookOnce()
  }
}
